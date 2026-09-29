import type { TerminalClientMessage } from '@cosmosh/api-contract';
import type { RawData } from 'ws';

import { normalizeNativeHistoryObservation } from './editor-protocol.js';

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

    if (
      parsed.type === 'directory-query' ||
      parsed.type === 'directory-cancel' ||
      parsed.type === 'completion-query' ||
      parsed.type === 'completion-cancel' ||
      parsed.type === 'completion-accept'
    ) {
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
      if (typeof parsed.requestId !== 'string' || !uuid.test(parsed.requestId)) return null;
      if (parsed.type === 'directory-query' || parsed.type === 'directory-cancel') {
        if (Object.keys(parsed).length !== 2) return null;
        return { type: parsed.type, requestId: parsed.requestId };
      }
      if (parsed.type === 'completion-cancel') {
        if (Object.keys(parsed).length !== 2) return null;
        return { type: parsed.type, requestId: parsed.requestId };
      }
      if (parsed.type === 'completion-query') {
        if (Object.keys(parsed).length !== 3 || (parsed.trigger !== 'typing' && parsed.trigger !== 'manual'))
          return null;
        return { type: parsed.type, requestId: parsed.requestId, trigger: parsed.trigger };
      }
      if (
        Object.keys(parsed).length !== 4 ||
        typeof parsed.snapshotId !== 'string' ||
        !uuid.test(parsed.snapshotId) ||
        typeof parsed.candidateId !== 'string' ||
        !uuid.test(parsed.candidateId)
      )
        return null;
      return {
        type: parsed.type,
        requestId: parsed.requestId,
        snapshotId: parsed.snapshotId,
        candidateId: parsed.candidateId,
      };
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

    if (parsed.type === 'shell-history-remove') {
      if (
        typeof parsed.requestId !== 'string' ||
        !/^[a-f0-9-]{36}$/u.test(parsed.requestId) ||
        typeof parsed.sourceId !== 'string' ||
        !/^[a-f0-9-]{36}$/u.test(parsed.sourceId) ||
        typeof parsed.command !== 'string' ||
        !normalizeNativeHistoryObservation({ status: 'ok', namespace: 'fish', entries: [parsed.command] })
      )
        return null;
      return { type: parsed.type, requestId: parsed.requestId, sourceId: parsed.sourceId, command: parsed.command };
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
