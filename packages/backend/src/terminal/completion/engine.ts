import { INSHELLISENSE_COMMAND_SPECS } from './generated-inshellisense.js';
import { scoreCompletionMatch } from './matching.js';
import type {
  TerminalCommandSpec,
  TerminalCompletionItem,
  TerminalCompletionRequest,
  TerminalCompletionResponse,
  TerminalPathCompletionContext,
  TerminalPathEntry,
} from './types.js';

const DEFAULT_COMPLETION_LIMIT = 8;
const MAX_COMPLETION_LIMIT = 16;
const MAX_PATH_ITEMS = 40;
const TYPING_PATH_PROVIDER_TIMEOUT_MS = 55;
const MAX_HISTORY_ITEMS_TYPING = 160;
const MAX_HISTORY_ITEMS_MANUAL = 1_200;

type CompletionRuntimeOptions = {
  recentCommands: string[];
  pathProvider?: (context: TerminalPathCompletionContext) => Promise<TerminalPathEntry[]>;
  typingPathProviderTimeoutMs?: number;
  tokenizerMode?: TerminalTokenizerMode;
};

type TerminalTokenizerMode = 'posix' | 'powershell' | 'cmd';

type PathCompletionRule = {
  command: string;
  directoriesOnly: boolean;
};

const PATH_COMPLETION_RULES: PathCompletionRule[] = [
  { command: 'cd', directoriesOnly: true },
  { command: 'pushd', directoriesOnly: true },
  { command: 'cat', directoriesOnly: false },
  { command: 'vim', directoriesOnly: false },
  { command: 'vi', directoriesOnly: false },
  { command: 'nvim', directoriesOnly: false },
  { command: 'nano', directoriesOnly: false },
  { command: 'less', directoriesOnly: false },
  { command: 'more', directoriesOnly: false },
  { command: 'head', directoriesOnly: false },
  { command: 'tail', directoriesOnly: false },
  { command: 'grep', directoriesOnly: false },
  { command: 'rg', directoriesOnly: false },
  { command: 'sed', directoriesOnly: false },
  { command: 'awk', directoriesOnly: false },
  { command: 'find', directoriesOnly: false },
  { command: 'ls', directoriesOnly: false },
  { command: 'touch', directoriesOnly: false },
  { command: 'rm', directoriesOnly: false },
  { command: 'cp', directoriesOnly: false },
  { command: 'mv', directoriesOnly: false },
  { command: 'chmod', directoriesOnly: false },
  { command: 'chown', directoriesOnly: false },
  { command: 'chgrp', directoriesOnly: false },
  { command: 'ln', directoriesOnly: false },
  { command: 'tar', directoriesOnly: false },
  { command: 'unzip', directoriesOnly: false },
  { command: 'zip', directoriesOnly: false },
  { command: 'scp', directoriesOnly: false },
  { command: 'sftp', directoriesOnly: false },
  { command: 'rsync', directoriesOnly: false },
];

const normalizeToken = (value: string): string => value.trim().toLowerCase();
const COMMAND_PATH_SEPARATOR = ' ';

type ParsedCommandToken = {
  value: string;
  start: number;
  end: number;
};

const computeSubsequenceScore = (query: string, candidate: string, fuzzyMatch: boolean): number => {
  return query ? scoreCompletionMatch(query, candidate, fuzzyMatch) : 0;
};

