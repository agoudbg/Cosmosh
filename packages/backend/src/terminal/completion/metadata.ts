import type { ShellCompletionCandidate } from '@cosmosh/api-contract';

import { INSHELLISENSE_COMMAND_SPECS } from './generated-inshellisense.js';
import { scoreCompletionMatch } from './matching.js';
import type { TerminalCommandSpec } from './types.js';

/** Private catalogue output, consumed only by snapshot-bound quoting and edit construction. */
export type CommandMetadataCandidate = Pick<ShellCompletionCandidate, 'label' | 'detailI18nKey'> & {
  insertText: string;
  kind: 'command' | 'subcommand' | 'option';
  score: number;
  insertion: 'literal' | 'words';
};

/** @param command Catalogue-owned spelling. @returns Explicit compound aliases without normalizing user text. */
const specCommandPaths = (command: string): string[] => {
  const paths = [command];
  const tokens = command.split(' ').filter(Boolean);
  if (tokens.length === 1 && tokens[0].includes('-')) paths.push(tokens[0].replaceAll('-', ' '));
  if (tokens.length === 2) paths.push(tokens.join('-'));
  return paths;
};

/** @returns A stable first-entry index that preserves the imported catalogue's alias precedence. */
const indexCommandSpecs = (): Map<string, TerminalCommandSpec> => {
  const result = new Map<string, TerminalCommandSpec>();
  for (const spec of INSHELLISENSE_COMMAND_SPECS) {
    for (const name of specCommandPaths(spec.command)) {
      const normalized = name.trim().toLowerCase();
      if (normalized && !result.has(normalized)) result.set(normalized, spec);
    }
  }
  return result;
};
const SPEC_BY_COMMAND_PATH = indexCommandSpecs();

/** @param commandPath Actual decoded words joined at explicit boundaries. @returns Only a case-exact catalogue match. */
const resolveSpec = (commandPath: string): TerminalCommandSpec | undefined => {
  const spec = SPEC_BY_COMMAND_PATH.get(commandPath.trim().toLowerCase());
  return spec && specCommandPaths(spec.command).includes(commandPath) ? spec : undefined;
};

/**
 * Resolves completed command words without treating the active word as an accepted subcommand.
 * @param tokens Snapshot-decoded words. @param tokenIndex Active word position.
 * @returns The most specific supported command and the exact prefix it consumed.
 */
const resolveSpecContext = (
  tokens: string[],
  tokenIndex: number,
): { spec: TerminalCommandSpec; matchedTokens: string[] } | null => {
  const fixedTokens = tokens.slice(0, Math.max(0, tokenIndex));
  if (!fixedTokens.length) return null;
  for (let length = fixedTokens.length; length >= 1; length -= 1) {
    const candidateTokens = fixedTokens.slice(0, length);
    const candidate = candidateTokens.some((token) => /[\t ]/u.test(token))
      ? undefined
      : resolveSpec(candidateTokens.join(' '));
    if (!candidate) continue;
    const next = fixedTokens[length];
    if (next && !next.startsWith('-')) continue;
    return { spec: candidate, matchedTokens: candidateTokens };
  }
  const root = resolveSpec(fixedTokens[0]);
  if (!root) return null;
  let cursor: Pick<TerminalCommandSpec, 'descriptionI18nKey' | 'subcommands' | 'options'> = root;
  const matchedTokens = [fixedTokens[0]];
  for (let index = 1; index < fixedTokens.length; index += 1) {
    const token = fixedTokens[index];
    if (!token || token.startsWith('-')) break;
    if (index === 1) {
      const compound = resolveSpec(`${fixedTokens[0]}-${token}`);
      if (compound) {
        matchedTokens.push(token);
        cursor = compound;
        continue;
      }
    }
    const child = cursor.subcommands?.find((entry) => entry.name === token);
    if (!child) break;
    matchedTokens.push(token);
    cursor = child;
  }
  return {
    spec: {
      command: matchedTokens.join(' ').trim(),
      descriptionI18nKey: cursor.descriptionI18nKey,
      subcommands: cursor.subcommands,
      options: cursor.options,
    },
    matchedTokens,
  };
};

/** @param command Completed command. @param suffix Static snippet. @returns A readable catalogue label. */
const commandLabel = (command: string, suffix: string): string =>
  [command.trim(), suffix.trim()].filter(Boolean).join(' ');

