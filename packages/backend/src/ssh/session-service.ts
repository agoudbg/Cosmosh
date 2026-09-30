import { randomBytes, randomUUID } from 'node:crypto';

import type { SshTerminalServerMessage } from '@cosmosh/api-contract';
import type { PrismaClient } from '@prisma/client';
import type { Client, ClientChannel } from 'ssh2';
import type { RawData } from 'ws';

import type { AuditEventService } from '../audit/service.js';
import type { AuditEventInput } from '../audit/types.js';
import { createI18n, type I18nInstance, type Locale } from '../i18n-bridge.js';
import {
  BaseTerminalSessionService,
  TERMINAL_PENDING_OUTPUT_MAX_BYTES,
  TERMINAL_PENDING_OUTPUT_MAX_CHUNKS,
  type TerminalManagedSessionBase,
} from '../terminal/base-session-service.js';
import {
  clampTerminalSize,
  normalizeTerminalClientMessage,
  TERMINAL_TELEMETRY_INTERVAL_MS,
} from '../terminal/shared.js';
import {
  openSshClient,
  type OpenSshClientResult,
  type SshClientLifecycleMonitor,
  type SshServerWithKeychain,
} from './connect.js';
import { executeBoundedSshCommand } from './exec.js';
import type { SshProxyMetadata } from './proxy.js';

type GetDbClient = () => PrismaClient;

type CreateSshSessionInput = {
  locale: Locale;
  requestId?: string;
  serverId: string;
  cols: number;
  rows: number;
  term: string;
  connectTimeoutSec: number;
  strictHostKey?: boolean;
  enableSshCompression?: boolean;
  systemProxyRules?: string;
};

type CreateSshSessionSuccess = {
  type: 'success';
  sessionId: string;
  serverId: string;
  websocketUrl: string;
  websocketToken: string;
};

type CreateSshSessionHostUntrusted = {
  type: 'host-untrusted';
  serverId: string;
  host: string;
  port: number;
  algorithm: 'sha256';
  fingerprint: string;
};

type CreateSshSessionFailure = { type: 'failed'; message: string };

type CreateSshSessionResult =
  CreateSshSessionSuccess | CreateSshSessionHostUntrusted | { type: 'not-found' } | CreateSshSessionFailure;

type TrustSshFingerprintInput = {
  requestId?: string;
  serverId: string;
  fingerprintSha256: string;
  algorithm: string;
};

type TrustSshFingerprintResult = { type: 'success' } | { type: 'not-found' };

type SshShellStreamLifecycleMonitor = {
  isClosed(): boolean;
  release(): void;
};

type OpenShellResult =
  | {
      type: 'ready';
      client: Client;
      stream: ClientChannel;
      lifecycleMonitor: SshClientLifecycleMonitor;
      streamLifecycleMonitor: SshShellStreamLifecycleMonitor;
      proxyMetadata: SshProxyMetadata;
    }
  | { type: 'host-untrusted'; fingerprint: string; message: string; proxyMetadata?: SshProxyMetadata }
  | { type: 'failed'; message: string; proxyMetadata?: SshProxyMetadata };

type ServerOutboundMessage = SshTerminalServerMessage;

type SshLiveSession = TerminalManagedSessionBase & {
  serverId: string;
  requestId?: string;
  loginAuditId: string | null;
  client: Client;
  stream: ClientChannel;
  telemetryInterval: NodeJS.Timeout | null;
  lastNetworkSample: {
    rxBytesTotal: number;
    txBytesTotal: number;
    timestampMs: number;
  } | null;
  commandCount: number;
};

type ParsedRemoteTelemetry = {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesTotal: number;
  networkTxBytesTotal: number;
};

const TELEMETRY_COMMAND =
  ' sh -lc \'cpu=$(top -bn1 | awk -F"[, ]+" "/Cpu\\(s\\)|%Cpu\\(s\\)/ {for(i=1;i<=NF;i++){if($i==\\"id\\"){print 100-$(i-1); exit}}}"); if [ -z "$cpu" ]; then cpu=$(awk "/^cpu /{idle=$5;total=0;for(i=2;i<=NF;i++){total+=$i} if(total>0){print (total-idle)*100/total}else{print 0}}" /proc/stat); fi; mem=$(free -b | awk "/^Mem:/ {print \\$3 \\" \\" \\$2}"); net=$(awk "NR>2 {rx+=\\$2;tx+=\\$10} END {print rx \\" \\" tx}" /proc/net/dev); printf "%s\\n%s\\n%s\\n" "${cpu:-0}" "${mem:-0 0}" "${net:-0 0}"\'';

