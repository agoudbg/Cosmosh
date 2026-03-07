import { API_CODES } from '@cosmosh/api-contract';
import { Hono } from 'hono';

import { buildErrorPayload } from './errors.js';
import { type BackendHttpApp, type BackendHttpEnv, getTranslator } from './i18n.js';
import { registerCommonMiddleware } from './middleware.js';
import { registerLocalTerminalRoutes } from './routes/local-terminal.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSshRoutes } from './routes/ssh.js';
import { registerSystemRoutes } from './routes/system.js';
import type { BackendAppContext } from './types.js';

/**
 * Composes the backend HTTP app by registering shared middleware and domain routes.
 */
export const createBackendApp = (context: BackendAppContext): BackendHttpApp => {
  const app = new Hono<BackendHttpEnv>();

  registerCommonMiddleware(app, context);
  registerSystemRoutes(app);
  registerSettingsRoutes(app, context);
  registerSshRoutes(app, context);
  registerLocalTerminalRoutes(app, context);

  app.onError((error, c) => {
    console.error('[http][UNHANDLED]', error);
    return c.json(
      buildErrorPayload(API_CODES.commonInternalServerError, getTranslator(c)('errors.common.internalServerError')),
      500,
    );
  });

  return app;
};
