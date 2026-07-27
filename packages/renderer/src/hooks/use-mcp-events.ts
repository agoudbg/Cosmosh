/**
 * Live MCP event-channel subscription.
 *
 * Opens the backend event WebSocket (via `createMcpEventsChannel`, reusing the
 * terminal's "direct backend WS + query token" pattern), streams status/approval/
 * connection/client events into the MCP store, and keeps the REST-backed lists in
 * sync by refetching whenever the channel (re)connects. The channel is only active
 * while the `mcpEnabled` setting is on; disabling it tears the socket down and
 * clears the runtime data.
 */

import { parseMcpEventMessage } from '@cosmosh/api-contract';
import React from 'react';

import {
  createMcpEventsChannel,
  getMcpStatus,
  listMcpApprovals,
  listMcpClients,
  listMcpConnections,
  listMcpTerminalLaunches,
} from '../lib/backend';
import {
  applyMcpEvent,
  resetMcpRuntimeData,
  setMcpApprovals,
  setMcpChannelState,
  setMcpClients,
  setMcpConnections,
  setMcpStatus,
  setMcpTerminalLaunches,
} from '../lib/mcp-store';
import { useSettingsValue } from '../lib/settings-store';

/** Base reconnect delay in milliseconds; grows exponentially up to the cap. */
const RECONNECT_BASE_DELAY_MS = 1_000;
/** Maximum reconnect backoff delay in milliseconds. */
const RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * Fetches the current runtime snapshot over REST and pushes it into the store.
 *
 * Called on initial subscribe and on every reconnect so the panel reflects any
 * events that were missed while the socket was down.
 *
 * @returns Nothing; failures are swallowed (the channel will retry).
 */
const refreshRuntimeData = async (): Promise<void> => {
  try {
    const [status, clients, connections, approvals, terminalLaunches] = await Promise.all([
      getMcpStatus(),
      listMcpClients(),
      listMcpConnections(),
      listMcpApprovals(),
      listMcpTerminalLaunches(),
    ]);
    setMcpStatus(status.data);
    setMcpClients(clients.data.items);
    setMcpConnections(connections.data.items);
    setMcpApprovals(approvals.data.items);
    setMcpTerminalLaunches(terminalLaunches.data.items);
  } catch {
    // Ignore — a transient REST failure will be retried on the next reconnect.
  }
};

/**
 * Subscribes to the MCP event channel for the lifetime of the mounting component.
 *
 * Intended to be mounted once (e.g. by the global approval host) so the store
 * stays live regardless of which tab is focused.
 *
 * @returns Nothing.
 */
export const useMcpEvents = (): void => {
  const mcpEnabled = useSettingsValue('mcpEnabled');

  React.useEffect(() => {
    if (!mcpEnabled) {
      resetMcpRuntimeData('idle');
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearReconnectTimer = (): void => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed) {
        return;
      }
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      attempt += 1;
      clearReconnectTimer();
      reconnectTimer = setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      setMcpChannelState('connecting');
      let channel;
      try {
        channel = await createMcpEventsChannel();
      } catch {
        setMcpChannelState('closed');
        scheduleReconnect();
        return;
      }
      if (disposed) {
        return;
      }

      const websocketUrl = new URL(channel.data.websocketUrl);
      websocketUrl.searchParams.set('token', channel.data.websocketToken);
      const nextSocket = new WebSocket(websocketUrl.toString());
      socket = nextSocket;

      nextSocket.addEventListener('open', () => {
        if (disposed) {
          return;
        }
        attempt = 0;
        setMcpChannelState('open');
        void refreshRuntimeData();
      });

      nextSocket.addEventListener('message', (messageEvent) => {
        if (typeof messageEvent.data !== 'string') {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(messageEvent.data);
        } catch {
          return;
        }
        const event = parseMcpEventMessage(parsed);
        if (event) {
          applyMcpEvent(event);
        }
      });

      nextSocket.addEventListener('close', () => {
        if (socket === nextSocket) {
          socket = null;
        }
        if (disposed) {
          return;
        }
        setMcpChannelState('closed');
        scheduleReconnect();
      });

      nextSocket.addEventListener('error', () => {
        // `close` fires after `error`; reconnection is scheduled there.
        nextSocket.close();
      });
    };

    void connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      if (socket) {
        socket.close();
        socket = null;
      }
      resetMcpRuntimeData('idle');
    };
  }, [mcpEnabled]);
};
