import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';

import type { TerminalCommandSpec, TerminalCommandSpecOption, TerminalCommandSpecSubcommand } from './types.js';

type JsonTranslationTree = {
  [key: string]: string | JsonTranslationTree;
};

type CompletionResourceManifest = {
  descriptionI18nKeyPrefix: string;
  specs: {
    fileName: string;
    commandCount: number;
    rawBytes: number;
    compressedBytes: number;
    sha256: string;
  };
  descriptions: {
    fileName: string;
    keyCount: number;
    rawBytes: number;
    compressedBytes: number;
    sha256: string;
  };
};

type CompletionResourceLoaderOverrides = {
  specs?: () => Promise<ReadonlyArray<TerminalCommandSpec>>;
  descriptions?: () => Promise<JsonTranslationTree>;
};

type CompactOption = readonly [
  name: string,
  descriptionKey?: string | null,
  takesValue?: 1 | null,
  insertText?: string | null,
  valueSuggestions?: readonly string[] | null,
];

type CompactSubcommand = readonly [
  name: string,
  descriptionKey?: string | null,
  subcommands?: readonly CompactSubcommand[] | null,
  options?: readonly CompactOption[] | null,
];

type CompactCommandSpec = readonly [
  command: string,
  descriptionKey?: string | null,
  subcommands?: readonly CompactSubcommand[] | null,
  options?: readonly CompactOption[] | null,
];

const brotliDecompressAsync = promisify(brotliDecompress);
const MANIFEST_FILE_NAME = 'inshellisense-manifest.json';
const FALLBACK_DESCRIPTION_I18N_KEY_PREFIX = 'completion.inshellisenseDescriptions.';
const warningKeys = new Set<string>();

let manifestPromise: Promise<CompletionResourceManifest> | null = null;
let specsPromise: Promise<ReadonlyArray<TerminalCommandSpec>> | null = null;
let descriptionPromise: Promise<JsonTranslationTree> | null = null;
let testResourceOverrides: CompletionResourceLoaderOverrides | null = null;

/**
 * Emits each completion resource warning once so repeated requests do not flood logs.
 */
const warnOnce = (key: string, message: string, error: unknown): void => {
  if (warningKeys.has(key)) {
    return;
  }

  warningKeys.add(key);
  console.warn(message, error);
};

/**
 * Reads the generated completion manifest from the runtime resources folder.
 */
const readResourceManifest = async (): Promise<CompletionResourceManifest> => {
  const manifestUrl = new URL(`./resources/${MANIFEST_FILE_NAME}`, import.meta.url);
  const manifestBuffer = await readFile(manifestUrl);

  return JSON.parse(manifestBuffer.toString('utf8')) as CompletionResourceManifest;
};

/**
 * Loads the completion resource manifest once per backend process.
 */
const loadResourceManifest = async (): Promise<CompletionResourceManifest> => {
  manifestPromise ??= readResourceManifest();
  return await manifestPromise;
};

/**
 * Reads and validates one compressed completion resource.
 */
const readCompressedJsonResource = async <T>(fileName: string, expectedSha256: string): Promise<T> => {
  const resourceUrl = new URL(`./resources/${fileName}`, import.meta.url);
  const compressed = await readFile(resourceUrl);
  const rawBuffer = await brotliDecompressAsync(compressed);
  const actualSha256 = createHash('sha256').update(rawBuffer).digest('hex');

  if (actualSha256 !== expectedSha256) {
    throw new Error(`Completion resource hash mismatch for ${fileName}.`);
  }

  return JSON.parse(rawBuffer.toString('utf8')) as T;
};

/**
 * Restores a full backend i18n key from the compact payload form.
 */
const expandDescriptionI18nKey = (descriptionKey: string | null | undefined): string | undefined => {
  if (!descriptionKey) {
    return undefined;
  }

  return descriptionKey.includes('.') ? descriptionKey : `${FALLBACK_DESCRIPTION_I18N_KEY_PREFIX}${descriptionKey}`;
};

/**
 * Inflates compact option tuples into runtime completion spec objects.
 */
const inflateOptions = (
  options: readonly CompactOption[] | null | undefined,
): TerminalCommandSpecOption[] | undefined => {
  if (!options) {
    return undefined;
  }

  return options.map(([name, descriptionKey, takesValue, insertText, valueSuggestions]) => {
    const descriptionI18nKey = expandDescriptionI18nKey(descriptionKey);

    return {
      name,
      ...(descriptionI18nKey ? { descriptionI18nKey } : {}),
      ...(takesValue === 1 ? { takesValue: true } : {}),
      ...(typeof insertText === 'string' ? { insertText } : {}),
      ...(Array.isArray(valueSuggestions) ? { valueSuggestions: [...valueSuggestions] } : {}),
    };
  });
};