const parseCommandTokens = (line: string, mode: TerminalTokenizerMode): ParsedCommandToken[] => {
  const tokens: ParsedCommandToken[] = [];
  const input = String(line || '');
  const isPosixMode = mode === 'posix';
  const isPowerShellMode = mode === 'powershell';

  let cursor = 0;
  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor] ?? '')) {
      cursor += 1;
    }

    if (cursor >= input.length) {
      break;
    }

    const tokenStart = cursor;
    let value = '';
    let quote: 'single' | 'double' | null = null;

    while (cursor < input.length) {
      const char = input[cursor] ?? '';

      if (quote === 'single') {
        if (isPowerShellMode && char === "'" && input[cursor + 1] === "'") {
          value += "'";
          cursor += 2;
          continue;
        }

        if (char === "'") {
          quote = null;
        } else {
          value += char;
        }
        cursor += 1;
        continue;
      }

      if (quote === 'double') {
        if (char === '"') {
          quote = null;
          cursor += 1;
          continue;
        }

        if (isPosixMode && char === '\\' && cursor + 1 < input.length) {
          const escaped = input[cursor + 1] ?? '';
          if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
            value += escaped;
            cursor += 2;
            continue;
          }
        }

        if (isPowerShellMode && char === '`' && cursor + 1 < input.length) {
          value += input[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }

        value += char;
        cursor += 1;
        continue;
      }

      if (/\s/.test(char)) {
        break;
      }

      if (char === "'" && (isPosixMode || isPowerShellMode)) {
        quote = 'single';
        cursor += 1;
        continue;
      }

      if (char === '"') {
        quote = 'double';
        cursor += 1;
        continue;
      }

      if (isPosixMode && char === '\\' && cursor + 1 < input.length) {
        value += input[cursor + 1] ?? '';
        cursor += 2;
        continue;
      }

      value += char;
      cursor += 1;
    }

    tokens.push({
      value,
      start: tokenStart,
      end: cursor,
    });
  }

  return tokens;
};

const tokenizeCommand = (line: string, mode: TerminalTokenizerMode): string[] => {
  return parseCommandTokens(line, mode)
    .map((token) => token.value.trim())
    .filter((segment) => segment.length > 0);
};

const resolveCurrentToken = (
  linePrefix: string,
  parsedTokens: ParsedCommandToken[],
): { token: string; tokenIndex: number; replacePrefixLength: number } => {
  if (!linePrefix.trim()) {
    return { token: '', tokenIndex: 0, replacePrefixLength: 0 };
  }

  const hasTrailingWhitespace = /\s$/.test(linePrefix);
  if (parsedTokens.length === 0) {
    return { token: '', tokenIndex: 0, replacePrefixLength: 0 };
  }

  if (hasTrailingWhitespace) {
    return {
      token: '',
      tokenIndex: parsedTokens.length,
      replacePrefixLength: 0,
    };
  }

  const tokenIndex = Math.max(0, parsedTokens.length - 1);
  const token = parsedTokens[tokenIndex] ?? { value: '' };

  return {
    token: token.value,
    tokenIndex,
    replacePrefixLength: token.value.length,
  };
};

const toCommandPathLabel = (baseCommand: string, suffixToken: string): string => {
  const normalizedBase = baseCommand.trim();
  const normalizedSuffix = suffixToken.trim();
  if (!normalizedBase) {
    return normalizedSuffix;
  }

  if (!normalizedSuffix) {
    return normalizedBase;
  }

  return `${normalizedBase}${COMMAND_PATH_SEPARATOR}${normalizedSuffix}`;
};

const buildCommandPath = (tokens: string[]): string => tokens.join(COMMAND_PATH_SEPARATOR).trim();

/** @param command Catalogue-owned command spelling. @returns Its explicit compound aliases without normalizing user text. */
const specCommandPaths = (command: string): string[] => {
  const paths = [command];
  const tokens = command.split(COMMAND_PATH_SEPARATOR).filter(Boolean);
  if (tokens.length === 1 && tokens[0].includes('-')) paths.push(tokens[0].replaceAll('-', COMMAND_PATH_SEPARATOR));
  if (tokens.length === 2) paths.push(tokens.join('-'));
  return paths;
};

const SPEC_BY_COMMAND_PATH = (() => {
  const specMap = new Map<string, TerminalCommandSpec>();

  const registerSpec = (commandPath: string, spec: TerminalCommandSpec): void => {
    const normalizedPath = normalizeToken(commandPath);
    if (!normalizedPath || specMap.has(normalizedPath)) {
      return;
    }

    specMap.set(normalizedPath, spec);
  };

  INSHELLISENSE_COMMAND_SPECS.forEach((entry) => {
    specCommandPaths(entry.command).forEach((name) => registerSpec(name, entry));
  });

  return specMap;
})();

const resolveSpecByCommandPath = (commandPath: string, exact = false): TerminalCommandSpec | undefined => {
  const normalizedPath = normalizeToken(commandPath);
  if (!normalizedPath) {
    return undefined;
  }

  const spec = SPEC_BY_COMMAND_PATH.get(normalizedPath);
  return exact && spec && !specCommandPaths(spec.command).includes(commandPath) ? undefined : spec;
};

