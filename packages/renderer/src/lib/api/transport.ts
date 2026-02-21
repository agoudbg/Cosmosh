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
import { API_HEADERS, API_PATHS } from '@cosmosh/api-contract';

type RuntimeTarget = 'electron' | 'browser';

export type LocalTerminalProfile = {
  id: string;
  name: string;
  command: string;
  executablePath: string;
  args: string[];
};

export type LocalTerminalListResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    items: LocalTerminalProfile[];
  };
};

export type LocalTerminalCreateSessionRequest = {
  profileId: string;
  cols: number;
  rows: number;
  term: string;
};

export type LocalTerminalCreateSessionResponse = {
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

type ApiResponse =
  | ApiErrorResponse
  | ApiTestPingResponse
  | ApiSettingsGetResponse
  | ApiSettingsUpdateResponse
  | ApiSshListServersResponse
  | ApiSshCreateServerResponse
  | ApiSshUpdateServerResponse
  | ApiSshGetServerCredentialsResponse
  | ApiSshListFoldersResponse
  | ApiSshCreateFolderResponse
  | ApiSshUpdateFolderResponse
  | ApiSshListTagsResponse
  | ApiSshCreateTagResponse
  | ApiSshCreateSessionResponse
  | ApiSshCreateSessionHostVerificationRequiredResponse
  | ApiSshTrustFingerprintResponse
  | LocalTerminalListResponse
  | LocalTerminalCreateSessionResponse;

export type ApiTransport = {
  target: RuntimeTarget;
  testPing: () => Promise<ApiTestPingResponse | ApiErrorResponse>;
  getSettings: () => Promise<ApiSettingsGetResponse | ApiErrorResponse>;
  updateSettings: (payload: ApiSettingsUpdateRequest) => Promise<ApiSettingsUpdateResponse | ApiErrorResponse>;
  listSshServers: () => Promise<ApiSshListServersResponse | ApiErrorResponse>;
  createSshServer: (payload: ApiSshCreateServerRequest) => Promise<ApiSshCreateServerResponse | ApiErrorResponse>;
  updateSshServer: (
    serverId: string,
    payload: ApiSshUpdateServerRequest,
  ) => Promise<ApiSshUpdateServerResponse | ApiErrorResponse>;
  getSshServerCredentials: (serverId: string) => Promise<ApiSshGetServerCredentialsResponse | ApiErrorResponse>;
  listSshFolders: () => Promise<ApiSshListFoldersResponse | ApiErrorResponse>;
  createSshFolder: (payload: ApiSshCreateFolderRequest) => Promise<ApiSshCreateFolderResponse | ApiErrorResponse>;
  updateSshFolder: (
    folderId: string,
    payload: ApiSshUpdateFolderRequest,
  ) => Promise<ApiSshUpdateFolderResponse | ApiErrorResponse>;
  listSshTags: () => Promise<ApiSshListTagsResponse | ApiErrorResponse>;
  createSshTag: (payload: ApiSshCreateTagRequest) => Promise<ApiSshCreateTagResponse | ApiErrorResponse>;
  createSshSession: (
    payload: ApiSshCreateSessionRequest,
  ) => Promise<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse>;
  trustSshFingerprint: (
    payload: ApiSshTrustFingerprintRequest,
  ) => Promise<ApiSshTrustFingerprintResponse | ApiErrorResponse>;
  listLocalTerminalProfiles: () => Promise<LocalTerminalListResponse | ApiErrorResponse>;
  createLocalTerminalSession: (
    payload: LocalTerminalCreateSessionRequest,
  ) => Promise<LocalTerminalCreateSessionResponse | ApiErrorResponse>;
  closeLocalTerminalSession: (sessionId: string) => Promise<{ success: boolean }>;
  closeSshSession: (sessionId: string) => Promise<{ success: boolean }>;
  deleteSshServer: (serverId: string) => Promise<{ success: boolean }>;
  deleteSshFolder: (folderId: string) => Promise<{ success: boolean }>;
};

// Browser fallback uses build-time URL configuration to prepare for future web runtime.
const resolveBrowserBaseUrl = (): string => {
  const fromEnv = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_COSMOSH_API_BASE_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.replace(/\/$/, '');
  }

  return '';
};

// Browser auth is intentionally placeholder-only for now; token source is reserved here.
const resolveBrowserAuthToken = (): string | null => {
  try {
    return window.localStorage.getItem('cosmosh.accessToken');
  } catch {
    return null;
  }
};

