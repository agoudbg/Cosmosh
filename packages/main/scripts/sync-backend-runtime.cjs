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
  'socks',
  'intl-messageformat',
  '@prisma/adapter-better-sqlite3',
  'better-sqlite3-multiple-ciphers',
  '@modelcontextprotocol/sdk',
  'zod',
];
const workspaceRuntimePackages = ['backend', 'api-contract', 'i18n'];
const builtInModuleNames = new Set([...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)]);

/**
 * Resolves package root from any resolved entry path.
 */
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

/**
 * Resolves the on-disk root of an npm package.
 *
 * Prefers Node.js entry resolution so pnpm symlinks and export maps are
 * honored. Falls back to the conventional `./package.json` subpath when the
 * bare entry cannot be resolved — for example `@modelcontextprotocol/sdk@1.29.0`
 * maps "." to a `dist/cjs/index.js` missing from the published tarball, and
 * `dunder-proto@1.0.1` intentionally defines no "." export. The sync only
 * needs the package root to copy files, so the package.json path is enough.
 *
 * @param {string} packageName npm package name, including scope when present.
 * @param {string[]} resolvePaths node_modules roots to search, in priority order.
 * @returns {Promise<string>} Absolute path to the package root directory.
 * @throws {Error} When the package cannot be located from any resolve path.
 */
const resolvePackageRoot = async (packageName, resolvePaths) => {
  try {
    const resolvedEntryPath = require.resolve(packageName, { paths: resolvePaths });
    return await findPackageRootFromEntry(resolvedEntryPath, packageName);
  } catch (entryResolutionError) {
    try {
      const resolvedPackageJsonPath = require.resolve(`${packageName}/package.json`, { paths: resolvePaths });
      return await findPackageRootFromEntry(resolvedPackageJsonPath, packageName);
    } catch {
      throw new Error(`Unable to resolve package root for ${packageName}`, { cause: entryResolutionError });
    }
  }
};

const normalizeRelativePath = (sourcePath, sourcePackageRoot) =>
  path.relative(sourcePackageRoot, sourcePath).split(path.sep).join('/');

const hasExcludedPathSegment = (relativePath, excludedNames) => {
  const segments = relativePath.split('/');
  return segments.some((segment) => excludedNames.has(segment.toLowerCase()));
};

/**
 * Resolves runtime-specific prebuild folder prefixes for node-pty artifacts.
 */
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

const excludedDirectoryNames = new Set([
  '.github',
  '.vscode',
  '__tests__',
  'benchmark',
  'benchmarks',
  'docs',
  'doc',
  'example',
  'examples',
  'test',
  'tests',
]);

const excludedFileExtensions = new Set([
  '.cc',
  '.cpp',
  '.c',
  '.d.ts',
  '.d.mts',
  '.exp',
  '.gyp',
  '.h',
  '.hpp',
  '.iobj',
  '.ilk',
  '.lib',
  '.map',
  '.md',
  '.mk',
  '.obj',
  '.o',
  '.pdb',
  '.ts',
  '.tsx',
  '.vcxproj',
  '.yaml',
  '.yml',
]);

/**
 * Filters out development-only files to keep packaged runtime minimal and predictable.
 */
