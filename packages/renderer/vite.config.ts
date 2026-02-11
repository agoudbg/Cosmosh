import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import themeWatcher from './scripts/vite-theme-watcher.js';

// https://vite.dev/config/
export default defineConfig({
  plugins: [themeWatcher(), react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
