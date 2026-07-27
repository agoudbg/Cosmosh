import type {
  ApiAuditEventDetailResponse,
  ApiAuditEventListQuery,
  ApiAuditEventListResponse,
  ApiErrorResponse,
  ApiMcpBindTerminalLaunchRequest,
  ApiMcpBindTerminalLaunchResponse,
  ApiMcpCreateEventsChannelResponse,
  ApiMcpListApprovalsResponse,
  ApiMcpListClientsResponse,
  ApiMcpListConnectionsResponse,
  ApiMcpListTerminalLaunchesResponse,
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
  ApiSftpDownloadFileRequest,
  ApiSftpDownloadFileResponse,
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
  ApiSftpTaskErrorCode,
  ApiSftpTaskResult,
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
} from '@cosmosh/api-contract';

import { resolveSftpTaskResult, waitForSftpTask } from './sftp-task-runtime';
import {
  createApiTransport,
  LocalTerminalCreateSessionRequest,
  LocalTerminalCreateSessionResponse,
  LocalTerminalListResponse,
} from './transport';

export type BackendClient = {
  runtimeTarget: 'electron' | 'browser';
  testPing: () => Promise<ApiTestPingResponse>;
  listAuditEvents: (query?: ApiAuditEventListQuery) => Promise<ApiAuditEventListResponse>;
  getAuditEventById: (eventId: string) => Promise<ApiAuditEventDetailResponse>;
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
  listSshKeychains: () => Promise<ApiSshListKeychainsResponse>;
  createSshKeychain: (payload: ApiSshCreateKeychainRequest) => Promise<ApiSshCreateKeychainResponse>;
  updateSshKeychain: (
    keychainId: string,
    payload: ApiSshUpdateKeychainRequest,
  ) => Promise<ApiSshUpdateKeychainResponse>;
  getSshKeychainCredentials: (keychainId: string) => Promise<ApiSshGetKeychainCredentialsResponse>;
  listPortForwardRules: () => Promise<ApiPortForwardListRulesResponse>;
  createPortForwardRule: (payload: ApiPortForwardCreateRuleRequest) => Promise<ApiPortForwardCreateRuleResponse>;
  updatePortForwardRule: (
    ruleId: string,
    payload: ApiPortForwardUpdateRuleRequest,
  ) => Promise<ApiPortForwardUpdateRuleResponse>;
  startPortForwardRule: (
    ruleId: string,
    payload: ApiPortForwardStartRuleRequest,
  ) => Promise<ApiPortForwardStartRuleResponse>;
  stopPortForwardRule: (ruleId: string) => Promise<ApiPortForwardStopRuleResponse>;
  deletePortForwardRule: (ruleId: string) => Promise<{ success: boolean }>;
  createSshSession: (
    payload: ApiSshCreateSessionRequest,
  ) => Promise<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse>;
  createSftpSession: (
    payload: ApiSftpCreateSessionRequest,
  ) => Promise<ApiSftpCreateSessionResponse | ApiSftpCreateSessionHostVerificationRequiredResponse>;
  listSftpDirectory: (sessionId: string, query?: ApiSftpListDirectoryQuery) => Promise<ApiSftpListDirectoryResponse>;
  getSftpEntryDetails: (sessionId: string, payload: ApiSftpEntryDetailsRequest) => Promise<ApiSftpEntryDetailsResponse>;
  readSftpFile: (sessionId: string, query: ApiSftpReadFileQuery) => Promise<ApiSftpReadFileResponse>;
  writeSftpFile: (sessionId: string, payload: ApiSftpWriteFileRequest) => Promise<ApiSftpWriteFileResponse>;
  downloadSftpFile: (sessionId: string, payload: ApiSftpDownloadFileRequest) => Promise<ApiSftpDownloadFileResponse>;
  uploadSftpFile: (sessionId: string, payload: ApiSftpUploadFileRequest) => Promise<ApiSftpUploadFileResponse>;
  getSftpTransferProgress: (transferId: string) => Promise<ApiSftpTransferProgressResponse>;
  createSftpDirectory: (
    sessionId: string,
    payload: ApiSftpCreateDirectoryRequest,
  ) => Promise<ApiSftpCreateDirectoryResponse>;
  createSftpFile: (sessionId: string, payload: ApiSftpCreateFileRequest) => Promise<ApiSftpCreateFileResponse>;
  renameSftpEntry: (sessionId: string, payload: ApiSftpRenameRequest) => Promise<ApiSftpRenameResponse>;
  copySftpEntry: (sessionId: string, payload: ApiSftpCopyRequest) => Promise<ApiSftpCopyResponse>;
  deleteSftpEntry: (sessionId: string, payload: ApiSftpDeleteRequest) => Promise<ApiSftpDeleteResponse>;
  runSftpBatchOperation: (
    sessionId: string,
    payload: ApiSftpBatchOperationRequest,
  ) => Promise<ApiSftpBatchOperationResponse>;
  startSftpTask: (sessionId: string, payload: ApiSftpStartTaskRequest) => Promise<ApiSftpStartTaskResponse>;
  listSftpTasks: (sessionId: string) => Promise<ApiSftpListTasksResponse>;
  getSftpTask: (sessionId: string, taskId: string) => Promise<ApiSftpGetTaskResponse>;
  getSftpArchiveCapabilities: (sessionId: string) => Promise<ApiSftpArchiveCapabilitiesResponse>;
  startSftpArchiveOperation: (
    sessionId: string,
    payload: ApiSftpArchiveOperationRequest,
  ) => Promise<ApiSftpArchiveOperationAcceptedResponse>;
  getSftpArchiveOperation: (sessionId: string, operationId: string) => Promise<ApiSftpArchiveOperationStatusResponse>;
  resolveSftpArchiveConflict: (
    sessionId: string,
    operationId: string,
    payload: ApiSftpArchiveConflictResolutionRequest,
  ) => Promise<ApiSftpArchiveConflictResolutionResponse>;
  cancelSftpArchiveOperation: (sessionId: string, operationId: string) => Promise<ApiSftpArchiveCancelResponse>;
  trustSshFingerprint: (payload: ApiSshTrustFingerprintRequest) => Promise<ApiSshTrustFingerprintResponse>;
  listLocalTerminalProfiles: () => Promise<LocalTerminalListResponse>;
  createLocalTerminalSession: (
    payload: LocalTerminalCreateSessionRequest,
  ) => Promise<LocalTerminalCreateSessionResponse>;
  closeLocalTerminalSession: (sessionId: string) => Promise<{ success: boolean }>;
  closeSshSession: (sessionId: string) => Promise<{ success: boolean }>;
  closeSftpSession: (sessionId: string) => Promise<{ success: boolean }>;
  deleteSshServer: (serverId: string) => Promise<{ success: boolean }>;
  deleteSshFolder: (folderId: string) => Promise<{ success: boolean }>;
  deleteSshKeychain: (keychainId: string) => Promise<{ success: boolean }>;
  getMcpStatus: () => Promise<ApiMcpStatusResponse>;
  rotateMcpPairingToken: () => Promise<ApiMcpRotatePairingTokenResponse>;
  revokeMcpPairingToken: () => Promise<{ success: boolean }>;
  listMcpClients: () => Promise<ApiMcpListClientsResponse>;
  listMcpConnections: () => Promise<ApiMcpListConnectionsResponse>;
  closeMcpConnection: (connectionId: string) => Promise<{ success: boolean }>;
  detachMcpConnection: (connectionId: string) => Promise<{ success: boolean }>;
  interruptMcpConnection: (connectionId: string) => Promise<{ success: boolean }>;
  listMcpApprovals: () => Promise<ApiMcpListApprovalsResponse>;
  resolveMcpApproval: (
    approvalId: string,
    payload: ApiMcpResolveApprovalRequest,
  ) => Promise<ApiMcpResolveApprovalResponse>;
  listMcpTerminalLaunches: () => Promise<ApiMcpListTerminalLaunchesResponse>;
  cancelMcpTerminalLaunch: (launchId: string) => Promise<{ success: boolean }>;
  bindMcpTerminalLaunch: (
    launchId: string,
    payload: ApiMcpBindTerminalLaunchRequest,
  ) => Promise<ApiMcpBindTerminalLaunchResponse>;
  createMcpEventsChannel: () => Promise<ApiMcpCreateEventsChannelResponse>;
};

