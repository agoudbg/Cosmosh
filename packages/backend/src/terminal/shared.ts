import type { RawData } from 'ws';

/**
 * Shared telemetry refresh interval for terminal-like sessions.
 */
export const TERMINAL_TELEMETRY_INTERVAL_MS = 5_000;

/**
 * Debounce window for command history refresh after user input.
 */
export const TERMINAL_HISTORY_REFRESH_DEBOUNCE_MS = 120;

/**
 * Minimum spacing between consecutive history refresh executions.
 */
export const TERMINAL_HISTORY_REFRESH_THROTTLE_MS = 450;

/**
 * Maximum number of recent command entries kept in memory.
 */
export const TERMINAL_HISTORY_MAX_ENTRIES = 200;

/**
 * Browser-to-backend WebSocket contract for interactive terminal streams.
 */
export type TerminalClientInboundMessage =
  | {
      type: 'input';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    }
  | {
      type: 'close';
    }
  | {
      type: 'ping';
    }
  | {
      type: 'history-delete';
      command: string;
    }
  | {
      type: 'completion-request';
      requestId: string;
      linePrefix: string;
      cursorIndex: number;
      limit?: number;
      fuzzyMatch?: boolean;
      trigger: 'typing' | 'manual';
    };

/**
 * Parses a raw WebSocket payload into terminal client contract.
 */
