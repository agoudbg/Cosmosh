import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteShellCapability, ShellContext } from '@cosmosh/api-contract';

import { createSshPaneState, reduceSshPaneState, type SshPaneStateMap } from './ssh-pane-state';
import type { ServerInboundMessage } from './ssh-types';

const HISTORY_CONTEXT: ShellContext = {
  sessionId: 'native-session',
  shellInstanceId: 'fish-owner',
  shell: 'fish',
  helperVersion: 'test',
  protocolVersion: 3,
  capabilities: ['history-read'],
  permissions: { history: true, cwd: false, input: false, paths: false, nativeCompletion: false },
  status: 'paused',
  reason: 'input-submitted',
  revision: 1,
  inputGeneration: 0,
  submissionToken: null,
  promptGeneration: 1,
  cwdGeneration: 0,
  cwd: null,
  lastKnownCwd: null,
};
const HISTORY_VIEW = {
  status: 'ok',
  source: { id: 'source-one', namespace: 'fish', shell: 'fish' },
  entries: ['printf "new"  ', 'printf "two\nlines"', 'older'],
} as const;
/** @param state Pane map. @param payload Trusted transport message. @returns Reduced first-pane state. */
const historyMessage = (state: SshPaneStateMap, payload: ServerInboundMessage): SshPaneStateMap =>
  reduceSshPaneState(state, { type: 'server-message', paneId: 'first', payload, receivedAt: 1 });
/** @returns Two connected panes with one native history owner and an exact newest-first list. */
const historyState = (): SshPaneStateMap => {
  let state: SshPaneStateMap = { first: createSshPaneState(), second: createSshPaneState() };
  state = reduceSshPaneState(state, { type: 'transport-state', paneId: 'first', connectionState: 'connected' });
  state = historyMessage(state, { type: 'shell-context', context: HISTORY_CONTEXT });
  return historyMessage(state, {
    type: 'shell-history',
    view: { ...HISTORY_VIEW, entries: [...HISTORY_VIEW.entries] },
  });
};

test('native history keeps exact newest-first records separate from legacy telemetry and other panes', () => {
  let state = historyState();
  assert.deepEqual(state.first.historyView?.entries, HISTORY_VIEW.entries);
  assert.equal(state.second.historyView, null);
  state = historyMessage(state, { type: 'history', recentCommands: ['mixed-file-record'] });
  state = historyMessage(state, {
    type: 'telemetry',
    cpuUsagePercent: 1,
    memoryUsedBytes: 1,
    memoryTotalBytes: 2,
    networkRxBytesPerSec: 0,
    networkTxBytesPerSec: 0,
    recentCommands: ['stale-telemetry-copy'],
  });
  assert.deepEqual(state.first.historyView?.entries, HISTORY_VIEW.entries);
  assert.deepEqual(state.first.telemetryState.recentCommands, []);
});

test('history removal results require the same pending request, source and pane', () => {
  let state = reduceSshPaneState(historyState(), {
    type: 'history-removal-requested',
    paneId: 'first',
    sourceId: 'source-one',
    requestId: 'request-one',
  });
  for (const [requestId, sourceId] of [
    ['old-request', 'source-one'],
    ['request-one', 'old-source'],
  ])
    state = historyMessage(state, {
      type: 'shell-history-remove-result',
      requestId,
      sourceId,
      status: 'removed-from-reader',
    });
  assert.equal(state.first.historyRemoval?.status, 'pending');
  assert.equal(state.second.historyRemoval, null);
  state = historyMessage(state, {
    type: 'shell-history-remove-result',
    requestId: 'request-one',
    sourceId: 'source-one',
    status: 'removed-from-reader',
  });
  assert.equal(state.first.historyRemoval?.status, 'removed-from-reader');
  state = historyMessage(state, { type: 'shell-history', view: { ...HISTORY_VIEW, entries: ['older'] } });
  assert.equal(state.first.historyRemoval?.status, 'removed-from-reader');
  state = historyMessage(state, { type: 'shell-history', view: { status: 'private', source: null, entries: [] } });
  assert.equal(state.first.historyRemoval, null);
  assert.deepEqual(state.first.historyView?.entries, []);
});

