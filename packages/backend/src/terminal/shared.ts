import type { TerminalClientMessage } from '@cosmosh/api-contract';
import type { RawData } from 'ws';

/** Shared telemetry refresh interval for terminal-like sessions. */
export const TERMINAL_TELEMETRY_INTERVAL_MS = 5_000;

/** Browser-to-backend WebSocket contract for interactive terminal streams. */
export type TerminalClientInboundMessage = TerminalClientMessage;

/**
 * Parses a raw WebSocket payload into the interactive terminal contract.
 *
 * @param payload Raw WebSocket frame received from Renderer.
 * @returns A valid terminal message, or null for malformed payloads.
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

    return null;
  } catch {
    return null;
  }
};

/**
 * Clamps PTY columns or rows to safe bounds and rounds non-integer values.
 *
 * @param value Requested terminal dimension.
 * @param fallback Value used when the request is not finite.
 * @param min Smallest supported dimension.
 * @param max Largest supported dimension.
 * @returns Clamped integer dimension.
 */
export const clampTerminalSize = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};
