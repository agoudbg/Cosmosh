import type { McpConnectionCloseReason } from '@cosmosh/api-contract';

import type { TabItem } from '../types/tabs';
import type { AgentTerminalSurface } from './agent-terminal-registry';

/**
 * Returns the tab currently representing one pending visible terminal launch.
 *
 * @param tabs Current application tabs.
 * @param launchId Renderer-only launch id.
 * @returns Matching tab, or undefined.
 */
export const findTerminalLaunchTab = (tabs: readonly TabItem[], launchId: string): TabItem | undefined => {
  return tabs.find((tab) => tab.state?.agentTerminal?.launchId === launchId);
};

/**
 * Selects the eligible primary pane created for one terminal launch.
 *
 * Secondary panes cannot satisfy a launch because the Agent-created tab binds
 * exactly once to its primary SSH session.
 *
 * @param surfaces Renderer-owned pane snapshots.
 * @param tabId Agent-created tab id.
 * @param serverId Approved server id.
 * @returns Ready primary surface, or undefined.
 */
export const findReadyTerminalLaunchSurface = (
  surfaces: readonly AgentTerminalSurface[],
  tabId: string,
  serverId: string,
): AgentTerminalSurface | undefined => {
  return surfaces.find((candidate) => {
    return (
      candidate.tabId === tabId &&
      candidate.paneIndex === 0 &&
      candidate.serverId === serverId &&
      candidate.sessionId !== null &&
      candidate.disabledReason === null
    );
  });
};

/**
 * Decides whether a closed MCP connection should also close its visible tab.
 *
 * Only explicit Agent or MCP-panel close actions own the lifecycle of an
 * Agent-created tab. Disconnect-like cleanup must preserve it for the user.
 *
 * @param tab Agent-marked tab.
 * @param reason Backend connection close reason.
 * @returns True when Cosmosh should close the tab.
 */
export const shouldCloseAgentTerminalTab = (tab: TabItem, reason: McpConnectionCloseReason): boolean => {
  return tab.state?.agentTerminal?.agentCreatedTab === true && (reason === 'tool' || reason === 'ui');
};
