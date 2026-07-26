import crypto from 'node:crypto';

import {
  API_CODES,
  API_PATHS,
  type ApiSettingsGetResponse,
  type ApiSettingsUpdateResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';

import { findSettingsRow, toSettingsScopeColumns, toSettingsScopePayload } from '../../settings/read.js';
import {
  DEFAULT_SETTINGS_SCOPE,
  parseSettingsUpdateRequest,
  parseStoredSettingsValues,
} from '../../settings/validation.js';
import { buildErrorPayload } from '../errors.js';
import { type BackendHttpApp, getTranslator } from '../i18n.js';
import type { BackendAppContext } from '../types.js';

/**
 * Normalizes Date/string values to ISO timestamp in responses.
 */
const toIsoTimestamp = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
};

/**
 * Returns changed settings keys without exposing any setting values.
 */
const collectChangedSettingKeys = (previousValues: object, nextValues: object): string[] => {
  const changedKeys: string[] = [];

  const previousRecord = previousValues as Record<string, unknown>;
  const nextRecord = nextValues as Record<string, unknown>;

  for (const [key, nextValue] of Object.entries(nextRecord)) {
    const previousSerialized = JSON.stringify(previousRecord[key]);
    const nextSerialized = JSON.stringify(nextValue);
    if (previousSerialized !== nextSerialized) {
      changedKeys.push(key);
    }
  }

  return changedKeys.sort();
};

/**
 * Registers settings read/update routes.
 */
export const registerSettingsRoutes = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.get(API_PATHS.settingsGet, async (c) => {
    const t = getTranslator(c);
    const db = context.getDbClient();
    const scopeColumns = toSettingsScopeColumns(DEFAULT_SETTINGS_SCOPE);
    const row = await findSettingsRow(db, scopeColumns);

    const payload: ApiSettingsGetResponse = createApiSuccess({
      code: API_CODES.settingsGetOk,
      message: t('success.settings.fetched'),
      data: {
        item: {
          scope: toSettingsScopePayload(scopeColumns.scopeAccountId, scopeColumns.scopeDeviceId),
          revision: row?.revision ?? 0,
          updatedAt: row ? toIsoTimestamp(row.updatedAt) : new Date().toISOString(),
          values: parseStoredSettingsValues(row?.payloadJson),
        },
      },
    });

    return c.json(payload);
  });

  app.put(API_PATHS.settingsUpdate, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const parsed = parseSettingsUpdateRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.settingsValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.settings.invalidRequestPayload'),
        ),
        400,
      );
    }

    const scopeColumns = toSettingsScopeColumns(parsed.value.scope ?? DEFAULT_SETTINGS_SCOPE);
    const payloadJson = JSON.stringify(parsed.value.values);
    const db = context.getDbClient();
    const previousRow = await findSettingsRow(db, scopeColumns);
    const previousValues = parseStoredSettingsValues(previousRow?.payloadJson);
    const changedKeys = collectChangedSettingKeys(previousValues, parsed.value.values);

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

    const row = await findSettingsRow(db, scopeColumns);

    if (!row) {
      return c.json(buildErrorPayload(API_CODES.settingsValidationFailed, t('errors.settings.rowNotPersisted')), 400);
    }

    const payload: ApiSettingsUpdateResponse = createApiSuccess({
      code: API_CODES.settingsUpdateOk,
      message: t('success.settings.updated'),
      requestId,
      data: {
        item: {
          scope: toSettingsScopePayload(row.scopeAccountId, row.scopeDeviceId),
          revision: row.revision,
          updatedAt: toIsoTimestamp(row.updatedAt),
          values: parseStoredSettingsValues(row.payloadJson),
        },
      },
    });

    void context.auditEventService.logEvent({
      category: 'settings',
      action: 'update',
      outcome: 'success',
      severity: changedKeys.length > 0 ? 'warning' : 'info',
      entityType: 'app-settings',
      entityId: `${row.scopeAccountId}:${row.scopeDeviceId}`,
      requestId,
      metadata: {
        changedKeys,
        changedCount: changedKeys.length,
        revision: row.revision,
      },
    });

    // Re-apply the MCP enabled gate whenever the toggle changes so the endpoint,
    // events socket, and discovery file follow the persisted setting immediately.
    if (changedKeys.includes('mcpEnabled')) {
      await context.mcpService.refreshEnabledState().catch((error: unknown) => {
        console.error('[settings][MCP] Failed to refresh MCP enabled state.', error);
      });
    }

    return c.json(payload);
  });
};
