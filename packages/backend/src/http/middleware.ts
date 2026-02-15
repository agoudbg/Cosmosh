import { API_CODES, API_HEADERS } from '@cosmosh/api-contract';
import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { buildErrorPayload } from './errors.js';
import type { BackendAppContext } from './types.js';

export const registerCommonMiddleware = (app: Hono, context: BackendAppContext): void => {
  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: ['http://localhost:5173', 'file://'],
      credentials: true,
    }),
  );

  app.use('/api/v1/*', async (c, next) => {
    if (!context.isSecureLocalMode) {
      await next();
      return;
    }

    const providedToken = c.req.header(API_HEADERS.internalToken);
    if (providedToken !== context.internalToken) {
      return c.json(buildErrorPayload(API_CODES.authInvalidToken, 'Invalid internal authentication token.'), 401);
    }

    await next();
  });
};