const createBrowserFallbackError = (message: string): ApiErrorResponse => {
  return {
    success: false,
    code: 'AUTH_INVALID_TOKEN',
    message,
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
};

const createElectronTransport = (): ApiTransport => {
  return {
    target: 'electron',
    testPing: async () => {
      return (await window.electron!.backendTestPing()) as ApiTestPingResponse | ApiErrorResponse;
    },
    getSettings: async () => {
      return (await window.electron!.backendSettingsGet()) as ApiSettingsGetResponse | ApiErrorResponse;
    },
    updateSettings: async (payload) => {
      return (await window.electron!.backendSettingsUpdate(payload)) as ApiSettingsUpdateResponse | ApiErrorResponse;
    },
    listSshServers: async () => {
      return (await window.electron!.backendSshListServers()) as ApiSshListServersResponse | ApiErrorResponse;
    },
    createSshServer: async (payload) => {
      return (await window.electron!.backendSshCreateServer(payload)) as ApiSshCreateServerResponse | ApiErrorResponse;
    },
    updateSshServer: async (serverId, payload) => {
      return (await window.electron!.backendSshUpdateServer(serverId, payload)) as
        | ApiSshUpdateServerResponse
        | ApiErrorResponse;
    },
    getSshServerCredentials: async (serverId) => {
      return (await window.electron!.backendSshGetServerCredentials(serverId)) as
        | ApiSshGetServerCredentialsResponse
        | ApiErrorResponse;
    },
    listSshFolders: async () => {
      return (await window.electron!.backendSshListFolders()) as ApiSshListFoldersResponse | ApiErrorResponse;
    },
    createSshFolder: async (payload) => {
      return (await window.electron!.backendSshCreateFolder(payload)) as ApiSshCreateFolderResponse | ApiErrorResponse;
    },
    updateSshFolder: async (folderId, payload) => {
      return (await window.electron!.backendSshUpdateFolder(folderId, payload)) as
        | ApiSshUpdateFolderResponse
        | ApiErrorResponse;
    },
    listSshTags: async () => {
      return (await window.electron!.backendSshListTags()) as ApiSshListTagsResponse | ApiErrorResponse;
    },
    createSshTag: async (payload) => {
      return (await window.electron!.backendSshCreateTag(payload)) as ApiSshCreateTagResponse | ApiErrorResponse;
    },
    createSshSession: async (payload) => {
      return (await window.electron!.backendSshCreateSession(payload)) as
        | ApiSshCreateSessionResponse
        | ApiSshCreateSessionHostVerificationRequiredResponse
        | ApiErrorResponse;
    },
    trustSshFingerprint: async (payload) => {
      return (await window.electron!.backendSshTrustFingerprint(payload)) as
        | ApiSshTrustFingerprintResponse
        | ApiErrorResponse;
    },
    listLocalTerminalProfiles: async () => {
      return (await window.electron!.backendLocalTerminalListProfiles()) as
        | LocalTerminalListResponse
        | ApiErrorResponse;
    },
    createLocalTerminalSession: async (payload) => {
      return (await window.electron!.backendLocalTerminalCreateSession(payload)) as
        | LocalTerminalCreateSessionResponse
        | ApiErrorResponse;
    },
    closeLocalTerminalSession: async (sessionId) => {
      return await window.electron!.backendLocalTerminalCloseSession(sessionId);
    },
    closeSshSession: async (sessionId) => {
      return await window.electron!.backendSshCloseSession(sessionId);
    },
    deleteSshServer: async (serverId) => {
      return await window.electron!.backendSshDeleteServer(serverId);
    },
    deleteSshFolder: async (folderId) => {
      return await window.electron!.backendSshDeleteFolder(folderId);
    },
  };
};

const createBrowserTransport = (): ApiTransport => {
  const callBrowserApi = async (
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<ApiResponse> => {
    const token = resolveBrowserAuthToken();
    const baseUrl = resolveBrowserBaseUrl();

    if (!token) {
      return createBrowserFallbackError('Browser auth flow is not implemented yet. Please sign in first.');
    }

    if (!baseUrl) {
      return createBrowserFallbackError('Browser API base URL is not configured. Set VITE_COSMOSH_API_BASE_URL.');
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        [API_HEADERS.locale]: navigator.language,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    return (await response.json()) as ApiResponse;
  };

  return {
    target: 'browser',
    testPing: async () => {
      return (await callBrowserApi(API_PATHS.testPing, 'GET')) as ApiTestPingResponse | ApiErrorResponse;
    },
    getSettings: async () => {
      return (await callBrowserApi(API_PATHS.settingsGet, 'GET')) as ApiSettingsGetResponse | ApiErrorResponse;
    },
    updateSettings: async (payload) => {
      return (await callBrowserApi(API_PATHS.settingsUpdate, 'PUT', payload)) as
        | ApiSettingsUpdateResponse
        | ApiErrorResponse;
    },
    listSshServers: async () => {
      return (await callBrowserApi(API_PATHS.sshListServers, 'GET')) as ApiSshListServersResponse | ApiErrorResponse;
    },
    createSshServer: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateServer, 'POST', payload)) as
        | ApiSshCreateServerResponse
        | ApiErrorResponse;
    },
    updateSshServer: async (serverId, payload) => {
      const path = API_PATHS.sshUpdateServer.replace('{serverId}', encodeURIComponent(serverId));
      return (await callBrowserApi(path, 'PUT', payload)) as ApiSshUpdateServerResponse | ApiErrorResponse;
    },
    getSshServerCredentials: async (serverId) => {
      const path = API_PATHS.sshGetServerCredentials.replace('{serverId}', encodeURIComponent(serverId));
      return (await callBrowserApi(path, 'GET')) as ApiSshGetServerCredentialsResponse | ApiErrorResponse;
    },
    listSshFolders: async () => {
      return (await callBrowserApi(API_PATHS.sshListFolders, 'GET')) as ApiSshListFoldersResponse | ApiErrorResponse;
    },
    createSshFolder: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateFolder, 'POST', payload)) as
        | ApiSshCreateFolderResponse
        | ApiErrorResponse;
    },
    updateSshFolder: async (folderId, payload) => {
      const path = API_PATHS.sshUpdateFolder.replace('{folderId}', encodeURIComponent(folderId));
      return (await callBrowserApi(path, 'PUT', payload)) as ApiSshUpdateFolderResponse | ApiErrorResponse;
    },
    listSshTags: async () => {
      return (await callBrowserApi(API_PATHS.sshListTags, 'GET')) as ApiSshListTagsResponse | ApiErrorResponse;
    },
    createSshTag: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateTag, 'POST', payload)) as
        | ApiSshCreateTagResponse
        | ApiErrorResponse;
    },
    createSshSession: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateSession, 'POST', payload)) as
        | ApiSshCreateSessionResponse
        | ApiSshCreateSessionHostVerificationRequiredResponse
        | ApiErrorResponse;
    },
    trustSshFingerprint: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshTrustFingerprint, 'POST', payload)) as
        | ApiSshTrustFingerprintResponse
        | ApiErrorResponse;
    },
    listLocalTerminalProfiles: async () => {
      return createBrowserFallbackError('Local terminal profiles are only available in Electron runtime.');
    },
    createLocalTerminalSession: async () => {
      return createBrowserFallbackError('Local terminal sessions are only available in Electron runtime.');
    },
    closeLocalTerminalSession: async () => {
      return { success: false };
    },
    closeSshSession: async (sessionId) => {
      const path = API_PATHS.sshCloseSession.replace('{sessionId}', encodeURIComponent(sessionId));
      const response = await fetch(`${resolveBrowserBaseUrl()}${path}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${resolveBrowserAuthToken() ?? ''}`,
          [API_HEADERS.locale]: navigator.language,
        },
      });

      return { success: response.status === 204 };
    },
    deleteSshServer: async (serverId) => {
      const path = API_PATHS.sshDeleteServer.replace('{serverId}', encodeURIComponent(serverId));
      const response = await fetch(`${resolveBrowserBaseUrl()}${path}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${resolveBrowserAuthToken() ?? ''}`,
          [API_HEADERS.locale]: navigator.language,
        },
      });

      return { success: response.status === 204 };
    },
    deleteSshFolder: async (folderId) => {
      const path = API_PATHS.sshDeleteFolder.replace('{folderId}', encodeURIComponent(folderId));
      const response = await fetch(`${resolveBrowserBaseUrl()}${path}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${resolveBrowserAuthToken() ?? ''}`,
          [API_HEADERS.locale]: navigator.language,
        },
      });

      return { success: response.status === 204 };
    },
  };
};

export const createApiTransport = (): ApiTransport => {
  if (window.electron?.backendTestPing) {
    return createElectronTransport();
  }

  return createBrowserTransport();
};