const REMOTE_SHELL_UTF8_ENV = {
  LANG: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
} as const satisfies Readonly<NodeJS.ProcessEnv>;

/**
 * Records an early shell close until the live session installs its permanent listener.
 *
 * @param stream Newly opened interactive shell stream.
 * @returns Monitor that closes the callback-to-session-registration event gap.
 */
const createSshShellStreamLifecycleMonitor = (stream: ClientChannel): SshShellStreamLifecycleMonitor => {
  let closed = false;
  const handleClose = (): void => {
    closed = true;
  };

  stream.on('close', handleClose);

  return {
    isClosed: () => closed,
    release: () => stream.off('close', handleClose),
  };
};

/**
 * SSH terminal session orchestrator.
 *
 * The service owns SSH credentials, host trust, login audits, telemetry, and the
 * interactive WebSocket transport. Generic WebSocket lifecycle handling remains in
 * `BaseTerminalSessionService`.
 */
export class SshSessionService extends BaseTerminalSessionService<SshLiveSession, ServerOutboundMessage> {
  private readonly getDbClient: GetDbClient;

  private readonly auditEventService: AuditEventService;

  private readonly credentialEncryptionKey: Buffer;

  constructor(options: {
    host: string;
    port: number;
    getDbClient: GetDbClient;
    auditEventService: AuditEventService;
    credentialEncryptionKey: Buffer;
  }) {
    super({
      host: options.host,
      port: options.port,
      pathPrefix: '/ws/ssh/',
    });

    this.getDbClient = options.getDbClient;
    this.auditEventService = options.auditEventService;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
  }