const shouldIncludeThirdPartyPath = (packageName, sourcePath, sourcePackageRoot) => {
  const relativePath = normalizeRelativePath(sourcePath, sourcePackageRoot);

  if (!relativePath) {
    return true;
  }

  const fileName = path.basename(sourcePath);

  if (relativePath === 'node_modules' || relativePath.startsWith('node_modules/')) {
    return false;
  }

  if (hasExcludedPathSegment(relativePath, excludedDirectoryNames)) {
    return false;
  }

  const lowerRelativePath = relativePath.toLowerCase();
  const lowerFileName = fileName.toLowerCase();

  if (
    excludedFileExtensions.has(path.extname(lowerFileName)) ||
    lowerFileName.endsWith('.d.ts') ||
    lowerFileName.endsWith('.d.mts') ||
    lowerFileName.endsWith('.ipdb') ||
    lowerFileName.endsWith('.tlog') ||
    lowerRelativePath.endsWith('.d.ts') ||
    lowerRelativePath.endsWith('.d.mts')
  ) {
    return false;
  }

  if (
    lowerRelativePath.includes('/obj/') ||
    lowerRelativePath.includes('/obj.target/') ||
    lowerRelativePath.includes('/.deps/')
  ) {
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
    const { prebuildPrefix } = getNodePtyRuntimePrefixes();
    const prebuildRoot = trimTrailingSlash(prebuildPrefix);

    if (
      relativePath === 'build' ||
      relativePath.startsWith('build/') ||
      relativePath === 'src' ||
      relativePath.startsWith('src/') ||
      relativePath === 'scripts' ||
      relativePath.startsWith('scripts/') ||
      relativePath === 'typings' ||
      relativePath.startsWith('typings/') ||
      relativePath === 'third_party' ||
      relativePath.startsWith('third_party/')
    ) {
      return false;
    }

    if (relativePath === 'prebuilds') {
      return true;
    }

    if (relativePath.startsWith('prebuilds/')) {
      return relativePath === prebuildRoot || relativePath.startsWith(prebuildPrefix);
    }
  }

  return true;
};

/**
 * Copies one npm package into runtime node_modules with packaging filter rules.
 */
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

/**
 * Recursively syncs production dependencies while skipping built-ins and workspace packages.
 */
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

const collectExportTargetPaths = (exportsField, collectedPaths) => {
  if (!exportsField) {
    return;
  }

  if (typeof exportsField === 'string') {
    if (exportsField.startsWith('./')) {
      collectedPaths.add(exportsField.slice(2));
    }
    return;
  }

  if (Array.isArray(exportsField)) {
    exportsField.forEach((entry) => {
      collectExportTargetPaths(entry, collectedPaths);
    });
    return;
  }

  if (typeof exportsField === 'object') {
    Object.values(exportsField).forEach((entry) => {
      collectExportTargetPaths(entry, collectedPaths);
    });
  }
};

const normalizeExportAssetPath = (exportPath) => {
  const withoutQuery = exportPath.split('?')[0];
  const wildcardIndex = withoutQuery.indexOf('*');
  const pathBeforeWildcard = wildcardIndex >= 0 ? withoutQuery.slice(0, wildcardIndex) : withoutQuery;
  const normalized = pathBeforeWildcard.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized;
};

const copyExportedRuntimeAssets = async (sourcePackageDir, targetPackageDir, packageJsonObject) => {
  const exportTargetPaths = new Set();
  collectExportTargetPaths(packageJsonObject.exports, exportTargetPaths);

  for (const exportTargetPath of exportTargetPaths) {
    const normalizedAssetPath = normalizeExportAssetPath(exportTargetPath);
    if (!normalizedAssetPath) {
      continue;
    }

    const topLevelSegment = normalizedAssetPath.split('/')[0];
    if (!topLevelSegment || topLevelSegment === 'dist' || topLevelSegment === 'package.json') {
      continue;
    }

    const sourceAssetPath = path.join(sourcePackageDir, normalizedAssetPath);
    const targetAssetPath = path.join(targetPackageDir, normalizedAssetPath);

    try {
      const stats = await fs.stat(sourceAssetPath);
      if (stats.isDirectory()) {
        await fs.cp(sourceAssetPath, targetAssetPath, {
          recursive: true,
          force: true,
        });
      } else {
        await fs.mkdir(path.dirname(targetAssetPath), { recursive: true });
        await fs.copyFile(sourceAssetPath, targetAssetPath);
      }
    } catch {
      // Ignore unresolved export placeholders and keep sync resilient.
    }
  }
};

/**
 * Minifies JSON runtime assets after copy while keeping source locale files readable.
 */
const minifyJsonFilesInDirectory = async (directoryPath) => {
  let entries;

  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await minifyJsonFilesInDirectory(entryPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
      continue;
    }

    try {
      const rawJson = await fs.readFile(entryPath, 'utf8');
      await fs.writeFile(entryPath, `${JSON.stringify(JSON.parse(rawJson))}\n`, 'utf8');
    } catch (error) {
      throw new Error(`Failed to minify runtime JSON asset: ${entryPath}`, { cause: error });
    }
  }
};

/**
 * Starts recursion from a curated list of backend entry dependencies.
 */