export const normalizeTerminalClientMessage = (payload: RawData): TerminalClientInboundMessage | null => {
  try {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;

    if (parsed.type === 'input' && typeof parsed.data === 'string') {
      return { type: 'input', data: parsed.data };
    }

    if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
      return {
        type: 'resize',
        cols: parsed.cols,
        rows: parsed.rows,
      };
    }

    if (parsed.type === 'close') {
      return { type: 'close' };
    }

    if (parsed.type === 'ping') {
      return { type: 'ping' };
    }

    if (parsed.type === 'history-delete' && typeof parsed.command === 'string') {
      return {
        type: 'history-delete',
        command: parsed.command,
      };
    }

    if (
      parsed.type === 'completion-request' &&
      typeof parsed.requestId === 'string' &&
      typeof parsed.linePrefix === 'string' &&
      typeof parsed.cursorIndex === 'number' &&
      (parsed.limit === undefined || typeof parsed.limit === 'number') &&
      (parsed.fuzzyMatch === undefined || typeof parsed.fuzzyMatch === 'boolean') &&
      (parsed.trigger === 'typing' || parsed.trigger === 'manual')
    ) {
      return {
        type: 'completion-request',
        requestId: parsed.requestId,
        linePrefix: parsed.linePrefix,
        cursorIndex: parsed.cursorIndex,
        limit: parsed.limit,
        fuzzyMatch: parsed.fuzzyMatch,
        trigger: parsed.trigger,
      };
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Clamps PTY columns/rows to safe bounds and rounds non-integer values.
 */
export const clampTerminalSize = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};

/**
 * Parses mixed shell history lines into a normalized command list.
 */
export const parseTerminalHistoryOutput = (output: string, maxEntries = TERMINAL_HISTORY_MAX_ENTRIES): string[] => {
  const lines = output.split(/\r?\n/);
  const parsedCommands: string[] = [];

  for (const line of lines) {
    const command = parseTerminalHistoryLine(line);
    if (!command) {
      continue;
    }

    parsedCommands.push(command);
  }

  const deduplicated: string[] = [];
  const seen = new Set<string>();

  for (let index = parsedCommands.length - 1; index >= 0; index -= 1) {
    const command = parsedCommands[index];
    if (seen.has(command)) {
      continue;
    }

    seen.add(command);
    deduplicated.push(command);

    if (deduplicated.length >= maxEntries) {
      break;
    }
  }

  return deduplicated.reverse();
};

/**
 * Merges prioritized and fallback command lists while preserving order and uniqueness.
 */
export const mergeTerminalRecentCommands = (
  prioritized: readonly string[],
  fallback: readonly string[],
  maxEntries = TERMINAL_HISTORY_MAX_ENTRIES,
): string[] => {
  const merged: string[] = [];
  const seen = new Set<string>();

  const append = (commands: readonly string[]): void => {
    for (const command of commands) {
      const normalized = command.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      merged.push(normalized);
      if (merged.length >= maxEntries) {
        return;
      }
    }
  };

  append(prioritized);
  if (merged.length < maxEntries) {
    append(fallback);
  }

  return merged;
};

/**
 * Computes effective delay for history refresh with debounce + throttle semantics.
 */
export const computeHistorySyncDelayMs = (
  lastHistorySyncStartedAtMs: number,
  nowMs: number,
  options?: { immediate?: boolean },
): number => {
  const throttleRemaining = Math.max(0, TERMINAL_HISTORY_REFRESH_THROTTLE_MS - (nowMs - lastHistorySyncStartedAtMs));
  const baseDelayMs = options?.immediate ? 0 : TERMINAL_HISTORY_REFRESH_DEBOUNCE_MS;
  return Math.max(baseDelayMs, throttleRemaining);
};

export type TerminalInteractiveCompletionState = {
  lineBuffer: string;
  recentCommands: string[];
};

/**
 * Updates session-scoped interactive completion state from raw terminal input stream.
 * This parser intentionally tracks only commands typed in the current live session.
 */
export const updateInteractiveCompletionState = (
  state: TerminalInteractiveCompletionState,
  inputData: string,
  options?: { maxEntries?: number },
): void => {
  const maxEntries = Math.max(1, options?.maxEntries ?? TERMINAL_HISTORY_MAX_ENTRIES);
  let lineBuffer = state.lineBuffer;
  let recentCommands = state.recentCommands;

  const commitCurrentBuffer = (): void => {
    const normalizedCommand = lineBuffer.trim();
    if (!normalizedCommand) {
      lineBuffer = '';
      return;
    }

    recentCommands = [normalizedCommand, ...recentCommands.filter((entry) => entry !== normalizedCommand)].slice(
      0,
      maxEntries,
    );

    lineBuffer = '';
  };

  for (let index = 0; index < inputData.length; index += 1) {
    const char = inputData[index] ?? '';

    if (char === '\x1b') {
      break;
    }

    if (char === '\r' || char === '\n') {
      commitCurrentBuffer();
      continue;
    }

    if (char === '\u0003') {
      lineBuffer = '';
      continue;
    }

    if (char === '\x7f' || char === '\b') {
      if (lineBuffer.length > 0) {
        lineBuffer = lineBuffer.slice(0, -1);
      }
      continue;
    }

    if (char === '\t' || char === '\u0000') {
      continue;
    }

    if (char >= ' ') {
      lineBuffer += char;
    }
  }

  state.lineBuffer = lineBuffer;
  state.recentCommands = recentCommands;
};

const parseTerminalHistoryLine = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (/^#[0-9]{9,}$/.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith('- cmd: ')) {
    const fishCommand = trimmed.slice(7).replace(/\\n/g, '\n').trim();
    return fishCommand.length > 0 ? fishCommand : null;
  }

  const zshExtendedMatch = /^:\s*\d+:\d+;(.*)$/.exec(trimmed);
  if (zshExtendedMatch) {
    const zshCommand = zshExtendedMatch[1]?.trim() ?? '';
    return zshCommand.length > 0 ? zshCommand : null;
  }

  const numberedHistoryMatch = /^\s*\d+\*?\s+(.*)$/.exec(trimmed);
  if (numberedHistoryMatch) {
    const command = numberedHistoryMatch[1]?.trim() ?? '';
    return command.length > 0 ? command : null;
  }

  if (/^(when|paths?|exit|cwd):\s*/i.test(trimmed)) {
    return null;
  }

  return trimmed;
};
