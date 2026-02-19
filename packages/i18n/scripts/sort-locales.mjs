import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(__dirname, '../locales');

const mode = process.argv.includes('--check') ? 'check' : 'write';

const sortObjectDeep = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectDeep(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value)
    .map(([key, nestedValue]) => [key, sortObjectDeep(nestedValue)])
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  return Object.fromEntries(entries);
};

const formatJson = (value) => {
  return `${JSON.stringify(value, null, 2)}\n`;
};

const listLocaleJsonFiles = async () => {
  const localeNames = await readdir(localesDir);
  const files = [];

  for (const localeName of localeNames) {
    const localePath = path.join(localesDir, localeName);
    const scopeFiles = await readdir(localePath);

    for (const scopeFile of scopeFiles) {
      if (!scopeFile.endsWith('.json')) {
        continue;
      }

      files.push(path.join(localePath, scopeFile));
    }
  }

  return files;
};

const jsonFiles = await listLocaleJsonFiles();
const unsortedFiles = [];

for (const filePath of jsonFiles) {
  const content = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);
  const sorted = sortObjectDeep(parsed);
  const nextContent = formatJson(sorted);

  if (content !== nextContent) {
    unsortedFiles.push(filePath);

    if (mode === 'write') {
      await writeFile(filePath, nextContent, 'utf8');
    }
  }
}

if (mode === 'check' && unsortedFiles.length > 0) {
  for (const filePath of unsortedFiles) {
    console.error(`Locale file is not key-sorted: ${filePath}`);
  }

  console.error('Run `pnpm --filter @cosmosh/i18n sort` to fix ordering.');
  process.exit(1);
}

if (mode === 'write') {
  console.log(`Sorted locale files: ${unsortedFiles.length}`);
} else {
  console.log('Locale sort check passed.');
}
