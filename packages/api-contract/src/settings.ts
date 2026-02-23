/**
 * Settings validation — generic, registry-driven.
 *
 * All per-key rules (type, enum, range, maxLength) are derived from
 * SETTINGS_REGISTRY at runtime.  No manual switch/case per key is needed;
 * adding a setting to the registry automatically enables its validation.
 */

import type { SettingKey, SettingsValues } from './settings-registry';
import { DEFAULT_SETTINGS_VALUES, SETTINGS_DEFINITION_MAP, SETTINGS_REGISTRY } from './settings-registry';

export { DEFAULT_SETTINGS_VALUES };

// ── Structured Validation Error ──────────────────────────────

export type SettingValidationError = {
  /** i18n key for the localized error message template. */
  i18nKey: string;
  /** Parameters for ICU message interpolation. */
  params: Record<string, string | number>;
  /** Pre-formatted English fallback for contexts without i18n. */
  fallbackMessage: string;
};

const validationError = (
  i18nKey: string,
  params: Record<string, string | number>,
  fallbackMessage: string,
): SettingValidationError => ({
  i18nKey,
  params,
  fallbackMessage,
});

// ── Internal ─────────────────────────────────────────────────

const SETTINGS_KEYS: ReadonlyArray<SettingKey> = SETTINGS_REGISTRY.map((item) => item.key);
const SETTINGS_KEY_SET = new Set<string>(SETTINGS_KEYS as ReadonlyArray<string>);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

/**
 * Validate and parse a single setting value based on its registry definition.
 * Validation rules (type check, enum options, integer range, string maxLength)
 * are derived entirely from the definition — no per-key branching.
 *
 * Returns a structured error with i18n key, params, and English fallback.
 */
const parseSettingValue = (key: SettingKey, input: unknown): { value?: unknown; error?: SettingValidationError } => {
  const definition = SETTINGS_DEFINITION_MAP.get(key);
  if (!definition) {
    return {
      error: validationError(
        'settings.validation.unsupportedKey',
        { key: String(key) },
        `Unsupported setting key: ${String(key)}.`,
      ),
    };
  }

  // Use the nameI18nKey as the setting name param so consumers can resolve it.
  const nameKey = definition.nameI18nKey;

  switch (definition.valueType) {
    case 'boolean': {
      if (typeof input === 'boolean') {
        return { value: input };
      }

      return {
        error: validationError(
          'settings.validation.booleanRequired',
          { nameI18nKey: nameKey, key },
          `${key} must be a boolean.`,
        ),
      };
    }

    case 'number': {
      const parsed = typeof input === 'number' ? input : Number(input);
      const { min, max } = definition;

      if (!Number.isInteger(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
        if (min !== undefined && max !== undefined) {
          return {
            error: validationError(
              'settings.validation.integerRange',
              { nameI18nKey: nameKey, key, min, max },
              `${key} must be an integer between ${min} and ${max}.`,
            ),
          };
        }

        return {
          error: validationError(
            'settings.validation.integerRequired',
            { nameI18nKey: nameKey, key },
            `${key} must be an integer.`,
          ),
        };
      }

      return { value: parsed };
    }

    case 'string': {
      if (typeof input !== 'string') {
        return {
          error: validationError(
            'settings.validation.stringRequired',
            { nameI18nKey: nameKey, key },
            `${key} must be a string.`,
          ),
        };
      }

      // Enum validation: when options exist, only listed values are accepted.
      if (definition.options && definition.options.length > 0) {
        const allowed = definition.options.map((o) => o.value);
        if (!allowed.includes(input)) {
          return {
            error: validationError(
              'settings.validation.enumRequired',
              { nameI18nKey: nameKey, key, options: allowed.join(', ') },
              `${key} must be one of: ${allowed.join(', ')}.`,
            ),
          };
        }

        return { value: input };
      }

      // Free-text string: enforce maxLength from the definition (default 1000).
      const limit = definition.maxLength ?? 1000;
      if (input.length > limit) {
        return {
          error: validationError(
            'settings.validation.maxLengthExceeded',
            { nameI18nKey: nameKey, key, limit },
            `${key} must be ${limit} characters or fewer.`,
          ),
        };
      }

      return { value: input };
    }

    default:
      return {
        error: validationError(
          'settings.validation.unsupportedType',
          { key: String(key) },
          `Unsupported setting value type for key: ${String(key)}.`,
        ),
      };
  }
};

export const normalizeSettingsValuesStrict = (
  value: unknown,
): { value?: SettingsValues; error?: SettingValidationError } => {
  if (!isRecord(value)) {
    return {
      error: validationError(
        'settings.validation.notObject',
        {},
        'Settings values must be a JSON object.',
      ),
    };
  }

  const unknownKeys = Object.keys(value).filter((key) => !SETTINGS_KEY_SET.has(key));
  if (unknownKeys.length > 0) {
    return {
      error: validationError(
        'settings.validation.unknownKeys',
        { keys: unknownKeys.join(', ') },
        `Settings contain unknown keys: ${unknownKeys.join(', ')}.`,
      ),
    };
  }

  const result = { ...DEFAULT_SETTINGS_VALUES } as Record<SettingKey, unknown>;

  for (const key of SETTINGS_KEYS) {
    if (!(key in value)) {
      const def = SETTINGS_DEFINITION_MAP.get(key);
      return {
        error: validationError(
          'settings.validation.missingKey',
          { nameI18nKey: def?.nameI18nKey ?? key, key },
          `${key} is required.`,
        ),
      };
    }

    const parsed = parseSettingValue(key, value[key]);
    if (parsed.value === undefined) {
      return {
        error: parsed.error ?? validationError(
          'settings.validation.invalid',
          { key },
          `${key} is invalid.`,
        ),
      };
    }

    result[key] = parsed.value;
  }

  return { value: result as SettingsValues };
};

export const normalizeSettingsValuesWithDefaults = (value: unknown): SettingsValues => {
  if (!isRecord(value)) {
    return { ...DEFAULT_SETTINGS_VALUES };
  }

  const result = { ...DEFAULT_SETTINGS_VALUES } as Record<SettingKey, unknown>;

  for (const key of SETTINGS_KEYS) {
    if (!(key in value)) {
      continue;
    }

    const parsed = parseSettingValue(key, value[key]);
    if (parsed.value === undefined) {
      continue;
    }

    result[key] = parsed.value;
  }

  return result as SettingsValues;
};
