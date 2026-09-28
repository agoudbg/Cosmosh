/** Current OSC contract version shared by the desktop runtime and remote helper. */
export const REMOTE_SHELL_PROTOCOL_VERSION = 3;

/** Shells supported by the Remote Enhancements helper. */
export const REMOTE_SHELL_NAMES = ['bash', 'zsh', 'fish', 'sh', 'ash'] as const;

/** Remote shell events accepted from the trusted helper runtime. */
export const REMOTE_SHELL_EVENT_NAMES = [
  'integration-ready',
  'prompt-ready',
  'cwd',
  'command-start',
  'command-end',
  'foreground-command',
  'line-state',
] as const;

/** Capabilities that a helper may advertise after installation validation. */
export const REMOTE_SHELL_CAPABILITIES = [
  'cwd',
  'command-start',
  'command-end',
  'foreground-command',
  'prompt-ready',
  'line-state',
  'input-snapshot',
  'input-apply',
  'directory-read',
  'history-read',
  'native-completion',
] as const;

/** Supported remote login shell name. */
export type RemoteShellName = (typeof REMOTE_SHELL_NAMES)[number];

/** Event name emitted by a supported remote shell helper. */
export type RemoteShellEventName = (typeof REMOTE_SHELL_EVENT_NAMES)[number];

/** Capability name advertised by a supported remote shell helper. */
export type RemoteShellCapability = (typeof REMOTE_SHELL_CAPABILITIES)[number];

/** Shared fields carried by every trusted remote shell event. */
type RemoteShellEventBase = {
  type: 'remote-shell-event';
  shell: RemoteShellName;
  helperVersion: string;
  protocolVersion: number;
  capabilities: RemoteShellCapability[];
  shellInstanceId: string;
  timestamp: number;
  cwd?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  commandId?: string;
  promptGeneration?: number;
  lineLength?: number;
  cursorIndex?: number;
};

/**
 * Discriminated helper event forwarded by Backend only after contract validation.
 *
 * Command events contain only a sanitized executable name. Line-state events contain
 * lengths and cursor metadata, never the command buffer itself.
 */
export type RemoteShellEventMessage = RemoteShellEventBase &
  (
    | { event: 'integration-ready' }
    | { event: 'prompt-ready'; promptGeneration?: number }
    | { event: 'cwd'; cwd: string }
    | { event: 'command-start'; command: string; commandId: string }
    | { event: 'command-end'; command: string; commandId: string; exitCode: number; durationMs: number }
    | { event: 'foreground-command'; command: string; commandId: string }
    | { event: 'line-state'; lineLength: number; cursorIndex: number; promptGeneration: number }
  );

/** User permissions are independent of the capabilities installed by a helper. */
export type ShellPermissions = {
  cwd: boolean;
  input: boolean;
  history: boolean;
  paths: boolean;
  nativeCompletion: boolean;
};

/** Current usability of the original interactive Shell, not a guess from screen text. */
export type ShellContextStatus = 'unavailable' | 'initializing' | 'ready' | 'busy' | 'paused';

/** Stable reason codes used by capability diagnostics without retaining terminal text. */
export type ShellContextReason =
  | 'helper-unavailable'
  | 'waiting-for-prompt'
  | 'command-running'
  | 'input-submitted'
  | 'foreign-shell'
  | 'unsupported-editor'
  | 'permission-disabled'
  | 'transport-closed';

/** One Shell-confirmed directory report; logical/physical path separation is filled by v3 adapters. */
export type ShellDirectoryContext = {
  logical: string;
  physical: string | null;
  home: string | null;
};

/**
 * Backend-owned state shared by enhancement consumers for one terminal session.
 * It never contains current input text or credentials. Revision counters invalidate asynchronous work.
 */
