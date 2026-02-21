import type {
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

import {
  createApiTransport,
  LocalTerminalCreateSessionRequest,
  LocalTerminalCreateSessionResponse,
  LocalTerminalListResponse,
} from './transport';

export type BackendClient = {
  runtimeTarget: 'electron' | 'browser';
  testPing: () => Promise<ApiTestPingResponse>;
  getSettings: () => Promise<ApiSettingsGetResponse>;
  updateSettings: (payload: ApiSettingsUpdateRequest) => Promise<ApiSettingsUpdateResponse>;
  listSshServers: () => Promise<ApiSshListServersResponse>;
  createSshServer: (payload: ApiSshCreateServerRequest) => Promise<ApiSshCreateServerResponse>;
  updateSshServer: (serverId: string, payload: ApiSshUpdateServerRequest) => Promise<ApiSshUpdateServerResponse>;
  getSshServerCredentials: (serverId: string) => Promise<ApiSshGetServerCredentialsResponse>;
  listSshFolders: () => Promise<ApiSshListFoldersResponse>;
  createSshFolder: (payload: ApiSshCreateFolderRequest) => Promise<ApiSshCreateFolderResponse>;
  updateSshFolder: (folderId: string, payload: ApiSshUpdateFolderRequest) => Promise<ApiSshUpdateFolderResponse>;
  listSshTags: () => Promise<ApiSshListTagsResponse>;
  createSshTag: (payload: ApiSshCreateTagRequest) => Promise<ApiSshCreateTagResponse>;
  createSshSession: (
    payload: ApiSshCreateSessionRequest,
  ) => Promise<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse>;
  trustSshFingerprint: (payload: ApiSshTrustFingerprintRequest) => Promise<ApiSshTrustFingerprintResponse>;
  listLocalTerminalProfiles: () => Promise<LocalTerminalListResponse>;
  createLocalTerminalSession: (
    payload: LocalTerminalCreateSessionRequest,
  ) => Promise<LocalTerminalCreateSessionResponse>;
  closeLocalTerminalSession: (sessionId: string) => Promise<{ success: boolean }>;
  closeSshSession: (sessionId: string) => Promise<{ success: boolean }>;
  deleteSshServer: (serverId: string) => Promise<{ success: boolean }>;
  deleteSshFolder: (folderId: string) => Promise<{ success: boolean }>;
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
    getSettings: async () => {
      const payload = await transport.getSettings();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    updateSettings: async (requestPayload) => {
      const payload = await transport.updateSettings(requestPayload);

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
    updateSshServer: async (serverId, requestPayload) => {
      const payload = await transport.updateSshServer(serverId, requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    getSshServerCredentials: async (serverId) => {
      const payload = await transport.getSshServerCredentials(serverId);

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
    updateSshFolder: async (folderId, requestPayload) => {
      const payload = await transport.updateSshFolder(folderId, requestPayload);

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
    listLocalTerminalProfiles: async () => {
      const payload = await transport.listLocalTerminalProfiles();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createLocalTerminalSession: async (requestPayload) => {
      const payload = await transport.createLocalTerminalSession(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    closeLocalTerminalSession: async (sessionId) => {
      return transport.closeLocalTerminalSession(sessionId);
    },
    closeSshSession: async (sessionId) => {
      return transport.closeSshSession(sessionId);
    },
    deleteSshServer: async (serverId) => {
      return transport.deleteSshServer(serverId);
    },
    deleteSshFolder: async (folderId) => {
      return transport.deleteSshFolder(folderId);
    },
  };
};

export const backendClient = createBackendClient();
