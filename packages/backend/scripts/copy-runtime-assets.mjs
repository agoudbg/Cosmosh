import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

const runtimeAssets = [
  {
    from: path.join(packageRoot, 'src', 'terminal', 'completion', 'generated-inshellisense.msgpack'),
    to: path.join(packageRoot, 'dist', 'terminal', 'completion', 'generated-inshellisense.msgpack'),
  },
];

for (const asset of runtimeAssets) {
  await fs.mkdir(path.dirname(asset.to), { recursive: true });
  await fs.copyFile(asset.from, asset.to);
}

console.log(`[backend:build] Copied runtime assets: ${runtimeAssets.length}`);
