import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';

import {
  calibrateAutocompleteCommandPrefix,
  captureTerminalPaste,
  containsTerminalControlContent,
  createTerminalPasteWarningRequest,
  dispatchTerminalInput,
  flattenCommandForTerminalInput,
  reconcileSecondaryPaneRuntimes,
  resetTerminalForNewPtySession,
  resolveAutocompleteCommandPrefix,
  resolvePromptCommandStartOffset,
  resolveSftpDirectoryPathFromSelection,
  resolveTerminalPaneCloseTransition,
  shouldHandleTerminalAutocompleteKeyEvent,
  shouldReconnectTerminalPaneOnActivation,
} from './ssh-utils';

const require = createRequire(import.meta.url);
const { SerializeAddon: XtermSerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
const { Terminal: XtermTerminal } = require('@xterm/xterm') as typeof import('@xterm/xterm');

/**
 * Writes terminal output and waits until xterm has parsed the full chunk.
 *
 * @param terminal Target xterm instance.
 * @param data Output bytes to parse.
 * @returns Promise resolved after parsing completes.
 */
const writeTerminal = (terminal: Terminal, data: string): Promise<void> =>
  new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });

/**
 * Reads all retained normal-buffer rows through xterm's public buffer API.
 *
 * @param terminal Source xterm instance.
 * @returns Plain-text projection of retained normal-buffer history.
 */
