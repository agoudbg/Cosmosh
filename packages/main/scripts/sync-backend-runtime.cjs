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

const normalizeRelativePath = (sourcePath, sourcePackageRoot) =>
  path.relative(sourcePackageRoot, sourcePath).split(path.sep).join('/');

const getNodePtyRuntimePrefixes = () => {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return {
      prebuildPrefix: `prebuilds/win32-${arch}/`,
      conptyPrefix: 'third_party/conpty/',
      conptyArchSegment: `/win10-${arch}/`,
    };
  }

  if (platform === 'darwin') {
    return {
      prebuildPrefix: `prebuilds/darwin-${arch}/`,
      conptyPrefix: '',
      conptyArchSegment: '',
    };
  }

  return {
    prebuildPrefix: `prebuilds/linux-${arch}/`,
    conptyPrefix: '',
    conptyArchSegment: '',
  };
};

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');

const shouldIncludeThirdPartyPath = (packageName, sourcePath, sourcePackageRoot) => {
  const relativePath = normalizeRelativePath(sourcePath, sourcePackageRoot);

  if (!relativePath) {
    return true;
  }

  const fileName = path.basename(sourcePath);

  if (relativePath === 'node_modules' || relativePath.startsWith('node_modules/')) {
    return false;
  }

  if (fileName.endsWith('.map')) {
    return false;
  }

  if (packageName === 'better-sqlite3-multiple-ciphers') {
    if (relativePath === 'build' || relativePath === 'build/Release') {
      return true;
    }

    if (relativePath.startsWith('build/')) {
      return relativePath === 'build/Release/better_sqlite3.node';
    }

    if (relativePath === 'deps' || relativePath.startsWith('deps/') || relativePath === 'src' || relativePath.startsWith('src/')) {
      return false;
    }
  }

  if (packageName === 'node-pty') {
    const { prebuildPrefix, conptyPrefix, conptyArchSegment } = getNodePtyRuntimePrefixes();
    const prebuildRoot = trimTrailingSlash(prebuildPrefix);
    const conptyArchMarker = trimTrailingSlash(conptyArchSegment).replace(/^\//, '');

    if (relativePath === 'prebuilds') {
      return true;
    }

    if (relativePath.startsWith('prebuilds/')) {
      return relativePath === prebuildRoot || relativePath.startsWith(prebuildPrefix);
    }

    if (conptyPrefix && (relativePath === 'third_party' || relativePath === 'third_party/conpty')) {
      return true;
    }

    if (conptyPrefix && relativePath.startsWith(conptyPrefix)) {
      const conptyArchMatch = relativePath.match(/\/win10-(x64|arm64)(?:\/|$)/i);

      if (!conptyArchMatch) {
        return true;
      }

      return conptyArchMatch[0].toLowerCase().includes(conptyArchMarker.toLowerCase());
    }
  }

  return true;
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
    filter: (sourcePath) => shouldIncludeThirdPartyPath(packageName, sourcePath, sourcePackageRoot),
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
