import type { components } from '@cosmosh/api-contract';

import { getAppSettings } from './backend';
import { getLocale, setLocale } from './i18n';

export type AppSettingsValues = components['schemas']['SettingsValues'];
export type AppSettingsScope = components['schemas']['SettingsScope'];

const RUNTIME_SETTINGS_UPDATED_EVENT = 'cosmosh:runtime-settings-updated';

export const DEFAULT_APP_SETTINGS_VALUES: AppSettingsValues = {
  language: 'en',
  theme: 'dark',
  sshMaxRows: 10000,
  sshConnectionTimeoutSec: 45,
  devToolsEnabled: false,
  autoSaveEnabled: true,
  accountSyncEnabled: false,
  defaultServerNoteTemplate: '',
  terminalSelectionBarEnabled: true,
  terminalTextDropMode: 'external',
  terminalSelectionSearchEngine: 'google',
  terminalSelectionSearchUrlTemplate: '',
};

export const applyThemeSetting = (theme: AppSettingsValues['theme']): void => {
  document.documentElement.dataset.theme = theme;
};

export const applyRuntimeSettings = async (values: AppSettingsValues): Promise<void> => {
  applyThemeSetting(values.theme);

  if (getLocale() !== values.language) {
    await setLocale(values.language);
  }
};

export const emitRuntimeSettingsUpdated = (values: AppSettingsValues): void => {
  window.dispatchEvent(
    new CustomEvent<AppSettingsValues>(RUNTIME_SETTINGS_UPDATED_EVENT, {
      detail: values,
    }),
  );
};

export const onRuntimeSettingsUpdated = (handler: (values: AppSettingsValues) => void): (() => void) => {
  const listener: EventListener = (event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }

    handler(event.detail as AppSettingsValues);
  };

  window.addEventListener(RUNTIME_SETTINGS_UPDATED_EVENT, listener);
  return () => {
    window.removeEventListener(RUNTIME_SETTINGS_UPDATED_EVENT, listener);
  };
};

export const initializeRuntimeSettings = async (): Promise<{
  scope: AppSettingsScope;
  values: AppSettingsValues;
  revision: number;
}> => {
  try {
    const response = await getAppSettings();
    await applyRuntimeSettings(response.data.item.values);

    return {
      scope: response.data.item.scope,
      values: response.data.item.values,
      revision: response.data.item.revision,
    };
  } catch {
    await applyRuntimeSettings(DEFAULT_APP_SETTINGS_VALUES);

    return {
      scope: { deviceId: 'local-device' },
      values: { ...DEFAULT_APP_SETTINGS_VALUES },
      revision: 0,
    };
  }
};
