import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const sourceLocalesDir = path.join(packageRoot, 'locales');
const targetLocalesDir = path.join(packageRoot, 'dist', 'locales');

await fs.rm(targetLocalesDir, { recursive: true, force: true });
await fs.cp(sourceLocalesDir, targetLocalesDir, {
  recursive: true,
  force: true,
  filter: (sourcePath) => {
    const lowerName = path.basename(sourcePath).toLowerCase();
    return lowerName.endsWith('.msgpack') || !path.extname(lowerName);
  },
});

console.log('[i18n:build] Copied locale runtime assets.');
