export type { components, operations, paths } from './generated';
export { createApiError, createApiSuccess } from './envelope';
export { appendApiQueryParams, replaceApiPathToken, resolveApiPath } from './http';
export type { ApiPathParams, ApiQueryParams } from './http';
export { APP_MENU_ACTIONS, isAppMenuAction } from './ipc';
export type {
  AppCloseConfirmationRequest,
  AppCloseConfirmationResponse,
  AppMenuAction,
  BackendRequestTrace,
  BackendRequestTraceBody,
  BackendRequestTraceBodyKind,
  BackendRequestTraceMethod,
  SystemProxyResolveRequest,
  SystemProxyResolveResult,
  SftpOpenWithApplication,
  SftpDroppedUploadLocalEntry,
  SftpTemporaryFileWatchChange,
  SftpUploadFileSelection,
  SftpUploadLocalFile,
  SftpUploadRejectedLocalEntry,
  SftpUploadRejectedLocalEntryReason,
} from './ipc';
export {
  DEFAULT_MCP_COMMAND_POLICY,
  DEFAULT_MCP_SERVER_COMMAND_POLICY,
  isMcpApprovalUserDecision,
  isMcpCommandPolicy,
  isMcpServerCommandPolicy,
  MCP_COMMAND_POLICY_OPTIONS,
  MCP_SERVER_COMMAND_POLICY_OPTIONS,
  parseMcpEventMessage,
  resolveEffectiveMcpCommandPolicy,
} from './mcp';
export type {
  McpApprovalDecision,
  McpApprovalKind,
  McpApprovalUserDecision,
  McpClientInfo,
  McpClientSessionSummary,
  McpCommandPolicy,
  McpConnectionCloseReason,
  McpConnectionSummary,
  McpEventMessage,
  McpPendingApprovalPayload,
  McpRuntimeStatus,
  McpServerCommandPolicy,
} from './mcp';
export {
  GLOBAL_SERVER_PROXY_MODES,
  MAX_PROXY_URL_LENGTH,
  MAX_SYSTEM_PROXY_RULES_LENGTH,
  SSH_SERVER_PROXY_MODES,
  SUPPORTED_PROXY_PROTOCOLS,
  isGlobalServerProxyMode,
  isSshServerProxyMode,
  validateProxyUrl,
} from './proxy';
export type {
  GlobalServerProxyMode,
  ProxyUrlValidationResult,
  SshServerProxyMode,
  SupportedProxyProtocol,
} from './proxy';
export { API_CAPABILITIES, API_CODES, API_HEADERS, API_PATHS } from './protocol';
export {
  DEFAULT_SETTINGS_VALUES,
  normalizeSettingsValuesStrict,
  normalizeSettingsValuesWithDefaults,
} from './settings';
export type { SettingValidationError } from './settings';
export {
  DEFAULT_SFTP_AUXILIARY_SIDEBAR_MODE,
  DEFAULT_SFTP_DIRECTORY_LIST_VIEW_SETTING,
  DEFAULT_SFTP_IMAGE_PREVIEW_WARNING_THRESHOLD_BYTES,
  DEFAULT_SFTP_TEXT_PREVIEW_WARNING_THRESHOLD_BYTES,
  MAX_SFTP_IMAGE_PREVIEW_WARNING_THRESHOLD_BYTES,
  MAX_SFTP_TEXT_PREVIEW_WARNING_THRESHOLD_BYTES,
  SFTP_AUXILIARY_SIDEBAR_MODES,
  SFTP_DIRECTORY_LIST_COLUMN_IDS,
  compareSftpEntriesByBrowserOrder,
  compareSftpEntryNames,
  compareSftpNames,
  isSftpDirectoryListColumnId,
  sortSftpEntriesByBrowserOrder,
} from './sftp';
export type {
  SftpAuxiliarySidebarMode,
  SftpDirectoryListColumnId,
  SftpDirectoryListColumnSetting,
  SftpDirectoryListSortDirection,
  SftpDirectoryListSortSetting,
  SftpDirectoryListViewSetting,
  SftpNamedItem,
  SftpSortableEntry,
} from './sftp';
export {
  getVisibleCategories,
  paginateSettingsByCategory,
  resolveCategoryId,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_IDS,
  SETTINGS_DEFINITION_MAP,
  SETTINGS_REGISTRY,
} from './settings-registry';
export type {
  SettingDefinition,
  SettingKey,
  SettingsCategory,
  SettingsCategoryId,
  SettingsJsonSchemaNode,
  SettingsSection,
  SettingsValues,
} from './settings-registry';
export {
  DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
  isTerminalClipboardAccess,
  TERMINAL_CLIPBOARD_ACCESS_OPTIONS,
} from './terminal-clipboard';
export type { TerminalClipboardAccess } from './terminal-clipboard';
export {
  DEFAULT_TERMINAL_FORCE_SELECTION_MODIFIER,
  DEFAULT_TERMINAL_RIGHT_CLICK_ACTION,
  TERMINAL_FORCE_SELECTION_MODIFIER_OPTIONS,
  TERMINAL_RIGHT_CLICK_ACTION_OPTIONS,
} from './terminal-interaction';
export type { TerminalForceSelectionModifier, TerminalRightClickAction } from './terminal-interaction';
export {
  REMOTE_SHELL_CAPABILITIES,
  REMOTE_SHELL_EVENT_NAMES,
  REMOTE_SHELL_NAMES,
  REMOTE_SHELL_PROTOCOL_VERSION,
} from './terminal-protocol';
export type {
  RemoteBootstrapPhase,
  RemoteBootstrapState,
  RemoteBootstrapStatus,
  RemoteEnhancementRuntimeStatus,
  RemoteShellCapability,
  RemoteShellEventMessage,
  RemoteShellEventName,
  RemoteShellName,
  SshTerminalServerMessage,
  TerminalClientMessage,
  TerminalCompletionItem,
  TerminalServerMessage,
} from './terminal-protocol';
export {
  DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS,
  MAX_TERMINAL_INLINE_IMAGE_PIXEL_LIMIT,
  MAX_TERMINAL_INLINE_IMAGE_SEQUENCE_LIMIT,
  MAX_TERMINAL_INLINE_IMAGE_SIXEL_PALETTE_LIMIT,
  MAX_TERMINAL_INLINE_IMAGE_STORAGE_LIMIT_MB,
  TERMINAL_INLINE_IMAGE_BOOLEAN_OPTION_KEYS,
  TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS,
  TERMINAL_INLINE_IMAGE_OPTION_KEYS,
} from './terminal-inline-images';
export type { TerminalInlineImageOptions } from './terminal-inline-images';

