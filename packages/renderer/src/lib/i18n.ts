import type { Locale, TranslationParams } from '@cosmosh/i18n';
import { createI18n, createLocaleHeaders, resolveLocale } from '@cosmosh/i18n';

let currentLocale: Locale = 'en';
export const LOCALE_CHANGE_EVENT = 'cosmosh:locale-change';

const LOCALE_STORAGE_KEY = 'cosmosh.renderer.locale';

const readStoredLocale = (): Locale | null => {
  try {
    if (typeof window === 'undefined') {
      return null;
    }

    const storedValue = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!storedValue) {
      return null;
    }

    return resolveLocale(storedValue, 'en');
  } catch {
    return null;
  }
};

const persistLocale = (locale: Locale): void => {
  try {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Silently ignore storage failures (e.g., disabled cookies)
  }
};

const applyLocale = (locale: Locale): Locale => {
  currentLocale = locale;
  i18n.setLocale(currentLocale);
  emitLocaleChange();
  persistLocale(locale);
  return currentLocale;
};

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
  const storedLocale = readStoredLocale();
  if (storedLocale) {
    return setLocale(storedLocale);
  }

  const localeFromMain = await window.electron?.getLocale?.();
  return applyLocale(resolveLocale(localeFromMain ?? resolveRendererLocale(), 'en'));
};

export const t = (key: string, params?: TranslationParams): string => {
  return i18n.t(key, params);
};

export const setLocale = async (locale: string): Promise<Locale> => {
  const nextLocale = resolveLocale(locale, 'en');
  const syncedLocale = await window.electron?.setLocale?.(nextLocale);
  return applyLocale(resolveLocale(syncedLocale ?? nextLocale, 'en'));
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
