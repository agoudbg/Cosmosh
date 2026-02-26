import type {
  ApiErrorResponse,
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
 * Runtime shape for local terminal presets returned by backend.
 */
type LocalTerminalProfile = {
  id: string;
  name: string;
  command: string;
  executablePath: string;
  args: string[];
};

type LocalTerminalListResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    items: LocalTerminalProfile[];
  };
};

type LocalTerminalCreateSessionRequest = {
  profileId: string;
  cols: number;
  rows: number;
  term: string;
};

type LocalTerminalCreateSessionResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    sessionId: string;
    profileId: string;
    websocketUrl: string;
    websocketToken: string;
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
    ipcRenderer.send('app:close-window');
  },
  getLocale: () => {
    return ipcRenderer.invoke('i18n:get-locale');
  },
  setLocale: (locale: string) => {
    return ipcRenderer.invoke('i18n:set-locale', locale);
  },
  getRuntimeUserName: () => {
    return ipcRenderer.invoke('app:get-runtime-user-name');
  },
  getAppVersionInfo: () => {
    return ipcRenderer.invoke('app:get-version-info') as Promise<{
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
    }>;
  },
  getPendingLaunchWorkingDirectory: () => {
    return ipcRenderer.invoke('app:get-pending-launch-working-directory') as Promise<string | null>;
  },
  /**
   * Subscribes to launch cwd events emitted when a second instance forwards context.
   */
  onLaunchWorkingDirectory: (listener: (cwd: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, cwd: unknown) => {
      if (typeof cwd !== 'string') {
        return;
      }

      listener(cwd);
    };

    ipcRenderer.on('app:launch-working-directory', handler);

    return () => {
      ipcRenderer.removeListener('app:launch-working-directory', handler);
    };
  },
  openDevTools: () => {
    return ipcRenderer.invoke('app:open-devtools') as Promise<boolean>;
  },
  showInFileManager: (targetPath?: string) => {
    return ipcRenderer.invoke('app:show-in-file-manager', targetPath) as Promise<boolean>;
  },
  openExternalUrl: (targetUrl: string) => {
    return ipcRenderer.invoke('app:open-external-url', targetUrl) as Promise<boolean>;
  },
  importPrivateKeyFromFile: () => {
    return ipcRenderer.invoke('app:import-private-key') as Promise<{ canceled: boolean; content?: string }>;
  },

  // ---------------------------------------------------------------------------
  // Backend settings and SSH channels
  // ---------------------------------------------------------------------------
  backendTestPing: () => {
    return ipcRenderer.invoke('backend:test-ping') as Promise<ApiTestPingResponse | ApiErrorResponse>;
  },
  backendSettingsGet: () => {
    return ipcRenderer.invoke('backend:settings-get') as Promise<ApiSettingsGetResponse | ApiErrorResponse>;
  },
  backendSettingsUpdate: (payload: ApiSettingsUpdateRequest) => {
    return ipcRenderer.invoke('backend:settings-update', payload) as Promise<
      ApiSettingsUpdateResponse | ApiErrorResponse
    >;
  },
  backendSshListServers: () => {
    return ipcRenderer.invoke('backend:ssh-list-servers') as Promise<ApiSshListServersResponse | ApiErrorResponse>;
  },
  backendSshCreateServer: (payload: ApiSshCreateServerRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-server', payload) as Promise<
      ApiSshCreateServerResponse | ApiErrorResponse
    >;
  },
  backendSshUpdateServer: (serverId: string, payload: ApiSshUpdateServerRequest) => {
    return ipcRenderer.invoke('backend:ssh-update-server', serverId, payload) as Promise<
      ApiSshUpdateServerResponse | ApiErrorResponse
    >;
  },
  backendSshGetServerCredentials: (serverId: string) => {
    return ipcRenderer.invoke('backend:ssh-get-server-credentials', serverId) as Promise<
      ApiSshGetServerCredentialsResponse | ApiErrorResponse
    >;
  },
  backendSshListFolders: () => {
    return ipcRenderer.invoke('backend:ssh-list-folders') as Promise<ApiSshListFoldersResponse | ApiErrorResponse>;
  },
  backendSshCreateFolder: (payload: ApiSshCreateFolderRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-folder', payload) as Promise<
      ApiSshCreateFolderResponse | ApiErrorResponse
    >;
  },
  backendSshUpdateFolder: (folderId: string, payload: ApiSshUpdateFolderRequest) => {
    return ipcRenderer.invoke('backend:ssh-update-folder', folderId, payload) as Promise<
      ApiSshUpdateFolderResponse | ApiErrorResponse
    >;
  },
  backendSshListTags: () => {
    return ipcRenderer.invoke('backend:ssh-list-tags') as Promise<ApiSshListTagsResponse | ApiErrorResponse>;
  },
  backendSshCreateTag: (payload: ApiSshCreateTagRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-tag', payload) as Promise<ApiSshCreateTagResponse | ApiErrorResponse>;
  },
  backendSshCreateSession: (payload: ApiSshCreateSessionRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-session', payload) as Promise<
      ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    >;
  },
  backendSshTrustFingerprint: (payload: ApiSshTrustFingerprintRequest) => {
    return ipcRenderer.invoke('backend:ssh-trust-fingerprint', payload) as Promise<
      ApiSshTrustFingerprintResponse | ApiErrorResponse
    >;
  },
  backendSshCloseSession: (sessionId: string) => {
    return ipcRenderer.invoke('backend:ssh-close-session', sessionId) as Promise<{ success: boolean }>;
  },
  backendSshDeleteServer: (serverId: string) => {
    return ipcRenderer.invoke('backend:ssh-delete-server', serverId) as Promise<{ success: boolean }>;
  },
  backendSshDeleteFolder: (folderId: string) => {
    return ipcRenderer.invoke('backend:ssh-delete-folder', folderId) as Promise<{ success: boolean }>;
  },

  // ---------------------------------------------------------------------------
  // Local terminal channels
  // ---------------------------------------------------------------------------
  // Local terminal IPC proxy group.
  backendLocalTerminalListProfiles: () => {
    return ipcRenderer.invoke('backend:local-terminal-list-profiles') as Promise<
      LocalTerminalListResponse | ApiErrorResponse
    >;
  },
  backendLocalTerminalCreateSession: (payload: LocalTerminalCreateSessionRequest) => {
    return ipcRenderer.invoke('backend:local-terminal-create-session', payload) as Promise<
      LocalTerminalCreateSessionResponse | ApiErrorResponse
    >;
  },
  backendLocalTerminalCloseSession: (sessionId: string) => {
    return ipcRenderer.invoke('backend:local-terminal-close-session', sessionId) as Promise<{ success: boolean }>;
  },
  platform: process.platform,
});
