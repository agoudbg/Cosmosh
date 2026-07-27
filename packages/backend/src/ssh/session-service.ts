import { randomBytes, randomUUID } from 'node:crypto';

import {
  AGENT_TERMINAL_REQUIRED_CAPABILITIES,
  type AgentTerminalAttachmentStatus,
  type McpClientInfo,
  type McpConnectionMode,
  type RemoteEnhancementRuntimeStatus,
  type RemoteShellCapability,
  type RemoteShellEventMessage,
  type SshTerminalServerMessage,
} from '@cosmosh/api-contract';
import type { PrismaClient } from '@prisma/client';
import { type Client, type ClientChannel } from 'ssh2';
import { type RawData } from 'ws';

import type { AuditEventService } from '../audit/service.js';
import type { AuditEventInput } from '../audit/types.js';
import { createI18n, type I18nInstance, type Locale } from '../i18n-bridge.js';
import {
  REMOTE_BOOTSTRAP_EXEC_OPTIONS,
  type RemoteBootstrapResult,
  type RemoteBootstrapRuntimeContract,
  RemoteBootstrapService,
  type RemoteBootstrapStatus,
} from '../remote-bootstrap/service.js';
import { readDefaultSettingsValues } from '../settings/read.js';
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
import { type AgentTerminalCommandOutcome, AgentTerminalController } from './agent-terminal.js';
import {
  openSshClient,
  type OpenSshClientResult,
  type SshClientLifecycleMonitor,
  type SshServerWithKeychain,
} from './connect.js';
import { executeBoundedSshCommand } from './exec.js';
import type { SshProxyMetadata } from './proxy.js';
import { RemoteShellEventOscParser, type RemoteShellEventStreamFrame } from './remote-shell-events.js';

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
  remoteEnhancementsEnabled?: boolean;
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
  CreateSshSessionSuccess | CreateSshSessionHostUntrusted | { type: 'not-found' } | CreateSshSessionFailure;

type TrustSshFingerprintInput = {
  requestId?: string;
  serverId: string;
  fingerprintSha256: string;
  algorithm: string;
};

type TrustSshFingerprintResult = { type: 'success' } | { type: 'not-found' };

type AgentTerminalClosedListener = (sessionId: string, connectionId: string) => void;

type AgentTerminalStatusListener = (sessionId: string, status: AgentTerminalAttachmentStatus) => void;

type SshShellStreamLifecycleMonitor = {
  /** @returns Whether the shell stream closed before session ownership completed. */
  isClosed(): boolean;
  /** Removes the temporary close listener after the live session listener is attached. */
  release(): void;
};

type OpenShellResult =
  | {
      type: 'ready';
      client: Client;
      stream: ClientChannel;
      completionSecretValue: string | null;
      lifecycleMonitor: SshClientLifecycleMonitor;
      streamLifecycleMonitor: SshShellStreamLifecycleMonitor;
      proxyMetadata: SshProxyMetadata;
      remoteBootstrapResult: RemoteBootstrapResult;
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

type ServerOutboundMessage = SshTerminalServerMessage;

type RemoteEnhancementRuntimeState = RemoteEnhancementRuntimeStatus['state'];

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
  remoteShellEventParser: RemoteShellEventOscParser;
  pendingStreamFrames: RemoteShellEventStreamFrame[];
  pendingStreamFrameBytes: number;
  pendingStreamFrameDropCount: number;
  remoteShellReady: boolean;
  remoteShellAtPrompt: boolean;
  remoteShellLineLength: number;
  remoteShellCwd: string | null;
  remoteShellForegroundCommand: string | null;
  lastRemoteCommand: string | null;
  lastRemoteCommandId: string | null;
  lastExitCode: number | null;
  lastCommandDurationMs: number | null;
  pendingRemoteBootstrapStatuses: RemoteBootstrapStatus[];
  remoteEnhancementsRuntimeState: RemoteEnhancementRuntimeState;
  remoteEnhancementsRuntimeContract: RemoteBootstrapRuntimeContract | null;
  remoteEnhancementsRuntimeCode: string | null;
  remoteEnhancementsRuntimeMessage: string | null;
  remoteEnhancementsHandshakeTimeout: NodeJS.Timeout | null;
  agentTerminalController: AgentTerminalController;
  agentTerminalClosing: boolean;
};

/**
 * Renderer-safe automation eligibility for one existing SSH terminal.
 */
export type AgentTerminalSessionSnapshot = {
  sessionId: string;
  serverId: string;
  automationAvailable: boolean;
  atPrompt: boolean;
  lineLength: number;
  busy: boolean;
  attached: boolean;
};

/**
 * Stable outcome of granting an Agent access to one SSH terminal.
 */
export type AttachAgentTerminalResult =
  | { type: 'success'; snapshot: AgentTerminalSessionSnapshot }
  | { type: 'terminal-not-found' }
  | { type: 'terminal-busy' }
  | { type: 'terminal-not-ready' }
  | { type: 'terminal-automation-unavailable' };

/**
 * Stable outcome of executing one command through a visible SSH PTY.
 */
export type RunAgentTerminalCommandResult =
  | { type: 'success'; result: AgentTerminalCommandOutcome }
  | { type: 'terminal-not-found' }
  | { type: 'terminal-busy' }
  | { type: 'terminal-not-ready' }
  | { type: 'terminal-automation-unavailable' }
  | { type: 'terminal-detached' };

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
// LC_ALL is intentionally omitted so remote time, sorting, and numeric locale categories remain user-controlled.
const REMOTE_SHELL_UTF8_ENV = {
  LANG: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
} as const satisfies Readonly<NodeJS.ProcessEnv>;
const REMOTE_COMPLETION_CWD_PROBE_COMMAND = 'sh -lc \'printf "%s\\n%s\\n" "$PWD" "$HOME"\'';
const SSH_COMPLETION_EXEC_TIMEOUT_MS = 3_000;
const SSH_TYPING_PATH_PROVIDER_TIMEOUT_MS = 1_200;
const SSH_PENDING_STREAM_FRAME_MAX_COUNT = TERMINAL_PENDING_OUTPUT_MAX_CHUNKS;
const SSH_PENDING_STREAM_FRAME_MAX_BYTES = TERMINAL_PENDING_OUTPUT_MAX_BYTES;
const SSH_REMOTE_BOOTSTRAP_ENSURE_TIMEOUT_MS = 15_000;
const SSH_REMOTE_ENHANCEMENT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Measures one detached SSH stream frame against the bounded queue budget.
 *
 * Visible output retains the existing raw UTF-8 byte accounting. Helper events
 * use their serialized WebSocket payload size so both frame kinds share one
 * meaningful memory bound.
 *
 * @param frame Parsed visible-output or trusted helper-event frame.
 * @returns UTF-8 payload bytes retained by the pending queue.
 */
