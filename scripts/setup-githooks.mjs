import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repoRoot, '.githooks', 'pre-commit');

const run = (command) => {
  execSync(command, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
};

try {
  run('git config core.hooksPath .githooks');
} catch (error) {
  console.warn('[prepare] Failed to set core.hooksPath.');
  console.warn(error instanceof Error ? error.message : String(error));
}

try {
  await chmod(hookPath, 0o755);
  console.log('[prepare] Ensured .githooks/pre-commit is executable.');
} catch (error) {
  console.warn('[prepare] Failed to chmod .githooks/pre-commit.');
  console.warn(error instanceof Error ? error.message : String(error));
}
