import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';

import {
  calibrateAutocompleteCommandPrefix,
  canInsertHistoryCommand,
  containsTerminalControlContent,
  createTerminalPasteWarningRequest,
  flattenCommandForTerminalInput,
  reconcileSecondaryPaneRuntimes,
  resetTerminalForNewPtySession,
  resolveAutocompleteCommandPrefix,
  resolvePromptCommandStartOffset,
  resolveSftpDirectoryPathFromSelection,
  resolveTerminalPaneCloseTransition,
  shouldReconnectTerminalPaneOnActivation,
} from './ssh-utils';

const require = createRequire(import.meta.url);

test('history insertion accepts only unchanged single-line text and never terminal control keys', () => {
  for (const command of ['printf "hello"  ', '中文😀', '--help', "echo '; $value'", '  echo spaced  '])
    assert.equal(canInsertHistoryCommand(command), true, command);
  for (const command of ['', '  ', 'first\nsecond', 'echo\r', '\tfile', '\x1b[31m', 'echo\x7f', 'echo\u0085'])
    assert.equal(canInsertHistoryCommand(command), false, JSON.stringify(command));
});
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

test('selection directory resolver accepts explicit remote paths', () => {
  assert.equal(resolveSftpDirectoryPathFromSelection('/'), '/');
  assert.equal(resolveSftpDirectoryPathFromSelection('/var/www/'), '/var/www');
  assert.equal(resolveSftpDirectoryPathFromSelection("'~/projects/site'"), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('./logs,'), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('file:///opt/app/current'), '/opt/app/current');
  assert.equal(resolveSftpDirectoryPathFromSelection('file:///tmp/%broken'), '/tmp/%broken');
  assert.equal(resolveSftpDirectoryPathFromSelection('file:///tmp/%00name'), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('file:///tmp/%0Aname'), null);
});

test('selection directory resolver rejects ambiguous or unsafe values', () => {
  assert.equal(resolveSftpDirectoryPathFromSelection('var/www'), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('https://example.com/path'), null);
  assert.equal(resolveSftpDirectoryPathFromSelection(''), null);
});

test('selection directory resolver resolves dot-relative paths from trusted pane cwd', () => {
  const directory = { logical: '/display/link', physical: '/actual/app', home: '/custom home' };
  assert.equal(resolveSftpDirectoryPathFromSelection('./logs', directory), '/actual/app/./logs');
  assert.equal(resolveSftpDirectoryPathFromSelection('../shared/cache', directory), '/actual/app/../shared/cache');
  assert.equal(resolveSftpDirectoryPathFromSelection('./link/../next', directory), '/actual/app/./link/../next');
  assert.equal(resolveSftpDirectoryPathFromSelection('relative/path', directory), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('~/folder', directory), '/custom home/folder');
  assert.equal(resolveSftpDirectoryPathFromSelection('./folder', { ...directory, physical: null }), null);
  assert.equal(resolveSftpDirectoryPathFromSelection('~/folder', { ...directory, home: null }), null);
  for (const name of ['/tmp/end.', '/tmp/back\\slash', '/tmp/space folder', '/tmp/with,']) {
    assert.equal(resolveSftpDirectoryPathFromSelection(name), name);
  }
  assert.equal(resolveSftpDirectoryPathFromSelection("'/tmp/trailing '"), '/tmp/trailing ');
  assert.equal(resolveSftpDirectoryPathFromSelection('/first\n/second'), null);
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
