import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const OUTPUT_FILE = new URL('../src/terminal/completion/generated-inshellisense.ts', import.meta.url);
const I18N_EN_OUTPUT_FILE = new URL('../../i18n/locales/en/backend-inshellisense.json', import.meta.url);
const I18N_ZH_CN_OUTPUT_FILE = new URL('../../i18n/locales/zh-CN/backend-inshellisense.json', import.meta.url);
const require = createRequire(import.meta.url);

const toArray = (value) => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const sanitizeText = (value, options = { trim: true }) => {
  if (typeof value !== 'string') {
    return '';
  }

  const withoutLineSeparators = value.replaceAll('\u2028', ' ').replaceAll('\u2029', ' ');
  return options.trim === false ? withoutLineSeparators : withoutLineSeparators.trim();
};

const toDescriptionI18nKey = (seed) => {
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 8);

  // Extract readable command context from seed
  // Seed format: "cmd:git", "sub:git push", "opt:git push:--force"
  let readablePart = '';
  if (seed.startsWith('cmd:')) {
    readablePart = seed.slice(4);
  } else if (seed.startsWith('sub:')) {
    readablePart = seed.slice(4);
  } else if (seed.startsWith('opt:')) {
    // Convert "opt:git push:--force" to "git push --force"
    readablePart = seed.slice(4).replace(':', ' ');
  }

  // Sanitize readable part for use in key (replace special chars with underscore)
  const sanitizedReadable = readablePart
    .replace(/[^a-zA-Z0-9\-_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

  const keyPart = sanitizedReadable ? `${sanitizedReadable}_${hash}` : hash;
  return `completion.inshellisenseDescriptions.${keyPart}`;
};

const ensureTreePath = (target, pathKey, value) => {
  const segments = String(pathKey || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return;
  }

  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }

    cursor = cursor[segment];
  }

  cursor[segments[segments.length - 1]] = value;
};

const getTreePathValue = (target, pathKey) => {
  const segments = String(pathKey || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return undefined;
  }

  let cursor = target;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !(segment in cursor)) {
      return undefined;
    }

    cursor = cursor[segment];
  }

  return cursor;
};

const registerDescriptionEntry = (catalog, seed, description) => {
  const normalizedDescription = sanitizeText(description, { trim: true });
  if (!normalizedDescription) {
    return undefined;
  }

  const key = toDescriptionI18nKey(seed);
  catalog.set(key, normalizedDescription);
  return key;
};

const readJsonFileOrDefault = async (fileUrl, fallbackValue) => {
  try {
    const content = await fs.readFile(fileUrl, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallbackValue;
  }
};

const normalizeSpecRoot = (specValue) => {
  if (!specValue) {
    return null;
  }

  if (typeof specValue === 'function') {
    try {
      return specValue();
    } catch {
      return null;
    }
  }

  if (typeof specValue === 'object') {
    return specValue;
  }

  return null;
};

const normalizeName = (name) => {
  if (typeof name === 'string') {
    return sanitizeText(name);
  }

  if (Array.isArray(name)) {
    return name
      .map((item) => (typeof item === 'string' ? sanitizeText(item) : ''))
      .find((item) => item.length > 0) ?? null;
  }

  return null;
};

const normalizeNameList = (value) => {
  const names = toArray(value)
    .map((item) => (typeof item === 'string' ? sanitizeText(item) : ''))
    .filter((item) => item.length > 0);
  return Array.from(new Set(names));
};

const normalizeSuggestionEntries = (value) => {
  const suggestions = toArray(value)
    .flatMap((entry) => {
      if (typeof entry === 'string') {
        return [sanitizeText(entry)];
      }

      if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
        return [sanitizeText(entry.name)];
      }

      return [];
    })
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(suggestions));
};

const normalizeOptionArgMetadata = (entry) => {
  const args = toArray(entry?.args).filter((item) => item && typeof item === 'object');
  if (args.length === 0) {
    return {
      takesValue: false,
      valueSuggestions: [],
    };
  }

  const valueSuggestions = Array.from(
    new Set(
      args.flatMap((arg) => {
        return normalizeSuggestionEntries(arg?.suggestions);
      }),
    ),
  );

  return {
    takesValue: true,
    valueSuggestions,
  };
};

const findSubcommandNodeBySegment = (specNode, segment) => {
  if (!specNode || typeof specNode !== 'object') {
    return null;
  }

  const normalizedSegment = String(segment || '').trim().toLowerCase();
  if (!normalizedSegment) {
    return null;
  }

  const subcommands = toArray(specNode.subcommands);
  for (const subcommand of subcommands) {
    const names = normalizeNameList(subcommand?.name);
    if (names.some((name) => name.toLowerCase() === normalizedSegment)) {
      return subcommand;
    }
  }

  return null;
};