test('history namespace, owner, permissions and transport changes invalidate records and actions', () => {
  const pending = reduceSshPaneState(historyState(), {
    type: 'history-removal-requested',
    paneId: 'first',
    requestId: 'request-one',
    sourceId: 'source-one',
  });
  const changed = [
    historyMessage(pending, {
      type: 'shell-history',
      view: { ...HISTORY_VIEW, source: { ...HISTORY_VIEW.source, id: 'source-two', namespace: 'work' }, entries: [] },
    }),
    historyMessage(pending, {
      type: 'shell-context',
      context: { ...HISTORY_CONTEXT, shellInstanceId: 'new-owner', revision: 2 },
    }),
    historyMessage(pending, {
      type: 'shell-context',
      context: { ...HISTORY_CONTEXT, permissions: { ...HISTORY_CONTEXT.permissions, history: false }, revision: 2 },
    }),
    reduceSshPaneState(pending, { type: 'transport-state', paneId: 'first', connectionState: 'failed' }),
    reduceSshPaneState(pending, { type: 'history-read-permission', paneId: 'first', allowed: false }),
  ];
  for (let state of changed) {
    state = historyMessage(state, {
      type: 'shell-history-remove-result',
      requestId: 'request-one',
      sourceId: 'source-one',
      status: 'removed-from-reader',
    });
    assert.equal(state.first.historyRemoval, null);
    assert.deepEqual(state.first.historyView?.entries, []);
    assert.deepEqual(state.first.telemetryState.recentCommands, []);
  }
  const blocked = changed.at(-1)!;
  assert.equal(
    historyMessage(blocked, { type: 'shell-history', view: { ...HISTORY_VIEW, entries: [...HISTORY_VIEW.entries] } })
      .first,
    blocked.first,
  );
  const enabled = reduceSshPaneState(blocked, { type: 'history-read-permission', paneId: 'first', allowed: true });
  assert.deepEqual(enabled.first.historyView?.entries, []);
});

test('credential offers and results remain bound to their pane and one pending token', () => {
  let state: SshPaneStateMap = { first: createSshPaneState(), second: createSshPaneState() };
  state = reduceSshPaneState(state, { type: 'transport-state', paneId: 'first', connectionState: 'connected' });
  state = reduceSshPaneState(state, {
    type: 'server-message',
    paneId: 'first',
    receivedAt: 10,
    payload: { type: 'credential-fill-offer', offer: { token: 'one', expiresAt: 1000 } },
  });
  state = reduceSshPaneState(state, { type: 'credential-fill-requested', paneId: 'first', token: 'one' });
  assert.equal(state.first.credentialFillRequestToken, 'one');
  assert.equal(state.second.credentialFillOffer, null);
  state = reduceSshPaneState(state, {
    type: 'server-message',
    paneId: 'first',
    receivedAt: 11,
    payload: { type: 'credential-fill-result', token: 'old', status: 'filled' },
  });
  assert.equal(state.first.credentialFillResult, null);
  state = reduceSshPaneState(state, {
    type: 'server-message',
    paneId: 'first',
    receivedAt: 12,
    payload: { type: 'credential-fill-offer', offer: null },
  });
  assert.equal(state.first.credentialFillRequestToken, 'one');
  state = reduceSshPaneState(state, {
    type: 'server-message',
    paneId: 'first',
    receivedAt: 13,
    payload: { type: 'credential-fill-result', token: 'one', status: 'filled' },
  });
  assert.equal(state.first.credentialFillResult?.payload.status, 'filled');
  assert.equal(state.first.credentialFillRequestToken, null);
  assert.deepEqual(state.first.remoteEnhancementsDebugEvents, []);
});

