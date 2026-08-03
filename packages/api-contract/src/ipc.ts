export const APP_MENU_ACTIONS = [
  'open-about',
  'open-settings',
  'new-tab',
  'close-current-tab',
  'close-right-tabs',
  'show-tab-switcher',
] as const;

export type AppMenuAction = (typeof APP_MENU_ACTIONS)[number];

/**
 * Main-to-renderer request to display the guarded window close confirmation.
 */
export type AppCloseConfirmationRequest = {
  requestId: string;
};

/**
 * Renderer response that resolves one guarded window close confirmation.
 */
export type AppCloseConfirmationResponse = {
  requestId: string;
  confirmed: boolean;
};

/** Window-level progress states accepted by Electron presentation IPC. */
export type TerminalWindowProgressState = 'none' | 'normal' | 'error' | 'indeterminate' | 'warning';

/** Identity of the latest standalone Bell observed across one renderer window. */
export type TerminalWindowBellEvent = {
  tabId: string;
  paneId: string;
  /** Renderer-window monotonic Bell sequence used to order equal timestamps. */
  sequence: number;
  receivedAt: number;
};

/**
 * Memory-only terminal activity snapshot sent from renderer to its owning window.
 *
 * Progress and Bell remain independent: clearing progress never creates a Bell
 * event, and acknowledging Bell attention does not discard the latest event
 * identity used for edge de-duplication.
 */
export type TerminalWindowActivity = {
  progressState: TerminalWindowProgressState;
  progressValue: number | null;
  bellAttention: boolean;
  bellAudibleEnabled: boolean;
  bellFlashEnabled: boolean;
  latestBellEvent: TerminalWindowBellEvent | null;
};

/** Allow-listed renderer-to-main channel for terminal window activity snapshots. */
export const TERMINAL_WINDOW_ACTIVITY_IPC_CHANNEL = 'app:set-terminal-window-activity';

export type SystemProxyResolveRequest = {
  host: string;
  port: number;
};

export type SystemProxyResolveResult = {
  proxyRules: string;
};

const APP_MENU_ACTION_SET: ReadonlySet<string> = new Set(APP_MENU_ACTIONS);
const TERMINAL_WINDOW_PROGRESS_STATE_SET: ReadonlySet<string> = new Set([
  'none',
  'normal',
  'error',
  'indeterminate',
  'warning',
]);
const MAX_TERMINAL_WINDOW_ACTIVITY_SOURCE_ID_LENGTH = 128;

/**
 * Checks whether one Bell source identifier is safe to carry across IPC.
 *
 * @param value Unknown source identifier.
 * @returns Whether the value is bounded and contains no terminal controls.
 */
const isTerminalWindowActivitySourceId = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TERMINAL_WINDOW_ACTIVITY_SOURCE_ID_LENGTH) {
    return false;
  }

  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f);
  });
};

/**
 * Parses an untrusted terminal window activity IPC payload.
 *
 * @param value Unknown renderer payload.
 * @returns A cloned, strictly validated snapshot, or `null` when malformed.
 */