const resolveBestSpecContext = (
  tokens: string[],
  currentTokenIndex: number,
  currentTokenValue: string,
  exact = false,
): {
  spec: TerminalCommandSpec;
  matchedTokens: string[];
} | null => {
  const hasCurrentToken = currentTokenValue.trim().length > 0;
  const effectiveLength = hasCurrentToken ? currentTokenIndex + 1 : currentTokenIndex;
  const fixedTokens = tokens.slice(0, Math.max(0, effectiveLength));
  if (fixedTokens.length === 0) {
    return null;
  }

  for (let length = fixedTokens.length; length >= 1; length -= 1) {
    const candidateTokens = fixedTokens.slice(0, length);
    const candidateSpec =
      exact && candidateTokens.some((token) => /[\t ]/u.test(token))
        ? undefined
        : resolveSpecByCommandPath(
            exact ? candidateTokens.join(COMMAND_PATH_SEPARATOR) : buildCommandPath(candidateTokens),
            exact,
          );
    if (candidateSpec) {
      if (length < fixedTokens.length) {
        const nextToken = fixedTokens[length] ?? '';
        if (nextToken && !nextToken.startsWith('-')) {
          continue;
        }
      }

      return {
        spec: candidateSpec,
        matchedTokens: candidateTokens,
      };
    }
  }

  const firstToken = fixedTokens[0] ?? '';
  const rootSpec = resolveSpecByCommandPath(firstToken, exact);
  if (!rootSpec) {
    return null;
  }

  let cursor: Pick<TerminalCommandSpec, 'descriptionI18nKey' | 'subcommands' | 'options'> = rootSpec;
  const matchedTokens = [firstToken];

  for (let index = 1; index < fixedTokens.length; index += 1) {
    const token = fixedTokens[index] ?? '';
    if (!token || token.startsWith('-')) {
      break;
    }

    if (index === 1) {
      const compoundAliasSpec = resolveSpecByCommandPath(`${firstToken}-${token}`, exact);
      if (compoundAliasSpec) {
        matchedTokens.push(token);
        cursor = compoundAliasSpec;
        continue;
      }
    }

    const nextSubcommand = (cursor.subcommands ?? []).find((entry) =>
      exact ? entry.name === token : normalizeToken(entry.name) === normalizeToken(token),
    );

    if (!nextSubcommand) {
      break;
    }

    matchedTokens.push(token);
    cursor = nextSubcommand;
  }

  return {
    spec: {
      command: buildCommandPath(matchedTokens),
      descriptionI18nKey: cursor.descriptionI18nKey,
      subcommands: cursor.subcommands,
      options: cursor.options,
    },
    matchedTokens,
  };
};

const resolveOptionEntryByName = (
  spec: TerminalCommandSpec,
  optionToken: string,
): (NonNullable<TerminalCommandSpec['options']>[number] & { name: string }) | null => {
  const normalized = normalizeToken(optionToken);
  if (!normalized) {
    return null;
  }

  for (const option of spec.options ?? []) {
    const optionName = option.name.trim();
    if (!optionName) {
      continue;
    }

    if (normalizeToken(optionName) === normalized) {
      return {
        ...option,
        name: optionName,
      };
    }
  }

  return null;
};

const analyzeSpecArgumentContext = (
  spec: TerminalCommandSpec,
  tokens: string[],
  currentTokenIndex: number,
  currentTokenValue: string,
  matchedCommandTokens: string[],
): {
  usedOptionNames: Set<string>;
  currentOptionValueParent: string | null;
} => {
  const commandTokenLength = matchedCommandTokens.length;
  const completedUntil = currentTokenIndex - 1;
  const usedOptionNames = new Set<string>();

  for (let index = commandTokenLength; index <= completedUntil; index += 1) {
    const token = tokens[index] ?? '';
    if (!token.startsWith('-')) {
      continue;
    }

    const optionEntry = resolveOptionEntryByName(spec, token);
    if (!optionEntry) {
      continue;
    }

    usedOptionNames.add(optionEntry.name);

    if (optionEntry.takesValue && index + 1 <= completedUntil) {
      index += 1;
    }
  }

  const previousToken = currentTokenIndex > 0 ? (tokens[currentTokenIndex - 1] ?? '') : '';
  const previousOption = resolveOptionEntryByName(spec, previousToken);
  const currentLooksLikeOption = currentTokenValue.trim().startsWith('-');
  const currentOptionValueParent = previousOption?.takesValue && !currentLooksLikeOption ? previousOption.name : null;

  return {
    usedOptionNames,
    currentOptionValueParent,
  };
};