  public async createSession(input: CreateSshSessionInput): Promise<CreateSshSessionResult> {
    const i18n = createI18n({ locale: input.locale, fallbackLocale: 'en' });
    const db = this.getDbClient();
    const server = await db.sshServer.findUnique({
      where: { id: input.serverId },
      include: { keychain: true },
    });

    if (!server) {
      return { type: 'not-found' };
    }

    const trustedKeys = await db.sshKnownHost.findMany({
      where: {
        host: server.host,
        port: server.port,
        trusted: true,
        keyType: 'sha256',
      },
      select: { fingerprint: true },
    });
    const trustedFingerprintSet = new Set(trustedKeys.map((item) => item.fingerprint));
    const strictHostKey = input.strictHostKey ?? server.strictHostKey;
    const enableSshCompression = input.enableSshCompression ?? server.enableSshCompression;
    const sessionId = randomUUID();
    const pendingOutput: string[] = [];
    let pendingOutputBytes = 0;
    let pendingOutputDropCount = 0;

    const bufferPendingOutput = (chunk: string): void => {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      pendingOutput.push(chunk);
      pendingOutputBytes += chunkBytes;

      while (
        pendingOutput.length > TERMINAL_PENDING_OUTPUT_MAX_CHUNKS ||
        pendingOutputBytes > TERMINAL_PENDING_OUTPUT_MAX_BYTES
      ) {
        const dropped = pendingOutput.shift();
        if (!dropped) {
          break;
        }

        pendingOutputBytes = Math.max(0, pendingOutputBytes - Buffer.byteLength(dropped, 'utf8'));
        pendingOutputDropCount += 1;
      }
    };

    let liveSession: SshLiveSession | null = null;
    const shellResult = await this.openShell(server, {
      cols: input.cols,
      rows: input.rows,
      term: input.term,
      connectTimeoutSec: input.connectTimeoutSec,
      strictHostKey,
      enableSshCompression,
      systemProxyRules: input.systemProxyRules,
      trustedFingerprintSet,
      t: i18n.t,
      onOutput: (data) => {
        if (liveSession) {
          this.sendServerMessage(liveSession, { type: 'output', data });
          return;
        }

        bufferPendingOutput(data);
      },
    });

    if (shellResult.type === 'host-untrusted') {
      const loginAuditId = await this.createLoginAudit({
        serverId: server.id,
        result: 'failed',
        failureReason: shellResult.message || 'Host fingerprint is not trusted.',
      });

      this.logAuditEvent({
        category: 'ssh-session',
        action: 'connect',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId: input.requestId,
        relatedRecordId: loginAuditId ?? undefined,
        metadata: {
          host: server.host,
          port: server.port,
          strictHostKey,
          enableSshCompression,
          fingerprint: shellResult.fingerprint,
          reason: shellResult.message || 'Host fingerprint is not trusted.',
          proxyMode: shellResult.proxyMetadata?.mode,
          proxyProtocol: shellResult.proxyMetadata?.protocol,
        },
      });

      return {
        type: 'host-untrusted',
        serverId: server.id,
        host: server.host,
        port: server.port,
        algorithm: 'sha256',
        fingerprint: shellResult.fingerprint,
      };
    }

    if (shellResult.type === 'failed') {
      const loginAuditId = await this.createLoginAudit({
        serverId: server.id,
        result: 'failed',
        failureReason: shellResult.message,
      });

      this.logAuditEvent({
        category: 'ssh-session',
        action: 'connect',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId: input.requestId,
        relatedRecordId: loginAuditId ?? undefined,
        metadata: {
          host: server.host,
          port: server.port,
          strictHostKey,
          enableSshCompression,
          reason: shellResult.message,
          proxyMode: shellResult.proxyMetadata?.mode,
          proxyProtocol: shellResult.proxyMetadata?.protocol,
        },
      });

      return { type: 'failed', message: shellResult.message };
    }

    const websocketToken = randomBytes(24).toString('hex');
    const attachTimeout = setTimeout(() => {
      this.disposeSession(sessionId, 'ws.websocketConnectionTimeout');
    }, 30_000);
    const loginAuditId = await this.createLoginAudit({
      serverId: server.id,
      result: 'success',
      sessionId,
      sessionStartedAt: new Date(),
    });

    this.logAuditEvent({
      category: 'ssh-session',
      action: 'connect',
      outcome: 'success',
      severity: 'info',
      entityType: 'ssh-server',
      entityId: server.id,
      sessionId,
      requestId: input.requestId,
      relatedRecordId: loginAuditId ?? undefined,
      metadata: {
        host: server.host,
        port: server.port,
        strictHostKey,
        enableSshCompression,
        proxyMode: shellResult.proxyMetadata.mode,
        proxyProtocol: shellResult.proxyMetadata.protocol,
      },
    });

    liveSession = {
      sessionId,
      serverId: server.id,
      requestId: input.requestId,
      loginAuditId,
      websocketToken,
      client: shellResult.client,
      stream: shellResult.stream,
      pendingOutput,
      pendingOutputBytes,
      pendingOutputDropCount,
      attachTimeout,
      telemetryInterval: null,
      lastNetworkSample: null,
      commandCount: 0,
      t: i18n.t,
      socket: null,
      disposed: false,
    };

    const handleLiveStreamClose = (): void => {
      this.disposeSession(sessionId, 'ws.sshStreamClosed');
    };
    const handleLiveClientClose = (): void => {
      this.disposeSession(sessionId, 'ws.sshConnectionClosed');
    };
    const handleLiveClientError = (error: Error): void => {
      this.sendServerMessage(liveSession, { type: 'error', message: error.message });
      this.disposeSession(sessionId, 'ws.sshConnectionError');
    };

    this.registerSession(liveSession);
    shellResult.stream.on('close', handleLiveStreamClose);
    shellResult.client.on('close', handleLiveClientClose);
    shellResult.client.on('error', handleLiveClientError);
    shellResult.lifecycleMonitor.release();
    shellResult.streamLifecycleMonitor.release();

    const guardedClientError = shellResult.lifecycleMonitor.readError();
    if (guardedClientError) {
      handleLiveClientError(guardedClientError);
      return { type: 'failed', message: guardedClientError.message };
    }
    if (shellResult.lifecycleMonitor.isClosed()) {
      handleLiveClientClose();
      return { type: 'failed', message: i18n.t('ws.sshConnectionClosed') };
    }
    if (shellResult.streamLifecycleMonitor.isClosed()) {
      handleLiveStreamClose();
      return { type: 'failed', message: i18n.t('ws.sshStreamClosed') };
    }

    this.startSessionTelemetry(sessionId);

    return {
      type: 'success',
      sessionId,
      serverId: server.id,
      websocketUrl: `${this.websocketBaseUrl}/ws/ssh/${encodeURIComponent(sessionId)}`,
      websocketToken,
    };
  }