export const parseTerminalWindowActivity = (value: unknown): TerminalWindowActivity | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.progressState !== 'string' ||
    !TERMINAL_WINDOW_PROGRESS_STATE_SET.has(candidate.progressState) ||
    typeof candidate.bellAttention !== 'boolean' ||
    typeof candidate.bellAudibleEnabled !== 'boolean' ||
    typeof candidate.bellFlashEnabled !== 'boolean'
  ) {
    return null;
  }

  const progressState = candidate.progressState as TerminalWindowProgressState;
  const expectsProgressValue = progressState === 'normal' || progressState === 'error' || progressState === 'warning';
  if (
    (expectsProgressValue &&
      (typeof candidate.progressValue !== 'number' ||
        !Number.isInteger(candidate.progressValue) ||
        candidate.progressValue < 0 ||
        candidate.progressValue > 100)) ||
    (!expectsProgressValue && candidate.progressValue !== null)
  ) {
    return null;
  }

  const latestBellEvent = candidate.latestBellEvent;
  if (latestBellEvent !== null) {
    if (!latestBellEvent || typeof latestBellEvent !== 'object' || Array.isArray(latestBellEvent)) {
      return null;
    }

    const bellCandidate = latestBellEvent as Record<string, unknown>;
    if (
      !isTerminalWindowActivitySourceId(bellCandidate.tabId) ||
      !isTerminalWindowActivitySourceId(bellCandidate.paneId) ||
      typeof bellCandidate.sequence !== 'number' ||
      !Number.isSafeInteger(bellCandidate.sequence) ||
      bellCandidate.sequence <= 0 ||
      typeof bellCandidate.receivedAt !== 'number' ||
      !Number.isSafeInteger(bellCandidate.receivedAt) ||
      bellCandidate.receivedAt < 0
    ) {
      return null;
    }

    return {
      progressState,
      progressValue: expectsProgressValue ? (candidate.progressValue as number) : null,
      bellAttention: candidate.bellAttention,
      bellAudibleEnabled: candidate.bellAudibleEnabled,
      bellFlashEnabled: candidate.bellFlashEnabled,
      latestBellEvent: {
        tabId: bellCandidate.tabId,
        paneId: bellCandidate.paneId,
        sequence: bellCandidate.sequence,
        receivedAt: bellCandidate.receivedAt,
      },
    };
  }

  return {
    progressState,
    progressValue: expectsProgressValue ? (candidate.progressValue as number) : null,
    bellAttention: candidate.bellAttention,
    bellAudibleEnabled: candidate.bellAudibleEnabled,
    bellFlashEnabled: candidate.bellFlashEnabled,
    latestBellEvent: null,
  };
};

/**
 * Checks whether an IPC payload is a supported app menu action.
 *
 * @param value Unknown IPC payload.
 * @returns True when the payload matches a known app menu action.
 */
export const isAppMenuAction = (value: unknown): value is AppMenuAction => {
  return typeof value === 'string' && APP_MENU_ACTION_SET.has(value);
};

export type SftpOpenWithApplication = {
  id: string;
  name: string;
  path: string;
  bundleIdentifier?: string;
  iconDataUrl?: string;
};

export type SftpTemporaryFileWatchChange = {
  watchId: string;
  localPath: string;
  size: number;
  modifiedAt: string;
};

/**
 * One user-selected local file staged under the Cosmosh-controlled SFTP temp root.
 */
export type SftpUploadLocalFile = {
  name: string;
  localPath: string;
  size: number;
  modifiedAt: string;
};

/**
 * Why a dropped local filesystem entry could not be staged for SFTP upload.
 */
export type SftpUploadRejectedLocalEntryReason =
  'directory-unsupported' | 'not-file' | 'path-unavailable' | 'unreadable';

/**
 * One dropped local entry that main/preload declined before SFTP upload.
 */
export type SftpUploadRejectedLocalEntry = {
  name: string;
  reason: SftpUploadRejectedLocalEntryReason;
};

/**
 * Local path payload resolved by preload for dropped SFTP upload entries.
 *
 * Renderer code never constructs this shape; it passes File objects to preload,
 * and preload narrows them to paths before invoking main.
 */
export type SftpDroppedUploadLocalEntry = {
  name: string;
  localPath?: string;
};

/**
 * Result returned by the native SFTP upload file picker.
 */
export type SftpUploadFileSelection = {
  canceled: boolean;
  files: SftpUploadLocalFile[];
  rejectedEntries?: SftpUploadRejectedLocalEntry[];
};

/** HTTP methods mirrored by the development backend request trace store. */
export type BackendRequestTraceMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Body representation categories used by the request trace DevTools panel. */
export type BackendRequestTraceBodyKind = 'empty' | 'json' | 'text';

/** Bounded, sanitized request or response body captured for development diagnostics. */
export type BackendRequestTraceBody = {
  kind: BackendRequestTraceBodyKind;
  sizeBytes: number;
  truncated: boolean;
  value: unknown;
};

/** Sanitized mirror of one completed main-process backend proxy request. */
export type BackendRequestTrace = {
  id: string;
  startedAt: string;
  completedAt: string;
  method: BackendRequestTraceMethod;
  path: string;
  status: number | null;
  ok: boolean | null;
  durationMs: number;
  requestBody: BackendRequestTraceBody;
  responseBody: BackendRequestTraceBody;
  requestId?: string;
  error?: string;
  truncated: boolean;
};
