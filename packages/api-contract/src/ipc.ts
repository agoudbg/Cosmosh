export const APP_MENU_ACTIONS = [
  'open-about',
  'open-settings',
  'new-tab',
  'close-current-tab',
  'close-right-tabs',
  'show-tab-switcher',
] as const;

export type AppMenuAction = (typeof APP_MENU_ACTIONS)[number];

export const LEGAL_DOCUMENT_IDS = ['project', 'chromium', 'third-party'] as const;

export type LegalDocumentId = (typeof LEGAL_DOCUMENT_IDS)[number];

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

export type SystemProxyResolveRequest = {
  host: string;
  port: number;
};

export type SystemProxyResolveResult = {
  proxyRules: string;
};

const APP_MENU_ACTION_SET: ReadonlySet<string> = new Set(APP_MENU_ACTIONS);
const LEGAL_DOCUMENT_ID_SET: ReadonlySet<string> = new Set(LEGAL_DOCUMENT_IDS);

/**
 * Checks whether an IPC payload is a supported app menu action.
 *
 * @param value Unknown IPC payload.
 * @returns True when the payload matches a known app menu action.
 */
export const isAppMenuAction = (value: unknown): value is AppMenuAction => {
  return typeof value === 'string' && APP_MENU_ACTION_SET.has(value);
};

/**
 * Checks whether an unknown renderer payload identifies a supported legal document.
 *
 * @param value Unknown IPC payload.
 * @returns True when the payload matches a supported legal document identifier.
 */
export const isLegalDocumentId = (value: unknown): value is LegalDocumentId => {
  return typeof value === 'string' && LEGAL_DOCUMENT_ID_SET.has(value);
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
