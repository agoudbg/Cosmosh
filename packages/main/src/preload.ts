import type {
  ApiAuditEventDetailResponse,
  ApiAuditEventListQuery,
  ApiAuditEventListResponse,
  ApiErrorResponse,
  ApiLocalTerminalCreateSessionRequest,
  ApiLocalTerminalCreateSessionResponse,
  ApiLocalTerminalListProfilesResponse,
  ApiPortForwardCreateRuleRequest,
  ApiPortForwardCreateRuleResponse,
  ApiPortForwardListRulesResponse,
  ApiPortForwardStartRuleRequest,
  ApiPortForwardStartRuleResponse,
  ApiPortForwardStopRuleResponse,
  ApiPortForwardUpdateRuleRequest,
  ApiPortForwardUpdateRuleResponse,
  ApiSettingsGetResponse,
  ApiSettingsUpdateRequest,
  ApiSettingsUpdateResponse,
  ApiSftpArchiveCancelResponse,
  ApiSftpArchiveCapabilitiesResponse,
  ApiSftpArchiveConflictResolutionRequest,
  ApiSftpArchiveConflictResolutionResponse,
  ApiSftpArchiveOperationAcceptedResponse,
  ApiSftpArchiveOperationRequest,
  ApiSftpArchiveOperationStatusResponse,
  ApiSftpBatchOperationRequest,
  ApiSftpBatchOperationResponse,
  ApiSftpCopyRequest,
  ApiSftpCopyResponse,
  ApiSftpCreateDirectoryRequest,
  ApiSftpCreateDirectoryResponse,
  ApiSftpCreateFileRequest,
  ApiSftpCreateFileResponse,
  ApiSftpCreateSessionHostVerificationRequiredResponse,
  ApiSftpCreateSessionRequest,
  ApiSftpCreateSessionResponse,
  ApiSftpDeleteRequest,
  ApiSftpDeleteResponse,
  ApiSftpDownloadFileRequest,
  ApiSftpDownloadFileResponse,
  ApiSftpEntryDetailsRequest,
  ApiSftpEntryDetailsResponse,
  ApiSftpGetTaskResponse,
  ApiSftpListDirectoryQuery,
  ApiSftpListDirectoryResponse,
  ApiSftpListTasksResponse,
  ApiSftpReadFileQuery,
  ApiSftpReadFileResponse,
  ApiSftpRenameRequest,
  ApiSftpRenameResponse,
  ApiSftpStartTaskRequest,
  ApiSftpStartTaskResponse,
  ApiSftpTransferProgressResponse,
  ApiSftpUploadFileRequest,
  ApiSftpUploadFileResponse,
  ApiSftpWriteFileRequest,
  ApiSftpWriteFileResponse,
  ApiSshCreateFolderRequest,
  ApiSshCreateFolderResponse,
  ApiSshCreateKeychainRequest,
  ApiSshCreateKeychainResponse,
  ApiSshCreateServerRequest,
  ApiSshCreateServerResponse,
  ApiSshCreateSessionHostVerificationRequiredResponse,
  ApiSshCreateSessionRequest,
  ApiSshCreateSessionResponse,
  ApiSshCreateTagRequest,
  ApiSshCreateTagResponse,
  ApiSshGetKeychainCredentialsResponse,
  ApiSshGetServerCredentialsResponse,
  ApiSshListFoldersResponse,
  ApiSshListKeychainsResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiSshTrustFingerprintRequest,
  ApiSshTrustFingerprintResponse,
  ApiSshUpdateFolderRequest,
  ApiSshUpdateFolderResponse,
  ApiSshUpdateKeychainRequest,
  ApiSshUpdateKeychainResponse,
  ApiSshUpdateServerRequest,
  ApiSshUpdateServerResponse,
  ApiTestPingResponse,
  AppCloseConfirmationRequest,
  AppCloseConfirmationResponse,
  AppMenuAction,
  BackendRequestTrace,
  SftpDroppedUploadLocalEntry,
  SftpOpenWithApplication,
  SftpTemporaryFileWatchChange,
  SftpUploadFileSelection,
  SystemProxyResolveRequest,
  SystemProxyResolveResult,
  TerminalWindowActivity,
} from '@cosmosh/api-contract';
import { parseTerminalWindowActivity, TERMINAL_WINDOW_ACTIVITY_IPC_CHANNEL } from '@cosmosh/api-contract';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const PRELOAD_APP_MENU_ACTIONS: ReadonlySet<AppMenuAction> = new Set([
  'open-about',
  'open-settings',
  'new-tab',
  'close-current-tab',
  'close-right-tabs',
  'show-tab-switcher',
]);
const MAX_CLOSE_CONFIRMATION_REQUEST_ID_LENGTH = 128;