const startsWithNormalizedTokens = (tokens: string[], prefixTokens: string[]): boolean => {
  if (prefixTokens.length === 0 || tokens.length < prefixTokens.length) {
    return false;
  }

  for (let index = 0; index < prefixTokens.length; index += 1) {
    const left = normalizeToken(tokens[index] ?? '');
    const right = normalizeToken(prefixTokens[index] ?? '');
    if (!left || !right || left !== right) {
      return false;
    }
  }

  return true;
};

const toHistoryItem = (
  command: string,
  context: {
    query: string;
    normalizedLinePrefix: string;
    currentTokenIndex: number;
    currentTokenValue: string;
    fuzzyMatch: boolean;
    matchedCommandTokens: string[];
  },
  tokenizerMode: TerminalTokenizerMode,
  index: number,
  totalCommands: number,
): TerminalCompletionItem | null => {
  const label = command.trim();
  if (!label) {
    return null;
  }

  const historyTokens = tokenizeCommand(label, tokenizerMode);
  if (historyTokens.length === 0) {
    return null;
  }

  const historyRootCommand = historyTokens[0] ?? '';
  const queryForRoot = context.currentTokenValue || context.query;

  if (context.currentTokenIndex > 0 && context.matchedCommandTokens.length > 0) {
    if (!startsWithNormalizedTokens(historyTokens, context.matchedCommandTokens)) {
      return null;
    }
  }

  const currentHistoryToken = historyTokens[context.currentTokenIndex] ?? '';
  const tokenScore =
    context.currentTokenIndex <= 0
      ? computeSubsequenceScore(queryForRoot, historyRootCommand, context.fuzzyMatch)
      : context.currentTokenValue
        ? computeSubsequenceScore(context.currentTokenValue, currentHistoryToken, context.fuzzyMatch)
        : 32;
  if (tokenScore <= 0) {
    return null;
  }

  const normalizedHistory = normalizeToken(label);
  const normalizedLinePrefix = normalizeToken(context.normalizedLinePrefix);
  const prefixBonus = normalizedHistory.startsWith(normalizedLinePrefix) ? 22 : 0;
  const rootBonus =
    context.currentTokenIndex <= 0 &&
    normalizeToken(historyRootCommand).startsWith(normalizeToken(context.currentTokenValue || context.query))
      ? 18
      : 0;

  const score = tokenScore + prefixBonus + rootBonus;
  if (score <= 0) {
    return null;
  }

  const shouldInsertWholeCommand = context.currentTokenIndex <= 0;
  if (!shouldInsertWholeCommand && !currentHistoryToken) {
    return null;
  }

  const historySuffixInsertText = shouldInsertWholeCommand
    ? label
    : historyTokens.slice(context.currentTokenIndex).join(COMMAND_PATH_SEPARATOR);
  if (!historySuffixInsertText) {
    return null;
  }

  const distanceFromLatest = Math.max(0, totalCommands - 1 - index);
  const recencyBonus = Math.max(0, 180 - distanceFromLatest * 8);
  // Partial-token history replacement must delete what user actually typed,
  // not the full matched history token length.
  const normalizedReplacePrefixLength = shouldInsertWholeCommand
    ? context.normalizedLinePrefix.length
    : context.currentTokenValue.length;

  return {
    id: `history:${index}:${label}`,
    label,
    insertText: historySuffixInsertText,
    replacePrefixLength: normalizedReplacePrefixLength,
    detail: 'History',
    detailI18nKey: 'completion.labels.history',
    source: 'history',
    kind: 'history',
    score: score + 24 + recencyBonus,
  };
};

/**
 * Executes path provider with a short timeout for typing-triggered requests.
 */
