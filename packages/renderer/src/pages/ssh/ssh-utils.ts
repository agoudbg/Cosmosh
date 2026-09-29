import type { ShellDirectoryContext } from '@cosmosh/api-contract';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { ITerminalOptions, Terminal } from '@xterm/xterm';

import type { ClientOutboundMessage, TerminalPaneRuntime, TerminalSelectionSettings } from './ssh-types';

const SEARCH_URL_BY_ENGINE: Partial<Record<TerminalSelectionSettings['searchEngine'], string>> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

const PROMPT_TERMINATOR_CHARS = new Set<string>(['$', '#', '>', '%', '❯', '➜', 'λ']);
const MAX_PROMPT_TOKENS_TO_SCAN = 12;
const PROMPT_DECORATION_TOKEN_PATTERN = /^\([^()\s]{1,64}\)$/u;
const SHELL_QUOTED_PATH_PATTERN = /^(['"])([\s\S]+)\1$/;
const SHELL_FILE_URL_PATTERN = /^file:\/\/([^?#]*)/i;
const REMOTE_DIRECTORY_PATH_PATTERN = /^(?:\/|~(?=\/|$)|\.{1,2}(?=\/|$)).*/;
/** Maximum paste preview length shown in the safety dialog. */
const TERMINAL_PASTE_WARNING_PREVIEW_MAX_LENGTH = 240;
/** Matches newline forms that make a paste span multiple terminal input lines. */
const TERMINAL_MULTILINE_PATTERN = /\r\n|\n|\r/;
/** ASCII escape byte used by terminal control sequences. */
const TERMINAL_ESCAPE_CODE_POINT = 0x1b;
/** ASCII bell byte used by OSC terminators and audible/visual alerts. */
const TERMINAL_BELL_CODE_POINT = 0x07;
/** CAN exits any incomplete VT parser sequence without producing terminal input. */
const TERMINAL_CANCEL_SEQUENCE = '\x18';
/** RIS asks xterm to reset its parser, buffers, modes, selection, and decorations in input order. */
const TERMINAL_FULL_RESET_SEQUENCE = '\x1bc';
/** SGR 0 prevents the restored display snapshot from styling output from the replacement PTY. */
const TERMINAL_GRAPHIC_RENDITION_RESET_SEQUENCE = '\x1b[0m';
/** Keeps replacement PTY output visually separate from the restored previous-session cursor. */
const TERMINAL_HISTORY_REPLAY_SEPARATOR = '\r\n';

export type TerminalPasteWarningReason = 'multiLine' | 'largeText' | 'controlCharacters';

export type TerminalPasteWarningRequest = {
  id: string;
  text: string;
  reasons: TerminalPasteWarningReason[];
  characterCount: number;
  threshold: number;
  preview: string;
};

export type TerminalPasteSafetySettings = {
  warnOnMultiLinePaste: boolean;
  warnOnLargePaste: boolean;
  largePasteWarningThreshold: number;
  warnOnControlCharactersPaste: boolean;
};

export type TerminalPaneActivationReconnectInput = {
  owner: 'primary' | 'secondary';
  connectionState: 'connecting' | 'connected' | 'failed';
  socketReadyState: number | null;
  isFirstActivation: boolean;
  reconnectOnFocus: boolean;
};

type PromptBoundaryToken = {
  value: string;
  start: number;
};

type CommandStartResolveOptions = {
  promptPrefixRegex?: RegExp | null;
};

type AutocompleteCommandPrefixResolveOptions = {
  localPrefixNeedsRenderedContext?: boolean;
};

/**
 * Determines whether a pane should open a new session when its tab becomes active.
 *
 * The first activation starts a deferred primary session independently of the reconnect
 * preference. Later activations only recover failed panes when the preference allows it.
 * Sockets that are already connecting or open always retain ownership of their attempt.
 *
 * @param input Pane ownership, transport state, and activation context.
 * @returns `true` when the pane runtime should invoke its reconnect operation.
 */
export const shouldReconnectTerminalPaneOnActivation = (input: TerminalPaneActivationReconnectInput): boolean => {
  if (input.socketReadyState === WebSocket.CONNECTING || input.socketReadyState === WebSocket.OPEN) {
    return false;
  }

  if (input.isFirstActivation) {
    return input.owner === 'primary';
  }

  return input.reconnectOnFocus && input.connectionState === 'failed';
};

/**
 * Resets xterm at a backend PTY session boundary while restoring safe normal-buffer history.
 *
 * xterm's JavaScript `reset()` API is synchronous and intentionally leaves queued input and
 * parser state intact. Writing CAN followed by RIS through the emulator's output path first
 * cancels an incomplete OSC/DCS/CSI sequence, then performs the full reset in parser order. The
 * normal buffer is serialized without alternate-buffer content or terminal modes and replayed in
 * the same ordered write so a superseding attempt cannot observe a partially restored display.
 * These bytes and the display snapshot are written only to the local xterm emulator and never
 * reach the backend PTY.
 *
 * @param terminal Public xterm surface required for ordered output and scrollback configuration.
 * @param serializeAddon Existing pane-local addon used to capture bounded normal-buffer history.
 * @param isCurrentAttempt Returns whether the reconnect attempt still owns the pane.
 * @param releaseSessionState Clears pane-local state after old write callbacks have drained.
 * @returns Whether this attempt applied the session-boundary reset.
 */
export const resetTerminalForNewPtySession = async (
  terminal: Pick<Terminal, 'options' | 'write'>,
  serializeAddon: Pick<SerializeAddon, 'serialize'>,
  isCurrentAttempt: () => boolean,
  releaseSessionState: () => void,
): Promise<boolean> => {
  await new Promise<void>((resolve) => {
    terminal.write('', resolve);
  });

  if (!isCurrentAttempt()) {
    return false;
  }

  let normalBufferHistory = '';
  try {
    normalBufferHistory = serializeAddon.serialize({
      excludeAltBuffer: true,
      excludeModes: true,
      scrollback: terminal.options.scrollback,
    });
  } catch (error: unknown) {
    console.warn('[terminal][session-boundary] Failed to preserve normal-buffer history.', error);
  }

  releaseSessionState();
  const historyReplay = normalBufferHistory
    ? `${normalBufferHistory}${TERMINAL_GRAPHIC_RENDITION_RESET_SEQUENCE}${TERMINAL_HISTORY_REPLAY_SEPARATOR}`
    : '';
  await new Promise<void>((resolve) => {
    terminal.write(`${TERMINAL_CANCEL_SEQUENCE}${TERMINAL_FULL_RESET_SEQUENCE}${historyReplay}`, resolve);
  });

  return isCurrentAttempt();
};

/**
 * Reconciles secondary pane runtimes only when the active layout has a stable target.
 *
 * A primary retry temporarily clears target readiness, so that transition must preserve
 * sibling runtimes. Once readiness returns, only panes removed from the layout are disposed.
 *
 * @param runtimeMap Pane-indexed runtime resources shared by primary and secondary panes.
 * @param input Current layout ids and lifecycle gates.
 * @returns Nothing.
 */
export const reconcileSecondaryPaneRuntimes = <TRuntime extends Pick<TerminalPaneRuntime, 'owner' | 'dispose'>>(
  runtimeMap: Map<string, TRuntime>,
  input: {
    desiredPaneIds: readonly string[];
    isActive: boolean;
    sessionTargetReady: boolean;
  },
): void => {
  if (!input.isActive || !input.sessionTargetReady) {
    return;
  }

  const desiredPaneIds = new Set(input.desiredPaneIds);
  runtimeMap.forEach((runtime, paneId) => {
    if (runtime.owner === 'primary' || desiredPaneIds.has(paneId)) {
      return;
    }

    runtime.dispose();
    runtimeMap.delete(paneId);
  });
};

/**
 * Formats pasted text for a compact safety-dialog preview.
 *
 * @param text Text that is about to be pasted.
 * @returns Preview text with tabs made readable while real line breaks stay visible.
 */
export const formatTerminalPastePreview = (text: string): string => {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const compact =
    normalized.length <= TERMINAL_PASTE_WARNING_PREVIEW_MAX_LENGTH
      ? normalized
      : `${normalized.slice(0, TERMINAL_PASTE_WARNING_PREVIEW_MAX_LENGTH - 3)}...`;

  return compact.replace(/\t/g, '\\t');
};

/**
 * Checks whether one code point is a terminal control byte worth warning about.
 *
 * @param codePoint Character code point.
 * @returns True when the code point is a non-whitespace control byte.
 */
const isTerminalControlCodePoint = (codePoint: number): boolean => {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
    return false;
  }

  return (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
};

/**
 * Checks whether ESC is followed by a plausible ANSI control-sequence introducer.
 *
 * @param text Candidate paste payload.
 * @param escapeIndex Index of ESC in the payload.
 * @returns True when the following byte starts a common terminal sequence.
 */
const startsTerminalEscapeSequence = (text: string, escapeIndex: number): boolean => {
  const nextCodePoint = text.codePointAt(escapeIndex + 1);
  if (nextCodePoint === undefined) {
    return true;
  }

  return nextCodePoint >= 0x40 && nextCodePoint <= 0x5f;
};

/**
 * Checks whether pasted text includes terminal control bytes or escape sequences.
 *
 * @param text Candidate paste payload.
 * @returns True when control content is present.
 */
export const containsTerminalControlContent = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint === TERMINAL_ESCAPE_CODE_POINT && startsTerminalEscapeSequence(text, index)) {
      return true;
    }

    if (codePoint === TERMINAL_BELL_CODE_POINT || isTerminalControlCodePoint(codePoint)) {
      return true;
    }

    if (codePoint > 0xffff) {
      index += 1;
    }
  }

  return false;
};

/**
 * Builds a paste-warning request when the current safety settings require confirmation.
 *
 * @param text Text that is about to be pasted.
 * @param settings Paste safety settings from the registry.
 * @returns Warning request or `null` when paste can proceed immediately.
 */
export const createTerminalPasteWarningRequest = (
  text: string,
  settings: TerminalPasteSafetySettings,
): TerminalPasteWarningRequest | null => {
  const reasons: TerminalPasteWarningReason[] = [];
  const threshold = Math.max(1, settings.largePasteWarningThreshold);

  if (settings.warnOnMultiLinePaste && TERMINAL_MULTILINE_PATTERN.test(text)) {
    reasons.push('multiLine');
  }

  if (settings.warnOnLargePaste && text.length >= threshold) {
    reasons.push('largeText');
  }

  if (settings.warnOnControlCharactersPaste && containsTerminalControlContent(text)) {
    reasons.push('controlCharacters');
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    reasons,
    characterCount: text.length,
    threshold,
    preview: formatTerminalPastePreview(text),
  };
};

/** Matches a rendered shell continuation prompt (`> `, zsh `pipe> `) at line start. */
const COMMAND_CONTINUATION_PROMPT_PATTERN = /^[a-z]*> /;

/**
 * Flattens one retained command into a single-line terminal input payload.
 *
 * Timeline entries retain rendered continuation lines (heredocs, quoted
 * strings), and a PTY treats every embedded newline as Enter, so writing the
 * retained text verbatim would submit it immediately. Continuation-prompt
 * decorations on follow-up lines are shell chrome rather than user input.
 *
 * @param command Retained command text possibly spanning terminal lines.
 * @returns Single-line payload safe to insert without submitting.
 */
export const flattenCommandForTerminalInput = (command: string): string => {
  const lines = command.split(TERMINAL_MULTILINE_PATTERN);
  const flattened: string[] = [];
  lines.forEach((line, lineIndex) => {
    const withoutContinuationPrompt = lineIndex > 0 ? line.replace(COMMAND_CONTINUATION_PROMPT_PATTERN, '') : line;
    const trimmed = withoutContinuationPrompt.trim();
    if (trimmed.length > 0) {
      flattened.push(trimmed);
    }
  });

  return flattened.join(' ');
};

/**
 * Identifies history records that can be inserted as literal terminal text without control keys.
 * @param command Exact native history record, including significant spaces.
 * @returns Whether the existing single-line insertion action can preserve this record.
 */
export const canInsertHistoryCommand = (command: string): boolean =>
  command.trim().length > 0 && !/\p{Cc}/u.test(command);

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
export const sendClientMessage = (
  socket: Pick<WebSocket, 'readyState' | 'send'>,
  payload: ClientOutboundMessage,
): void => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
};

