/// <reference types="vite/client" />

import type { ApiErrorResponse, ApiTestPingResponse } from '@cosmosh/api-contract';

declare global {
  interface Window {
    electron?: {
      send: (channel: string, data: unknown) => void;
      on: (channel: string, func: (...args: unknown[]) => void) => void;
      once: (channel: string, func: (...args: unknown[]) => void) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      getLocale: () => Promise<string>;
      setLocale: (locale: string) => Promise<string>;
      backendTestPing: () => Promise<ApiTestPingResponse | ApiErrorResponse>;
      platform: NodeJS.Platform;
    };
  }
}

export {};
