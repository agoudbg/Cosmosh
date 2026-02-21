import { randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient, SshServer } from '@prisma/client';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { decryptSensitiveValue } from './crypto.js';

type GetDbClient = () => PrismaClient;

type CreateSshSessionInput = {
  serverId: string;
  cols: number;
  rows: number;
  term: string;
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

type CreateSshSessionFailure = {
  type: 'failed';
  message: string;
};

type CreateSshSessionResult =
  | CreateSshSessionSuccess
  | CreateSshSessionHostUntrusted
  | { type: 'not-found' }
  | CreateSshSessionFailure;

type TrustSshFingerprintInput = {
  serverId: string;
  fingerprintSha256: string;
  algorithm: string;
};

type TrustSshFingerprintResult = { type: 'success' } | { type: 'not-found' };

type OpenShellResult =
  | {
      type: 'ready';
      client: Client;
      stream: ClientChannel;
    }
  | {
      type: 'host-untrusted';
      fingerprint: string;
      message: string;
    }
  | {
      type: 'failed';
      message: string;
    };

type ClientInboundMessage =
  | {
      type: 'input';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    }
  | {
      type: 'close';
    }
  | {
      type: 'ping';
    };

type ServerOutboundMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'exit';
      reason: string;
    }
  | {
      type: 'pong';
    }
  | {
      type: 'telemetry';
      cpuUsagePercent: number | null;
      memoryUsedBytes: number | null;
      memoryTotalBytes: number | null;
      networkRxBytesPerSec: number | null;
      networkTxBytesPerSec: number | null;
      recentCommands: string[];
    };

type SshLiveSession = {
  sessionId: string;
  serverId: string;
  loginAuditId: string | null;
  websocketToken: string;
  client: Client;
  stream: ClientChannel;
  pendingOutput: string[];
  attachTimeout: NodeJS.Timeout;
  telemetryInterval: NodeJS.Timeout | null;
  lastNetworkSample: {
    rxBytesTotal: number;
    txBytesTotal: number;
    timestampMs: number;
  } | null;
  commandBuffer: string;
  commandCount: number;
  recentCommands: string[];
  socket: WebSocket | null;
  disposed: boolean;
};

type ParsedRemoteTelemetry = {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesTotal: number;
  networkTxBytesTotal: number;
};

const TELEMETRY_INTERVAL_MS = 5_000;
// Leading whitespace intentionally avoids writing this command into shell history on most shells.
const TELEMETRY_COMMAND =
  ' sh -lc \'cpu=$(top -bn1 | awk -F"[, ]+" "/Cpu\\(s\\)|%Cpu\\(s\\)/ {for(i=1;i<=NF;i++){if($i==\\"id\\"){print 100-$(i-1); exit}}}"); if [ -z "$cpu" ]; then cpu=$(awk "/^cpu /{idle=$5;total=0;for(i=2;i<=NF;i++){total+=$i} if(total>0){print (total-idle)*100/total}else{print 0}}" /proc/stat); fi; mem=$(free -b | awk "/^Mem:/ {print \\$3 \\" \\" \\$2}"); net=$(awk "NR>2 {rx+=\\$2;tx+=\\$10} END {print rx \\" \\" tx}" /proc/net/dev); printf "%s\\n%s\\n%s\\n" "${cpu:-0}" "${mem:-0 0}" "${net:-0 0}"\'';

const normalizeMessage = (payload: RawData): ClientInboundMessage | null => {
  try {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;

    if (parsed.type === 'input' && typeof parsed.data === 'string') {
      return { type: 'input', data: parsed.data };
    }

    if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
      return {
        type: 'resize',
        cols: parsed.cols,
        rows: parsed.rows,
      };
    }

    if (parsed.type === 'close') {
      return { type: 'close' };
    }

    if (parsed.type === 'ping') {
      return { type: 'ping' };
    }

    return null;
  } catch {
    return null;
  }
};

const toShellSize = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};

export class SshSessionService {
  private readonly sessions = new Map<string, SshLiveSession>();

  private readonly websocketServer: WebSocketServer;

  private readonly websocketBaseUrl: string;

  private readonly getDbClient: GetDbClient;

  private readonly credentialEncryptionKey: Buffer;

