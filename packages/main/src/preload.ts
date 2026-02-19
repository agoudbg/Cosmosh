import type {
  ApiErrorResponse,
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
import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // IPC communication
  send: (channel: string, data: unknown) => {
    ipcRenderer.send(channel, data);
  },
  on: (channel: string, func: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => func(...args));
  },
  once: (channel: string, func: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_event, ...args) => func(...args));
  },
  invoke: (channel: string, ...args: unknown[]) => {
    return ipcRenderer.invoke(channel, ...args);
  },
  getLocale: () => {
    return ipcRenderer.invoke('i18n:get-locale');
  },
  setLocale: (locale: string) => {
    return ipcRenderer.invoke('i18n:set-locale', locale);
  },
  getRuntimeUserName: () => {
    return ipcRenderer.invoke('app:get-runtime-user-name');
  },
  openDevTools: () => {
    return ipcRenderer.invoke('app:open-devtools') as Promise<boolean>;
  },
  backendTestPing: () => {
    return ipcRenderer.invoke('backend:test-ping') as Promise<ApiTestPingResponse | ApiErrorResponse>;
  },
  backendSshListServers: () => {
    return ipcRenderer.invoke('backend:ssh-list-servers') as Promise<ApiSshListServersResponse | ApiErrorResponse>;
  },
  backendSshCreateServer: (payload: ApiSshCreateServerRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-server', payload) as Promise<
      ApiSshCreateServerResponse | ApiErrorResponse
    >;
  },
  backendSshUpdateServer: (serverId: string, payload: ApiSshUpdateServerRequest) => {
    return ipcRenderer.invoke('backend:ssh-update-server', serverId, payload) as Promise<
      ApiSshUpdateServerResponse | ApiErrorResponse
    >;
  },
  backendSshGetServerCredentials: (serverId: string) => {
    return ipcRenderer.invoke('backend:ssh-get-server-credentials', serverId) as Promise<
      ApiSshGetServerCredentialsResponse | ApiErrorResponse
    >;
  },
  backendSshListFolders: () => {
    return ipcRenderer.invoke('backend:ssh-list-folders') as Promise<ApiSshListFoldersResponse | ApiErrorResponse>;
  },
  backendSshCreateFolder: (payload: ApiSshCreateFolderRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-folder', payload) as Promise<
      ApiSshCreateFolderResponse | ApiErrorResponse
    >;
  },
  backendSshUpdateFolder: (folderId: string, payload: ApiSshUpdateFolderRequest) => {
    return ipcRenderer.invoke('backend:ssh-update-folder', folderId, payload) as Promise<
      ApiSshUpdateFolderResponse | ApiErrorResponse
    >;
  },
  backendSshListTags: () => {
    return ipcRenderer.invoke('backend:ssh-list-tags') as Promise<ApiSshListTagsResponse | ApiErrorResponse>;
  },
  backendSshCreateTag: (payload: ApiSshCreateTagRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-tag', payload) as Promise<ApiSshCreateTagResponse | ApiErrorResponse>;
  },
  backendSshCreateSession: (payload: ApiSshCreateSessionRequest) => {
    return ipcRenderer.invoke('backend:ssh-create-session', payload) as Promise<
      ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    >;
  },
  backendSshTrustFingerprint: (payload: ApiSshTrustFingerprintRequest) => {
    return ipcRenderer.invoke('backend:ssh-trust-fingerprint', payload) as Promise<
      ApiSshTrustFingerprintResponse | ApiErrorResponse
    >;
  },
  backendSshCloseSession: (sessionId: string) => {
    return ipcRenderer.invoke('backend:ssh-close-session', sessionId) as Promise<{ success: boolean }>;
  },
  backendSshDeleteServer: (serverId: string) => {
    return ipcRenderer.invoke('backend:ssh-delete-server', serverId) as Promise<{ success: boolean }>;
  },
  backendSshDeleteFolder: (folderId: string) => {
    return ipcRenderer.invoke('backend:ssh-delete-folder', folderId) as Promise<{ success: boolean }>;
  },
  platform: process.platform,
});
