import { API_HEADERS } from '@cosmosh/api-contract';
import type { Context, Hono } from 'hono';

import { createI18n, type I18nInstance, type Locale, resolveLocale } from '../i18n-bridge.js';

export type BackendHttpVariables = {
  locale: Locale;
  i18n: I18nInstance;
  t: I18nInstance['t'];
};

export type BackendHttpEnv = {
  Variables: BackendHttpVariables;
};

export type BackendHttpApp = Hono<BackendHttpEnv>;
export type BackendHttpContext = Context<BackendHttpEnv>;
export type BackendTranslator = I18nInstance['t'];

const SENSITIVE_REASON_PATTERN = /(password|passphrase|private\s*key|token|secret|credential|authorization)/i;

/**
 * Registers per-request i18n context based on x-cosmosh-locale and accept-language headers.
 */
export const registerI18nMiddleware = (app: BackendHttpApp): void => {
  app.use('*', async (c, next) => {
    const localeHeader = c.req.header(API_HEADERS.locale) ?? c.req.header('accept-language');
    const locale = resolveLocale(localeHeader, 'en');
    const i18n = createI18n({ locale, scope: 'backend', fallbackLocale: 'en' });

    c.set('locale', locale);
    c.set('i18n', i18n);
    c.set('t', i18n.t);

    await next();
  });
};

/**
 * Reads translator from request context.
 */
export const getTranslator = (c: BackendHttpContext): BackendTranslator => {
  return c.get('t');
};

/**
 * Translates known validation/service error strings into backend i18n keys.
 */
export const translateValidationMessage = (
  rawMessage: string,
  nonSensitiveMessage: string,
  sensitiveFallbackMessage: string,
): string => {
  if (SENSITIVE_REASON_PATTERN.test(rawMessage)) {
    return sensitiveFallbackMessage;
  }

  return nonSensitiveMessage;
};