  public async trustFingerprint(input: TrustSshFingerprintInput): Promise<TrustSshFingerprintResult> {
    const db = this.getDbClient();
    const server = await db.sshServer.findUnique({
      where: { id: input.serverId },
      select: { id: true, host: true, port: true },
    });

    if (!server) {
      return { type: 'not-found' };
    }

    const existingKnownHost = await db.sshKnownHost.findFirst({
      where: {
        host: server.host,
        port: server.port,
        keyType: input.algorithm,
        fingerprint: input.fingerprintSha256,
      },
      select: { id: true },
    });

    if (existingKnownHost) {
      await db.sshKnownHost.update({
        where: { id: existingKnownHost.id },
        data: { trusted: true, keyType: input.algorithm },
      });

      this.logAuditEvent({
        category: 'ssh-host-trust',
        action: 'trust-fingerprint',
        outcome: 'success',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId: input.requestId,
        metadata: {
          host: server.host,
          port: server.port,
          algorithm: input.algorithm,
          fingerprint: input.fingerprintSha256,
          reusedRecord: true,
        },
      });

      return { type: 'success' };
    }

    await db.sshKnownHost.create({
      data: {
        id: randomUUID(),
        host: server.host,
        port: server.port,
        keyType: input.algorithm,
        fingerprint: input.fingerprintSha256,
        trusted: true,
      },
    });

    this.logAuditEvent({
      category: 'ssh-host-trust',
      action: 'trust-fingerprint',
      outcome: 'success',
      severity: 'warning',
      entityType: 'ssh-server',
      entityId: server.id,
      requestId: input.requestId,
      metadata: {
        host: server.host,
        port: server.port,
        algorithm: input.algorithm,
        fingerprint: input.fingerprintSha256,
        reusedRecord: false,
      },
    });

    return { type: 'success' };
  }

  protected onSessionAttached(session: SshLiveSession): void {
    this.sendServerMessage(session, { type: 'ready' });
    this.flushPendingOutput(session, (data) => ({ type: 'output', data }));
  }

  protected handleClientMessage(session: SshLiveSession, rawPayload: RawData): void {
    const message = normalizeTerminalClientMessage(rawPayload);

    if (!message) {
      this.sendServerMessage(session, {
        type: 'error',
        message: session.t('ws.invalidWebsocketMessageFormat'),
      });
      return;
    }

    if (message.type === 'input') {
      if (/\r|\n/.test(message.data)) {
        const submittedInputCount = message.data.split(/\r\n|[\r\n]/).length - 1;
        session.commandCount += Math.max(1, submittedInputCount);
      }
      session.stream.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = clampTerminalSize(message.cols, 120, 20, 400);
      const rows = clampTerminalSize(message.rows, 32, 10, 200);
      session.stream.setWindow(rows, cols, 0, 0);
      return;
    }

    if (message.type === 'ping') {
      this.sendServerMessage(session, { type: 'pong' });
      return;
    }

    this.disposeSession(session.sessionId, 'ws.clientRequestedClose');
  }

  protected disposeSession(
    sessionId: string,
    reasonKey: string,
    reasonParams?: Record<string, string | number | boolean>,
  ): void {
    this.disposeSessionWithCommonLifecycle(sessionId, reasonKey, reasonParams, {
      beforeExit: (session, reason) => {
        void this.finalizeLoginAudit(session, reason);
      },
      createExitMessage: (reason) => ({ type: 'exit', reason }),
      disposeTransport: (session) => {
        try {
          session.stream.close();
        } catch {
          // Ignore stream close races during disposal.
        }

        try {
          session.client.end();
        } catch {
          // Ignore client close races during disposal.
        }
      },
    });
  }

  private startSessionTelemetry(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    session.telemetryInterval = setInterval(() => {
      void this.collectAndSendTelemetry(sessionId);
    }, TERMINAL_TELEMETRY_INTERVAL_MS);

    void this.collectAndSendTelemetry(sessionId);
  }