/** One pane's ordinary input and the optional suggestion UI update that follows it. */
type TerminalInputDispatch = {
  socket: Pick<WebSocket, 'readyState' | 'send'> | null;
  paneId: string;
  data: string;
  submissionToken?: string;
  updateAutocomplete: () => void;
};

/**
 * Forwards original input exactly once before running optional autocomplete UI work.
 * The caller must invalidate submission context first. No asynchronous gap is introduced between
 * forwarding and candidate invalidation. UI exceptions cannot discard an already accepted key.
 * @param input Pane transport, unchanged data, submission identity and optional UI update.
 * @returns Nothing. Transport errors propagate; UI failures are reported without input or error text.
 */
export const forwardTerminalInput = (input: TerminalInputDispatch): void => {
  if (input.socket) {
    sendClientMessage(input.socket, {
      type: 'input',
      data: input.data,
      ...(input.submissionToken ? { submissionToken: input.submissionToken } : {}),
    });
  }
  try {
    input.updateAutocomplete();
  } catch {
    // Exceptions from optional callbacks may contain command text; never copy them into logs.
    console.warn('[ssh][input] Failed to update optional autocomplete.', { paneId: input.paneId });
  }
};

/**
 * Compiles user-configured prompt regex into a safe runtime matcher.
 *
 * Accepted formats:
 * - raw pattern, e.g. `^.+[$#]\\s+`
 * - regex literal, e.g. `/^.+[$#]\\s+/i`
 *
 * Stateful `g`/`y` flags are stripped to keep repeated executions deterministic.
 *
 * @param pattern Raw prompt regex setting.
 * @returns Compiled regex or `null` when input is empty/invalid.
 */
