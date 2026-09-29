/**
 * Settings validation — generic, registry-driven.
 *
 * All per-key rules (type, enum, range, maxLength) are derived from
 * SETTINGS_REGISTRY at runtime.  No manual switch/case per key is needed;
 * adding a setting to the registry automatically enables its validation.
 */

import { validateProxyUrl } from './proxy';
import type { SettingKey, SettingsValues } from './settings-registry';
import { DEFAULT_SETTINGS_VALUES, SETTINGS_DEFINITION_MAP, SETTINGS_REGISTRY } from './settings-registry';
import {
  DEFAULT_SFTP_DIRECTORY_LIST_VIEW_SETTING,
  isSftpDirectoryListColumnId,
  SFTP_DIRECTORY_LIST_COLUMN_IDS,
  type SftpDirectoryListColumnId,
  type SftpDirectoryListColumnSetting,
  type SftpDirectoryListSortDirection,
  type SftpDirectoryListViewSetting,
} from './sftp';
import {
  TERMINAL_INLINE_IMAGE_BOOLEAN_OPTION_KEYS,
  TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS,
  TERMINAL_INLINE_IMAGE_OPTION_KEYS,
  type TerminalInlineImageOptions,
} from './terminal-inline-images';

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
const TERMINAL_INLINE_IMAGE_OPTION_KEY_SET = new Set<string>(
  TERMINAL_INLINE_IMAGE_OPTION_KEYS as ReadonlyArray<string>,
);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Clones the structured SFTP directory-list setting before storing or exposing it.
 *
 * @param value Valid SFTP directory-list view setting.
 * @returns A new object graph safe for caller-side mutation.
 */
const cloneSftpDirectoryListViewSetting = (value: SftpDirectoryListViewSetting): SftpDirectoryListViewSetting => ({
  version: 1,
  columns: value.columns.map((column) => ({
    id: column.id,
    visible: column.visible,
  })),
  sort: {
    field: value.sort.field,
    direction: value.sort.direction,
  },
});

/**
 * Clones terminal inline image options before storing or exposing them.
 *
 * @param value Valid terminal inline image options.
 * @returns Detached options object safe for caller-side mutation.
 */
const cloneTerminalInlineImageOptions = (value: TerminalInlineImageOptions): TerminalInlineImageOptions => ({
  enableSizeReports: value.enableSizeReports,
  pixelLimit: value.pixelLimit,
  sixelSupport: value.sixelSupport,
  sixelScrolling: value.sixelScrolling,
  sixelPaletteLimit: value.sixelPaletteLimit,
  sixelSizeLimit: value.sixelSizeLimit,
  storageLimit: value.storageLimit,
  showPlaceholder: value.showPlaceholder,
  iipSupport: value.iipSupport,
  iipSizeLimit: value.iipSizeLimit,
});

/**
 * Clones default settings that carry structured JSON values.
 *
 * @param key Setting key.
 * @param value Default setting value.
 * @returns Safe default value copy.
 */
const cloneSettingValue = (key: SettingKey, value: SettingsValues[SettingKey]): unknown => {
  if (key === 'sftpDirectoryListView') {
    return cloneSftpDirectoryListViewSetting(value as SftpDirectoryListViewSetting);
  }

  if (key === 'terminalInlineImageOptions') {
    return cloneTerminalInlineImageOptions(value as TerminalInlineImageOptions);
  }

  return value;
};

/**
 * Builds a settings record with JSON defaults detached from registry constants.
 *
 * @returns New settings record seeded with default values.
 */
const createDefaultSettingsRecord = (): Record<SettingKey, unknown> => {
  const result = {} as Record<SettingKey, unknown>;

  for (const key of SETTINGS_REGISTRY.map((item) => item.key)) {
    result[key] = cloneSettingValue(key, DEFAULT_SETTINGS_VALUES[key]);
  }

  return result;
};

/**
 * Checks whether a user-provided time zone can be used with Intl formatting.
 *
 * @param value Candidate IANA time zone or the `system` sentinel.
 * @returns Whether the candidate is supported by the current runtime.
 */
