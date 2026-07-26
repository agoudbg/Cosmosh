import type {
  ApiAuditEventDetailResponse,
  ApiAuditEventListQuery,
  ApiAuditEventListResponse,
  ApiErrorResponse,
  ApiLocalTerminalCreateSessionRequest,
  ApiLocalTerminalCreateSessionResponse,
  ApiLocalTerminalListProfilesResponse,
  ApiMcpCreateEventsChannelResponse,
  ApiMcpListApprovalsResponse,
  ApiMcpListClientsResponse,
  ApiMcpListConnectionsResponse,
  ApiMcpResolveApprovalRequest,
  ApiMcpResolveApprovalResponse,
  ApiMcpRotatePairingTokenResponse,
  ApiMcpStatusResponse,
  ApiPortForwardCreateRuleRequest,
  ApiPortForwardCreateRuleResponse,
  ApiPortForwardListRulesResponse,
  ApiPortForwardStartRuleRequest,
  ApiPortForwardStartRuleResponse,
  ApiPortForwardStopRuleResponse,
  ApiPortForwardUpdateRuleRequest,
  ApiPortForwardUpdateRuleResponse,
  ApiSettingsGetResponse,
  ApiSettingsUpdateRequest,
  ApiSettingsUpdateResponse,
  ApiSftpArchiveCancelResponse,
  ApiSftpArchiveCapabilitiesResponse,
  ApiSftpArchiveConflictResolutionRequest,
  ApiSftpArchiveConflictResolutionResponse,
  ApiSftpArchiveOperationAcceptedResponse,
  ApiSftpArchiveOperationRequest,
  ApiSftpArchiveOperationStatusResponse,
  ApiSftpBatchOperationRequest,
  ApiSftpBatchOperationResponse,
  ApiSftpCopyRequest,
  ApiSftpCopyResponse,
  ApiSftpCreateDirectoryRequest,
  ApiSftpCreateDirectoryResponse,
  ApiSftpCreateFileRequest,
  ApiSftpCreateFileResponse,
  ApiSftpCreateSessionHostVerificationRequiredResponse,
  ApiSftpCreateSessionRequest,
  ApiSftpCreateSessionResponse,
  ApiSftpDeleteRequest,
  ApiSftpDeleteResponse,
  ApiSftpEntryDetailsRequest,
  ApiSftpEntryDetailsResponse,
  ApiSftpGetTaskResponse,
  ApiSftpListDirectoryQuery,
  ApiSftpListDirectoryResponse,
  ApiSftpListTasksResponse,
  ApiSftpReadFileQuery,
  ApiSftpReadFileResponse,
  ApiSftpRenameRequest,
  ApiSftpRenameResponse,
  ApiSftpStartTaskRequest,
  ApiSftpStartTaskResponse,
  ApiSftpTransferProgressResponse,
  ApiSftpUploadFileRequest,
  ApiSftpUploadFileResponse,
  ApiSftpWriteFileRequest,
  ApiSftpWriteFileResponse,
  ApiSshCreateFolderRequest,
  ApiSshCreateFolderResponse,
  ApiSshCreateKeychainRequest,
  ApiSshCreateKeychainResponse,
  ApiSshCreateServerRequest,
  ApiSshCreateServerResponse,
  ApiSshCreateSessionHostVerificationRequiredResponse,
  ApiSshCreateSessionRequest,
  ApiSshCreateSessionResponse,
  ApiSshCreateTagRequest,
  ApiSshCreateTagResponse,
  ApiSshGetKeychainCredentialsResponse,
  ApiSshGetServerCredentialsResponse,
  ApiSshListFoldersResponse,
  ApiSshListKeychainsResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiSshTrustFingerprintRequest,
  ApiSshTrustFingerprintResponse,
  ApiSshUpdateFolderRequest,
  ApiSshUpdateFolderResponse,
  ApiSshUpdateKeychainRequest,
  ApiSshUpdateKeychainResponse,
  ApiSshUpdateServerRequest,
  ApiSshUpdateServerResponse,
  ApiTestPingResponse,
  AppCloseConfirmationRequest,
  AppCloseConfirmationResponse,
  AppMenuAction,
  BackendRequestTrace,
  SftpOpenWithApplication,
  SftpTemporaryFileWatchChange,
  SftpUploadFileSelection,
  SystemProxyResolveRequest,
  SystemProxyResolveResult,
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
      focusWindow: () => Promise<boolean>;
      onCloseConfirmationRequested: (listener: (request: AppCloseConfirmationRequest) => void) => () => void;
      respondToCloseConfirmation: (response: AppCloseConfirmationResponse) => void;
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
      getDownloadsPath: () => Promise<string>;
      createSftpTemporaryFile: (fileName: string) => Promise<string>;
      createSftpDownloadsFile: (fileName: string) => Promise<string>;
      selectSftpUploadFiles: () => Promise<SftpUploadFileSelection>;
      stageDroppedSftpUploadFiles: (files: File[]) => Promise<SftpUploadFileSelection>;
      cleanupSftpTemporaryFiles: (localPaths: string[]) => Promise<boolean>;
      openSftpTemporaryFile: (localPath: string) => Promise<boolean>;
      readSftpTemporaryImagePreview: (localPath: string) => Promise<string>;
      startSftpTemporaryFileWatch: (localPath: string) => Promise<string>;
      stopSftpTemporaryFileWatch: (watchId: string) => Promise<boolean>;
      onSftpTemporaryFileChanged: (listener: (change: SftpTemporaryFileWatchChange) => void) => () => void;
      showSftpOpenWithDialog: (localPath: string) => Promise<boolean>;
      listSftpOpenWithApplications: (localPath: string) => Promise<SftpOpenWithApplication[]>;
      openSftpFileWithApplication: (localPath: string, applicationPath: string) => Promise<boolean>;
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
      resolveSystemProxy: (request: SystemProxyResolveRequest) => Promise<SystemProxyResolveResult>;
      onLaunchWorkingDirectory: (listener: (cwd: string) => void) => () => void;
      onAppMenuAction: (listener: (action: AppMenuAction) => void) => () => void;
      openDevTools: () => Promise<boolean>;
      toggleDevTools: () => Promise<boolean>;
      reloadWebView: () => Promise<boolean>;
      restartBackendRuntime: () => Promise<boolean>;
      showInFileManager: (targetPath?: string) => Promise<boolean>;
      openExternalUrl: (targetUrl: string) => Promise<boolean>;
      setWindowsSystemMenuSymbolColor: (symbolColor: string) => Promise<boolean>;
      showSaveFileDialog: (defaultPath?: string) => Promise<{ canceled: boolean; filePath?: string }>;
      importPrivateKeyFromFile: () => Promise<{
        canceled: boolean;
        fileName?: string;
        content?: string;
      }>;
      getProcessPerformanceStats: () => Promise<{
        sampledAt: number;
        cpuPercent: number | null;
        mainProcessMemory: {
          rssBytes: number;
          heapTotalBytes: number;
          heapUsedBytes: number;
          externalBytes: number;
          arrayBuffersBytes: number;
        };
        rendererProcessMemory: {
          residentSetBytes: number;
          privateBytes: number;
          sharedBytes: number;
        } | null;
        backendProcess: {
          pid: number;
          cpuPercent: number | null;
          memoryRssBytes: number | null;
        } | null;
      }>;
      exportMainHeapSnapshot: () => Promise<{
        ok: boolean;
        filePath?: string;
        message?: string;
      }>;
      getBackendRequestTraces: () => Promise<BackendRequestTrace[]>;
      clearBackendRequestTraces: () => Promise<boolean>;
      onBackendRequestTrace: (listener: (trace: BackendRequestTrace) => void) => () => void;
      backendTestPing: () => Promise<ApiTestPingResponse | ApiErrorResponse>;
      backendSettingsGet: () => Promise<ApiSettingsGetResponse | ApiErrorResponse>;
      backendSettingsUpdate: (
        payload: ApiSettingsUpdateRequest,
      ) => Promise<ApiSettingsUpdateResponse | ApiErrorResponse>;
      backendAuditListEvents: (query?: ApiAuditEventListQuery) => Promise<ApiAuditEventListResponse | ApiErrorResponse>;
      backendAuditGetEventById: (eventId: string) => Promise<ApiAuditEventDetailResponse | ApiErrorResponse>;
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
      backendSshListKeychains: () => Promise<ApiSshListKeychainsResponse | ApiErrorResponse>;
      backendSshCreateKeychain: (
        payload: ApiSshCreateKeychainRequest,
      ) => Promise<ApiSshCreateKeychainResponse | ApiErrorResponse>;
      backendSshUpdateKeychain: (
        keychainId: string,
        payload: ApiSshUpdateKeychainRequest,
      ) => Promise<ApiSshUpdateKeychainResponse | ApiErrorResponse>;
      backendSshGetKeychainCredentials: (
        keychainId: string,
      ) => Promise<ApiSshGetKeychainCredentialsResponse | ApiErrorResponse>;
      backendSshCreateSession: (
        payload: ApiSshCreateSessionRequest,
      ) => Promise<
        ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
      >;
      backendSshTrustFingerprint: (
        payload: ApiSshTrustFingerprintRequest,
      ) => Promise<ApiSshTrustFingerprintResponse | ApiErrorResponse>;
      backendSshCloseSession: (sessionId: string) => Promise<{ success: boolean }>;
      backendSftpCreateSession: (
        payload: ApiSftpCreateSessionRequest,
      ) => Promise<
        ApiSftpCreateSessionResponse | ApiSftpCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
      >;
      backendSftpListDirectory: (
        sessionId: string,
        query?: ApiSftpListDirectoryQuery,
      ) => Promise<ApiSftpListDirectoryResponse | ApiErrorResponse>;
      backendSftpGetEntryDetails: (
        sessionId: string,
        payload: ApiSftpEntryDetailsRequest,
      ) => Promise<ApiSftpEntryDetailsResponse | ApiErrorResponse>;
      backendSftpReadFile: (
        sessionId: string,
        query: ApiSftpReadFileQuery,
      ) => Promise<ApiSftpReadFileResponse | ApiErrorResponse>;
      backendSftpWriteFile: (
        sessionId: string,
        payload: ApiSftpWriteFileRequest,
      ) => Promise<ApiSftpWriteFileResponse | ApiErrorResponse>;
      backendSftpDownloadFile: (
        sessionId: string,
        payload: ApiSftpDownloadFileRequest,
      ) => Promise<ApiSftpDownloadFileResponse | ApiErrorResponse>;
      backendSftpUploadFile: (
        sessionId: string,
        payload: ApiSftpUploadFileRequest,
      ) => Promise<ApiSftpUploadFileResponse | ApiErrorResponse>;
      backendSftpGetTransferProgress: (
        transferId: string,
      ) => Promise<ApiSftpTransferProgressResponse | ApiErrorResponse>;
      backendSftpCreateDirectory: (
        sessionId: string,
        payload: ApiSftpCreateDirectoryRequest,
      ) => Promise<ApiSftpCreateDirectoryResponse | ApiErrorResponse>;
      backendSftpCreateFile: (
        sessionId: string,
        payload: ApiSftpCreateFileRequest,
      ) => Promise<ApiSftpCreateFileResponse | ApiErrorResponse>;
      backendSftpRenameEntry: (
        sessionId: string,
        payload: ApiSftpRenameRequest,
      ) => Promise<ApiSftpRenameResponse | ApiErrorResponse>;
      backendSftpCopyEntry: (
        sessionId: string,
        payload: ApiSftpCopyRequest,
      ) => Promise<ApiSftpCopyResponse | ApiErrorResponse>;
      backendSftpDeleteEntry: (
        sessionId: string,
        payload: ApiSftpDeleteRequest,
      ) => Promise<ApiSftpDeleteResponse | ApiErrorResponse>;
      backendSftpBatchOperation: (
        sessionId: string,
        payload: ApiSftpBatchOperationRequest,
      ) => Promise<ApiSftpBatchOperationResponse | ApiErrorResponse>;
      backendSftpStartTask: (
        sessionId: string,
        payload: ApiSftpStartTaskRequest,
      ) => Promise<ApiSftpStartTaskResponse | ApiErrorResponse>;
      backendSftpListTasks: (sessionId: string) => Promise<ApiSftpListTasksResponse | ApiErrorResponse>;
      backendSftpGetTask: (sessionId: string, taskId: string) => Promise<ApiSftpGetTaskResponse | ApiErrorResponse>;
      backendSftpGetArchiveCapabilities: (
        sessionId: string,
      ) => Promise<ApiSftpArchiveCapabilitiesResponse | ApiErrorResponse>;
      backendSftpStartArchiveOperation: (
        sessionId: string,
        payload: ApiSftpArchiveOperationRequest,
      ) => Promise<ApiSftpArchiveOperationAcceptedResponse | ApiErrorResponse>;
      backendSftpGetArchiveOperation: (
        sessionId: string,
        operationId: string,
      ) => Promise<ApiSftpArchiveOperationStatusResponse | ApiErrorResponse>;
      backendSftpResolveArchiveConflict: (
        sessionId: string,
        operationId: string,
        payload: ApiSftpArchiveConflictResolutionRequest,
      ) => Promise<ApiSftpArchiveConflictResolutionResponse | ApiErrorResponse>;
      backendSftpCancelArchiveOperation: (
        sessionId: string,
        operationId: string,
      ) => Promise<ApiSftpArchiveCancelResponse | ApiErrorResponse>;
      backendSftpCloseSession: (sessionId: string) => Promise<{ success: boolean }>;
      backendSshDeleteServer: (serverId: string) => Promise<{ success: boolean }>;
      backendSshDeleteFolder: (folderId: string) => Promise<{ success: boolean }>;
      backendSshDeleteKeychain: (keychainId: string) => Promise<{ success: boolean }>;
      backendPortForwardListRules: () => Promise<ApiPortForwardListRulesResponse | ApiErrorResponse>;
      backendPortForwardCreateRule: (
        payload: ApiPortForwardCreateRuleRequest,
      ) => Promise<ApiPortForwardCreateRuleResponse | ApiErrorResponse>;
      backendPortForwardUpdateRule: (
        ruleId: string,
        payload: ApiPortForwardUpdateRuleRequest,
      ) => Promise<ApiPortForwardUpdateRuleResponse | ApiErrorResponse>;
      backendPortForwardStartRule: (
        ruleId: string,
        payload: ApiPortForwardStartRuleRequest,
      ) => Promise<ApiPortForwardStartRuleResponse | ApiErrorResponse>;
      backendPortForwardStopRule: (ruleId: string) => Promise<ApiPortForwardStopRuleResponse | ApiErrorResponse>;
      backendPortForwardDeleteRule: (ruleId: string) => Promise<{ success: boolean }>;
      backendLocalTerminalListProfiles: () => Promise<LocalTerminalListResponse | ApiErrorResponse>;
      backendLocalTerminalCreateSession: (
        payload: LocalTerminalCreateSessionRequest,
      ) => Promise<LocalTerminalCreateSessionResponse | ApiErrorResponse>;
      backendLocalTerminalCloseSession: (sessionId: string) => Promise<{ success: boolean }>;
      backendMcpGetStatus: () => Promise<ApiMcpStatusResponse | ApiErrorResponse>;
      backendMcpRotatePairingToken: () => Promise<ApiMcpRotatePairingTokenResponse | ApiErrorResponse>;
      backendMcpRevokePairingToken: () => Promise<{ success: boolean }>;
      backendMcpListClients: () => Promise<ApiMcpListClientsResponse | ApiErrorResponse>;
      backendMcpListConnections: () => Promise<ApiMcpListConnectionsResponse | ApiErrorResponse>;
      backendMcpCloseConnection: (connectionId: string) => Promise<{ success: boolean }>;
      backendMcpListApprovals: () => Promise<ApiMcpListApprovalsResponse | ApiErrorResponse>;
      backendMcpResolveApproval: (
        approvalId: string,
        payload: ApiMcpResolveApprovalRequest,
      ) => Promise<ApiMcpResolveApprovalResponse | ApiErrorResponse>;
      backendMcpCreateEventsChannel: () => Promise<ApiMcpCreateEventsChannelResponse | ApiErrorResponse>;
      platform: NodeJS.Platform;
    };
    __COSMOSH_BACKEND_REQUEST_TRACE__?: {
      traces: BackendRequestTrace[];
      enabled: boolean;
      updatedAt: string | null;
      refresh: () => Promise<BackendRequestTrace[]>;
      clear: () => Promise<boolean>;
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
