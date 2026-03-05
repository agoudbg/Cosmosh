import { DEFAULT_SETTINGS_VALUES, type SettingsScope, type SettingsValues } from '@cosmosh/api-contract';

import { getLocale, setLocale } from './i18n';

export type AppSettingsValues = SettingsValues;
export type AppSettingsScope = SettingsScope;

export const DEFAULT_APP_SETTINGS_VALUES: AppSettingsValues = {
  ...DEFAULT_SETTINGS_VALUES,
};

/**
 * Resolves Windows title bar symbol color token from current computed theme.
 *
 * @returns CSS color string for title bar overlay symbols, or empty string.
 */
const resolveWindowsSystemMenuSymbolColor = (): string => {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-windows-system-menu-symbol').trim();
};

/**
 * Pushes current Windows title bar symbol color to main process bridge.
 *
 * @returns Nothing.
 */
const syncWindowsSystemMenuSymbolColor = (): void => {
  if (window.electron?.platform !== 'win32') {
    return;
  }

  const symbolColor = resolveWindowsSystemMenuSymbolColor();
  if (!symbolColor) {
    return;
  }

  void window.electron?.setWindowsSystemMenuSymbolColor?.(symbolColor);
};

export const applyThemeSetting = (theme: AppSettingsValues['theme']): void => {
  document.documentElement.dataset.theme = theme;
  syncWindowsSystemMenuSymbolColor();
};

export const applyRuntimeSettings = async (values: AppSettingsValues): Promise<void> => {
  applyThemeSetting(values.theme);

  if (getLocale() !== values.language) {
    await setLocale(values.language);
  }
};