import type { components, paths } from './generated';
import type { SettingsValues } from './settings-registry';

// ── Settings API types ───────────────────────────────────────
// Hand-crafted with strict SettingsValues from the registry.
// The OpenAPI SettingsValues schema is intentionally loose;
// these types provide compile-time safety the generated ones cannot.

type SettingsScope = components['schemas']['SettingsScope'];
export type { SettingsScope };

export interface SettingsResource {
  scope: SettingsScope;
  revision: number;
  updatedAt: string;
  values: SettingsValues;
}

interface ApiSuccessBase {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
}

export type ApiSettingsGetResponse = ApiSuccessBase & {
  data: { item: SettingsResource };
};

export type ApiSettingsUpdateRequest = {
  scope?: SettingsScope;
  values: SettingsValues;
};

export type ApiSettingsUpdateResponse = ApiSuccessBase & {
  data: { item: SettingsResource };
};

// ── Non-settings API types (generated) ───────────────────────

export type ApiErrorResponse = components['schemas']['ApiError'];
export type ApiTestPingResponse = paths['/api/v1/test/ping']['get']['responses']['200']['content']['application/json'];
export type ApiRuntimeActiveConnectionsData = components['schemas']['RuntimeActiveConnectionsData'];
export type ApiRuntimeActiveConnectionsGetResponse =
  paths['/api/v1/runtime/active-connections']['get']['responses']['200']['content']['application/json'];