const resolveSpecNodeForEntry = (rootSpec, entryPath) => {
  const root = normalizeSpecRoot(rootSpec);
  if (!root || typeof root !== 'object') {
    return null;
  }

  const segments = String(entryPath || '')
    .split('/')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (segments.length <= 1) {
    return root;
  }

  let cursor = root;
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextNode = findSubcommandNodeBySegment(cursor, segment);
    if (!nextNode) {
      return null;
    }

    cursor = nextNode;
  }

  return cursor;
};

const normalizeOptionEntries = (specNode, descriptionCatalog, commandPath) => {
  return toArray(specNode?.options)
    .flatMap((entry) => {
      const names = normalizeNameList(entry?.name);
      const metadata = normalizeOptionArgMetadata(entry);
      const normalizedDescription =
        typeof entry?.description === 'string' ? sanitizeText(entry.description, { trim: false }) : undefined;

      return names.map((name) => ({
        name,
        takesValue: metadata.takesValue,
        valueSuggestions: metadata.valueSuggestions,
        descriptionI18nKey: registerDescriptionEntry(descriptionCatalog, `opt:${commandPath}:${name}`, normalizedDescription),
      }));
    })
    .filter((entry) => entry.name.length > 0);
};

const normalizeSubcommandEntries = (specNode, descriptionCatalog, commandPath, visitedNodes = new WeakSet()) => {
  const normalizeSubcommandNode = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    if (visitedNodes.has(entry)) {
      return [];
    }

    visitedNodes.add(entry);
    const names = normalizeNameList(entry?.name);
    if (names.length === 0) {
      return [];
    }

    const primaryName = names[0] ?? '';
    const nextCommandPath = `${commandPath} ${primaryName}`.trim();
    const nestedSubcommands = normalizeSubcommandEntries(entry, descriptionCatalog, nextCommandPath, visitedNodes);
    const nestedOptions = normalizeOptionEntries(entry, descriptionCatalog, nextCommandPath);
    const normalizedDescription =
      typeof entry?.description === 'string' ? sanitizeText(entry.description, { trim: false }) : undefined;

    return names.map((name) => ({
      name,
      descriptionI18nKey: registerDescriptionEntry(
        descriptionCatalog,
        `sub:${commandPath} ${name}`,
        normalizedDescription,
      ),
      subcommands: nestedSubcommands,
      options: nestedOptions,
    }));
  };

  return toArray(specNode?.subcommands)
    .flatMap((entry) => normalizeSubcommandNode(entry))
    .filter((entry) => entry.name.length > 0);
};

const createSpecEntry = (entryPath, sourceSpec, descriptionCatalog) => {
  const specNode = resolveSpecNodeForEntry(sourceSpec, entryPath);
  const normalizedCommand = sanitizeText(entryPath.replaceAll('/', ' '));

  if (!specNode || typeof specNode !== 'object' || !normalizedCommand) {
    return {
      command: normalizedCommand,
    };
  }

  const normalizedDescription =
    typeof specNode.description === 'string' ? sanitizeText(specNode.description, { trim: false }) : undefined;
  const subcommands = normalizeSubcommandEntries(specNode, descriptionCatalog, normalizedCommand);
  const options = normalizeOptionEntries(specNode, descriptionCatalog, normalizedCommand);

  return {
    command: normalizedCommand,
    descriptionI18nKey: registerDescriptionEntry(
      descriptionCatalog,
      `cmd:${normalizedCommand}`,
      normalizedDescription,
    ),
    subcommands,
    options,
  };
};

const resolveLinkedSpecPath = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return sanitizeText(value).replace(/\.js$/i, '');
  }

  if (typeof value === 'function') {
    try {
      const resolved = value();
      if (typeof resolved === 'string') {
        return sanitizeText(resolved).replace(/\.js$/i, '');
      }
    } catch {
      return null;
    }
  }

  if (typeof value === 'object' && typeof value.path === 'string') {
    return sanitizeText(value.path).replace(/\.js$/i, '');
  }

  if (typeof value === 'object' && typeof value.command === 'string') {
    const normalized = sanitizeText(value.command).replaceAll(' ', '/');
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
};

const collectLinkedSpecPaths = (specNode, parentEntryPath) => {
  const visitedNodes = new WeakSet();
  const linkedPaths = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (visitedNodes.has(node)) {
      return;
    }

    visitedNodes.add(node);
    const subcommands = toArray(node.subcommands);

    for (const subcommand of subcommands) {
      const linkedModulePath = resolveLinkedSpecPath(subcommand?.loadSpec);
      if (linkedModulePath) {
        linkedPaths.add(linkedModulePath);
      }

      walk(subcommand);
    }
  };

  walk(specNode);
  return Array.from(linkedPaths);
};

