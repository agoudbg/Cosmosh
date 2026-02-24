import { timingSafeEqual } from 'node:crypto';

import { API_CODES, API_HEADERS } from '@cosmosh/api-contract';
import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { buildErrorPayload } from './errors.js';
import type { BackendAppContext } from './types.js';

const DEFAULT_RENDERER_DEV_PORT = 2767;

/**
 * Resolves renderer dev origin port used by local CORS policy.
 */
const resolveRendererDevPort = (): number => {
  const candidate = Number(process.env.COSMOSH_RENDERER_DEV_PORT ?? DEFAULT_RENDERER_DEV_PORT);
  if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535) {
    return DEFAULT_RENDERER_DEV_PORT;
  }

  return candidate;
};

/**
 * Verifies internal token using timing-safe comparison to reduce token oracle risks.
 */
const isValidInternalToken = (providedToken: string | undefined, expectedToken: string | undefined): boolean => {
  if (!providedToken || !expectedToken) {
    return false;
  }

  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

/**
 * Registers cross-cutting middleware: logging, CORS, and secure local auth guard.
 */
export const registerCommonMiddleware = (app: Hono, context: BackendAppContext): void => {
  const rendererDevOrigin = `http://localhost:${resolveRendererDevPort()}`;

  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: [rendererDevOrigin, 'file://'],
      credentials: true,
    }),
  );

  app.use('/api/v1/*', async (c, next) => {
    if (!context.isSecureLocalMode) {
      await next();
      return;
    }

    const providedToken = c.req.header(API_HEADERS.internalToken);
    if (!isValidInternalToken(providedToken, context.internalToken)) {
      return c.json(buildErrorPayload(API_CODES.authInvalidToken, 'Invalid internal authentication token.'), 401);
    }

    await next();
  });
};
