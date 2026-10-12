'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const archiveChromiumLicense = require('./archive-chromium-license.cjs');
const generateThirdPartyNotices = require('./generate-third-party-notices.cjs');

const PROJECT_LICENSE_FILE_NAME = 'LICENSE';

/**
 * Copies the project's license into the packaged application's legal-files directory.
 *
 * @param {import('electron-builder').AfterPackContext} context electron-builder afterPack context.
 * @param {string} targetDirectory Destination directory for legal files.
 * @returns {Promise<string>} Absolute path to the copied project license.
 */
const copyProjectLicense = async (context, targetDirectory) => {
  const workspaceRoot = path.resolve(context.packager.projectDir, '../..');
  const sourcePath = path.join(workspaceRoot, PROJECT_LICENSE_FILE_NAME);
  const targetPath = path.join(targetDirectory, PROJECT_LICENSE_FILE_NAME);

  await fs.copyFile(sourcePath, targetPath);
  return targetPath;
};

/**
 * Runs all legal-document packaging steps after electron-builder assembles the app directory.
 *
 * @param {import('electron-builder').AfterPackContext} context electron-builder afterPack context.
 * @returns {Promise<void>} Resolves after all legal documents are written.
 */
module.exports = async function afterPack(context) {
  await archiveChromiumLicense(context);

  const targetDirectory = generateThirdPartyNotices.getLegalFilesDirectory(context);
  const projectLicensePath = await copyProjectLicense(context, targetDirectory);
  const noticePath = await generateThirdPartyNotices(context);

  console.log('afterPack: copied project license to ' + projectLicensePath);
  console.log('afterPack: generated third-party notices at ' + noticePath);
};
