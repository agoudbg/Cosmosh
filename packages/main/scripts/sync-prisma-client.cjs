const fs = require('node:fs/promises');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '../../..');
const pnpmStoreDir = path.join(workspaceRoot, 'node_modules', '.pnpm');
const runtimeResourcesRoot = path.join(workspaceRoot, 'packages', 'main', 'resources-runtime', 'node_modules');
const targetDir = path.join(runtimeResourcesRoot, '.prisma');
const targetPrismaClientDir = path.join(runtimeResourcesRoot, '@prisma', 'client');

const shouldSkipPrismaArtifact = (sourcePath) => {
  const fileName = path.basename(sourcePath);
  if (/\.tmp\d+$/i.test(fileName)) {
    return true;
  }

  if (fileName.endsWith('.map')) {
    return true;
  }

  if (/query_(engine|compiler)_bg\.(?!sqlite\.)[a-z0-9-]+\.wasm-base64\.(js|mjs)$/i.test(fileName)) {
    return true;
  }

  return false;
};

const findPrismaSourceDirs = async () => {
  const entries = await fs.readdir(pnpmStoreDir, { withFileTypes: true });
  const prismaClientPackageDir = entries.find(
    (entry) =>
      entry.isDirectory() &&
      (entry.name.startsWith('@prisma+client@') || entry.name.startsWith('%40prisma%2Bclient%40')),
  );

  if (!prismaClientPackageDir) {
    throw new Error('Unable to locate @prisma/client in node_modules/.pnpm.');
  }

  const sourceRoot = path.join(pnpmStoreDir, prismaClientPackageDir.name, 'node_modules');
  return {
    prismaRuntimeDir: path.join(sourceRoot, '.prisma'),
    prismaClientDir: path.join(sourceRoot, '@prisma', 'client'),
  };
};

const syncPrismaClient = async () => {
  const { prismaRuntimeDir, prismaClientDir } = await findPrismaSourceDirs();

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.rm(targetPrismaClientDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.mkdir(path.dirname(targetPrismaClientDir), { recursive: true });
  await fs.cp(prismaRuntimeDir, targetDir, {
    recursive: true,
    filter: (sourcePath) => !shouldSkipPrismaArtifact(sourcePath),
  });
  await fs.cp(prismaClientDir, targetPrismaClientDir, {
    recursive: true,
    filter: (sourcePath) => !shouldSkipPrismaArtifact(sourcePath),
  });

  console.log(`[main:prebuild] Synced Prisma runtime: ${prismaRuntimeDir} -> ${targetDir}`);
  console.log(`[main:prebuild] Synced Prisma package: ${prismaClientDir} -> ${targetPrismaClientDir}`);
};

syncPrismaClient().catch((error) => {
  console.error('[main:prebuild] Failed to sync Prisma runtime files.', error);
  process.exitCode = 1;
});
