export const REMOTE_SHELL_INPUT_LINE_MAX_LENGTH = 4096;
export const REMOTE_SHELL_SUBMITTED_COMMAND_MAX_COUNT = 32;

export type RemoteShellInputEventName = 'input-change' | 'input-submit' | 'input-clear';

export type RemoteShellInputClearReason = 'interrupt' | 'kill-line' | 'secret-prompt' | 'foreground-command';

export type RemoteShellInputMessage = {
  type: 'remote-shell-input';
  event: RemoteShellInputEventName;
  timestamp: number;
  line?: string;
  command?: string;
  reason?: RemoteShellInputClearReason;
};

export type RemoteShellInputState = {
  lineBuffer: string;
  submittedCommands: string[];
};

/**
 * Builds the initial in-memory shell input tracker state.
 *
 * @returns Empty shell input state for one live SSH session.
 */
export const createRemoteShellInputState = (): RemoteShellInputState => ({
  lineBuffer: '',
  submittedCommands: [],
});

/**
 * Updates local shell input state from renderer-originated terminal input bytes.
 *
 * The tracker is intentionally local to the live session. It never reads remote
 * shell output and never attempts to record input while the session is inside a
 * password prompt or an already-running foreground command.
 *
 * @param state Mutable input tracker state for one SSH session.
 * @param inputData Raw terminal input payload received from renderer.
 * @param options Timestamp and optional suppression reason.
 * @returns Debug messages safe to forward to renderer.
 */
export const updateRemoteShellInputState = (
  state: RemoteShellInputState,
  inputData: string,
  options: { timestamp: number; suppressedReason?: RemoteShellInputClearReason | null },
): RemoteShellInputMessage[] => {
  if (options.suppressedReason) {
    return clearRemoteShellInputState(state, options.timestamp, options.suppressedReason);
  }

  const events: RemoteShellInputMessage[] = [];
  let lineChanged = false;

  const emitSubmit = (): void => {
    const command = state.lineBuffer.trim();
    state.lineBuffer = '';
    lineChanged = true;

    if (!command) {
      return;
    }

    state.submittedCommands.push(command);
    if (state.submittedCommands.length > REMOTE_SHELL_SUBMITTED_COMMAND_MAX_COUNT) {
      state.submittedCommands.splice(0, state.submittedCommands.length - REMOTE_SHELL_SUBMITTED_COMMAND_MAX_COUNT);
    }

    events.push({
      type: 'remote-shell-input',
      event: 'input-submit',
      timestamp: options.timestamp,
      command,
      line: '',
    });
  };

  for (let index = 0; index < inputData.length; index += 1) {
    const char = inputData[index] ?? '';

    if (char === '\x1b') {
      break;
    }

    if (char === '\r' || char === '\n') {
      emitSubmit();
      continue;
    }

    if (char === '\u0003') {
      events.push(...clearRemoteShellInputState(state, options.timestamp, 'interrupt'));
      lineChanged = false;
      continue;
    }

    if (char === '\u0015') {
      events.push(...clearRemoteShellInputState(state, options.timestamp, 'kill-line'));
      lineChanged = false;
      continue;
    }

    if (char === '\u0017') {
      const nextLine = state.lineBuffer.replace(/\s*\S+\s*$/, '');
      if (nextLine !== state.lineBuffer) {
        state.lineBuffer = nextLine;
        lineChanged = true;
      }
      continue;
    }

    if (char === '\x7f' || char === '\b') {
      if (state.lineBuffer.length > 0) {
        state.lineBuffer = state.lineBuffer.slice(0, -1);
        lineChanged = true;
      }
      continue;
    }

    if (char === '\t' || char === '\u0000') {
      continue;
    }

    if (char >= ' ' && state.lineBuffer.length < REMOTE_SHELL_INPUT_LINE_MAX_LENGTH) {
      state.lineBuffer += char;
      lineChanged = true;
    }
  }

  if (lineChanged) {
    events.push({
      type: 'remote-shell-input',
      event: 'input-change',
      timestamp: options.timestamp,
      line: state.lineBuffer,
    });
  }

  return events;
};

/**
 * Pops the oldest submitted shell command waiting for a remote command-end event.
 *
 * @param state Mutable input tracker state for one SSH session.
 * @returns Submitted command line, or null when none is pending.
 */
export const takeSubmittedRemoteShellCommand = (state: RemoteShellInputState): string | null => {
  return state.submittedCommands.shift() ?? null;
};

/**
 * Clears the local line buffer without emitting secret content.
 *
 * @param state Mutable input tracker state for one SSH session.
 * @param timestamp Message timestamp.
 * @param reason Why the buffer was cleared.
 * @returns A clear event when there was visible local input, otherwise no event.
 */
const clearRemoteShellInputState = (
  state: RemoteShellInputState,
  timestamp: number,
  reason: RemoteShellInputClearReason,
): RemoteShellInputMessage[] => {
  if (!state.lineBuffer) {
    return [];
  }

  state.lineBuffer = '';
  return [
    {
      type: 'remote-shell-input',
      event: 'input-clear',
      timestamp,
      line: '',
      reason,
    },
  ];
};
