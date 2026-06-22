import { createRequire } from 'node:module';

import type { Locale } from '../../i18n-bridge.js';

const require = createRequire(import.meta.url);
const INSHELLISENSE_DESCRIPTION_KEY_PREFIX = 'completion.inshellisenseDescriptions.';

type JsonTranslationTree = {
  [key: string]: string | JsonTranslationTree;
};

type DescriptionCatalog = Readonly<Record<string, string>>;

const EMPTY_DESCRIPTION_CATALOG: DescriptionCatalog = Object.freeze({});
const catalogPromises = new Map<Locale, Promise<DescriptionCatalog>>();

/**
 * Flattens nested JSON translation trees into dotted-key lookup entries.
 *
 * @param tree Translation tree loaded from the generated description catalog.
 * @param prefix Current dotted-key prefix while walking nested objects.
 * @param output Mutable lookup target populated with flattened entries.
 * @returns Flattened lookup target.
 */
const flattenTranslationTree = (
  tree: JsonTranslationTree,
  prefix = '',
  output: Record<string, string> = {},
): Record<string, string> => {
  for (const [key, value] of Object.entries(tree)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      output[nextKey] = value;
      continue;
    }

    flattenTranslationTree(value, nextKey, output);
  }

  return output;
};

/**
 * Loads the generated inshellisense description catalog for one locale.
 *
 * @param locale Locale whose generated catalog should be loaded.
 * @returns Description lookup table keyed by full i18n detail key.
 */
const loadCatalog = async (locale: Locale): Promise<DescriptionCatalog> => {
  try {
    const catalog = require(`@cosmosh/i18n/locales/${locale}/backend-inshellisense.json`) as JsonTranslationTree;
    return flattenTranslationTree(catalog);
  } catch (error: unknown) {
    if (locale !== 'zh-CN') {
      console.warn(`[completion] Failed to load inshellisense description catalog for ${locale}.`, error);
    }

    return EMPTY_DESCRIPTION_CATALOG;
  }
};

/**
 * Returns a cached generated description catalog for one locale.
 *
 * @param locale Locale whose catalog should be returned.
 * @returns Promise resolving to cached description lookup entries.
 */
const getCatalog = async (locale: Locale): Promise<DescriptionCatalog> => {
  const existingPromise = catalogPromises.get(locale);
  if (existingPromise) {
    return existingPromise;
  }

  const nextPromise = loadCatalog(locale);
  catalogPromises.set(locale, nextPromise);
  return nextPromise;
};

/**
 * Resolves generated inshellisense description text without polluting backend i18n resources.
 *
 * @param locale Active backend locale.
 * @param key Full detail i18n key stored in generated command specs.
 * @returns Description text when available, otherwise null.
 */
export const resolveInshellisenseDescription = async (locale: Locale, key: string): Promise<string | null> => {
  if (!key.startsWith(INSHELLISENSE_DESCRIPTION_KEY_PREFIX)) {
    return null;
  }

  const activeCatalog = await getCatalog(locale);
  const activeValue = activeCatalog[key];
  if (activeValue) {
    return activeValue;
  }

  if (locale === 'en') {
    return null;
  }

  const fallbackCatalog = await getCatalog('en');
  return fallbackCatalog[key] ?? null;
};
