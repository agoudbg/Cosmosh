import type { ITerminalOptions, Terminal } from '@xterm/xterm';

import type { ClientOutboundMessage, TerminalSelectionSettings } from './ssh-types';

const SEARCH_URL_BY_ENGINE: Partial<Record<TerminalSelectionSettings['searchEngine'], string>> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

const COMMAND_START_TOKENS = ['> ', '$ ', '# ', '❯ ', '➜ ', 'λ '];

/**
 * Detects common password/passphrase prompt endings in terminal output.
 */
export const SECRET_PROMPT_PATTERN = /(password(?: for [^:]+)?:|passphrase(?: for [^:]+)?:)\s*$/i;

/**
 * Formats bytes in a compact terminal-style representation.
 *
 * @param value Input bytes value.
 * @returns Compact byte string such as `12K` or `1.4M`.
 */
export const formatCompactBytes = (value: number): string => {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const units = ['B', 'K', 'M', 'G', 'T'];
  let scaled = safeValue;
  let unitIndex = 0;

  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(scaled)}${units[unitIndex]}`;
  }

  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${units[unitIndex]}`;
};

/**
 * Converts CPU telemetry value into a stable human readable string.
 *
 * @param value CPU percent value from telemetry.
 * @returns Percent string with one decimal or `N/A`.
 */
export const formatCpuPercent = (value: number | null): string => {
  if (value === null) {
    return 'N/A';
  }

  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `${safeValue.toFixed(1)}%`;
};

/**
 * Combines memory used and total bytes into `used/total` compact notation.
 *
 * @param usedBytes Used memory in bytes.
 * @param totalBytes Total memory in bytes.
 * @returns Memory usage string or `N/A` when unavailable.
 */
export const formatMemoryUsage = (usedBytes: number | null, totalBytes: number | null): string => {
  if (usedBytes === null || totalBytes === null) {
    return 'N/A';
  }

  return `${formatCompactBytes(usedBytes)}/${formatCompactBytes(totalBytes)}`;
};

/**
 * Converts traffic throughput value to compact bytes-per-second format.
 *
 * @param bytesPerSecond Throughput value in bytes per second.
 * @returns Compact traffic string or `N/A`.
 */
export const formatTrafficRate = (bytesPerSecond: number | null): string => {
  if (bytesPerSecond === null) {
    return 'N/A';
  }

  return formatCompactBytes(bytesPerSecond);
};

/**
 * Sends a message to the terminal websocket only when the connection is open.
 *
 * @param socket Target websocket.
 * @param payload Serialized client payload.
 * @returns Nothing.
 */
export const sendClientMessage = (socket: WebSocket, payload: ClientOutboundMessage): void => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
};

/**
 * Locates where user command starts in a shell prompt line.
 *
 * @param linePrefix Visible content before cursor on current line.
 * @returns Zero-based command start column.
 */
export const resolveCommandStartOffset = (linePrefix: string): number => {
  let bestIndex = -1;
  let bestTokenLength = 0;

  for (const token of COMMAND_START_TOKENS) {
    const index = linePrefix.lastIndexOf(token);
    if (index < 0) {
      continue;
    }

    if (index > bestIndex) {
      bestIndex = index;
      bestTokenLength = token.length;
    }
  }

  if (bestIndex < 0) {
    return 0;
  }

  return Math.max(0, bestIndex + bestTokenLength);
};

/**
 * Resolves current shell line prefix and extracted command-only prefix.
 *
 * @param terminal Source xterm instance.
 * @returns Cursor row and command prefix context, or `null` when unavailable.
 */
export const resolveTerminalCurrentLinePrefix = (
  terminal: Terminal,
): {
  fullLinePrefix: string;
  commandPrefix: string;
  commandStartColumn: number;
  cursorRow: number;
} | null => {
  const activeBuffer = terminal.buffer.active;
  const cursorY = activeBuffer.cursorY;
  const cursorX = activeBuffer.cursorX;
  const absoluteLineIndex = activeBuffer.baseY + cursorY;
  const line = activeBuffer.getLine(absoluteLineIndex);

  if (!line) {
    return null;
  }

  const fullLinePrefix = line.translateToString(true, 0, cursorX);
  const commandStartColumn = resolveCommandStartOffset(fullLinePrefix);

  return {
    fullLinePrefix,
    commandPrefix: fullLinePrefix.slice(commandStartColumn),
    commandStartColumn,
    cursorRow: cursorY,
  };
};

/**
 * Parses a best-effort absolute cwd hint from shell prompt prefix.
 *
 * @param fullLinePrefix Full terminal line text before cursor.
 * @param commandStartColumn Command start column resolved from prompt tokens.
 * @returns Absolute POSIX-like cwd hint or `null` when unavailable.
 */