const isSupportedTimeZoneSetting = (value: string): boolean => {
  const normalizedValue = value.trim();
  if (normalizedValue === 'system') {
    return true;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalizedValue });
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates and normalizes the terminal inline image JSON setting.
 *
 * @param key Setting key used in error messages.
 * @param nameKey Setting title i18n key.
 * @param input Raw JSON value.
 * @returns Parsed options or a validation error.
 */
const parseTerminalInlineImageOptionsSetting = (
  key: SettingKey,
  nameKey: string,
  input: unknown,
): { value?: TerminalInlineImageOptions; error?: SettingValidationError } => {
  const invalid = (fallbackDetail: string): { error: SettingValidationError } => ({
    error: validationError(
      'settings.validation.invalid',
      { nameI18nKey: nameKey, key },
      `${key} must be valid terminal inline image options. ${fallbackDetail}`,
    ),
  });

  if (!isRecord(input)) {
    return invalid('Expected a JSON object.');
  }

  const unknownKeys = Object.keys(input).filter((optionKey) => !TERMINAL_INLINE_IMAGE_OPTION_KEY_SET.has(optionKey));
  if (unknownKeys.length > 0) {
    return invalid(`Unknown option keys: ${unknownKeys.join(', ')}.`);
  }

  for (const optionKey of TERMINAL_INLINE_IMAGE_OPTION_KEYS) {
    if (!(optionKey in input)) {
      return invalid(`Missing required option: ${optionKey}.`);
    }
  }

  for (const optionKey of TERMINAL_INLINE_IMAGE_BOOLEAN_OPTION_KEYS) {
    if (typeof input[optionKey] !== 'boolean') {
      return invalid(`${optionKey} must be a boolean.`);
    }
  }

  for (const [optionKey, limits] of Object.entries(TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS)) {
    const rawValue = input[optionKey];
    if (
      typeof rawValue !== 'number' ||
      !Number.isInteger(rawValue) ||
      rawValue < limits.minimum ||
      rawValue > limits.maximum
    ) {
      return invalid(`${optionKey} must be an integer between ${limits.minimum} and ${limits.maximum}.`);
    }
  }

  const parsed: TerminalInlineImageOptions = {
    enableSizeReports: input.enableSizeReports as boolean,
    pixelLimit: input.pixelLimit as number,
    sixelSupport: input.sixelSupport as boolean,
    sixelScrolling: input.sixelScrolling as boolean,
    sixelPaletteLimit: input.sixelPaletteLimit as number,
    sixelSizeLimit: input.sixelSizeLimit as number,
    storageLimit: input.storageLimit as number,
    showPlaceholder: input.showPlaceholder as boolean,
    iipSupport: input.iipSupport as boolean,
    iipSizeLimit: input.iipSizeLimit as number,
  };

  return { value: parsed };
};
/**
 * Validates and normalizes the SFTP directory-list JSON setting.
 *
 * @param key Setting key used in error messages.
 * @param nameKey Setting title i18n key.
 * @param input Raw JSON value.
 * @returns Parsed view setting or a validation error.
 */
