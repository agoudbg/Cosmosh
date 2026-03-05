const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Walks a file or directory recursively and returns latest mtime in milliseconds.
 * Missing paths return 0 to force rebuild decisions.
 */
function getLatestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }

  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    return stats.mtimeMs;
  }

  let latest = stats.mtimeMs;
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    const childMtimeMs = getLatestMtimeMs(childPath);
    if (childMtimeMs > latest) {
      latest = childMtimeMs;
    }
  }

  return latest;
}

/**
 * Returns latest mtime among all provided paths.
 */
function getLatestFromPaths(paths) {
  let latest = 0;
  for (const currentPath of paths) {
    const candidate = getLatestMtimeMs(currentPath);
    if (candidate > latest) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * Runs a pnpm workspace command and exits with child exit code when failed.
 */
function runWorkspaceCommand(repoRoot, command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const repoRoot = path.resolve(__dirname, '../../..');

const checks = [
  {
    name: '@cosmosh/api-contract',
    buildArgs: ['--filter', '@cosmosh/api-contract', 'build'],
    inputs: [
      path.join(repoRoot, 'packages', 'api-contract', 'src'),
      path.join(repoRoot, 'packages', 'api-contract', 'openapi', 'cosmosh.openapi.yaml'),
      path.join(repoRoot, 'packages', 'api-contract', 'scripts', 'generate-protocol.mjs'),
    ],
    outputs: [
      path.join(repoRoot, 'packages', 'api-contract', 'dist', 'index.js'),
      path.join(repoRoot, 'packages', 'api-contract', 'dist', 'index.d.ts'),
    ],
  },
  {
    name: '@cosmosh/i18n',
    buildArgs: ['--filter', '@cosmosh/i18n', 'build'],
    inputs: [
      path.join(repoRoot, 'packages', 'i18n', 'src'),
      path.join(repoRoot, 'packages', 'i18n', 'locales'),
    ],
    outputs: [path.join(repoRoot, 'packages', 'i18n', 'dist', 'index.js')],
  },
];

for (const check of checks) {
  const inputMtimeMs = getLatestFromPaths(check.inputs);
  const outputMtimeMs = getLatestFromPaths(check.outputs);

  if (outputMtimeMs >= inputMtimeMs && outputMtimeMs > 0) {
    console.log(`[predev] ${check.name} is up-to-date. Skipping build.`);
    continue;
  }

  console.log(`[predev] ${check.name} is stale. Running build...`);
  runWorkspaceCommand(repoRoot, 'pnpm', check.buildArgs);
}
