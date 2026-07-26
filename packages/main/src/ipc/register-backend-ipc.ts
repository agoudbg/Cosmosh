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
import { API_CODES, API_PATHS, appendApiQueryParams, replaceApiPathToken } from '@cosmosh/api-contract';
import { ipcMain } from 'electron';

import type { SftpDownloadTargetAuthorizationRegistry } from './sftp-download-target-authorizations';
import {
  authorizeSftpTaskStartRequest,
  observeSftpTaskForDownloadAuthorization,
  settleRejectedSftpTaskStart,
} from './sftp-task-download-authorizations';

/**
 * Runtime dependencies required by backend IPC registration.
 */
export type RegisterBackendIpcHandlersOptions = {
  /**
   * Generic backend request adapter used by most channels.
   * Keeps channel implementation focused on route/payload mapping.
   */
  requestBackend: <TSuccess>(
    path: string,
    options: {
      method: 'DELETE' | 'GET' | 'POST' | 'PUT';
      body?: unknown;
    },
  ) => Promise<TSuccess | ApiErrorResponse>;
  /** Generic backend request adapter for status-sensitive calls such as DELETE. */
  requestBackendRaw: (
    path: string,
    options: {
      method: 'DELETE';
    },
  ) => Promise<{ status: number }>;
  /** Returns and clears one-shot launch working directory context. */
  consumePendingLaunchWorkingDirectory: () => string | null;
  /** Validates renderer-owned local paths before proxying SFTP downloads. */
  sftpDownloadTargetAuthorizations: SftpDownloadTargetAuthorizationRegistry;
};

/**
 * Sends an authenticated backend DELETE request and maps HTTP 204 to success flag.
 */
const requestBackendDeleteSuccess = async (
  options: RegisterBackendIpcHandlersOptions,
  path: string,
): Promise<{ success: boolean }> => {
  try {
    const response = await options.requestBackendRaw(path, {
      method: 'DELETE',
    });

    return {
      success: response.status === 204,
    };
  } catch {
    return {
      success: false,
    };
  }
};

/**
 * Registers a DELETE-based backend IPC handler that maps HTTP 204 to success response.
 *
 * @param options Backend runtime dependencies.
 * @param channel IPC channel name.
 * @param pathTemplate API path template containing one route parameter.
 * @param token Path token name in template.
 * @returns void.
 */
const registerDeleteHandler = (
  options: RegisterBackendIpcHandlersOptions,
  channel: string,
  pathTemplate: string,
  token: string,
): void => {
  ipcMain.handle(channel, async (_event, tokenValue: string): Promise<{ success: boolean }> => {
    const path = replaceApiPathToken(pathTemplate, token, tokenValue);
    return requestBackendDeleteSuccess(options, path);
  });
};

/**
 * Registers all backend-related IPC handlers (settings/SSH/local terminal).
 */
export const registerBackendIpcHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  // Settings, SSH, and local terminal channels share API_PATHS contract from api-contract package.
  registerBackendSshAndSettingsHandlers(options);
  registerBackendLocalTerminalHandlers(options);
  registerBackendMcpHandlers(options);
};

/**
 * Registers SSH/settings handlers backed by backend HTTP API.
 */
const registerBackendSshAndSettingsHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  ipcMain.handle('backend:test-ping', async (): Promise<ApiTestPingResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiTestPingResponse>(API_PATHS.testPing, {
      method: 'GET',
    });
  });

  ipcMain.handle('backend:settings-get', async (): Promise<ApiSettingsGetResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSettingsGetResponse>(API_PATHS.settingsGet, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:settings-update',
    async (_event, payload: ApiSettingsUpdateRequest): Promise<ApiSettingsUpdateResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSettingsUpdateResponse>(API_PATHS.settingsUpdate, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:audit-list-events',
    async (_event, query?: ApiAuditEventListQuery): Promise<ApiAuditEventListResponse | ApiErrorResponse> => {
      const path = appendApiQueryParams(API_PATHS.auditListEvents, query);
      return options.requestBackend<ApiAuditEventListResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:audit-get-event-by-id',
    async (_event, eventId: string): Promise<ApiAuditEventDetailResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.auditGetEventById, 'eventId', eventId);
      return options.requestBackend<ApiAuditEventDetailResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle('backend:ssh-list-servers', async (): Promise<ApiSshListServersResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListServersResponse>(API_PATHS.sshListServers, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-server',
    async (_event, payload: ApiSshCreateServerRequest): Promise<ApiSshCreateServerResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateServerResponse>(API_PATHS.sshCreateServer, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-update-server',
    async (
      _event,
      serverId: string,
      payload: ApiSshUpdateServerRequest,
    ): Promise<ApiSshUpdateServerResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sshUpdateServer, 'serverId', serverId);
      return options.requestBackend<ApiSshUpdateServerResponse>(path, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-get-server-credentials',
    async (_event, serverId: string): Promise<ApiSshGetServerCredentialsResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sshGetServerCredentials, 'serverId', serverId);
      return options.requestBackend<ApiSshGetServerCredentialsResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle('backend:ssh-list-folders', async (): Promise<ApiSshListFoldersResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListFoldersResponse>(API_PATHS.sshListFolders, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-folder',
    async (_event, payload: ApiSshCreateFolderRequest): Promise<ApiSshCreateFolderResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateFolderResponse>(API_PATHS.sshCreateFolder, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-update-folder',
    async (
      _event,
      folderId: string,
      payload: ApiSshUpdateFolderRequest,
    ): Promise<ApiSshUpdateFolderResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sshUpdateFolder, 'folderId', folderId);
      return options.requestBackend<ApiSshUpdateFolderResponse>(path, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle('backend:ssh-list-tags', async (): Promise<ApiSshListTagsResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListTagsResponse>(API_PATHS.sshListTags, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-tag',
    async (_event, payload: ApiSshCreateTagRequest): Promise<ApiSshCreateTagResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateTagResponse>(API_PATHS.sshCreateTag, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle('backend:ssh-list-keychains', async (): Promise<ApiSshListKeychainsResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiSshListKeychainsResponse>(API_PATHS.sshListKeychains, { method: 'GET' });
  });

  ipcMain.handle(
    'backend:ssh-create-keychain',
    async (_event, payload: ApiSshCreateKeychainRequest): Promise<ApiSshCreateKeychainResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshCreateKeychainResponse>(API_PATHS.sshCreateKeychain, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-update-keychain',
    async (
      _event,
      keychainId: string,
      payload: ApiSshUpdateKeychainRequest,
    ): Promise<ApiSshUpdateKeychainResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sshUpdateKeychain, 'keychainId', keychainId);
      return options.requestBackend<ApiSshUpdateKeychainResponse>(path, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-get-keychain-credentials',
    async (_event, keychainId: string): Promise<ApiSshGetKeychainCredentialsResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sshGetKeychainCredentials, 'keychainId', keychainId);
      return options.requestBackend<ApiSshGetKeychainCredentialsResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:ssh-create-session',
    async (
      _event,
      payload: ApiSshCreateSessionRequest,
    ): Promise<
      ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    > => {
      return options.requestBackend<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse>(
        API_PATHS.sshCreateSession,
        {
          method: 'POST',
          body: payload,
        },
      );
    },
  );

  ipcMain.handle(
    'backend:ssh-trust-fingerprint',
    async (
      _event,
      payload: ApiSshTrustFingerprintRequest,
    ): Promise<ApiSshTrustFingerprintResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiSshTrustFingerprintResponse>(API_PATHS.sshTrustFingerprint, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-create-session',
    async (
      _event,
      payload: ApiSftpCreateSessionRequest,
    ): Promise<
      ApiSftpCreateSessionResponse | ApiSftpCreateSessionHostVerificationRequiredResponse | ApiErrorResponse
    > => {
      return options.requestBackend<
        ApiSftpCreateSessionResponse | ApiSftpCreateSessionHostVerificationRequiredResponse
      >(API_PATHS.sftpCreateSession, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-list-directory',
    async (
      _event,
      sessionId: string,
      query?: ApiSftpListDirectoryQuery,
    ): Promise<ApiSftpListDirectoryResponse | ApiErrorResponse> => {
      const pathTemplate = replaceApiPathToken(API_PATHS.sftpListDirectory, 'sessionId', sessionId);
      const path = appendApiQueryParams(pathTemplate, query);
      return options.requestBackend<ApiSftpListDirectoryResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-get-entry-details',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpEntryDetailsRequest,
    ): Promise<ApiSftpEntryDetailsResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpGetEntryDetails, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpEntryDetailsResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-read-file',
    async (
      _event,
      sessionId: string,
      query: ApiSftpReadFileQuery,
    ): Promise<ApiSftpReadFileResponse | ApiErrorResponse> => {
      const pathTemplate = replaceApiPathToken(API_PATHS.sftpReadFile, 'sessionId', sessionId);
      const path = appendApiQueryParams(pathTemplate, query);
      return options.requestBackend<ApiSftpReadFileResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-write-file',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpWriteFileRequest,
    ): Promise<ApiSftpWriteFileResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpWriteFile, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpWriteFileResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-download-file',
    async (
      event,
      sessionId: string,
      payload: ApiSftpDownloadFileRequest,
    ): Promise<ApiSftpDownloadFileResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpDownloadFile, 'sessionId', sessionId);
      const ownerWebContentsId = event.sender.id;
      const localPath = payload.transferId
        ? options.sftpDownloadTargetAuthorizations.consumeForTransfer(
            ownerWebContentsId,
            payload.localPath,
            payload.transferId,
          )
        : options.sftpDownloadTargetAuthorizations.consume(ownerWebContentsId, payload.localPath);

      try {
        const response = await options.requestBackend<ApiSftpDownloadFileResponse>(path, {
          method: 'POST',
          body: {
            ...payload,
            localPath,
          },
        });
        if (payload.transferId) {
          if (response.code === API_CODES.sftpSessionNotFound) {
            options.sftpDownloadTargetAuthorizations.allowTransferRetry(ownerWebContentsId, payload.transferId);
          } else {
            options.sftpDownloadTargetAuthorizations.completeTransfer(ownerWebContentsId, payload.transferId);
          }
        }
        return response;
      } catch (error: unknown) {
        if (payload.transferId) {
          options.sftpDownloadTargetAuthorizations.completeTransfer(ownerWebContentsId, payload.transferId);
        }
        throw error;
      }
    },
  );

  ipcMain.handle(
    'backend:sftp-upload-file',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpUploadFileRequest,
    ): Promise<ApiSftpUploadFileResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpUploadFile, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpUploadFileResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-get-transfer-progress',
    async (_event, transferId: string): Promise<ApiSftpTransferProgressResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpGetTransferProgress, 'transferId', transferId);
      return options.requestBackend<ApiSftpTransferProgressResponse>(path, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-create-directory',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpCreateDirectoryRequest,
    ): Promise<ApiSftpCreateDirectoryResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpCreateDirectory, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpCreateDirectoryResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-create-file',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpCreateFileRequest,
    ): Promise<ApiSftpCreateFileResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpCreateFile, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpCreateFileResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-rename-entry',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpRenameRequest,
    ): Promise<ApiSftpRenameResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpRenameEntry, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpRenameResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-copy-entry',
    async (_event, sessionId: string, payload: ApiSftpCopyRequest): Promise<ApiSftpCopyResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpCopyEntry, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpCopyResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-delete-entry',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpDeleteRequest,
    ): Promise<ApiSftpDeleteResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpDeleteEntry, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpDeleteResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-batch-operation',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpBatchOperationRequest,
    ): Promise<ApiSftpBatchOperationResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpBatchOperation, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpBatchOperationResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:sftp-start-task',
    async (
      event,
      sessionId: string,
      payload: ApiSftpStartTaskRequest,
    ): Promise<ApiSftpStartTaskResponse | ApiErrorResponse> => {
      const ownerWebContentsId = event.sender.id;
      const authorizedPayload = authorizeSftpTaskStartRequest(
        options.sftpDownloadTargetAuthorizations,
        ownerWebContentsId,
        payload,
      );
      const path = replaceApiPathToken(API_PATHS.sftpStartTask, 'sessionId', sessionId);

      try {
        const response = await options.requestBackend<ApiSftpStartTaskResponse>(path, {
          method: 'POST',
          body: authorizedPayload,
        });
        if (!response.success) {
          settleRejectedSftpTaskStart(
            options.sftpDownloadTargetAuthorizations,
            ownerWebContentsId,
            authorizedPayload,
            response,
          );
        }
        return response;
      } catch (error: unknown) {
        if (authorizedPayload.operation === 'download') {
          options.sftpDownloadTargetAuthorizations.completeTransfer(
            ownerWebContentsId,
            authorizedPayload.payload.transferId,
          );
        }
        throw error;
      }
    },
  );

  ipcMain.handle(
    'backend:sftp-list-tasks',
    async (event, sessionId: string): Promise<ApiSftpListTasksResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpListTasks, 'sessionId', sessionId);
      const response = await options.requestBackend<ApiSftpListTasksResponse>(path, { method: 'GET' });
      if (response.success) {
        response.data.items.forEach((task) => {
          observeSftpTaskForDownloadAuthorization(options.sftpDownloadTargetAuthorizations, event.sender.id, task);
        });
      }
      return response;
    },
  );

  ipcMain.handle(
    'backend:sftp-get-task',
    async (event, sessionId: string, taskId: string): Promise<ApiSftpGetTaskResponse | ApiErrorResponse> => {
      const sessionPath = replaceApiPathToken(API_PATHS.sftpGetTask, 'sessionId', sessionId);
      const path = replaceApiPathToken(sessionPath, 'taskId', taskId);
      const response = await options.requestBackend<ApiSftpGetTaskResponse>(path, { method: 'GET' });
      if (response.success) {
        observeSftpTaskForDownloadAuthorization(
          options.sftpDownloadTargetAuthorizations,
          event.sender.id,
          response.data,
        );
      }
      return response;
    },
  );

  ipcMain.handle(
    'backend:sftp-get-archive-capabilities',
    async (_event, sessionId: string): Promise<ApiSftpArchiveCapabilitiesResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpGetArchiveCapabilities, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpArchiveCapabilitiesResponse>(path, { method: 'GET' });
    },
  );

  ipcMain.handle(
    'backend:sftp-start-archive-operation',
    async (
      _event,
      sessionId: string,
      payload: ApiSftpArchiveOperationRequest,
    ): Promise<ApiSftpArchiveOperationAcceptedResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.sftpStartArchiveOperation, 'sessionId', sessionId);
      return options.requestBackend<ApiSftpArchiveOperationAcceptedResponse>(path, { method: 'POST', body: payload });
    },
  );

  ipcMain.handle(
    'backend:sftp-get-archive-operation',
    async (
      _event,
      sessionId: string,
      operationId: string,
    ): Promise<ApiSftpArchiveOperationStatusResponse | ApiErrorResponse> => {
      const sessionPath = replaceApiPathToken(API_PATHS.sftpGetArchiveOperation, 'sessionId', sessionId);
      const path = replaceApiPathToken(sessionPath, 'operationId', operationId);
      return options.requestBackend<ApiSftpArchiveOperationStatusResponse>(path, { method: 'GET' });
    },
  );

  ipcMain.handle(
    'backend:sftp-resolve-archive-conflict',
    async (
      _event,
      sessionId: string,
      operationId: string,
      payload: ApiSftpArchiveConflictResolutionRequest,
    ): Promise<ApiSftpArchiveConflictResolutionResponse | ApiErrorResponse> => {
      const sessionPath = replaceApiPathToken(API_PATHS.sftpResolveArchiveConflict, 'sessionId', sessionId);
      const path = replaceApiPathToken(sessionPath, 'operationId', operationId);
      return options.requestBackend<ApiSftpArchiveConflictResolutionResponse>(path, { method: 'POST', body: payload });
    },
  );

  ipcMain.handle(
    'backend:sftp-cancel-archive-operation',
    async (
      _event,
      sessionId: string,
      operationId: string,
    ): Promise<ApiSftpArchiveCancelResponse | ApiErrorResponse> => {
      const sessionPath = replaceApiPathToken(API_PATHS.sftpCancelArchiveOperation, 'sessionId', sessionId);
      const path = replaceApiPathToken(sessionPath, 'operationId', operationId);
      return options.requestBackend<ApiSftpArchiveCancelResponse>(path, { method: 'DELETE' });
    },
  );

  registerDeleteHandler(options, 'backend:ssh-close-session', API_PATHS.sshCloseSession, 'sessionId');
  registerDeleteHandler(options, 'backend:sftp-close-session', API_PATHS.sftpCloseSession, 'sessionId');
  registerDeleteHandler(options, 'backend:ssh-delete-server', API_PATHS.sshDeleteServer, 'serverId');
  registerDeleteHandler(options, 'backend:ssh-delete-folder', API_PATHS.sshDeleteFolder, 'folderId');
  registerDeleteHandler(options, 'backend:ssh-delete-keychain', API_PATHS.sshDeleteKeychain, 'keychainId');

  ipcMain.handle(
    'backend:port-forward-list-rules',
    async (): Promise<ApiPortForwardListRulesResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiPortForwardListRulesResponse>(API_PATHS.portForwardListRules, { method: 'GET' });
    },
  );

  ipcMain.handle(
    'backend:port-forward-create-rule',
    async (
      _event,
      payload: ApiPortForwardCreateRuleRequest,
    ): Promise<ApiPortForwardCreateRuleResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiPortForwardCreateRuleResponse>(API_PATHS.portForwardCreateRule, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:port-forward-update-rule',
    async (
      _event,
      ruleId: string,
      payload: ApiPortForwardUpdateRuleRequest,
    ): Promise<ApiPortForwardUpdateRuleResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.portForwardUpdateRule, 'ruleId', ruleId);
      return options.requestBackend<ApiPortForwardUpdateRuleResponse>(path, {
        method: 'PUT',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:port-forward-start-rule',
    async (
      _event,
      ruleId: string,
      payload: ApiPortForwardStartRuleRequest,
    ): Promise<ApiPortForwardStartRuleResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.portForwardStartRule, 'ruleId', ruleId);
      return options.requestBackend<ApiPortForwardStartRuleResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:port-forward-stop-rule',
    async (_event, ruleId: string): Promise<ApiPortForwardStopRuleResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.portForwardStopRule, 'ruleId', ruleId);
      return options.requestBackend<ApiPortForwardStopRuleResponse>(path, {
        method: 'POST',
      });
    },
  );

  registerDeleteHandler(options, 'backend:port-forward-delete-rule', API_PATHS.portForwardDeleteRule, 'ruleId');
};

