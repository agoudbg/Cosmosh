export type { components, operations, paths } from './generated';
export { createApiError, createApiSuccess } from './envelope';
export { API_CAPABILITIES, API_CODES, API_HEADERS, API_PATHS } from './protocol';

import type { components, paths } from './generated';

export type ApiErrorResponse = components['schemas']['ApiError'];
export type ApiTestPingResponse = paths['/api/v1/test/ping']['get']['responses']['200']['content']['application/json'];
