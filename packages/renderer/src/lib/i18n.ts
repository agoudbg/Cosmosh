import type { Locale, TranslationParams } from '@cosmosh/i18n';
import { createI18n, createLocaleHeaders, resolveLocale } from '@cosmosh/i18n';

let currentLocale: Locale = 'en';
export const LOCALE_CHANGE_EVENT = 'cosmosh:locale-change';

const emitLocaleChange = (): void => {
  window.dispatchEvent(
    new CustomEvent<{ locale: Locale }>(LOCALE_CHANGE_EVENT, {
      detail: { locale: currentLocale },
    }),
  );
};

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
  emitLocaleChange();
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
  emitLocaleChange();
  return currentLocale;
};

export const getLocale = (): Locale => {
  return currentLocale;
};

export const getLocaleHeaders = (): Record<string, string> => {
  return createLocaleHeaders(currentLocale);
};

export const onLocaleChange = (listener: (locale: Locale) => void): (() => void) => {
  const handler = (event: Event): void => {
    const customEvent = event as CustomEvent<{ locale: Locale }>;
    listener(customEvent.detail?.locale ?? currentLocale);
  };

  window.addEventListener(LOCALE_CHANGE_EVENT, handler);

  return () => {
    window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  };
};
