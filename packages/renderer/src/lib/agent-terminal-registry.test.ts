import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTerminalAttachmentStatus, RemoteEnhancementRuntimeStatus } from '@cosmosh/api-contract';

import {
  type AgentTerminalSurface,
  areAgentTerminalSurfaceListsEqual,
  resolveAgentTerminalDisabledReason,
  resolveDefaultAgentTerminalSurface,
} from './agent-terminal-registry';

const ACTIVE_RUNTIME: RemoteEnhancementRuntimeStatus = {
  type: 'remote-enhancement-runtime-status',
  state: 'active',
  capabilities: ['command-start', 'command-end', 'prompt-ready', 'line-state'],
};

/**
 * Builds one renderer surface with overridable selection state.
 *
 * @param overrides Fields that differ from the eligible baseline.
 * @returns Complete surface fixture.
 */
const surface = (overrides: Partial<AgentTerminalSurface> = {}): AgentTerminalSurface => ({
  surfaceId: 'tab-1:pane-1',
  tabId: 'tab-1',
  tabTitle: 'Server One',
  paneId: 'pane-1',
  paneIndex: 0,
  sessionId: 'session-1',
  serverId: 'server-1',
  serverName: 'Server One',
  isActiveTab: false,
  isActivePane: false,
  connectionState: 'connected',
  runtimeStatus: ACTIVE_RUNTIME,
  atPrompt: true,
  lineLength: 0,
  attachmentStatus: null,
  disabledReason: null,
  ...overrides,
});

test('attachment selector defaults to the current pane even when it is disabled', () => {
  const eligible = surface({ surfaceId: 'tab-2:pane-1', tabId: 'tab-2' });
  const current = surface({
    isActiveTab: true,
    isActivePane: true,
    disabledReason: 'pending-input',
  });

  assert.equal(resolveDefaultAgentTerminalSurface([eligible, current])?.surfaceId, current.surfaceId);
});

test('attachment selector falls back to the first eligible split pane', () => {
  const failed = surface({
    surfaceId: 'tab-1:pane-1',
    connectionState: 'failed',
    disabledReason: 'connection-failed',
  });
  const secondary = surface({
    surfaceId: 'tab-1:pane-2',
    paneId: 'pane-2',
    paneIndex: 1,
  });

  assert.equal(resolveDefaultAgentTerminalSurface([failed, secondary])?.surfaceId, secondary.surfaceId);
});

test('eligibility reports every fail-closed terminal state', () => {
  const attached: AgentTerminalAttachmentStatus = {
    type: 'agent-attachment-status',
    state: 'idle',
    connectionId: 'connection-1',
  };
  const base = {
    connectionState: 'connected' as const,
    runtimeStatus: ACTIVE_RUNTIME,
    atPrompt: true,
    lineLength: 0,
    attachmentStatus: null,
  };

  assert.equal(resolveAgentTerminalDisabledReason({ ...base, connectionState: 'connecting' }), 'connecting');
  assert.equal(resolveAgentTerminalDisabledReason({ ...base, connectionState: 'failed' }), 'connection-failed');
  assert.equal(resolveAgentTerminalDisabledReason({ ...base, runtimeStatus: null }), 'automation-unavailable');
  assert.equal(resolveAgentTerminalDisabledReason({ ...base, attachmentStatus: attached }), 'already-attached');
  assert.equal(resolveAgentTerminalDisabledReason({ ...base, atPrompt: false }), 'not-at-prompt');
  assert.equal(resolveAgentTerminalDisabledReason({ ...base, lineLength: 3 }), 'pending-input');
  assert.equal(resolveAgentTerminalDisabledReason(base), null);
});

test('Bash and Fish lifecycle capabilities are sufficient without line-state', () => {
  assert.equal(
    resolveAgentTerminalDisabledReason({
      connectionState: 'connected',
      runtimeStatus: {
        type: 'remote-enhancement-runtime-status',
        state: 'active',
        capabilities: ['cwd', 'command-start', 'command-end', 'foreground-command', 'prompt-ready'],
      },
      atPrompt: true,
      lineLength: 0,
      attachmentStatus: null,
    }),
    null,
  );
});

test('surface registry publishes a surviving pane promoted to primary', () => {
  const promoted = surface({
    surfaceId: 'tab-1:pane-2',
    paneId: 'pane-2',
    paneIndex: 1,
    sessionId: 'session-2',
  });
  assert.equal(areAgentTerminalSurfaceListsEqual([promoted], [{ ...promoted, paneIndex: 0 }]), false);
});
