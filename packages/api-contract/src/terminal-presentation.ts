/** Supported user-facing attention policies for standalone terminal Bell events. */
export const TERMINAL_BELL_ATTENTION_MODES = ['audible', 'visual', 'taskbar', 'all', 'none'] as const;

/** User-facing attention policy for standalone terminal Bell events. */
export type TerminalBellAttentionMode = (typeof TERMINAL_BELL_ATTENTION_MODES)[number];

/** Default Bell policy preserves sound, tab attention, and taskbar Flash behavior. */
export const DEFAULT_TERMINAL_BELL_ATTENTION_MODE: TerminalBellAttentionMode = 'all';

/**
 * Checks whether a Bell policy includes an audible operating-system signal.
 *
 * @param mode Configured Bell attention policy.
 * @returns Whether Main should play an audible Bell signal.
 */
export const isTerminalBellAudible = (mode: TerminalBellAttentionMode): boolean => {
  return mode === 'audible' || mode === 'all';
};

/**
 * Checks whether a Bell policy includes the tab-local visual attention slot.
 *
 * @param mode Configured Bell attention policy.
 * @returns Whether Renderer should expose Bell attention in terminal tabs.
 */
export const isTerminalBellVisual = (mode: TerminalBellAttentionMode): boolean => {
  return mode === 'visual' || mode === 'all';
};

/**
 * Checks whether a Bell policy includes window taskbar Flash attention.
 *
 * @param mode Configured Bell attention policy.
 * @returns Whether Main should Flash an unfocused window for a new Bell.
 */
export const isTerminalBellTaskbar = (mode: TerminalBellAttentionMode): boolean => {
  return mode === 'taskbar' || mode === 'all';
};