test('new prompts and disconnects invalidate pending credential actions', () => {
  let state: SshPaneStateMap = { first: createSshPaneState() };
  state = reduceSshPaneState(state, { type: 'transport-state', paneId: 'first', connectionState: 'connected' });
  for (const token of ['one', 'two']) {
    state = reduceSshPaneState(state, {
      type: 'server-message',
      paneId: 'first',
      receivedAt: 10,
      payload: { type: 'credential-fill-offer', offer: { token, expiresAt: 1000 } },
    });
    assert.equal(state.first.credentialFillRequestToken, null);
    state = reduceSshPaneState(state, { type: 'credential-fill-requested', paneId: 'first', token });
    assert.equal(state.first.credentialFillRequestToken, token);
  }
  state = reduceSshPaneState(state, { type: 'transport-state', paneId: 'first', connectionState: 'failed' });
  assert.equal(state.first.credentialFillOffer, null);
  assert.equal(state.first.credentialFillRequestToken, null);
  state = reduceSshPaneState(state, {
    type: 'server-message',
    paneId: 'first',
    receivedAt: 12,
    payload: { type: 'credential-fill-result', token: 'two', status: 'filled' },
  });
  assert.equal(state.first.credentialFillResult, null);
});

const INITIAL_STATE: SshPaneStateMap = {
  'pane-1': createSshPaneState(),
  'pane-2': createSshPaneState(),
};

const REMOTE_EVENT_BASE = {
  type: 'remote-shell-event',
  shell: 'zsh',
  helperVersion: 'test-v2',
  protocolVersion: 3,
  shellInstanceId: 'shell-1',
  capabilities: [
    'cwd',
    'command-start',
    'command-end',
    'foreground-command',
    'prompt-ready',
    'line-state',
  ] as RemoteShellCapability[],
  timestamp: 100,
  physicalCwd: '/physical',
  homeDirectory: '/home/fixture',
} as const;