export const compilePromptPrefixRegex = (pattern: string): RegExp | null => {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return null;
  }

  const regexLiteralMatch = /^\/(.+)\/([a-z]*)$/i.exec(normalizedPattern);
  const source = regexLiteralMatch?.[1] ?? normalizedPattern;
  const rawFlags = regexLiteralMatch?.[2] ?? '';
  const flagsWithoutState = rawFlags.replace(/[gy]/g, '');
  const flags = flagsWithoutState.includes('u') ? flagsWithoutState : `${flagsWithoutState}u`;

  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};

/**
 * Resolves whether a single character should be treated as prompt terminator.
 *
 * @param value Candidate character.
 * @returns `true` when character is a known prompt terminator marker.
 */
const isPromptTerminatorChar = (value: string): boolean => {
  return PROMPT_TERMINATOR_CHARS.has(value);
};

/**
 * Checks whether a token is composed only by non-word symbols.
 *
 * @param token Candidate token.
 * @returns `true` when token is symbolic-only.
 */
const isSymbolicToken = (token: string): boolean => {
  return token.length > 0 && /^[^A-Za-z0-9_]+$/u.test(token);
};

/** Exact operator tokens that mark command text rather than prompt context. */
const SHELL_OPERATOR_TOKEN_SET = new Set<string>(['&&', '||', '|', ';', ';;', '&', '>', '>>', '<', '<<']);