export const resolvePromptWorkingDirectoryHint = (
  fullLinePrefix: string,
  commandStartColumn: number,
): string | null => {
  const promptSegment = fullLinePrefix.slice(0, Math.max(0, commandStartColumn)).trimEnd();
  if (!promptSegment) {
    return null;
  }

  const hostPromptMatch = /:[\s]*([^\s]+)\s*[#$]$/.exec(promptSegment);
  const plainPromptMatch = /^([^\s]+)\s*[#$]$/.exec(promptSegment);
  const candidate = hostPromptMatch?.[1] ?? plainPromptMatch?.[1] ?? '';
  if (!candidate) {
    return null;
  }

  if (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('/')) {
    return candidate;
  }

  return null;
};

/**
 * Replaces known placeholders in custom search templates.
 *
 * @param template Search template configured by user.
 * @param encodedQuery URL-encoded query text.
 * @returns Resolved template string.
 */
export const resolveSearchTemplate = (template: string, encodedQuery: string): string => {
  if (template.includes('%s')) {
    return template.replaceAll('%s', encodedQuery);
  }

  if (template.includes('QUERY_TOKEN')) {
    return template.replaceAll('QUERY_TOKEN', encodedQuery);
  }

  return `${template}${encodedQuery}`;
};

/**
 * Validates and resolves custom search URL template.
 *
 * @param searchUrlTemplate Custom search template.
 * @param encodedQuery URL-encoded query text.
 * @returns Resolved valid URL or `null`.
 */
export const tryResolveCustomSearchUrl = (searchUrlTemplate: string, encodedQuery: string): string | null => {
  const normalizedTemplate = searchUrlTemplate.trim();
  if (normalizedTemplate.length === 0) {
    return null;
  }

  const resolvedTemplate = resolveSearchTemplate(normalizedTemplate, encodedQuery);

  try {
    const parsedCustomUrl = new URL(resolvedTemplate);
    if (parsedCustomUrl.protocol === 'http:' || parsedCustomUrl.protocol === 'https:') {
      return parsedCustomUrl.toString();
    }
  } catch {
    // Ignore invalid custom templates and fallback to configured search engine.
  }

  return null;
};

/**
 * Resolves final search URL based on engine and custom fallback policy.
 *
 * @param engine Selected search engine.
 * @param query Raw selected text.
 * @param searchUrlTemplate Custom template value from settings.
 * @returns Final URL used for external search.
 */
export const resolveSearchUrl = (
  engine: TerminalSelectionSettings['searchEngine'],
  query: string,
  searchUrlTemplate: string,
): string => {
  const encodedQuery = encodeURIComponent(query.trim());

  if (engine === 'custom') {
    const customUrl = tryResolveCustomSearchUrl(searchUrlTemplate, encodedQuery);
    if (customUrl) {
      return customUrl;
    }
  }

  const baseUrl = SEARCH_URL_BY_ENGINE[engine] ?? SEARCH_URL_BY_ENGINE.google;
  return `${baseUrl}${encodedQuery}`;
};

/**
 * Parses optional number setting with min/max guards.
 *
 * @param value Raw string value from settings store.
 * @param constraints Optional min/max constraints.
 * @returns Parsed number or `undefined` when invalid.
 */
export const parseOptionalNumberSetting = (
  value: string,
  constraints?: { min?: number; max?: number },
): number | undefined => {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return undefined;
  }

  const parsedValue = Number(normalizedValue);
  if (!Number.isFinite(parsedValue)) {
    return undefined;
  }

  if (constraints?.min !== undefined && parsedValue < constraints.min) {
    return undefined;
  }

  if (constraints?.max !== undefined && parsedValue > constraints.max) {
    return undefined;
  }

  return parsedValue;
};

/**
 * Parses xterm font weight setting from user-configured value.
 *
 * @param value Raw font weight value from settings.
 * @param fallback Fallback weight when parsing fails.
 * @returns Parsed xterm-compatible font weight.
 */
export const resolveTerminalFontWeightSetting = (
  value: string,
  fallback: NonNullable<ITerminalOptions['fontWeight']>,
): ITerminalOptions['fontWeight'] => {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return fallback;
  }

  if (/^\d+$/.test(normalizedValue)) {
    return Number(normalizedValue);
  }

  const literalWeightValues: Array<Exclude<NonNullable<ITerminalOptions['fontWeight']>, number>> = [
    'normal',
    'bold',
    '100',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '900',
  ];

  return literalWeightValues.includes(normalizedValue as (typeof literalWeightValues)[number])
    ? (normalizedValue as (typeof literalWeightValues)[number])
    : fallback;
};

/**
 * Applies runtime-updatable xterm options to an existing terminal instance.
 *
 * @param terminal Target xterm instance.
 * @param options Next runtime options.
 * @returns Nothing.
 */
export const applyTerminalRuntimeOptions = (terminal: Terminal, options: ITerminalOptions): void => {
  terminal.options.convertEol = options.convertEol;
  terminal.options.altClickMovesCursor = options.altClickMovesCursor;
  terminal.options.cursorBlink = options.cursorBlink;
  terminal.options.cursorInactiveStyle = options.cursorInactiveStyle;
  terminal.options.cursorStyle = options.cursorStyle;
  terminal.options.cursorWidth = options.cursorWidth;
  terminal.options.customGlyphs = options.customGlyphs;
  terminal.options.drawBoldTextInBrightColors = options.drawBoldTextInBrightColors;
  terminal.options.fastScrollSensitivity = options.fastScrollSensitivity;
  terminal.options.fontFamily = options.fontFamily;
  terminal.options.fontSize = options.fontSize;
  terminal.options.fontWeight = options.fontWeight;
  terminal.options.fontWeightBold = options.fontWeightBold;
  terminal.options.letterSpacing = options.letterSpacing;
  terminal.options.lineHeight = options.lineHeight;
  terminal.options.minimumContrastRatio = options.minimumContrastRatio;
  terminal.options.screenReaderMode = options.screenReaderMode;
  terminal.options.scrollback = options.scrollback;
  terminal.options.scrollOnUserInput = options.scrollOnUserInput;
  terminal.options.scrollSensitivity = options.scrollSensitivity;
  terminal.options.smoothScrollDuration = options.smoothScrollDuration;
  terminal.options.tabStopWidth = options.tabStopWidth;
  terminal.options.theme = options.theme;
};