export type ApiRuntimeActiveConnectionsCloseResponse =
  paths['/api/v1/runtime/active-connections']['delete']['responses']['200']['content']['application/json'];
export type ApiAuditEventListQuery = paths['/api/v1/audit/events']['get']['parameters']['query'];
export type ApiAuditEventListResponse =
  paths['/api/v1/audit/events']['get']['responses']['200']['content']['application/json'];
export type ApiAuditEventDetailResponse =
  paths['/api/v1/audit/events/{eventId}']['get']['responses']['200']['content']['application/json'];
export type ApiSshListServersResponse =
  paths['/api/v1/ssh/servers']['get']['responses']['200']['content']['application/json'];
export type ApiSshCreateServerRequest =
  paths['/api/v1/ssh/servers']['post']['requestBody']['content']['application/json'];
export type ApiSshCreateServerResponse =
  paths['/api/v1/ssh/servers']['post']['responses']['200']['content']['application/json'];
export type ApiSshUpdateServerRequest =
  paths['/api/v1/ssh/servers/{serverId}']['put']['requestBody']['content']['application/json'];
export type ApiSshUpdateServerResponse =
  paths['/api/v1/ssh/servers/{serverId}']['put']['responses']['200']['content']['application/json'];
export type ApiSshGetServerCredentialsResponse =
  paths['/api/v1/ssh/servers/{serverId}/credentials']['get']['responses']['200']['content']['application/json'];
export type ApiSshListKeychainsResponse =
  paths['/api/v1/ssh/keychains']['get']['responses']['200']['content']['application/json'];
export type ApiSshCreateKeychainRequest =
  paths['/api/v1/ssh/keychains']['post']['requestBody']['content']['application/json'];
export type ApiSshCreateKeychainResponse =
  paths['/api/v1/ssh/keychains']['post']['responses']['200']['content']['application/json'];
export type ApiSshUpdateKeychainRequest =
  paths['/api/v1/ssh/keychains/{keychainId}']['put']['requestBody']['content']['application/json'];
export type ApiSshUpdateKeychainResponse =
  paths['/api/v1/ssh/keychains/{keychainId}']['put']['responses']['200']['content']['application/json'];
export type ApiSshGetKeychainCredentialsResponse =
  paths['/api/v1/ssh/keychains/{keychainId}/credentials']['get']['responses']['200']['content']['application/json'];
export type ApiSshListFoldersResponse =
  paths['/api/v1/ssh/folders']['get']['responses']['200']['content']['application/json'];
export type ApiSshCreateFolderRequest =
  paths['/api/v1/ssh/folders']['post']['requestBody']['content']['application/json'];
export type ApiSshCreateFolderResponse =
  paths['/api/v1/ssh/folders']['post']['responses']['200']['content']['application/json'];
export type ApiSshUpdateFolderRequest =
  paths['/api/v1/ssh/folders/{folderId}']['put']['requestBody']['content']['application/json'];
export type ApiSshUpdateFolderResponse =
  paths['/api/v1/ssh/folders/{folderId}']['put']['responses']['200']['content']['application/json'];
export type ApiSshListTagsResponse =
  paths['/api/v1/ssh/tags']['get']['responses']['200']['content']['application/json'];
export type ApiSshCreateTagRequest = paths['/api/v1/ssh/tags']['post']['requestBody']['content']['application/json'];
export type ApiSshCreateTagResponse =
  paths['/api/v1/ssh/tags']['post']['responses']['200']['content']['application/json'];
export type ApiSshCreateSessionRequest =
  paths['/api/v1/ssh/sessions']['post']['requestBody']['content']['application/json'];
export type ApiSshCreateSessionResponse =
  paths['/api/v1/ssh/sessions']['post']['responses']['200']['content']['application/json'];
export type ApiSshCreateSessionHostVerificationRequiredResponse =
  paths['/api/v1/ssh/sessions']['post']['responses']['409']['content']['application/json'];
export type ApiSshTrustFingerprintRequest =
  paths['/api/v1/ssh/trusted-host-keys']['post']['requestBody']['content']['application/json'];
