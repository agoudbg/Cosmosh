import {
  type ApiSettingsUpdateRequest,
  DEFAULT_SETTINGS_VALUES,
  normalizeSettingsValuesStrict,
  normalizeSettingsValuesWithDefaults,
  type SettingsScope,
  type SettingsValues,
  type SettingValidationError,
} from '@cosmosh/api-contract';

type SettingsUpdateRequest = ApiSettingsUpdateRequest;

const MAX_SCOPE_FIELD_LENGTH = 120;

/**
 * Default local settings scope used when caller does not provide explicit scope fields.
 */
export const DEFAULT_SETTINGS_SCOPE: SettingsScope = {
  deviceId: 'local-device',
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeScope = (scope: unknown): { value: SettingsScope; error?: string } => {
  if (!isRecord(scope)) {
    return { value: DEFAULT_SETTINGS_SCOPE };
  }

  const accountId = normalizeOptionalString(scope.accountId);
  const deviceId = normalizeOptionalString(scope.deviceId) ?? DEFAULT_SETTINGS_SCOPE.deviceId;

  if (accountId && accountId.length > MAX_SCOPE_FIELD_LENGTH) {
    return { value: DEFAULT_SETTINGS_SCOPE, error: 'scope.accountId must be 120 characters or fewer.' };
  }

  if (deviceId.length > MAX_SCOPE_FIELD_LENGTH) {
    return { value: DEFAULT_SETTINGS_SCOPE, error: 'scope.deviceId must be 120 characters or fewer.' };
  }

  return {
    value: {
      accountId,
      deviceId,
    },
  };
};

/**
 * Parses and validates settings update payload from API layer.
 */
export const parseSettingsUpdateRequest = (
  payload: unknown,
): { value?: SettingsUpdateRequest; error?: SettingValidationError } => {
  if (!isRecord(payload)) {
    return {
      error: {
        i18nKey: 'settings.validation.notObject',
        params: {},
        fallbackMessage: 'Request body must be a JSON object.',
      },
    };
  }

  const scopeResult = normalizeScope(payload.scope);
  if (scopeResult.error) {
    return {
      error: {
        i18nKey: 'settings.validation.invalid',
        params: { key: 'scope' },
        fallbackMessage: scopeResult.error,
      },
    };
  }

  const valuesResult = normalizeSettingsValuesStrict(payload.values);
  if (!valuesResult.value) {
    return {
      error: valuesResult.error ?? {
        i18nKey: 'settings.validation.invalid',
        params: { key: 'values' },
        fallbackMessage: 'Settings values are invalid.',
      },
    };
  }

  return {
    value: {
      scope: scopeResult.value,
      values: valuesResult.value,
    },
  };
};

/**
 * Parses persisted settings JSON with backward-compatible defaults fallback.
 */
export const parseStoredSettingsValues = (payloadJson: string | null | undefined): SettingsValues => {
  if (!payloadJson) {
    return { ...DEFAULT_SETTINGS_VALUES };
  }

  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return normalizeSettingsValuesWithDefaults(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS_VALUES };
  }
};

/**
 * Normalizes arbitrary scope input into validated settings scope.
 */
export const normalizeSettingsScopeInput = (scope: unknown): { value?: SettingsScope; error?: string } => {
  const result = normalizeScope(scope);
  if (result.error) {
    return { error: result.error };
  }

  return { value: result.value };
};
