/** Renderer-document epoch shared by every standalone terminal Bell edge. */
export const TERMINAL_BELL_RENDERER_EPOCH = globalThis.crypto.randomUUID();

let terminalBellSequence = 0;

/**
 * Allocates one total-order Bell identity within the current renderer epoch.
 *
 * @returns Positive renderer-window sequence number.
 */
export const allocateTerminalBellSequence = (): number => {
  terminalBellSequence += 1;
  return terminalBellSequence;
};
