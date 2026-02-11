import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Vite plugin that watches theme/tokens.cjs and auto-syncs to index.css
 * Triggers HMR on changes so CSS variables update live in dev mode.
 */
export default function themeWatcherPlugin() {
  let config;

  return {
    name: 'theme-watcher',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    configureServer(server) {
      // Only watch in dev mode
      if (config.command !== 'serve') return;

      const tokensPath = path.resolve(config.root, 'theme/tokens.cjs');
      const indexCssPath = path.resolve(config.root, 'src/index.css');

      // Watch theme tokens file
      server.watcher.add(tokensPath);

      server.watcher.on('change', (filePath) => {
        if (path.resolve(filePath) === path.resolve(tokensPath)) {
          try {
            // Execute sync script
            execSync('node ./scripts/sync-theme.cjs', { cwd: config.root, stdio: 'pipe' });

            // Force full reload of CSS
            server.ws.send({
              type: 'full',
              event: 'full-reload',
              payload: { path: indexCssPath },
            });
          } catch (error) {
            console.error('Theme sync failed:', error.message);
          }
        }
      });
    },
  };
}