export type ShellContext = {
  sessionId: string;
  shellInstanceId: string | null;
  shell: RemoteShellName | null;
  helperVersion: string | null;
  protocolVersion: number | null;
  capabilities: RemoteShellCapability[];
  permissions: ShellPermissions;
  status: ShellContextStatus;
  reason: ShellContextReason | null;
  revision: number;
  inputGeneration: number;
  promptGeneration: number | null;
  cwdGeneration: number;
  cwd: ShellDirectoryContext | null;
  lastKnownCwd: ShellDirectoryContext | null;
};

/** Phase names emitted by Remote Bootstrap orchestration. */
export type RemoteBootstrapPhase = 'probe' | 'manifest' | 'download' | 'install' | 'verify';

/** State names emitted by Remote Bootstrap orchestration. */
export type RemoteBootstrapState = 'started' | 'ok' | 'skipped' | 'failed';

/** Bootstrap progress message forwarded from Backend to one terminal session. */
export type RemoteBootstrapStatus = {
  type: 'bootstrap-status';
  phase: RemoteBootstrapPhase;
  state: RemoteBootstrapState;
  version?: string;
  code?: string;
  message?: string;
};

/** Backend-owned trust state for one installed Remote Enhancements runtime. */
export type RemoteEnhancementRuntimeStatus = {
  type: 'remote-enhancement-runtime-status';
  state: 'pending' | 'active' | 'disabled';
  helperVersion?: string;
  protocolVersion?: number;
  capabilities?: RemoteShellCapability[];
  code?: string;
  message?: string;
};

/** Opaque, expiring prompt action; the saved login password remains in Backend memory. */
export type TerminalCredentialFillOffer = {
  token: string;
  expiresAt: number;
};

/** Result of an explicitly requested saved-login-password action; never carries a secret. */
export type TerminalCredentialFillResult =
  | { type: 'credential-fill-result'; token: string; status: 'filled' }
  | {
      type: 'credential-fill-result';
      token: string;
      status: 'rejected';
      reason: 'stale' | 'expired' | 'disabled' | 'unavailable' | 'failed';
    };

/** Completion candidate transferred over a terminal WebSocket. */
export type TerminalCompletionItem = {
  id: string;
  label: string;
  insertText: string;
  replacePrefixLength?: number;
  detail: string | null;
  source: 'history' | 'inshellisense' | 'runtime';
  kind: 'command' | 'subcommand' | 'option' | 'history' | 'path';
  score: number;
};

/** Renderer-to-Backend messages supported by interactive terminal sessions. */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' }
  | { type: 'ping' }
  | { type: 'history-delete'; command: string }
  | { type: 'credential-fill'; token: string }
  | {
      type: 'completion-request';
      requestId: string;
      linePrefix: string;
      cursorIndex: number;
      workingDirectoryHint?: string;
      limit?: number;
      fuzzyMatch?: boolean;
      includeHistory?: boolean;
      includeBuiltInCommands?: boolean;
      includePathSuggestions?: boolean;
      trigger: 'typing' | 'manual';
    };

/** Messages common to local and SSH terminal WebSocket sessions. */
export type TerminalServerMessage =
  | { type: 'credential-fill-offer'; offer: TerminalCredentialFillOffer | null }
  | TerminalCredentialFillResult
  | { type: 'ready' }
  | { type: 'output'; data: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; reason: string }
  | { type: 'pong' }
  | {
      type: 'telemetry';
      cpuUsagePercent: number | null;
      memoryUsedBytes: number | null;
      memoryTotalBytes: number | null;
      networkRxBytesPerSec: number | null;
      networkTxBytesPerSec: number | null;
      recentCommands: string[];
    }
  | { type: 'history'; recentCommands: string[] }
  | {
      type: 'completion-response';
      requestId: string;
      replacePrefixLength: number;
      items: TerminalCompletionItem[];
    };

/** Complete Backend-to-Renderer message contract for SSH terminal sessions. */
export type SshTerminalServerMessage =
  | TerminalServerMessage
  | RemoteBootstrapStatus
  | RemoteEnhancementRuntimeStatus
  | RemoteShellEventMessage
  | { type: 'shell-context'; context: ShellContext };