/**
 * Error thrown when the backend returns a structured API failure envelope.
 */
export class BackendApiError extends Error {
  public readonly code: ApiErrorResponse['code'];

  public readonly requestId: string;

  public readonly timestamp: string;

  /**
   * Creates a renderer error while preserving backend failure metadata.
   *
   * @param payload Backend API error response.
   */
  public constructor(payload: ApiErrorResponse) {
    super(payload.message);
    this.name = 'BackendApiError';
    this.code = payload.code;
    this.requestId = payload.requestId;
    this.timestamp = payload.timestamp;
  }
}

/**
 * Checks whether an unknown value is a structured backend API error.
 *
 * @param error Candidate error thrown by the backend client.
 * @returns Whether the error preserves backend API metadata.
 */
export const isBackendApiError = (error: unknown): error is BackendApiError => {
  return error instanceof BackendApiError;
};

/**
 * Error reported by a terminal asynchronous SFTP task snapshot.
 */
export class BackendSftpTaskError extends Error {
  public readonly code: ApiSftpTaskErrorCode;

  public readonly outcomeUnknown: boolean;

  /**
   * Creates a task error without widening the HTTP API error-code contract.
   *
   * @param task Terminal failed task snapshot.
   */
  public constructor(task: { errorCode?: ApiSftpTaskErrorCode; errorMessage?: string; outcomeUnknown?: boolean }) {
    super(task.errorMessage ?? 'SFTP task did not complete successfully.');
    this.name = 'BackendSftpTaskError';
    this.code = task.errorCode ?? 'SFTP_OPERATION_FAILED';
    this.outcomeUnknown = task.outcomeUnknown === true;
  }
}

