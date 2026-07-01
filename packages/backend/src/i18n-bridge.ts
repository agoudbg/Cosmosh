import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { CreateI18nOptions, EnableI18nDevHotReloadOptions, I18nInstance, Locale } from '@cosmosh/i18n';
import { decode } from '@msgpack/msgpack';

const require = createRequire(import.meta.url);
const i18nRuntime = require('@cosmosh/i18n') as typeof import('@cosmosh/i18n');

type JsonTranslationTree = {
  [key: string]: string | JsonTranslationTree;
};

const backendEn = require('@cosmosh/i18n/locales/en/backend.json') as JsonTranslationTree;
const backendZhCN = require('@cosmosh/i18n/locales/zh-CN/backend.json') as JsonTranslationTree;

/**
 * Loads a generated backend locale extension from its MessagePack runtime asset.
 *
 * @param packageSubpath Exported @cosmosh/i18n locale asset subpath.
 * @returns Decoded translation tree for backend i18n registration.
 */
export const loadBackendInshellisenseMessages = (packageSubpath: string): JsonTranslationTree => {
  const assetPath = require.resolve(packageSubpath);

  try {
    const decoded = decode(readFileSync(assetPath));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Decoded payload is not a translation tree.');
    }

    return decoded as JsonTranslationTree;
  } catch (error: unknown) {
    throw new Error(`Failed to load backend inshellisense MessagePack locale asset: ${assetPath}`, {
      cause: error,
    });
  }
};

const backendInshellisenseEn = loadBackendInshellisenseMessages(
  '@cosmosh/i18n/locales/en/backend-inshellisense.msgpack',
);
const backendInshellisenseZhCN = loadBackendInshellisenseMessages(
  '@cosmosh/i18n/locales/zh-CN/backend-inshellisense.msgpack',
);

const backendMessages = i18nRuntime.createMessages({
  en: {
    backend: i18nRuntime.mergeTranslationTrees(backendEn, backendInshellisenseEn),
  },
  'zh-CN': {
    backend: i18nRuntime.mergeTranslationTrees(backendZhCN, backendInshellisenseZhCN),
  },
});

type BackendCreateI18nOptions = Omit<CreateI18nOptions, 'resources' | 'scope'>;

type BackendEnableI18nDevHotReloadOptions = Omit<
  EnableI18nDevHotReloadOptions,
  'resources' | 'scopes' | 'additionalScopeLocaleFiles'
> & {
  additionalScopeLocaleFiles?: string[];
};

export const createI18n = ({ locale, fallbackLocale, onMissingKey }: BackendCreateI18nOptions): I18nInstance => {
  return i18nRuntime.createI18n({
    locale,
    scope: 'backend',
    fallbackLocale,
    onMissingKey,
    resources: backendMessages,
  });
};

export const enableI18nDevHotReload = ({
  localeRootDir,
  debounceMs,
  additionalScopeLocaleFiles,
}: BackendEnableI18nDevHotReloadOptions): Promise<() => void> => {
  const extensionFiles = Array.from(new Set(['backend-inshellisense.json', ...(additionalScopeLocaleFiles ?? [])]));

  return i18nRuntime.enableI18nDevHotReload({
    localeRootDir,
    debounceMs,
    resources: backendMessages,
    scopes: ['backend'],
    additionalScopeLocaleFiles: {
      backend: extensionFiles,
    },
  });
};

export const resolveLocale = i18nRuntime.resolveLocale;

export type { I18nInstance, Locale };