/**
 * Registers local terminal handlers backed by backend HTTP API.
 */
const registerBackendLocalTerminalHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  ipcMain.handle(
    'backend:local-terminal-list-profiles',
    async (): Promise<ApiLocalTerminalListProfilesResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiLocalTerminalListProfilesResponse>(API_PATHS.localTerminalListProfiles, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:local-terminal-create-session',
    async (
      _event,
      payload: ApiLocalTerminalCreateSessionRequest,
    ): Promise<ApiLocalTerminalCreateSessionResponse | ApiErrorResponse> => {
      const launchWorkingDirectory = options.consumePendingLaunchWorkingDirectory();
      return options.requestBackend<ApiLocalTerminalCreateSessionResponse>(API_PATHS.localTerminalCreateSession, {
        method: 'POST',
        body: {
          ...payload,
          ...(launchWorkingDirectory ? { cwd: launchWorkingDirectory } : {}),
        },
      });
    },
  );

  ipcMain.handle(
    'backend:local-terminal-close-session',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      const path = replaceApiPathToken(API_PATHS.localTerminalCloseSession, 'sessionId', sessionId);
      return requestBackendDeleteSuccess(options, path);
    },
  );
};

/**
 * Registers MCP management handlers backed by the authenticated backend HTTP API.
 *
 * These proxy the renderer authorization UI and MCP panel; the externally-reachable
 * `/mcp` endpoint has independent Bearer auth and is never exposed over IPC.
 *
 * @param options Backend runtime dependencies.
 */