/**
 * Checks whether an unknown value is a terminal asynchronous SFTP task error.
 *
 * @param error Candidate task failure.
 * @returns Whether the error preserves the backend task error code.
 */
export const isBackendSftpTaskError = (error: unknown): error is BackendSftpTaskError => {
  return error instanceof BackendSftpTaskError;
};

/**
 * Throws a structured API error instead of losing the backend error code.
 *
 * @param payload Backend API error response.
 * @returns Never returns because it always throws.
 */
const throwBackendApiError = (payload: ApiErrorResponse): never => {
  throw new BackendApiError(payload);
};

/**
 * Returns a successful transport response or throws a structured backend error.
 *
 * @param payload Transport response envelope.
 * @returns Successful API response.
 */
const unwrapApiResponse = <TResponse extends { success: true }>(payload: TResponse | ApiErrorResponse): TResponse => {
  if (!payload.success) {
    throwBackendApiError(payload);
  }

  return payload as TResponse;
};

export const createBackendClient = (): BackendClient => {
  const transport = createApiTransport();

  /**
   * Runs one public SFTP operation through the backend scheduler and waits for its retained result.
   *
   * @param sessionId Session that accepts the task.
   * @param request Typed asynchronous task descriptor.
   * @returns Completed task result and acceptance metadata.
   */
  const runScheduledSftpTask = async (
    sessionId: string,
    request: ApiSftpStartTaskRequest,
  ): Promise<{ accepted: ApiSftpStartTaskResponse; result: ApiSftpTaskResult }> => {
    const accepted = unwrapApiResponse(await transport.startSftpTask(sessionId, request));
    const terminalTask = await waitForSftpTask({
      acceptedTask: accepted.data,
      getTask: async (acceptedSessionId, taskId) =>
        unwrapApiResponse(await transport.getSftpTask(acceptedSessionId, taskId)),
    });

    const result = resolveSftpTaskResult(terminalTask, request.operation === 'batch');
    if (!result) {
      throw new BackendSftpTaskError(terminalTask);
    }

    return {
      accepted,
      result,
    };
  };

  return {
    runtimeTarget: transport.target,
    testPing: async () => {
      const payload = await transport.testPing();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    listAuditEvents: async (query) => {
      const payload = await transport.listAuditEvents(query);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    getAuditEventById: async (eventId) => {
      const payload = await transport.getAuditEventById(eventId);

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
    listSshKeychains: async () => {
      const payload = await transport.listSshKeychains();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createSshKeychain: async (requestPayload) => {
      const payload = await transport.createSshKeychain(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    updateSshKeychain: async (keychainId, requestPayload) => {
      const payload = await transport.updateSshKeychain(keychainId, requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    getSshKeychainCredentials: async (keychainId) => {
      const payload = await transport.getSshKeychainCredentials(keychainId);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    listPortForwardRules: async () => {
      const payload = await transport.listPortForwardRules();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    createPortForwardRule: async (requestPayload) => {
      const payload = await transport.createPortForwardRule(requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    updatePortForwardRule: async (ruleId, requestPayload) => {
      const payload = await transport.updatePortForwardRule(ruleId, requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    startPortForwardRule: async (ruleId, requestPayload) => {
      const payload = await transport.startPortForwardRule(ruleId, requestPayload);

      if (payload.success) {
        return payload;
      }

      if (payload.code === 'SSH_HOST_UNTRUSTED' && 'data' in payload) {
        return payload;
      }

      if (!payload.success) {
        throw new Error(payload.message);
      }

      throw new Error('Unexpected port forwarding start response.');
    },
    stopPortForwardRule: async (ruleId) => {
      const payload = await transport.stopPortForwardRule(ruleId);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    deletePortForwardRule: async (ruleId) => {
      return transport.deletePortForwardRule(ruleId);
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
    createSftpSession: async (requestPayload) => {
      const payload = await transport.createSftpSession(requestPayload);

      if (payload.success) {
        return payload;
      }

      if (payload.code === 'SSH_HOST_UNTRUSTED' && 'data' in payload) {
        return payload;
      }

      if (!payload.success) {
        throw new Error(payload.message);
      }

      throw new Error('Unexpected SFTP session response.');
    },
    listSftpDirectory: async (sessionId, query) => {
      return unwrapApiResponse(await transport.listSftpDirectory(sessionId, query));
    },
    getSftpEntryDetails: async (sessionId, requestPayload) => {
      return unwrapApiResponse(await transport.getSftpEntryDetails(sessionId, requestPayload));
    },
    readSftpFile: async (sessionId, query) => {
      return unwrapApiResponse(await transport.readSftpFile(sessionId, query));
    },
    writeSftpFile: async (sessionId, requestPayload) => {
      return unwrapApiResponse(await transport.writeSftpFile(sessionId, requestPayload));
    },
    downloadSftpFile: async (sessionId, requestPayload) => {
      const { accepted, result } = await runScheduledSftpTask(sessionId, {
        operation: 'download',
        payload: {
          ...requestPayload,
          transferId: requestPayload.transferId ?? crypto.randomUUID(),
        },
      });
      if (result.type !== 'download') {
        throw new Error('SFTP download task returned an unexpected result.');
      }
      return {
        ...accepted,
        code: 'SFTP_OPERATION_OK',
        data: result.data,
      };
    },
    uploadSftpFile: async (sessionId, requestPayload) => {
      const { accepted, result } = await runScheduledSftpTask(sessionId, {
        operation: 'upload',
        payload: {
          ...requestPayload,
          transferId: requestPayload.transferId ?? crypto.randomUUID(),
        },
      });
      if (result.type !== 'operation') {
        throw new Error('SFTP upload task returned an unexpected result.');
      }
      return {
        ...accepted,
        code: 'SFTP_OPERATION_OK',
        data: result.data,
      };
    },
    getSftpTransferProgress: async (transferId) => {
      return unwrapApiResponse(await transport.getSftpTransferProgress(transferId));
    },
    createSftpDirectory: async (sessionId, requestPayload) => {
      const { accepted, result } = await runScheduledSftpTask(sessionId, {
        operation: 'create-directory',
        payload: requestPayload,
      });
      if (result.type !== 'operation') {
        throw new Error('SFTP create-directory task returned an unexpected result.');
      }
      return {
        ...accepted,
        code: 'SFTP_OPERATION_OK',
        data: result.data,
      };
    },
    createSftpFile: async (sessionId, requestPayload) => {
      const { accepted, result } = await runScheduledSftpTask(sessionId, {
        operation: 'create-file',
        payload: requestPayload,
      });
      if (result.type !== 'operation') {
        throw new Error('SFTP create-file task returned an unexpected result.');
      }
      return {
        ...accepted,
        code: 'SFTP_OPERATION_OK',
        data: result.data,
      };
    },
    renameSftpEntry: async (sessionId, requestPayload) => {
      const { accepted, result } = await runScheduledSftpTask(sessionId, {
        operation: 'rename',
        payload: requestPayload,
      });
      if (result.type !== 'operation') {
        throw new Error('SFTP rename task returned an unexpected result.');
      }
      return {
        ...accepted,
        code: 'SFTP_OPERATION_OK',
        data: result.data,
      };
    },
    copySftpEntry: async (sessionId, requestPayload) => {
      return unwrapApiResponse(await transport.copySftpEntry(sessionId, requestPayload));
    },
    deleteSftpEntry: async (sessionId, requestPayload) => {
      return unwrapApiResponse(await transport.deleteSftpEntry(sessionId, requestPayload));
    },
    runSftpBatchOperation: async (sessionId, requestPayload) => {
      const { accepted, result } = await runScheduledSftpTask(sessionId, {
        operation: 'batch',
        payload: requestPayload,
      });
      if (result.type !== 'batch') {
        throw new Error('SFTP batch task returned an unexpected result.');
      }
      return {
        ...accepted,
        code: 'SFTP_OPERATION_OK',
        data: result.data,
      };
    },
    startSftpTask: async (sessionId, requestPayload) => {
      return unwrapApiResponse(await transport.startSftpTask(sessionId, requestPayload));
    },
    listSftpTasks: async (sessionId) => {
      return unwrapApiResponse(await transport.listSftpTasks(sessionId));
    },
    getSftpTask: async (sessionId, taskId) => {
      return unwrapApiResponse(await transport.getSftpTask(sessionId, taskId));
    },
    getSftpArchiveCapabilities: async (sessionId) => {
      return unwrapApiResponse(await transport.getSftpArchiveCapabilities(sessionId));
    },
    startSftpArchiveOperation: async (sessionId, requestPayload) => {
      return unwrapApiResponse(await transport.startSftpArchiveOperation(sessionId, requestPayload));
    },
    getSftpArchiveOperation: async (sessionId, operationId) => {
      return unwrapApiResponse(await transport.getSftpArchiveOperation(sessionId, operationId));
    },
    resolveSftpArchiveConflict: async (sessionId, operationId, requestPayload) => {
      return unwrapApiResponse(await transport.resolveSftpArchiveConflict(sessionId, operationId, requestPayload));
    },
    cancelSftpArchiveOperation: async (sessionId, operationId) => {
      return unwrapApiResponse(await transport.cancelSftpArchiveOperation(sessionId, operationId));
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
    closeSftpSession: async (sessionId) => {
      return transport.closeSftpSession(sessionId);
    },
    deleteSshServer: async (serverId) => {
      return transport.deleteSshServer(serverId);
    },
    deleteSshFolder: async (folderId) => {
      return transport.deleteSshFolder(folderId);
    },
    deleteSshKeychain: async (keychainId) => {
      return transport.deleteSshKeychain(keychainId);
    },
    getMcpStatus: async () => {
      const payload = await transport.getMcpStatus();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    rotateMcpPairingToken: async () => {
      const payload = await transport.rotateMcpPairingToken();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    revokeMcpPairingToken: async () => {
      return transport.revokeMcpPairingToken();
    },
    listMcpClients: async () => {
      const payload = await transport.listMcpClients();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    listMcpConnections: async () => {
      const payload = await transport.listMcpConnections();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    closeMcpConnection: async (connectionId) => {
      return transport.closeMcpConnection(connectionId);
    },
    detachMcpConnection: async (connectionId) => {
      return transport.detachMcpConnection(connectionId);
    },
    interruptMcpConnection: async (connectionId) => {
      return transport.interruptMcpConnection(connectionId);
    },
    listMcpApprovals: async () => {
      const payload = await transport.listMcpApprovals();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    resolveMcpApproval: async (approvalId, requestPayload) => {
      const payload = await transport.resolveMcpApproval(approvalId, requestPayload);

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
    listMcpTerminalLaunches: async () => {
      const payload = await transport.listMcpTerminalLaunches();
      if (!payload.success) {
        throw new Error(payload.message);
      }
      return payload;
    },
    cancelMcpTerminalLaunch: async (launchId) => {
      return transport.cancelMcpTerminalLaunch(launchId);
    },
    bindMcpTerminalLaunch: async (launchId, requestPayload) => {
      const payload = await transport.bindMcpTerminalLaunch(launchId, requestPayload);
      if (!payload.success) {
        throw new Error(payload.message);
      }
      return payload;
    },
    createMcpEventsChannel: async () => {
      const payload = await transport.createMcpEventsChannel();

      if (!payload.success) {
        throw new Error(payload.message);
      }

      return payload;
    },
  };
};

export const backendClient = createBackendClient();
