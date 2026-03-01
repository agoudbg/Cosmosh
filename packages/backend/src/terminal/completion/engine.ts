import { INSHELLISENSE_COMMAND_SPECS } from './generated-inshellisense.js';
import type {
  TerminalCommandSpec,
  TerminalCompletionItem,
  TerminalCompletionRequest,
  TerminalCompletionResponse,
} from './types.js';

const DEFAULT_COMPLETION_LIMIT = 8;
const MAX_COMPLETION_LIMIT = 16;

const normalizeToken = (value: string): string => value.trim().toLowerCase();
const COMMAND_PATH_SEPARATOR = ' ';

type ParsedCommandToken = {
  value: string;
  start: number;
  end: number;
};

const computeSubsequenceScore = (query: string, candidate: string, fuzzyMatch: boolean): number => {
  const normalizedQuery = normalizeToken(query);
  const normalizedCandidate = normalizeToken(candidate);

  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 1_000 - Math.min(80, normalizedCandidate.length - normalizedQuery.length);
  }

  if (normalizedCandidate.includes(normalizedQuery)) {
    return 600 - Math.min(120, normalizedCandidate.length - normalizedQuery.length);
  }

  if (!fuzzyMatch) {
    return 0;
  }

  let queryIndex = 0;
  let candidateIndex = 0;
  let gapPenalty = 0;

  while (queryIndex < normalizedQuery.length && candidateIndex < normalizedCandidate.length) {
    if (normalizedQuery[queryIndex] === normalizedCandidate[candidateIndex]) {
      queryIndex += 1;
    } else {
      gapPenalty += 1;
    }

    candidateIndex += 1;
  }

  if (queryIndex < normalizedQuery.length) {
    return 0;
  }

  return Math.max(120, 260 - gapPenalty);
};

const parseCommandTokens = (line: string): ParsedCommandToken[] => {
  const tokens: ParsedCommandToken[] = [];
  const input = String(line || '');

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

        if (char === '\\' && cursor + 1 < input.length) {
          const escaped = input[cursor + 1] ?? '';
          if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
            value += escaped;
            cursor += 2;
            continue;
          }
        }

        value += char;
        cursor += 1;
        continue;
      }

      if (/\s/.test(char)) {
        break;
      }

      if (char === "'") {
        quote = 'single';
        cursor += 1;
        continue;
      }

      if (char === '"') {
        quote = 'double';
        cursor += 1;
        continue;
      }

      if (char === '\\' && cursor + 1 < input.length) {
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

const tokenizeCommand = (line: string): string[] => {
  return parseCommandTokens(line)
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
    registerSpec(entry.command, entry);

    const normalizedCommand = normalizeToken(entry.command);
    const commandTokens = normalizedCommand.split(COMMAND_PATH_SEPARATOR).filter((token) => token.length > 0);

    if (commandTokens.length === 1 && commandTokens[0]?.includes('-')) {
      registerSpec(commandTokens[0].replaceAll('-', COMMAND_PATH_SEPARATOR), entry);
    }

    if (commandTokens.length === 2) {
      registerSpec(`${commandTokens[0]}-${commandTokens[1]}`, entry);
    }
  });

  return specMap;
})();

const resolveSpecByCommandPath = (commandPath: string): TerminalCommandSpec | undefined => {
  const normalizedPath = normalizeToken(commandPath);
  if (!normalizedPath) {
    return undefined;
  }

  return SPEC_BY_COMMAND_PATH.get(normalizedPath);
};

