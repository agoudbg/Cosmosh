import crypto from 'node:crypto';

import {
  API_CODES,
  API_PATHS,
  type ApiSettingsGetResponse,
  type ApiSettingsUpdateResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';
import type { Hono } from 'hono';

import {
  DEFAULT_SETTINGS_SCOPE,
  parseSettingsUpdateRequest,
  parseStoredSettingsValues,
} from '../../settings/validation.js';
import { buildErrorPayload } from '../errors.js';
import type { BackendAppContext } from '../types.js';

const toScopeColumns = (scope: {
  accountId?: string;
  deviceId: string;
}): { scopeAccountId: string; scopeDeviceId: string } => {
  return {
    scopeAccountId: scope.accountId ?? '',
    scopeDeviceId: scope.deviceId,
  };
};

const toScopePayload = (scopeAccountId: string, scopeDeviceId: string): { accountId?: string; deviceId: string } => {
  return {
    accountId: scopeAccountId.length > 0 ? scopeAccountId : undefined,
    deviceId: scopeDeviceId,
  };
};

type AppSettingsRow = {
  scopeAccountId: string;
  scopeDeviceId: string;
  payloadJson: string;
  revision: number;
  updatedAt: Date | string;
};

const findSettingsRow = async (
  context: BackendAppContext,
  scopeColumns: { scopeAccountId: string; scopeDeviceId: string },
): Promise<AppSettingsRow | null> => {
  const db = context.getDbClient();
  const rows = await db.$queryRaw<AppSettingsRow[]>`
    SELECT "scopeAccountId", "scopeDeviceId", "payloadJson", "revision", "updatedAt"
    FROM "AppSettings"
    WHERE "scopeAccountId" = ${scopeColumns.scopeAccountId}
      AND "scopeDeviceId" = ${scopeColumns.scopeDeviceId}
    LIMIT 1
  `;

  return rows[0] ?? null;
};

const toIsoTimestamp = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
};

export const registerSettingsRoutes = (app: Hono, context: BackendAppContext): void => {
  app.get(API_PATHS.settingsGet, async (c) => {
    const scopeColumns = toScopeColumns(DEFAULT_SETTINGS_SCOPE);
    const row = await findSettingsRow(context, scopeColumns);

    const payload: ApiSettingsGetResponse = createApiSuccess({
      code: API_CODES.settingsGetOk,
      message: 'Settings fetched successfully.',
      data: {
        item: {
          scope: toScopePayload(scopeColumns.scopeAccountId, scopeColumns.scopeDeviceId),
          revision: row?.revision ?? 0,
          updatedAt: row ? toIsoTimestamp(row.updatedAt) : new Date().toISOString(),
          values: parseStoredSettingsValues(row?.payloadJson),
        },
      },
    });

    return c.json(payload);
  });

  app.put(API_PATHS.settingsUpdate, async (c) => {
    const parsed = parseSettingsUpdateRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(API_CODES.settingsValidationFailed, parsed.error ?? 'Invalid settings request payload.'),
        400,
      );
    }

    const scopeColumns = toScopeColumns(parsed.value.scope ?? DEFAULT_SETTINGS_SCOPE);
    const payloadJson = JSON.stringify(parsed.value.values);
    const db = context.getDbClient();

    await db.$executeRaw`
      INSERT INTO "AppSettings" (
        "id",
        "scopeAccountId",
        "scopeDeviceId",
        "payloadJson",
        "revision",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${crypto.randomUUID()},
        ${scopeColumns.scopeAccountId},
        ${scopeColumns.scopeDeviceId},
        ${payloadJson},
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT("scopeAccountId", "scopeDeviceId") DO UPDATE SET
        "payloadJson" = excluded."payloadJson",
        "revision" = "AppSettings"."revision" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    `;

    const row = await findSettingsRow(context, scopeColumns);

    if (!row) {
      return c.json(buildErrorPayload(API_CODES.settingsValidationFailed, 'Settings row was not persisted.'), 400);
    }

    const payload: ApiSettingsUpdateResponse = createApiSuccess({
      code: API_CODES.settingsUpdateOk,
      message: 'Settings updated successfully.',
      data: {
        item: {
          scope: toScopePayload(row.scopeAccountId, row.scopeDeviceId),
          revision: row.revision,
          updatedAt: toIsoTimestamp(row.updatedAt),
          values: parseStoredSettingsValues(row.payloadJson),
        },
      },
    });

    return c.json(payload);
  });
};
