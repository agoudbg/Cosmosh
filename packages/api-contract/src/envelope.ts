import { randomUUID } from 'node:crypto';

import type { ApiErrorResponse } from './index';

type MetaInput = {
  message: string;
  requestId?: string;
  timestamp?: string;
};

const createMeta = ({ message, requestId, timestamp }: MetaInput) => {
  return {
    message,
    requestId: requestId ?? randomUUID(),
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