const resolvePathItemsWithTriggerBudget = async (
  pathProvider: NonNullable<CompletionRuntimeOptions['pathProvider']>,
  pathContext: TerminalPathCompletionContext,
  trigger: TerminalCompletionRequest['trigger'],
  timeoutMs = TYPING_PATH_PROVIDER_TIMEOUT_MS,
): Promise<TerminalCompletionItem[]> => {
  if (trigger !== 'typing') {
    return collectPathItems(await pathProvider(pathContext), pathContext);
  }

  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const timeoutPromise = new Promise<TerminalPathEntry[]>((resolve) => {
    setTimeout(() => resolve([]), normalizedTimeoutMs);
  });

  const pathEntries = await Promise.race([pathProvider(pathContext), timeoutPromise]);
  return collectPathItems(pathEntries, pathContext);
};

const addItemWithBestScore = (target: Map<string, TerminalCompletionItem>, item: TerminalCompletionItem): void => {
  const existing = target.get(item.label);
  if (!existing || item.score > existing.score) {
    target.set(item.label, item);
  }
};

const collectCommandItems = (query: string, fuzzyMatch: boolean): TerminalCompletionItem[] => {
  const items: TerminalCompletionItem[] = [];
  const dedupe = new Set<string>();

  INSHELLISENSE_COMMAND_SPECS.forEach((spec, index) => {
    const commandCandidates = new Set<string>([spec.command]);
    (spec.subcommands ?? []).forEach((subcommand) => {
      const fullSubcommand = toCommandPathLabel(spec.command, subcommand.name);
      if (fullSubcommand) {
        commandCandidates.add(fullSubcommand);
      }
    });

    commandCandidates.forEach((candidateLabel) => {
      if (dedupe.has(candidateLabel)) {
        return;
      }

      const score = computeSubsequenceScore(query, candidateLabel, fuzzyMatch);
      if (score <= 0) {
        return;
      }

      dedupe.add(candidateLabel);
      items.push({
        id: `cmd:${index}:${candidateLabel}`,
        label: candidateLabel,
        insertText: candidateLabel,
        detail: null,
        detailI18nKey: spec.descriptionI18nKey,
        source: 'inshellisense',
        kind: candidateLabel.includes(COMMAND_PATH_SEPARATOR) ? 'subcommand' : 'command',
        score: score + 180,
      });
    });
  });

  return items;
};

const collectNestedItems = (
  spec: TerminalCommandSpec,
  query: string,
  fuzzyMatch: boolean,
  options?: {
    usedOptionNames?: Set<string>;
  },
): TerminalCompletionItem[] => {
  const items: TerminalCompletionItem[] = [];

  (spec.subcommands ?? []).forEach((entry, index) => {
    const label = toCommandPathLabel(spec.command, entry.name);
    const score = query ? computeSubsequenceScore(query, entry.name, fuzzyMatch) : 520;
    if (score <= 0) {
      return;
    }

    items.push({
      id: `sub:${spec.command}:${index}:${entry.name}`,
      label,
      insertText: entry.name,
      detail: null,
      detailI18nKey: entry.descriptionI18nKey,
      source: 'inshellisense',
      kind: 'subcommand',
      score: score + 220,
    });
  });

  (spec.options ?? []).forEach((entry, index) => {
    const optionLabel = entry.name.trim();
    if (!optionLabel) {
      return;
    }

    if (options?.usedOptionNames?.has(optionLabel)) {
      return;
    }

    const label = toCommandPathLabel(spec.command, optionLabel);
    const score = query ? computeSubsequenceScore(query, optionLabel, fuzzyMatch) : 510;
    if (score <= 0) {
      return;
    }

    const optionInsertText = entry.insertText ?? (entry.takesValue ? `${optionLabel} ` : optionLabel);

    items.push({
      id: `opt:${spec.command}:${index}:${optionLabel}`,
      label,
      insertText: optionInsertText,
      detail: null,
      detailI18nKey: entry.descriptionI18nKey,
      source: 'inshellisense',
      kind: 'option',
      score: score + 210,
    });
  });

  return items;
};