const getPendingStreamFrameBytes = (frame: RemoteShellEventStreamFrame): number => {
  const payload = frame.type === 'output' ? frame.data : JSON.stringify(frame.event);
  return Buffer.byteLength(payload, 'utf8');
};

/** Error used to distinguish the optional pre-shell budget from bootstrap failures. */
class RemoteBootstrapEnsureTimeoutError extends Error {
  public constructor() {
    super('remote enhancement setup exceeded the 15 second connection budget');
    this.name = 'RemoteBootstrapEnsureTimeoutError';
  }
}

/**
 * Normalizes an AbortSignal reason without allowing unknown values to escape.
 *
 * @param signal Signal that cancelled pre-shell setup.
 * @returns Original Error reason or a stable cancellation fallback.
 */
const readAbortSignalError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('remote enhancement setup cancelled');
};

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
 * Awaits an operation while allowing the caller to stop waiting at a shared deadline.
 *
 * The underlying operation still receives the same signal and is expected to cancel its
 * own I/O. The explicit race also contains dependencies that do not support cancellation.
 *
 * @param operation In-flight asynchronous operation.
 * @param signal Signal that owns the shared deadline.
 * @returns Operation result when it completes before cancellation.
 */
const awaitWithAbortSignal = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    throw readAbortSignalError(signal);
  }

  return await new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      signal.removeEventListener('abort', handleAbort);
      reject(readAbortSignalError(signal));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
};

/**
 * Builds the shared status emitted when either enhancement feature gate is off.
 *
 * @returns Explicit skipped bootstrap status.
 */
const remoteBootstrapDisabledStatus = (): RemoteBootstrapStatus => {
  return {
    type: 'bootstrap-status',
    phase: 'probe',
    state: 'skipped',
    code: 'REMOTE_ENHANCEMENTS_DISABLED',
    message: 'remote enhancements are disabled',
  };
};

/**
 * Resolves the persisted server gate with a disable-only session override.
 *
 * Renderer snapshots may be stale, so a request can narrow the persisted setting but
 * can never re-enable a server that the current database record has disabled.
 *
 * @param persistedEnabled Current server setting read by Backend.
 * @param requestedEnabled Optional session request override.
 * @returns True only when the persisted gate is enabled and the request did not disable it.
 */
export const resolveRemoteEnhancementsSessionGate = (
  persistedEnabled: boolean,
  requestedEnabled: boolean | undefined,
): boolean => {
  return persistedEnabled && requestedEnabled !== false;
};

/**
 * Resolves whether helper command-start events are authoritative for one session.
 *
 * @param runtimeState Current trusted helper runtime state.
 * @param capabilities Installed helper capabilities, when available.
 * @returns `true` only after activation with structured command-start support.
 */
export const usesStructuredRemoteCommandLifecycle = (
  runtimeState: RemoteEnhancementRuntimeState,
  capabilities: readonly RemoteShellCapability[] | null | undefined,
): boolean => {
  return runtimeState === 'active' && Boolean(capabilities?.includes('command-start'));
};

/**
 * Verifies that an OSC event came from the exact helper contract validated pre-shell.
 *
 * @param event Parsed helper event.
 * @param contract Bootstrap-validated runtime identity.
 * @returns True when shell, version, protocol, and capabilities all match.
 */
