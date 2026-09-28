import type { TerminalClientMessage } from '@cosmosh/api-contract';
import type { RawData } from 'ws';

import { normalizeEditorBuffer } from './editor-protocol.js';

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
export type TerminalClientInboundMessage = TerminalClientMessage;

/**
 * Parses a raw WebSocket payload into terminal client contract.
 */
export const normalizeTerminalClientMessage = (payload: RawData): TerminalClientInboundMessage | null => {
  try {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;

    if (parsed.type === 'editor-snapshot' || parsed.type === 'editor-apply') {
      if (typeof parsed.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(parsed.requestId)) return null;
      if (parsed.type === 'editor-snapshot') return { type: parsed.type, requestId: parsed.requestId };
      const replacement = normalizeEditorBuffer(parsed.replacement);
      if (!replacement || typeof parsed.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/u.test(parsed.snapshotId))
        return null;
      return { type: parsed.type, requestId: parsed.requestId, snapshotId: parsed.snapshotId, replacement };
    }

    if (parsed.type === 'input' && typeof parsed.data === 'string') {
      if (
        parsed.submissionToken !== undefined &&
        (typeof parsed.submissionToken !== 'string' || !/^[a-f0-9-]{36}$/u.test(parsed.submissionToken))
      )
        return null;
      return {
        type: 'input',
        data: parsed.data,
        ...(typeof parsed.submissionToken === 'string' ? { submissionToken: parsed.submissionToken } : {}),
      };
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

    if (
      parsed.type === 'credential-fill' &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      parsed.token.length <= 128
    ) {
      return { type: 'credential-fill', token: parsed.token };
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
      (parsed.workingDirectoryHint === undefined || typeof parsed.workingDirectoryHint === 'string') &&
      (parsed.limit === undefined || typeof parsed.limit === 'number') &&
      (parsed.fuzzyMatch === undefined || typeof parsed.fuzzyMatch === 'boolean') &&
      (parsed.includeHistory === undefined || typeof parsed.includeHistory === 'boolean') &&
      (parsed.includeBuiltInCommands === undefined || typeof parsed.includeBuiltInCommands === 'boolean') &&
      (parsed.includePathSuggestions === undefined || typeof parsed.includePathSuggestions === 'boolean') &&
      (parsed.trigger === 'typing' || parsed.trigger === 'manual')
    ) {
      return {
        type: 'completion-request',
        requestId: parsed.requestId,
        linePrefix: parsed.linePrefix,
        cursorIndex: parsed.cursorIndex,
        workingDirectoryHint: parsed.workingDirectoryHint,
        limit: parsed.limit,
        fuzzyMatch: parsed.fuzzyMatch,
        includeHistory: parsed.includeHistory,
        includeBuiltInCommands: parsed.includeBuiltInCommands,
        includePathSuggestions: parsed.includePathSuggestions,
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
