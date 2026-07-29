import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerminalPresentationState,
  MAX_TERMINAL_APPLICATION_TITLE_CODE_POINTS,
  parseTerminalOscProgress,
  reduceTerminalPresentationState,
  sanitizeTerminalApplicationTitle,
  type TerminalPresentationProgress,
  type TerminalPresentationStateMap,
} from './terminal-presentation-state';

const INITIAL_STATE: TerminalPresentationStateMap = {
  'pane-1': createTerminalPresentationState(),
  'pane-2': createTerminalPresentationState(),
};

test('application titles remove unsafe controls while preserving visible Unicode text', () => {
  const rawTitle = '  Claude\u0007\nCode \u202e spoof \u2066中文 😀  ';

  assert.equal(sanitizeTerminalApplicationTitle(rawTitle), 'Claude Code spoof 中文 😀');
  assert.equal(sanitizeTerminalApplicationTitle('\u0000\u0007\u202e'), null);
});

test('application titles are bounded by Unicode code points', () => {
  const title = '😀'.repeat(MAX_TERMINAL_APPLICATION_TITLE_CODE_POINTS + 1);
  const sanitized = sanitizeTerminalApplicationTitle(title);

  assert.ok(sanitized);
  assert.equal(Array.from(sanitized).length, MAX_TERMINAL_APPLICATION_TITLE_CODE_POINTS);
});

test('OSC 9;4 parser maps every supported progress state', () => {
  assert.deepEqual(parseTerminalOscProgress('4;0;100'), {
    matched: true,
    progress: { state: 'none', value: null },
  });
  assert.deepEqual(parseTerminalOscProgress('4;1;42'), {
    matched: true,
    progress: { state: 'normal', value: 42 },
  });
  assert.deepEqual(parseTerminalOscProgress('4;2;18'), {
    matched: true,
    progress: { state: 'error', value: 18 },
  });
  assert.deepEqual(parseTerminalOscProgress('4;3;0'), {
    matched: true,
    progress: { state: 'indeterminate', value: null },
  });
  assert.deepEqual(parseTerminalOscProgress('4;4;76'), {
    matched: true,
    progress: { state: 'warning', value: 76 },
  });
});

test('OSC 9;4 parser leaves unrelated OSC 9 data unmatched and consumes malformed progress payloads', () => {
  assert.deepEqual(parseTerminalOscProgress('7;file://host/path'), { matched: false });

  for (const payload of [
    '4',
    '4;1',
    '4;1;10;extra',
    '4;5;10',
    '4;1;-1',
    '4;1;01',
    '4;1;1.5',
    '4;1;101',
    '4;normal;50',
  ]) {
    assert.deepEqual(parseTerminalOscProgress(payload), {
      matched: true,
      progress: null,
    });
  }
});

test('pane reducer isolates application title and progress updates by pane', () => {
  const titled = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'application-title',
    paneId: 'pane-2',
    title: 'Agent task',
  });
  const progressed = reduceTerminalPresentationState(titled, {
    type: 'progress',
    paneId: 'pane-2',
    progress: { state: 'indeterminate', value: null },
  });

  assert.deepEqual(progressed['pane-1'], createTerminalPresentationState());
  assert.equal(progressed['pane-2']?.applicationTitle, 'Agent task');
  assert.equal(progressed['pane-2']?.progressState, 'indeterminate');
  assert.equal(progressed['pane-2']?.progressValue, null);
});

test('pane reducer preserves identity for duplicate presentation updates', () => {
  const titled = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'application-title',
    paneId: 'pane-1',
    title: 'Agent task',
  });
  const duplicateTitle = reduceTerminalPresentationState(titled, {
    type: 'application-title',
    paneId: 'pane-1',
    title: 'Agent task',
  });
  const progressed = reduceTerminalPresentationState(duplicateTitle, {
    type: 'progress',
    paneId: 'pane-1',
    progress: { state: 'normal', value: 25 },
  });
  const duplicateProgress = reduceTerminalPresentationState(progressed, {
    type: 'progress',
    paneId: 'pane-1',
    progress: { state: 'normal', value: 25 },
  });

  assert.equal(duplicateTitle, titled);
  assert.equal(duplicateProgress, progressed);
});

test('pane reducer rejects progress combinations that violate domain invariants at runtime', () => {
  const invalidProgress = {
    state: 'normal',
    value: 101,
  } as TerminalPresentationProgress;
  const nextState = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'progress',
    paneId: 'pane-1',
    progress: invalidProgress,
  });

  assert.equal(nextState, INITIAL_STATE);
});

test('Bell events retain distinct sequence edges and acknowledgement keeps event metadata', () => {
  const firstBell = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'bell',
    paneId: 'pane-1',
    receivedAt: 100,
  });
  const secondBell = reduceTerminalPresentationState(firstBell, {
    type: 'bell',
    paneId: 'pane-1',
    receivedAt: 100,
  });
  const acknowledged = reduceTerminalPresentationState(secondBell, {
    type: 'acknowledge-bell',
    paneId: 'pane-1',
  });

  assert.equal(secondBell['pane-1']?.bellAttention, true);
  assert.equal(secondBell['pane-1']?.lastBellAt, 100);
  assert.equal(secondBell['pane-1']?.bellSequence, 2);
  assert.equal(acknowledged['pane-1']?.bellAttention, false);
  assert.equal(acknowledged['pane-1']?.lastBellAt, 100);
  assert.equal(acknowledged['pane-1']?.bellSequence, 2);
});

test('pane lifecycle actions ensure, reset, and remove isolated presentation state', () => {
  const ensured = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'ensure-pane',
    paneId: 'pane-3',
  });
  const titled = reduceTerminalPresentationState(ensured, {
    type: 'application-title',
    paneId: 'pane-3',
    title: 'Temporary',
  });
  const reset = reduceTerminalPresentationState(titled, {
    type: 'reset-pane',
    paneId: 'pane-3',
  });
  const removed = reduceTerminalPresentationState(reset, {
    type: 'remove-pane',
    paneId: 'pane-3',
  });

  assert.deepEqual(reset['pane-3'], createTerminalPresentationState());
  assert.equal(removed['pane-3'], undefined);
  assert.equal(removed['pane-1'], INITIAL_STATE['pane-1']);
  assert.equal(removed['pane-2'], INITIAL_STATE['pane-2']);
});

test('pane reducer ignores invalid Bell timestamps and events for unknown panes', () => {
  const invalidBell = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'bell',
    paneId: 'pane-1',
    receivedAt: Number.NaN,
  });
  const unknownPaneTitle = reduceTerminalPresentationState(INITIAL_STATE, {
    type: 'application-title',
    paneId: 'missing',
    title: 'Ignored',
  });

  assert.equal(invalidBell, INITIAL_STATE);
  assert.equal(unknownPaneTitle, INITIAL_STATE);
});