  constructor(options: { host: string; port: number; getDbClient: GetDbClient; credentialEncryptionKey: Buffer }) {
    this.getDbClient = options.getDbClient;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
    this.websocketServer = new WebSocketServer({
      host: options.host,
      port: options.port,
    });

    this.websocketBaseUrl = `ws://${options.host}:${options.port}`;

    this.websocketServer.on('connection', (socket, request) => {
      const requestUrl = new URL(request.url ?? '', this.websocketBaseUrl);
      const pathPrefix = '/ws/ssh/';

      if (!requestUrl.pathname.startsWith(pathPrefix)) {
        socket.close(1008, 'Invalid websocket path.');
        return;
      }

      const sessionId = decodeURIComponent(requestUrl.pathname.slice(pathPrefix.length));
      const token = requestUrl.searchParams.get('token') ?? '';
      const session = this.sessions.get(sessionId);

      if (!session || session.disposed || token !== session.websocketToken) {
        socket.close(1008, 'Session is invalid or expired.');
        return;
      }

      if (session.socket && session.socket.readyState === session.socket.OPEN) {
        session.socket.close(1012, 'Session reconnected from a new client.');
      }

      session.socket = socket;
      clearTimeout(session.attachTimeout);
      this.sendServerMessage(session, { type: 'ready' });
      this.flushPendingOutput(session);

      socket.on('message', (payload) => {
        this.handleClientMessage(session, payload);
      });

      socket.on('close', () => {
        if (session.disposed) {
          return;
        }

        this.disposeSession(session.sessionId, 'WebSocket disconnected.');
      });

      socket.on('error', () => {
        if (session.disposed) {
          return;
        }

        this.disposeSession(session.sessionId, 'WebSocket transport error.');
      });
    });
  }

  public getWebSocketBaseUrl(): string {
    return this.websocketBaseUrl;
  }

