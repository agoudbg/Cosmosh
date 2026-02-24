import {
  API_CAPABILITIES,
  API_CODES,
  API_HEADERS,
  API_PATHS,
  type ApiTestPingResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';
import { createI18n, resolveLocale } from '@cosmosh/i18n';
import type { Hono } from 'hono';

/**
 * Registers public/system routes (root metadata, health, and connectivity test).
 */
export const registerSystemRoutes = (app: Hono): void => {
  app.get('/', (c) => {
    const requestLocale = resolveLocale(c.req.header(API_HEADERS.locale) ?? c.req.header('accept-language'), 'en');
    const i18n = createI18n({ locale: requestLocale, scope: 'backend', fallbackLocale: 'en' });

    return c.json({
      message: i18n.t('api.rootMessage'),
      version: '0.1.0',
      status: 'running',
    });
  });

  app.get(API_PATHS.health, (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get(API_PATHS.testPing, (c) => {
    const payload: ApiTestPingResponse = createApiSuccess({
      code: API_CODES.testPingOk,
      message: 'Backend connection is healthy.',
      data: {
        service: 'cosmosh-backend',
        mode: 'electron-main',
        authenticated: true,
        capabilities: [...API_CAPABILITIES],
      },
    });

    return c.json(payload);
  });
};
