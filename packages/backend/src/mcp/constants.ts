/**
 * Shared numeric bounds and identifiers for the Cosmosh MCP runtime.
 *
 * These constants intentionally mirror the discipline used by the SSH and
 * port-forward runtimes: every agent-reachable resource is capped so a
 * misbehaving or hostile client cannot exhaust local resources.
 */

/** Maximum number of concurrently open agent SSH connections. */
export const MCP_MAX_CONNECTIONS = 8;

/** Idle timeout after which an unused agent connection is closed. */
export const MCP_CONNECTION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Authorization prompt lifetime; expiry resolves the request as a timeout (deny). */
export const MCP_APPROVAL_TIMEOUT_MS = 120 * 1000;

/** Default per-command execution timeout when the agent does not specify one. */
export const MCP_DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/** Hard upper bound for a single agent command execution timeout. */
export const MCP_MAX_COMMAND_TIMEOUT_MS = 120_000;

/** Default combined stdout+stderr byte budget for one command. */
export const MCP_DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Hard upper bound for the combined stdout+stderr byte budget. */
export const MCP_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Maximum accepted command string length in bytes. */
export const MCP_MAX_COMMAND_BYTES = 8 * 1024;

/** Connection establishment timeout (seconds) for agent-opened SSH clients. */
export const MCP_CONNECT_TIMEOUT_SEC = 45;

/** WebSocket path prefix for the renderer authorization event channel. */
export const MCP_EVENTS_PATH_PREFIX = '/mcp-events/';

/** Time a freshly created event channel waits for the renderer socket to attach. */
export const MCP_EVENTS_ATTACH_TIMEOUT_MS = 30_000;

/** Discovery file schema version. */
export const MCP_DISCOVERY_FILE_VERSION = 1;

/** Discovery file name written under `<userData>/mcp/`. */
export const MCP_DISCOVERY_FILE_NAME = 'bridge.json';

/** Advertised MCP server implementation name. */
export const MCP_SERVER_NAME = 'cosmosh-mcp';

/** HTTP header carrying the MCP protocol session id. */
export const MCP_SESSION_ID_HEADER = 'mcp-session-id';