  public async createSession(input: CreateSshSessionInput): Promise<CreateSshSessionResult> {
    const db = this.getDbClient();
    const server = await db.sshServer.findUnique({
      where: {
        id: input.serverId,
      },
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
      select: {
        fingerprint: true,
      },
    });

    const trustedFingerprintSet = new Set(trustedKeys.map((item) => item.fingerprint));
    const pendingOutput: string[] = [];
    let liveSession: SshLiveSession | null = null;
    const shellResult = await this.openShell(server, {
      cols: input.cols,
      rows: input.rows,
      term: input.term,
      trustedFingerprintSet,
      onOutput: (data) => {
        if (liveSession) {
          this.sendServerMessage(liveSession, {
            type: 'output',
            data,
          });
          return;
        }

        pendingOutput.push(data);
      },
    });

    if (shellResult.type === 'host-untrusted') {
      await this.createLoginAudit({
        serverId: server.id,
        result: 'failed',
        failureReason: shellResult.message || 'Host fingerprint is not trusted.',
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
      await this.createLoginAudit({
        serverId: server.id,
        result: 'failed',
        failureReason: shellResult.message,
      });

      return {
        type: 'failed',
        message: shellResult.message,
      };
    }

    const sessionId = randomUUID();
    const websocketToken = randomBytes(24).toString('hex');

    const attachTimeout = setTimeout(() => {
      this.disposeSession(sessionId, 'WebSocket connection timeout.');
    }, 30_000);

    const loginAuditId = await this.createLoginAudit({
      serverId: server.id,
      result: 'success',
      sessionId,
      sessionStartedAt: new Date(),
    });

    liveSession = {
      sessionId,
      serverId: server.id,
      loginAuditId,
      websocketToken,
      client: shellResult.client,
      stream: shellResult.stream,
      pendingOutput,
      attachTimeout,
      telemetryInterval: null,
      lastNetworkSample: null,
      commandBuffer: '',
      commandCount: 0,
      recentCommands: [],
      socket: null,
      disposed: false,
    };

    shellResult.stream.on('close', () => {
      this.disposeSession(sessionId, 'SSH stream closed.');
    });

    shellResult.client.on('close', () => {
      this.disposeSession(sessionId, 'SSH connection closed.');
    });

    shellResult.client.on('error', (error: Error) => {
      this.sendServerMessage(liveSession, {
        type: 'error',
        message: error.message,
      });
      this.disposeSession(sessionId, 'SSH connection error.');
    });

    this.sessions.set(sessionId, liveSession);
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
      where: {
        id: input.serverId,
      },
      select: {
        id: true,
        host: true,
        port: true,
      },
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
      select: {
        id: true,
      },
    });

    if (existingKnownHost) {
      await db.sshKnownHost.update({
        where: {
          id: existingKnownHost.id,
        },
        data: {
          trusted: true,
          keyType: input.algorithm,
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

    return { type: 'success' };
  }

  public closeSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) {
      return false;
    }

    this.disposeSession(sessionId, 'Session closed by API request.');
    return true;
  }

  public async stop(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      this.disposeSession(sessionId, 'Backend shutdown.');
    }

    await new Promise<void>((resolve, reject) => {
      this.websocketServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private sendServerMessage(session: SshLiveSession, payload: ServerOutboundMessage): void {
    if (!session.socket || session.socket.readyState !== session.socket.OPEN) {
      if (payload.type === 'output') {
        session.pendingOutput.push(payload.data);
      }
      return;
    }

    session.socket.send(JSON.stringify(payload));
  }

  private flushPendingOutput(session: SshLiveSession): void {
    while (session.pendingOutput.length > 0) {
      const data = session.pendingOutput.shift();
      if (!data) {
        continue;
      }

      this.sendServerMessage(session, {
        type: 'output',
        data,
      });
    }
  }

  private handleClientMessage(session: SshLiveSession, rawPayload: RawData): void {
    const message = normalizeMessage(rawPayload);

    if (!message) {
      this.sendServerMessage(session, {
        type: 'error',
        message: 'Invalid websocket message format.',
      });
      return;
    }

    if (message.type === 'input') {
      this.captureCommandInput(session, message.data);
      session.stream.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = toShellSize(message.cols, 120, 20, 400);
      const rows = toShellSize(message.rows, 32, 10, 200);
      session.stream.setWindow(rows, cols, 0, 0);
      return;
    }

    if (message.type === 'ping') {
      this.sendServerMessage(session, { type: 'pong' });
      return;
    }

    this.disposeSession(session.sessionId, 'Client requested close.');
  }

  private disposeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    session.disposed = true;
    this.sessions.delete(sessionId);
    clearTimeout(session.attachTimeout);

    if (session.telemetryInterval) {
      clearInterval(session.telemetryInterval);
      session.telemetryInterval = null;
    }

    void this.finalizeLoginAudit(session);

    this.sendServerMessage(session, {
      type: 'exit',
      reason,
    });

    try {
      session.stream.close();
    } catch {
      // Ignore stream close race errors.
    }

    try {
      session.client.end();
    } catch {
      // Ignore client close race errors.
    }

    if (session.socket && session.socket.readyState === session.socket.OPEN) {
      session.socket.close(1000, reason);
    }

    session.socket = null;
  }

  private startSessionTelemetry(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    session.telemetryInterval = setInterval(() => {
      void this.collectAndSendTelemetry(sessionId);
    }, TELEMETRY_INTERVAL_MS);

    // Kick off once immediately so the UI gets values without waiting for the first interval.
    void this.collectAndSendTelemetry(sessionId);
  }

  private async collectAndSendTelemetry(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    const parsed = await this.readRemoteTelemetry(session);
    if (!parsed) {
      // Frontend renders explicit N/A placeholders when metrics are unavailable on the remote host.
      this.sendServerMessage(session, {
        type: 'telemetry',
        cpuUsagePercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        networkRxBytesPerSec: null,
        networkTxBytesPerSec: null,
        recentCommands: [...session.recentCommands],
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
      recentCommands: [...session.recentCommands],
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
      return {
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
      };
    }

    const deltaMs = Math.max(1, timestampMs - previous.timestampMs);
    const deltaSeconds = deltaMs / 1000;

    return {
      rxBytesPerSec: Math.max(0, (currentRxBytesTotal - previous.rxBytesTotal) / deltaSeconds),
      txBytesPerSec: Math.max(0, (currentTxBytesTotal - previous.txBytesTotal) / deltaSeconds),
    };
  }

  private async readRemoteTelemetry(session: SshLiveSession): Promise<ParsedRemoteTelemetry | null> {
    return await new Promise<ParsedRemoteTelemetry | null>((resolve) => {
      let stdout = '';

      session.client.exec(TELEMETRY_COMMAND, (error, channel) => {
        if (error) {
          resolve(null);
          return;
        }

        channel.on('data', (chunk: Buffer | string) => {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });

        channel.on('close', () => {
          resolve(this.parseTelemetryOutput(stdout));
        });
      });
    });
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

  private captureCommandInput(session: SshLiveSession, inputData: string): void {
    for (const character of inputData) {
      if (character === '\r' || character === '\n') {
        const submitted = session.commandBuffer;
        session.commandBuffer = '';

        const command = submitted.trim();
        if (command.length > 0) {
          this.pushRecentCommand(session, command);
        }
        continue;
      }

      if (character === '\u007f') {
        session.commandBuffer = session.commandBuffer.slice(0, -1);
        continue;
      }

      if (character === '\u0015') {
        session.commandBuffer = '';
        continue;
      }

      // Ignore control keys (arrow keys, ctrl combinations, etc.) and only keep printable text.
      if (character >= ' ' && character !== '\u007f') {
        session.commandBuffer += character;

        if (session.commandBuffer.length > 512) {
          session.commandBuffer = session.commandBuffer.slice(-512);
        }
      }
    }
  }

  private pushRecentCommand(session: SshLiveSession, command: string): void {
    session.commandCount += 1;
    // Keep all submitted commands for this session to match full-history UX expectations.
    session.recentCommands.push(command);
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
        select: {
          id: true,
        },
      });

      return audit.id;
    } catch (error: unknown) {
      console.error('[ssh][audit] Failed to create SSH login audit record.', error);
      return null;
    }
  }

  private async finalizeLoginAudit(session: SshLiveSession): Promise<void> {
    if (!session.loginAuditId) {
      return;
    }

    try {
      const db = this.getDbClient();
      await db.sshLoginAudit.update({
        where: {
          id: session.loginAuditId,
        },
        data: {
          sessionEndedAt: new Date(),
          commandCount: session.commandCount,
        },
      });
    } catch (error: unknown) {
      console.error('[ssh][audit] Failed to finalize SSH login audit record.', error);
    }
  }

  private async openShell(
    server: SshServer,
    options: {
      cols: number;
      rows: number;
      term: string;
      trustedFingerprintSet: Set<string>;
      onOutput: (data: string) => void;
    },
  ): Promise<OpenShellResult> {
    const client = new Client();
    let presentedFingerprint = '';

    const connectConfig: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hashedKey: string) => {
        presentedFingerprint = hashedKey;
        return options.trustedFingerprintSet.has(hashedKey);
      },
    };

    try {
      if (server.authType === 'password' || server.authType === 'both') {
        if (!server.passwordEncrypted) {
          return {
            type: 'failed',
            message: 'Password is required but not configured for this server.',
          };
        }

        connectConfig.password = decryptSensitiveValue(server.passwordEncrypted, this.credentialEncryptionKey);
      }

      if (server.authType === 'key' || server.authType === 'both') {
        if (!server.privateKeyEncrypted) {
          return {
            type: 'failed',
            message: 'Private key is required but not configured for this server.',
          };
        }

        connectConfig.privateKey = decryptSensitiveValue(server.privateKeyEncrypted, this.credentialEncryptionKey);

        if (server.privateKeyPassphraseEncrypted) {
          connectConfig.passphrase = decryptSensitiveValue(
            server.privateKeyPassphraseEncrypted,
            this.credentialEncryptionKey,
          );
        }
      }
    } catch (error: unknown) {
      return {
        type: 'failed',
        message:
          error instanceof Error
            ? `Unable to decrypt SSH credentials: ${error.message}. Please re-save this server credentials.`
            : 'Unable to decrypt SSH credentials. Please re-save this server credentials.',
      };
    }

    return await new Promise<OpenShellResult>((resolve) => {
      let settled = false;

      const settle = (result: OpenShellResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      client.once('ready', () => {
        const cols = toShellSize(options.cols, 120, 20, 400);
        const rows = toShellSize(options.rows, 32, 10, 200);
        const term = options.term.trim() || 'xterm-256color';

        client.shell({ term, cols, rows }, (error, stream) => {
          if (error) {
            client.end();
            settle({
              type: 'failed',
              message: `Failed to open SSH shell: ${error.message}`,
            });
            return;
          }

          stream.on('data', (chunk: Buffer | string) => {
            const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            options.onOutput(data);
          });

          stream.stderr.on('data', (chunk: Buffer | string) => {
            const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            options.onOutput(data);
          });

          settle({
            type: 'ready',
            client,
            stream,
          });
        });
      });

      client.on('error', (error: Error) => {
        if (settled) {
          return;
        }

        client.end();

        if (presentedFingerprint && !options.trustedFingerprintSet.has(presentedFingerprint)) {
          settle({
            type: 'host-untrusted',
            fingerprint: presentedFingerprint,
            message: error.message,
          });
          return;
        }

        settle({
          type: 'failed',
          message: error.message,
        });
      });

      client.connect(connectConfig);
    });
  }
}
