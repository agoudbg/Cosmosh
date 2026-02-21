const fs = require('node:fs/promises');
const { builtinModules } = require('node:module');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '../../..');
const backendNodeModulesRoot = path.join(workspaceRoot, 'packages', 'backend', 'node_modules');
const i18nNodeModulesRoot = path.join(workspaceRoot, 'packages', 'i18n', 'node_modules');
const runtimeNodeModulesRoot = path.join(workspaceRoot, 'packages', 'main', 'resources-runtime', 'node_modules');
const runtimeCosmoshRoot = path.join(runtimeNodeModulesRoot, '@cosmosh');

const thirdPartyEntryPackages = [
  '@hono/node-server',
  'hono',
  'ssh2',
  'ws',
  'node-pty',
  'intl-messageformat',
  'better-sqlite3-multiple-ciphers',
];
const workspaceRuntimePackages = ['backend', 'api-contract', 'i18n'];
const builtInModuleNames = new Set([...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)]);

const findPackageRootFromEntry = async (entryPath, expectedPackageName) => {
  let cursor = path.dirname(entryPath);

  while (true) {
    const packageJsonPath = path.join(cursor, 'package.json');

    try {
      const raw = await fs.readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed && parsed.name === expectedPackageName) {
        return cursor;
      }
    } catch {
      // Keep walking upward until a matching package root is found.
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Unable to locate package root for ${expectedPackageName} from ${entryPath}`);
    }

    cursor = parent;
  }
};

const resolvePackageRoot = async (packageName, resolvePaths) => {
  const resolvedEntryPath = require.resolve(packageName, { paths: resolvePaths });
  return await findPackageRootFromEntry(resolvedEntryPath, packageName);
};

const copyPackageToRuntime = async (packageName, sourcePackageRoot) => {
  const segments = packageName.split('/');
  const targetPackageRoot = path.join(runtimeNodeModulesRoot, ...segments);

  await fs.rm(targetPackageRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetPackageRoot), { recursive: true });
  await fs.cp(sourcePackageRoot, targetPackageRoot, {
    recursive: true,
    force: true,
    dereference: true,
    errorOnExist: false,
  });
};

const syncedThirdPartyPackages = new Set();

const syncPackageRecursively = async (packageName, resolvePaths) => {
  if (syncedThirdPartyPackages.has(packageName)) {
    return;
  }

  const packageRoot = await resolvePackageRoot(packageName, resolvePaths);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const rawPackageJson = await fs.readFile(packageJsonPath, 'utf8');
  const parsedPackageJson = JSON.parse(rawPackageJson);

  await copyPackageToRuntime(packageName, packageRoot);
  syncedThirdPartyPackages.add(packageName);

  const dependencyNames = [
    ...Object.keys(parsedPackageJson.dependencies ?? {}),
    ...Object.keys(parsedPackageJson.optionalDependencies ?? {}),
  ];

  for (const dependencyName of dependencyNames) {
    if (dependencyName.startsWith('@cosmosh/')) {
      continue;
    }

    if (builtInModuleNames.has(dependencyName)) {
      continue;
    }

    await syncPackageRecursively(dependencyName, [packageRoot, ...resolvePaths, runtimeNodeModulesRoot]);
  }
};

const syncThirdPartyDependencies = async () => {
  const initialResolvePaths = [backendNodeModulesRoot, i18nNodeModulesRoot, path.join(workspaceRoot, 'node_modules')];

  for (const packageName of thirdPartyEntryPackages) {
    await syncPackageRecursively(packageName, initialResolvePaths);
    console.log(`[main:prebuild] Synced third-party runtime dependency: ${packageName}`);
  }
};

const syncWorkspaceRuntimePackages = async () => {
  await fs.mkdir(runtimeCosmoshRoot, { recursive: true });

  for (const packageName of workspaceRuntimePackages) {
    const sourcePackageDir = path.join(workspaceRoot, 'packages', packageName);
    const sourceDistDir = path.join(sourcePackageDir, 'dist');
    const sourcePackageJsonPath = path.join(sourcePackageDir, 'package.json');
    const targetPackageDir = path.join(runtimeCosmoshRoot, packageName);
    const targetDistDir = path.join(targetPackageDir, 'dist');
    const targetPackageJsonPath = path.join(targetPackageDir, 'package.json');

    await fs.access(sourceDistDir);
    await fs.access(sourcePackageJsonPath);
    await fs.rm(targetPackageDir, { recursive: true, force: true });
    await fs.mkdir(targetPackageDir, { recursive: true });
    await fs.cp(sourceDistDir, targetDistDir, { recursive: true, force: true });
    await fs.copyFile(sourcePackageJsonPath, targetPackageJsonPath);

    console.log(`[main:prebuild] Synced workspace runtime package: @cosmosh/${packageName}`);
  }
};

const syncBackendRuntime = async () => {
  await fs.mkdir(runtimeNodeModulesRoot, { recursive: true });
  await syncThirdPartyDependencies();
  await syncWorkspaceRuntimePackages();
};

syncBackendRuntime().catch((error) => {
  console.error('[main:prebuild] Failed to sync backend runtime dependencies.', error);
  process.exitCode = 1;
});
