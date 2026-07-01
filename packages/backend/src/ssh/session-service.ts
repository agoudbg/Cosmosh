import { randomBytes, randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { type RawData } from 'ws';

import type { AuditEventService } from '../audit/service.js';
import type { AuditEventInput } from '../audit/types.js';
import { createI18n, type I18nInstance, type Locale } from '../i18n-bridge.js';
import {
  BaseTerminalSessionService,
  TERMINAL_PENDING_OUTPUT_MAX_BYTES,
  TERMINAL_PENDING_OUTPUT_MAX_CHUNKS,
  type TerminalManagedSessionBase,
} from '../terminal/base-session-service.js';
import { localizeTerminalCompletionItems, resolveTerminalCompletions } from '../terminal/completion/engine.js';
import { createRemotePathProvider } from '../terminal/completion/path-providers.js';
import {
  type CompletionPromptState,
  replayRemoteCompletionCwdCommands,
  resolveRemotePromptCwd,
  updatePromptStateFromInput,
  updatePromptStateFromOutput,
  updateRemoteCompletionCwd,
} from '../terminal/completion/runtime-state.js';
import {
  clampTerminalSize,
  computeHistorySyncDelayMs,
  mergeTerminalRecentCommands,
  normalizeTerminalClientMessage,
  parseTerminalHistoryOutput,
  TERMINAL_HISTORY_MAX_ENTRIES,
  TERMINAL_TELEMETRY_INTERVAL_MS,
  type TerminalClientInboundMessage,
  updateInteractiveCompletionState,
} from '../terminal/shared.js';
import { buildSshCompressionAlgorithms } from './compression.js';
import { decryptSensitiveValue } from './crypto.js';
import { executeBoundedSshCommand } from './exec.js';
import { prepareSshProxyTransport, SshProxyConnectionError, type SshProxyMetadata } from './proxy.js';

type GetDbClient = () => PrismaClient;

type SshServerWithKeychain = Prisma.SshServerGetPayload<{
  include: {
    keychain: true;
  };
}>;

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
  requestId?: string;
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
      completionSecretValue: string | null;
      proxyMetadata: SshProxyMetadata;
    }
  | {
      type: 'host-untrusted';
      fingerprint: string;
      message: string;
      proxyMetadata?: SshProxyMetadata;
    }
  | {
      type: 'failed';
      message: string;
      proxyMetadata?: SshProxyMetadata;
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
    }
  | {
      type: 'history';
      recentCommands: string[];
    }
  | {
      type: 'completion-response';
      requestId: string;
      replacePrefixLength: number;
      items: Array<{
        id: string;
        label: string;
        insertText: string;
        detail: string | null;
        source: 'history' | 'inshellisense' | 'runtime';
        kind: 'command' | 'subcommand' | 'option' | 'history' | 'path' | 'secret';
        score: number;
      }>;
    };

type SshLiveSession = TerminalManagedSessionBase & {
  locale: Locale;
  serverId: string;
  loginAuditId: string | null;
  client: Client;
  stream: ClientChannel;
  telemetryInterval: NodeJS.Timeout | null;
  lastNetworkSample: {
    rxBytesTotal: number;
    txBytesTotal: number;
    timestampMs: number;
  } | null;
  historySyncTimeout: NodeJS.Timeout | null;
  historySyncInFlight: boolean;
  historySyncPending: boolean;
  lastHistorySyncStartedAtMs: number;
  commandCount: number;
  recentCommands: string[];
  completionLineBuffer: string;
  completionRecentCommands: string[];
  completionWorkingDirectory: string | null;
  completionHomeDirectory: string | null;
  completionCwdInitializationPromise: Promise<string | null> | null;
  completionPendingCwdCommands: string[];
  completionPromptState: CompletionPromptState;
  completionSecretValue: string | null;
};

type ParsedRemoteTelemetry = {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesTotal: number;
  networkTxBytesTotal: number;
};

