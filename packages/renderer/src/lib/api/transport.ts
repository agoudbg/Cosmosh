import type {
  ApiErrorResponse,
  ApiSshCreateFolderRequest,
  ApiSshCreateFolderResponse,
  ApiSshCreateServerRequest,
  ApiSshCreateServerResponse,
  ApiSshCreateTagRequest,
  ApiSshCreateTagResponse,
  ApiSshListFoldersResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiTestPingResponse,
} from '@cosmosh/api-contract';
import { API_HEADERS, API_PATHS } from '@cosmosh/api-contract';

type RuntimeTarget = 'electron' | 'browser';

type ApiResponse =
  | ApiErrorResponse
  | ApiTestPingResponse
  | ApiSshListServersResponse
  | ApiSshCreateServerResponse
  | ApiSshListFoldersResponse
  | ApiSshCreateFolderResponse
  | ApiSshListTagsResponse
  | ApiSshCreateTagResponse;

export type ApiTransport = {
  target: RuntimeTarget;
  testPing: () => Promise<ApiTestPingResponse | ApiErrorResponse>;
  listSshServers: () => Promise<ApiSshListServersResponse | ApiErrorResponse>;
  createSshServer: (payload: ApiSshCreateServerRequest) => Promise<ApiSshCreateServerResponse | ApiErrorResponse>;
  listSshFolders: () => Promise<ApiSshListFoldersResponse | ApiErrorResponse>;
  createSshFolder: (payload: ApiSshCreateFolderRequest) => Promise<ApiSshCreateFolderResponse | ApiErrorResponse>;
  listSshTags: () => Promise<ApiSshListTagsResponse | ApiErrorResponse>;
  createSshTag: (payload: ApiSshCreateTagRequest) => Promise<ApiSshCreateTagResponse | ApiErrorResponse>;
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
    listSshServers: async () => {
      return (await window.electron!.backendSshListServers()) as ApiSshListServersResponse | ApiErrorResponse;
    },
    createSshServer: async (payload) => {
      return (await window.electron!.backendSshCreateServer(payload)) as ApiSshCreateServerResponse | ApiErrorResponse;
    },
    listSshFolders: async () => {
      return (await window.electron!.backendSshListFolders()) as ApiSshListFoldersResponse | ApiErrorResponse;
    },
    createSshFolder: async (payload) => {
      return (await window.electron!.backendSshCreateFolder(payload)) as ApiSshCreateFolderResponse | ApiErrorResponse;
    },
    listSshTags: async () => {
      return (await window.electron!.backendSshListTags()) as ApiSshListTagsResponse | ApiErrorResponse;
    },
    createSshTag: async (payload) => {
      return (await window.electron!.backendSshCreateTag(payload)) as ApiSshCreateTagResponse | ApiErrorResponse;
    },
  };
};

const createBrowserTransport = (): ApiTransport => {
  const callBrowserApi = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<ApiResponse> => {
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
    listSshServers: async () => {
      return (await callBrowserApi(API_PATHS.sshListServers, 'GET')) as ApiSshListServersResponse | ApiErrorResponse;
    },
    createSshServer: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateServer, 'POST', payload)) as
        | ApiSshCreateServerResponse
        | ApiErrorResponse;
    },
    listSshFolders: async () => {
      return (await callBrowserApi(API_PATHS.sshListFolders, 'GET')) as ApiSshListFoldersResponse | ApiErrorResponse;
    },
    createSshFolder: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateFolder, 'POST', payload)) as
        | ApiSshCreateFolderResponse
        | ApiErrorResponse;
    },
    listSshTags: async () => {
      return (await callBrowserApi(API_PATHS.sshListTags, 'GET')) as ApiSshListTagsResponse | ApiErrorResponse;
    },
    createSshTag: async (payload) => {
      return (await callBrowserApi(API_PATHS.sshCreateTag, 'POST', payload)) as
        | ApiSshCreateTagResponse
        | ApiErrorResponse;
    },
  };
};

export const createApiTransport = (): ApiTransport => {
  if (window.electron?.backendTestPing) {
    return createElectronTransport();
  }

  return createBrowserTransport();
};