export type ApiSshTrustFingerprintResponse =
  paths['/api/v1/ssh/trusted-host-keys']['post']['responses']['200']['content']['application/json'];
export type ApiSshCloseSessionRequest = paths['/api/v1/ssh/sessions/{sessionId}']['delete']['parameters']['path'];
export type ApiPortForwardListRulesResponse =
  paths['/api/v1/port-forwards/rules']['get']['responses']['200']['content']['application/json'];
export type ApiPortForwardCreateRuleRequest =
  paths['/api/v1/port-forwards/rules']['post']['requestBody']['content']['application/json'];
export type ApiPortForwardCreateRuleResponse =
  paths['/api/v1/port-forwards/rules']['post']['responses']['200']['content']['application/json'];
export type ApiPortForwardUpdateRuleRequest =
  paths['/api/v1/port-forwards/rules/{ruleId}']['put']['requestBody']['content']['application/json'];
export type ApiPortForwardUpdateRuleResponse =
  paths['/api/v1/port-forwards/rules/{ruleId}']['put']['responses']['200']['content']['application/json'];
export type ApiPortForwardStartRuleRequest =
  paths['/api/v1/port-forwards/rules/{ruleId}/start']['post']['requestBody']['content']['application/json'];
export type ApiPortForwardStartRuleResponse =
  | paths['/api/v1/port-forwards/rules/{ruleId}/start']['post']['responses']['200']['content']['application/json']
  | paths['/api/v1/port-forwards/rules/{ruleId}/start']['post']['responses']['409']['content']['application/json'];
export type ApiPortForwardStopRuleResponse =
  paths['/api/v1/port-forwards/rules/{ruleId}/stop']['post']['responses']['200']['content']['application/json'];
export type ApiSftpCreateSessionRequest =
  paths['/api/v1/sftp/sessions']['post']['requestBody']['content']['application/json'];
export type ApiSftpCreateSessionResponse =
  paths['/api/v1/sftp/sessions']['post']['responses']['200']['content']['application/json'];
export type ApiSftpCreateSessionHostVerificationRequiredResponse =
  paths['/api/v1/sftp/sessions']['post']['responses']['409']['content']['application/json'];
export type ApiSftpListDirectoryQuery =
  paths['/api/v1/sftp/sessions/{sessionId}/entries']['get']['parameters']['query'];
export type ApiSftpListDirectoryResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/entries']['get']['responses']['200']['content']['application/json'];
export type ApiSftpEntryDetailsRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/entries/details']['post']['requestBody']['content']['application/json'];
export type ApiSftpEntryDetailsResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/entries/details']['post']['responses']['200']['content']['application/json'];
export type ApiSftpReadFileQuery = paths['/api/v1/sftp/sessions/{sessionId}/file']['get']['parameters']['query'];
export type ApiSftpReadFileResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/file']['get']['responses']['200']['content']['application/json'];
export type ApiSftpWriteFileRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/file']['post']['requestBody']['content']['application/json'];
export type ApiSftpWriteFileResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/file']['post']['responses']['200']['content']['application/json'];
export type ApiSftpDownloadFileRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/download']['post']['requestBody']['content']['application/json'];
export type ApiSftpDownloadFileResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/download']['post']['responses']['200']['content']['application/json'];
export type ApiSftpUploadFileRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/upload']['post']['requestBody']['content']['application/json'];
export type ApiSftpUploadFileResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/upload']['post']['responses']['200']['content']['application/json'];
export type ApiSftpTransferProgressResponse =
  paths['/api/v1/sftp/transfers/{transferId}']['get']['responses']['200']['content']['application/json'];
export type ApiSftpCreateDirectoryRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/directories']['post']['requestBody']['content']['application/json'];
export type ApiSftpCreateDirectoryResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/directories']['post']['responses']['200']['content']['application/json'];
export type ApiSftpCreateFileRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/files']['post']['requestBody']['content']['application/json'];
export type ApiSftpCreateFileResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/files']['post']['responses']['200']['content']['application/json'];
export type ApiSftpRenameRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/rename']['post']['requestBody']['content']['application/json'];
export type ApiSftpRenameResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/rename']['post']['responses']['200']['content']['application/json'];
export type ApiSftpCopyRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/copy']['post']['requestBody']['content']['application/json'];
export type ApiSftpCopyResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/copy']['post']['responses']['200']['content']['application/json'];
export type ApiSftpDeleteRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/entries/delete']['post']['requestBody']['content']['application/json'];
export type ApiSftpDeleteResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/entries/delete']['post']['responses']['200']['content']['application/json'];
export type ApiSftpBatchOperationRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/batch']['post']['requestBody']['content']['application/json'];
export type ApiSftpBatchOperationResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/batch']['post']['responses']['200']['content']['application/json'];
export type ApiSftpBatchOperationItem = components['schemas']['SftpBatchOperationItemResult'];
export type ApiSftpTaskOperationType = components['schemas']['SftpTaskOperationType'];
export type ApiSftpTaskState = components['schemas']['SftpTaskState'];
export type ApiSftpTaskErrorCode = components['schemas']['SftpTaskErrorCode'];
export type ApiSftpTaskTransferReference = components['schemas']['SftpTaskTransferReference'];
export type ApiSftpTaskCreateFileDescriptor = components['schemas']['SftpTaskCreateFileDescriptor'];
export type ApiSftpTaskCreateDirectoryDescriptor = components['schemas']['SftpTaskCreateDirectoryDescriptor'];
export type ApiSftpTaskRenameDescriptor = components['schemas']['SftpTaskRenameDescriptor'];
export type ApiSftpTaskUploadDescriptor = components['schemas']['SftpTaskUploadDescriptor'];
export type ApiSftpTaskDownloadDescriptor = components['schemas']['SftpTaskDownloadDescriptor'];
export type ApiSftpTaskBatchDescriptor = components['schemas']['SftpTaskBatchDescriptor'];
export type ApiSftpTaskOperationResult = components['schemas']['SftpTaskOperationResult'];
export type ApiSftpTaskDownloadResult = components['schemas']['SftpTaskDownloadResult'];
export type ApiSftpTaskBatchResult = components['schemas']['SftpTaskBatchResult'];
export type ApiSftpTaskResult = components['schemas']['SftpTaskResult'];
export type ApiSftpTaskData = components['schemas']['SftpTaskData'];
export type ApiSftpTaskListData = components['schemas']['SftpTaskListData'];
export type ApiSftpStartTaskRequest =
  paths['/api/v1/sftp/sessions/{sessionId}/tasks']['post']['requestBody']['content']['application/json'];
export type ApiSftpStartTaskResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/tasks']['post']['responses']['202']['content']['application/json'];
export type ApiSftpListTasksResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/tasks']['get']['responses']['200']['content']['application/json'];
export type ApiSftpGetTaskResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/tasks/{taskId}']['get']['responses']['200']['content']['application/json'];
export type ApiSftpArchiveFormat = components['schemas']['SftpArchiveFormat'];
export type ApiSftpArchiveCompressionLevel = components['schemas']['SftpArchiveCompressionLevel'];
export type ApiSftpArchiveDestinationMode = components['schemas']['SftpArchiveDestinationMode'];
export type ApiSftpArchiveErrorCode = components['schemas']['SftpArchiveErrorCode'];
export type ApiSftpArchiveConflictResolution = components['schemas']['SftpArchiveConflictResolution'];
export type ApiSftpArchiveOperationState = components['schemas']['SftpArchiveOperationState'];
export type ApiSftpArchiveOperationStage = components['schemas']['SftpArchiveOperationStage'];
export type ApiSftpArchiveCompressRequest = components['schemas']['SftpArchiveCompressRequest'];
export type ApiSftpArchiveExtractRequest = components['schemas']['SftpArchiveExtractRequest'];
export type ApiSftpArchiveOperationRequest = components['schemas']['SftpArchiveOperationRequest'];
export type ApiSftpArchiveConflictResolutionRequest = components['schemas']['SftpArchiveConflictResolutionRequest'];
export type ApiSftpArchiveConflict = components['schemas']['SftpArchiveConflict'];
export type ApiSftpArchiveCapabilitiesData = components['schemas']['SftpArchiveCapabilitiesData'];
export type ApiSftpArchiveOperationData = components['schemas']['SftpArchiveOperationData'];
export type ApiSftpArchiveCapabilitiesResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/archive-capabilities']['get']['responses']['200']['content']['application/json'];
export type ApiSftpArchiveOperationAcceptedResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/archive-operations']['post']['responses']['202']['content']['application/json'];
export type ApiSftpArchiveOperationStatusResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/archive-operations/{operationId}']['get']['responses']['200']['content']['application/json'];
export type ApiSftpArchiveConflictResolutionResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/archive-operations/{operationId}/conflict-resolution']['post']['responses']['200']['content']['application/json'];
export type ApiSftpArchiveCancelResponse =
  paths['/api/v1/sftp/sessions/{sessionId}/archive-operations/{operationId}']['delete']['responses']['202']['content']['application/json'];
