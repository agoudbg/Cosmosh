import { createI18n, resolveLocale } from '@cosmosh/i18n';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'file://'],
    credentials: true,
  }),
);

// Routes
app.get('/', (c) => {
  // Locale is request-scoped so API responses can match the caller language.
  const requestLocale = resolveLocale(c.req.header('x-cosmosh-locale') ?? c.req.header('accept-language'), 'en');
  const i18n = createI18n({ locale: requestLocale, scope: 'backend', fallbackLocale: 'en' });

  return c.json({
    message: i18n.t('api.rootMessage'),
    version: '0.1.0',
    status: 'running',
  });
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes placeholder
const api = new Hono();

api.get('/sessions', (c) => {
  return c.json({ sessions: [] });
});

app.route('/api', api);

// Start server
const port = 3000;
console.log(`🚀 Cosmosh Backend starting on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
