import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteShellCapability } from '@cosmosh/api-contract';

import { createSshPaneState, reduceSshPaneState, type SshPaneStateMap } from './ssh-pane-state';
import type { ServerInboundMessage } from './ssh-types';

const INITIAL_STATE: SshPaneStateMap = {
  'pane-1': createSshPaneState(),
  'pane-2': createSshPaneState(),
};

const REMOTE_EVENT_BASE = {
  type: 'remote-shell-event',
  shell: 'zsh',
  helperVersion: 'test-v2',
  protocolVersion: 2,
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

test('pane reducer tracks Agent attachment state and pessimistically invalidates prompt readiness on input', () => {
  const promptReady = [
    { ...REMOTE_EVENT_BASE, event: 'prompt-ready', promptGeneration: 4 },
    { ...REMOTE_EVENT_BASE, event: 'line-state', promptGeneration: 4, lineLength: 0, cursorIndex: 0 },
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
  const attached = reduceSshPaneState(promptReady, {
    type: 'server-message',
    paneId: 'pane-1',
    receivedAt: 3,
    payload: {
      type: 'agent-attachment-status',
      state: 'running',
      connectionId: 'connection-1',
      client: { name: 'test-agent', version: '1.0.0' },
      mode: 'attached',
      agentCreatedTab: false,
    },
  });
  const withInput = reduceSshPaneState(attached, {
    type: 'client-input',
    paneId: 'pane-1',
    data: 'x',
  });

  assert.equal(attached['pane-1']?.agentAttachmentStatus?.state, 'running');
  assert.equal(withInput['pane-1']?.atPrompt, true);
  assert.equal(withInput['pane-1']?.lineState?.lineLength, 1);

  const submitted = reduceSshPaneState(withInput, {
    type: 'client-input',
    paneId: 'pane-1',
    data: '\r',
  });
  assert.equal(submitted['pane-1']?.atPrompt, false);
  assert.equal(submitted['pane-1']?.lineState, null);
});
