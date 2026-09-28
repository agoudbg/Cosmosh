import type { SettingsValues } from '@cosmosh/api-contract';
import type { PrismaClient } from '@prisma/client';

import { DEFAULT_SETTINGS_SCOPE, parseStoredSettingsValues } from './validation.js';

/** Flat AppSettings unique-key columns for one settings scope. */
export type SettingsScopeColumns = {
  scopeAccountId: string;
  scopeDeviceId: string;
};

/** Raw AppSettings row shape loaded by SQL readers. */
export type AppSettingsRow = {
  scopeAccountId: string;
  scopeDeviceId: string;
  payloadJson: string;
  revision: number;
  updatedAt: Date | string;
};

/**
 * Converts API scope object into flat DB key columns.
 *
 * @param scope Settings scope from the API contract.
 * @returns Columns used by the AppSettings unique key.
 */
export const toSettingsScopeColumns = (scope: { accountId?: string; deviceId: string }): SettingsScopeColumns => {
  return {
    scopeAccountId: scope.accountId ?? '',
    scopeDeviceId: scope.deviceId,
  };
};

/**
 * Converts DB scope columns back into API response shape.
 *
 * @param scopeAccountId Persisted account scope column.
 * @param scopeDeviceId Persisted device scope column.
 * @returns API scope payload.
 */
export const toSettingsScopePayload = (
  scopeAccountId: string,
  scopeDeviceId: string,
): { accountId?: string; deviceId: string } => {
  return {
    accountId: scopeAccountId.length > 0 ? scopeAccountId : undefined,
    deviceId: scopeDeviceId,
  };
};

/**
 * Loads one settings row for a specific scope.
 *
 * @param db Prisma client used for the read.
 * @param scopeColumns AppSettings unique-key columns.
 * @returns Persisted settings row or null.
 */
export const findSettingsRow = async (
  db: PrismaClient,
  scopeColumns: SettingsScopeColumns,
): Promise<AppSettingsRow | null> => {
  const rows = await db.$queryRaw<AppSettingsRow[]>`
    SELECT "scopeAccountId", "scopeDeviceId", "payloadJson", "revision", "updatedAt"
    FROM "AppSettings"
    WHERE "scopeAccountId" = ${scopeColumns.scopeAccountId}
      AND "scopeDeviceId" = ${scopeColumns.scopeDeviceId}
    LIMIT 1
  `;

  return rows[0] ?? null;
};

/**
 * Reads default-scope application settings with registry defaults filled in.
 *
 * @param db Prisma client used for the read.
 * @returns Normalized default-scope settings values.
 */
export const readDefaultSettingsValues = async (db: PrismaClient): Promise<SettingsValues> => {
  return (await readDefaultSettingsSnapshot(db)).values;
};

/** Persisted settings revision paired with its normalized values for async race checks. */
export type DefaultSettingsSnapshot = { values: SettingsValues; revision: number };

/**
 * Reads values and revision together so a late read cannot restore an earlier permission.
 * @param db Prisma client used for the read.
 * @returns Current default-scope settings snapshot.
 */
export const readDefaultSettingsSnapshot = async (db: PrismaClient): Promise<DefaultSettingsSnapshot> => {
  const scopeColumns = toSettingsScopeColumns(DEFAULT_SETTINGS_SCOPE);
  const row = await findSettingsRow(db, scopeColumns);
  return { values: parseStoredSettingsValues(row?.payloadJson), revision: row?.revision ?? 0 };
};