/**
 * Checks whether an app-menu IPC payload is safe to forward into the renderer.
 *
 * @param value Unknown IPC payload.
 * @returns Whether the payload is a supported app menu action.
 */
const isAppMenuAction = (value: unknown): value is AppMenuAction => {
  return typeof value === 'string' && PRELOAD_APP_MENU_ACTIONS.has(value as AppMenuAction);
};

/**
 * Typed IPC invoke helper used by all bridge methods.
 * Centralizing this adapter keeps renderer-call transport swappable in future browser builds.
 *
 * @param channel IPC channel name.
 * @param args Optional IPC payload args.
 * @returns Promise resolving to typed response payload.
 */
const invokeIpc = <TResponse>(channel: string, ...args: unknown[]): Promise<TResponse> => {
  return ipcRenderer.invoke(channel, ...args) as Promise<TResponse>;
};

type DroppedSftpUploadFile = Parameters<typeof webUtils.getPathForFile>[0];

/**
 * Resolves dropped File objects into the narrow path payload accepted by main.
 *
 * @param files Renderer-provided dropped File objects.
 * @returns Preload-resolved dropped upload entries.
 */
const resolveDroppedSftpUploadLocalEntries = (files: unknown): SftpDroppedUploadLocalEntry[] => {
  if (!Array.isArray(files)) {
    return [];
  }

  return files.map((file) => {
    const fileRecord = file && typeof file === 'object' ? (file as Record<string, unknown>) : {};
    const name = typeof fileRecord.name === 'string' ? fileRecord.name : '';
    let localPath = '';
    try {
      localPath = webUtils.getPathForFile(file as DroppedSftpUploadFile);
    } catch {
      localPath = '';
    }

    return {
      name,
      ...(localPath ? { localPath } : {}),
    };
  });
};

/**
 * Fire-and-forget IPC send helper.
 *
 * @param channel IPC channel name.
 * @param args Optional IPC payload args.
 * @returns void.
 */
const sendIpc = (channel: string, ...args: unknown[]): void => {
  ipcRenderer.send(channel, ...args);
};

const closeConfirmationListeners = new Set<(request: AppCloseConfirmationRequest) => void>();
let bufferedCloseConfirmationRequest: AppCloseConfirmationRequest | null = null;

/**
 * Validates a Main-owned close confirmation request before renderer delivery.
 *
 * @param value Untrusted Main-to-preload IPC payload.
 * @returns Validated request, or `null` when malformed.
 */
const parseCloseConfirmationRequest = (value: unknown): AppCloseConfirmationRequest | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const requestId = (value as Record<string, unknown>).requestId;
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > MAX_CLOSE_CONFIRMATION_REQUEST_ID_LENGTH
  ) {
    return null;
  }

  return { requestId };
};

/**
 * Validates a renderer response before sending it across the preload boundary.
 *
 * @param value Renderer-provided response payload.
 * @returns Validated response, or `null` when malformed.
 */
const parseCloseConfirmationResponse = (value: unknown): AppCloseConfirmationResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requestId !== 'string' ||
    candidate.requestId.length === 0 ||
    candidate.requestId.length > MAX_CLOSE_CONFIRMATION_REQUEST_ID_LENGTH ||
    typeof candidate.confirmed !== 'boolean'
  ) {
    return null;
  }

  return {
    requestId: candidate.requestId,
    confirmed: candidate.confirmed,
  };
};

