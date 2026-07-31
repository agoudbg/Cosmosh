/**
 * Bundles the MCP stdio bridge into a single self-contained CJS file.
 *
 * The output (`dist/cosmosh-mcp.cjs`) inlines the MCP SDK and all other
 * dependencies so it can run directly under the packaged Electron binary via
 * `ELECTRON_RUN_AS_NODE=1`, with no `node_modules` alongside it. Only Node
 * built-ins remain external.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const packageDirectoryPath = path.resolve(scriptDirectoryPath, '..');

await build({
  entryPoints: [path.join(packageDirectoryPath, 'src', 'index.ts')],
  outfile: path.join(packageDirectoryPath, 'dist', 'cosmosh-mcp.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: false,
  sourcemap: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
});
