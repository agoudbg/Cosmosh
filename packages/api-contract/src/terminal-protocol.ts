/** Current OSC contract version shared by the desktop runtime and remote helper. */
export const REMOTE_SHELL_PROTOCOL_VERSION = 3;

/** Shells supported by the Remote Enhancements helper. */
export const REMOTE_SHELL_NAMES = ['bash', 'zsh', 'fish', 'sh', 'ash'] as const;

/** Remote shell events accepted from the trusted helper runtime. */
export const REMOTE_SHELL_EVENT_NAMES = [
  'integration-ready',
  'prompt-ready',
  'cwd',
  'cwd-invalidated',
  'command-start',
  'command-end',
  'foreground-command',
  'line-state',
  'editor-state',
] as const;

/** Capabilities that a helper may advertise after installation validation. */
export const REMOTE_SHELL_CAPABILITIES = [
  'cwd',
  'cwd-invalidated',
  'command-start',
  'command-end',
  'foreground-command',
  'prompt-ready',
  'line-state',
  'editor-state',
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
  physicalCwd?: string | null;
  homeDirectory?: string | null;
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
    | { event: 'cwd'; cwd: string; physicalCwd: string | null; homeDirectory: string | null }
    | { event: 'cwd-invalidated'; promptGeneration: number }
    | { event: 'command-start'; command: string; commandId: string }
    | { event: 'command-end'; command: string; commandId: string; exitCode: number; durationMs: number }
    | { event: 'foreground-command'; command: string; commandId: string }
    | { event: 'line-state'; lineLength: number; cursorIndex: number; promptGeneration: number }
    | {
        event: 'editor-state';
        promptGeneration: number;
        pid: number;
        startTime: string;
        available: boolean;
        triggerNonce: string;
        notification?: ShellEditorNotification;
      }
  );

/** Metadata identifying one installed original-Shell editor and its currently owned binding epoch. */
export type ShellEditorTarget = {
  instanceId: string;
  shell: 'bash' | 'zsh' | 'fish';
  pid: number;
  startTime: string;
};

/** Private Shell wake-up metadata; contains no command or terminal input. */
export type ShellEditorNotification = { fd: number; inode: string } | { signal: 'URG' } | { callback: 'readline' };

/** Complete input buffer with a Unicode codepoint cursor offset; never persisted or included in OSC/debug events. */
export type ShellEditorBuffer = { text: string; cursor: number };

/** Connection identity and latest input sequence acknowledged by the original remote PTY owner. */
export type ShellInputBoundary = { epoch: string; sequence: number };

/** Original Shell history in native newest-first order; private mode returns no namespace or records. */
export type ShellNativeHistory = {
  status: 'ok' | 'partial' | 'private';
  namespace: string | null;
  entries: string[];
};

/** One current native history source. The opaque ID changes when its permission or namespace lifetime ends. */
export type ShellHistorySource = { id: string; shell: 'fish'; namespace: string };

/** Exact newest-first native records, or an explicit state with no retained private history. */
export type ShellHistoryView =
  | { status: 'ok' | 'partial'; source: ShellHistorySource; entries: string[] }
  | { status: 'disabled' | 'unsupported' | 'unavailable' | 'private'; source: null; entries: [] };

/** Removal is scoped to the original reader; native history-file persistence remains unconfirmed. */
export type ShellHistoryRemovalResult = {
  type: 'shell-history-remove-result';
  requestId: string;
  sourceId: string;
  status: 'removed-from-reader' | 'stale' | 'unavailable' | 'unknown';
};

/** A requested, editor-owned observation, retained only in session memory. */
export type ShellEditorSnapshot = {
  promptGeneration: number;
  editorMode: 'emacs' | 'vi-insert';
  buffer?: ShellEditorBuffer;
  directory?: ShellDirectoryContext;
  history?: ShellNativeHistory;
};

/** Literal values decoded by the query Fish; descriptions are display-only, never Shell code. */
export type ShellNativeCompletionEntry = { token: string; value: string; detail: string | null };

/** Bounded isolated Fish query. Partial results reached a limit or omitted unsupported rows. */
export type ShellNativeCompletionResult = {
  status: 'ok' | 'partial' | 'timeout' | 'unavailable';
  entries: ShellNativeCompletionEntry[];
};

/** Private stdin request to the bounded remote helper process. */
export type ShellEditorRequest = {
  requestId: string;
  target: ShellEditorTarget;
  inputBoundary: ShellInputBoundary;
  operation: 'context' | 'snapshot' | 'apply' | 'history' | 'history-delete' | 'native-completion';
  promptGeneration: number;
  includeDirectory: boolean;
  notification?: ShellEditorNotification;
  /** Native completion requires the exact input/CWD snapshot; history-delete requires one native record. */
  expected?: ShellEditorSnapshot;
  replacement?: ShellEditorBuffer;
};

/** Data-only directory query sent to the installed helper through bounded SSH stdin. */
export type ShellPathQueryRequest = {
  directory: string;
  fragment: string;
  directoriesOnly: boolean;
  fuzzyMatch: boolean;
  limit: number;
};

/** Complete literal directory entry; names are never split or trimmed. */
export type ShellPathEntry = { name: string; kind: 'file' | 'directory' };

/** Stable directory source outcome; partial indicates the scan reached 10,000 entries. */
export type ShellPathQueryResult = {
  status:
    'ok' | 'partial' | 'denied' | 'missing' | 'not-directory' | 'invalid' | 'unavailable' | 'timeout' | 'cancelled';
  entries: ShellPathEntry[];
  scanned: number;
};

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

/** Original Shell directory metadata: logical for display, physical for file operations, home for tilde expansion. */
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
  /** Opaque identifier of the last submitted input received by Backend; never contains input text. */
  submissionToken: string | null;
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

/** Display-only suggestion bound to a private snapshot; edits remain in the owning Backend session. */
export type ShellCompletionCandidate = {
  id: string;
  label: string;
  detail: string | null;
  detailI18nKey?: string;
  source: 'history' | 'inshellisense' | 'runtime' | 'fish';
  kind: 'command' | 'subcommand' | 'option' | 'argument' | 'history' | 'path';
};

/** Legacy completion candidate transferred over a terminal WebSocket. */
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
  | { type: 'input'; data: string; submissionToken?: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' }
  | { type: 'ping' }
  | { type: 'history-delete'; command: string }
  | { type: 'shell-history-remove'; requestId: string; sourceId: string; command: string }
  | { type: 'credential-fill'; token: string }
  | { type: 'editor-snapshot'; requestId: string }
  | { type: 'editor-apply'; requestId: string; snapshotId: string; replacement: ShellEditorBuffer }
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
  | {
      type: 'editor-snapshot-result';
      requestId: string;
      status: 'ok';
      snapshotId: string;
      snapshot: ShellEditorSnapshot;
    }
  | { type: 'editor-snapshot-result'; requestId: string; status: 'stale' | 'unavailable' | 'unsupported' | 'unknown' }
  | {
      type: 'editor-apply-result';
      requestId: string;
      status: 'applied' | 'stale' | 'unavailable' | 'unsupported' | 'unknown';
    }
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
  | { type: 'shell-history'; view: ShellHistoryView }
  | ShellHistoryRemovalResult
  | RemoteBootstrapStatus
  | RemoteEnhancementRuntimeStatus
  | RemoteShellEventMessage
  | { type: 'shell-context'; context: ShellContext };
