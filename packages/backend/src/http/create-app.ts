import { API_CODES } from '@cosmosh/api-contract';
import { Hono } from 'hono';

import { buildErrorPayload } from './errors.js';
import { registerCommonMiddleware } from './middleware.js';
import { registerLocalTerminalRoutes } from './routes/local-terminal.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSshRoutes } from './routes/ssh.js';
import { registerSystemRoutes } from './routes/system.js';
import type { BackendAppContext } from './types.js';

/**
 * Composes the backend HTTP app by registering shared middleware and domain routes.
 */
export const createBackendApp = (context: BackendAppContext): Hono => {
  const app = new Hono();

  registerCommonMiddleware(app, context);
  registerSystemRoutes(app);
  registerSettingsRoutes(app, context);
  registerSshRoutes(app, context);
  registerLocalTerminalRoutes(app, context);

  app.onError((error, c) => {
    console.error('[http][UNHANDLED]', error);
    return c.json(buildErrorPayload(API_CODES.authInvalidToken, 'Internal server error.'), 500);
  });

  return app;
};
