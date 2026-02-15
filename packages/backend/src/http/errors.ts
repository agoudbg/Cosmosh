import { type ApiErrorResponse, createApiError } from '@cosmosh/api-contract';

export const buildErrorPayload = (code: ApiErrorResponse['code'], message: string): ApiErrorResponse => {
  return createApiError({ code, message });
};
