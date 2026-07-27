/**
 * Cosmosh MCP (Model Context Protocol) shared contract types.
 *
 * Covers the command authorization policy model (global setting plus per-server
 * override) and the wire payloads exchanged between the backend MCP service and
 * the renderer authorization UI. REST management endpoints are typed through
 * the OpenAPI contract; the event-channel payloads here are hand-written like
 * the IPC-only types in ipc.ts.
 */

// ── Command authorization policy ─────────────────────────────

/**
 * Effective policy for agent-issued command execution on an MCP SSH connection.
 */
export type McpCommandPolicy = 'off' | 'ask' | 'allowWithinConnection';

/**
 * Default-strict command policy used when no explicit choice was made.
 */
export const DEFAULT_MCP_COMMAND_POLICY: McpCommandPolicy = 'ask';

/**
 * Stable option list shared by settings, API validation, and renderer UI.
 */
export const MCP_COMMAND_POLICY_OPTIONS: readonly McpCommandPolicy[] = ['off', 'ask', 'allowWithinConnection'];

const MCP_COMMAND_POLICY_SET: ReadonlySet<string> = new Set(MCP_COMMAND_POLICY_OPTIONS);

/**
 * Checks whether a raw value is a supported MCP command policy.
 *
 * @param value Candidate value.
 * @returns True when the value is a supported command policy.
 */
export const isMcpCommandPolicy = (value: unknown): value is McpCommandPolicy => {
  return typeof value === 'string' && MCP_COMMAND_POLICY_SET.has(value);
};

/**
 * Per-server command policy: an explicit policy or `default` to inherit the
 * global `mcpCommandPolicy` setting.
 */
export type McpServerCommandPolicy = McpCommandPolicy | 'default';

/**
 * Default per-server policy inheriting the global setting.
 */
export const DEFAULT_MCP_SERVER_COMMAND_POLICY: McpServerCommandPolicy = 'default';

/**
 * Stable option list for the per-server policy override select.
 */
export const MCP_SERVER_COMMAND_POLICY_OPTIONS: readonly McpServerCommandPolicy[] = [
  'default',
  'off',
  'ask',
  'allowWithinConnection',
];

const MCP_SERVER_COMMAND_POLICY_SET: ReadonlySet<string> = new Set(MCP_SERVER_COMMAND_POLICY_OPTIONS);

/**
 * Checks whether a raw value is a supported per-server MCP command policy.
 *
 * @param value Candidate value.
 * @returns True when the value is a supported per-server command policy.
 */
export const isMcpServerCommandPolicy = (value: unknown): value is McpServerCommandPolicy => {
  return typeof value === 'string' && MCP_SERVER_COMMAND_POLICY_SET.has(value);
};

/**
 * Resolves the effective command policy for one server.
 *
 * @param serverPolicy Per-server override persisted on the SSH server.
 * @param globalPolicy Global `mcpCommandPolicy` setting value.
 * @returns Effective policy applied to agent command execution.
 */
export const resolveEffectiveMcpCommandPolicy = (
  serverPolicy: McpServerCommandPolicy,
  globalPolicy: McpCommandPolicy,
): McpCommandPolicy => {
  return serverPolicy === 'default' ? globalPolicy : serverPolicy;
};

// ── Authorization approvals ──────────────────────────────────

/**
 * Operation kinds that require explicit user authorization.
 */
export type McpApprovalKind = 'connection-open' | 'terminal-attach' | 'command-execute';

/**
 * Terminal states of one authorization request.
 */
export type McpApprovalDecision = 'approved' | 'approvedForConnection' | 'denied' | 'timeout' | 'superseded';

/**
 * Decisions the renderer may submit for a pending approval.
 */
export type McpApprovalUserDecision = Extract<McpApprovalDecision, 'approved' | 'approvedForConnection' | 'denied'>;

const MCP_APPROVAL_USER_DECISION_SET: ReadonlySet<string> = new Set([
  'approved',
  'approvedForConnection',
  'denied',
] satisfies McpApprovalUserDecision[]);

/**
 * Checks whether a raw value is a decision the renderer may submit.
 *
 * @param value Candidate value.
 * @returns True when the value is a supported user decision.
 */
export const isMcpApprovalUserDecision = (value: unknown): value is McpApprovalUserDecision => {
  return typeof value === 'string' && MCP_APPROVAL_USER_DECISION_SET.has(value);
};

