import type { ApiMcpPendingTerminalLaunch } from '@cosmosh/api-contract';
import React from 'react';

import { useAgentTerminalSurfaces } from '../lib/agent-terminal-registry';
import { bindMcpTerminalLaunch, cancelMcpTerminalLaunch } from '../lib/backend';
import { t } from '../lib/i18n';
import { useMcpStoreSelector } from '../lib/mcp-store';
import {
  findReadyTerminalLaunchSurface,
  findTerminalLaunchTab,
  shouldCloseAgentTerminalTab,
} from '../lib/mcp-terminal-lifecycle';
import { createSshConnectionIntent } from '../lib/ssh-connection-intent';
import { useToast } from '../lib/toast-context';
import type { TabItem, TabPage } from '../types/tabs';

type McpTerminalHostProps = {
  tabs: readonly TabItem[];
  addTab: (page: TabPage, overrides?: Partial<TabItem>) => string;
  updateTab: (tabId: string, updates: Partial<TabItem>) => void;
  closeTab: (tabId: string) => void;
};

/**
 * Owns renderer-only creation and binding of Agent-visible SSH tabs.
 *
 * Pending launches are replayable, so this host deduplicates by launch id.
 * SSH session ids stay inside this renderer-to-backend bind path.
 *
 * @param props Tab lifecycle callbacks from the application root.
 * @returns No visible UI.
 */