test('latest context owns each pane and cannot be overwritten by stale or replayed metadata', () => {
  const context: ShellContext = {
    sessionId: 'session-1',
    shellInstanceId: 'shell-1',
    shell: 'zsh',
    helperVersion: 'fixture-v3',
    protocolVersion: 3,
    capabilities: ['cwd', 'prompt-ready', 'line-state'],
    permissions: { cwd: true, input: true, paths: true, history: true, nativeCompletion: false },
    status: 'ready',
    reason: null,
    revision: 5,
    inputGeneration: 2,
    submissionToken: null,
    promptGeneration: 3,
    cwdGeneration: 2,
    cwd: { logical: '/display', physical: '/current', home: '/custom home' },
    lastKnownCwd: { logical: '/display', physical: '/current', home: '/custom home' },
  };
  let state = reduceSshPaneState(INITIAL_STATE, {
    type: 'server-message',
    paneId: 'pane-2',
    receivedAt: 1,
    payload: { type: 'shell-context', context },
  });
  assert.equal(state['pane-1']!.shellContext, null);
  assert.equal(state['pane-2']!.trustedCwd, '/current');
  assert.deepEqual(state['pane-2']!.remoteEnhancementsDebugEvents, []);
  const submitted = reduceSshPaneState(state, { type: 'input-submitted', paneId: 'pane-2', token: 'submit-1' });
  assert.equal(submitted['pane-2']!.shellContext?.cwd, null, 'submission invalidates before the server responds');
  assert.equal(submitted['pane-2']!.shellContext?.status, 'paused');
  assert.equal(submitted['pane-1'], state['pane-1'], 'other panes retain their own state');
  const delayed = reduceSshPaneState(submitted, {
    type: 'server-message',
    paneId: 'pane-2',
    receivedAt: 2,
    payload: { type: 'shell-context', context: { ...context, revision: 6 } },
  });
  assert.equal(delayed['pane-2']!.shellContext?.cwd, null, 'queued old context cannot restore the submitted directory');
  const resumed = reduceSshPaneState(delayed, {
    type: 'server-message',
    paneId: 'pane-2',
    receivedAt: 3,
    payload: {
      type: 'shell-context',
      context: { ...context, revision: 7, promptGeneration: 4, submissionToken: 'submit-1' },
    },
  });
  assert.equal(resumed['pane-2']!.shellContext?.cwd?.physical, '/current');
  for (const shell of ['bash', 'sh', 'ash'] as const) {
    const baseline = { ...context, shell, promptGeneration: shell === 'bash' ? 3 : null };
    let queued = reduceSshPaneState(INITIAL_STATE, {
      type: 'server-message',
      paneId: 'pane-2',
      receivedAt: 1,
      payload: { type: 'shell-context', context: baseline },
    });
    queued = reduceSshPaneState(queued, { type: 'input-submitted', paneId: 'pane-2', token: 'first' });
    queued = reduceSshPaneState(queued, { type: 'input-submitted', paneId: 'pane-2', token: 'second' });
    queued = reduceSshPaneState(queued, {
      type: 'server-message',
      paneId: 'pane-2',
      receivedAt: 2,
      payload: { type: 'shell-context', context: { ...baseline, revision: 6, submissionToken: 'first' } },
    });
    assert.equal(queued['pane-2']!.trustedCwd, null, 'an earlier acknowledgement cannot release the latest submission');
    queued = reduceSshPaneState(queued, {
      type: 'server-message',
      paneId: 'pane-2',
      receivedAt: 3,
      payload: {
        type: 'shell-context',
        context: { ...baseline, revision: 7, submissionToken: 'second', status: 'paused', cwd: null },
      },
    });
    assert.equal(queued['pane-2']!.pendingSubmissionToken, 'second', 'receipt alone does not confirm a prompt');
    queued = reduceSshPaneState(queued, {
      type: 'server-message',
      paneId: 'pane-2',
      receivedAt: 4,
      payload: { type: 'shell-context', context: { ...baseline, revision: 8, submissionToken: 'second' } },
    });
    assert.equal(queued['pane-2']!.trustedCwd, '/current');
    assert.equal(queued['pane-2']!.pendingSubmissionToken, null);
  }
  for (const payload of [
    { type: 'shell-context' as const, context: { ...context, revision: 4, cwd: null } },
    { ...REMOTE_EVENT_BASE, event: 'cwd' as const, cwd: '/stale' },
    { ...REMOTE_EVENT_BASE, event: 'prompt-ready' as const, promptGeneration: 1 },
    {
      ...REMOTE_EVENT_BASE,
      shellInstanceId: 'foreign',
      event: 'line-state' as const,
      lineLength: 42,
      cursorIndex: 42,
      promptGeneration: 3,
    },
  ]) {
    state = reduceSshPaneState(state, { type: 'server-message', paneId: 'pane-2', receivedAt: 2, payload });
  }
  assert.equal(state['pane-2']!.trustedCwd, '/current');
  assert.equal(state['pane-2']!.promptGeneration, 3);
  assert.equal(state['pane-2']!.lineState, null);
  state = reduceSshPaneState(state, {
    type: 'server-message',
    paneId: 'pane-2',
    receivedAt: 3,
    payload: {
      type: 'shell-context',
      context: { ...context, revision: 6, status: 'paused', reason: 'foreign-shell', cwd: null },
    },
  });
  assert.equal(state['pane-2']!.trustedCwd, null);
  assert.equal(state['pane-2']!.shellContext?.lastKnownCwd?.logical, '/display');
  state = reduceSshPaneState(state, { type: 'transport-state', paneId: 'pane-2', connectionState: 'failed' });
  assert.equal(state['pane-2']!.shellContext, null);
  assert.equal(state['pane-2']!.promptGeneration, null);
});

test('pane reducer isolates telemetry and transport failures by source pane', () => {
  const withTelemetry = reduceSshPaneState(INITIAL_STATE, {
    type: 'server-message',
    paneId: 'pane-2',
    receivedAt: 1,
    payload: {
      type: 'telemetry',
      cpuUsagePercent: 12,
      memoryUsedBytes: 20,
      memoryTotalBytes: 40,
      networkRxBytesPerSec: 2,
      networkTxBytesPerSec: 3,
      recentCommands: ['pwd'],
    },
  });
  const failedPane = reduceSshPaneState(withTelemetry, {
    type: 'transport-state',
    paneId: 'pane-2',
    connectionState: 'failed',
    connectionError: 'closed',
  });

  assert.equal(failedPane['pane-1']?.connectionState, 'connecting');
  assert.equal(failedPane['pane-1']?.telemetryState.cpuUsagePercent, null);
  assert.equal(failedPane['pane-2']?.connectionState, 'failed');
  assert.equal(failedPane['pane-2']?.telemetryState.cpuUsagePercent, 12);
  assert.deepEqual(failedPane['pane-2']?.telemetryState.recentCommands, ['pwd']);
});