/**
 * MCP client identity captured from the protocol `initialize` handshake.
 */
export type McpClientInfo = {
  name: string;
  version: string;
};

/**
 * Pending authorization request rendered by the approval dialog.
 */
export type McpPendingApprovalPayload = {
  approvalId: string;
  kind: McpApprovalKind;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry; the request resolves to `timeout` afterwards. */
  expiresAt: string;
  client: McpClientInfo;
  /** Connection mode the approval will create or use. */
  connectionMode?: McpConnectionMode;
  /** Target fields are absent until the user selects a pane for `terminal-attach`. */
  serverId?: string;
  serverName?: string;
  host?: string;
  port?: number;
  username?: string;
  /** Agent-supplied intent shown to the user, when provided. */
  reason?: string;
  /** Full command text for `command-execute` approvals. */
  command?: string;
  /** Target connection for `command-execute` approvals. */
  connectionId?: string;
};

// ── Runtime summaries ────────────────────────────────────────

/**
 * How an MCP connection reaches the remote SSH runtime.
 */
export type McpConnectionMode = 'terminal' | 'background' | 'attached';

/**
 * Whether a connection can accept a new Agent command immediately.
 */
export type McpConnectionStatus = 'ready' | 'busy';

/**
 * Active agent-opened SSH connection summary.
 */
export type McpConnectionSummary = {
  connectionId: string;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  client: McpClientInfo;
  /** ISO-8601 timestamps. */
  openedAt: string;
  lastUsedAt: string;
  commandCount: number;
  /** True after the user granted `approvedForConnection`. */
  commandsPreApproved: boolean;
  mode: McpConnectionMode;
  status: McpConnectionStatus;
  userVisible: boolean;
  agentCreatedTab: boolean;
};

/**
 * Renderer-visible request to create a normal SSH tab for an approved Agent.
 */
export type McpPendingTerminalLaunch = {
  launchId: string;
  client: McpClientInfo;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  reason?: string;
  /** ISO-8601 timestamps. */
  createdAt: string;
  expiresAt: string;
};

/**
 * Active MCP protocol session summary.
 */
export type McpClientSessionSummary = {
  mcpSessionId: string;
  client: McpClientInfo;
  /** ISO-8601 timestamps. */
  startedAt: string;
  lastActivityAt: string;
};

/**
 * Renderer-facing MCP runtime status snapshot.
 */
export type McpRuntimeStatus = {
  enabled: boolean;
  tokenConfigured: boolean;
  activeClientCount: number;
  activeConnectionCount: number;
  pendingApprovalCount: number;
  pendingTerminalLaunchCount: number;
};

// ── Event channel (backend -> renderer WebSocket) ────────────

/**
 * Messages pushed to the renderer over the MCP events WebSocket.
 */
export type McpEventMessage =
  | { type: 'approval-requested'; approval: McpPendingApprovalPayload }
  | { type: 'approval-resolved'; approvalId: string; decision: McpApprovalDecision }
  | { type: 'connection-opened'; connection: McpConnectionSummary }
  | { type: 'connection-updated'; connection: McpConnectionSummary }
  | { type: 'connection-closed'; connectionId: string; reason: McpConnectionCloseReason }
  | { type: 'terminal-launch-requested'; launch: McpPendingTerminalLaunch }
  | { type: 'terminal-launch-resolved'; launchId: string }
  | { type: 'client-session-started'; session: McpClientSessionSummary }
  | { type: 'client-session-ended'; mcpSessionId: string }
  | { type: 'status-changed'; status: McpRuntimeStatus };

/**
 * Why an MCP SSH connection was closed.
 */
export type McpConnectionCloseReason =
  'tool' | 'ui' | 'idle' | 'shutdown' | 'error' | 'disabled' | 'client-disconnected' | 'detached';

/**
 * Parses one raw MCP event-channel frame.
 *
 * @param value Raw JSON-decoded frame.
 * @returns The event message, or null when the frame is not a known event.
 */
export const parseMcpEventMessage = (value: unknown): McpEventMessage | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { type?: unknown };
  switch (candidate.type) {
    case 'approval-requested':
    case 'approval-resolved':
    case 'connection-opened':
    case 'connection-updated':
    case 'connection-closed':
    case 'terminal-launch-requested':
    case 'terminal-launch-resolved':
    case 'client-session-started':
    case 'client-session-ended':
    case 'status-changed':
      return value as McpEventMessage;
    default:
      return null;
  }
};
