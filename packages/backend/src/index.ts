import {
  API_CAPABILITIES,
  API_CODES,
  API_HEADERS,
  API_PATHS,
  type ApiErrorResponse,
  type ApiTestPingResponse,
  createApiError,
  createApiSuccess,
} from '@cosmosh/api-contract';
import { createI18n, resolveLocale } from '@cosmosh/i18n';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { DatabaseInitError, initializeDatabase, shutdownDatabase } from './db/prisma.js';
import { resolveRuntimeMode } from './runtime.js';

const app = new Hono();

/**
 * Parse backend port from environment and validate safe numeric bounds.
 */
const resolvePort = (input: string | undefined): number => {
  if (!input) {
    return 3000;
  }

  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid COSMOSH_API_PORT: "${input}". Expected integer in range 1-65535.`);
  }

  return parsed;
};

const runtimeMode = resolveRuntimeMode(process.env.COSMOSH_RUNTIME_MODE);
const port = resolvePort(process.env.COSMOSH_API_PORT);
const internalToken = process.env.COSMOSH_INTERNAL_TOKEN;
const isSecureLocalMode = runtimeMode === 'electron-main';

if (isSecureLocalMode && !internalToken) {
  throw new Error('COSMOSH_INTERNAL_TOKEN is required when COSMOSH_RUNTIME_MODE is electron-main.');
}

const buildErrorPayload = (code: ApiErrorResponse['code'], message: string): ApiErrorResponse => {
  return createApiError({ code, message });
};

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'file://'],
    credentials: true,
  }),
);

app.use('/api/v1/*', async (c, next) => {
  // Internal token check is only required when backend is launched via Electron main process.
  if (!isSecureLocalMode) {
    await next();
    return;
  }

  const providedToken = c.req.header(API_HEADERS.internalToken);
  if (providedToken !== internalToken) {
    return c.json(buildErrorPayload(API_CODES.authInvalidToken, 'Invalid internal authentication token.'), 401);
  }

  await next();
});

// Routes
app.get('/', (c) => {
  // Locale is request-scoped so API responses can match the caller language.
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

const registerShutdownHooks = (): void => {
  // Handle process termination so DB handles are released cleanly.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`\n[shutdown] Received ${signal}. Shutting down backend...`);

    try {
      await shutdownDatabase();
      process.exit(0);
    } catch (error: unknown) {
      if (error instanceof DatabaseInitError) {
        console.error(`[shutdown][${error.code}] ${error.message}`, {
          signal,
          context: error.context,
          cause: error.cause,
        });
      } else {
        console.error('[shutdown][UNKNOWN] Failed to disconnect database during shutdown.', { signal, error });
      }

      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
};

/**
 * Backend bootstrap order:
 * 1) Initialize persistence
 * 2) Register shutdown hooks
 * 3) Start HTTP listener
 */
const bootstrap = async (): Promise<void> => {
  // Database initialization is intentionally done before starting the HTTP server,
  // so runtime fails fast when persistence is not ready.
  await initializeDatabase({ runtimeMode });

  console.log(`🚀 Cosmosh Backend starting on http://127.0.0.1:${port} (${runtimeMode})`);
  registerShutdownHooks();

  serve({
    fetch: app.fetch,
    port,
  });
};

void bootstrap().catch(async (error: unknown) => {
  if (error instanceof DatabaseInitError) {
    console.error(`[bootstrap][${error.code}] ${error.message}`, {
      context: error.context,
      cause: error.cause,
    });
  } else {
    console.error('[bootstrap][UNKNOWN] Failed to bootstrap backend service.', error);
  }

  await shutdownDatabase();
  process.exit(1);
});
