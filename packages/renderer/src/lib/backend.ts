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

import { backendClient } from './api/client';
import type {
  LocalTerminalCreateSessionRequest,
  LocalTerminalCreateSessionResponse,
  LocalTerminalListResponse,
} from './api/transport';

export const testBackendPing = async (): Promise<ApiTestPingResponse> => {
  return backendClient.testPing();
};

export const getBackendRuntimeTarget = (): 'electron' | 'browser' => {
  return backendClient.runtimeTarget;
};

export const listSshServers = async (): Promise<ApiSshListServersResponse> => {
  return backendClient.listSshServers();
};

export const createSshServer = async (payload: ApiSshCreateServerRequest): Promise<ApiSshCreateServerResponse> => {
  return backendClient.createSshServer(payload);
};

export const updateSshServer = async (
  serverId: string,
  payload: ApiSshUpdateServerRequest,
): Promise<ApiSshUpdateServerResponse> => {
  return backendClient.updateSshServer(serverId, payload);
};

export const getSshServerCredentials = async (serverId: string): Promise<ApiSshGetServerCredentialsResponse> => {
  return backendClient.getSshServerCredentials(serverId);
};

export const listSshFolders = async (): Promise<ApiSshListFoldersResponse> => {
  return backendClient.listSshFolders();
};

export const createSshFolder = async (payload: ApiSshCreateFolderRequest): Promise<ApiSshCreateFolderResponse> => {
  return backendClient.createSshFolder(payload);
};

export const updateSshFolder = async (
  folderId: string,
  payload: ApiSshUpdateFolderRequest,
): Promise<ApiSshUpdateFolderResponse> => {
  return backendClient.updateSshFolder(folderId, payload);
};

export const listSshTags = async (): Promise<ApiSshListTagsResponse> => {
  return backendClient.listSshTags();
};

export const createSshTag = async (payload: ApiSshCreateTagRequest): Promise<ApiSshCreateTagResponse> => {
  return backendClient.createSshTag(payload);
};

export const createSshSession = async (
  payload: ApiSshCreateSessionRequest,
): Promise<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse> => {
  return backendClient.createSshSession(payload);
};

export const trustSshFingerprint = async (
  payload: ApiSshTrustFingerprintRequest,
): Promise<ApiSshTrustFingerprintResponse> => {
  return backendClient.trustSshFingerprint(payload);
};

export const closeSshSession = async (sessionId: string): Promise<{ success: boolean }> => {
  return backendClient.closeSshSession(sessionId);
};

export const listLocalTerminalProfiles = async (): Promise<LocalTerminalListResponse> => {
  return backendClient.listLocalTerminalProfiles();
};

export const createLocalTerminalSession = async (
  payload: LocalTerminalCreateSessionRequest,
): Promise<LocalTerminalCreateSessionResponse> => {
  return backendClient.createLocalTerminalSession(payload);
};

export const closeLocalTerminalSession = async (sessionId: string): Promise<{ success: boolean }> => {
  return backendClient.closeLocalTerminalSession(sessionId);
};

export const deleteSshServer = async (serverId: string): Promise<{ success: boolean }> => {
  return backendClient.deleteSshServer(serverId);
};

export const deleteSshFolder = async (folderId: string): Promise<{ success: boolean }> => {
  return backendClient.deleteSshFolder(folderId);
};
