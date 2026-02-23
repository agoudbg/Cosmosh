import type { components, paths } from '@cosmosh/api-contract';

type SettingsScope = components['schemas']['SettingsScope'];
type SettingsValues = components['schemas']['SettingsValues'];
type SettingsUpdateRequest = paths['/api/v1/settings']['put']['requestBody']['content']['application/json'];

const MAX_SCOPE_FIELD_LENGTH = 120;

export const DEFAULT_SETTINGS_SCOPE: SettingsScope = {
  deviceId: 'local-device',
};

export const DEFAULT_SETTINGS_VALUES: SettingsValues = {
  language: 'en',
  theme: 'dark',
  sshMaxRows: 10000,
  sshConnectionTimeoutSec: 45,
  autoSaveEnabled: true,
  accountSyncEnabled: false,
  defaultServerNoteTemplate: '',
  terminalSelectionBarEnabled: true,
  terminalTextDropMode: 'external',
  terminalSelectionSearchEngine: 'google',
  terminalSelectionSearchUrlTemplate: '',
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

const normalizeSettingsValues = (value: unknown): { value?: SettingsValues; error?: string } => {
  if (!isRecord(value)) {
    return { error: 'values must be a JSON object.' };
  }

  const language = value.language;
  if (language !== 'en' && language !== 'zh-CN') {
    return { error: 'values.language must be one of: en, zh-CN.' };
  }

  const theme = value.theme;
  if (theme !== 'dark' && theme !== 'light' && theme !== 'auto') {
    return { error: 'values.theme must be one of: dark, light, auto.' };
  }

  const sshMaxRows = typeof value.sshMaxRows === 'number' ? value.sshMaxRows : Number(value.sshMaxRows);
  if (!Number.isInteger(sshMaxRows) || sshMaxRows < 100 || sshMaxRows > 200000) {
    return { error: 'values.sshMaxRows must be an integer between 100 and 200000.' };
  }

  const sshConnectionTimeoutSec =
    typeof value.sshConnectionTimeoutSec === 'number'
      ? value.sshConnectionTimeoutSec
      : Number(value.sshConnectionTimeoutSec);
  if (!Number.isInteger(sshConnectionTimeoutSec) || sshConnectionTimeoutSec < 5 || sshConnectionTimeoutSec > 180) {
    return { error: 'values.sshConnectionTimeoutSec must be an integer between 5 and 180.' };
  }

  if (typeof value.autoSaveEnabled !== 'boolean') {
    return { error: 'values.autoSaveEnabled must be a boolean.' };
  }

  if (typeof value.accountSyncEnabled !== 'boolean') {
    return { error: 'values.accountSyncEnabled must be a boolean.' };
  }

  const defaultServerNoteTemplate =
    typeof value.defaultServerNoteTemplate === 'string' ? value.defaultServerNoteTemplate : '';
  if (defaultServerNoteTemplate.length > 1000) {
    return { error: 'values.defaultServerNoteTemplate must be 1000 characters or fewer.' };
  }

  if (typeof value.terminalSelectionBarEnabled !== 'boolean') {
    return { error: 'values.terminalSelectionBarEnabled must be a boolean.' };
  }

  const terminalTextDropMode = value.terminalTextDropMode;
  if (terminalTextDropMode !== 'off' && terminalTextDropMode !== 'always' && terminalTextDropMode !== 'external') {
    return { error: 'values.terminalTextDropMode must be one of: off, always, external.' };
  }

  const terminalSelectionSearchEngine = value.terminalSelectionSearchEngine;
  if (
    terminalSelectionSearchEngine !== 'google' &&
    terminalSelectionSearchEngine !== 'bing' &&
    terminalSelectionSearchEngine !== 'duckduckgo' &&
    terminalSelectionSearchEngine !== 'baidu' &&
    terminalSelectionSearchEngine !== 'custom'
  ) {
    return {
      error: 'values.terminalSelectionSearchEngine must be one of: google, bing, duckduckgo, baidu, custom.',
    };
  }

  const terminalSelectionSearchUrlTemplate =
    typeof value.terminalSelectionSearchUrlTemplate === 'string' ? value.terminalSelectionSearchUrlTemplate : '';
  if (terminalSelectionSearchUrlTemplate.length > 1000) {
    return { error: 'values.terminalSelectionSearchUrlTemplate must be 1000 characters or fewer.' };
  }

  return {
    value: {
      language,
      theme,
      sshMaxRows,
      sshConnectionTimeoutSec,
      autoSaveEnabled: value.autoSaveEnabled,
      accountSyncEnabled: value.accountSyncEnabled,
      defaultServerNoteTemplate,
      terminalSelectionBarEnabled: value.terminalSelectionBarEnabled,
      terminalTextDropMode,
      terminalSelectionSearchEngine,
      terminalSelectionSearchUrlTemplate,
    },
  };
};

export const parseSettingsUpdateRequest = (payload: unknown): { value?: SettingsUpdateRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const scopeResult = normalizeScope(payload.scope);
  if (scopeResult.error) {
    return { error: scopeResult.error };
  }

  const valuesResult = normalizeSettingsValues(payload.values);
  if (!valuesResult.value) {
    return { error: valuesResult.error ?? 'values are invalid.' };
  }

  return {
    value: {
      scope: scopeResult.value,
      values: valuesResult.value,
    },
  };
};

export const parseStoredSettingsValues = (payloadJson: string | null | undefined): SettingsValues => {
  if (!payloadJson) {
    return { ...DEFAULT_SETTINGS_VALUES };
  }

  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    const normalized = normalizeSettingsValues(parsed);
    if (!normalized.value) {
      return { ...DEFAULT_SETTINGS_VALUES };
    }

    return normalized.value;
  } catch {
    return { ...DEFAULT_SETTINGS_VALUES };
  }
};

export const normalizeSettingsScopeInput = (scope: unknown): { value?: SettingsScope; error?: string } => {
  const result = normalizeScope(scope);
  if (result.error) {
    return { error: result.error };
  }

  return { value: result.value };
};
