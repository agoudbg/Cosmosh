import type {
  ApiErrorResponse,
  ApiLocalTerminalCreateSessionRequest,
  ApiLocalTerminalCreateSessionResponse,
  ApiLocalTerminalListProfilesResponse,
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

type LocalTerminalListResponse = ApiLocalTerminalListProfilesResponse;
type LocalTerminalCreateSessionRequest = ApiLocalTerminalCreateSessionRequest;
type LocalTerminalCreateSessionResponse = ApiLocalTerminalCreateSessionResponse;

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly VITE_ENABLE_STRICT_MODE?: string;
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
        buildTime: string;
        commit: string;
        electron: string;
        chromium: string;
        node: string;
        v8: string;
        os: string;
      }>;
      getPendingLaunchWorkingDirectory: () => Promise<string | null>;
      getDatabaseSecurityInfo: () => Promise<{
        runtimeMode: 'development' | 'production';
        resolverMode: 'development-fixed-key' | 'safe-storage' | 'master-password-fallback';
        safeStorageAvailable: boolean;
        databasePath: string;
        securityConfigPath: string;
        hasEncryptedDbMasterKey: boolean;
        hasMasterPasswordHash: boolean;
        hasMasterPasswordSalt: boolean;
        hasMasterPasswordEnv: boolean;
        fallbackReady: boolean;
      }>;
      onLaunchWorkingDirectory: (listener: (cwd: string) => void) => () => void;
      openDevTools: () => Promise<boolean>;
      restartBackendRuntime: () => Promise<boolean>;
      showInFileManager: (targetPath?: string) => Promise<boolean>;
      openExternalUrl: (targetUrl: string) => Promise<boolean>;
      importPrivateKeyFromFile: () => Promise<{ canceled: boolean; content?: string }>;
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

declare module '*.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/css/css.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/html/html.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}