test('pane reducer ignores unpaired cwd and rejects stale line-state generations', () => {
  const messages: ServerInboundMessage[] = [
    { ...REMOTE_EVENT_BASE, event: 'cwd', cwd: '/srv/app' },
    { ...REMOTE_EVENT_BASE, event: 'prompt-ready', promptGeneration: 4 },
    { ...REMOTE_EVENT_BASE, event: 'line-state', promptGeneration: 3, lineLength: 8, cursorIndex: 4 },
    { ...REMOTE_EVENT_BASE, event: 'line-state', promptGeneration: 4, lineLength: 8, cursorIndex: 4 },
  ];
  const nextState = messages.reduce(
    (state, payload, index) =>
      reduceSshPaneState(state, {
        type: 'server-message',
        paneId: 'pane-1',
        payload,
        receivedAt: index + 1,
      }),
    INITIAL_STATE,
  );

  assert.equal(nextState['pane-1']?.trustedCwd, null);
  assert.deepEqual(nextState['pane-1']?.lineState, {
    promptGeneration: 4,
    lineLength: 8,
    cursorIndex: 4,
  });
  assert.equal(nextState['pane-2']?.trustedCwd, null);
});

test('pane reducer clears trusted helper calibration when runtime trust is lost', () => {
  const activeState = [
    { ...REMOTE_EVENT_BASE, event: 'cwd', cwd: '/srv/app' },
    { ...REMOTE_EVENT_BASE, event: 'prompt-ready', promptGeneration: 4 },
    { ...REMOTE_EVENT_BASE, event: 'line-state', promptGeneration: 4, lineLength: 8, cursorIndex: 4 },
  ].reduce(
    (state, payload, index) =>
      reduceSshPaneState(state, {
        type: 'server-message',
        paneId: 'pane-1',
        payload: payload as ServerInboundMessage,
        receivedAt: index + 1,
      }),
    INITIAL_STATE,
  );
  const disabledState = reduceSshPaneState(activeState, {
    type: 'server-message',
    paneId: 'pane-1',
    receivedAt: 4,
    payload: {
      type: 'remote-enhancement-runtime-status',
      state: 'disabled',
      code: 'HELPER_CONTRACT_MISMATCH',
      message: 'contract mismatch',
    },
  });

  assert.equal(disabledState['pane-1']?.trustedCwd, null);
  assert.equal(disabledState['pane-1']?.promptGeneration, null);
  assert.equal(disabledState['pane-1']?.lineState, null);
});

test('pane reducer joins command start and end by command id', () => {
  const started = reduceSshPaneState(INITIAL_STATE, {
    type: 'server-message',
    paneId: 'pane-1',
    receivedAt: 1_000,
    payload: {
      ...REMOTE_EVENT_BASE,
      event: 'command-start',
      command: 'git',
      commandId: 'cmd-1',
    },
  });
  const ended = reduceSshPaneState(started, {
    type: 'server-message',
    paneId: 'pane-1',
    receivedAt: 1_125,
    payload: {
      ...REMOTE_EVENT_BASE,
      event: 'command-end',
      command: 'git',
      commandId: 'cmd-1',
      durationMs: 125,
      exitCode: 0,
    },
  });

  assert.deepEqual(ended['pane-1']?.commandTimeline, [
    {
      commandId: 'cmd-1',
      command: 'git',
      startedAt: 1_000,
      endedAt: 1_125,
      durationMs: 125,
      exitCode: 0,
    },
  ]);
  assert.equal(ended['pane-1']?.remoteEnhancementsDebugEvents.length, 2);
});