const McpTerminalHost: React.FC<McpTerminalHostProps> = ({ tabs, addTab, updateTab, closeTab }) => {
  const terminalLaunches = useMcpStoreSelector((snapshot) => snapshot.terminalLaunches);
  const connectionClosures = useMcpStoreSelector((snapshot) => snapshot.connectionClosures);
  const surfaces = useAgentTerminalSurfaces();
  const { error: notifyError } = useToast();
  const creatingLaunchIdsRef = React.useRef<Set<string>>(new Set());
  const bindingLaunchIdsRef = React.useRef<Set<string>>(new Set());
  const cancelledLaunchIdsRef = React.useRef<Set<string>>(new Set());
  const processedClosureKeysRef = React.useRef<Set<string>>(new Set());
  const previousTabsRef = React.useRef<readonly TabItem[]>(tabs);

  React.useEffect(() => {
    const currentTabIds = new Set(tabs.map((tab) => tab.id));
    const pendingLaunchIds = new Set(terminalLaunches.map((launch) => launch.launchId));

    for (const previousTab of previousTabsRef.current) {
      const marker = previousTab.state?.agentTerminal;
      if (
        !currentTabIds.has(previousTab.id) &&
        marker?.launchId &&
        !marker.connectionId &&
        pendingLaunchIds.has(marker.launchId)
      ) {
        cancelledLaunchIdsRef.current.add(marker.launchId);
        void cancelMcpTerminalLaunch(marker.launchId);
      }
    }

    previousTabsRef.current = tabs;
  }, [tabs, terminalLaunches]);

  React.useEffect(() => {
    const liveLaunchIds = new Set(terminalLaunches.map((launch) => launch.launchId));
    for (const launchId of creatingLaunchIdsRef.current) {
      if (!liveLaunchIds.has(launchId) || findTerminalLaunchTab(tabs, launchId)) {
        creatingLaunchIdsRef.current.delete(launchId);
      }
    }

    for (const launch of terminalLaunches) {
      if (
        cancelledLaunchIdsRef.current.has(launch.launchId) ||
        creatingLaunchIdsRef.current.has(launch.launchId) ||
        findTerminalLaunchTab(tabs, launch.launchId)
      ) {
        continue;
      }

      creatingLaunchIdsRef.current.add(launch.launchId);
      addTab('ssh', {
        title: launch.serverName,
        iconKey: 'ssh',
        state: {
          sshConnectionIntent: createSshConnectionIntent(launch.serverId),
          agentTerminal: {
            client: launch.client,
            agentCreatedTab: true,
            launchId: launch.launchId,
          },
        },
      });
    }

    for (const tab of tabs) {
      const marker = tab.state?.agentTerminal;
      if (marker?.launchId && !marker.connectionId && !liveLaunchIds.has(marker.launchId)) {
        updateTab(tab.id, {
          state: {
            ...(tab.state ?? {}),
            agentTerminal: undefined,
          },
        });
      }
    }
  }, [addTab, tabs, terminalLaunches, updateTab]);

  React.useEffect(() => {
    for (const launch of terminalLaunches) {
      const tab = findTerminalLaunchTab(tabs, launch.launchId);
      if (!tab || tab.state?.agentTerminal?.connectionId) {
        continue;
      }

      const surface = findReadyTerminalLaunchSurface(surfaces, tab.id, launch.serverId);
      if (!surface?.sessionId || bindingLaunchIdsRef.current.has(launch.launchId)) {
        continue;
      }

      bindingLaunchIdsRef.current.add(launch.launchId);
      void bindLaunch({
        launch,
        tab,
        terminalSessionId: surface.sessionId,
        updateTab,
        notifyError,
        onFailure: (launchId) => {
          cancelledLaunchIdsRef.current.add(launchId);
          void cancelMcpTerminalLaunch(launchId);
        },
      }).finally(() => {
        bindingLaunchIdsRef.current.delete(launch.launchId);
      });
    }
  }, [notifyError, surfaces, tabs, terminalLaunches, updateTab]);

  React.useEffect(() => {
    const liveClosureKeys = new Set(connectionClosures.map((closure) => `${closure.connectionId}:${closure.reason}`));
    for (const closureKey of processedClosureKeysRef.current) {
      if (!liveClosureKeys.has(closureKey)) {
        processedClosureKeysRef.current.delete(closureKey);
      }
    }

    for (const closure of connectionClosures) {
      const closureKey = `${closure.connectionId}:${closure.reason}`;
      if (processedClosureKeysRef.current.has(closureKey)) {
        continue;
      }

      const tab = tabs.find((candidate) => candidate.state?.agentTerminal?.connectionId === closure.connectionId);
      if (!tab) {
        continue;
      }
      processedClosureKeysRef.current.add(closureKey);

      if (shouldCloseAgentTerminalTab(tab, closure.reason)) {
        closeTab(tab.id);
        continue;
      }

      updateTab(tab.id, {
        state: {
          ...(tab.state ?? {}),
          agentTerminal: undefined,
        },
      });
    }
  }, [closeTab, connectionClosures, tabs, updateTab]);

  return null;
};

/**
 * Binds one ready primary SSH pane and applies the connection summary to its tab.
 *
 * @param input Launch, tab, private session id, and UI callbacks.
 * @returns Nothing.
 */
const bindLaunch = async (input: {
  launch: ApiMcpPendingTerminalLaunch;
  tab: TabItem;
  terminalSessionId: string;
  updateTab: McpTerminalHostProps['updateTab'];
  notifyError: (message: string) => void;
  onFailure: (launchId: string) => void;
}): Promise<void> => {
  try {
    const response = await bindMcpTerminalLaunch(input.launch.launchId, {
      terminalSessionId: input.terminalSessionId,
    });
    input.updateTab(input.tab.id, {
      state: {
        ...(input.tab.state ?? {}),
        agentTerminal: {
          client: input.launch.client,
          agentCreatedTab: true,
          launchId: input.launch.launchId,
          connectionId: response.data.connection.connectionId,
        },
      },
    });
  } catch {
    input.onFailure(input.launch.launchId);
    input.updateTab(input.tab.id, {
      state: {
        ...(input.tab.state ?? {}),
        agentTerminal: undefined,
      },
    });
    input.notifyError(t('mcpTerminal.errors.launchFailed'));
  }
};

export default McpTerminalHost;
