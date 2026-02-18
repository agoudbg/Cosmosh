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
  ApiSshListFoldersResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiSshTrustFingerprintRequest,
  ApiSshTrustFingerprintResponse,
  ApiTestPingResponse,
} from '@cosmosh/api-contract';

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    electron?: {
      send: (channel: string, data: unknown) => void;
      on: (channel: string, func: (...args: unknown[]) => void) => void;
      once: (channel: string, func: (...args: unknown[]) => void) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      getLocale: () => Promise<string>;
      setLocale: (locale: string) => Promise<string>;
      getRuntimeUserName: () => Promise<string>;
      backendTestPing: () => Promise<ApiTestPingResponse | ApiErrorResponse>;
      backendSshListServers: () => Promise<ApiSshListServersResponse | ApiErrorResponse>;
      backendSshCreateServer: (
        payload: ApiSshCreateServerRequest,
      ) => Promise<ApiSshCreateServerResponse | ApiErrorResponse>;
      backendSshListFolders: () => Promise<ApiSshListFoldersResponse | ApiErrorResponse>;
      backendSshCreateFolder: (
        payload: ApiSshCreateFolderRequest,
      ) => Promise<ApiSshCreateFolderResponse | ApiErrorResponse>;
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
      platform: NodeJS.Platform;
    };
  }
}

export {};
