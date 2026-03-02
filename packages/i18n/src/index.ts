import { messages } from './messages';
import { IntlMessageFormat } from 'intl-messageformat';

import type {
  CreateI18nOptions,
  EnableI18nDevHotReloadOptions,
  I18nInstance,
  Locale,
  Messages,
  Scope,
  TranslationPrimitive,
  TranslationParams,
  TranslationTree,
} from './types/i18n';

const supportedLocales: Locale[] = ['en', 'zh-CN'];
const formatterCache = new Map<string, IntlMessageFormat>();
const intlMessageFormatOptions = { ignoreTag: true } as const;
const supportedScopes: Scope[] = ['main', 'renderer', 'backend'];
const additionalScopeLocaleFiles: Partial<Record<Scope, string[]>> = {
  backend: ['backend-inshellisense.json'],
};

type NodeFsModule = typeof import('node:fs');
type NodePathModule = typeof import('node:path');

const loadNodeRuntimeModules = async (): Promise<{ fs: NodeFsModule; path: NodePathModule } | null> => {
  try {
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    return {
      fs,
      path,
    };
  } catch {
    return null;
  }
};

const tryReloadMessagesFromDisk = (localeRootDir: string, fs: NodeFsModule, path: NodePathModule): boolean => {
  if (!fs || !path) {
    return false;
  }

  const nextMessages: Messages = {
    en: {
      main: messages.en.main,
      renderer: messages.en.renderer,
      backend: messages.en.backend,
    },
    'zh-CN': {
      main: messages['zh-CN'].main,
      renderer: messages['zh-CN'].renderer,
      backend: messages['zh-CN'].backend,
    },
  };

  try {
    const mergeTranslationTrees = (baseTree: TranslationTree, extensionTree: TranslationTree): TranslationTree => {
      const mergedTree: TranslationTree = {
        ...baseTree,
      };

      Object.entries(extensionTree).forEach(([key, value]) => {
        const currentValue = mergedTree[key];
        if (
          currentValue &&
          typeof currentValue === 'object' &&
          !Array.isArray(currentValue) &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value)
        ) {
          mergedTree[key] = mergeTranslationTrees(currentValue as TranslationTree, value as TranslationTree);
          return;
        }

        mergedTree[key] = value;
      });

      return mergedTree;
    };

    for (const locale of supportedLocales) {
      for (const scope of supportedScopes) {
        const filePath = path.resolve(localeRootDir, locale, `${scope}.json`);

        if (!fs.existsSync(filePath)) {
          throw new Error(`Missing locale file: ${filePath}`);
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as TranslationTree;
        const extensionFiles = additionalScopeLocaleFiles[scope] ?? [];
        const merged = extensionFiles.reduce<TranslationTree>((acc, extensionFileName) => {
          const extensionPath = path.resolve(localeRootDir, locale, extensionFileName);
          if (!fs.existsSync(extensionPath)) {
            return acc;
          }

          const extensionRaw = fs.readFileSync(extensionPath, 'utf8');
          const extensionParsed = JSON.parse(extensionRaw) as TranslationTree;
          return mergeTranslationTrees(acc, extensionParsed);
        }, parsed);

        nextMessages[locale][scope] = merged;
      }
    }
  } catch (error) {
    console.warn('[i18n] Failed to reload locales from disk.', error);
    return false;
  }

  for (const locale of supportedLocales) {
    for (const scope of supportedScopes) {
      messages[locale][scope] = nextMessages[locale][scope];
    }
  }

  formatterCache.clear();
  return true;
};

export const enableI18nDevHotReload = async ({
  localeRootDir,
  debounceMs = 60,
}: EnableI18nDevHotReloadOptions): Promise<() => void> => {
  if (process.env.NODE_ENV === 'production') {
    return () => undefined;
  }

  const runtimeModules = await loadNodeRuntimeModules();
  if (!runtimeModules) {
    return () => undefined;
  }

  const { fs, path } = runtimeModules;
  const resolvedLocaleRootDir = path.resolve(localeRootDir);

  if (!fs.existsSync(resolvedLocaleRootDir)) {
    console.warn(`[i18n] Locale directory not found: ${resolvedLocaleRootDir}`);
    return () => undefined;
  }

  tryReloadMessagesFromDisk(resolvedLocaleRootDir, fs, path);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(resolvedLocaleRootDir, { recursive: true }, (_event, filename) => {
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.json')) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      tryReloadMessagesFromDisk(resolvedLocaleRootDir, fs, path);
    }, debounceMs);
  });

  console.log(`[i18n] Dev hot reload enabled. Watching ${resolvedLocaleRootDir}`);

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    watcher.close();
  };
};

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
    formatter = new IntlMessageFormat(templateWithPrintf, locale, undefined, intlMessageFormatOptions);
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
  EnableI18nDevHotReloadOptions,
  I18nInstance,
  Locale,
  Messages,
  MissingKeyPayload,
  Scope,
  TranslationParams,
} from './types/i18n';
