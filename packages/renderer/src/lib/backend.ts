import type {
  ApiAuditEventDetailResponse,
  ApiAuditEventListQuery,
  ApiAuditEventListResponse,
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

import { backendClient } from './api/client';
import type {
  LocalTerminalCreateSessionRequest,
  LocalTerminalCreateSessionResponse,
  LocalTerminalListResponse,
} from './api/transport';

export { BackendApiError, BackendSftpTaskError, isBackendApiError, isBackendSftpTaskError } from './api/client';

export const testBackendPing = async (): Promise<ApiTestPingResponse> => {
  return backendClient.testPing();
};

export const listAuditEvents = async (query?: ApiAuditEventListQuery): Promise<ApiAuditEventListResponse> => {
  return backendClient.listAuditEvents(query);
};

export const getAuditEventById = async (eventId: string): Promise<ApiAuditEventDetailResponse> => {
  return backendClient.getAuditEventById(eventId);
};

export const getBackendRuntimeTarget = (): 'electron' | 'browser' => {
  return backendClient.runtimeTarget;
};

export const getAppSettings = async (): Promise<ApiSettingsGetResponse> => {
  return backendClient.getSettings();
};

export const updateAppSettings = async (payload: ApiSettingsUpdateRequest): Promise<ApiSettingsUpdateResponse> => {
  return backendClient.updateSettings(payload);
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

export const listSshKeychains = async (): Promise<ApiSshListKeychainsResponse> => {
  return backendClient.listSshKeychains();
};

export const createSshKeychain = async (
  payload: ApiSshCreateKeychainRequest,
): Promise<ApiSshCreateKeychainResponse> => {
  return backendClient.createSshKeychain(payload);
};

export const updateSshKeychain = async (
  keychainId: string,
  payload: ApiSshUpdateKeychainRequest,
): Promise<ApiSshUpdateKeychainResponse> => {
  return backendClient.updateSshKeychain(keychainId, payload);
};

export const getSshKeychainCredentials = async (keychainId: string): Promise<ApiSshGetKeychainCredentialsResponse> => {
  return backendClient.getSshKeychainCredentials(keychainId);
};

export const listPortForwardRules = async (): Promise<ApiPortForwardListRulesResponse> => {
  return backendClient.listPortForwardRules();
};

export const createPortForwardRule = async (
  payload: ApiPortForwardCreateRuleRequest,
): Promise<ApiPortForwardCreateRuleResponse> => {
  return backendClient.createPortForwardRule(payload);
};

export const updatePortForwardRule = async (
  ruleId: string,
  payload: ApiPortForwardUpdateRuleRequest,
): Promise<ApiPortForwardUpdateRuleResponse> => {
  return backendClient.updatePortForwardRule(ruleId, payload);
};

export const startPortForwardRule = async (
  ruleId: string,
  payload: ApiPortForwardStartRuleRequest,
): Promise<ApiPortForwardStartRuleResponse> => {
  return backendClient.startPortForwardRule(ruleId, payload);
};

export const stopPortForwardRule = async (ruleId: string): Promise<ApiPortForwardStopRuleResponse> => {
  return backendClient.stopPortForwardRule(ruleId);
};

export const deletePortForwardRule = async (ruleId: string): Promise<{ success: boolean }> => {
  return backendClient.deletePortForwardRule(ruleId);
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

export const createSftpSession = async (
  payload: ApiSftpCreateSessionRequest,
): Promise<ApiSftpCreateSessionResponse | ApiSftpCreateSessionHostVerificationRequiredResponse> => {
  return backendClient.createSftpSession(payload);
};

export const listSftpDirectory = async (
  sessionId: string,
  query?: ApiSftpListDirectoryQuery,
): Promise<ApiSftpListDirectoryResponse> => {
  return backendClient.listSftpDirectory(sessionId, query);
};

export const getSftpEntryDetails = async (
  sessionId: string,
  payload: ApiSftpEntryDetailsRequest,
): Promise<ApiSftpEntryDetailsResponse> => {
  return backendClient.getSftpEntryDetails(sessionId, payload);
};

export const readSftpFile = async (
  sessionId: string,
  query: ApiSftpReadFileQuery,
): Promise<ApiSftpReadFileResponse> => {
  return backendClient.readSftpFile(sessionId, query);
};

export const writeSftpFile = async (
  sessionId: string,
  payload: ApiSftpWriteFileRequest,
): Promise<ApiSftpWriteFileResponse> => {
  return backendClient.writeSftpFile(sessionId, payload);
};

export const downloadSftpFile = async (
  sessionId: string,
  payload: ApiSftpDownloadFileRequest,
): Promise<ApiSftpDownloadFileResponse> => {
  return backendClient.downloadSftpFile(sessionId, payload);
};

export const uploadSftpFile = async (
  sessionId: string,
  payload: ApiSftpUploadFileRequest,
): Promise<ApiSftpUploadFileResponse> => {
  return backendClient.uploadSftpFile(sessionId, payload);
};

export const getSftpTransferProgress = async (transferId: string): Promise<ApiSftpTransferProgressResponse> => {
  return backendClient.getSftpTransferProgress(transferId);
};

export const createSftpDirectory = async (
  sessionId: string,
  payload: ApiSftpCreateDirectoryRequest,
): Promise<ApiSftpCreateDirectoryResponse> => {
  return backendClient.createSftpDirectory(sessionId, payload);
};

export const createSftpFile = async (
  sessionId: string,
  payload: ApiSftpCreateFileRequest,
): Promise<ApiSftpCreateFileResponse> => {
  return backendClient.createSftpFile(sessionId, payload);
};

export const renameSftpEntry = async (
  sessionId: string,
  payload: ApiSftpRenameRequest,
): Promise<ApiSftpRenameResponse> => {
  return backendClient.renameSftpEntry(sessionId, payload);
};

export const copySftpEntry = async (sessionId: string, payload: ApiSftpCopyRequest): Promise<ApiSftpCopyResponse> => {
  return backendClient.copySftpEntry(sessionId, payload);
};

export const deleteSftpEntry = async (
  sessionId: string,
  payload: ApiSftpDeleteRequest,
): Promise<ApiSftpDeleteResponse> => {
  return backendClient.deleteSftpEntry(sessionId, payload);
};

export const runSftpBatchOperation = async (
  sessionId: string,
  payload: ApiSftpBatchOperationRequest,
): Promise<ApiSftpBatchOperationResponse> => {
  return backendClient.runSftpBatchOperation(sessionId, payload);
};

export const startSftpTask = async (
  sessionId: string,
  payload: ApiSftpStartTaskRequest,
): Promise<ApiSftpStartTaskResponse> => {
  return backendClient.startSftpTask(sessionId, payload);
};

export const listSftpTasks = async (sessionId: string): Promise<ApiSftpListTasksResponse> => {
  return backendClient.listSftpTasks(sessionId);
};

export const getSftpTask = async (sessionId: string, taskId: string): Promise<ApiSftpGetTaskResponse> => {
  return backendClient.getSftpTask(sessionId, taskId);
};

export const getSftpArchiveCapabilities = async (sessionId: string): Promise<ApiSftpArchiveCapabilitiesResponse> => {
  return backendClient.getSftpArchiveCapabilities(sessionId);
};

export const startSftpArchiveOperation = async (
  sessionId: string,
  payload: ApiSftpArchiveOperationRequest,
): Promise<ApiSftpArchiveOperationAcceptedResponse> => {
  return backendClient.startSftpArchiveOperation(sessionId, payload);
};

export const getSftpArchiveOperation = async (
  sessionId: string,
  operationId: string,
): Promise<ApiSftpArchiveOperationStatusResponse> => {
  return backendClient.getSftpArchiveOperation(sessionId, operationId);
};

export const resolveSftpArchiveConflict = async (
  sessionId: string,
  operationId: string,
  payload: ApiSftpArchiveConflictResolutionRequest,
): Promise<ApiSftpArchiveConflictResolutionResponse> => {
  return backendClient.resolveSftpArchiveConflict(sessionId, operationId, payload);
};

export const cancelSftpArchiveOperation = async (
  sessionId: string,
  operationId: string,
): Promise<ApiSftpArchiveCancelResponse> => {
  return backendClient.cancelSftpArchiveOperation(sessionId, operationId);
};

export const closeSftpSession = async (sessionId: string): Promise<{ success: boolean }> => {
  return backendClient.closeSftpSession(sessionId);
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

export const deleteSshKeychain = async (keychainId: string): Promise<{ success: boolean }> => {
  return backendClient.deleteSshKeychain(keychainId);
};

export const getMcpStatus = async (): Promise<ApiMcpStatusResponse> => {
  return backendClient.getMcpStatus();
};

export const rotateMcpPairingToken = async (): Promise<ApiMcpRotatePairingTokenResponse> => {
  return backendClient.rotateMcpPairingToken();
};

export const revokeMcpPairingToken = async (): Promise<{ success: boolean }> => {
  return backendClient.revokeMcpPairingToken();
};

export const listMcpClients = async (): Promise<ApiMcpListClientsResponse> => {
  return backendClient.listMcpClients();
};

export const listMcpConnections = async (): Promise<ApiMcpListConnectionsResponse> => {
  return backendClient.listMcpConnections();
};

export const closeMcpConnection = async (connectionId: string): Promise<{ success: boolean }> => {
  return backendClient.closeMcpConnection(connectionId);
};

export const listMcpApprovals = async (): Promise<ApiMcpListApprovalsResponse> => {
  return backendClient.listMcpApprovals();
};

export const resolveMcpApproval = async (
  approvalId: string,
  payload: ApiMcpResolveApprovalRequest,
): Promise<ApiMcpResolveApprovalResponse> => {
  return backendClient.resolveMcpApproval(approvalId, payload);
};

export const createMcpEventsChannel = async (): Promise<ApiMcpCreateEventsChannelResponse> => {
  return backendClient.createMcpEventsChannel();
};