const collectOptionValueItems = (
  spec: TerminalCommandSpec,
  optionName: string,
  query: string,
  fuzzyMatch: boolean,
): TerminalCompletionItem[] => {
  const optionEntry = resolveOptionEntryByName(spec, optionName);
  if (!optionEntry || !optionEntry.takesValue) {
    return [];
  }

  const valueSuggestions = Array.from(new Set(optionEntry.valueSuggestions ?? [])).filter((entry) => entry.length > 0);
  if (valueSuggestions.length === 0) {
    return [];
  }

  const items: TerminalCompletionItem[] = [];
  valueSuggestions.forEach((value, index) => {
    const score = query ? computeSubsequenceScore(query, value, fuzzyMatch) : 540;
    if (score <= 0) {
      return;
    }

    items.push({
      id: `val:${spec.command}:${optionName}:${index}:${value}`,
      label: toCommandPathLabel(spec.command, `${optionName} ${value}`),
      insertText: value,
      detail: null,
      detailI18nKey: optionEntry.descriptionI18nKey,
      source: 'inshellisense',
      kind: 'option',
      score: score + 230,
    });
  });

  return items;
};

/**
 * Reads the existing static command catalogue using already-decoded words, without a second Shell parse.
 * The active word is never treated as an already completed subcommand or used option.
 * @param tokens Literal words. @param tokenIndex Active word index. @param prefix Text before the cursor in that word.
 * @param fuzzyMatch Allow subsequence matches. @returns Static metadata candidates, with no remote execution.
 */
export const resolveCommandMetadata = (
  tokens: string[],
  tokenIndex: number,
  prefix: string,
  fuzzyMatch: boolean,
): CommandMetadataCandidate[] => {
  if (tokenIndex === 0) return collectCommandItems(prefix, fuzzyMatch).map((item) => ({ ...item, insertion: 'words' }));
  if (!/^[A-Za-z0-9_.+-]+$/u.test(tokens[0] ?? '')) return [];
  const context = resolveBestSpecContext(tokens, tokenIndex, '', true);
  if (!context) return [];
  const usedOptionNames = new Set<string>();
  for (let index = context.matchedTokens.length; index < tokenIndex; index += 1) {
    const token = tokens[index];
    if (token === '--') return [];
    const option = context.spec.options?.find((entry) => entry.name === token);
    if (option) {
      usedOptionNames.add(option.name);
      if (option.takesValue) {
        if (index + 1 === tokenIndex)
          return collectOptionValueItems(context.spec, option.name, prefix, fuzzyMatch).map((item) => ({
            ...item,
            insertion: 'literal',
          }));
        index += 1;
      }
    } else if (token.startsWith('-') || context.spec.subcommands?.length) {
      // Unknown flags and unresolved subcommands can change the meaning of every later word.
      return [];
    }
  }
  return collectNestedItems(context.spec, prefix, fuzzyMatch, { usedOptionNames }).map((item) => ({
    ...item,
    insertion: 'words',
  }));
};

/** Static metadata distinguishes one argument value from an explicitly multiword command/option snippet. */
export type CommandMetadataCandidate = TerminalCompletionItem & { insertion: 'literal' | 'words' };

/**
 * Decides whether path completion should run for the current token and command context.
 * Returns null when the token is not path-eligible (e.g. option token starting with '-').
 */
const resolvePathCompletionContext = (
  tokens: string[],
  currentTokenIndex: number,
  currentTokenValue: string,
  fuzzyMatch: boolean,
  completionLimit: number,
): TerminalPathCompletionContext | null => {
  const trimmedCurrentToken = currentTokenValue.trim();
  if (trimmedCurrentToken.startsWith('-')) {
    return null;
  }

  const normalizedRootCommand = normalizeToken(tokens[0] ?? '');
  const isDirectPathCommand =
    currentTokenIndex === 0 && /^(\.|\/|~)/.test(trimmedCurrentToken || (tokens[0] ?? '').trim());
  if (isDirectPathCommand) {
    return {
      partialPath: currentTokenValue,
      directoriesOnly: false,
      fuzzyMatch,
      limit: Math.min(MAX_PATH_ITEMS, completionLimit * 3),
    };
  }

  if (currentTokenIndex <= 0) {
    return null;
  }

  const rule = PATH_COMPLETION_RULES.find((entry) => entry.command === normalizedRootCommand);
  if (!rule) {
    return null;
  }

  return {
    partialPath: currentTokenValue,
    directoriesOnly: rule.directoriesOnly,
    fuzzyMatch,
    limit: Math.min(MAX_PATH_ITEMS, completionLimit * 3),
  };
};

