import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTerminalSurface } from '../lib/agent-terminal-registry';
import {
  findReadyTerminalLaunchSurface,
  findTerminalLaunchTab,
  shouldCloseAgentTerminalTab,
} from '../lib/mcp-terminal-lifecycle';
import type { TabItem } from '../types/tabs';

const AGENT_TAB: TabItem = {
  id: 'tab-agent',
  page: 'ssh',
  title: 'Server One',
  iconKey: 'ssh',
  state: {
    agentTerminal: {
      client: { name: 'test-agent', version: '1.0.0' },
      agentCreatedTab: true,
      launchId: 'launch-1',
      connectionId: 'connection-1',
    },
  },
};

/**
 * Builds one ready primary launch surface.
 *
 * @param overrides Fields that differ from the primary baseline.
 * @returns Surface fixture.
 */
const surface = (overrides: Partial<AgentTerminalSurface> = {}): AgentTerminalSurface => ({
  surfaceId: 'tab-agent:pane-1',
  tabId: 'tab-agent',
  tabTitle: 'Server One',
  paneId: 'pane-1',
  paneIndex: 0,
  sessionId: 'session-1',
  serverId: 'server-1',
  serverName: 'Server One',
  isActiveTab: true,
  isActivePane: true,
  connectionState: 'connected',
  runtimeStatus: {
    type: 'remote-enhancement-runtime-status',
    state: 'active',
    capabilities: ['command-start', 'command-end', 'prompt-ready', 'line-state'],
  },
  atPrompt: true,
  lineLength: 0,
  attachmentStatus: null,
  disabledReason: null,
  ...overrides,
});

test('launch replay deduplicates against the tab launch marker', () => {
  assert.equal(findTerminalLaunchTab([AGENT_TAB], 'launch-1')?.id, AGENT_TAB.id);
  assert.equal(findTerminalLaunchTab([AGENT_TAB], 'launch-other'), undefined);
});

test('launch binding uses only the ready primary pane from a split tab', () => {
  const secondary = surface({
    surfaceId: 'tab-agent:pane-2',
    paneId: 'pane-2',
    paneIndex: 1,
    sessionId: 'session-2',
  });
  const primary = surface();

  assert.equal(findReadyTerminalLaunchSurface([secondary, primary], 'tab-agent', 'server-1')?.sessionId, 'session-1');
  assert.equal(
    findReadyTerminalLaunchSurface([surface({ disabledReason: 'pending-input' }), secondary], 'tab-agent', 'server-1'),
    undefined,
  );
});

test('only explicit close actions close an Agent-created tab', () => {
  assert.equal(shouldCloseAgentTerminalTab(AGENT_TAB, 'tool'), true);
  assert.equal(shouldCloseAgentTerminalTab(AGENT_TAB, 'ui'), true);
  assert.equal(shouldCloseAgentTerminalTab(AGENT_TAB, 'client-disconnected'), false);
  assert.equal(shouldCloseAgentTerminalTab(AGENT_TAB, 'idle'), false);

  const attachedTab: TabItem = {
    ...AGENT_TAB,
    state: {
      ...AGENT_TAB.state,
      agentTerminal: {
        ...AGENT_TAB.state!.agentTerminal!,
        agentCreatedTab: false,
      },
    },
  };
  assert.equal(shouldCloseAgentTerminalTab(attachedTab, 'ui'), false);
});
