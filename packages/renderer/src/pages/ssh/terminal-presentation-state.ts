/** Maximum number of Unicode code points retained from an application-provided terminal title. */
export const MAX_TERMINAL_APPLICATION_TITLE_CODE_POINTS = 256;

const TERMINAL_TITLE_DIRECTIONAL_FORMATTING_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const TERMINAL_TITLE_WHITESPACE = /\s+/gu;
const OSC_PROGRESS_INTEGER = /^(?:0|[1-9]\d{0,2})$/u;
const OSC_PROGRESS_STATE = /^[0-4]$/u;

/**
 * Replaces terminal control code points with spaces without relying on a
 * control-character regular expression that obscures the accepted ranges.
 *
 * @param title Raw terminal title.
 * @returns Title with C0, DEL, and C1 code points replaced by spaces.
 */
const replaceTerminalTitleControlCharacters = (title: string): string =>
  Array.from(title, (character) => {
    const codePoint = character.codePointAt(0);
    const isControl = codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    return isControl ? ' ' : character;
  }).join('');

/** Presentation states defined by the OSC 9;4 progress protocol. */
export type TerminalProgressState = 'none' | 'normal' | 'error' | 'indeterminate' | 'warning';

/** Validated progress presentation emitted by an OSC 9;4 sequence. */
export type TerminalPresentationProgress =
  | {
      state: 'none' | 'indeterminate';
      value: null;
    }
  | {
      state: 'normal' | 'error' | 'warning';
      value: number;
    };

/** Passive terminal presentation state owned by one terminal pane. */
export type TerminalPresentationState = {
  /** Sanitized, memory-only title most recently emitted through OSC 0/2. */
  applicationTitle: string | null;
  /** Current application-reported OSC 9;4 state. */
  progressState: TerminalProgressState;
  /** Validated percentage for determinate states, otherwise null. */
  progressValue: number | null;
  /** Whether this pane has Bell attention awaiting user acknowledgement. */
  bellAttention: boolean;
  /** Local receipt time of the newest valid standalone Bell event. */
  lastBellAt: number | null;
  /**
   * Monotonic pane-local event identity used to preserve distinct Bell edges
   * when multiple events share the same wall-clock timestamp.
   */
  bellSequence: number;
};

/** Pane-indexed terminal presentation state. */
export type TerminalPresentationStateMap = Readonly<Record<string, TerminalPresentationState>>;

/** Reducer actions accepted by the pane presentation domain. */
export type TerminalPresentationStateAction =
  | { type: 'ensure-pane'; paneId: string }
  | { type: 'reset-pane'; paneId: string }
  | { type: 'session-ended'; paneId: string }
  | { type: 'remove-pane'; paneId: string }
  | { type: 'application-title'; paneId: string; title: string }
  | { type: 'progress'; paneId: string; progress: TerminalPresentationProgress }
  | { type: 'bell'; paneId: string; receivedAt: number }
  | { type: 'acknowledge-bell'; paneId: string };

/** Result of inspecting one xterm OSC 9 payload for the `9;4` progress namespace. */
export type TerminalOscProgressParseResult =
  | { matched: false }
  | {
      matched: true;
      /**
       * Null means the payload selected OSC 9;4 but failed strict validation.
       * Callers should consume and ignore it instead of forwarding malformed
       * presentation data to another OSC 9 handler.
       */
      progress: TerminalPresentationProgress | null;
    };

/**
 * Creates isolated baseline presentation state for one terminal pane.
 *
 * @returns Fresh state with no application-owned title, progress, or Bell attention.
 */
export const createTerminalPresentationState = (): TerminalPresentationState => ({
  applicationTitle: null,
  progressState: 'none',
  progressValue: null,
  bellAttention: false,
  lastBellAt: null,
  bellSequence: 0,
});

/**
 * Sanitizes an untrusted application title before it reaches Cosmosh chrome.
 *
 * Control characters become spaces so adjacent words do not collapse. Unicode
 * directional formatting controls are removed to prevent title-bar spoofing,
 * while ordinary non-ASCII text and emoji remain intact.
 *
 * @param title Raw title received from the terminal parser.
 * @returns Bounded display title, or null when no visible content remains.
 */
export const sanitizeTerminalApplicationTitle = (title: string): string | null => {
  const normalized = replaceTerminalTitleControlCharacters(title)
    .replace(TERMINAL_TITLE_DIRECTIONAL_FORMATTING_CHARACTERS, '')
    .replace(TERMINAL_TITLE_WHITESPACE, ' ')
    .trim();

  if (!normalized) {
    return null;
  }

  const bounded = Array.from(normalized).slice(0, MAX_TERMINAL_APPLICATION_TITLE_CODE_POINTS).join('').trim();
  return bounded || null;
};

/**
 * Parses the data portion delivered to an xterm OSC 9 handler.
 *
 * The expected payload is `4;<state>;<progress>`. The parser recognizes only
 * the OSC 9;4 namespace and validates canonical integer state/progress fields.
 * State 3 ignores the numeric value after validation, while state 0 clears all
 * progress without implying completion or Bell attention.
 *
 * @param data OSC 9 payload supplied by xterm without OSC introducer/terminator.
 * @returns Match status plus validated progress when the payload is well formed.
 */
