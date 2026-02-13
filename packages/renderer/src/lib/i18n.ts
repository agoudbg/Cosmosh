import type { Locale, TranslationParams } from '@cosmosh/i18n';
import { createI18n, createLocaleHeaders, resolveLocale } from '@cosmosh/i18n';

let currentLocale: Locale = 'en';

const resolveRendererLocale = (): Locale => {
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }

  return 'en';
};

const i18n = createI18n({
  locale: currentLocale,
  scope: 'renderer',
  fallbackLocale: 'en',
});

export const initializeLocale = async (): Promise<Locale> => {
  const localeFromMain = await window.electron?.getLocale?.();
  currentLocale = resolveLocale(localeFromMain ?? resolveRendererLocale(), 'en');
  i18n.setLocale(currentLocale);
  return currentLocale;
};

export const t = (key: string, params?: TranslationParams): string => {
  return i18n.t(key, params);
};

export const setLocale = async (locale: string): Promise<Locale> => {
  const nextLocale = resolveLocale(locale, 'en');
  const syncedLocale = await window.electron?.setLocale?.(nextLocale);
  currentLocale = resolveLocale(syncedLocale ?? nextLocale, 'en');
  i18n.setLocale(currentLocale);
  return currentLocale;
};

export const getLocale = (): Locale => {
  return currentLocale;
};

export const getLocaleHeaders = (): Record<string, string> => {
  return createLocaleHeaders(currentLocale);
};