/**
 * Subscribes to close confirmation requests and replays one request that arrived
 * before the React root mounted.
 *
 * @param listener Renderer callback that opens the confirmation dialog.
 * @returns Unsubscribe callback.
 */
const onCloseConfirmationRequested = (listener: (request: AppCloseConfirmationRequest) => void): (() => void) => {
  closeConfirmationListeners.add(listener);

  if (bufferedCloseConfirmationRequest) {
    const request = bufferedCloseConfirmationRequest;
    bufferedCloseConfirmationRequest = null;
    listener(request);
  }

  return () => {
    closeConfirmationListeners.delete(listener);
  };
};

ipcRenderer.on('app:close-confirmation-request', (_event, value: unknown) => {
  const request = parseCloseConfirmationRequest(value);
  if (!request) {
    return;
  }

  if (closeConfirmationListeners.size === 0) {
    bufferedCloseConfirmationRequest = request;
    return;
  }

  for (const listener of closeConfirmationListeners) {
    listener(request);
  }
});

/**
 * Subscribes to string payload events and returns an unsubscribe callback.
 *
 * @param channel IPC channel name.
 * @param listener Callback invoked only for valid string payloads.
 * @returns Unsubscribe callback.
 */
const onIpcStringPayload = (channel: string, listener: (payload: string) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    if (typeof payload !== 'string') {
      return;
    }

    listener(payload);
  };

  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

/**
 * Subscribes to validated application menu action events.
 *
 * @param listener Callback invoked for known app menu actions only.
 * @returns Unsubscribe callback.
 */
const onIpcAppMenuActionPayload = (listener: (action: AppMenuAction) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, action: unknown) => {
    if (!isAppMenuAction(action)) {
      return;
    }

    listener(action);
  };

  ipcRenderer.on('app:menu-action', handler);

  return () => {
    ipcRenderer.removeListener('app:menu-action', handler);
  };
};

/**
 * Checks whether an IPC payload is an SFTP temp-file change event.
 *
 * @param value Unknown IPC payload.
 * @returns Whether the payload matches the watched temp-file change shape.
 */
const isSftpTemporaryFileWatchChange = (value: unknown): value is SftpTemporaryFileWatchChange => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return (
    typeof payload.watchId === 'string' &&
    typeof payload.localPath === 'string' &&
    typeof payload.size === 'number' &&
    typeof payload.modifiedAt === 'string'
  );
};

/**
 * Subscribes to validated SFTP temp-file change events.
 *
 * @param listener Callback invoked for changed temp files.
 * @returns Unsubscribe callback.
 */
const onSftpTemporaryFileChanged = (listener: (change: SftpTemporaryFileWatchChange) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    if (!isSftpTemporaryFileWatchChange(payload)) {
      return;
    }

    listener(payload);
  };

  ipcRenderer.on('app:sftp-temporary-file-changed', handler);

  return () => {
    ipcRenderer.removeListener('app:sftp-temporary-file-changed', handler);
  };
};

/**
 * Subscribes to backend request trace mirror events.
 *
 * @param listener Callback invoked for sanitized request traces.
 * @returns Unsubscribe callback.
 */
const onBackendRequestTrace = (listener: (trace: BackendRequestTrace) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: BackendRequestTrace) => {
    listener(payload);
  };

  ipcRenderer.on('debug:backend-request-trace-event', handler);

  return () => {
    ipcRenderer.removeListener('debug:backend-request-trace-event', handler);
  };
};

/**
 * Exposes a minimal, allow-listed bridge API to renderer.
 * Security boundary: renderer never gets direct access to raw `ipcRenderer`.
 */