const resolveBestSpecContext = (
  tokens: string[],
  currentTokenIndex: number,
  currentTokenValue: string,
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
    const candidateSpec = resolveSpecByCommandPath(buildCommandPath(candidateTokens));
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
  const rootSpec = resolveSpecByCommandPath(firstToken);
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
      const compoundAliasSpec = resolveSpecByCommandPath(`${firstToken}-${token}`);
      if (compoundAliasSpec) {
        matchedTokens.push(token);
        cursor = compoundAliasSpec;
        continue;
      }
    }

    const nextSubcommand = (cursor.subcommands ?? []).find(
      (entry) => normalizeToken(entry.name) === normalizeToken(token),
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
  const completedUntil = currentTokenValue.trim().length > 0 ? currentTokenIndex : currentTokenIndex - 1;
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
  index: number,
  totalCommands: number,
): TerminalCompletionItem | null => {
  const label = command.trim();
  if (!label) {
    return null;
  }

  const historyTokens = tokenizeCommand(label);
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

  const distanceFromLatest = Math.max(0, totalCommands - 1 - index);
  const recencyBonus = Math.max(0, 180 - distanceFromLatest * 8);

  return {
    id: `history:${index}:${label}`,
    label,
    insertText: shouldInsertWholeCommand ? label : currentHistoryToken,
    detail: 'History',
    detailI18nKey: 'completion.labels.history',
    source: 'history',
    kind: 'history',
    score: score + 24 + recencyBonus,
  };
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

  const valueSuggestions = Array.from(
    new Set((optionEntry.valueSuggestions ?? []).map((entry) => entry.trim())),
  ).filter((entry) => entry.length > 0);
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
 * Resolves terminal completion candidates using session history and command specs.
 */
export const resolveTerminalCompletions = (
  request: TerminalCompletionRequest,
  options: {
    recentCommands: string[];
  },
): TerminalCompletionResponse => {
  const normalizedCursorIndex = Number.isFinite(request.cursorIndex)
    ? Math.max(0, Math.min(request.linePrefix.length, Math.floor(request.cursorIndex)))
    : request.linePrefix.length;

  const normalizedLinePrefix = request.linePrefix.slice(0, normalizedCursorIndex);
  const query = normalizedLinePrefix.trimStart();
  const fuzzyMatch = request.fuzzyMatch ?? true;
  const completionLimit = Math.max(1, Math.min(MAX_COMPLETION_LIMIT, request.limit ?? DEFAULT_COMPLETION_LIMIT));

  if (!query) {
    return {
      replacePrefixLength: 0,
      items: [],
    };
  }

  const parsedTokens = parseCommandTokens(normalizedLinePrefix);
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

  options.recentCommands.forEach((command, index) => {
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
      index,
      options.recentCommands.length,
    );
    if (!historyItem) {
      return;
    }

    addItemWithBestScore(itemMap, historyItem);
  });

  const shouldSuggestRootCommand = currentToken.tokenIndex <= 0;

  if (shouldSuggestRootCommand) {
    collectCommandItems(currentTokenValue || query, fuzzyMatch).forEach((item) => addItemWithBestScore(itemMap, item));
  } else {
    const spec = specContext?.spec;
    if (spec) {
      if (argumentContext.currentOptionValueParent) {
        collectOptionValueItems(spec, argumentContext.currentOptionValueParent, currentTokenValue, fuzzyMatch).forEach(
          (item) => addItemWithBestScore(itemMap, item),
        );
      } else {
        const nestedQuery = currentTokenIsPartOfMatchedPath ? '' : currentTokenValue;
        collectNestedItems(spec, nestedQuery, fuzzyMatch, {
          usedOptionNames: argumentContext.usedOptionNames,
        }).forEach((item) => addItemWithBestScore(itemMap, item));
      }
    }
  }

  const rankedItems = Array.from(itemMap.values())
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.source !== right.source) {
        return left.source === 'inshellisense' ? -1 : 1;
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
    const fallbackLabelKey = item.source === 'history' ? 'completion.labels.history' : 'completion.labels.commandSpec';
    const fallbackLabel = translate(fallbackLabelKey);
    const safeFallbackLabel =
      typeof fallbackLabel === 'string' && fallbackLabel.length > 0 && fallbackLabel !== fallbackLabelKey
        ? fallbackLabel
        : item.source === 'history'
          ? 'History'
          : 'Command spec';

    return {
      ...item,
      detail: hasTranslatedDetail ? translatedDetail : item.detail?.trim() || safeFallbackLabel,
    };
  });
};
