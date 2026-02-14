import type { ApiTestPingResponse } from '@cosmosh/api-contract';

import { backendClient } from './api/client';

export const testBackendPing = async (): Promise<ApiTestPingResponse> => {
  return backendClient.testPing();
};

export const getBackendRuntimeTarget = (): 'electron' | 'browser' => {
  return backendClient.runtimeTarget;
};