const parseSftpDirectoryListViewSetting = (
  key: SettingKey,
  nameKey: string,
  input: unknown,
): { value?: SftpDirectoryListViewSetting; error?: SettingValidationError } => {
  const invalid = (fallbackDetail: string): { error: SettingValidationError } => ({
    error: validationError(
      'settings.validation.invalid',
      { nameI18nKey: nameKey, key },
      `${key} must be a valid SFTP directory-list view setting. ${fallbackDetail}`,
    ),
  });

  if (!isRecord(input)) {
    return invalid('Expected a JSON object.');
  }

  if (input.version !== 1) {
    return invalid('Expected version 1.');
  }

  if (!Array.isArray(input.columns)) {
    return invalid('Expected a columns array.');
  }

  const defaultColumnsById = new Map<SftpDirectoryListColumnId, SftpDirectoryListColumnSetting>(
    DEFAULT_SFTP_DIRECTORY_LIST_VIEW_SETTING.columns.map((column) => [column.id, column]),
  );
  const seenColumnIds = new Set<SftpDirectoryListColumnId>();
  const parsedColumns: SftpDirectoryListColumnSetting[] = [];

  for (const rawColumn of input.columns) {
    if (!isRecord(rawColumn)) {
      return invalid('Every column entry must be an object.');
    }

    const { id, visible } = rawColumn;
    if (!isSftpDirectoryListColumnId(id) || typeof visible !== 'boolean') {
      return invalid('Every column entry must include a supported id and boolean visible flag.');
    }

    if (seenColumnIds.has(id)) {
      return invalid(`Duplicate column id: ${id}.`);
    }

    if (id === 'name' && !visible) {
      return invalid('The name column must stay visible.');
    }

    seenColumnIds.add(id);
    parsedColumns.push({ id, visible });
  }

  for (const columnId of SFTP_DIRECTORY_LIST_COLUMN_IDS) {
    if (!seenColumnIds.has(columnId)) {
      const defaultColumn = defaultColumnsById.get(columnId);
      parsedColumns.push({
        id: columnId,
        visible: defaultColumn?.visible ?? false,
      });
    }
  }

  if (!isRecord(input.sort)) {
    return invalid('Expected a sort object.');
  }

  const sortField = input.sort.field;
  const sortDirection = input.sort.direction;
  if (!isSftpDirectoryListColumnId(sortField) || (sortDirection !== 'asc' && sortDirection !== 'desc')) {
    return invalid('Sort must include a supported field and asc/desc direction.');
  }

  return {
    value: {
      version: 1,
      columns: parsedColumns,
      sort: {
        field: sortField,
        direction: sortDirection as SftpDirectoryListSortDirection,
      },
    },
  };
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

      if (key === 'dateTimeTimeZone') {
        const normalizedInput = input.trim();
        if (!isSupportedTimeZoneSetting(normalizedInput)) {
          return {
            error: validationError(
              'settings.validation.timeZoneUnsupported',
              { nameI18nKey: nameKey, key },
              `${key} must be "system" or a supported IANA time zone.`,
            ),
          };
        }

        return { value: normalizedInput };
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

    case 'json': {
      if (key === 'sftpDirectoryListView') {
        return parseSftpDirectoryListViewSetting(key, nameKey, input);
      }

      if (key === 'terminalInlineImageOptions') {
        return parseTerminalInlineImageOptionsSetting(key, nameKey, input);
      }

      return {
        error: validationError(
          'settings.validation.unsupportedType',
          { key: String(key) },
          `Unsupported JSON setting key: ${String(key)}.`,
        ),
      };
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
      error: validationError('settings.validation.notObject', {}, 'Settings values must be a JSON object.'),
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

  const result = createDefaultSettingsRecord();

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
        error: parsed.error ?? validationError('settings.validation.invalid', { key }, `${key} is invalid.`),
      };
    }

    result[key] = parsed.value;
  }

  if (result.serverProxyMode === 'custom') {
    const proxyUrlResult = validateProxyUrl(result.serverProxyUrl);
    if (!proxyUrlResult.valid) {
      return {
        error: validationError(
          'settings.validation.proxyUrlInvalid',
          { key: 'serverProxyUrl' },
          'serverProxyUrl must be a valid http, https, or socks5 proxy URL when custom proxy mode is selected.',
        ),
      };
    }

    result.serverProxyUrl = proxyUrlResult.normalizedUrl;
  }

  return { value: result as SettingsValues };
};

/**
 * Reads stored or cached settings with current defaults and explicit legacy opt-outs preserved.
 * @param value Untrusted settings object. @returns Valid current settings, without retired keys.
 */
export const normalizeSettingsValuesWithDefaults = (value: unknown): SettingsValues => {
  if (!isRecord(value)) {
    return createDefaultSettingsRecord() as SettingsValues;
  }

  const result = createDefaultSettingsRecord();

  // A saved opt-out must survive the new manual default. An explicit malformed mode stays off;
  // only a valid new mode can supersede the old switch. New writes use the strict current schema.
  if ('terminalNativeCompletionMode' in value) {
    result.terminalNativeCompletionMode = 'off';
  } else if ('terminalNativeCompletionEnabled' in value) {
    result.terminalNativeCompletionMode = value.terminalNativeCompletionEnabled === true ? 'manual' : 'off';
  }

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
