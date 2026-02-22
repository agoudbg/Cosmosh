const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const workspaceRoot = path.resolve(__dirname, '../../..');
const backendNodeModulesRoot = path.join(workspaceRoot, 'packages', 'backend', 'node_modules');
const mainNodeModulesRoot = path.join(workspaceRoot, 'packages', 'main', 'node_modules');
const packageName = 'better-sqlite3-multiple-ciphers';
const mainPackageJsonPath = path.join(workspaceRoot, 'packages', 'main', 'package.json');

const findPackageRootFromEntry = async (entryPath, expectedPackageName) => {
  let cursor = path.dirname(entryPath);

  while (true) {
    const packageJsonPath = path.join(cursor, 'package.json');

    try {
      const raw = await fs.readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed?.name === expectedPackageName) {
        return cursor;
      }
    } catch {
      // Keep searching parent directories.
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Unable to locate package root for ${expectedPackageName} from ${entryPath}`);
    }

    cursor = parent;
  }
};

const runCommand = async (command, args, cwd, extraEnv = {}) => {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (code=${code ?? 'null'}, signal=${signal ?? 'null'}): ${command} ${args.join(' ')}`));
    });
  });
};

const resolveElectronVersion = async () => {
  const raw = await fs.readFile(mainPackageJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const declaredVersion = parsed?.devDependencies?.electron;

  if (typeof declaredVersion !== 'string') {
    throw new Error('Unable to resolve Electron version from packages/main/package.json.');
  }

  const matched = declaredVersion.match(/\d+\.\d+\.\d+/);
  if (!matched) {
    throw new Error(`Unable to parse Electron version from declaration: ${declaredVersion}`);
  }

  return matched[0];
};

const resolveNodeGypCliPath = async () => {
  const configuredNodeGyp = process.env.npm_config_node_gyp;
  if (configuredNodeGyp) {
    try {
      await fs.access(configuredNodeGyp);
      return configuredNodeGyp;
    } catch {
      // Ignore invalid npm_config_node_gyp and continue searching.
    }
  }

  const candidates = [
    path.join(mainNodeModulesRoot, 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(workspaceRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue searching fallback candidates.
    }
  }

  const resolveFromPaths = [mainNodeModulesRoot, backendNodeModulesRoot, workspaceRoot];
  try {
    return require.resolve('node-gyp/bin/node-gyp.js', {
      paths: resolveFromPaths,
    });
  } catch {
    // Keep the dedicated error below for clearer guidance.
  }

  throw new Error('Unable to locate node-gyp CLI. Install node-gyp or use a Node.js distribution that bundles npm/node-gyp.');
};

const ensureSqlCipherNativeAddon = async () => {
  const packageEntry = require.resolve(packageName, {
    paths: [backendNodeModulesRoot, path.join(workspaceRoot, 'node_modules')],
  });
  const packageRoot = await findPackageRootFromEntry(packageEntry, packageName);
  const nativeBindingPath = path.join(packageRoot, 'build', 'Release', 'better_sqlite3.node');

  const electronVersion = await resolveElectronVersion();
  console.log(
    `[main:prebuild] Building SQLCipher native addon for Electron ${electronVersion} (ensures ABI compatibility).`,
  );
  const nodeGypCliPath = await resolveNodeGypCliPath();

  await runCommand(process.execPath, [nodeGypCliPath, 'rebuild', '--release'], packageRoot, {
    npm_config_runtime: 'electron',
    npm_config_target: electronVersion,
    npm_config_disturl: 'https://electronjs.org/headers',
  });

  await fs.access(nativeBindingPath);
  console.log(`[main:prebuild] Native SQLCipher addon built successfully: ${nativeBindingPath}`);
};

ensureSqlCipherNativeAddon().catch((error) => {
  console.error('[main:prebuild] Failed to ensure SQLCipher native addon.', error);
  process.exitCode = 1;
});
