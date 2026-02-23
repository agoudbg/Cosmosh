import type {
  ApiErrorResponse,
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

type LocalTerminalProfile = {
  id: string;
  name: string;
  command: string;
  executablePath: string;
  args: string[];
};

type LocalTerminalListResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    items: LocalTerminalProfile[];
  };
};

type LocalTerminalCreateSessionRequest = {
  profileId: string;
  cols: number;
  rows: number;
  term: string;
};

type LocalTerminalCreateSessionResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    sessionId: string;
    profileId: string;
    websocketUrl: string;
    websocketToken: string;
  };
};

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    electron?: {
      closeWindow: () => void;
      getLocale: () => Promise<string>;
      setLocale: (locale: string) => Promise<string>;
      getRuntimeUserName: () => Promise<string>;
      getAppVersionInfo: () => Promise<{
        appName: string;
        version: string;
        buildVersion: string;
      }>;
      openDevTools: () => Promise<boolean>;
      showInFileManager: (targetPath?: string) => Promise<boolean>;
      openExternalUrl: (targetUrl: string) => Promise<boolean>;
      backendTestPing: () => Promise<ApiTestPingResponse | ApiErrorResponse>;
      backendSettingsGet: () => Promise<ApiSettingsGetResponse | ApiErrorResponse>;
      backendSettingsUpdate: (
        payload: ApiSettingsUpdateRequest,
      ) => Promise<ApiSettingsUpdateResponse | ApiErrorResponse>;
      backendSshListServers: () => Promise<ApiSshListServersResponse | ApiErrorResponse>;
      backendSshCreateServer: (
        payload: ApiSshCreateServerRequest,
      ) => Promise<ApiSshCreateServerResponse | ApiErrorResponse>;
      backendSshUpdateServer: (
        serverId: string,
        payload: ApiSshUpdateServerRequest,
      ) => Promise<ApiSshUpdateServerResponse | ApiErrorResponse>;
      backendSshGetServerCredentials: (
        serverId: string,
      ) => Promise<ApiSshGetServerCredentialsResponse | ApiErrorResponse>;
      backendSshListFolders: () => Promise<ApiSshListFoldersResponse | ApiErrorResponse>;
      backendSshCreateFolder: (
        payload: ApiSshCreateFolderRequest,
      ) => Promise<ApiSshCreateFolderResponse | ApiErrorResponse>;
      backendSshUpdateFolder: (
        folderId: string,
        payload: ApiSshUpdateFolderRequest,
      ) => Promise<ApiSshUpdateFolderResponse | ApiErrorResponse>;
      backendSshListTags: () => Promise<ApiSshListTagsResponse | ApiErrorResponse>;
      backendSshCreateTag: (payload: ApiSshCreateTagRequest) => Promise<ApiSshCreateTagResponse | ApiErrorResponse>;
      backendSshCreateSession: (
        payload: ApiSshCreateSessionRequest,
      ) => Promise<
        ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
      >;
      backendSshTrustFingerprint: (
        payload: ApiSshTrustFingerprintRequest,
      ) => Promise<ApiSshTrustFingerprintResponse | ApiErrorResponse>;
      backendSshCloseSession: (sessionId: string) => Promise<{ success: boolean }>;
      backendSshDeleteServer: (serverId: string) => Promise<{ success: boolean }>;
      backendSshDeleteFolder: (folderId: string) => Promise<{ success: boolean }>;
      backendLocalTerminalListProfiles: () => Promise<LocalTerminalListResponse | ApiErrorResponse>;
      backendLocalTerminalCreateSession: (
        payload: LocalTerminalCreateSessionRequest,
      ) => Promise<LocalTerminalCreateSessionResponse | ApiErrorResponse>;
      backendLocalTerminalCloseSession: (sessionId: string) => Promise<{ success: boolean }>;
      platform: NodeJS.Platform;
    };
  }
}

export {};
