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
  McpConnectionMode,
  McpConnectionStatus,
  McpConnectionSummary,
  McpEventMessage,
  McpPendingApprovalPayload,
} from '@cosmosh/api-contract';
import type { Client } from 'ssh2';

import type { SshClientLifecycleMonitor } from '../ssh/connect.js';
import type { McpConnectionCapacityReservation } from './connection-capacity.js';

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
type McpConnectionStateBase = {
  connectionId: string;
  /** Protocol session that exclusively owns this SSH connection. */
  ownerSessionId: string;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  clientInfo: McpClientInfo;
  /** Last persisted server revision observed while enforcing command policy. */
  serverPolicyUpdatedAt: Date;
  openedAt: Date;
  lastUsedAt: Date;
  commandCount: number;
  commandsPreApproved: boolean;
  idleTimer: NodeJS.Timeout | null;
  disposed: boolean;
  mode: McpConnectionMode;
  status: McpConnectionStatus;
  userVisible: boolean;
  agentCreatedTab: boolean;
  capacityReservation: McpConnectionCapacityReservation;
};

/**
 * Independent ssh2 client retained for background command execution.
 */
export type McpBackgroundConnectionState = McpConnectionStateBase & {
  mode: 'background';
  client: Client;
  lifecycleMonitor: SshClientLifecycleMonitor;
};

/**
 * Agent permission attached to one renderer-owned SSH session.
 */
export type McpTerminalConnectionState = McpConnectionStateBase & {
  mode: 'terminal' | 'attached';
  terminalSessionId: string;
};

/**
 * In-memory representation of one Agent SSH connection in any supported mode.
 */
export type McpConnectionState = McpBackgroundConnectionState | McpTerminalConnectionState;

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
  connectionMode?: McpConnectionMode;
  serverId?: string;
  serverName?: string;
  host?: string;
  port?: number;
  username?: string;
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
