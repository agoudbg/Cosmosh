import fs from 'node:fs/promises';

const SOURCE_DIR = new URL('../src/terminal/completion/resources/', import.meta.url);
const DIST_COMPLETION_DIR = new URL('../dist/terminal/completion/', import.meta.url);
const TARGET_DIR = new URL('../dist/terminal/completion/resources/', import.meta.url);
const REQUIRED_FILE_NAMES = [
  'inshellisense-manifest.json',
  'inshellisense-command-specs.json.zst',
  'inshellisense-descriptions.json.zst',
];
const LEGACY_DIST_FILE_NAMES = [
  'generated-inshellisense.d.ts',
  'generated-inshellisense.d.ts.map',
  'generated-inshellisense.js',
  'generated-inshellisense.js.map',
];

const assertCompletionResourcesExist = async () => {
  for (const fileName of REQUIRED_FILE_NAMES) {
    await fs.access(new URL(fileName, SOURCE_DIR));
  }
};

const copyCompletionResources = async () => {
  await assertCompletionResourcesExist();
  for (const fileName of LEGACY_DIST_FILE_NAMES) {
    await fs.rm(new URL(fileName, DIST_COMPLETION_DIR), { force: true });
  }

  await fs.rm(TARGET_DIR, { recursive: true, force: true });
  await fs.mkdir(TARGET_DIR, { recursive: true });
  for (const fileName of REQUIRED_FILE_NAMES) {
    await fs.copyFile(new URL(fileName, SOURCE_DIR), new URL(fileName, TARGET_DIR));
  }

  process.stdout.write('[backend:build] Copied completion runtime resources.\n');
};

copyCompletionResources().catch((error) => {
  process.stderr.write(`[backend:build] Failed to copy completion runtime resources: ${String(error)}\n`);
  process.exitCode = 1;
});