/**
 * Inflates compact nested command tuples into runtime completion spec objects.
 */
const inflateSubcommands = (
  subcommands: readonly CompactSubcommand[] | null | undefined,
): TerminalCommandSpecSubcommand[] | undefined => {
  if (!subcommands) {
    return undefined;
  }

  return subcommands.map(([name, descriptionKey, nestedSubcommands, options]) => {
    const descriptionI18nKey = expandDescriptionI18nKey(descriptionKey);

    return {
      name,
      ...(descriptionI18nKey ? { descriptionI18nKey } : {}),
      ...(Array.isArray(nestedSubcommands) ? { subcommands: inflateSubcommands(nestedSubcommands) ?? [] } : {}),
      ...(Array.isArray(options) ? { options: inflateOptions(options) ?? [] } : {}),
    };
  });
};

/**
 * Inflates compact command tuples into the completion engine's runtime shape.
 */
const inflateCommandSpecs = (specs: readonly CompactCommandSpec[]): ReadonlyArray<TerminalCommandSpec> => {
  return specs.map(([command, descriptionKey, subcommands, options]) => {
    const descriptionI18nKey = expandDescriptionI18nKey(descriptionKey);

    return {
      command,
      ...(descriptionI18nKey ? { descriptionI18nKey } : {}),
      ...(Array.isArray(subcommands) ? { subcommands: inflateSubcommands(subcommands) ?? [] } : {}),
      ...(Array.isArray(options) ? { options: inflateOptions(options) ?? [] } : {}),
    };
  });
};

/**
 * Loads the compressed inshellisense command specs on first use.
 */
export const loadInshellisenseCommandSpecs = async (): Promise<ReadonlyArray<TerminalCommandSpec>> => {
  if (testResourceOverrides?.specs) {
    return testResourceOverrides.specs();
  }

  specsPromise ??= loadResourceManifest()
    .then((manifest) =>
      readCompressedJsonResource<CompactCommandSpec[]>(manifest.specs.fileName, manifest.specs.sha256),
    )
    .then((specs) => inflateCommandSpecs(specs))
    .catch((error: unknown) => {
      warnOnce(
        'specs',
        '[completion] Failed to load inshellisense command specs. Built-in command completion is disabled for this process.',
        error,
      );
      return [];
    });

  return specsPromise;
};

/**
 * Loads generated English completion descriptions on first use.
 */
const loadDescriptionTree = async (): Promise<JsonTranslationTree> => {
  if (testResourceOverrides?.descriptions) {
    return testResourceOverrides.descriptions();
  }

  if (descriptionPromise) {
    return descriptionPromise;
  }

  descriptionPromise = loadResourceManifest()
    .then((manifest) =>
      readCompressedJsonResource<JsonTranslationTree>(manifest.descriptions.fileName, manifest.descriptions.sha256),
    )
    .catch((error: unknown) => {
      warnOnce(
        'description',
        '[completion] Failed to load inshellisense descriptions. Completion details will use fallback labels.',
        error,
      );
      return {};
    });

  return descriptionPromise;
};

/**
 * Resolves a dotted translation key from a nested JSON tree.
 */
const resolveTreeValue = (target: JsonTranslationTree, key: string): string | undefined => {
  const result = key.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, target);

  return typeof result === 'string' && result.trim().length > 0 ? result : undefined;
};

/**
 * Resolves a generated English inshellisense description.
 */
export const resolveInshellisenseDescription = async (key: string): Promise<string | undefined> => {
  const currentTree = await loadDescriptionTree();
  return resolveTreeValue(currentTree, key);
};

/**
 * Resets lazy resource state for focused completion-engine tests.
 */
export const resetCompletionResourceLoaderForTests = (): void => {
  manifestPromise = null;
  specsPromise = null;
  descriptionPromise = null;
  warningKeys.clear();
  testResourceOverrides = null;
};

/**
 * Overrides lazy resource reads for focused completion-engine tests.
 */
export const setCompletionResourceLoaderOverridesForTests = (overrides: CompletionResourceLoaderOverrides): void => {
  resetCompletionResourceLoaderForTests();
  testResourceOverrides = overrides;
};
