/* eslint-disable */
/* prettier-ignore */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode } from '@msgpack/msgpack';

import type {
  TerminalCommandSpec,
  TerminalCommandSpecOption,
  TerminalCommandSpecSubcommand,
} from './types.js';

const DESCRIPTION_I18N_KEY_PREFIX = 'completion.inshellisenseDescriptions.';
const COMPACT_SPECS_ASSET_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'generated-inshellisense.msgpack');

export const INSHELLISENSE_COMMAND_SPECS_COMPACT_SHA256 = 'fdf844b0b640b8dd1db3e15dd9f2f5347e6aea6e6a14d9f1d779b5d2751204f8';

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

const expandDescriptionI18nKey = (descriptionKey: string | null | undefined): string | undefined => {
  if (!descriptionKey) {
    return undefined;
  }

  return descriptionKey.includes('.') ? descriptionKey : `${DESCRIPTION_I18N_KEY_PREFIX}${descriptionKey}`;
};

const inflateOptions = (options: readonly CompactOption[] | null | undefined): TerminalCommandSpecOption[] | undefined => {
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

export const inflateCommandSpecs = (specs: readonly CompactCommandSpec[]): ReadonlyArray<TerminalCommandSpec> => {
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
 * Loads compact inshellisense command specs from the generated MessagePack asset.
 * @returns Compact command specs decoded from the generated runtime asset.
 */
export const loadCompactInshellisenseCommandSpecs = (): readonly CompactCommandSpec[] => {
  try {
    const decoded = decode(readFileSync(COMPACT_SPECS_ASSET_PATH));
    if (!Array.isArray(decoded)) {
      throw new Error('Decoded payload is not an array.');
    }

    return decoded as CompactCommandSpec[];
  } catch (error: unknown) {
    throw new Error(`Failed to load generated inshellisense MessagePack asset: ${COMPACT_SPECS_ASSET_PATH}`, {
      cause: error,
    });
  }
};

/**
 * Auto-generated from @withfig/autocomplete resources.
 * Run `pnpm --filter @cosmosh/backend completion:generate` to refresh.
 */
export const INSHELLISENSE_COMMAND_SPECS: ReadonlyArray<TerminalCommandSpec> = inflateCommandSpecs(
  loadCompactInshellisenseCommandSpecs(),
);