/**
 * Checks whether a token is a glyph-only prompt status suffix such as `✗`.
 *
 * Restricting the match to non-ASCII symbols keeps ASCII arguments like `--`
 * or `*` from being mistaken for prompt decoration.
 *
 * @param token Candidate token inside the leading prompt run.
 * @returns `true` when token reads as a prompt status glyph.
 */
const isPromptStatusSymbolToken = (token: string): boolean => {
  if (token.length > 3 || !isSymbolicToken(token)) {
    return false;
  }

  for (const character of token) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return true;
    }
  }

  return false;
};

/**
 * Decides whether a token can be interpreted as prompt start context.
 *
 * @param token First token in current shell segment.
 * @returns `true` when token likely belongs to prompt metadata.
 */
const isLikelyPromptStartToken = (token: string): boolean => {
  if (!token) {
    return false;
  }

  const lastChar = token[token.length - 1] ?? '';
  if (isPromptTerminatorChar(lastChar)) {
    return true;
  }

  if (token === 'PS') {
    return true;
  }

  if (token.includes('@') || token.includes('~')) {
    return true;
  }

  return isSymbolicToken(token);
};

/**
 * Detects a standalone environment decoration that may precede shell identity.
 *
 * Conda and Python virtual environments commonly prepend tokens such as
 * `(base)` or `(.venv)` before the user/host prompt. The decoration alone is
 * insufficient evidence of a prompt and must be followed by prompt context.
 *
 * @param token Candidate leading token.
 * @returns `true` when the token is a bounded parenthesized decoration.
 */
const isPromptDecorationToken = (token: string): boolean => PROMPT_DECORATION_TOKEN_PATTERN.test(token);

/**
 * Locates prompt identity after any leading environment decorations.
 *
 * @param tokens Whitespace-preserving tokens from one logical terminal line.
 * @returns Prompt-context token index, or `-1` when the line looks like user input.
 */
const resolvePromptContextTokenIndex = (tokens: PromptBoundaryToken[]): number => {
  const scanLimit = Math.min(tokens.length, MAX_PROMPT_TOKENS_TO_SCAN);
  let tokenIndex = 0;
  while (tokenIndex < scanLimit && isPromptDecorationToken(tokens[tokenIndex]?.value ?? '')) {
    tokenIndex += 1;
  }

  if (tokenIndex >= scanLimit) {
    return -1;
  }

  return isLikelyPromptStartToken(tokens[tokenIndex]?.value ?? '') ? tokenIndex : -1;
};

