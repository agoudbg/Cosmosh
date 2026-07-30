import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { Terminal as XtermTerminal } from '@xterm/xterm';

import { registerTerminalPresentationIntegration } from './terminal-presentation-integration';
import {
  createTerminalPresentationState,
  reduceTerminalPresentationState,
  type TerminalPresentationStateAction,
  type TerminalPresentationStateMap,
} from './terminal-presentation-state';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');

/**
 * Awaits one xterm write callback so deliberately fragmented control sequences
 * preserve parser order in tests.
 *
 * @param terminal xterm instance receiving a single transport-like chunk.
 * @param chunk Raw terminal data chunk.
 * @returns Promise resolved after xterm parses the chunk.
 */
const writeTerminalChunk = (terminal: XtermTerminal, chunk: string): Promise<void> =>
  new Promise((resolve) => {
    terminal.write(chunk, resolve);
  });

test('xterm parser routes fragmented OSC 0/2, OSC 9;4, and standalone Bell events to one pane', async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const actions: TerminalPresentationStateAction[] = [];
  const integration = registerTerminalPresentationIntegration({
    paneId: 'pane-2',
    terminal,
    dispatch: (action) => actions.push(action),
    now: () => 1234,
  });

  try {
    for (const chunk of [
      '\u001b]0;Claude',
      ' Code\u0007\u001b]2;Kimi',
      ' Code\u001b\\\u001b]9',
      ';4;3',
      ';0\u0007',
      '\u0007',
    ]) {
      await writeTerminalChunk(terminal, chunk);
    }

    assert.deepEqual(actions, [
      {
        type: 'application-title',
        paneId: 'pane-2',
        title: 'Claude Code',
      },
      {
        type: 'application-title',
        paneId: 'pane-2',
        title: 'Kimi Code',
      },
      {
        type: 'progress',
        paneId: 'pane-2',
        progress: { state: 'indeterminate', value: null },
      },
      {
        type: 'bell',
        paneId: 'pane-2',
        receivedAt: 1234,
      },
    ]);
  } finally {
    integration.dispose();
    terminal.dispose();
  }
});

test('xterm parser routes Kimi Code valueless progress sequences without treating terminators as Bell', async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const actions: TerminalPresentationStateAction[] = [];
  const integration = registerTerminalPresentationIntegration({
    paneId: 'pane-kimi',
    terminal,
    dispatch: (action) => actions.push(action),
  });

  try {
    await writeTerminalChunk(terminal, '\u001b]9;4;3\u0007');
    await writeTerminalChunk(terminal, '\u001b]9;4;0;\u0007');

    assert.deepEqual(actions, [
      {
        type: 'progress',
        paneId: 'pane-kimi',
        progress: { state: 'indeterminate', value: null },
      },
      {
        type: 'progress',
        paneId: 'pane-kimi',
        progress: { state: 'none', value: null },
      },
    ]);
  } finally {
    integration.dispose();
    terminal.dispose();
  }
});

test('OSC 9 integration consumes malformed progress but leaves unrelated OSC 9 payloads available', async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const fallbackPayloads: string[] = [];
  const fallbackDisposable = terminal.parser.registerOscHandler(9, (data) => {
    fallbackPayloads.push(data);
    return true;
  });
  const actions: TerminalPresentationStateAction[] = [];
  const integration = registerTerminalPresentationIntegration({
    paneId: 'pane-1',
    terminal,
    dispatch: (action) => actions.push(action),
  });

  try {
    await writeTerminalChunk(terminal, '\u001b]9;4;5;50\u0007');
    await writeTerminalChunk(terminal, '\u001b]9;7;unrelated\u0007');

    assert.deepEqual(actions, []);
    assert.deepEqual(fallbackPayloads, ['7;unrelated']);
  } finally {
    integration.dispose();
    fallbackDisposable.dispose();
    terminal.dispose();
  }
});

test('disposing the integration stops every presentation event without disposing xterm', async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const actions: TerminalPresentationStateAction[] = [];
  let resetCount = 0;
  const integration = registerTerminalPresentationIntegration({
    paneId: 'pane-1',
    terminal,
    dispatch: (action) => actions.push(action),
  });

  integration.resetAfterPendingWrites(() => {
    resetCount += 1;
  });
  integration.dispose();
  integration.dispose();
  await writeTerminalChunk(terminal, '\u001b]0;Ignored\u0007\u001b]9;4;1;50\u0007\u0007');

  assert.deepEqual(actions, []);
  assert.equal(resetCount, 0);
  terminal.dispose();
});

test('reconnect reset drains old parser work before accepting replacement connection output', async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  let state: TerminalPresentationStateMap = {
    'pane-1': createTerminalPresentationState(),
  };
  const dispatch = (action: TerminalPresentationStateAction): void => {
    state = reduceTerminalPresentationState(state, action);
  };
  const integration = registerTerminalPresentationIntegration({
    paneId: 'pane-1',
    terminal,
    dispatch,
    now: () => 100,
  });

  try {
    terminal.write('\u001b]0;Old task\u0007\u001b]9;4;1;80\u0007\u0007');
    integration.resetAfterPendingWrites(() => {
      dispatch({ type: 'reset-pane', paneId: 'pane-1' });
    });
    await writeTerminalChunk(terminal, '\u001b]0;New task\u0007');

    assert.deepEqual(state['pane-1'], {
      ...createTerminalPresentationState(),
      applicationTitle: 'New task',
    });
  } finally {
    integration.dispose();
    terminal.dispose();
  }
});