const readNormalBufferText = (terminal: Terminal): string => {
  const rows: string[] = [];
  for (let index = 0; index < terminal.buffer.normal.length; index += 1) {
    rows.push(terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
  }
  return rows.join('\n');
};

const DEFAULT_PASTE_WARNING_SETTINGS = {
  warnOnMultiLinePaste: true,
  warnOnLargePaste: true,
  largePasteWarningThreshold: 8,
  warnOnControlCharactersPaste: true,
};

test('native paste is canceled before unchanged clipboard text reaches confirmation', () => {
  const calls: string[] = [];
  const text = 'echo one\r\necho two\x1b[D';
  captureTerminalPaste(
    {
      clipboardData: { getData: (format: string) => (format === 'text/plain' ? text : '') },
      preventDefault: () => calls.push('preventDefault'),
      stopPropagation: () => calls.push('stopPropagation'),
    },
    (payload) => {
      assert.equal(payload, text);
      calls.push('confirm');
      assert.deepEqual(createTerminalPasteWarningRequest(payload, DEFAULT_PASTE_WARNING_SETTINGS)?.reasons, [
        'multiLine',
        'largeText',
        'controlCharacters',
      ]);
    },
  );
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation', 'confirm']);
});

test('empty and unavailable native clipboard data cannot fall through to xterm', () => {
  for (const clipboardData of [null, { getData: () => '' }]) {
    let canceled = 0;
    captureTerminalPaste(
      {
        clipboardData,
        preventDefault: () => {
          canceled += 1;
        },
        stopPropagation: () => {
          canceled += 1;
        },
      },
      () => assert.fail('Empty clipboard must not request insertion'),
    );
    assert.equal(canceled, 2);
  }
});

test('application input reaches real xterm onData exactly once without clipboard normalization', () => {
  const terminal = new XtermTerminal();
  const received: string[] = [];
  const subscription = terminal.onData((data) => received.push(data));
  const payloads = ['\x03', 'cd /tmp', '报告-😀', '\x7f', 'echo startup\r', '\x0c', 'one\r\ntwo'];
  try {
    for (const payload of payloads) {
      assert.equal(dispatchTerminalInput(terminal, { readyState: WebSocket.OPEN }, payload, 'input'), true);
    }
    assert.deepEqual(received, payloads);
  } finally {
    subscription.dispose();
    terminal.dispose();
  }
});

test('confirmed paste uses xterm paste semantics regardless of bracketed paste preference', () => {
  const received: string[] = [];
  const text = 'one\r\ntwo\x1b[D';
  for (const ignoreBracketedPasteMode of [true, false]) {
    const terminal = {
      options: { ignoreBracketedPasteMode },
      input: () => assert.fail('Paste must not bypass xterm clipboard normalization'),
      paste: (data: string) => received.push(data),
    };
    assert.equal(dispatchTerminalInput(terminal, { readyState: WebSocket.OPEN }, text, 'paste'), true);
  }
  assert.deepEqual(received, [text, text]);
});

test('application input and paste reject unavailable or disabled targets before emitting data', () => {
  const terminal = {
    options: { disableStdin: false },
    input: () => assert.fail('Unavailable input must not reach xterm'),
    paste: () => assert.fail('Unavailable paste must not reach xterm'),
  };
  const openSocket = { readyState: WebSocket.OPEN };
  for (const kind of ['input', 'paste'] as const) {
    for (const socket of [
      null,
      ...[WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED].map((readyState) => ({ readyState })),
    ]) {
      assert.equal(dispatchTerminalInput(terminal, socket, 'text', kind), false);
    }
    assert.equal(dispatchTerminalInput(null, openSocket, 'text', kind), false);
    assert.equal(dispatchTerminalInput(terminal, openSocket, '', kind), false);
    terminal.options.disableStdin = true;
    assert.equal(dispatchTerminalInput(terminal, openSocket, 'text', kind), false);
    terminal.options.disableStdin = false;
  }
});

test('autocomplete keyboard gate restores terminal keys when disabled and preserves plain keys when enabled', () => {
  for (const key of ['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'Escape', 'a', 'Backspace']) {
    const event = { key, isComposing: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    assert.equal(shouldHandleTerminalAutocompleteKeyEvent(event, false), false, `${key} must reach the terminal`);
    assert.equal(shouldHandleTerminalAutocompleteKeyEvent(event, true), true, `${key} may use configured actions`);
  }
});

test('autocomplete keyboard gate preserves modified terminal keys and input-method composition', () => {
  for (const key of ['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'Escape']) {
    const event = { key, isComposing: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const modifier of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const) {
      assert.equal(
        shouldHandleTerminalAutocompleteKeyEvent({ ...event, [modifier]: true }, true),
        false,
        `${modifier}+${key} must reach the terminal`,
      );
    }
    assert.equal(shouldHandleTerminalAutocompleteKeyEvent({ ...event, isComposing: true }, true), false);
  }
  assert.equal(
    shouldHandleTerminalAutocompleteKeyEvent(
      { key: 'Process', isComposing: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false },
      true,
    ),
    false,
  );
});

test('selection directory resolver accepts explicit remote paths', () => {
  assert.equal(resolveSftpDirectoryPathFromSelection('/'), '/');
  assert.equal(resolveSftpDirectoryPathFromSelection('/var/www/'), '/var/www');
  assert.equal(resolveSftpDirectoryPathFromSelection("'~/projects/site'"), '~/projects/site');
  assert.equal(resolveSftpDirectoryPathFromSelection('./logs,'), './logs');
  assert.equal(resolveSftpDirectoryPathFromSelection('file:///opt/app/current'), '/opt/app/current');
  assert.equal(resolveSftpDirectoryPathFromSelection('file:///tmp/%broken'), '/tmp/%broken');
});

test('selection directory resolver rejects ambiguous or unsafe values', () => {
  assert.equal(resolveSftpDirectoryPathFromSelection('var/www'), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('https://example.com/path'), null);
  assert.equal(resolveSftpDirectoryPathFromSelection(''), null);
});

test('selection directory resolver resolves dot-relative paths from trusted pane cwd', () => {
  assert.equal(resolveSftpDirectoryPathFromSelection('./logs', '/srv/app'), '/srv/app/logs');
  assert.equal(resolveSftpDirectoryPathFromSelection('../shared/cache', '/srv/app/current'), '/srv/app/shared/cache');
  assert.equal(resolveSftpDirectoryPathFromSelection('../../../../etc', '/srv/app'), '/etc');
  assert.equal(resolveSftpDirectoryPathFromSelection('relative/path', '/srv/app'), null);
});

test('pane close transition promotes a surviving pane without changing its id', () => {
  assert.deepEqual(resolveTerminalPaneCloseTransition(['pane-1', 'pane-2', 'pane-3'], 'pane-1', 'pane-1'), {
    paneIds: ['pane-2', 'pane-3'],
    activePaneId: 'pane-2',
  });
  assert.deepEqual(resolveTerminalPaneCloseTransition(['pane-1', 'pane-2', 'pane-3'], 'pane-3', 'pane-2'), {
    paneIds: ['pane-1', 'pane-3'],
    activePaneId: 'pane-3',
  });
  assert.equal(resolveTerminalPaneCloseTransition(['pane-1'], 'pane-1', 'pane-1'), null);
});

test('pane activation starts a deferred primary session regardless of reconnect preference', () => {
  assert.equal(
    shouldReconnectTerminalPaneOnActivation({
      owner: 'primary',
      connectionState: 'connecting',
      socketReadyState: null,
      isFirstActivation: true,
      reconnectOnFocus: false,
    }),
    true,
  );
  assert.equal(
    shouldReconnectTerminalPaneOnActivation({
      owner: 'secondary',
      connectionState: 'failed',
      socketReadyState: null,
      isFirstActivation: true,
      reconnectOnFocus: true,
    }),
    false,
  );
});

test('pane activation reconnects every failed pane only when enabled', () => {
  assert.equal(
    shouldReconnectTerminalPaneOnActivation({
      owner: 'secondary',
      connectionState: 'failed',
      socketReadyState: WebSocket.CLOSED,
      isFirstActivation: false,
      reconnectOnFocus: true,
    }),
    true,
  );
  assert.equal(
    shouldReconnectTerminalPaneOnActivation({
      owner: 'primary',
      connectionState: 'failed',
      socketReadyState: WebSocket.CLOSED,
      isFirstActivation: false,
      reconnectOnFocus: false,
    }),
    false,
  );
  assert.equal(
    shouldReconnectTerminalPaneOnActivation({
      owner: 'secondary',
      connectionState: 'failed',
      socketReadyState: WebSocket.CONNECTING,
      isFirstActivation: false,
      reconnectOnFocus: true,
    }),
    false,
  );
});

test('PTY session reset clears old VT state while preserving normal-buffer history', async () => {
  const terminal = new XtermTerminal({
    allowProposedApi: true,
    cols: 42,
    rows: 6,
    scrollback: 100,
  });
  const serializeAddon = new XtermSerializeAddon();
  terminal.loadAddon(serializeAddon);
  const observedInput: string[] = [];
  let addonDisposeCount = 0;
  const inputListener = terminal.onData((data) => {
    observedInput.push(data);
  });
  terminal.loadAddon({
    activate: () => undefined,
    dispose: () => {
      addonDisposeCount += 1;
    },
  });

  try {
    await writeTerminal(
      terminal,
      `\x1b[31m${Array.from({ length: 12 }, (_, index) => `old-${index}`).join('\r\n')}\x1b[?1h\x1b[?1000h\x1b[?2004h\x1b[4h\x1b[?6h\x1b[?1049hALT-ONLY`,
    );

    assert.equal(terminal.buffer.active.type, 'alternate');
    assert.ok(terminal.buffer.normal.baseY > 0);
    assert.equal(terminal.modes.applicationCursorKeysMode, true);
    assert.equal(terminal.modes.bracketedPasteMode, true);
    assert.equal(terminal.modes.insertMode, true);
    assert.equal(terminal.modes.mouseTrackingMode, 'vt200');
    assert.equal(terminal.modes.originMode, true);

    // Queue one more mode change and leave the old parser inside an unterminated OSC.
    terminal.write('\x1b[?1003h\x1b]0;unfinished-old-title');
    let releasedSessionStateCount = 0;
    const didReset = await resetTerminalForNewPtySession(
      terminal,
      serializeAddon,
      () => true,
      () => {
        releasedSessionStateCount += 1;
      },
    );

    assert.equal(didReset, true);
    assert.equal(releasedSessionStateCount, 1);
    assert.equal(terminal.buffer.active.type, 'normal');
    assert.ok(terminal.buffer.normal.baseY > 0);
    assert.match(readNormalBufferText(terminal), /old-0/);
    assert.match(readNormalBufferText(terminal), /old-11/);
    assert.doesNotMatch(readNormalBufferText(terminal), /ALT-ONLY/);
    assert.equal(terminal.modes.applicationCursorKeysMode, false);
    assert.equal(terminal.modes.bracketedPasteMode, false);
    assert.equal(terminal.modes.insertMode, false);
    assert.equal(terminal.modes.mouseTrackingMode, 'none');
    assert.equal(terminal.modes.originMode, false);
    assert.equal(terminal.cols, 42);
    assert.equal(terminal.rows, 6);
    assert.equal(addonDisposeCount, 0);

    await writeTerminal(terminal, 'fresh-session-output');
    assert.match(readNormalBufferText(terminal), /fresh-session-output/);
    const freshOutputLine = terminal.buffer.normal.getLine(
      terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY,
    );
    assert.equal(
      freshOutputLine?.getCell(terminal.buffer.normal.cursorX - 'fresh-session-output'.length)?.isAttributeDefault(),
      true,
    );
    terminal.input('listener-survives-reset');
    assert.deepEqual(observedInput, ['listener-survives-reset']);
  } finally {
    inputListener.dispose();
    terminal.dispose();
  }

  assert.equal(addonDisposeCount, 1);
});

test('stale PTY reset attempt cannot reset a newer terminal session', async () => {
  const terminal = new XtermTerminal({ allowProposedApi: true, cols: 40, rows: 5 });
  const barrierCallbacks: Array<() => void> = [];
  let currentAttemptId = 1;
  let resetWriteCount = 0;
  let releasedSessionStateCount = 0;
  let serializedHistoryCount = 0;
  const controlledTerminal: Pick<Terminal, 'options' | 'write'> = {
    options: terminal.options,
    write: (data, callback) => {
      if (typeof data === 'string' && data.length > 0) {
        resetWriteCount += 1;
      }
      if (callback) {
        barrierCallbacks.push(callback);
      }
    },
  };
  const controlledSerializeAddon: Pick<SerializeAddon, 'serialize'> = {
    serialize: () => {
      serializedHistoryCount += 1;
      return 'old-session-history';
    },
  };

  try {
    const staleResetPromise = resetTerminalForNewPtySession(
      controlledTerminal,
      controlledSerializeAddon,
      () => currentAttemptId === 1,
      () => {
        releasedSessionStateCount += 1;
      },
    );
    currentAttemptId = 2;
    await writeTerminal(terminal, '\x1b[?1hnew-session');
    barrierCallbacks.shift()?.();

    assert.equal(await staleResetPromise, false);
    assert.equal(resetWriteCount, 0);
    assert.equal(releasedSessionStateCount, 0);
    assert.equal(serializedHistoryCount, 0);
    assert.equal(terminal.modes.applicationCursorKeysMode, true);
    assert.equal(terminal.buffer.active.getLine(0)?.translateToString(true), 'new-session');
  } finally {
    terminal.dispose();
  }
});

test('superseded PTY reset restores history before the newer attempt can continue', async () => {
  const terminal = new XtermTerminal({ allowProposedApi: true, cols: 40, rows: 5, scrollback: 100 });
  const serializeAddon = new XtermSerializeAddon();
  terminal.loadAddon(serializeAddon);
  let currentAttemptId = 1;
  const supersedingSerializeAddon: Pick<SerializeAddon, 'serialize'> = {
    serialize: (options) => {
      const history = serializeAddon.serialize(options);
      currentAttemptId = 2;
      return history;
    },
  };

  try {
    await writeTerminal(terminal, 'history-before-race\x1b[?1h');
    const didReset = await resetTerminalForNewPtySession(
      terminal,
      supersedingSerializeAddon,
      () => currentAttemptId === 1,
      () => undefined,
    );

    assert.equal(didReset, false);
    assert.match(readNormalBufferText(terminal), /history-before-race/);
    assert.equal(terminal.modes.applicationCursorKeysMode, false);
  } finally {
    terminal.dispose();
  }
});

test('history serialization failure still allows a clean PTY reset', async () => {
  const terminal = new XtermTerminal({ allowProposedApi: true, cols: 40, rows: 5, scrollback: 100 });
  const serializationError = new Error('serialization failed');
  const warnings: unknown[][] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };

  try {
    await writeTerminal(terminal, 'history-that-cannot-be-restored\x1b[?1h');
    const didReset = await resetTerminalForNewPtySession(
      terminal,
      {
        serialize: () => {
          throw serializationError;
        },
      },
      () => true,
      () => undefined,
    );

    assert.equal(didReset, true);
    assert.equal(terminal.modes.applicationCursorKeysMode, false);
    assert.doesNotMatch(readNormalBufferText(terminal), /history-that-cannot-be-restored/);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[1], serializationError);
  } finally {
    console.warn = originalConsoleWarn;
    terminal.dispose();
  }
});

test('pane reconciliation preserves siblings during primary retry and later prunes removed panes', () => {
  const disposeCounts = new Map<string, number>();
  const createRuntime = (paneId: string, owner: 'primary' | 'secondary') => ({
    owner,
    dispose: (): void => {
      disposeCounts.set(paneId, (disposeCounts.get(paneId) ?? 0) + 1);
    },
  });
  const runtimeMap = new Map([
    ['pane-1', createRuntime('pane-1', 'primary')],
    ['pane-2', createRuntime('pane-2', 'secondary')],
    ['pane-removed', createRuntime('pane-removed', 'secondary')],
  ]);

  reconcileSecondaryPaneRuntimes(runtimeMap, {
    desiredPaneIds: ['pane-1', 'pane-2'],
    isActive: true,
    sessionTargetReady: false,
  });

  assert.deepEqual([...runtimeMap.keys()], ['pane-1', 'pane-2', 'pane-removed']);
  assert.equal(disposeCounts.size, 0);

  reconcileSecondaryPaneRuntimes(runtimeMap, {
    desiredPaneIds: ['pane-1', 'pane-2'],
    isActive: true,
    sessionTargetReady: true,
  });

  assert.deepEqual([...runtimeMap.keys()], ['pane-1', 'pane-2']);
  assert.equal(disposeCounts.get('pane-removed'), 1);
  assert.equal(disposeCounts.has('pane-1'), false);
  assert.equal(disposeCounts.has('pane-2'), false);
});

test('paste warning request reports enabled paste safety reasons', () => {
  const request = createTerminalPasteWarningRequest('echo one\necho two', DEFAULT_PASTE_WARNING_SETTINGS);

  assert.ok(request);
  assert.deepEqual(request.reasons, ['multiLine', 'largeText']);
  assert.equal(request.threshold, 8);
  assert.equal(request.characterCount, 17);
  assert.equal(request.preview, 'echo one\necho two');
});

test('paste warning request detects terminal control content', () => {
  assert.equal(containsTerminalControlContent('\u001b[31mred\u001b[0m'), true);
  assert.equal(containsTerminalControlContent('title\u0007'), true);

  const request = createTerminalPasteWarningRequest('printf "\u001b[31m"', {
    ...DEFAULT_PASTE_WARNING_SETTINGS,
    warnOnMultiLinePaste: false,
    warnOnLargePaste: false,
  });

  assert.ok(request);
  assert.deepEqual(request.reasons, ['controlCharacters']);
});

test('paste warning request returns null when no enabled reason matches', () => {
  assert.equal(createTerminalPasteWarningRequest('echo ok', DEFAULT_PASTE_WARNING_SETTINGS), null);
  assert.equal(
    createTerminalPasteWarningRequest('echo one\necho two', {
      ...DEFAULT_PASTE_WARNING_SETTINGS,
      warnOnMultiLinePaste: false,
      warnOnLargePaste: false,
    }),
    null,
  );
});

test('prompt boundary skips virtual environment decoration only with shell prompt context', () => {
  const renderedInput = '(base) xyz10@DESKTOP:~$ sudo ss -tlnp | grep :22';
  const commandStartOffset = resolvePromptCommandStartOffset(renderedInput);

  assert.equal(renderedInput.slice(commandStartOffset), 'sudo ss -tlnp | grep :22');
  assert.equal(resolvePromptCommandStartOffset('(base) echo value'), 0);
});

test('prompt boundary strips through trailing status glyphs of glyph-led prompts', () => {
  const renderedInput = '➜  myrepo git:(main) ✗ ls -la';
  assert.equal(renderedInput.slice(resolvePromptCommandStartOffset(renderedInput)), 'ls -la');

  const promptOnly = '➜  myrepo git:(main) ✗';
  assert.equal(resolvePromptCommandStartOffset(promptOnly), promptOnly.length);
});

test('prompt boundary stops at shell operators inside command text', () => {
  const compound = 'user@host:~$ (cd /tmp && make)';
  assert.equal(compound.slice(resolvePromptCommandStartOffset(compound)), '(cd /tmp && make)');

  const redirect = '$ sort > out.txt';
  assert.equal(redirect.slice(resolvePromptCommandStartOffset(redirect)), 'sort > out.txt');
});

test('prompt boundary ignores ascii symbolic arguments', () => {
  const line = '$ ls -- *';
  assert.equal(line.slice(resolvePromptCommandStartOffset(line)), 'ls -- *');
});

test('autocomplete command prefix uses local shadow for normal typing', () => {
  assert.equal(resolveAutocompleteCommandPrefix('ec', 'echo'), 'echo');
});

test('autocomplete command prefix preserves recalled history command context', () => {
  assert.equal(
    resolveAutocompleteCommandPrefix('echo 1ec', 'ec', {
      localPrefixNeedsRenderedContext: true,
    }),
    'echo 1ec',
  );
});

test('autocomplete command prefix merges local suffix before terminal echo catches up', () => {
  assert.equal(
    resolveAutocompleteCommandPrefix('echo 1e', 'ec', {
      localPrefixNeedsRenderedContext: true,
    }),
    'echo 1ec',
  );
});

test('autocomplete command prefix uses trusted line-state cursor only when lengths agree', () => {
  assert.equal(
    calibrateAutocompleteCommandPrefix('git status --short', {
      lineLength: 18,
      cursorIndex: 10,
    }),
    'git status',
  );
  assert.equal(
    calibrateAutocompleteCommandPrefix('git status --short', {
      lineLength: 99,
      cursorIndex: 3,
    }),
    'git status --short',
  );
});

test('flatten keeps single-line commands untouched', () => {
  assert.equal(flattenCommandForTerminalInput('git status --short'), 'git status --short');
});

test('flatten joins retained continuation lines without submitting newlines', () => {
  assert.equal(flattenCommandForTerminalInput('cat <<EOF\n> line1\n> EOF'), 'cat <<EOF line1 EOF');
  assert.equal(flattenCommandForTerminalInput('echo start\r\n> --flag'), 'echo start --flag');
});

test('flatten strips zsh-style named continuation prompts on follow-up lines', () => {
  assert.equal(flattenCommandForTerminalInput("echo 'a\nquote> b'"), "echo 'a b'");
  assert.equal(flattenCommandForTerminalInput('ls |\npipe> wc -l'), 'ls | wc -l');
});

test('flatten preserves first-line content that resembles a continuation prompt', () => {
  assert.equal(flattenCommandForTerminalInput('sort > out.txt'), 'sort > out.txt');
  assert.equal(flattenCommandForTerminalInput('a\nb > c'), 'a b > c');
});

test('flatten drops blank continuation lines', () => {
  assert.equal(flattenCommandForTerminalInput('one\n\n> two\n   \n> three'), 'one two three');
});
