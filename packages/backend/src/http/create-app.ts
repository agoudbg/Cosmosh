import { API_CODES } from '@cosmosh/api-contract';
import { Hono } from 'hono';

import { buildErrorPayload } from './errors.js';
import { registerCommonMiddleware } from './middleware.js';
import { registerSshRoutes } from './routes/ssh.js';
import { registerSystemRoutes } from './routes/system.js';
import type { BackendAppContext } from './types.js';

export const createBackendApp = (context: BackendAppContext): Hono => {
  const app = new Hono();

  registerCommonMiddleware(app, context);
  registerSystemRoutes(app);
  registerSshRoutes(app, context);

  app.onError((error, c) => {
    console.error('[http][UNHANDLED]', error);
    return c.json(buildErrorPayload(API_CODES.authInvalidToken, 'Internal server error.'), 500);
  });

  return app;
};