/**
 * Decides whether a token can be treated as one prompt terminator fragment.
 *
 * @param token Candidate token in prompt segment.
 * @returns `true` when token can delimit prompt and command.
 */
const isPromptTerminatorToken = (token: string): boolean => {
  if (!token) {
    return false;
  }

  const lastChar = token[token.length - 1] ?? '';
  if (isPromptTerminatorChar(lastChar)) {
    return true;
  }

  return token.length <= 3 && isSymbolicToken(token);
};

/**
 * Splits one string into whitespace-delimited tokens while preserving indexes.
 *
 * @param linePrefix Source text to tokenize.
 * @returns Tokens with absolute start indexes.
 */
const tokenizeWhitespace = (linePrefix: string): PromptBoundaryToken[] => {
  const tokens: PromptBoundaryToken[] = [];
  let cursor = 0;

  while (cursor < linePrefix.length) {
    while (cursor < linePrefix.length && /\s/.test(linePrefix[cursor] ?? '')) {
      cursor += 1;
    }

    if (cursor >= linePrefix.length) {
      break;
    }

    const tokenStart = cursor;
    while (cursor < linePrefix.length && !/\s/.test(linePrefix[cursor] ?? '')) {
      cursor += 1;
    }

    tokens.push({
      value: linePrefix.slice(tokenStart, cursor),
      start: tokenStart,
    });
  }

  return tokens;
};

/**
 * Finds the start offset of current shell command segment by parsing separators.
 *
 * Separator parsing intentionally tracks basic shell quoting semantics so
 * `;`, `&&`, `||`, `|` inside quotes do not split command segments.
 *
 * @param linePrefix Full text before cursor.
 * @returns Segment start offset before prompt-specific trimming.
 */
const resolveShellSegmentStartOffset = (linePrefix: string): number => {
  let segmentStartOffset = 0;
  let quote: 'single' | 'double' | null = null;

  for (let cursor = 0; cursor < linePrefix.length; cursor += 1) {
    const currentChar = linePrefix[cursor] ?? '';
    const nextChar = linePrefix[cursor + 1] ?? '';

    if (quote === 'single') {
      if (currentChar === "'") {
        quote = null;
      }

      continue;
    }

    if (quote === 'double') {
      if (currentChar === '"') {
        quote = null;
        continue;
      }

      if (currentChar === '\\') {
        cursor += 1;
      }

      continue;
    }

    if (currentChar === "'") {
      quote = 'single';
      continue;
    }

    if (currentChar === '"') {
      quote = 'double';
      continue;
    }

    if (currentChar === '\\') {
      cursor += 1;
      continue;
    }

    const isSemicolon = currentChar === ';';
    const isPipe = currentChar === '|';
    const isAmpersand = currentChar === '&';
    const isLogicalAnd = isAmpersand && nextChar === '&';
    const isLogicalOr = isPipe && nextChar === '|';
    if (!isSemicolon && !isPipe && !isAmpersand) {
      continue;
    }

    if (isLogicalAnd || isLogicalOr) {
      segmentStartOffset = cursor + 2;
      cursor += 1;
      continue;
    }

    segmentStartOffset = cursor + 1;
  }

  while (segmentStartOffset < linePrefix.length && /\s/.test(linePrefix[segmentStartOffset] ?? '')) {
    segmentStartOffset += 1;
  }

  return Math.max(0, segmentStartOffset);
};

/**
 * Resolves command start offset from user-provided prompt regex.
 *
 * Regex must match prompt prefix from the start of current command segment.
 *
 * @param linePrefix Segment text to evaluate.
 * @param promptPrefixRegex Compiled user regex.
 * @returns Command start offset within segment, or `null` when no match.
 */
const resolveConfiguredPromptOffset = (linePrefix: string, promptPrefixRegex: RegExp | null): number | null => {
  if (!promptPrefixRegex) {
    return null;
  }

  const match = promptPrefixRegex.exec(linePrefix);
  if (!match || match.index !== 0 || match[0].length === 0) {
    return null;
  }

  return Math.max(0, Math.min(linePrefix.length, match[0].length));
};

/**
 * Resolves command start offset by prompt heuristics around first prompt token.
 *
 * This fallback intentionally avoids hardcoded full prompt tokens. It first
 * requires the leading token to look like prompt context and then scans a
 * bounded token window for the last prompt terminator marker.
 *
 * @param linePrefix Segment text after shell separator parsing.
 * @returns Command start offset within segment.
 */
