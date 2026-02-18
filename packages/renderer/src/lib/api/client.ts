import type {
  ApiSshCreateFolderRequest,
  ApiSshCreateFolderResponse,
  ApiSshCreateServerRequest,
  ApiSshCreateServerResponse,
  ApiSshCreateSessionHostVerificationRequiredResponse,
  ApiSshCreateSessionRequest,
  ApiSshCreateSessionResponse,
  ApiSshCreateTagRequest,
  ApiSshCreateTagResponse,
  ApiSshListFoldersResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiSshTrustFingerprintRequest,
  ApiSshTrustFingerprintResponse,
  ApiTestPingResponse,
} from '@cosmosh/api-contract';

import { createApiTransport } from './transport';

export type BackendClient = {
  runtimeTarget: 'electron' | 'browser';
  testPing: () => Promise<ApiTestPingResponse>;
  listSshServers: () => Promise<ApiSshListServersResponse>;
  createSshServer: (payload: ApiSshCreateServerRequest) => Promise<ApiSshCreateServerResponse>;
  listSshFolders: () => Promise<ApiSshListFoldersResponse>;
  createSshFolder: (payload: ApiSshCreateFolderRequest) => Promise<ApiSshCreateFolderResponse>;
  listSshTags: () => Promise<ApiSshListTagsResponse>;
  createSshTag: (payload: ApiSshCreateTagRequest) => Promise<ApiSshCreateTagResponse>;
  createSshSession: (
    payload: ApiSshCreateSessionRequest,
  ) => Promise<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse>;
  trustSshFingerprint: (payload: ApiSshTrustFingerprintRequest) => Promise<ApiSshTrustFingerprintResponse>;
  closeSshSession: (sessionId: string) => Promise<{ success: boolean }>;
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
    listSshServers: async () => {
      const payload = await transport.listSshServers();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createSshServer: async (requestPayload) => {
      const payload = await transport.createSshServer(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    listSshFolders: async () => {
      const payload = await transport.listSshFolders();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createSshFolder: async (requestPayload) => {
      const payload = await transport.createSshFolder(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    listSshTags: async () => {
      const payload = await transport.listSshTags();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createSshTag: async (requestPayload) => {
      const payload = await transport.createSshTag(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createSshSession: async (requestPayload) => {
      const payload = await transport.createSshSession(requestPayload);

      if (payload.success) {
        return payload;
      }

      if (payload.code === 'SSH_HOST_UNTRUSTED' && 'data' in payload) {
        return payload;
      }

      if (!payload.success) {
        throw new Error(payload.message);
      }

      throw new Error('Unexpected SSH session response.');
    },
    trustSshFingerprint: async (requestPayload) => {
      const payload = await transport.trustSshFingerprint(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    closeSshSession: async (sessionId) => {
      return transport.closeSshSession(sessionId);
    },
  };
};

export const backendClient = createBackendClient();