// Leading whitespace intentionally avoids writing this command into shell history on most shells.
const TELEMETRY_COMMAND =
  ' sh -lc \'cpu=$(top -bn1 | awk -F"[, ]+" "/Cpu\\(s\\)|%Cpu\\(s\\)/ {for(i=1;i<=NF;i++){if($i==\\"id\\"){print 100-$(i-1); exit}}}"); if [ -z "$cpu" ]; then cpu=$(awk "/^cpu /{idle=$5;total=0;for(i=2;i<=NF;i++){total+=$i} if(total>0){print (total-idle)*100/total}else{print 0}}" /proc/stat); fi; mem=$(free -b | awk "/^Mem:/ {print \\$3 \\" \\" \\$2}"); net=$(awk "NR>2 {rx+=\\$2;tx+=\\$10} END {print rx \\" \\" tx}" /proc/net/dev); printf "%s\\n%s\\n%s\\n" "${cpu:-0}" "${mem:-0 0}" "${net:-0 0}"\'';
const REMOTE_HISTORY_FETCH_COMMAND =
  ' sh -lc \'set +e; if command -v history >/dev/null 2>&1; then history 2>/dev/null; fi; for file in "$HISTFILE" "$HOME/.bash_history" "$HOME/.zsh_history" "$HOME/.ash_history" "$HOME/.sh_history" "$HOME/.mksh_history" "$HOME/.ksh_history" "$HOME/.local/share/fish/fish_history" "$HOME/.python_history" "$HOME/.sqlite_history" "$HOME/.mysql_history" "$HOME/.lesshst"; do if [ -n "$file" ] && [ -f "$file" ]; then cat "$file" 2>/dev/null; fi; done; if command -v pwsh >/dev/null 2>&1; then pwsh -NoLogo -NoProfile -Command "if (Get-Command Get-PSReadLineOption -ErrorAction SilentlyContinue) { $path=(Get-PSReadLineOption).HistorySavePath; if ($path -and (Test-Path $path)) { Get-Content -Path $path -ErrorAction SilentlyContinue } }" 2>/dev/null; fi; if command -v powershell >/dev/null 2>&1; then powershell -NoLogo -NoProfile -Command "if (Get-Command Get-PSReadLineOption -ErrorAction SilentlyContinue) { $path=(Get-PSReadLineOption).HistorySavePath; if ($path -and (Test-Path $path)) { Get-Content -Path $path -ErrorAction SilentlyContinue } }" 2>/dev/null; fi\'';
const REMOTE_COMPLETION_CWD_PROBE_COMMAND = 'sh -lc \'printf "%s\\n%s\\n" "$PWD" "$HOME"\'';
const SSH_COMPLETION_EXEC_TIMEOUT_MS = 3_000;
const SSH_TYPING_PATH_PROVIDER_TIMEOUT_MS = 1_200;

