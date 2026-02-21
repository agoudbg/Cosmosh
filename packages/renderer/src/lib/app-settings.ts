import type { components } from '@cosmosh/api-contract';

import { getAppSettings } from './backend';
import { getLocale, setLocale } from './i18n';

export type AppSettingsValues = components['schemas']['SettingsValues'];
export type AppSettingsScope = components['schemas']['SettingsScope'];

export const DEFAULT_APP_SETTINGS_VALUES: AppSettingsValues = {
  language: 'en',
  theme: 'dark',
  sshMaxRows: 10000,
  sshConnectionTimeoutSec: 45,
  autoSaveEnabled: true,
  accountSyncEnabled: false,
  defaultServerNoteTemplate: '',
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
