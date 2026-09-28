import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteShellCapability, ShellContext } from '@cosmosh/api-contract';

import { createSshPaneState, reduceSshPaneState, type SshPaneStateMap } from './ssh-pane-state';
import type { ServerInboundMessage } from './ssh-types';

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
    promptGeneration: 3,
    cwdGeneration: 2,
    cwd: { logical: '/current', physical: null, home: null },
    lastKnownCwd: { logical: '/current', physical: null, home: null },
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
  assert.equal(state['pane-2']!.shellContext?.lastKnownCwd?.logical, '/current');
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

test('pane reducer retains trusted cwd and rejects stale line-state generations', () => {
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

  assert.equal(nextState['pane-1']?.trustedCwd, '/srv/app');
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
