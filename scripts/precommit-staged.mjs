import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const run = (command) => {
  console.log(`[pre-commit] ${command}`);
  execSync(command, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
};

const getStagedFiles = () => {
  const output = execSync('git diff --cached --name-only --diff-filter=ACMR', {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((file) => file.trim().replaceAll('\\\\', '/'))
    .filter(Boolean);
};

const changedIn = (files, directory) =>
  files.some((file) => file === directory || file.startsWith(`${directory}/`));

const isGlobalTriggerFile = (file) => {
  const globalFiles = new Set([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'AGENTS.md',
    'DEVELOPMENT.md',
  ]);

  if (globalFiles.has(file)) {
    return true;
  }

  return file.startsWith('.githooks/') || file.startsWith('scripts/');
};

const stagedFiles = getStagedFiles();

if (stagedFiles.length === 0) {
  console.log('[pre-commit] No staged files detected. Skip checks.');
  process.exit(0);
}

if (stagedFiles.some(isGlobalTriggerFile)) {
  console.log('[pre-commit] Global files changed. Run full pre-commit checks.');
  run('pnpm precommit:lint');
  process.exit(0);
}

const commands = [];

if (changedIn(stagedFiles, 'packages/backend')) {
  commands.push('pnpm --filter @cosmosh/backend lint');
}

if (changedIn(stagedFiles, 'packages/main')) {
  commands.push('pnpm --filter @cosmosh/main lint');
}

if (changedIn(stagedFiles, 'packages/renderer')) {
  commands.push('pnpm --filter @cosmosh/renderer lint');
}

if (changedIn(stagedFiles, 'packages/i18n')) {
  commands.push('pnpm --filter @cosmosh/i18n check');
  commands.push('pnpm --filter @cosmosh/i18n check:sort');
}

if (changedIn(stagedFiles, 'packages/api-contract')) {
  commands.push('pnpm --filter @cosmosh/api-contract typecheck');
}

if (commands.length === 0) {
  console.log('[pre-commit] No package checks needed for current staged files.');
  process.exit(0);
}

for (const command of commands) {
  run(command);
}
