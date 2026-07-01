import fs from 'node:fs/promises';

const REQUIRED_FILES = [
  new URL('../src/terminal/completion/resources/inshellisense-manifest.json', import.meta.url),
  new URL('../src/terminal/completion/resources/inshellisense-command-specs.json.zst', import.meta.url),
  new URL('../src/terminal/completion/resources/inshellisense-descriptions.json.zst', import.meta.url),
];

const fileExists = async (fileUrl) => {
  try {
    await fs.access(fileUrl);
    return true;
  } catch {
    return false;
  }
};

const needsGeneration = async () => {
  for (const fileUrl of REQUIRED_FILES) {
    if (!(await fileExists(fileUrl))) {
      return true;
    }
  }

  return false;
};

if (await needsGeneration()) {
  const { generateInshellisenseResources } = await import('./generate-inshellisense.mjs');
  await generateInshellisenseResources();
} else {
  process.stdout.write('[backend:build] Completion runtime resources are up-to-date.\n');
}
