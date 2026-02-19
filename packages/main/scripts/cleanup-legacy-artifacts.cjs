const fs = require('node:fs/promises');
const path = require('node:path');

const mainPackageRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(mainPackageRoot, 'release');

const cleanupReleaseOutputDirectory = async () => {
  try {
    await fs.rm(releaseDir, { recursive: true, force: true });
    await fs.mkdir(releaseDir, { recursive: true });
    console.log('[main:prebuild] Recreated clean release directory.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reset release directory before build. ${message}`);
  }
};

const cleanupLegacyReleaseArtifacts = async () => {
  const entries = await fs.readdir(mainPackageRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('release-fix')) {
      continue;
    }

    const targetPath = path.join(mainPackageRoot, entry.name);

    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      console.log(`[main:prebuild] Removed legacy artifact directory: ${entry.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[main:prebuild] Unable to remove legacy artifact directory: ${entry.name}. ${message}`);
    }
  }
};

Promise.all([cleanupReleaseOutputDirectory(), cleanupLegacyReleaseArtifacts()]).catch((error) => {
  console.error('[main:prebuild] Failed while preparing build artifacts.', error);
  process.exitCode = 1;
});
