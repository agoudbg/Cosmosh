import fs from 'node:fs/promises';

const SOURCE_DIR = new URL('../src/terminal/completion/resources/', import.meta.url);
const TARGET_DIR = new URL('../dist/terminal/completion/resources/', import.meta.url);
const REQUIRED_FILE_NAMES = [
  'inshellisense-manifest.json',
  'inshellisense-command-specs.json.br',
  'inshellisense-descriptions.json.br',
];

const assertCompletionResourcesExist = async () => {
  for (const fileName of REQUIRED_FILE_NAMES) {
    await fs.access(new URL(fileName, SOURCE_DIR));
  }
};

const copyCompletionResources = async () => {
  await assertCompletionResourcesExist();
  await fs.mkdir(TARGET_DIR, { recursive: true });
  await fs.cp(SOURCE_DIR, TARGET_DIR, {
    recursive: true,
    force: true,
  });

  process.stdout.write('[backend:build] Copied completion runtime resources.\n');
};

copyCompletionResources().catch((error) => {
  process.stderr.write(`[backend:build] Failed to copy completion runtime resources: ${String(error)}\n`);
  process.exitCode = 1;
});