/**
 * Builds runtime path completion items from filesystem provider entries.
 */
const collectPathItems = (
  entries: TerminalPathEntry[],
  context: TerminalPathCompletionContext,
): TerminalCompletionItem[] => {
  const normalizedQuery = context.partialPath.trim();
  const items: TerminalCompletionItem[] = [];

  entries.forEach((entry, index) => {
    if (!entry.name.trim()) {
      return;
    }

    if (context.directoriesOnly && entry.kind !== 'directory') {
      return;
    }

    const baseScore = normalizedQuery
      ? computeSubsequenceScore(normalizedQuery, entry.name, context.fuzzyMatch)
      : entry.kind === 'directory'
        ? 560
        : 520;
    if (baseScore <= 0) {
      return;
    }

    items.push({
      id: `path:${index}:${entry.name}`,
      label: entry.name,
      insertText: entry.name,
      detail: null,
      detailI18nKey: entry.kind === 'directory' ? 'completion.labels.pathDirectory' : 'completion.labels.pathFile',
      source: 'runtime',
      kind: 'path',
      score: baseScore + (entry.kind === 'directory' ? 260 : 220),
    });
  });

  return items;
};

/**
 * Resolves terminal completion candidates using session history and command specs.
 */
export const resolveTerminalCompletions = (
  request: TerminalCompletionRequest,
  options: CompletionRuntimeOptions,
): Promise<TerminalCompletionResponse> => {
  return resolveTerminalCompletionsAsync(request, options);
};

/**
 * Resolves completion candidates by combining command specs, history, paths and runtime prompt actions.
 */
