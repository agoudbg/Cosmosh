/**
 * Internal runtime types for the Cosmosh MCP backend module.
 *
 * Wire-facing shapes (policies, approvals, events) live in
 * `@cosmosh/api-contract`; the types here describe in-memory runtime state and
 * the dependency surface passed between MCP sub-services.
 */

import type {
  McpApprovalDecision,
  McpApprovalKind,
  McpClientInfo,
  McpConnectionCloseReason,
  McpConnectionSummary,
  McpEventMessage,
  McpPendingApprovalPayload,
  McpServerCommandPolicy,
} from '@cosmosh/api-contract';
import type { Client } from 'ssh2';

import type { SshClientLifecycleMonitor } from '../ssh/connect.js';

/**
 * Monotonic clock and timer surface, injectable so broker/registry timeouts are
 * deterministic under test.
 */
export type McpClock = {
  now: () => number;
  setTimeout: (handler: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimeout: (handle: NodeJS.Timeout) => void;
};

/**
 * Default clock backed by the Node.js global timers.
 */
export const systemMcpClock: McpClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

/**
 * In-memory representation of one agent-opened SSH connection.
 */
export type McpConnectionState = {
  connectionId: string;
  /** Protocol session that exclusively owns this SSH connection. */
  ownerSessionId: string;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  client: Client;
  clientInfo: McpClientInfo;
  /** Per-server override captured at open time; resolved against the global setting per command. */
  serverCommandPolicy: McpServerCommandPolicy;
  lifecycleMonitor: SshClientLifecycleMonitor;
  openedAt: Date;
  lastUsedAt: Date;
  commandCount: number;
  commandsPreApproved: boolean;
  idleTimer: NodeJS.Timeout | null;
  disposed: boolean;
};

/**
 * Snapshot converted from {@link McpConnectionState} for renderer/tool consumers.
 */
export type McpConnectionSnapshot = McpConnectionSummary;

/**
 * Active MCP protocol session state (one per connected agent client).
 */
export type McpClientSessionState = {
  mcpSessionId: string;
  client: McpClientInfo;
  startedAt: Date;
  lastActivityAt: Date;
};

/**
 * Pending authorization request tracked by the approval broker.
 */
export type McpApprovalRecord = {
  payload: McpPendingApprovalPayload;
  resolve: (decision: McpApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

/**
 * Input required to raise one authorization prompt.
 */
export type McpApprovalRequestInput = {
  kind: McpApprovalKind;
  client: McpClientInfo;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  reason?: string;
  command?: string;
  connectionId?: string;
};

/**
 * Broadcast sink used by sub-services to push events to the renderer channel.
 */
export type McpEventEmitter = (message: McpEventMessage) => void;

/**
 * Close reason forwarded to the connection registry teardown path.
 */
export type McpConnectionCloseCause = McpConnectionCloseReason;
