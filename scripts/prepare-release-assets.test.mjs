import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareReleaseAssets, validateReleaseAssetNames } from './prepare-release-assets.mjs';

const COMPLETE_ASSET_NAMES = [
  'Cosmosh-0.1.0.AppImage',
  'Cosmosh-0.1.0.dmg',
  'Cosmosh-0.1.0.deb',
  'Cosmosh-0.1.0-mac.zip',
  'Cosmosh Setup 0.1.0.exe',
];

test('validates and sorts a complete release inventory', () => {
  const shuffledNames = [...COMPLETE_ASSET_NAMES].reverse();
  const validatedNames = validateReleaseAssetNames(shuffledNames);

  assert.deepEqual(validatedNames, [...COMPLETE_ASSET_NAMES].sort());
});

test('rejects an incomplete platform inventory', () => {
  const incompleteNames = COMPLETE_ASSET_NAMES.filter((assetName) => !assetName.endsWith('.dmg'));

  assert.throws(() => validateReleaseAssetNames(incompleteNames), /macOS disk image/);
});

test('rejects unexpected release files', () => {
  assert.throws(() => validateReleaseAssetNames([...COMPLETE_ASSET_NAMES, 'unreviewed-script.sh']), /unexpected assets/);
});

test('writes deterministic SHA256SUMS entries', async () => {
  const releaseDirectory = await mkdtemp(path.join(tmpdir(), 'cosmosh-release-assets-'));
  try {
    for (const assetName of COMPLETE_ASSET_NAMES) {
      await writeFile(path.join(releaseDirectory, assetName), `fixture:${assetName}`, 'utf8');
    }

    const result = await prepareReleaseAssets(releaseDirectory);
    const checksumContents = await readFile(result.checksumPath, 'utf8');
    const checksumLines = checksumContents.trimEnd().split('\n');

    assert.equal(checksumLines.length, COMPLETE_ASSET_NAMES.length);
    assert.deepEqual(
      checksumLines.map((line) => line.slice(66)),
      [...COMPLETE_ASSET_NAMES].sort(),
    );

    const firstAssetName = [...COMPLETE_ASSET_NAMES].sort()[0];
    const expectedDigest = createHash('sha256').update(`fixture:${firstAssetName}`).digest('hex');
    assert.equal(checksumLines[0], `${expectedDigest}  ${firstAssetName}`);
  } finally {
    await rm(releaseDirectory, { recursive: true, force: true });
  }
});
