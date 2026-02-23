import { DEFAULT_SETTINGS_VALUES, type SettingsScope, type SettingsValues } from '@cosmosh/api-contract';

import { getLocale, setLocale } from './i18n';

export type AppSettingsValues = SettingsValues;
export type AppSettingsScope = SettingsScope;

export const DEFAULT_APP_SETTINGS_VALUES: AppSettingsValues = {
  ...DEFAULT_SETTINGS_VALUES,
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