const resolveHeuristicPromptOffset = (linePrefix: string): number => {
  const tokens = tokenizeWhitespace(linePrefix);
  if (tokens.length === 0) {
    return 0;
  }

  const promptContextTokenIndex = resolvePromptContextTokenIndex(tokens);
  if (promptContextTokenIndex < 0) {
    return 0;
  }

  let lastPromptTerminatorIndex = -1;
  const scanLimit = Math.min(tokens.length, MAX_PROMPT_TOKENS_TO_SCAN);
  for (let tokenIndex = promptContextTokenIndex; tokenIndex < scanLimit; tokenIndex += 1) {
    const currentToken = tokens[tokenIndex]?.value ?? '';
    if (!isPromptTerminatorToken(currentToken)) {
      continue;
    }

    lastPromptTerminatorIndex = tokenIndex;
  }

  const nextCommandToken =
    lastPromptTerminatorIndex >= 0
      ? (tokens[lastPromptTerminatorIndex + 1] ?? null)
      : (tokens[promptContextTokenIndex + 1] ?? null);
  if (lastPromptTerminatorIndex >= 0 && !nextCommandToken) {
    // Prompt-only frame (no echoed command text yet): anchor command start at prompt end.
    return Math.max(0, linePrefix.length);
  }

  const promptContextToken = tokens[promptContextTokenIndex]?.value ?? '';
  if (tokens.length === promptContextTokenIndex + 1 && isPromptTerminatorToken(promptContextToken)) {
    return Math.max(0, linePrefix.length);
  }

  if (!nextCommandToken) {
    return 0;
  }

  return Math.max(0, nextCommandToken.start);
};

/**
 * Finds the largest overlap where the rendered prefix suffix already contains
 * the beginning of the local suffix. This keeps readline-recalled commands from
 * duplicating text while the terminal echo is still catching up.
 *
 * @param renderedCommandPrefix Command prefix reconstructed from xterm.
 * @param localCommandPrefix Local input suffix tracked from xterm input events.
 * @returns Number of local-prefix characters already present at the rendered suffix.
 */
const resolveRenderedLocalPrefixOverlap = (renderedCommandPrefix: string, localCommandPrefix: string): number => {
  const maxOverlapLength = Math.min(renderedCommandPrefix.length, localCommandPrefix.length);

  for (let overlapLength = maxOverlapLength; overlapLength > 0; overlapLength -= 1) {
    if (renderedCommandPrefix.endsWith(localCommandPrefix.slice(0, overlapLength))) {
      return overlapLength;
    }
  }

  return 0;
};

/**
 * Resolves the command prefix used for completion requests from rendered xterm
 * state and local input shadow state.
 *
 * @param renderedCommandPrefix Command prefix reconstructed from the visible xterm row.
 * @param localCommandPrefix Command prefix or suffix tracked from local input events.
 * @param options Reconciliation mode for local shadow state.
 * @returns Effective command prefix to send to the completion backend.
 */
export const resolveAutocompleteCommandPrefix = (
  renderedCommandPrefix: string,
  localCommandPrefix: string | undefined,
  options?: AutocompleteCommandPrefixResolveOptions,
): string => {
  if (localCommandPrefix === undefined) {
    return renderedCommandPrefix;
  }

  if (!options?.localPrefixNeedsRenderedContext) {
    return localCommandPrefix;
  }

  if (renderedCommandPrefix.length === 0) {
    return localCommandPrefix;
  }

  if (localCommandPrefix.length === 0) {
    return renderedCommandPrefix;
  }

  if (renderedCommandPrefix.endsWith(localCommandPrefix)) {
    return renderedCommandPrefix;
  }

  if (localCommandPrefix.startsWith(renderedCommandPrefix)) {
    return localCommandPrefix;
  }

  const overlapLength = resolveRenderedLocalPrefixOverlap(renderedCommandPrefix, localCommandPrefix);
  return `${renderedCommandPrefix}${localCommandPrefix.slice(overlapLength)}`;
};

/**
 * Calibrates a reconstructed completion prefix with trusted shell cursor metadata.
 *
 * The helper never sends command text. Calibration is therefore applied only when
 * renderer reconstruction has the exact helper-reported line length; otherwise the
 * existing conservative prefix remains unchanged.
 *
 * @param commandPrefix Reconstructed command buffer candidate.
 * @param lineState Optional helper-reported line length and cursor index.
 * @returns Prefix ending at the trusted cursor when lengths agree.
 */
export const calibrateAutocompleteCommandPrefix = (
  commandPrefix: string,
  lineState: { lineLength: number; cursorIndex: number } | null,
): string => {
  if (!lineState || commandPrefix.length !== lineState.lineLength) {
    return commandPrefix;
  }

  return commandPrefix.slice(0, lineState.cursorIndex);
};

