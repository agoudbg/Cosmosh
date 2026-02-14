import type { ApiTestPingResponse } from '@cosmosh/api-contract';

import { createApiTransport } from './transport';

export type BackendClient = {
  runtimeTarget: 'electron' | 'browser';
  testPing: () => Promise<ApiTestPingResponse>;
};

export const createBackendClient = (): BackendClient => {
  const transport = createApiTransport();

  return {
    runtimeTarget: transport.target,
    testPing: async () => {
      const payload = await transport.testPing();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
  };
};

export const backendClient = createBackendClient();
