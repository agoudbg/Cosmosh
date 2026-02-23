import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import themeWatcher from './scripts/vite-theme-watcher.js';

const workspaceRoot = path.resolve(__dirname, '../..');
const i18nSourceEntry = path.resolve(workspaceRoot, 'packages/i18n/src/index.ts');
const DEFAULT_RENDERER_DEV_PORT = 2767;

const resolveRendererDevPort = (): number => {
  const candidate = Number(process.env.COSMOSH_RENDERER_DEV_PORT ?? DEFAULT_RENDERER_DEV_PORT);
  if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535) {
    return DEFAULT_RENDERER_DEV_PORT;
  }

  return candidate;
};

const createCspHtmlPlugin = (cspPolicy: string) => {
  return {
    name: 'cosmosh-csp-html-transform',
    transformIndexHtml: (html: string) => {
      return html.replace('__COSMOSH_CSP_CONTENT__', cspPolicy);
    },
  };
};

const resolveCspPolicy = (mode: string, rendererDevPort: number): string => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const runtimeTarget = (env.VITE_RUNTIME_TARGET ?? 'electron').toLowerCase();

  const defaultConnectSrc =
    runtimeTarget === 'browser'
      ? "'self' https: wss: http://localhost:* ws://localhost:*"
      : `'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:${rendererDevPort} ws://localhost:${rendererDevPort}`;

  const connectSrc = env.VITE_CSP_CONNECT_SRC?.trim() || defaultConnectSrc;

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
};

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const rendererDevPort = resolveRendererDevPort();
  const cspPolicy = resolveCspPolicy(mode, rendererDevPort);

  return {
    plugins: [themeWatcher(), react(), createCspHtmlPlugin(cspPolicy)],
    base: './',
    resolve: {
      alias: command === 'serve' ? { '@cosmosh/i18n': i18nSourceEntry } : undefined,
    },
    optimizeDeps: {
      exclude: ['@cosmosh/i18n'],
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
    },
    server: {
      port: rendererDevPort,
      strictPort: true,
      fs: {
        allow: [workspaceRoot],
      },
    },
  };
});