const remoteShellEventMatchesContract = (
  event: RemoteShellEventMessage,
  contract: RemoteBootstrapRuntimeContract,
): boolean => {
  return (
    event.shell === contract.shell &&
    event.helperVersion === contract.helperVersion &&
    event.protocolVersion === contract.protocolVersion &&
    event.capabilities.length === contract.capabilities.length &&
    event.capabilities.every((capability) => contract.capabilities.includes(capability))
  );
};

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

  private readonly remoteBootstrapService: RemoteBootstrapService;

  private readonly agentTerminalClosedListeners = new Set<AgentTerminalClosedListener>();

  private readonly agentTerminalStatusListeners = new Set<AgentTerminalStatusListener>();

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
    this.remoteBootstrapService = new RemoteBootstrapService({
      auditEventService: options.auditEventService,
      manifestUrl: process.env.COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL?.trim() || undefined,
    });
  }

  /**
   * Subscribes to terminal disposal so MCP ownership can be invalidated.
   *
   * @param listener Listener receiving the terminal and connection ids.
   * @returns Unsubscribe callback.
   */
  public onAgentTerminalClosed(listener: (sessionId: string, connectionId: string) => void): () => void {
    this.agentTerminalClosedListeners.add(listener);
    return (): void => {
      this.agentTerminalClosedListeners.delete(listener);
    };
  }

  /**
   * Subscribes to attachment state changes used for MCP connection summaries.
   *
   * @param listener Listener receiving renderer-safe status changes.
   * @returns Unsubscribe callback.
   */
  public onAgentTerminalStatusChanged(
    listener: (sessionId: string, status: AgentTerminalAttachmentStatus) => void,
  ): () => void {
    this.agentTerminalStatusListeners.add(listener);
    return (): void => {
      this.agentTerminalStatusListeners.delete(listener);
    };
  }

  /**
   * Returns current Agent automation state for one renderer-owned terminal.
   *
   * @param sessionId SSH session id known only to Cosmosh runtime surfaces.
   * @returns Eligibility snapshot, or undefined when the terminal is gone.
   */
  public getAgentTerminalSession(sessionId: string): AgentTerminalSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toAgentTerminalSessionSnapshot(session) : undefined;
  }

  /**
   * Grants one Agent connection access to an eligible SSH terminal.
   *
   * @param input Terminal id and Agent identity selected by the renderer.
   * @returns Stable attach outcome.
   */
  public attachAgentTerminal(input: {
    sessionId: string;
    connectionId: string;
    client: McpClientInfo;
    mode: Extract<McpConnectionMode, 'terminal' | 'attached'>;
    agentCreatedTab: boolean;
  }): AttachAgentTerminalResult {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.disposed) {
      return { type: 'terminal-not-found' };
    }
    if (!this.supportsAgentTerminalAutomation(session)) {
      return { type: 'terminal-automation-unavailable' };
    }
    if (session.agentTerminalController.getAttachment() || session.agentTerminalController.isBusy()) {
      return { type: 'terminal-busy' };
    }
    if (!this.isAgentTerminalPromptReady(session)) {
      return { type: 'terminal-not-ready' };
    }
    if (
      !session.agentTerminalController.attach({
        connectionId: input.connectionId,
        client: input.client,
        mode: input.mode,
        agentCreatedTab: input.agentCreatedTab,
      })
    ) {
      return { type: 'terminal-busy' };
    }

    return { type: 'success', snapshot: this.toAgentTerminalSessionSnapshot(session) };
  }

  /**
   * Revokes one Agent attachment without closing the user terminal.
   *
   * @param connectionId MCP connection id.
   * @returns True when the matching attachment was removed.
   */
  public detachAgentTerminal(connectionId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.agentTerminalController.detach(connectionId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sends an ordinary interrupt byte to an attached terminal.
   *
   * @param connectionId MCP connection id.
   * @returns True when the matching live terminal received the interrupt.
   */
  public stopAgentTerminalCommand(connectionId: string): boolean {
    for (const session of this.sessions.values()) {
      if (
        session.agentTerminalController.getAttachment()?.connectionId !== connectionId ||
        !session.agentTerminalController.isBusy()
      ) {
        continue;
      }

      session.agentTerminalController.markUserIntervened();
      session.stream.write('\u0003');
      return true;
    }

    return false;
  }

  /**
   * Executes one Agent command in an attached visible PTY.
   *
   * @param input Terminal ownership, command, bounds, and cancellation.
   * @returns Stable readiness failure or trusted command result.
   */
  public async runAgentTerminalCommand(input: {
    sessionId: string;
    connectionId: string;
    command: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<RunAgentTerminalCommandResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.disposed) {
      return { type: 'terminal-not-found' };
    }
    if (session.agentTerminalController.getAttachment()?.connectionId !== input.connectionId) {
      return { type: 'terminal-detached' };
    }
    if (!this.supportsAgentTerminalAutomation(session)) {
      return { type: 'terminal-automation-unavailable' };
    }
    if (session.agentTerminalController.isBusy()) {
      return { type: 'terminal-busy' };
    }
    if (!this.isAgentTerminalPromptReady(session)) {
      return { type: 'terminal-not-ready' };
    }

    session.remoteShellAtPrompt = false;
    const result = await session.agentTerminalController.runCommand({
      connectionId: input.connectionId,
      command: input.command,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
      write: (data) => session.stream.write(data),
    });
    return { type: 'success', result };
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
    const remoteEnhancementsEnabled = resolveRemoteEnhancementsSessionGate(
      server.remoteEnhancementsEnabled,
      input.remoteEnhancementsEnabled,
    );
    const sessionId = randomUUID();
    const pendingRemoteBootstrapStatuses: RemoteBootstrapStatus[] = [];
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
      beforeShellOpen: async (signal) =>
        await this.ensureRemoteEnhancementsBeforeShell({
          openClient: async (signal) =>
            await this.openAuthenticatedClient(server, {
              connectTimeoutSec: input.connectTimeoutSec,
              enableSshCompression,
              signal,
              systemProxyRules: input.systemProxyRules,
              strictHostKey,
              trustedFingerprintSet,
              t: i18n.t,
            }),
          serverId: server.id,
          sessionId,
          requestId: input.requestId,
          serverEnabled: remoteEnhancementsEnabled,
          signal,
          sendStatus: (status) => pendingRemoteBootstrapStatuses.push(status),
        }),
      onOutput: (data) => {
        if (liveSession) {
          this.handleShellOutput(liveSession, data);
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
          remoteEnhancementsEnabled,
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
          remoteEnhancementsEnabled,
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
        remoteEnhancementsEnabled,
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
      remoteShellEventParser: new RemoteShellEventOscParser(),
      pendingStreamFrames: [],
      pendingStreamFrameBytes: 0,
      pendingStreamFrameDropCount: pendingOutputDropCount,
      remoteShellReady: false,
      remoteShellAtPrompt: false,
      remoteShellLineLength: 0,
      remoteShellCwd: null,
      remoteShellForegroundCommand: null,
      lastRemoteCommand: null,
      lastRemoteCommandId: null,
      lastExitCode: null,
      lastCommandDurationMs: null,
      pendingRemoteBootstrapStatuses,
      remoteEnhancementsRuntimeState: shellResult.remoteBootstrapResult.state === 'ready' ? 'pending' : 'disabled',
      remoteEnhancementsRuntimeContract:
        shellResult.remoteBootstrapResult.state === 'ready' ? shellResult.remoteBootstrapResult.contract : null,
      remoteEnhancementsRuntimeCode:
        shellResult.remoteBootstrapResult.state === 'disabled' ? shellResult.remoteBootstrapResult.code : null,
      remoteEnhancementsRuntimeMessage:
        shellResult.remoteBootstrapResult.state === 'disabled' ? shellResult.remoteBootstrapResult.message : null,
      remoteEnhancementsHandshakeTimeout: null,
      agentTerminalClosing: false,
      agentTerminalController: new AgentTerminalController({
        onStatusChanged: (status) => {
          if (!liveSession || liveSession.disposed || liveSession.agentTerminalClosing) {
            return;
          }

          this.sendServerMessage(liveSession, status);
          for (const listener of this.agentTerminalStatusListeners) {
            listener(liveSession.sessionId, status);
          }
        },
      }),
      t: i18n.t,
      socket: null,
      disposed: false,
    };

    this.startRemoteEnhancementHandshakeTimeout(liveSession);

    const rawPendingOutput = [...pendingOutput];
    liveSession.pendingOutput = [];
    liveSession.pendingOutputBytes = 0;
    liveSession.pendingOutputDropCount = 0;
    rawPendingOutput.forEach((chunk) => {
      this.handleShellOutput(liveSession, chunk);
    });

    const handleLiveStreamClose = (): void => {
      this.disposeSession(sessionId, 'ws.sshStreamClosed');
    };

    const handleLiveClientClose = (): void => {
      this.disposeSession(sessionId, 'ws.sshConnectionClosed');
    };

    const handleLiveClientError = (error: Error): void => {
      this.sendServerMessage(liveSession, {
        type: 'error',
        message: error.message,
      });
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
    // Control state must establish trust before ordered PTY frames reach the renderer.
    this.sendServerMessage(session, { type: 'ready' });
    while (session.pendingRemoteBootstrapStatuses.length > 0) {
      const status = session.pendingRemoteBootstrapStatuses.shift();
      if (status) {
        this.sendServerMessage(session, status);
      }
    }
    this.sendRemoteEnhancementRuntimeStatus(session);
    this.sendAgentTerminalAttachmentStatus(session);
    this.flushPendingStreamFrames(session);
  }

  /**
   * Sends a snapshot of attachment state after a renderer reconnect.
   *
   * @param session Attached SSH session.
   */
  private sendAgentTerminalAttachmentStatus(session: SshLiveSession): void {
    const attachment = session.agentTerminalController.getAttachment();
    if (!attachment) {
      this.sendServerMessage(session, { type: 'agent-attachment-status', state: 'detached' });
      return;
    }

    this.sendServerMessage(session, {
      type: 'agent-attachment-status',
      state: session.agentTerminalController.isBusy() ? 'running' : 'idle',
      connectionId: attachment.connectionId,
      client: attachment.client,
      mode: attachment.mode,
      agentCreatedTab: attachment.agentCreatedTab,
    });
  }

  /**
   * Notifies MCP ownership when terminal readiness changes without duplicating
   * the renderer attachment control frame.
   *
   * @param session SSH session whose readiness changed.
   */
  private notifyAgentTerminalStatusListeners(session: SshLiveSession): void {
    const attachment = session.agentTerminalController.getAttachment();
    const status: AgentTerminalAttachmentStatus = attachment
      ? {
          type: 'agent-attachment-status',
          state: session.agentTerminalController.isBusy() ? 'running' : 'idle',
          connectionId: attachment.connectionId,
          client: attachment.client,
          mode: attachment.mode,
          agentCreatedTab: attachment.agentCreatedTab,
        }
      : { type: 'agent-attachment-status', state: 'detached' };

    for (const listener of this.agentTerminalStatusListeners ?? []) {
      listener(session.sessionId, status);
    }
  }

  /**
   * Requires the complete trusted helper contract used by shared PTY commands.
   *
   * @param session SSH session being evaluated.
   * @returns True only when every required lifecycle capability is active.
   */
  private supportsAgentTerminalAutomation(session: SshLiveSession): boolean {
    const capabilities = session.remoteEnhancementsRuntimeContract?.capabilities;
    return (
      session.remoteEnhancementsRuntimeState === 'active' &&
      capabilities !== undefined &&
      AGENT_TERMINAL_REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability))
    );
  }

  /**
   * Verifies that no command or unsubmitted user input currently owns the prompt.
   *
   * @param session SSH session being evaluated.
   * @returns True when an Agent command may be written immediately.
   */
  private isAgentTerminalPromptReady(session: SshLiveSession): boolean {
    return (
      session.remoteShellAtPrompt &&
      session.remoteShellLineLength === 0 &&
      !session.remoteShellForegroundCommand &&
      !session.agentTerminalController.isBusy()
    );
  }

  /**
   * Converts live SSH state into a renderer-safe automation snapshot.
   *
   * @param session Live SSH session.
   * @returns Current eligibility snapshot.
   */
  private toAgentTerminalSessionSnapshot(session: SshLiveSession): AgentTerminalSessionSnapshot {
    return {
      sessionId: session.sessionId,
      serverId: session.serverId,
      automationAvailable: this.supportsAgentTerminalAutomation(session),
      atPrompt: this.isAgentTerminalPromptReady(session),
      lineLength: session.remoteShellLineLength,
      busy: session.agentTerminalController.isBusy(),
      attached: session.agentTerminalController.getAttachment() !== null,
    };
  }

  /**
   * Sends attached messages immediately while retaining detached SSH stream
   * output and helper events in one arrival-ordered queue.
   *
   * Control messages keep the base service's detached-drop semantics because
   * current bootstrap/runtime state is emitted explicitly on every attach.
   *
   * @param session Live SSH session receiving the payload.
   * @param payload Backend-to-renderer WebSocket message.
   * @returns Nothing.
   */
  protected override sendServerMessage(session: SshLiveSession, payload: ServerOutboundMessage): void {
    if (session.disposed) {
      return;
    }

    if (!session.socket || session.socket.readyState !== session.socket.OPEN) {
      if (payload.type === 'output') {
        this.bufferPendingStreamFrame(session, { type: 'output', data: payload.data });
      } else if (payload.type === 'remote-shell-event') {
        this.bufferPendingStreamFrame(session, { type: 'event', event: payload });
      }
      return;
    }

    super.sendServerMessage(session, payload);
  }

  /**
   * Parses shell OSC events out of a raw SSH output chunk before xterm rendering.
   *
   * @param session Live SSH session that owns the parser state.
   * @param data Raw output bytes decoded as UTF-8.
   * @returns Nothing.
   */
  private handleShellOutput(session: SshLiveSession, data: string): void {
    const frames = session.remoteShellEventParser.parse(data);

    for (const frame of frames) {
      if (frame.type === 'event') {
        this.handleRemoteShellEvent(session, frame.event);
      } else {
        this.handleVisibleShellOutput(session, frame.data);
      }
    }
  }

  /**
   * Applies visible terminal output to prompt tracking and renderer output.
   *
   * @param session Live SSH session receiving the visible output.
   * @param data Visible output with Cosmosh OSC events removed.
   * @returns Nothing.
   */
  private handleVisibleShellOutput(session: SshLiveSession, data: string): void {
    session.agentTerminalController.handleOutput(data);
    session.completionPromptState = updatePromptStateFromOutput(session.completionPromptState, data, Date.now());
    const promptCwd = resolveRemotePromptCwd(
      session.completionPromptState.outputTail,
      session.completionWorkingDirectory,
      session.completionHomeDirectory,
    );
    if (promptCwd) {
      this.applyResolvedRemoteCompletionCwd(session, promptCwd);
    }
    this.sendServerMessage(session, {
      type: 'output',
      data,
    });
  }

  /**
   * Updates backend-owned remote shell state and forwards the event to renderer.
   *
   * @param session Live SSH session receiving the event.
   * @param event Normalized remote shell event message.
   * @returns Nothing.
   */
  private handleRemoteShellEvent(session: SshLiveSession, event: RemoteShellEventMessage): void {
    if (session.remoteEnhancementsRuntimeState === 'disabled') {
      return;
    }

    const contract = session.remoteEnhancementsRuntimeContract;
    if (!contract || !remoteShellEventMatchesContract(event, contract)) {
      this.disableRemoteEnhancementsRuntime(session, 'HELPER_CONTRACT_MISMATCH', 'remote helper contract mismatch');
      return;
    }

    if (session.remoteEnhancementsRuntimeState === 'pending') {
      if (event.event !== 'integration-ready') {
        return;
      }

      this.clearRemoteEnhancementHandshakeTimeout(session);
      session.remoteEnhancementsRuntimeState = 'active';
      session.remoteEnhancementsRuntimeCode = null;
      session.remoteEnhancementsRuntimeMessage = null;
      this.sendRemoteEnhancementRuntimeStatus(session);
    }

    this.applyRemoteShellEventState(session, event);
    session.agentTerminalController.handleRemoteShellEvent(event);
    if (event.event === 'prompt-ready' || event.event === 'line-state') {
      this.notifyAgentTerminalStatusListeners(session);
    }

    this.sendServerMessage(session, event);
  }

  /**
   * Pushes one detached stream frame into the shared bounded SSH queue.
   *
   * Dropping the oldest whole frame preserves the relative order of every
   * retained output/event boundary instead of regrouping the two frame kinds.
   *
   * @param session Live SSH session that owns the pending queue.
   * @param frame Parsed visible-output or trusted helper-event frame.
   * @returns Nothing.
   */
  private bufferPendingStreamFrame(session: SshLiveSession, frame: RemoteShellEventStreamFrame): void {
    const frameBytes = getPendingStreamFrameBytes(frame);
    session.pendingStreamFrames.push(frame);
    session.pendingStreamFrameBytes += frameBytes;

    while (
      session.pendingStreamFrames.length > SSH_PENDING_STREAM_FRAME_MAX_COUNT ||
      session.pendingStreamFrameBytes > SSH_PENDING_STREAM_FRAME_MAX_BYTES
    ) {
      const droppedFrame = session.pendingStreamFrames.shift();
      if (!droppedFrame) {
        break;
      }

      session.pendingStreamFrameBytes = Math.max(
        0,
        session.pendingStreamFrameBytes - getPendingStreamFrameBytes(droppedFrame),
      );
      session.pendingStreamFrameDropCount += 1;
    }
  }

  /**
   * Flushes detached visible output and trusted helper events in arrival order.
   *
   * @param session Attached SSH session that owns the pending queue.
   * @returns Nothing.
   */
  private flushPendingStreamFrames(session: SshLiveSession): void {
    while (
      session.pendingStreamFrames.length > 0 &&
      session.socket &&
      session.socket.readyState === session.socket.OPEN
    ) {
      const frame = session.pendingStreamFrames.shift();
      if (!frame) {
        break;
      }

      session.pendingStreamFrameBytes = Math.max(
        0,
        session.pendingStreamFrameBytes - getPendingStreamFrameBytes(frame),
      );

      if (frame.type === 'output') {
        super.sendServerMessage(session, { type: 'output', data: frame.data });
      } else if (session.remoteEnhancementsRuntimeState === 'active') {
        super.sendServerMessage(session, frame.event);
      }
    }

    if (session.pendingStreamFrames.length === 0 && session.pendingStreamFrameDropCount > 0) {
      console.warn('[ssh][pending-stream] Dropped buffered stream frames while detached.', {
        sessionId: session.sessionId,
        droppedFrames: session.pendingStreamFrameDropCount,
      });
      session.pendingStreamFrameDropCount = 0;
    }
  }

  /**
   * Removes queued helper events after the runtime trust gate closes while
   * retaining ordinary terminal output in its original relative order.
   *
   * @param session SSH session whose helper runtime is being disabled.
   * @returns Nothing.
   */
  private discardPendingRemoteShellEventFrames(session: SshLiveSession): void {
    session.pendingStreamFrames = session.pendingStreamFrames.filter((frame) => frame.type === 'output');
    session.pendingStreamFrameBytes = session.pendingStreamFrames.reduce(
      (total, frame) => total + getPendingStreamFrameBytes(frame),
      0,
    );
  }

  /**
   * Applies one remote shell event to per-session state.
   *
   * @param session Live SSH session.
   * @param event Remote shell event from the interactive shell helper.
   * @returns Nothing.
   */
  private applyRemoteShellEventState(session: SshLiveSession, event: RemoteShellEventMessage): void {
    if (event.event === 'integration-ready') {
      session.remoteShellReady = true;
    }

    if (event.cwd) {
      session.remoteShellCwd = event.cwd;
      this.applyResolvedRemoteCompletionCwd(session, event.cwd);
    }

    if (event.event === 'prompt-ready') {
      session.remoteShellReady = true;
      session.remoteShellAtPrompt = true;
      session.remoteShellLineLength = 0;
      session.remoteShellForegroundCommand = null;
      return;
    }

    if (event.event === 'foreground-command') {
      session.remoteShellAtPrompt = false;
      session.remoteShellForegroundCommand = event.command ?? null;
      return;
    }

    if (event.event === 'command-start' && event.command) {
      session.remoteShellAtPrompt = false;
      session.remoteShellLineLength = 0;
      session.lastRemoteCommand = event.command;
      if (session.lastRemoteCommandId !== event.commandId) {
        session.lastRemoteCommandId = event.commandId;
        session.commandCount += 1;
        this.scheduleHistorySync(session.sessionId);
      }
      return;
    }

    if (event.event === 'line-state') {
      session.remoteShellLineLength = event.lineLength;
      return;
    }

    if (event.event === 'command-end') {
      if (event.command) {
        session.lastRemoteCommand = event.command;
      }
      if (event.exitCode !== undefined) {
        session.lastExitCode = event.exitCode;
      }
      if (event.durationMs !== undefined) {
        session.lastCommandDurationMs = event.durationMs;
      }
    }
  }

  /**
   * Ensures the remote helper is current after SSH authentication and before PTY creation.
   *
   * Bootstrap failures intentionally return a disabled runtime contract so ordinary SSH
   * can continue without accepting stale helper events.
   *
   * @param options Dedicated SSH client factory, feature gates, and status sink.
   * @returns Ready contract or fail-closed disabled state.
   */
  private async ensureRemoteEnhancementsBeforeShell(options: {
    openClient: (signal: AbortSignal) => Promise<OpenSshClientResult>;
    serverId: string;
    sessionId: string;
    requestId?: string;
    serverEnabled: boolean;
    signal?: AbortSignal;
    sendStatus: (status: RemoteBootstrapStatus) => void;
    ensureTimeoutMs?: number;
  }): Promise<RemoteBootstrapResult> {
    if (!options.serverEnabled) {
      options.sendStatus(remoteBootstrapDisabledStatus());
      return {
        state: 'disabled',
        code: 'REMOTE_ENHANCEMENTS_DISABLED',
        message: 'remote enhancements are disabled',
      };
    }

    const statusContext = {
      serverId: options.serverId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      sendStatus: options.sendStatus,
    };
    const abortController = new AbortController();
    const timeoutError = new RemoteBootstrapEnsureTimeoutError();
    let didTimeout = false;
    const ensureTimeout = setTimeout(
      () => {
        didTimeout = true;
        abortController.abort(timeoutError);
      },
      Math.max(1, options.ensureTimeoutMs ?? SSH_REMOTE_BOOTSTRAP_ENSURE_TIMEOUT_MS),
    );
    ensureTimeout.unref();
    const handleParentAbort = (): void => {
      if (!abortController.signal.aborted && options.signal) {
        abortController.abort(readAbortSignalError(options.signal));
      }
    };
    if (options.signal?.aborted) {
      handleParentAbort();
    } else {
      options.signal?.addEventListener('abort', handleParentAbort, { once: true });
    }
    let stage: 'settings' | 'bootstrap' = 'settings';
    let bootstrapTransportDisposing = false;
    const bootstrapTransport: {
      client: Client | null;
      lifecycleMonitor: SshClientLifecycleMonitor | null;
      opening: Promise<Client | null> | null;
    } = {
      client: null,
      lifecycleMonitor: null,
      opening: null,
    };

    /**
     * Cancels optional setup when its dedicated SSH transport fails.
     *
     * @param error Client-level transport error.
     * @returns Nothing.
     */
    const handleBootstrapClientError = (error: Error): void => {
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
    };

    /**
     * Converts a clean-but-early client close into the same cancellation path.
     *
     * @returns Nothing.
     */
    const handleBootstrapClientClose = (): void => {
      handleBootstrapClientError(new Error('remote enhancement SSH transport closed'));
    };

    /**
     * Lazily opens the isolated transport only when bootstrap first needs a remote command.
     *
     * @returns Dedicated bootstrap client, or null when its independent connection failed.
     */
    const getBootstrapClient = async (): Promise<Client | null> => {
      if (bootstrapTransport.client) {
        return bootstrapTransport.client;
      }

      bootstrapTransport.opening ??= (async () => {
        const openResult = await options.openClient(abortController.signal);
        if (openResult.type !== 'ready') {
          return null;
        }

        if (abortController.signal.aborted) {
          openResult.lifecycleMonitor.releaseAfterClose();
          openResult.client.destroy();
          throw readAbortSignalError(abortController.signal);
        }

        bootstrapTransport.client = openResult.client;
        bootstrapTransport.lifecycleMonitor = openResult.lifecycleMonitor;
        openResult.client.once('error', handleBootstrapClientError);
        openResult.client.once('close', () => {
          openResult.client.off('error', handleBootstrapClientError);
          openResult.lifecycleMonitor.release();
          if (!bootstrapTransportDisposing) {
            handleBootstrapClientClose();
          }
        });

        const guardedError = openResult.lifecycleMonitor.readError();
        if (guardedError) {
          handleBootstrapClientError(guardedError);
          throw guardedError;
        }
        if (openResult.lifecycleMonitor.isClosed()) {
          openResult.client.off('error', handleBootstrapClientError);
          openResult.lifecycleMonitor.release();
          const closeError = new Error('remote enhancement SSH transport closed during connection handoff');
          handleBootstrapClientError(closeError);
          throw closeError;
        }

        return bootstrapTransport.client;
      })();

      return await bootstrapTransport.opening;
    };

    try {
      const settings = await awaitWithAbortSignal(
        readDefaultSettingsValues(this.getDbClient()),
        abortController.signal,
      );
      if (!settings.remoteEnhancementsEnabled) {
        options.sendStatus(remoteBootstrapDisabledStatus());
        return {
          state: 'disabled',
          code: 'REMOTE_ENHANCEMENTS_DISABLED',
          message: 'remote enhancements are disabled',
        };
      }

      stage = 'bootstrap';
      return await awaitWithAbortSignal(
        this.remoteBootstrapService.runForSession({
          serverId: options.serverId,
          sessionId: options.sessionId,
          requestId: options.requestId,
          executeCommand: async (command) => {
            const client = await getBootstrapClient();
            if (!client) {
              return null;
            }

            return await executeBoundedSshCommand(client, command, {
              ...REMOTE_BOOTSTRAP_EXEC_OPTIONS,
              signal: abortController.signal,
            });
          },
          sendStatus: (status) => {
            if (!abortController.signal.aborted) {
              options.sendStatus(status);
            }
          },
          signal: abortController.signal,
        }),
        abortController.signal,
      );
    } catch (error: unknown) {
      if (error instanceof RemoteBootstrapEnsureTimeoutError || didTimeout) {
        this.remoteBootstrapService.reportStatus(statusContext, {
          type: 'bootstrap-status',
          phase: 'install',
          state: 'failed',
          code: 'BOOTSTRAP_ENSURE_TIMEOUT',
          message: timeoutError.message,
        });
        return {
          state: 'disabled',
          code: 'BOOTSTRAP_ENSURE_TIMEOUT',
          message: timeoutError.message,
        };
      }

      if (options.signal?.aborted) {
        return {
          state: 'disabled',
          code: 'BOOTSTRAP_CANCELLED',
          message: 'remote enhancement setup cancelled with the primary SSH transport',
        };
      }

      const isSettingsFailure = stage === 'settings';
      const message =
        error instanceof Error
          ? error.message
          : isSettingsFailure
            ? 'failed to read settings'
            : 'remote bootstrap failed';
      const code = isSettingsFailure ? 'SETTINGS_READ_FAILED' : 'BOOTSTRAP_UNEXPECTED_FAILURE';
      this.remoteBootstrapService.reportStatus(statusContext, {
        type: 'bootstrap-status',
        phase: isSettingsFailure ? 'probe' : 'install',
        state: 'failed',
        code,
        message,
      });
      return { state: 'disabled', code, message };
    } finally {
      clearTimeout(ensureTimeout);
      options.signal?.removeEventListener('abort', handleParentAbort);
      const bootstrapClient = bootstrapTransport.client;
      if (bootstrapClient) {
        bootstrapTransportDisposing = true;
        if (abortController.signal.aborted) {
          bootstrapClient.destroy();
        } else {
          bootstrapClient.end();
        }
        if (bootstrapTransport.lifecycleMonitor?.isClosed()) {
          bootstrapTransport.lifecycleMonitor.release();
        }
        bootstrapTransport.client = null;
        bootstrapTransport.lifecycleMonitor = null;
      }
    }
  }

  /**
   * Emits the current enhancement runtime state and validated contract.
   *
   * @param session Live SSH session receiving the state message.
   * @returns Nothing.
   */
  private sendRemoteEnhancementRuntimeStatus(session: SshLiveSession): void {
    const contract = session.remoteEnhancementsRuntimeContract;
    this.sendServerMessage(session, {
      type: 'remote-enhancement-runtime-status',
      state: session.remoteEnhancementsRuntimeState,
      helperVersion: contract?.helperVersion,
      protocolVersion: contract?.protocolVersion,
      capabilities: contract ? [...contract.capabilities] : undefined,
      code: session.remoteEnhancementsRuntimeCode ?? undefined,
      message: session.remoteEnhancementsRuntimeMessage ?? undefined,
    });
  }

  /**
   * Starts the finite trust window for an installed helper handshake.
   *
   * @param session Live SSH session waiting for `integration-ready`.
   * @param timeoutMs Handshake deadline, overridden only by focused unit tests.
   * @returns Nothing.
   */
  private startRemoteEnhancementHandshakeTimeout(
    session: SshLiveSession,
    timeoutMs = SSH_REMOTE_ENHANCEMENT_HANDSHAKE_TIMEOUT_MS,
  ): void {
    this.clearRemoteEnhancementHandshakeTimeout(session);
    if (session.remoteEnhancementsRuntimeState !== 'pending') {
      return;
    }

    session.remoteEnhancementsHandshakeTimeout = setTimeout(
      () => {
        session.remoteEnhancementsHandshakeTimeout = null;
        if (session.disposed || session.remoteEnhancementsRuntimeState !== 'pending') {
          return;
        }

        this.disableRemoteEnhancementsRuntime(
          session,
          'HELPER_HANDSHAKE_TIMEOUT',
          'remote helper handshake was not received before the runtime deadline',
        );
      },
      Math.max(1, timeoutMs),
    );
    session.remoteEnhancementsHandshakeTimeout.unref();
  }

  /**
   * Clears the helper handshake deadline after activation, disablement, or disposal.
   *
   * @param session Live SSH session owning the timer.
   * @returns Nothing.
   */
  private clearRemoteEnhancementHandshakeTimeout(session: SshLiveSession): void {
    if (!session.remoteEnhancementsHandshakeTimeout) {
      return;
    }

    clearTimeout(session.remoteEnhancementsHandshakeTimeout);
    session.remoteEnhancementsHandshakeTimeout = null;
  }

  /**
   * Clears trusted helper-derived state and closes the runtime data gate.
   *
   * @param session Live SSH session whose remote enhancement runtime is disabled.
   * @param code Stable reason code surfaced to diagnostics.
   * @param message Operator-facing reason.
   * @returns Nothing.
   */
  private disableRemoteEnhancementsRuntime(session: SshLiveSession, code: string, message: string): void {
    this.clearRemoteEnhancementHandshakeTimeout(session);
    session.remoteEnhancementsRuntimeState = 'disabled';
    session.remoteEnhancementsRuntimeCode = code;
    session.remoteEnhancementsRuntimeMessage = message;
    this.discardPendingRemoteShellEventFrames(session);
    session.remoteShellReady = false;
    session.remoteShellAtPrompt = false;
    session.remoteShellLineLength = 0;
    session.remoteShellCwd = null;
    session.remoteShellForegroundCommand = null;
    session.lastRemoteCommand = null;
    session.lastRemoteCommandId = null;
    session.lastExitCode = null;
    session.lastCommandDurationMs = null;
    const attachment = session.agentTerminalController.getAttachment();
    if (attachment) {
      session.agentTerminalController.detach(attachment.connectionId);
    }
    this.sendRemoteEnhancementRuntimeStatus(session);
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
      session.agentTerminalController.markUserIntervened();
      if (message.data.includes('\r') || message.data.includes('\n') || message.data.includes('\u0003')) {
        session.remoteShellAtPrompt = false;
        session.remoteShellLineLength = 0;
      } else if (message.data.length > 0) {
        session.remoteShellLineLength = Math.max(1, session.remoteShellLineLength);
      }
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

      const usesStructuredCommandLifecycle = usesStructuredRemoteCommandLifecycle(
        session.remoteEnhancementsRuntimeState,
        session.remoteEnhancementsRuntimeContract?.capabilities,
      );
      if (/\r|\n/.test(message.data) && !usesStructuredCommandLifecycle) {
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
    if (session.remoteShellForegroundCommand) {
      this.sendServerMessage(session, {
        type: 'completion-response',
        requestId: message.requestId,
        replacePrefixLength: 0,
        items: [],
      });
      return;
    }

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
            if (session.remoteShellCwd) {
              return session.remoteShellCwd;
            }

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
      items: localizeTerminalCompletionItems(completionResult.items, (key) => session.t(key)),
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
        this.clearRemoteEnhancementHandshakeTimeout(session);
        const attachment = session.agentTerminalController.getAttachment();
        session.agentTerminalClosing = true;
        session.agentTerminalController.closeTerminal();
        if (attachment) {
          for (const listener of this.agentTerminalClosedListeners) {
            listener(session.sessionId, attachment.connectionId);
          }
        }
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

  /**
   * Opens one authenticated SSH transport using the shared credential, proxy, and host-trust policy.
   *
   * Each invocation creates a fresh client and, when applicable, a fresh proxy socket. This is the
   * security boundary that keeps bootstrap exec channels off the interactive terminal transport.
   *
   * @param server SSH server record with resolved keychain material.
   * @param options Attempt-scoped transport policy and cancellation state.
   * @returns Ready SSH client or a normalized connection failure.
   */
  private async openAuthenticatedClient(
    server: SshServerWithKeychain,
    options: {
      connectTimeoutSec: number;
      enableSshCompression: boolean;
      signal?: AbortSignal;
      systemProxyRules?: string;
      strictHostKey: boolean;
      trustedFingerprintSet: Set<string>;
      t: I18nInstance['t'];
    },
  ): Promise<OpenSshClientResult> {
    return await openSshClient(server, {
      connectTimeoutSec: options.connectTimeoutSec,
      db: this.getDbClient(),
      enableSshCompression: options.enableSshCompression,
      signal: options.signal,
      systemProxyRules: options.systemProxyRules,
      strictHostKey: options.strictHostKey,
      trustedFingerprintSet: options.trustedFingerprintSet,
      credentialEncryptionKey: this.credentialEncryptionKey,
      t: options.t,
    });
  }

  /**
   * Authenticates the primary SSH transport, completes isolated pre-shell setup, then opens its PTY.
   *
   * The callback deliberately receives no Client. This type-level boundary guarantees that
   * bootstrap cannot consume PAM login messages by opening an exec channel on the primary transport.
   *
   * @param server SSH server record with resolved keychain material.
   * @param options Terminal dimensions, transport policy, pre-shell setup, and output sink.
   * @returns Open interactive shell or a normalized connection failure.
   */
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
      beforeShellOpen: (signal: AbortSignal) => Promise<RemoteBootstrapResult>;
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

    const { client, completionSecretValue, lifecycleMonitor, proxyMetadata } = openResult;
    const bootstrapAbortController = new AbortController();

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
        }
        resolve(result);
      };

      const handleClientError = (error: Error): void => {
        if (settled) {
          return;
        }

        bootstrapAbortController.abort(error);
        settle({
          type: 'failed',
          message: error.message,
          proxyMetadata,
        });
        client.end();
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

      void (async () => {
        let remoteBootstrapResult: RemoteBootstrapResult;
        try {
          remoteBootstrapResult = await options.beforeShellOpen(bootstrapAbortController.signal);
        } catch (error: unknown) {
          remoteBootstrapResult = {
            state: 'disabled',
            code: 'BOOTSTRAP_UNEXPECTED_FAILURE',
            message: error instanceof Error ? error.message : 'remote bootstrap failed',
          };
        }

        if (settled) {
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
              client.end();
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

            const streamLifecycleMonitor = createSshShellStreamLifecycleMonitor(stream);

            settle({
              type: 'ready',
              client,
              stream,
              completionSecretValue,
              lifecycleMonitor,
              streamLifecycleMonitor,
              proxyMetadata,
              remoteBootstrapResult,
            });
          });
        } catch (error: unknown) {
          handleClientError(error instanceof Error ? error : new Error('SSH shell creation failed.'));
        }
      })();
    });
  }
}