  private async collectAndSendTelemetry(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    const parsed = await this.readRemoteTelemetry(session);
    if (!parsed) {
      this.sendServerMessage(session, {
        type: 'telemetry',
        cpuUsagePercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        networkRxBytesPerSec: null,
        networkTxBytesPerSec: null,
      });
      return;
    }

    const now = Date.now();
    const networkRates = this.computeNetworkRates(session, parsed.networkRxBytesTotal, parsed.networkTxBytesTotal, now);

    this.sendServerMessage(session, {
      type: 'telemetry',
      cpuUsagePercent: parsed.cpuUsagePercent,
      memoryUsedBytes: parsed.memoryUsedBytes,
      memoryTotalBytes: parsed.memoryTotalBytes,
      networkRxBytesPerSec: networkRates.rxBytesPerSec,
      networkTxBytesPerSec: networkRates.txBytesPerSec,
    });
  }

  private computeNetworkRates(
    session: SshLiveSession,
    currentRxBytesTotal: number,
    currentTxBytesTotal: number,
    timestampMs: number,
  ): { rxBytesPerSec: number; txBytesPerSec: number } {
    const previous = session.lastNetworkSample;
    session.lastNetworkSample = {
      rxBytesTotal: currentRxBytesTotal,
      txBytesTotal: currentTxBytesTotal,
      timestampMs,
    };

    if (!previous) {
      return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    }

    const deltaSeconds = Math.max(1, timestampMs - previous.timestampMs) / 1000;
    return {
      rxBytesPerSec: Math.max(0, (currentRxBytesTotal - previous.rxBytesTotal) / deltaSeconds),
      txBytesPerSec: Math.max(0, (currentTxBytesTotal - previous.txBytesTotal) / deltaSeconds),
    };
  }

  private async readRemoteTelemetry(session: SshLiveSession): Promise<ParsedRemoteTelemetry | null> {
    const stdout = await executeBoundedSshCommand(session.client, TELEMETRY_COMMAND);
    if (stdout === null) {
      return null;
    }

    return this.parseTelemetryOutput(stdout);
  }

  private parseTelemetryOutput(output: string): ParsedRemoteTelemetry | null {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 3) {
      return null;
    }

    const cpuUsagePercent = Number.parseFloat(lines[0] ?? '0');
    const [memoryUsedRaw, memoryTotalRaw] = (lines[1] ?? '').split(/\s+/);
    const [networkRxRaw, networkTxRaw] = (lines[2] ?? '').split(/\s+/);
    const memoryUsedBytes = Number.parseInt(memoryUsedRaw ?? '0', 10);
    const memoryTotalBytes = Number.parseInt(memoryTotalRaw ?? '0', 10);
    const networkRxBytesTotal = Number.parseInt(networkRxRaw ?? '0', 10);
    const networkTxBytesTotal = Number.parseInt(networkTxRaw ?? '0', 10);

    if (
      !Number.isFinite(cpuUsagePercent) ||
      !Number.isFinite(memoryUsedBytes) ||
      !Number.isFinite(memoryTotalBytes) ||
      !Number.isFinite(networkRxBytesTotal) ||
      !Number.isFinite(networkTxBytesTotal)
    ) {
      return null;
    }

