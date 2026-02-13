import { messages } from './messages';
import { IntlMessageFormat } from 'intl-messageformat';

import type {
  CreateI18nOptions,
  I18nInstance,
  Locale,
  Scope,
  TranslationPrimitive,
  TranslationParams,
  TranslationTree,
} from './types/i18n';

const supportedLocales: Locale[] = ['en', 'zh-CN'];
const formatterCache = new Map<string, IntlMessageFormat>();

const resolveValue = (target: TranslationTree | undefined, key: string): string | undefined => {
  const result = key.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, target);

  return typeof result === 'string' ? result : undefined;
};

const formatTemplate = (template: string, locale: Locale, params?: TranslationParams): string => {
  // Keep backward compatibility for legacy placeholders and escaped percent literals.
  const escapedPercentToken = '__COSMOSH_PERCENT__';
  const normalizedTemplate = template.replace(/\{\{\s*(\w+)\s*\}\}/g, '{$1}').replace(/%%/g, escapedPercentToken);

  // Convert printf tokens to ICU placeholders so one formatter can handle all syntaxes.
  let autoIndex = 0;
  const templateWithPrintf = normalizedTemplate.replace(/%(\d+)?([ds])/g, (_match, index: string | undefined) => {
    if (index) {
      return `{__arg${index}}`;
    }

    autoIndex += 1;
    return `{__arg_auto_${autoIndex}}`;
  });

  const values: Record<string, TranslationPrimitive> = {};

  if (Array.isArray(params)) {
    params.forEach((value, index) => {
      const oneBasedIndex = index + 1;
      values[`__arg_auto_${oneBasedIndex}`] = value;
      values[`__arg${oneBasedIndex}`] = value;
    });
  } else if (params) {
    Object.entries(params).forEach(([key, value]) => {
      values[key] = value;

      if (/^\d+$/.test(key)) {
        values[`__arg${key}`] = value;
      }
    });
  }

  const cacheKey = `${locale}::${templateWithPrintf}`;
  let formatter = formatterCache.get(cacheKey);

  if (!formatter) {
    formatter = new IntlMessageFormat(templateWithPrintf, locale);
    formatterCache.set(cacheKey, formatter);
  }

  return String(formatter.format(values)).replace(new RegExp(escapedPercentToken, 'g'), '%');
};

export const resolveLocale = (input: string | undefined, fallbackLocale: Locale = 'en'): Locale => {
  // Normalize language-like inputs (en-US / zh-TW) into the supported locale set.
  if (!input) {
    return fallbackLocale;
  }

  const normalized = input.trim().toLowerCase();

  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }

  if (normalized.startsWith('en')) {
    return 'en';
  }

  return fallbackLocale;
};

export const getSupportedLocales = (): Locale[] => {
  return [...supportedLocales];
};

export const createLocaleHeaders = (locale: Locale): Record<string, string> => {
  return {
    'x-cosmosh-locale': locale,
  };
};

export const createI18n = ({
  locale,
  scope,
  fallbackLocale = 'en',
  onMissingKey,
  resources,
}: CreateI18nOptions): I18nInstance => {
  // Optional resource injection makes tests independent from product translation keys.
  const sourceMessages = resources ?? messages;
  let currentLocale = resolveLocale(locale, fallbackLocale);

  const t = (key: string, params?: TranslationParams): string => {
    const scopedCurrent = sourceMessages[currentLocale]?.[scope as Scope];
    const scopedFallback = sourceMessages[fallbackLocale]?.[scope as Scope];

    const fromCurrent = resolveValue(scopedCurrent, key);
    if (fromCurrent) {
      return formatTemplate(fromCurrent, currentLocale, params);
    }

    const fromFallback = resolveValue(scopedFallback, key);
    if (fromFallback) {
      return formatTemplate(fromFallback, fallbackLocale, params);
    }

    if (typeof onMissingKey === 'function') {
      onMissingKey({ locale: currentLocale, scope, key });
    }

    return key;
  };

  return {
    t,
    getLocale: () => currentLocale,
    setLocale: (nextLocale: string) => {
      currentLocale = resolveLocale(nextLocale, fallbackLocale);
    },
    getLocales: () => Object.keys(sourceMessages) as Locale[],
  };
};

export type {
  CreateI18nOptions,
  I18nInstance,
  Locale,
  Messages,
  MissingKeyPayload,
  Scope,
  TranslationParams,
} from './types/i18n';
