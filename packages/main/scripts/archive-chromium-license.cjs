'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const JSZip = require('jszip');

const LICENSE_FILE_NAME = 'LICENSES.chromium.html';
const LICENSE_ARCHIVE_NAME = `${LICENSE_FILE_NAME}.zip`;

/**
 * Returns the locations where electron-builder can place Chromium's license file.
 *
 * @param {import('electron-builder').AfterPackContext} context electron-builder afterPack context.
 * @returns {string[]} Candidate license file paths in priority order.
 */
const getLicensePathCandidates = (context) => {
  const candidates = [path.join(context.appOutDir, LICENSE_FILE_NAME)];
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas';
  const productFilename = context.packager?.appInfo?.productFilename;

  if (isMac && productFilename) {
    candidates.unshift(
      path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources', LICENSE_FILE_NAME),
    );
  }

  return [...new Set(candidates)];
};

/**
 * Finds the license file emitted by the Electron distribution.
 *
 * @param {string[]} candidates Candidate file paths.
 * @returns {Promise<string>} The existing license file path.
 * @throws {Error} If no candidate exists or a candidate cannot be inspected.
 */
const findLicensePath = async (candidates) => {
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Cannot find ${LICENSE_FILE_NAME} in the packaged Electron output. Checked: ${candidates.join(', ')}`,
  );
};

/**
 * Creates a deterministic ZIP containing the original Chromium license HTML.
 *
 * @param {string} licensePath Absolute path to the original license file.
 * @returns {Promise<string>} Absolute path to the generated archive.
 */
const archiveLicense = async (licensePath) => {
  const archivePath = path.join(path.dirname(licensePath), LICENSE_ARCHIVE_NAME);
  const temporaryArchivePath = `${archivePath}.${process.pid}.tmp`;
  const licenseContents = await fs.readFile(licensePath);
  const archive = new JSZip();

  archive.file(LICENSE_FILE_NAME, licenseContents, {
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    date: new Date(0),
    createFolders: false,
  });

  const archiveContents = await archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });

  try {
    await fs.writeFile(temporaryArchivePath, archiveContents, { flag: 'w' });
    await fs.rename(temporaryArchivePath, archivePath);
    await fs.unlink(licensePath);
  } finally {
    await fs.rm(temporaryArchivePath, { force: true });
  }

  return archivePath;
};

/**
 * Replaces Electron's uncompressed Chromium license file with a ZIP archive.
 *
 * @param {import('electron-builder').AfterPackContext} context electron-builder afterPack context.
 * @returns {Promise<void>} Resolves after the archive is written and the source is removed.
 */
module.exports = async function archiveChromiumLicense(context) {
  const licensePath = await findLicensePath(getLicensePathCandidates(context));
  const archivePath = await archiveLicense(licensePath);

  console.log(`afterPack: archived ${licensePath} as ${archivePath}`);
};
