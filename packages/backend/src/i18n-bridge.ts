import { createRequire } from 'node:module';

import type { CreateI18nOptions, EnableI18nDevHotReloadOptions, I18nInstance, Locale } from '@cosmosh/i18n';

const require = createRequire(import.meta.url);
const i18nRuntime = require('@cosmosh/i18n') as typeof import('@cosmosh/i18n');

type JsonTranslationTree = {
  [key: string]: string | JsonTranslationTree;
};

const backendEn = require('@cosmosh/i18n/locales/en/backend.json') as JsonTranslationTree;
const backendZhCN = require('@cosmosh/i18n/locales/zh-CN/backend.json') as JsonTranslationTree;

const backendMessages = i18nRuntime.createMessages({
  en: {
    backend: backendEn,
  },
  'zh-CN': {
    backend: backendZhCN,
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
  return i18nRuntime.enableI18nDevHotReload({
    localeRootDir,
    debounceMs,
    resources: backendMessages,
    scopes: ['backend'],
    additionalScopeLocaleFiles: {
      backend: additionalScopeLocaleFiles ?? [],
    },
  });
};

export const resolveLocale = i18nRuntime.resolveLocale;

export type { I18nInstance, Locale };