const generate = async () => {
  const indexPath = require.resolve('@withfig/autocomplete');
  const buildDir = path.dirname(indexPath);
  const indexModule = await import(pathToFileURL(indexPath).href);
  const specList = toArray(indexModule.default)
    .map((entry) => (typeof entry === 'string' ? entry : null))
    .filter(Boolean);

  const uniqueSpecPaths = Array.from(new Set(specList.map((entry) => entry.trim()).filter(Boolean))).sort();
  const pendingSpecPaths = [...uniqueSpecPaths];
  const enqueuedPaths = new Set(uniqueSpecPaths);
  const entries = [];
  const byCommand = new Map();
  const descriptionCatalog = new Map();

  while (pendingSpecPaths.length > 0) {
    const specPathEntry = pendingSpecPaths.shift();
    if (!specPathEntry) {
      continue;
    }

    const directSpecPath = path.join(buildDir, `${specPathEntry}.js`);
    const rootCommandName = specPathEntry.split('/')[0];
    const rootSpecPath = path.join(buildDir, `${rootCommandName}.js`);

    try {
      const specModule = await import(pathToFileURL(directSpecPath).href);
      const specEntry = createSpecEntry(specPathEntry, specModule.default, descriptionCatalog);
      if (specEntry.command) {
        byCommand.set(specEntry.command, specEntry);
      }

      const specNode = resolveSpecNodeForEntry(specModule.default, specPathEntry);
      collectLinkedSpecPaths(specNode, specPathEntry).forEach((linkedPath) => {
        if (!enqueuedPaths.has(linkedPath)) {
          enqueuedPaths.add(linkedPath);
          pendingSpecPaths.push(linkedPath);
        }
      });
    } catch {
      try {
        const rootSpecModule = await import(pathToFileURL(rootSpecPath).href);
        const specEntry = createSpecEntry(specPathEntry, rootSpecModule.default, descriptionCatalog);
        if (specEntry.command) {
          byCommand.set(specEntry.command, specEntry);
        }

        const specNode = resolveSpecNodeForEntry(rootSpecModule.default, specPathEntry);
        collectLinkedSpecPaths(specNode, specPathEntry).forEach((linkedPath) => {
          if (!enqueuedPaths.has(linkedPath)) {
            enqueuedPaths.add(linkedPath);
            pendingSpecPaths.push(linkedPath);
          }
        });
      } catch {
        const fallbackCommand = sanitizeText(specPathEntry.replaceAll('/', ' '));
        if (fallbackCommand) {
          byCommand.set(fallbackCommand, { command: fallbackCommand });
        }
      }
    }
  }

  entries.push(...Array.from(byCommand.values()).sort((left, right) => left.command.localeCompare(right.command)));

  const enInshellisenseLocaleTree = {};
  descriptionCatalog.forEach((description, key) => {
    ensureTreePath(enInshellisenseLocaleTree, key, description);
  });

  const existingEnInshellisenseLocaleTree = await readJsonFileOrDefault(I18N_EN_OUTPUT_FILE, {});
  const existingZhCnInshellisenseLocaleTree = await readJsonFileOrDefault(I18N_ZH_CN_OUTPUT_FILE, {});
  const zhCnInshellisenseLocaleTree = {};
  descriptionCatalog.forEach((description, key) => {
    const existingEnglishDescription = getTreePathValue(existingEnInshellisenseLocaleTree, key);
    const existingTranslation = getTreePathValue(existingZhCnInshellisenseLocaleTree, key);

    const hasManualTranslation =
      typeof existingTranslation === 'string' &&
      existingTranslation.trim().length > 0 &&
      typeof existingEnglishDescription === 'string' &&
      existingTranslation !== existingEnglishDescription;
    const englishSourceUnchanged =
      typeof existingEnglishDescription === 'string' && existingEnglishDescription === description;

    if (hasManualTranslation && englishSourceUnchanged) {
      ensureTreePath(zhCnInshellisenseLocaleTree, key, existingTranslation);
    }
  });

  const fileContent = `/* eslint-disable */\n/* prettier-ignore */\nimport type { TerminalCommandSpec } from './types.js';\n\n/**\n * Auto-generated from @withfig/autocomplete resources.\n * Run \`pnpm --filter @cosmosh/backend completion:generate\` to refresh.\n */\nexport const INSHELLISENSE_COMMAND_SPECS: ReadonlyArray<TerminalCommandSpec> = ${JSON.stringify(entries, null, 2)};\n`;
  const safeFileContent = fileContent.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const enLocaleContent = `${JSON.stringify(enInshellisenseLocaleTree, null, 2)}\n`;
  const zhCnLocaleContent = `${JSON.stringify(zhCnInshellisenseLocaleTree, null, 2)}\n`;

  await fs.writeFile(OUTPUT_FILE, safeFileContent, 'utf8');
  await fs.writeFile(I18N_EN_OUTPUT_FILE, enLocaleContent, 'utf8');
  await fs.writeFile(I18N_ZH_CN_OUTPUT_FILE, zhCnLocaleContent, 'utf8');
  process.stdout.write(
    `Generated ${entries.length} command specs and ${descriptionCatalog.size} inshellisense description locales.\n`,
  );
};

generate().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
