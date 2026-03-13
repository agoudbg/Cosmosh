import type {
  ApiErrorResponse,
  ApiLocalTerminalCreateSessionRequest,
  ApiLocalTerminalCreateSessionResponse,
  ApiLocalTerminalListProfilesResponse,
  ApiSettingsGetResponse,
  ApiSettingsUpdateRequest,
  ApiSettingsUpdateResponse,
  ApiSshCreateFolderRequest,
  ApiSshCreateFolderResponse,
  ApiSshCreateServerRequest,
  ApiSshCreateServerResponse,
  ApiSshCreateSessionHostVerificationRequiredResponse,
  ApiSshCreateSessionRequest,
  ApiSshCreateSessionResponse,
  ApiSshCreateTagRequest,
  ApiSshCreateTagResponse,
  ApiSshGetServerCredentialsResponse,
  ApiSshListFoldersResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiSshTrustFingerprintRequest,
  ApiSshTrustFingerprintResponse,
  ApiSshUpdateFolderRequest,
  ApiSshUpdateFolderResponse,
  ApiSshUpdateServerRequest,
  ApiSshUpdateServerResponse,
  ApiTestPingResponse,
} from '@cosmosh/api-contract';
import { contextBridge, ipcRenderer } from 'electron';

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
  /**
   * Subscribes to launch cwd events emitted when a second instance forwards context.
   */
  onLaunchWorkingDirectory: (listener: (cwd: string) => void) => {
    return onIpcStringPayload('app:launch-working-directory', listener);
  },
  openDevTools: () => {
    return invokeIpc<boolean>('app:open-devtools');
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
  importPrivateKeyFromFile: () => {
    return invokeIpc<{ canceled: boolean; content?: string }>('app:import-private-key');
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
  backendSshDeleteServer: (serverId: string) => {
    return invokeIpc<{ success: boolean }>('backend:ssh-delete-server', serverId);
  },
  backendSshDeleteFolder: (folderId: string) => {
    return invokeIpc<{ success: boolean }>('backend:ssh-delete-folder', folderId);
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
