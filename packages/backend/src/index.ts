import type { ApiErrorResponse, ApiTestPingResponse } from '@cosmosh/api-contract';
import {
  API_CAPABILITIES,
  API_CODES,
  API_HEADERS,
  API_PATHS,
  createApiError,
  createApiSuccess,
} from '@cosmosh/api-contract';
import { createI18n, resolveLocale } from '@cosmosh/i18n';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();
type RuntimeMode = 'standalone' | 'electron-main';

const resolveRuntimeMode = (input: string | undefined): RuntimeMode => {
  if (input === 'electron-main') {
    return 'electron-main';
  }

  return 'standalone';
};

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

// Start server
console.log(`🚀 Cosmosh Backend starting on http://127.0.0.1:${port} (${runtimeMode})`);

serve({
  fetch: app.fetch,
  port,
});
