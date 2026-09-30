import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECKSUM_FILENAME = 'SHA256SUMS';

const REQUIRED_EXACT_ASSETS = [];

const REQUIRED_RELEASE_EXTENSIONS = [
  ['Windows installer', '.exe'],
  ['Linux AppImage', '.AppImage'],
  ['Linux Debian package', '.deb'],
  ['macOS disk image', '.dmg'],
  ['macOS archive', '.zip'],
];

/**
 * Sorts release asset names using stable ASCII ordering.
 *
 * @param {string} left - The left asset name.
 * @param {string} right - The right asset name.
 * @returns {number} The comparison result.
 */
function compareAssetNames(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Validates that the assembled release contains every platform contract.
 *
 * @param {string[]} assetNames - Flat release asset file names.
 * @returns {string[]} A sorted copy of the validated asset names.
 * @throws {Error} When an expected asset is missing or a name is unsafe for checksum output.
 */
export function validateReleaseAssetNames(assetNames) {
  const uniqueNames = new Set(assetNames);
  if (uniqueNames.size !== assetNames.length) {
    throw new Error('Release assets must have unique file names.');
  }

  for (const assetName of assetNames) {
    if (/\r|\n/.test(assetName)) {
      throw new Error(`Release asset names cannot contain line breaks: ${JSON.stringify(assetName)}`);
    }
  }

  const inventoryErrors = REQUIRED_EXACT_ASSETS.filter((assetName) => !uniqueNames.has(assetName)).map(
    (assetName) => `missing ${assetName}`,
  );
  for (const [label, extension] of REQUIRED_RELEASE_EXTENSIONS) {
    const matchingAssets = assetNames.filter((assetName) => assetName.endsWith(extension));
    if (matchingAssets.length !== 1) {
      inventoryErrors.push(`expected exactly one ${label} (*${extension}), found ${matchingAssets.length}`);
    }
  }

  const unexpectedAssets = assetNames.filter(
    (assetName) =>
      !REQUIRED_EXACT_ASSETS.includes(assetName) &&
      !REQUIRED_RELEASE_EXTENSIONS.some(([, extension]) => assetName.endsWith(extension)),
  );
  if (unexpectedAssets.length > 0) {
    inventoryErrors.push(`unexpected assets: ${unexpectedAssets.join(', ')}`);
  }

  if (inventoryErrors.length > 0) {
    throw new Error(`Release asset inventory is invalid: ${inventoryErrors.join('; ')}`);
  }

  return [...assetNames].sort(compareAssetNames);
}

/**
 * Computes the SHA-256 digest of a file without loading the artifact into memory.
 *
 * @param {string} filePath - Absolute path of the artifact to hash.
 * @returns {Promise<string>} The lowercase hexadecimal digest.
 */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

/**
 * Validates a flat release directory and writes its deterministic checksum manifest.
 *
 * @param {string} releaseDirectory - Directory containing downloaded workflow artifacts.
 * @returns {Promise<{ assetNames: string[]; checksumPath: string }>} The validated inventory and checksum path.
 */
export async function prepareReleaseAssets(releaseDirectory) {
  const absoluteDirectory = path.resolve(releaseDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const nonFileEntries = entries.filter((entry) => !entry.isFile());
  if (nonFileEntries.length > 0) {
    throw new Error(
      `Release asset directory must be flat and contain files only: ${nonFileEntries.map((entry) => entry.name).join(', ')}`,
    );
  }

  const assetNames = validateReleaseAssetNames(
    entries.map((entry) => entry.name).filter((assetName) => assetName !== CHECKSUM_FILENAME),
  );
  const checksumLines = [];

  for (const assetName of assetNames) {
    const digest = await sha256File(path.join(absoluteDirectory, assetName));
    checksumLines.push(`${digest}  ${assetName}`);
  }

  const checksumPath = path.join(absoluteDirectory, CHECKSUM_FILENAME);
  await writeFile(checksumPath, `${checksumLines.join('\n')}\n`, 'utf8');
  return { assetNames, checksumPath };
}

/**
 * Runs the release preparation command and reports errors with actionable context.
 *
 * @returns {Promise<void>} Resolves after the checksum manifest is written.
 */
async function main() {
  const releaseDirectory = process.argv[2];
  if (!releaseDirectory) {
    throw new Error('Usage: node scripts/prepare-release-assets.mjs <release-directory>');
  }

  const result = await prepareReleaseAssets(releaseDirectory);
  console.log(`Prepared ${result.assetNames.length} release assets and ${result.checksumPath}.`);
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedModuleUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
