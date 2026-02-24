import { type ApiErrorResponse, createApiError } from '@cosmosh/api-contract';

/**
 * Builds normalized API error payloads for route-level error responses.
 */
export const buildErrorPayload = (code: ApiErrorResponse['code'], message: string): ApiErrorResponse => {
  return createApiError({ code, message });
};
