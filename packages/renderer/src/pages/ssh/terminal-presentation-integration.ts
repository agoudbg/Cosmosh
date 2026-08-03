import type { Terminal } from '@xterm/xterm';

import { parseTerminalOscProgress, type TerminalPresentationStateAction } from './terminal-presentation-state';

/** Renderer-window Bell sequence shared by every terminal integration instance. */
let terminalBellSequence = 0;

/**
 * Allocates a total-order identity for one standalone Bell edge.
 *
 * @returns Positive renderer-window sequence number.
 */
const allocateTerminalBellSequence = (): number => {
  terminalBellSequence += 1;
  return terminalBellSequence;
};

/** Dependencies required to passively observe one pane's xterm presentation events. */
export type TerminalPresentationIntegrationOptions = {
  /** Logical pane that owns the terminal instance. */
  paneId: string;
  /** xterm instance that remains the only terminal control-sequence parser. */
  terminal: Terminal;
  /** Pane-aware reducer sink owned by the SSH runtime coordinator. */
  dispatch: (action: TerminalPresentationStateAction) => void;
  /** Local clock used to timestamp standalone Bell events. */
  now?: () => number;
};

/** Disposable listener group attached to one xterm instance. */
export type TerminalPresentationIntegration = {
  /**
   * Runs a reset after xterm drains presentation events from previously queued
   * output, unless this integration is disposed first.
   *
   * @param reset Reset callback owned by the pane state coordinator.
   * @returns Nothing.
   */
  resetAfterPendingWrites: (reset: () => void) => void;
  /**
   * Clears session-owned title and progress after xterm drains queued output.
   *
   * @returns Nothing.
   */
  endSessionAfterPendingWrites: () => void;
  /**
   * Removes every registered presentation listener without disposing xterm itself.
   *
   * @returns Nothing.
   */
  dispose: () => void;
};

/**
 * Registers passive presentation listeners on one pane's xterm parser.
 *
 * OSC bytes stay in the normal PTY-to-xterm data path. xterm owns streaming
 * reassembly and OSC terminator handling; this integration only consumes
 * complete parser callbacks and independent Bell events.
 *
 * @param options Pane identity, xterm instance, reducer sink, and optional clock.
 * @returns Idempotent disposable for all registered presentation listeners.
 */
export const registerTerminalPresentationIntegration = (
  options: TerminalPresentationIntegrationOptions,
): TerminalPresentationIntegration => {
  const { paneId, terminal, dispatch, now = Date.now } = options;
  const titleDisposable = terminal.onTitleChange((title) => {
    dispatch({
      type: 'application-title',
      paneId,
      title,
    });
  });
  const progressDisposable = terminal.parser.registerOscHandler(9, (data) => {
    const parsed = parseTerminalOscProgress(data);
    if (!parsed.matched) {
      return false;
    }

    if (parsed.progress) {
      dispatch({
        type: 'progress',
        paneId,
        progress: parsed.progress,
      });
    }

    return true;
  });
  const bellDisposable = terminal.onBell(() => {
    dispatch({
      type: 'bell',
      paneId,
      sequence: allocateTerminalBellSequence(),
      receivedAt: now(),
    });
  });
  let disposed = false;

  /**
   * Places a cancellable presentation lifecycle callback behind xterm's parser queue.
   *
   * @param callback Lifecycle callback to run after queued writes.
   * @returns Nothing.
   */
  const runAfterPendingWrites = (callback: () => void): void => {
    if (disposed) {
      return;
    }

    // The empty write is a parser barrier: old presentation events run before
    // lifecycle cleanup, while later output remains ordered after it.
    terminal.write('', () => {
      if (!disposed) {
        callback();
      }
    });
  };

  /**
   * Places a caller-owned reset behind xterm's current parser queue.
   *
   * @param reset Reset callback owned by the pane state coordinator.
   * @returns Nothing.
   */
  const resetAfterPendingWrites = (reset: () => void): void => {
    runAfterPendingWrites(reset);
  };

  /**
   * Ends the current presentation session without discarding Bell attention.
   *
   * @returns Nothing.
   */
  const endSessionAfterPendingWrites = (): void => {
    runAfterPendingWrites(() => {
      dispatch({ type: 'session-ended', paneId });
    });
  };

  /**
   * Disables pending lifecycle callbacks and releases all xterm presentation listeners.
   *
   * @returns Nothing.
   */
  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    bellDisposable.dispose();
    progressDisposable.dispose();
    titleDisposable.dispose();
  };

  return {
    resetAfterPendingWrites,
    endSessionAfterPendingWrites,
    dispose,
  };
};