const syncThirdPartyDependencies = async () => {
  const initialResolvePaths = [backendNodeModulesRoot, i18nNodeModulesRoot, path.join(workspaceRoot, 'node_modules')];

  for (const packageName of thirdPartyEntryPackages) {
    await syncPackageRecursively(packageName, initialResolvePaths);
    console.log(`[main:prebuild] Synced third-party runtime dependency: ${packageName}`);
  }
};

/**
 * Validates that backend package production dependencies resolve from packaged runtime assets.
 *
 * Presence is checked with the same tolerant resolution used during sync:
 * packages whose bare entry cannot be resolved (missing or intentionally
 * absent root export) still count as present when their package directory
 * exists in the packaged runtime, because consumers may only import subpaths.
 */
const validateBackendRuntimeDependencies = async () => {
  const backendPackageJsonPath = path.join(workspaceRoot, 'packages', 'backend', 'package.json');
  const rawPackageJson = await fs.readFile(backendPackageJsonPath, 'utf8');
  const parsedPackageJson = JSON.parse(rawPackageJson);
  const dependencyNames = Object.keys(parsedPackageJson.dependencies ?? {});
  const missingDependencyNames = [];

  for (const dependencyName of dependencyNames) {
    if (dependencyName.startsWith('@cosmosh/')) {
      continue;
    }

    try {
      await resolvePackageRoot(dependencyName, [runtimeNodeModulesRoot]);
    } catch {
      missingDependencyNames.push(dependencyName);
    }
  }

  if (missingDependencyNames.length > 0) {
    throw new Error(
      `Packaged backend runtime is missing production dependencies: ${missingDependencyNames.join(', ')}`,
    );
  }

  console.log('[main:prebuild] Validated packaged backend runtime dependencies.');
};

/**
 * Copies built dist artifacts from workspace packages required by packaged backend runtime.
 */
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
    const sourcePackageJsonRaw = await fs.readFile(sourcePackageJsonPath, 'utf8');
    const sourcePackageJsonObject = JSON.parse(sourcePackageJsonRaw);

    await fs.rm(targetPackageDir, { recursive: true, force: true });
    await fs.mkdir(targetPackageDir, { recursive: true });
    await fs.cp(sourceDistDir, targetDistDir, {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const lowerName = path.basename(sourcePath).toLowerCase();

        if (lowerName.endsWith('.map') || lowerName.endsWith('.d.ts') || lowerName.endsWith('.d.mts')) {
          return false;
        }

        if (packageName === 'i18n' && lowerName === 'index.mjs') {
          return false;
        }

        return true;
      },
    });

    await copyExportedRuntimeAssets(sourcePackageDir, targetPackageDir, sourcePackageJsonObject);
    if (packageName === 'i18n') {
      await minifyJsonFilesInDirectory(path.join(targetPackageDir, 'locales'));
    }
    await fs.copyFile(sourcePackageJsonPath, targetPackageJsonPath);

    if (packageName === 'backend') {
      const sourcePrismaDir = path.join(sourcePackageDir, 'prisma');
      const targetPrismaDir = path.join(targetPackageDir, 'prisma');

      await fs.access(sourcePrismaDir);
      await fs.cp(sourcePrismaDir, targetPrismaDir, {
        recursive: true,
        force: true,
        filter: (sourcePath) => {
          const lowerName = path.basename(sourcePath).toLowerCase();

          if (lowerName.endsWith('.map') || lowerName.endsWith('.d.ts') || lowerName.endsWith('.d.mts')) {
            return false;
          }

          return true;
        },
      });
    }

    console.log(`[main:prebuild] Synced workspace runtime package: @cosmosh/${packageName}`);
  }
};

/**
 * Main orchestration entrypoint for runtime dependency sync.
 */
const syncBackendRuntime = async () => {
  await fs.mkdir(runtimeNodeModulesRoot, { recursive: true });
  await syncThirdPartyDependencies();
  await syncWorkspaceRuntimePackages();
  await validateBackendRuntimeDependencies();
};

syncBackendRuntime().catch((error) => {
  console.error('[main:prebuild] Failed to sync backend runtime dependencies.', error);
  process.exitCode = 1;
});