const registerBackendMcpHandlers = (options: RegisterBackendIpcHandlersOptions): void => {
  ipcMain.handle('backend:mcp-get-status', async (): Promise<ApiMcpStatusResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiMcpStatusResponse>(API_PATHS.mcpGetStatus, {
      method: 'GET',
    });
  });

  ipcMain.handle(
    'backend:mcp-rotate-pairing-token',
    async (): Promise<ApiMcpRotatePairingTokenResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiMcpRotatePairingTokenResponse>(API_PATHS.mcpRotatePairingToken, {
        method: 'POST',
      });
    },
  );

  ipcMain.handle('backend:mcp-revoke-pairing-token', async (): Promise<{ success: boolean }> => {
    return requestBackendDeleteSuccess(options, API_PATHS.mcpRevokePairingToken);
  });

  ipcMain.handle('backend:mcp-list-clients', async (): Promise<ApiMcpListClientsResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiMcpListClientsResponse>(API_PATHS.mcpListClients, {
      method: 'GET',
    });
  });

  ipcMain.handle(
    'backend:mcp-list-connections',
    async (): Promise<ApiMcpListConnectionsResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiMcpListConnectionsResponse>(API_PATHS.mcpListConnections, {
        method: 'GET',
      });
    },
  );

  ipcMain.handle(
    'backend:mcp-close-connection',
    async (_event, connectionId: string): Promise<{ success: boolean }> => {
      const path = replaceApiPathToken(API_PATHS.mcpCloseConnection, 'connectionId', connectionId);
      return requestBackendDeleteSuccess(options, path);
    },
  );

  ipcMain.handle('backend:mcp-list-approvals', async (): Promise<ApiMcpListApprovalsResponse | ApiErrorResponse> => {
    return options.requestBackend<ApiMcpListApprovalsResponse>(API_PATHS.mcpListApprovals, {
      method: 'GET',
    });
  });

  ipcMain.handle(
    'backend:mcp-resolve-approval',
    async (
      _event,
      approvalId: string,
      payload: ApiMcpResolveApprovalRequest,
    ): Promise<ApiMcpResolveApprovalResponse | ApiErrorResponse> => {
      const path = replaceApiPathToken(API_PATHS.mcpResolveApproval, 'approvalId', approvalId);
      return options.requestBackend<ApiMcpResolveApprovalResponse>(path, {
        method: 'POST',
        body: payload,
      });
    },
  );

  ipcMain.handle(
    'backend:mcp-create-events-channel',
    async (): Promise<ApiMcpCreateEventsChannelResponse | ApiErrorResponse> => {
      return options.requestBackend<ApiMcpCreateEventsChannelResponse>(API_PATHS.mcpCreateEventsChannel, {
        method: 'POST',
      });
    },
  );
};
