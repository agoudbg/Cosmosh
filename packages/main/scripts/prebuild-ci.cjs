const path = require('node:path');

const { createStep, runSteps } = require('./ci-step-runner.cjs');

const mainPackageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '../../..');
const backendPackageRoot = path.join(workspaceRoot, 'packages', 'backend');
const rendererPackageRoot = path.join(workspaceRoot, 'packages', 'renderer');
const useShellForPnpm = process.platform === 'win32';

/**
 * Creates a step that runs one main-package Node.js helper script.
 *
 * @param {string} label Human-readable step label for CI logs.
 * @param {string} scriptName File name under packages/main/scripts.
 * @returns {{ label: string, command: string, args: string[], cwd: string, shell: boolean }} Step descriptor.
 */
const mainNodeScript = (label, scriptName) =>
  createStep({
    label,
    command: process.execPath,
    args: [path.join(mainPackageRoot, 'scripts', scriptName)],
    cwd: mainPackageRoot,
  });

/**
 * Creates a step that runs pnpm from the workspace root.
 *
 * @param {string} label Human-readable step label for CI logs.
 * @param {string[]} args Arguments passed to pnpm.
 * @returns {{ label: string, command: string, args: string[], cwd: string, shell: boolean }} Step descriptor.
 */
const pnpmStep = (label, args) =>
  createStep({
    label,
    command: 'pnpm',
    args,
    cwd: workspaceRoot,
    shell: useShellForPnpm,
  });

/**
 * Creates a step that runs a package-local Node.js CLI without shell shims.
 *
 * @param {string} label Human-readable step label for CI logs.
 * @param {string} packageRoot Absolute package directory.
 * @param {string[]} cliPath Package-local CLI path segments.
 * @param {string[]} args CLI arguments.
 * @returns {{ label: string, command: string, args: string[], cwd: string, shell: boolean }} Step descriptor.
 */
const nodeCliStep = (label, packageRoot, cliPath, args) =>
  createStep({
    label,
    command: process.execPath,
    args: [path.join(packageRoot, ...cliPath), ...args],
    cwd: packageRoot,
  });

const steps = [
  mainNodeScript('Clean release artifacts', 'cleanup-legacy-artifacts.cjs'),
  mainNodeScript('Release Prisma locks', 'release-unlock-prisma-locks.cjs'),
  pnpmStep('Build API contract', ['--filter', '@cosmosh/api-contract', 'build']),
  pnpmStep('Build i18n', ['--filter', '@cosmosh/i18n', 'build']),
  pnpmStep('Generate backend Prisma client', ['--filter', '@cosmosh/backend', 'run', 'db:generate']),
  nodeCliStep('Compile backend', backendPackageRoot, ['node_modules', 'typescript', 'bin', 'tsc'], [
    '-p',
    'tsconfig.json',
  ]),
  mainNodeScript('Ensure SQLCipher native addon', 'ensure-sqlcipher-native.cjs'),
  mainNodeScript('Sync Prisma client runtime', 'sync-prisma-client.cjs'),
  mainNodeScript('Sync backend runtime', 'sync-backend-runtime.cjs'),
  mainNodeScript('Generate installer strings', 'generate-installer-strings.mjs'),
  mainNodeScript('Compile macOS Open With helper', 'compile-macos-open-with-helper.mjs'),
  pnpmStep('Sync renderer theme', ['--filter', '@cosmosh/renderer', 'run', 'theme:sync']),
  nodeCliStep('Type-check renderer', rendererPackageRoot, ['node_modules', 'typescript', 'bin', 'tsc'], [
    '-p',
    'tsconfig.json',
  ]),
  nodeCliStep('Build renderer', rendererPackageRoot, ['node_modules', 'vite', 'bin', 'vite.js'], ['build']),
];

/**
 * Runs the optimized CI prebuild sequence without package lifecycle duplication.
 *
 * @returns {Promise<void>} Resolves when all CI prebuild steps pass.
 */
const runCiPrebuild = async () => {
  await runSteps('main:prebuild:ci', steps);
};

runCiPrebuild().catch((error) => {
  console.error('[main:prebuild:ci] Failed.', error);
  process.exitCode = 1;
});
