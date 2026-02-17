import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import themeWatcher from './scripts/vite-theme-watcher.js';

const workspaceRoot = path.resolve(__dirname, '../..');
const i18nSourceEntry = path.resolve(workspaceRoot, 'packages/i18n/src/index.ts');

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [themeWatcher(), react()],
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
    port: 5173,
    strictPort: true,
    fs: {
      allow: [workspaceRoot],
    },
  },
}));