export const parseTerminalOscProgress = (data: string): TerminalOscProgressParseResult => {
  const fields = data.split(';');
  if (fields[0] !== '4') {
    return { matched: false };
  }

  const state = fields[1] ?? '';
  if (!OSC_PROGRESS_STATE.test(state)) {
    return { matched: true, progress: null };
  }

  const isValuelessState = state === '0' || state === '3';
  const hasOmittedProgress = fields.length === 2 || (fields.length === 3 && fields[2] === '');
  if (isValuelessState && hasOmittedProgress) {
    return {
      matched: true,
      progress: {
        state: state === '0' ? 'none' : 'indeterminate',
        value: null,
      },
    };
  }

  if (fields.length !== 3 || !OSC_PROGRESS_INTEGER.test(fields[2] ?? '')) {
    return { matched: true, progress: null };
  }

  const progressValue = Number(fields[2]);
  if (progressValue > 100) {
    return { matched: true, progress: null };
  }

  if (state === '0') {
    return {
      matched: true,
      progress: {
        state: 'none',
        value: null,
      },
    };
  }

  if (state === '3') {
    return {
      matched: true,
      progress: {
        state: 'indeterminate',
        value: null,
      },
    };
  }

  const progressState: Exclude<TerminalProgressState, 'none' | 'indeterminate'> =
    state === '1' ? 'normal' : state === '2' ? 'error' : 'warning';

  return {
    matched: true,
    progress: {
      state: progressState,
      value: progressValue,
    },
  };
};

/**
 * Reduces pane-scoped terminal presentation events without transport or UI side effects.
 *
 * @param state Current pane-indexed presentation state.
 * @param action Pane lifecycle or validated presentation action.
 * @returns Updated immutable pane map.
 */
export const reduceTerminalPresentationState = (
  state: TerminalPresentationStateMap,
  action: TerminalPresentationStateAction,
): TerminalPresentationStateMap => {
  if (action.type === 'remove-pane') {
    if (!state[action.paneId]) {
      return state;
    }

    const nextState = { ...state };
    delete nextState[action.paneId];
    return nextState;
  }

  if (action.type === 'reset-pane') {
    return {
      ...state,
      [action.paneId]: createTerminalPresentationState(),
    };
  }

  if (action.type === 'session-ended') {
    const previousPaneState = state[action.paneId];
    if (
      !previousPaneState ||
      (previousPaneState.applicationTitle === null &&
        previousPaneState.progressState === 'none' &&
        previousPaneState.progressValue === null)
    ) {
      return state;
    }

    return replacePaneState(state, action.paneId, {
      ...previousPaneState,
      applicationTitle: null,
      progressState: 'none',
      progressValue: null,
    });
  }

  const previousPaneState = state[action.paneId];
  if (action.type === 'ensure-pane') {
    if (previousPaneState) {
      return state;
    }

    return {
      ...state,
      [action.paneId]: createTerminalPresentationState(),
    };
  }

  if (!previousPaneState) {
    return state;
  }

  if (action.type === 'application-title') {
    const applicationTitle = sanitizeTerminalApplicationTitle(action.title);
    if (applicationTitle === previousPaneState.applicationTitle) {
      return state;
    }

    return replacePaneState(state, action.paneId, {
      ...previousPaneState,
      applicationTitle,
    });
  }

  if (action.type === 'progress') {
    if (!isValidTerminalPresentationProgress(action.progress)) {
      return state;
    }

    if (
      action.progress.state === previousPaneState.progressState &&
      action.progress.value === previousPaneState.progressValue
    ) {
      return state;
    }

    return replacePaneState(state, action.paneId, {
      ...previousPaneState,
      progressState: action.progress.state,
      progressValue: action.progress.value,
    });
  }

  if (action.type === 'bell') {
    if (!Number.isFinite(action.receivedAt) || action.receivedAt < 0) {
      return state;
    }

    return replacePaneState(state, action.paneId, {
      ...previousPaneState,
      bellAttention: true,
      lastBellAt: action.receivedAt,
      bellSequence: previousPaneState.bellSequence + 1,
    });
  }

  if (!previousPaneState.bellAttention) {
    return state;
  }

  return replacePaneState(state, action.paneId, {
    ...previousPaneState,
    bellAttention: false,
  });
};

/**
 * Replaces one existing pane entry while preserving all unrelated pane identities.
 *
 * @param state Current pane-indexed presentation state.
 * @param paneId Pane whose presentation changed.
 * @param paneState Replacement pane state.
 * @returns Updated immutable pane map.
 */
const replacePaneState = (
  state: TerminalPresentationStateMap,
  paneId: string,
  paneState: TerminalPresentationState,
): TerminalPresentationStateMap => ({
  ...state,
  [paneId]: paneState,
});

/**
 * Revalidates progress actions at the reducer boundary so future callers cannot
 * bypass parser invariants through untyped runtime data.
 *
 * @param progress Progress candidate accepted by the reducer action contract.
 * @returns Whether the state/value combination is internally consistent and bounded.
 */
const isValidTerminalPresentationProgress = (progress: TerminalPresentationProgress): boolean => {
  switch (progress.state) {
    case 'none':
    case 'indeterminate':
      return progress.value === null;
    case 'normal':
    case 'error':
    case 'warning':
      return Number.isInteger(progress.value) && progress.value >= 0 && progress.value <= 100;
  }
};