/**
 * Locates where user input starts without treating shell separators as a new
 * autocomplete segment.
 *
 * Command timeline tooltips need the complete submitted line, while
 * autocomplete intentionally narrows its context after separators such as
 * `&&` or `|`. Keeping prompt stripping separate prevents timeline entries
 * from losing the earlier portions of compound commands.
 *
 * @param line Visible logical terminal line containing prompt and user input.
 * @param options Optional prompt parsing configuration.
 * @returns Zero-based command start offset within the complete logical line.
 */
export const resolvePromptCommandStartOffset = (line: string, options?: CommandStartResolveOptions): number => {
  const configuredOffset = resolveConfiguredPromptOffset(line, options?.promptPrefixRegex ?? null);
  if (configuredOffset !== null) {
    return Math.max(0, configuredOffset);
  }

  // Prompt parsing takes the last terminator inside the leading prompt run but
  // hard-stops at shell operator tokens, so `&&` in a compound command never
  // reads as prompt context while glyph-led prompts (`➜ repo git:(main) ✗`)
  // still strip through their trailing status symbols.
  const tokens = tokenizeWhitespace(line);
  const promptContextTokenIndex = resolvePromptContextTokenIndex(tokens);
  if (promptContextTokenIndex >= 0) {
    const scanLimit = Math.min(tokens.length, MAX_PROMPT_TOKENS_TO_SCAN);
    let lastPromptTerminatorTokenIndex = -1;
    for (let tokenIndex = promptContextTokenIndex; tokenIndex < scanLimit; tokenIndex += 1) {
      const token = tokens[tokenIndex]?.value ?? '';
      if (SHELL_OPERATOR_TOKEN_SET.has(token)) {
        break;
      }

      const lastChar = token[token.length - 1] ?? '';
      if (isPromptTerminatorChar(lastChar) || isPromptStatusSymbolToken(token)) {
        lastPromptTerminatorTokenIndex = tokenIndex;
      }
    }

    if (lastPromptTerminatorTokenIndex >= 0) {
      return tokens[lastPromptTerminatorTokenIndex + 1]?.start ?? line.length;
    }
  }

  return Math.max(0, resolveHeuristicPromptOffset(line));
};

/**
 * Locates where user command starts in a shell prompt line.
 *
 * @param linePrefix Visible content before cursor on current line.
 * @param options Optional prompt parsing configuration.
 * @returns Zero-based command start column.
 */
export const resolveCommandStartOffset = (linePrefix: string, options?: CommandStartResolveOptions): number => {
  const segmentStartOffset = resolveShellSegmentStartOffset(linePrefix);
  const segmentPrefix = linePrefix.slice(segmentStartOffset);
  return Math.max(0, segmentStartOffset + resolvePromptCommandStartOffset(segmentPrefix, options));
};

/**
 * Resolves current shell line prefix and extracted command-only prefix.
 *
 * @param terminal Source xterm instance.
 * @param options Optional prompt parsing configuration.
 * @returns Cursor row and command prefix context, or `null` when unavailable.
 */
