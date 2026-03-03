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
import { API_HEADERS, API_PATHS } from '@cosmosh/api-contract';
import { ipcMain } from 'electron';

/**
 * Runtime dependencies required by backend IPC registration.
 */
export type RegisterBackendIpcHandlersOptions = {
  /** Returns active app locale used for backend request headers. */
  getLocale: () => string;
  /** Returns backend connection config (port + internal token). */
  requireBackendConfig: () => { port: number; token: string };
  /**
   * Generic backend request adapter used by most channels.
   * Keeps channel implementation focused on route/payload mapping.
   */
  requestBackend: <TSuccess>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT';
      body?: unknown;
    },
  ) => Promise<TSuccess | ApiErrorResponse>;
  /** Returns and clears one-shot launch working directory context. */
  consumePendingLaunchWorkingDirectory: () => string | null;
};

/**
 * Sends an authenticated backend DELETE request and maps HTTP 204 to success flag.
 */
const requestBackendDeleteSuccess = async (
  options: RegisterBackendIpcHandlersOptions,
  path: string,
): Promise<{ success: boolean }> => {
  const { port, token } = options.requireBackendConfig();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers: {
      [API_HEADERS.internalToken]: token,
      [API_HEADERS.locale]: options.getLocale(),
    },
  });

  return {
    success: response.status === 204,
  };
};

/**
 * Registers all backend-related IPC handlers (settings/SSH/local terminal).
 */
export const registerBackendIpcHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  // Settings, SSH, and local terminal channels share API_PATHS contract from api-contract package.
  registerBackendSshAndSettingsHandlers(options);
  registerBackendLocalTerminalHandlers(options);
};

/**
 * Registers SSH/settings handlers backed by backend HTTP API.
 */
const registerBackendSshAndSettingsHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  ipcMain.handle('backend:test-ping', async (): Promise<ApiTestPingResponse | ApiErrorResponse> => {
    const { port, token } = options.requireBackendConfig();
    const response = await fetch(`http://127.0.0.1:${port}${API_PATHS.testPing}`, {
      method: 'GET',
      headers: {
        [API_HEADERS.internalToken]: token,
        [API_HEADERS.locale]: options.getLocale(),
      },
    });

    const payload = (await response.json()) as ApiTestPingResponse | ApiErrorResponse;

    if (!response.ok) {
      throw new Error(payload.message);
    }

    return payload;
  });

  ipcMain.handle('backend:settings-get', async (): Promise<ApiSettingsGetResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSettingsGetResponse>(API_PATHS.settingsGet, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:settings-update',
    async (_event, payload: ApiSettingsUpdateRequest): Promise<ApiSettingsUpdateResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSettingsUpdateResponse>(API_PATHS.settingsUpdate, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle('backend:ssh-list-servers', async (): Promise<ApiSshListServersResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListServersResponse>(API_PATHS.sshListServers, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-server',
    async (_event, payload: ApiSshCreateServerRequest): Promise<ApiSshCreateServerResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateServerResponse>(API_PATHS.sshCreateServer, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-update-server',
    async (
      _event,
      serverId: string,
      payload: ApiSshUpdateServerRequest,
    ): Promise<ApiSshUpdateServerResponse | ApiErrorResponse> => {
      const path = API_PATHS.sshUpdateServer.replace('{serverId}', encodeURIComponent(serverId));
      return options.requestBackend<ApiSshUpdateServerResponse>(path, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-get-server-credentials',
    async (_event, serverId: string): Promise<ApiSshGetServerCredentialsResponse | ApiErrorResponse> => {
      const path = API_PATHS.sshGetServerCredentials.replace('{serverId}', encodeURIComponent(serverId));
      return options.requestBackend<ApiSshGetServerCredentialsResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle('backend:ssh-list-folders', async (): Promise<ApiSshListFoldersResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListFoldersResponse>(API_PATHS.sshListFolders, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-folder',
    async (_event, payload: ApiSshCreateFolderRequest): Promise<ApiSshCreateFolderResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateFolderResponse>(API_PATHS.sshCreateFolder, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-update-folder',
    async (
      _event,
      folderId: string,
      payload: ApiSshUpdateFolderRequest,
    ): Promise<ApiSshUpdateFolderResponse | ApiErrorResponse> => {
      const path = API_PATHS.sshUpdateFolder.replace('{folderId}', encodeURIComponent(folderId));
      return options.requestBackend<ApiSshUpdateFolderResponse>(path, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle('backend:ssh-list-tags', async (): Promise<ApiSshListTagsResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListTagsResponse>(API_PATHS.sshListTags, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-tag',
    async (_event, payload: ApiSshCreateTagRequest): Promise<ApiSshCreateTagResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateTagResponse>(API_PATHS.sshCreateTag, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-create-session',
    async (
      _event,
      payload: ApiSshCreateSessionRequest,
    ): Promise<
      ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    > => {
      return options.requestBackend<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse>(
        API_PATHS.sshCreateSession,
        {
          method: 'POST',
          body: payload,
        },
      );
    },
  );

  ipcMain.handle(
    'backend:ssh-trust-fingerprint',
    async (
      _event,
      payload: ApiSshTrustFingerprintRequest,
    ): Promise<ApiSshTrustFingerprintResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshTrustFingerprintResponse>(API_PATHS.sshTrustFingerprint, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle('backend:ssh-close-session', async (_event, sessionId: string): Promise<{ success: boolean }> => {
    const path = API_PATHS.sshCloseSession.replace('{sessionId}', encodeURIComponent(sessionId));
    return requestBackendDeleteSuccess(options, path);
  });

  ipcMain.handle('backend:ssh-delete-server', async (_event, serverId: string): Promise<{ success: boolean }> => {
    const path = API_PATHS.sshDeleteServer.replace('{serverId}', encodeURIComponent(serverId));
    return requestBackendDeleteSuccess(options, path);
  });

  ipcMain.handle('backend:ssh-delete-folder', async (_event, folderId: string): Promise<{ success: boolean }> => {
    const path = API_PATHS.sshDeleteFolder.replace('{folderId}', encodeURIComponent(folderId));
    return requestBackendDeleteSuccess(options, path);
  });
};

/**
 * Registers local terminal handlers backed by backend HTTP API.
 */
const registerBackendLocalTerminalHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  ipcMain.handle(
    'backend:local-terminal-list-profiles',
    async (): Promise<ApiLocalTerminalListProfilesResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiLocalTerminalListProfilesResponse>(API_PATHS.localTerminalListProfiles, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:local-terminal-create-session',
    async (
      _event,
      payload: ApiLocalTerminalCreateSessionRequest,
    ): Promise<ApiLocalTerminalCreateSessionResponse | ApiErrorResponse> => {
      const launchWorkingDirectory = options.consumePendingLaunchWorkingDirectory();
      return options.requestBackend<ApiLocalTerminalCreateSessionResponse>(API_PATHS.localTerminalCreateSession, {
        method: 'POST',
        body: {
          ...payload,
          ...(launchWorkingDirectory ? { cwd: launchWorkingDirectory } : {}),
        },
      });
    },
  );

  ipcMain.handle(
    'backend:local-terminal-close-session',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      const path = API_PATHS.localTerminalCloseSession.replace('{sessionId}', encodeURIComponent(sessionId));
      return requestBackendDeleteSuccess(options, path);
    },
  );
};