/** @param query Literal prefix. @param fuzzyMatch Matching preference. @returns Static command snippets only. */
const collectCommands = (query: string, fuzzyMatch: boolean): CommandMetadataCandidate[] => {
  if (!query) return [];
  const items: CommandMetadataCandidate[] = [];
  const seen = new Set<string>();
  for (const spec of INSHELLISENSE_COMMAND_SPECS) {
    const names = new Set([
      spec.command,
      ...(spec.subcommands ?? []).map((entry) => commandLabel(spec.command, entry.name)),
    ]);
    for (const label of names) {
      if (!label || seen.has(label)) continue;
      const score = scoreCompletionMatch(query, label, fuzzyMatch);
      if (score <= 0) continue;
      seen.add(label);
      items.push({
        label,
        insertText: label,
        detailI18nKey: spec.descriptionI18nKey,
        kind: label.includes(' ') ? 'subcommand' : 'command',
        score: score + 180,
        insertion: 'words',
      });
    }
  }
  return items;
};

/**
 * Keeps catalogue argument values literal, including spaces that must remain inside one argument.
 * @param spec Qualified command. @param optionName Exact flag. @param query Actual value prefix.
 * @param fuzzyMatch Matching preference. @returns Static values with no word-splitting permission.
 */
const collectOptionValues = (
  spec: TerminalCommandSpec,
  optionName: string,
  query: string,
  fuzzyMatch: boolean,
): CommandMetadataCandidate[] => {
  const option = spec.options?.find((entry) => entry.name === optionName);
  if (!option?.takesValue) return [];
  const items: CommandMetadataCandidate[] = [];
  for (const value of new Set(option.valueSuggestions ?? [])) {
    if (!value) continue;
    const score = query ? scoreCompletionMatch(query, value, fuzzyMatch) : 540;
    if (score > 0)
      items.push({
        label: commandLabel(spec.command, `${optionName} ${value}`),
        insertText: value,
        detailI18nKey: option.descriptionI18nKey,
        kind: 'option',
        score: score + 230,
        insertion: 'literal',
      });
  }
  return items;
};

/**
 * Reads static subcommands and flags without repeating already completed options.
 * @param spec Qualified command. @param query Active word prefix. @param fuzzyMatch Matching preference.
 * @param usedOptions Exact completed flags. @returns Catalogue-owned snippets for snapshot quoting.
 */
const collectNested = (
  spec: TerminalCommandSpec,
  query: string,
  fuzzyMatch: boolean,
  usedOptions: ReadonlySet<string>,
): CommandMetadataCandidate[] => {
  const items: CommandMetadataCandidate[] = [];
  for (const entry of spec.subcommands ?? []) {
    const score = query ? scoreCompletionMatch(query, entry.name, fuzzyMatch) : 520;
    if (score > 0)
      items.push({
        label: commandLabel(spec.command, entry.name),
        insertText: entry.name,
        detailI18nKey: entry.descriptionI18nKey,
        kind: 'subcommand',
        score: score + 220,
        insertion: 'words',
      });
  }
  for (const entry of spec.options ?? []) {
    const name = entry.name.trim();
    if (!name || usedOptions.has(name)) continue;
    const score = query ? scoreCompletionMatch(query, name, fuzzyMatch) : 510;
    if (score > 0)
      items.push({
        label: commandLabel(spec.command, name),
        insertText: entry.insertText ?? (entry.takesValue ? `${name} ` : name),
        detailI18nKey: entry.descriptionI18nKey,
        kind: 'option',
        score: score + 210,
        insertion: 'words',
      });
  }
  return items;
};

/**
 * Reads the static catalogue from snapshot-decoded words, without reparsing guessed terminal text.
 * Unknown flags, unresolved subcommands and the end-of-options marker stop metadata interpretation.
 * @param tokens Literal words. @param tokenIndex Active word index. @param prefix Actual prefix in that word.
 * @param fuzzyMatch Matching preference. @returns Private metadata drafts; nothing is executed or sent as raw edits.
 */
export const resolveCommandMetadata = (
  tokens: string[],
  tokenIndex: number,
  prefix: string,
  fuzzyMatch: boolean,
): CommandMetadataCandidate[] => {
  if (tokenIndex === 0) return collectCommands(prefix, fuzzyMatch);
  if (!/^[A-Za-z0-9_.+-]+$/u.test(tokens[0] ?? '')) return [];
  const context = resolveSpecContext(tokens, tokenIndex);
  if (!context) return [];
  const usedOptions = new Set<string>();
  for (let index = context.matchedTokens.length; index < tokenIndex; index += 1) {
    const token = tokens[index];
    if (token === '--') return [];
    const option = context.spec.options?.find((entry) => entry.name === token);
    if (option) {
      usedOptions.add(option.name);
      if (option.takesValue) {
        if (index + 1 === tokenIndex) return collectOptionValues(context.spec, option.name, prefix, fuzzyMatch);
        index += 1;
      }
    } else if (token.startsWith('-') || context.spec.subcommands?.length) return [];
  }
  return collectNested(context.spec, prefix, fuzzyMatch, usedOptions);
};