/**
 * SSH session orchestrator:
 * - opens SSH shells
 * - bridges WS <-> SSH stream messages
 * - tracks telemetry and login audits
 *
 * Layering note:
 * - BaseTerminalSessionService handles generic socket lifecycle.
 * - This class owns SSH-only concerns (credentials, host trust, login audit, remote command execution).
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
      where: {
        id: input.serverId,
      },
      include: {
        keychain: true,
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
    const strictHostKey = input.strictHostKey ?? server.strictHostKey;
    const enableSshCompression = input.enableSshCompression ?? server.enableSshCompression;
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
          liveSession.completionPromptState = updatePromptStateFromOutput(
            liveSession.completionPromptState,
            data,
            Date.now(),
          );
          const promptCwd = resolveRemotePromptCwd(
            liveSession.completionPromptState.outputTail,
            liveSession.completionWorkingDirectory,
            liveSession.completionHomeDirectory,
          );
          if (promptCwd) {
            this.applyResolvedRemoteCompletionCwd(liveSession, promptCwd);
          }
          this.sendServerMessage(liveSession, {
            type: 'output',
            data,
          });
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

      return {
        type: 'failed',
        message: shellResult.message,
      };
    }

    const sessionId = randomUUID();
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
      historySyncTimeout: null,
      historySyncInFlight: false,
      historySyncPending: false,
      lastHistorySyncStartedAtMs: 0,
      commandCount: 0,
      recentCommands: [],
      completionLineBuffer: '',
      completionRecentCommands: [],
      completionWorkingDirectory: null,
      completionHomeDirectory: null,
      completionCwdInitializationPromise: null,
      completionPendingCwdCommands: [],
      completionPromptState: {
        outputTail: '',
        promptDetectedAtMs: 0,
        shouldSuggestSecret: false,
      },
      completionSecretValue: shellResult.completionSecretValue,
      locale: i18n.getLocale(),
      t: i18n.t,
      socket: null,
      disposed: false,
    };

    pendingOutput.forEach((chunk) => {
      liveSession.completionPromptState = updatePromptStateFromOutput(
        liveSession.completionPromptState,
        chunk,
        Date.now(),
      );
      const promptCwd = resolveRemotePromptCwd(
        liveSession.completionPromptState.outputTail,
        liveSession.completionWorkingDirectory,
        liveSession.completionHomeDirectory,
      );
      if (promptCwd) {
        this.applyResolvedRemoteCompletionCwd(liveSession, promptCwd);
      }
    });

    shellResult.stream.on('close', () => {
      this.disposeSession(sessionId, 'ws.sshStreamClosed');
    });

    shellResult.client.on('close', () => {
      this.disposeSession(sessionId, 'ws.sshConnectionClosed');
    });

    shellResult.client.on('error', (error: Error) => {
      this.sendServerMessage(liveSession, {
        type: 'error',
        message: error.message,
      });
      this.disposeSession(sessionId, 'ws.sshConnectionError');
    });

    this.registerSession(liveSession);
    void this.ensureRemoteCompletionCwdInitialized(liveSession);
    this.startSessionTelemetry(sessionId);
    this.scheduleHistorySync(sessionId, { immediate: true });

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
    // Reattached clients must receive ready signal first, then buffered stream chunks in order.
    this.sendServerMessage(session, { type: 'ready' });
    this.flushPendingOutput(session, (data) => ({
      type: 'output',
      data,
    }));
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
      const interactiveState = {
        lineBuffer: session.completionLineBuffer,
        recentCommands: session.completionRecentCommands,
      };
      updateInteractiveCompletionState(interactiveState, message.data, {
        maxEntries: TERMINAL_HISTORY_MAX_ENTRIES,
        onCommandSubmitted: (command) => {
          if (!session.completionWorkingDirectory) {
            session.completionPendingCwdCommands.push(command);
            return;
          }

          session.completionWorkingDirectory = updateRemoteCompletionCwd(session.completionWorkingDirectory, command, {
            homeDirectory: session.completionHomeDirectory,
          });
        },
      });
      session.completionLineBuffer = interactiveState.lineBuffer;
      session.completionRecentCommands = interactiveState.recentCommands;
      session.completionPromptState = updatePromptStateFromInput(session.completionPromptState, message.data);

      if (/\r|\n/.test(message.data)) {
        const submittedInputCount = message.data.split(/\r\n|[\r\n]/).length - 1;
        session.commandCount += Math.max(1, submittedInputCount);
        this.scheduleHistorySync(session.sessionId);
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

    if (message.type === 'history-delete') {
      void this.deleteRemoteHistoryEntry(session, message.command);
      return;
    }

    if (message.type === 'completion-request') {
      void this.handleCompletionRequest(session, message);
      return;
    }

    this.disposeSession(session.sessionId, 'ws.clientRequestedClose');
  }

  /**
   * Resolves and returns localized completion items for one renderer request.
   */
  private async handleCompletionRequest(
    session: SshLiveSession,
    message: Extract<TerminalClientInboundMessage, { type: 'completion-request' }>,
  ): Promise<void> {
    const completionResult = await resolveTerminalCompletions(
      {
        linePrefix: message.linePrefix,
        cursorIndex: message.cursorIndex,
        limit: message.limit,
        fuzzyMatch: message.fuzzyMatch,
        includeHistory: message.includeHistory,
        includeBuiltInCommands: message.includeBuiltInCommands,
        includePathSuggestions: message.includePathSuggestions,
        includePasswordSuggestions: message.includePasswordSuggestions,
        trigger: message.trigger,
      },
      {
        recentCommands: session.completionRecentCommands,
        tokenizerMode: 'posix',
        typingPathProviderTimeoutMs: SSH_TYPING_PATH_PROVIDER_TIMEOUT_MS,
        pathProvider: createRemotePathProvider({
          resolveCwd: async () => {
            const hintedCwd = await this.resolveRequestCompletionWorkingDirectory(
              session,
              message.workingDirectoryHint,
            );
            if (hintedCwd) {
              this.applyResolvedRemoteCompletionCwd(session, hintedCwd);
              return session.completionWorkingDirectory;
            }

            if (!session.completionWorkingDirectory) {
              await this.ensureRemoteCompletionCwdInitialized(session);
            }

            return session.completionWorkingDirectory;
          },
          resolveHomeDirectory: async () => {
            if (!session.completionHomeDirectory) {
              await this.ensureRemoteCompletionCwdInitialized(session);
            }

            return session.completionHomeDirectory;
          },
          executeCommand: async (command) =>
            (await this.executeRemoteCommand(session, command, { timeoutMs: SSH_COMPLETION_EXEC_TIMEOUT_MS })) ?? '',
        }),
        promptState: {
          shouldSuggestSecret: session.completionPromptState.shouldSuggestSecret,
          secretValue: session.completionSecretValue,
        },
      },
    );

    this.sendServerMessage(session, {
      type: 'completion-response',
      requestId: message.requestId,
      replacePrefixLength: completionResult.replacePrefixLength,
      items: await localizeTerminalCompletionItems(completionResult.items, (key) => session.t(key), session.locale),
    });
  }

  /**
   * Resolves per-request cwd hint into effective SSH completion working directory.
   */
  private async resolveRequestCompletionWorkingDirectory(
    session: SshLiveSession,
    hintValue: string | undefined,
  ): Promise<string | null> {
    const hintedCwd = hintValue?.trim() ?? '';
    if (!hintedCwd) {
      return null;
    }

    if (hintedCwd.startsWith('/')) {
      return hintedCwd;
    }

    if ((hintedCwd === '~' || hintedCwd.startsWith('~/')) && !session.completionHomeDirectory) {
      await this.ensureRemoteCompletionCwdInitialized(session);
    }

    if (hintedCwd === '~' && session.completionHomeDirectory) {
      return session.completionHomeDirectory;
    }

    if (hintedCwd.startsWith('~/') && session.completionHomeDirectory) {
      return `${session.completionHomeDirectory}${hintedCwd.slice(1)}`;
    }

    return null;
  }

  /**
   * Applies a cwd resolved from the live prompt or renderer hint.
   * @param session live SSH terminal session.
   * @param cwd resolved cwd from the active shell context.
   * @returns Nothing.
   */
  private applyResolvedRemoteCompletionCwd(session: SshLiveSession, cwd: string | null): void {
    if (!cwd) {
      return;
    }

    session.completionWorkingDirectory = cwd;
    session.completionPendingCwdCommands = [];
  }

  /**
   * Applies a fallback cwd and replays commands captured before cwd was known.
   * @param session live SSH terminal session.
   * @param baseCwd initial cwd from a background probe.
   * @returns Nothing.
   */
  private applyRemoteCompletionBaseCwd(session: SshLiveSession, baseCwd: string | null): void {
    if (!baseCwd) {
      return;
    }

    session.completionWorkingDirectory = replayRemoteCompletionCwdCommands(
      baseCwd,
      session.completionPendingCwdCommands,
      {
        homeDirectory: session.completionHomeDirectory,
      },
    );
    session.completionPendingCwdCommands = [];
  }

  /**
   * Initializes SSH completion cwd/home once and shares the in-flight probe.
   * @param session live SSH terminal session.
   * @returns resolved working directory, or null when unavailable.
   */
  private async ensureRemoteCompletionCwdInitialized(session: SshLiveSession): Promise<string | null> {
    if (session.completionWorkingDirectory && session.completionHomeDirectory) {
      return session.completionWorkingDirectory;
    }

    if (!session.completionCwdInitializationPromise) {
      session.completionCwdInitializationPromise = this.resolveRemoteCompletionDirectories(session)
        .then((directories) => {
          if (directories.homeDirectory) {
            session.completionHomeDirectory = directories.homeDirectory;
          }

          if (!session.completionWorkingDirectory || session.completionPendingCwdCommands.length > 0) {
            this.applyRemoteCompletionBaseCwd(session, directories.workingDirectory);
          }

          return session.completionWorkingDirectory;
        })
        .finally(() => {
          session.completionCwdInitializationPromise = null;
        });
    }

    return await session.completionCwdInitializationPromise;
  }

  protected disposeSession(
    sessionId: string,
    reasonKey: string,
    reasonParams?: Record<string, string | number | boolean>,
  ): void {
    this.disposeSessionWithCommonLifecycle(sessionId, reasonKey, reasonParams, {
      beforeExit: (session, reason) => {
        // Persist audit metadata before underlying transport is torn down.
        void this.finalizeLoginAudit(session, reason);
      },
      createExitMessage: (reason) => ({
        type: 'exit',
        reason,
      }),
      disposeTransport: (session) => {
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

  private scheduleHistorySync(sessionId: string, options?: { immediate?: boolean }): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    if (session.historySyncTimeout) {
      clearTimeout(session.historySyncTimeout);
      session.historySyncTimeout = null;
    }

    const now = Date.now();
    // Keep history sidebar responsive while preventing bursty remote exec invocations.
    // Debounce groups rapid keystrokes; throttle protects host and network from command floods.
    const delayMs = computeHistorySyncDelayMs(session.lastHistorySyncStartedAtMs, now, options);

    session.historySyncTimeout = setTimeout(() => {
      session.historySyncTimeout = null;
      void this.syncRemoteHistory(sessionId);
    }, delayMs);
  }

  private async syncRemoteHistory(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    if (session.historySyncInFlight) {
      session.historySyncPending = true;
      return;
    }

    session.historySyncInFlight = true;
    session.lastHistorySyncStartedAtMs = Date.now();

    try {
      const commands = await this.readRemoteHistory(session);
      if (!commands) {
        return;
      }

      // Remote history is the source of truth for the commands sidebar.
      session.recentCommands = commands;
      session.completionRecentCommands = mergeTerminalRecentCommands(
        session.recentCommands,
        session.completionRecentCommands,
      );
      this.sendServerMessage(session, {
        type: 'history',
        recentCommands: [...session.recentCommands],
      });
    } finally {
      session.historySyncInFlight = false;

      if (session.historySyncPending) {
        session.historySyncPending = false;
        this.scheduleHistorySync(sessionId);
      }
    }
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
    const stdout = await this.executeRemoteCommand(session, TELEMETRY_COMMAND);
    if (stdout === null) {
      return null;
    }

    return this.parseTelemetryOutput(stdout);
  }

  private async readRemoteHistory(session: SshLiveSession): Promise<string[] | null> {
    const stdout = await this.executeRemoteCommand(session, REMOTE_HISTORY_FETCH_COMMAND);
    if (stdout === null) {
      return null;
    }

    return this.parseHistoryOutput(stdout);
  }

  private parseHistoryOutput(output: string): string[] {
    return parseTerminalHistoryOutput(output);
  }

  private async resolveRemoteCompletionDirectories(
    session: SshLiveSession,
  ): Promise<{ workingDirectory: string | null; homeDirectory: string | null }> {
    const stdout = await this.executeRemoteCommand(session, REMOTE_COMPLETION_CWD_PROBE_COMMAND, {
      timeoutMs: SSH_COMPLETION_EXEC_TIMEOUT_MS,
      maxOutputBytes: 8 * 1024,
    });
    const lines =
      stdout
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0) ?? [];
    const workingDirectory = lines[0] ?? null;
    const homeDirectory = lines[1] ?? null;

    return { workingDirectory, homeDirectory };
  }

  private async deleteRemoteHistoryEntry(session: SshLiveSession, command: string): Promise<void> {
    const normalizedCommand = command.trim();
    if (normalizedCommand.length === 0) {
      return;
    }

    const escapedCommand = this.escapeShellSingleQuote(normalizedCommand);
    // Best-effort delete across common POSIX shell history file formats.
    const deleteCommand =
      ' sh -lc \\' +
      `set +e; target='${escapedCommand}'; ` +
      'cleanup_plain(){ file="$1"; if [ -f "$file" ]; then tmp="$file.cosmosh.$$"; grep -Fvx -- "$target" "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file"; fi; }; ' +
      'cleanup_zsh(){ file="$1"; if [ -f "$file" ]; then tmp="$file.cosmosh.$$"; awk -v target="$target" "{line=$0;cmd=line; if (match(line,/^: [0-9]+:[0-9]+;/)) {cmd=substr(line,RSTART+RLENGTH)} if (cmd==target) {next} print line}" "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file"; fi; }; ' +
      'cleanup_plain "$HISTFILE"; cleanup_plain "$HOME/.bash_history"; cleanup_plain "$HOME/.ash_history"; cleanup_plain "$HOME/.sh_history"; cleanup_plain "$HOME/.mksh_history"; cleanup_plain "$HOME/.ksh_history"; cleanup_zsh "$HOME/.zsh_history";\'';

    await this.executeRemoteCommand(session, deleteCommand);

    session.recentCommands = session.recentCommands.filter((entry) => entry !== normalizedCommand);
    session.completionRecentCommands = session.completionRecentCommands.filter((entry) => entry !== normalizedCommand);
    this.sendServerMessage(session, {
      type: 'history',
      recentCommands: [...session.recentCommands],
    });
    this.scheduleHistorySync(session.sessionId, { immediate: true });
  }

  private escapeShellSingleQuote(value: string): string {
    return value.replace(/'/g, "'\"'\"'");
  }

  private async executeRemoteCommand(
    session: SshLiveSession,
    command: string,
    options?: {
      timeoutMs?: number;
      maxOutputBytes?: number;
    },
  ): Promise<string | null> {
    return await executeBoundedSshCommand(session.client, command, options);
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

  /**
   * Emits one audit event without blocking SSH runtime flow.
   */
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

  private async finalizeLoginAudit(session: SshLiveSession, reason: string): Promise<void> {
    if (session.loginAuditId) {
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
    const client = new Client();
    let presentedFingerprint = '';

    const connectConfig: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: options.connectTimeoutSec * 1000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      algorithms: {
        compress: buildSshCompressionAlgorithms(options.enableSshCompression),
      },
      hostHash: 'sha256',
      hostVerifier: (hashedKey: string) => {
        presentedFingerprint = hashedKey;
        if (!options.strictHostKey) {
          return true;
        }

        return options.trustedFingerprintSet.has(hashedKey);
      },
    };

    let completionSecretValue: string | null = null;

    try {
      if (server.keychain.authType === 'password' || server.keychain.authType === 'both') {
        if (!server.keychain.passwordEncrypted) {
          return {
            type: 'failed',
            message: options.t('errors.ssh.passwordNotConfigured'),
          };
        }

        connectConfig.password = decryptSensitiveValue(server.keychain.passwordEncrypted, this.credentialEncryptionKey);
        completionSecretValue = typeof connectConfig.password === 'string' ? connectConfig.password : null;
      }

      if (server.keychain.authType === 'key' || server.keychain.authType === 'both') {
        if (!server.keychain.privateKeyEncrypted) {
          return {
            type: 'failed',
            message: options.t('errors.ssh.privateKeyNotConfigured'),
          };
        }

        connectConfig.privateKey = decryptSensitiveValue(
          server.keychain.privateKeyEncrypted,
          this.credentialEncryptionKey,
        );

        if (server.keychain.privateKeyPassphraseEncrypted) {
          connectConfig.passphrase = decryptSensitiveValue(
            server.keychain.privateKeyPassphraseEncrypted,
            this.credentialEncryptionKey,
          );
          if (!completionSecretValue && typeof connectConfig.passphrase === 'string') {
            completionSecretValue = connectConfig.passphrase;
          }
        }
      }
    } catch {
      return {
        type: 'failed',
        message: options.t('errors.ssh.decryptCredentialsFailed'),
      };
    }

    let proxyTransport;
    try {
      proxyTransport = await prepareSshProxyTransport(
        this.getDbClient(),
        server,
        options.systemProxyRules,
        options.connectTimeoutSec * 1000,
      );
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: error instanceof Error ? error.message : 'Proxy connection failed.',
        proxyMetadata: error instanceof SshProxyConnectionError ? error.metadata : undefined,
      };
    }

    connectConfig.readyTimeout = proxyTransport.readyTimeoutMs;
    if (proxyTransport.socket) {
      connectConfig.sock = proxyTransport.socket;
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
        const cols = clampTerminalSize(options.cols, 120, 20, 400);
        const rows = clampTerminalSize(options.rows, 32, 10, 200);
        const term = options.term.trim() || 'xterm-256color';

        client.shell({ term, cols, rows }, (error, stream) => {
          if (error) {
            client.end();
            settle({
              type: 'failed',
              message: options.t('errors.ssh.openShellFailed', { reason: error.message }),
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
            completionSecretValue,
            proxyMetadata: proxyTransport.metadata,
          });
        });
      });

      client.on('error', (error: Error) => {
        if (settled) {
          return;
        }

        client.end();

        if (options.strictHostKey && presentedFingerprint && !options.trustedFingerprintSet.has(presentedFingerprint)) {
          settle({
            type: 'host-untrusted',
            fingerprint: presentedFingerprint,
            message: error.message,
            proxyMetadata: proxyTransport.metadata,
          });
          return;
        }

        settle({
          type: 'failed',
          message: error.message,
          proxyMetadata: proxyTransport.metadata,
        });
      });

      client.connect(connectConfig);
    });
  }
}
