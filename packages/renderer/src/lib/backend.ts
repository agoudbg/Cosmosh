import type {
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

import { backendClient } from './api/client';

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

export const listSshFolders = async (): Promise<ApiSshListFoldersResponse> => {
  return backendClient.listSshFolders();
};

export const createSshFolder = async (payload: ApiSshCreateFolderRequest): Promise<ApiSshCreateFolderResponse> => {
  return backendClient.createSshFolder(payload);
};

export const listSshTags = async (): Promise<ApiSshListTagsResponse> => {
  return backendClient.listSshTags();
};

export const createSshTag = async (payload: ApiSshCreateTagRequest): Promise<ApiSshCreateTagResponse> => {
  return backendClient.createSshTag(payload);
};
