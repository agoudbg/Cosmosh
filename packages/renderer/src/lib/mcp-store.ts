/**
 * Centralized MCP runtime store — single reactive source for the Settings MCP
 * management section and the global authorization dialog host.
 *
 * Built on React 18's `useSyncExternalStore` (same pattern as `settings-store.ts`).
 * The store holds the latest status snapshot plus the live lists of clients,
 * connections, and pending approvals. It is fed by REST refreshes and by the
 * backend event WebSocket (see `hooks/use-mcp-events.ts`); it performs no I/O
 * itself so it stays trivially testable and framework-agnostic.
 */

import type {
  ApiMcpClientSession,
  ApiMcpConnectionSummary,
  ApiMcpPendingApproval,
  ApiMcpPendingTerminalLaunch,
  ApiMcpStatusData,
  McpEventMessage,
} from '@cosmosh/api-contract';
import React from 'react';

// ── Internal State ───────────────────────────────────────────

/**
 * Immutable MCP store snapshot consumed by React components.
 */
export type McpStoreSnapshot = {
  status: ApiMcpStatusData | null;
  clients: readonly ApiMcpClientSession[];
  connections: readonly ApiMcpConnectionSummary[];
  approvals: readonly ApiMcpPendingApproval[];
  terminalLaunches: readonly ApiMcpPendingTerminalLaunch[];
  connectionClosures: readonly Extract<McpEventMessage, { type: 'connection-closed' }>[];
};

const EMPTY_SNAPSHOT: McpStoreSnapshot = {
  status: null,
  clients: [],
  connections: [],
  approvals: [],
  terminalLaunches: [],
  connectionClosures: [],
};

let currentSnapshot: McpStoreSnapshot = EMPTY_SNAPSHOT;

const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): McpStoreSnapshot => {
  return currentSnapshot;
};

/**
 * Replaces the snapshot and notifies subscribers.
 *
 * @param patch Partial snapshot fields to merge over the current snapshot.
 * @returns Nothing.
 */
const patchSnapshot = (patch: Partial<McpStoreSnapshot>): void => {
  currentSnapshot = { ...currentSnapshot, ...patch };
  emitChange();
};

// ── Mutations ────────────────────────────────────────────────

/**
 * Stores the latest status snapshot fetched over REST.
 *
 * @param status Status data, or null to clear.
 * @returns Nothing.
 */
export const setMcpStatus = (status: ApiMcpStatusData | null): void => {
  patchSnapshot({ status });
};

/**
 * Replaces the connected-clients list.
 *
 * @param clients Client sessions.
 * @returns Nothing.
 */
export const setMcpClients = (clients: readonly ApiMcpClientSession[]): void => {
  patchSnapshot({ clients });
};

/**
 * Replaces the active-connections list.
 *
 * @param connections Connection summaries.
 * @returns Nothing.
 */
export const setMcpConnections = (connections: readonly ApiMcpConnectionSummary[]): void => {
  patchSnapshot({ connections });
};

/**
 * Replaces the pending-approvals queue.
 *
 * @param approvals Pending approvals ordered oldest-first.
 * @returns Nothing.
 */
export const setMcpApprovals = (approvals: readonly ApiMcpPendingApproval[]): void => {
  patchSnapshot({ approvals });
};

/**
 * Replaces the renderer-backfilled terminal launch queue.
 *
 * @param terminalLaunches Pending visible terminal launches.
 */
export const setMcpTerminalLaunches = (terminalLaunches: readonly ApiMcpPendingTerminalLaunch[]): void => {
  patchSnapshot({ terminalLaunches });
};

/**
 * Clears all runtime data — used when MCP is disabled or the channel tears down.
 *
 * @returns Nothing.
 */
export const resetMcpRuntimeData = (): void => {
  currentSnapshot = { ...EMPTY_SNAPSHOT, status: currentSnapshot.status };
  emitChange();
};

/**
 * Applies one backend event-channel frame to the store.
 *
 * @param event Parsed MCP event message.
 * @returns Nothing.
 */
export const applyMcpEvent = (event: McpEventMessage): void => {
  switch (event.type) {
    case 'approval-requested': {
      const approval = event.approval as ApiMcpPendingApproval;
      const withoutDuplicate = currentSnapshot.approvals.filter((item) => item.approvalId !== approval.approvalId);
      patchSnapshot({ approvals: [...withoutDuplicate, approval] });
      return;
    }
    case 'approval-resolved': {
      patchSnapshot({
        approvals: currentSnapshot.approvals.filter((item) => item.approvalId !== event.approvalId),
      });
      return;
    }
    case 'connection-opened':
    case 'connection-updated': {
      const connection = event.connection as ApiMcpConnectionSummary;
      const withoutDuplicate = currentSnapshot.connections.filter(
        (item) => item.connectionId !== connection.connectionId,
      );
      patchSnapshot({ connections: [...withoutDuplicate, connection] });
      return;
    }
    case 'connection-closed': {
      patchSnapshot({
        connections: currentSnapshot.connections.filter((item) => item.connectionId !== event.connectionId),
        connectionClosures: [...currentSnapshot.connectionClosures.slice(-31), event],
      });
      return;
    }
    case 'terminal-launch-requested': {
      const launch = event.launch as ApiMcpPendingTerminalLaunch;
      const withoutDuplicate = currentSnapshot.terminalLaunches.filter((item) => item.launchId !== launch.launchId);
      patchSnapshot({ terminalLaunches: [...withoutDuplicate, launch] });
      return;
    }
    case 'terminal-launch-resolved': {
      patchSnapshot({
        terminalLaunches: currentSnapshot.terminalLaunches.filter((item) => item.launchId !== event.launchId),
      });
      return;
    }
    case 'client-session-started': {
      const session = event.session as ApiMcpClientSession;
      const withoutDuplicate = currentSnapshot.clients.filter((item) => item.mcpSessionId !== session.mcpSessionId);
      patchSnapshot({ clients: [...withoutDuplicate, session] });
      return;
    }
    case 'client-session-ended': {
      patchSnapshot({
        clients: currentSnapshot.clients.filter((item) => item.mcpSessionId !== event.mcpSessionId),
      });
      return;
    }
    case 'status-changed': {
      const previous = currentSnapshot.status;
      // Event status omits discovery/launcher paths; preserve them from the last REST snapshot.
      patchSnapshot({
        status: previous ? { ...previous, ...event.status } : { ...event.status },
      });
      return;
    }
    default:
      return;
  }
};

// ── React Hooks ──────────────────────────────────────────────

/**
 * Subscribes to the entire MCP store snapshot.
 *
 * @returns Current immutable snapshot.
 */
export const useMcpStore = (): McpStoreSnapshot => {
  return React.useSyncExternalStore(subscribe, getSnapshot);
};

/**
 * Subscribes to a derived slice of the MCP store.
 *
 * @param selector Pure selector over the snapshot.
 * @returns Selected value; re-renders only when it changes by identity.
 */
export function useMcpStoreSelector<T>(selector: (snapshot: McpStoreSnapshot) => T): T {
  const boundSelector = React.useCallback(() => selector(getSnapshot()), [selector]);
  return React.useSyncExternalStore(subscribe, boundSelector);
}