export type ApiSftpCloseSessionRequest = paths['/api/v1/sftp/sessions/{sessionId}']['delete']['parameters']['path'];
export type ApiSftpEntry = components['schemas']['SftpEntry'];
export type ApiSftpEntryDetailsItem = components['schemas']['SftpEntryDetailsItem'];
export type ApiSftpEntryType = components['schemas']['SftpEntryType'];
export type ApiSftpSymlinkTarget = components['schemas']['SftpSymlinkTarget'];
export type ApiLocalTerminalProfile = components['schemas']['LocalTerminalProfile'];
export type ApiLocalTerminalListProfilesResponse =
  paths['/api/v1/local-terminals/profiles']['get']['responses']['200']['content']['application/json'];
export type ApiLocalTerminalCreateSessionRequest =
  paths['/api/v1/local-terminals/sessions']['post']['requestBody']['content']['application/json'];
export type ApiLocalTerminalCreateSessionResponse =
  paths['/api/v1/local-terminals/sessions']['post']['responses']['200']['content']['application/json'];
export type ApiLocalTerminalCloseSessionRequest =
  paths['/api/v1/local-terminals/sessions/{sessionId}']['delete']['parameters']['path'];
export type ApiMcpStatusResponse =
  paths['/api/v1/mcp/status']['get']['responses']['200']['content']['application/json'];
export type ApiMcpRotatePairingTokenResponse =
  paths['/api/v1/mcp/pairing-token']['post']['responses']['200']['content']['application/json'];
export type ApiMcpListClientsResponse =
  paths['/api/v1/mcp/clients']['get']['responses']['200']['content']['application/json'];
export type ApiMcpListConnectionsResponse =
  paths['/api/v1/mcp/connections']['get']['responses']['200']['content']['application/json'];
export type ApiMcpCloseConnectionRequest =
  paths['/api/v1/mcp/connections/{connectionId}']['delete']['parameters']['path'];
export type ApiMcpListApprovalsResponse =
  paths['/api/v1/mcp/approvals']['get']['responses']['200']['content']['application/json'];
export type ApiMcpResolveApprovalRequest =
  paths['/api/v1/mcp/approvals/{approvalId}/decision']['post']['requestBody']['content']['application/json'];
export type ApiMcpResolveApprovalResponse =
  paths['/api/v1/mcp/approvals/{approvalId}/decision']['post']['responses']['200']['content']['application/json'];
export type ApiMcpCreateEventsChannelResponse =
  paths['/api/v1/mcp/events-channel']['post']['responses']['200']['content']['application/json'];
export type ApiMcpStatusData = components['schemas']['McpStatusData'];
export type ApiMcpClientSession = components['schemas']['McpClientSession'];
export type ApiMcpConnectionSummary = components['schemas']['McpConnectionSummary'];
export type ApiMcpPendingApproval = components['schemas']['McpPendingApproval'];