const resolveTerminalCompletionsAsync = async (
  request: TerminalCompletionRequest,
  options: CompletionRuntimeOptions,
): Promise<TerminalCompletionResponse> => {
  const normalizedCursorIndex = Number.isFinite(request.cursorIndex)
    ? Math.max(0, Math.min(request.linePrefix.length, Math.floor(request.cursorIndex)))
    : request.linePrefix.length;

  const normalizedLinePrefix = request.linePrefix.slice(0, normalizedCursorIndex);
  const query = normalizedLinePrefix.trimStart();
  const tokenizerMode: TerminalTokenizerMode = options.tokenizerMode ?? 'posix';
  const fuzzyMatch = request.fuzzyMatch ?? true;
  const includeHistory = request.includeHistory ?? true;
  const includeBuiltInCommands = request.includeBuiltInCommands ?? true;
  const includePathSuggestions = request.includePathSuggestions ?? true;
  const completionLimit = Math.max(1, Math.min(MAX_COMPLETION_LIMIT, request.limit ?? DEFAULT_COMPLETION_LIMIT));

  if (!query) {
    return {
      replacePrefixLength: 0,
      items: [],
    };
  }

  const parsedTokens = parseCommandTokens(normalizedLinePrefix, tokenizerMode);
  const tokens = parsedTokens.map((token) => token.value);
  const currentToken = resolveCurrentToken(normalizedLinePrefix, parsedTokens);
  const currentTokenValue = currentToken.token;
  const replacePrefixLength = currentToken.replacePrefixLength;
  const specContext = resolveBestSpecContext(tokens, currentToken.tokenIndex, currentTokenValue);
  const matchedCommandTokens = specContext?.matchedTokens ?? [];
  const currentTokenIsPartOfMatchedPath =
    currentTokenValue.trim().length > 0 && matchedCommandTokens.length === currentToken.tokenIndex + 1;
  const argumentContext = specContext
    ? analyzeSpecArgumentContext(
        specContext.spec,
        tokens,
        currentToken.tokenIndex,
        currentTokenValue,
        matchedCommandTokens,
      )
    : {
        usedOptionNames: new Set<string>(),
        currentOptionValueParent: null,
      };
  const itemMap = new Map<string, TerminalCompletionItem>();

  if (includeHistory) {
    const maxHistoryItems = request.trigger === 'typing' ? MAX_HISTORY_ITEMS_TYPING : MAX_HISTORY_ITEMS_MANUAL;
    const recentCommands = options.recentCommands.slice(-maxHistoryItems);
    recentCommands.forEach((command, index) => {
      const historyItem = toHistoryItem(
        command,
        {
          query,
          normalizedLinePrefix,
          currentTokenIndex: currentToken.tokenIndex,
          currentTokenValue,
          fuzzyMatch,
          matchedCommandTokens,
        },
        tokenizerMode,
        index,
        recentCommands.length,
      );
      if (!historyItem) {
        return;
      }

      addItemWithBestScore(itemMap, historyItem);
    });
  }

  const shouldSuggestRootCommand = currentToken.tokenIndex <= 0;

  if (includeBuiltInCommands) {
    if (shouldSuggestRootCommand) {
      collectCommandItems(currentTokenValue || query, fuzzyMatch).forEach((item) =>
        addItemWithBestScore(itemMap, item),
      );
    } else {
      const spec = specContext?.spec;
      if (spec) {
        if (argumentContext.currentOptionValueParent) {
          collectOptionValueItems(
            spec,
            argumentContext.currentOptionValueParent,
            currentTokenValue,
            fuzzyMatch,
          ).forEach((item) => addItemWithBestScore(itemMap, item));
        } else {
          const nestedQuery = currentTokenIsPartOfMatchedPath ? '' : currentTokenValue;
          collectNestedItems(spec, nestedQuery, fuzzyMatch, {
            usedOptionNames: argumentContext.usedOptionNames,
          }).forEach((item) => addItemWithBestScore(itemMap, item));
        }
      }
    }
  }

  if (includePathSuggestions) {
    const pathContext = resolvePathCompletionContext(
      tokens,
      currentToken.tokenIndex,
      currentTokenValue,
      fuzzyMatch,
      completionLimit,
    );
    if (pathContext && options.pathProvider) {
      const pathItems = await resolvePathItemsWithTriggerBudget(
        options.pathProvider,
        pathContext,
        request.trigger,
        options.typingPathProviderTimeoutMs,
      );
      pathItems.forEach((item) => addItemWithBestScore(itemMap, item));
    }
  }

  const rankedItems = Array.from(itemMap.values())
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.source !== right.source) {
        const sourcePriority = (source: TerminalCompletionItem['source']): number => {
          if (source === 'runtime') {
            return 0;
          }

          if (source === 'inshellisense') {
            return 1;
          }

          return 2;
        };

        return sourcePriority(left.source) - sourcePriority(right.source);
      }

      return left.label.localeCompare(right.label);
    })
    .slice(0, completionLimit);

  return {
    replacePrefixLength,
    items: rankedItems,
  };
};

/**
 * Localizes completion item detail text using backend i18n translator with safe fallback.
 */
export const localizeTerminalCompletionItems = (
  items: ReadonlyArray<TerminalCompletionItem>,
  translate: (key: string) => string,
): TerminalCompletionItem[] => {
  return items.map((item) => {
    const translatedDetail = item.detailI18nKey ? translate(item.detailI18nKey) : null;
    const hasTranslatedDetail =
      typeof translatedDetail === 'string' && translatedDetail.length > 0 && translatedDetail !== item.detailI18nKey;
    const fallbackLabelKey =
      item.source === 'history'
        ? 'completion.labels.history'
        : item.source === 'runtime'
          ? item.kind === 'path'
            ? 'completion.labels.pathFile'
            : 'completion.labels.commandSpec'
          : 'completion.labels.commandSpec';
    const fallbackLabel = translate(fallbackLabelKey);
    const safeFallbackLabel =
      typeof fallbackLabel === 'string' && fallbackLabel.length > 0 && fallbackLabel !== fallbackLabelKey
        ? fallbackLabel
        : item.source === 'history'
          ? 'History'
          : item.source === 'runtime'
            ? item.kind === 'path'
              ? 'File'
              : 'Runtime'
            : 'Command spec';

    return {
      ...item,
      detail: hasTranslatedDetail ? translatedDetail : item.detail?.trim() || safeFallbackLabel,
    };
  });
};
