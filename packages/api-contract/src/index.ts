export type { components, operations, paths } from './generated';
export { createApiError, createApiSuccess } from './envelope';
export { API_CAPABILITIES, API_CODES, API_HEADERS, API_PATHS } from './protocol';

import type { components, paths } from './generated';

export type ApiErrorResponse = components['schemas']['ApiError'];
export type ApiTestPingResponse = paths['/api/v1/test/ping']['get']['responses']['200']['content']['application/json'];
export type ApiSettingsGetResponse =
	paths['/api/v1/settings']['get']['responses']['200']['content']['application/json'];
export type ApiSettingsUpdateRequest =
	paths['/api/v1/settings']['put']['requestBody']['content']['application/json'];
export type ApiSettingsUpdateResponse =
	paths['/api/v1/settings']['put']['responses']['200']['content']['application/json'];
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
export type ApiSshListTagsResponse = paths['/api/v1/ssh/tags']['get']['responses']['200']['content']['application/json'];
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