export const resolveTerminalCurrentLinePrefix = (
  terminal: Terminal,
  options?: CommandStartResolveOptions,
): {
  fullLinePrefix: string;
  commandPrefix: string;
  commandStartColumn: number;
  commandPrefixStartOffset: number;
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

  const visualLinePrefix = line.translateToString(true, 0, cursorX);

  // Reconstruct the wrapped logical line so long commands keep full context for completion.
  const wrappedSegments: string[] = [visualLinePrefix];
  let scanLineIndex = absoluteLineIndex;
  while (scanLineIndex > 0) {
    const currentLine = activeBuffer.getLine(scanLineIndex);
    if (!currentLine?.isWrapped) {
      break;
    }

    const previousLine = activeBuffer.getLine(scanLineIndex - 1);
    if (!previousLine) {
      break;
    }

    wrappedSegments.unshift(previousLine.translateToString(true));
    scanLineIndex -= 1;
  }

  const fullLinePrefix = wrappedSegments.join('');
  const commandPrefixStartOffset = resolveCommandStartOffset(fullLinePrefix, options);
  const commandStartColumn = resolveCommandStartOffset(visualLinePrefix, options);

  return {
    fullLinePrefix,
    commandPrefix: fullLinePrefix.slice(commandPrefixStartOffset),
    commandStartColumn,
    commandPrefixStartOffset,
    cursorRow: cursorY,
  };
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
 * Unwraps one shell-style quoted selection while preserving the path body.
 *
 * @param value Candidate path text.
 * @returns Unquoted value when the full selection uses matching quotes.
 */
const stripShellPathQuotes = (value: string): string => {
  const quotedMatch = SHELL_QUOTED_PATH_PATTERN.exec(value);
  if (!quotedMatch) {
    return value;
  }

  return quotedMatch[2] ?? '';
};

/**
 * Decodes URL path text without letting malformed escape sequences break UI render.
 *
 * @param value Encoded path text.
 * @returns Decoded path text, or the original value when decoding fails.
 */
const safeDecodePathComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Resolves terminal selection text into a remote SFTP directory path candidate.
 *
 * This parser intentionally accepts only explicit POSIX-like directory strings:
 * absolute paths, home-relative paths, and dot-relative paths. Bare relative
 * names are excluded. Dot-relative paths are resolved only when the source pane
 * has a usable physical cwd. Dot components remain intact for remote symbolic-link resolution.
 *
 * @param text Raw terminal selection text.
 * @param directory Fresh directory metadata belonging to the source pane.
 * @returns Normalized path candidate or `null` when selection is not a safe directory path.
 */
export const resolveSftpDirectoryPathFromSelection = (
  text: string,
  directory?: ShellDirectoryContext | null,
): string | null => {
  const firstLine = text.trim();
  if (/[\r\n]/u.test(firstLine) || firstLine.includes('\u0000')) return null;
  if (!firstLine) {
    return null;
  }

  const fileUrlMatch = SHELL_FILE_URL_PATTERN.exec(firstLine);
  const rawCandidate = fileUrlMatch ? safeDecodePathComponent(fileUrlMatch[1] ?? '') : firstLine;
  const unquotedCandidate = stripShellPathQuotes(rawCandidate);
  if (/[\r\n]/u.test(unquotedCandidate) || unquotedCandidate.includes('\u0000')) return null;
  const withoutTrailingSlash =
    unquotedCandidate.length > 1 ? unquotedCandidate.replace(/\/+$/g, '') : unquotedCandidate;

  if (!REMOTE_DIRECTORY_PATH_PATTERN.test(withoutTrailingSlash)) {
    return null;
  }

  if (withoutTrailingSlash.startsWith('/')) return withoutTrailingSlash;
  if (withoutTrailingSlash.startsWith('~'))
    return directory?.home ? directory.home + withoutTrailingSlash.slice(1) : null;
  return directory?.physical ? directory.physical + '/' + withoutTrailingSlash : null;
};

/**
 * Resolves a deterministic pane collection and active pane after one close request.
 *
 * @param paneIds Ordered visible pane ids.
 * @param activePaneId Currently active pane id.
 * @param closingPaneId Pane requested for closure.
 * @returns Next pane state, or `null` when closure is not allowed.
 */
export const resolveTerminalPaneCloseTransition = (
  paneIds: readonly string[],
  activePaneId: string,
  closingPaneId: string,
): { paneIds: string[]; activePaneId: string } | null => {
  if (paneIds.length <= 1) {
    return null;
  }

  const closingIndex = paneIds.indexOf(closingPaneId);
  if (closingIndex < 0) {
    return null;
  }

  const nextPaneIds = paneIds.filter((paneId) => paneId !== closingPaneId);
  return {
    paneIds: nextPaneIds,
    activePaneId:
      activePaneId === closingPaneId
        ? (nextPaneIds[Math.max(0, closingIndex - 1)] ?? nextPaneIds[0] ?? activePaneId)
        : activePaneId,
  };
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
  terminal.options.ignoreBracketedPasteMode = options.ignoreBracketedPasteMode;
  terminal.options.letterSpacing = options.letterSpacing;
  terminal.options.lineHeight = options.lineHeight;
  terminal.options.macOptionClickForcesSelection = options.macOptionClickForcesSelection;
  terminal.options.macOptionIsMeta = options.macOptionIsMeta;
  terminal.options.minimumContrastRatio = options.minimumContrastRatio;
  terminal.options.overviewRuler = options.overviewRuler;
  terminal.options.rightClickSelectsWord = options.rightClickSelectsWord;
  terminal.options.screenReaderMode = options.screenReaderMode;
  terminal.options.scrollback = options.scrollback;
  terminal.options.scrollOnUserInput = options.scrollOnUserInput;
  terminal.options.scrollSensitivity = options.scrollSensitivity;
  terminal.options.smoothScrollDuration = options.smoothScrollDuration;
  terminal.options.tabStopWidth = options.tabStopWidth;
  terminal.options.theme = options.theme;
};
