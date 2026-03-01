import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(__dirname, '../locales');
const skippedScopeFiles = new Set(['backend-inshellisense']);

const flattenKeys = (target, parent = '') => {
  if (!target || typeof target !== 'object') {
    return [];
  }

  return Object.entries(target).flatMap(([key, value]) => {
    const nextPath = parent ? `${parent}.${key}` : key;

    if (typeof value === 'string') {
      return [nextPath];
    }

    if (value && typeof value === 'object') {
      return flattenKeys(value, nextPath);
    }

    return [];
  });
};

const readJson = async (filePath) => {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content);
};

const loadLocales = async () => {
  const localeNames = await readdir(localesDir);
  const entries = [];

  for (const localeName of localeNames) {
    const localePath = path.join(localesDir, localeName);
    const scopeFiles = await readdir(localePath);
    const scoped = {};

    for (const scopeFile of scopeFiles) {
      if (!scopeFile.endsWith('.json')) {
        continue;
      }

      const scopeName = scopeFile.replace(/\.json$/, '');
      scoped[scopeName] = await readJson(path.join(localePath, scopeFile));
    }

    entries.push([localeName, scoped]);
  }

  return Object.fromEntries(entries);
};

const locales = await loadLocales();
const baseLocale = 'en';
const baseScopes = locales[baseLocale];
const errors = [];

for (const [localeName, scopedMessages] of Object.entries(locales)) {
  for (const scopeName of Object.keys(baseScopes)) {
    if (skippedScopeFiles.has(scopeName)) {
      continue;
    }

    const baseKeys = new Set(flattenKeys(baseScopes[scopeName]));
    const currentKeys = new Set(flattenKeys(scopedMessages?.[scopeName] ?? {}));

    for (const key of baseKeys) {
      if (!currentKeys.has(key)) {
        errors.push(`[${localeName}.${scopeName}] missing key: ${key}`);
      }
    }

    for (const key of currentKeys) {
      if (!baseKeys.has(key)) {
        errors.push(`[${localeName}.${scopeName}] extra key: ${key}`);
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }

  process.exit(1);
}

console.log('Locale check passed.');