    return {
      cpuUsagePercent: Math.max(0, Math.min(100, cpuUsagePercent)),
      memoryUsedBytes: Math.max(0, memoryUsedBytes),
      memoryTotalBytes: Math.max(0, memoryTotalBytes),
      networkRxBytesTotal: Math.max(0, networkRxBytesTotal),
      networkTxBytesTotal: Math.max(0, networkTxBytesTotal),
    };
  }

  private logAuditEvent(input: AuditEventInput): void {
    void this.auditEventService.logEvent(input);
  }

  private async createLoginAudit(input: {
    serverId: string;
    result: 'success' | 'failed';
    failureReason?: string;
    sessionId?: string;
    sessionStartedAt?: Date;
  }): Promise<string | null> {
    try {
      const db = this.getDbClient();
      const audit = await db.sshLoginAudit.create({
        data: {
          id: randomUUID(),
          serverId: input.serverId,
          result: input.result,
          failureReason: input.failureReason,
          sessionId: input.sessionId,
          sessionStartedAt: input.sessionStartedAt,
        },
        select: { id: true },
      });

      return audit.id;
    } catch (error: unknown) {
      console.error('[ssh][audit] Failed to create SSH login audit record.', error);
      return null;
    }
  }

  private async finalizeLoginAudit(session: SshLiveSession, reason: string): Promise<void> {
    if (session.loginAuditId) {
      try {
        const db = this.getDbClient();
        await db.sshLoginAudit.update({
          where: { id: session.loginAuditId },
          data: {
            sessionEndedAt: new Date(),
            commandCount: session.commandCount,
          },
        });
      } catch (error: unknown) {
        console.error('[ssh][audit] Failed to finalize SSH login audit record.', error);
      }
    }

    this.logAuditEvent({
      category: 'ssh-session',
      action: 'session-close',
      outcome: 'success',
      severity: 'info',
      entityType: 'ssh-server',
      entityId: session.serverId,
      sessionId: session.sessionId,
      relatedRecordId: session.loginAuditId ?? undefined,
      metadata: {
        commandCount: session.commandCount,
        reason,
      },
    });
  }

  private async openAuthenticatedClient(
    server: SshServerWithKeychain,
    options: {
      connectTimeoutSec: number;
      enableSshCompression: boolean;
      systemProxyRules?: string;
      strictHostKey: boolean;
      trustedFingerprintSet: ReadonlySet<string>;
      t: I18nInstance['t'];
    },
  ): Promise<OpenSshClientResult> {
    return await openSshClient(server, {
      connectTimeoutSec: options.connectTimeoutSec,
      db: this.getDbClient(),
      enableSshCompression: options.enableSshCompression,
      systemProxyRules: options.systemProxyRules,
      strictHostKey: options.strictHostKey,
      trustedFingerprintSet: options.trustedFingerprintSet,
      credentialEncryptionKey: this.credentialEncryptionKey,
      t: options.t,
    });
  }

  private async openShell(
    server: SshServerWithKeychain,
    options: {
      cols: number;
      rows: number;
      term: string;
      connectTimeoutSec: number;
      strictHostKey: boolean;
      enableSshCompression: boolean;
      systemProxyRules?: string;
      trustedFingerprintSet: Set<string>;
      t: I18nInstance['t'];
      onOutput: (data: string) => void;
    },
  ): Promise<OpenShellResult> {
    const openResult = await this.openAuthenticatedClient(server, {
      connectTimeoutSec: options.connectTimeoutSec,
      enableSshCompression: options.enableSshCompression,
      systemProxyRules: options.systemProxyRules,
      strictHostKey: options.strictHostKey,
      trustedFingerprintSet: options.trustedFingerprintSet,
      t: options.t,
    });
    if (openResult.type !== 'ready') {
      return openResult;
    }

    const { client, lifecycleMonitor, proxyMetadata } = openResult;

    return await new Promise<OpenShellResult>((resolve) => {
      let settled = false;

      const settle = (result: OpenShellResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        client.off('error', handleClientError);
        client.off('close', handleClientClose);
        if (result.type !== 'ready') {
          lifecycleMonitor.releaseAfterClose();
          client.end();
        }
        resolve(result);
      };

      const handleClientError = (error: Error): void => {
        settle({
          type: 'failed',
          message: error.message,
          proxyMetadata,
        });
      };

      const handleClientClose = (): void => {
        handleClientError(new Error('SSH connection closed before shell handoff.'));
      };

      client.once('error', handleClientError);
      client.once('close', handleClientClose);

      const guardedError = lifecycleMonitor.readError();
      if (guardedError) {
        handleClientError(guardedError);
        return;
      }
      if (lifecycleMonitor.isClosed()) {
        handleClientClose();
        return;
      }

      const cols = clampTerminalSize(options.cols, 120, 20, 400);
      const rows = clampTerminalSize(options.rows, 32, 10, 200);
      const term = options.term.trim() || 'xterm-256color';

      try {
        client.shell({ term, cols, rows }, { env: { ...REMOTE_SHELL_UTF8_ENV } }, (error, stream) => {
          if (error) {
            settle({
              type: 'failed',
              message: options.t('errors.ssh.openShellFailed', { reason: error.message }),
              proxyMetadata,
            });
            return;
          }

          stream.on('data', (chunk: Buffer | string) => {
            options.onOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          });
          stream.stderr.on('data', (chunk: Buffer | string) => {
            options.onOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          });

          settle({
            type: 'ready',
            client,
            stream,
            lifecycleMonitor,
            streamLifecycleMonitor: createSshShellStreamLifecycleMonitor(stream),
            proxyMetadata,
          });
        });
      } catch (error: unknown) {
        handleClientError(error instanceof Error ? error : new Error('SSH shell creation failed.'));
      }
    });
  }
}
