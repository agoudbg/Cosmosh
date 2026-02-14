import type { ApiErrorResponse } from './index';

type MetaInput = {
  message: string;
  requestId?: string;
  timestamp?: string;
};

const createRequestId = () => {
  const runtimeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (typeof runtimeCrypto?.randomUUID === 'function') {
    return runtimeCrypto.randomUUID();
  }

  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const createMeta = ({ message, requestId, timestamp }: MetaInput) => {
  return {
    message,
    requestId: requestId ?? createRequestId(),
    timestamp: timestamp ?? new Date().toISOString(),
  };
};

export const createApiError = ({
  code,
  message,
  requestId,
  timestamp,
}: MetaInput & { code: ApiErrorResponse['code'] }): ApiErrorResponse => {
  return {
    success: false,
    code,
    ...createMeta({ message, requestId, timestamp }),
  };
};

export const createApiSuccess = <TCode extends string, TData>({
  code,
  data,
  message,
  requestId,
  timestamp,
}: MetaInput & {
  code: TCode;
  data: TData;
}): {
  success: true;
  code: TCode;
  message: string;
  requestId: string;
  timestamp: string;
  data: TData;
} => {
  return {
    success: true,
    code,
    ...createMeta({ message, requestId, timestamp }),
    data,
  };
};
