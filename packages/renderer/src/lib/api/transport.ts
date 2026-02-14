import type { ApiErrorResponse, ApiTestPingResponse } from '@cosmosh/api-contract';
import { API_HEADERS, API_PATHS } from '@cosmosh/api-contract';

type ApiResponse = ApiTestPingResponse | ApiErrorResponse;
type RuntimeTarget = 'electron' | 'browser';

export type ApiTransport = {
  target: RuntimeTarget;
  testPing: () => Promise<ApiResponse>;
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
      return (await window.electron!.backendTestPing()) as ApiResponse;
    },
  };
};

const createBrowserTransport = (): ApiTransport => {
  return {
    target: 'browser',
    testPing: async () => {
      const token = resolveBrowserAuthToken();
      const baseUrl = resolveBrowserBaseUrl();

      if (!token) {
        return createBrowserFallbackError('Browser auth flow is not implemented yet. Please sign in first.');
      }

      if (!baseUrl) {
        return createBrowserFallbackError('Browser API base URL is not configured. Set VITE_COSMOSH_API_BASE_URL.');
      }

      const response = await fetch(`${baseUrl}${API_PATHS.testPing}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          [API_HEADERS.locale]: navigator.language,
        },
      });

      return (await response.json()) as ApiResponse;
    },
  };
};

export const createApiTransport = (): ApiTransport => {
  if (window.electron?.backendTestPing) {
    return createElectronTransport();
  }

  return createBrowserTransport();
};