contextBridge.exposeInMainWorld('electron', {
  // ---------------------------------------------------------------------------
  // App window and locale controls
  // ---------------------------------------------------------------------------
  closeWindow: () => {
    sendIpc('app:close-window');
  },
  setTerminalWindowActivity: (value: TerminalWindowActivity) => {
    const activity = parseTerminalWindowActivity(value);
    if (activity) {
      sendIpc(TERMINAL_WINDOW_ACTIVITY_IPC_CHANNEL, activity);
    }
  },
  onCloseConfirmationRequested,
  respondToCloseConfirmation: (value: AppCloseConfirmationResponse) => {
    const response = parseCloseConfirmationResponse(value);
    if (response) {
      sendIpc('app:close-confirmation-response', response);
    }
  },
  getLocale: () => {
    return invokeIpc<string>('i18n:get-locale');
  },
  setLocale: (locale: string) => {
    return invokeIpc<string>('i18n:set-locale', locale);
  },
  getRuntimeUserName: () => {
    return invokeIpc<string>('app:get-runtime-user-name');
  },
  getAppVersionInfo: () => {
    return invokeIpc<{
      appName: string;
      version: string;
      buildVersion: string;
      buildTime: string;
      commit: string;
      electron: string;
      chromium: string;
      node: string;
      v8: string;
      os: string;
    }>('app:get-version-info');
  },
  getPendingLaunchWorkingDirectory: () => {
    return invokeIpc<string | null>('app:get-pending-launch-working-directory');
  },
  getDownloadsPath: () => {
    return invokeIpc<string>('app:get-downloads-path');
  },
  createSftpTemporaryFile: (fileName: string) => {
    return invokeIpc<string>('app:create-sftp-temporary-file', fileName);
  },
  createSftpDownloadsFile: (fileName: string) => {
    return invokeIpc<string>('app:create-sftp-downloads-file', fileName);
  },
  selectSftpUploadFiles: () => {
    return invokeIpc<SftpUploadFileSelection>('app:select-sftp-upload-files');
  },
  stageDroppedSftpUploadFiles: (files: File[]) => {
    return invokeIpc<SftpUploadFileSelection>(
      'app:stage-sftp-dropped-upload-files',
      resolveDroppedSftpUploadLocalEntries(files),
    );
  },
  cleanupSftpTemporaryFiles: (localPaths: string[]) => {
    return invokeIpc<boolean>('app:cleanup-sftp-temporary-files', localPaths);
  },
  openSftpTemporaryFile: (localPath: string) => {
    return invokeIpc<boolean>('app:open-sftp-temporary-file', localPath);
  },
  readSftpTemporaryImagePreview: (localPath: string) => {
    return invokeIpc<string>('app:read-sftp-temporary-image-preview', localPath);
  },
  startSftpTemporaryFileWatch: (localPath: string) => {
    return invokeIpc<string>('app:start-sftp-temporary-file-watch', localPath);
  },
  stopSftpTemporaryFileWatch: (watchId: string) => {
    return invokeIpc<boolean>('app:stop-sftp-temporary-file-watch', watchId);
  },
  onSftpTemporaryFileChanged: (listener: (change: SftpTemporaryFileWatchChange) => void) => {
    return onSftpTemporaryFileChanged(listener);
  },
  showSftpOpenWithDialog: (localPath: string) => {
    return invokeIpc<boolean>('app:show-sftp-open-with-dialog', localPath);
  },
  listSftpOpenWithApplications: (localPath: string) => {
    return invokeIpc<SftpOpenWithApplication[]>('app:list-sftp-open-with-applications', localPath);
  },
  openSftpFileWithApplication: (localPath: string, applicationPath: string) => {
    return invokeIpc<boolean>('app:open-sftp-file-with-application', localPath, applicationPath);
  },
  getDatabaseSecurityInfo: () => {
    return invokeIpc<{
      runtimeMode: 'development' | 'production';
      resolverMode: 'development-fixed-key' | 'safe-storage' | 'master-password-fallback';
      safeStorageAvailable: boolean;
      databasePath: string;
      securityConfigPath: string;
      hasEncryptedDbMasterKey: boolean;
      hasMasterPasswordHash: boolean;
      hasMasterPasswordSalt: boolean;
      hasMasterPasswordEnv: boolean;
      fallbackReady: boolean;
    }>('app:get-database-security-info');
  },
  resolveSystemProxy: (request: SystemProxyResolveRequest) => {
    return invokeIpc<SystemProxyResolveResult>('app:resolve-system-proxy', request);
  },
  /**
   * Subscribes to launch cwd events emitted when a second instance forwards context.
   */
  onLaunchWorkingDirectory: (listener: (cwd: string) => void) => {
    return onIpcStringPayload('app:launch-working-directory', listener);
  },
  onAppMenuAction: (listener: (action: AppMenuAction) => void) => {
    return onIpcAppMenuActionPayload(listener);
  },
  openDevTools: () => {
    return invokeIpc<boolean>('app:open-devtools');
  },
  toggleDevTools: () => {
    return invokeIpc<boolean>('app:toggle-devtools');
  },
  reloadWebView: () => {
    return invokeIpc<boolean>('app:reload-webview');
  },
  restartBackendRuntime: () => {
    return invokeIpc<boolean>('app:restart-backend-runtime');
  },
  showInFileManager: (targetPath?: string) => {
    return invokeIpc<boolean>('app:show-in-file-manager', targetPath);
  },
  openExternalUrl: (targetUrl: string) => {
    return invokeIpc<boolean>('app:open-external-url', targetUrl);
  },
  setWindowsSystemMenuSymbolColor: (symbolColor: string) => {
    return invokeIpc<boolean>('app:set-windows-system-menu-symbol-color', symbolColor);
  },
  showSaveFileDialog: (defaultPath?: string) => {
    return invokeIpc<{ canceled: boolean; filePath?: string }>('app:show-save-file-dialog', defaultPath);
  },
  importPrivateKeyFromFile: () => {
    return invokeIpc<{ canceled: boolean; fileName?: string; content?: string }>('app:import-private-key');
  },
  getProcessPerformanceStats: () => {
    return invokeIpc<{
      sampledAt: number;
      cpuPercent: number | null;
      mainProcessMemory: {
        rssBytes: number;
        heapTotalBytes: number;
        heapUsedBytes: number;
        externalBytes: number;
        arrayBuffersBytes: number;
      };
      rendererProcessMemory: {
        residentSetBytes: number;
        privateBytes: number;
        sharedBytes: number;
      } | null;
      backendProcess: {
        pid: number;
        cpuPercent: number | null;
        memoryRssBytes: number | null;
      } | null;
    }>('app:get-process-performance-stats');
  },
  exportMainHeapSnapshot: () => {
    return invokeIpc<{ ok: boolean; filePath?: string; message?: string }>('app:export-main-heap-snapshot');
  },
  getBackendRequestTraces: () => {
    return invokeIpc<BackendRequestTrace[]>('debug:backend-request-trace-list');
  },
  clearBackendRequestTraces: () => {
    return invokeIpc<boolean>('debug:backend-request-trace-clear');
  },
  onBackendRequestTrace: (listener: (trace: BackendRequestTrace) => void) => {
    return onBackendRequestTrace(listener);
  },

  // ---------------------------------------------------------------------------
  // Backend settings and SSH channels
  // ---------------------------------------------------------------------------
  backendTestPing: () => {
    return invokeIpc<ApiTestPingResponse | ApiErrorResponse>('backend:test-ping');
  },
  backendSettingsGet: () => {
    return invokeIpc<ApiSettingsGetResponse | ApiErrorResponse>('backend:settings-get');
  },
  backendSettingsUpdate: (payload: ApiSettingsUpdateRequest) => {
    return invokeIpc<ApiSettingsUpdateResponse | ApiErrorResponse>('backend:settings-update', payload);
  },
  backendAuditListEvents: (query?: ApiAuditEventListQuery) => {
    return invokeIpc<ApiAuditEventListResponse | ApiErrorResponse>('backend:audit-list-events', query);
  },
  backendAuditGetEventById: (eventId: string) => {
    return invokeIpc<ApiAuditEventDetailResponse | ApiErrorResponse>('backend:audit-get-event-by-id', eventId);
  },
  backendSshListServers: () => {
    return invokeIpc<ApiSshListServersResponse | ApiErrorResponse>('backend:ssh-list-servers');
  },
  backendSshCreateServer: (payload: ApiSshCreateServerRequest) => {
    return invokeIpc<ApiSshCreateServerResponse | ApiErrorResponse>('backend:ssh-create-server', payload);
  },
  backendSshUpdateServer: (serverId: string, payload: ApiSshUpdateServerRequest) => {
    return invokeIpc<ApiSshUpdateServerResponse | ApiErrorResponse>('backend:ssh-update-server', serverId, payload);
  },
  backendSshGetServerCredentials: (serverId: string) => {
    return invokeIpc<ApiSshGetServerCredentialsResponse | ApiErrorResponse>(
      'backend:ssh-get-server-credentials',
      serverId,
    );
  },
  backendSshListFolders: () => {
    return invokeIpc<ApiSshListFoldersResponse | ApiErrorResponse>('backend:ssh-list-folders');
  },
  backendSshCreateFolder: (payload: ApiSshCreateFolderRequest) => {
    return invokeIpc<ApiSshCreateFolderResponse | ApiErrorResponse>('backend:ssh-create-folder', payload);
  },
  backendSshUpdateFolder: (folderId: string, payload: ApiSshUpdateFolderRequest) => {
    return invokeIpc<ApiSshUpdateFolderResponse | ApiErrorResponse>('backend:ssh-update-folder', folderId, payload);
  },
  backendSshListTags: () => {
    return invokeIpc<ApiSshListTagsResponse | ApiErrorResponse>('backend:ssh-list-tags');
  },
  backendSshCreateTag: (payload: ApiSshCreateTagRequest) => {
    return invokeIpc<ApiSshCreateTagResponse | ApiErrorResponse>('backend:ssh-create-tag', payload);
  },
  backendSshListKeychains: () => {
    return invokeIpc<ApiSshListKeychainsResponse | ApiErrorResponse>('backend:ssh-list-keychains');
  },
  backendSshCreateKeychain: (payload: ApiSshCreateKeychainRequest) => {
    return invokeIpc<ApiSshCreateKeychainResponse | ApiErrorResponse>('backend:ssh-create-keychain', payload);
  },
  backendSshUpdateKeychain: (keychainId: string, payload: ApiSshUpdateKeychainRequest) => {
    return invokeIpc<ApiSshUpdateKeychainResponse | ApiErrorResponse>(
      'backend:ssh-update-keychain',
      keychainId,
      payload,
    );
  },
  backendSshGetKeychainCredentials: (keychainId: string) => {
    return invokeIpc<ApiSshGetKeychainCredentialsResponse | ApiErrorResponse>(
      'backend:ssh-get-keychain-credentials',
      keychainId,
    );
  },
  backendSshCreateSession: (payload: ApiSshCreateSessionRequest) => {
    return invokeIpc<
      ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    >('backend:ssh-create-session', payload);
  },
  backendSshTrustFingerprint: (payload: ApiSshTrustFingerprintRequest) => {
    return invokeIpc<ApiSshTrustFingerprintResponse | ApiErrorResponse>('backend:ssh-trust-fingerprint', payload);
  },
  backendSshCloseSession: (sessionId: string) => {
    return invokeIpc<{ success: boolean }>('backend:ssh-close-session', sessionId);
  },
  backendSftpCreateSession: (payload: ApiSftpCreateSessionRequest) => {
    return invokeIpc<
      ApiSftpCreateSessionResponse | ApiSftpCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    >('backend:sftp-create-session', payload);
  },
  backendSftpListDirectory: (sessionId: string, query?: ApiSftpListDirectoryQuery) => {
    return invokeIpc<ApiSftpListDirectoryResponse | ApiErrorResponse>('backend:sftp-list-directory', sessionId, query);
  },
  backendSftpGetEntryDetails: (sessionId: string, payload: ApiSftpEntryDetailsRequest) => {
    return invokeIpc<ApiSftpEntryDetailsResponse | ApiErrorResponse>(
      'backend:sftp-get-entry-details',
      sessionId,
      payload,
    );
  },
  backendSftpReadFile: (sessionId: string, query: ApiSftpReadFileQuery) => {
    return invokeIpc<ApiSftpReadFileResponse | ApiErrorResponse>('backend:sftp-read-file', sessionId, query);
  },
  backendSftpWriteFile: (sessionId: string, payload: ApiSftpWriteFileRequest) => {
    return invokeIpc<ApiSftpWriteFileResponse | ApiErrorResponse>('backend:sftp-write-file', sessionId, payload);
  },
  backendSftpDownloadFile: (sessionId: string, payload: ApiSftpDownloadFileRequest) => {
    return invokeIpc<ApiSftpDownloadFileResponse | ApiErrorResponse>('backend:sftp-download-file', sessionId, payload);
  },
  backendSftpUploadFile: (sessionId: string, payload: ApiSftpUploadFileRequest) => {
    return invokeIpc<ApiSftpUploadFileResponse | ApiErrorResponse>('backend:sftp-upload-file', sessionId, payload);
  },
  backendSftpGetTransferProgress: (transferId: string) => {
    return invokeIpc<ApiSftpTransferProgressResponse | ApiErrorResponse>(
      'backend:sftp-get-transfer-progress',
      transferId,
    );
  },
  backendSftpCreateDirectory: (sessionId: string, payload: ApiSftpCreateDirectoryRequest) => {
    return invokeIpc<ApiSftpCreateDirectoryResponse | ApiErrorResponse>(
      'backend:sftp-create-directory',
      sessionId,
      payload,
    );
  },
  backendSftpCreateFile: (sessionId: string, payload: ApiSftpCreateFileRequest) => {
    return invokeIpc<ApiSftpCreateFileResponse | ApiErrorResponse>('backend:sftp-create-file', sessionId, payload);
  },
  backendSftpRenameEntry: (sessionId: string, payload: ApiSftpRenameRequest) => {
    return invokeIpc<ApiSftpRenameResponse | ApiErrorResponse>('backend:sftp-rename-entry', sessionId, payload);
  },
  backendSftpCopyEntry: (sessionId: string, payload: ApiSftpCopyRequest) => {
    return invokeIpc<ApiSftpCopyResponse | ApiErrorResponse>('backend:sftp-copy-entry', sessionId, payload);
  },
  backendSftpDeleteEntry: (sessionId: string, payload: ApiSftpDeleteRequest) => {
    return invokeIpc<ApiSftpDeleteResponse | ApiErrorResponse>('backend:sftp-delete-entry', sessionId, payload);
  },
  backendSftpBatchOperation: (sessionId: string, payload: ApiSftpBatchOperationRequest) => {
    return invokeIpc<ApiSftpBatchOperationResponse | ApiErrorResponse>(
      'backend:sftp-batch-operation',
      sessionId,
      payload,
    );
  },
  backendSftpStartTask: (sessionId: string, payload: ApiSftpStartTaskRequest) => {
    return invokeIpc<ApiSftpStartTaskResponse | ApiErrorResponse>('backend:sftp-start-task', sessionId, payload);
  },
  backendSftpListTasks: (sessionId: string) => {
    return invokeIpc<ApiSftpListTasksResponse | ApiErrorResponse>('backend:sftp-list-tasks', sessionId);
  },
  backendSftpGetTask: (sessionId: string, taskId: string) => {
    return invokeIpc<ApiSftpGetTaskResponse | ApiErrorResponse>('backend:sftp-get-task', sessionId, taskId);
  },
  backendSftpGetArchiveCapabilities: (sessionId: string) => {
    return invokeIpc<ApiSftpArchiveCapabilitiesResponse | ApiErrorResponse>(
      'backend:sftp-get-archive-capabilities',
      sessionId,
    );
  },
  backendSftpStartArchiveOperation: (sessionId: string, payload: ApiSftpArchiveOperationRequest) => {
    return invokeIpc<ApiSftpArchiveOperationAcceptedResponse | ApiErrorResponse>(
      'backend:sftp-start-archive-operation',
      sessionId,
      payload,
    );
  },
  backendSftpGetArchiveOperation: (sessionId: string, operationId: string) => {
    return invokeIpc<ApiSftpArchiveOperationStatusResponse | ApiErrorResponse>(
      'backend:sftp-get-archive-operation',
      sessionId,
      operationId,
    );
  },
  backendSftpResolveArchiveConflict: (
    sessionId: string,
    operationId: string,
    payload: ApiSftpArchiveConflictResolutionRequest,
  ) => {
    return invokeIpc<ApiSftpArchiveConflictResolutionResponse | ApiErrorResponse>(
      'backend:sftp-resolve-archive-conflict',
      sessionId,
      operationId,
      payload,
    );
  },
  backendSftpCancelArchiveOperation: (sessionId: string, operationId: string) => {
    return invokeIpc<ApiSftpArchiveCancelResponse | ApiErrorResponse>(
      'backend:sftp-cancel-archive-operation',
      sessionId,
      operationId,
    );
  },
  backendSftpCloseSession: (sessionId: string) => {
    return invokeIpc<{ success: boolean }>('backend:sftp-close-session', sessionId);
  },
  backendSshDeleteServer: (serverId: string) => {
    return invokeIpc<{ success: boolean }>('backend:ssh-delete-server', serverId);
  },
  backendSshDeleteFolder: (folderId: string) => {
    return invokeIpc<{ success: boolean }>('backend:ssh-delete-folder', folderId);
  },
  backendSshDeleteKeychain: (keychainId: string) => {
    return invokeIpc<{ success: boolean }>('backend:ssh-delete-keychain', keychainId);
  },
  backendPortForwardListRules: () => {
    return invokeIpc<ApiPortForwardListRulesResponse | ApiErrorResponse>('backend:port-forward-list-rules');
  },
  backendPortForwardCreateRule: (payload: ApiPortForwardCreateRuleRequest) => {
    return invokeIpc<ApiPortForwardCreateRuleResponse | ApiErrorResponse>('backend:port-forward-create-rule', payload);
  },
  backendPortForwardUpdateRule: (ruleId: string, payload: ApiPortForwardUpdateRuleRequest) => {
    return invokeIpc<ApiPortForwardUpdateRuleResponse | ApiErrorResponse>(
      'backend:port-forward-update-rule',
      ruleId,
      payload,
    );
  },
  backendPortForwardStartRule: (ruleId: string, payload: ApiPortForwardStartRuleRequest) => {
    return invokeIpc<ApiPortForwardStartRuleResponse | ApiErrorResponse>(
      'backend:port-forward-start-rule',
      ruleId,
      payload,
    );
  },
  backendPortForwardStopRule: (ruleId: string) => {
    return invokeIpc<ApiPortForwardStopRuleResponse | ApiErrorResponse>('backend:port-forward-stop-rule', ruleId);
  },
  backendPortForwardDeleteRule: (ruleId: string) => {
    return invokeIpc<{ success: boolean }>('backend:port-forward-delete-rule', ruleId);
  },

  // ---------------------------------------------------------------------------
  // Local terminal channels
  // ---------------------------------------------------------------------------
  // Local terminal IPC proxy group.
  backendLocalTerminalListProfiles: () => {
    return invokeIpc<ApiLocalTerminalListProfilesResponse | ApiErrorResponse>('backend:local-terminal-list-profiles');
  },
  backendLocalTerminalCreateSession: (payload: ApiLocalTerminalCreateSessionRequest) => {
    return invokeIpc<ApiLocalTerminalCreateSessionResponse | ApiErrorResponse>(
      'backend:local-terminal-create-session',
      payload,
    );
  },
  backendLocalTerminalCloseSession: (sessionId: string) => {
    return invokeIpc<{ success: boolean }>('backend:local-terminal-close-session', sessionId);
  },
  platform: process.platform,
});
