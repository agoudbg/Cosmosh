import {
  API_CAPABILITIES,
  API_CODES,
  API_PATHS,
  type ApiTestPingResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';

import { type BackendHttpApp, getTranslator } from '../i18n.js';
import type { BackendAppContext } from '../types.js';

/**
 * Registers public/system routes (root metadata, health, and connectivity test).
 */
export const registerSystemRoutes = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.get('/', (c) => {
    const t = getTranslator(c);

    return c.json({
      message: t('api.rootMessage'),
      version: '0.1.0',
      status: 'running',
    });
  });

  app.get(API_PATHS.health, (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get(API_PATHS.testPing, (c) => {
    const t = getTranslator(c);

    const payload: ApiTestPingResponse = createApiSuccess({
      code: API_CODES.testPingOk,
      message: t('success.system.backendConnectionHealthy'),
      data: {
        service: 'cosmosh-backend',
        mode: context.runtimeMode,
        authenticated: c.get('authenticated'),
        capabilities: [...API_CAPABILITIES],
      },
    });

    return c.json(payload);
  });
};
