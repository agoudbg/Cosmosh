import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const i18nRuntime = require('@cosmosh/i18n') as typeof import('@cosmosh/i18n');

export const createI18n = i18nRuntime.createI18n;
export const enableI18nDevHotReload = i18nRuntime.enableI18nDevHotReload;
export const resolveLocale = i18nRuntime.resolveLocale;

export type { I18nInstance, Locale } from '@cosmosh/i18n';
