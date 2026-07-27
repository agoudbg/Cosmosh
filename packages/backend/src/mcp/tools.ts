/**
 * MCP tool registration for one protocol session.
 *
 * Tools are intentionally thin: schema validation and response shaping live
 * here, while every privileged action (authorization prompt, SSH open/exec,
 * policy resolution, audit) is delegated to the injected {@link McpToolRuntime}
 * implemented by {@link McpService}. Each registered tool closes over the
 * session's client identity so authorization prompts and audit records always
 * attribute the acting agent.
 */

import type { McpClientInfo, McpCommandPolicy, McpConnectionSummary } from '@cosmosh/api-contract';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { MCP_MAX_COMMAND_BYTES, MCP_MAX_COMMAND_TIMEOUT_MS, MCP_MAX_OUTPUT_BYTES } from './constants.js';

/**
 * Non-sensitive server descriptor returned by `list_servers`.
 */
export type McpServerListEntry = {
  serverId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** Effective command policy after applying the per-server override. */
  commandPolicy: McpCommandPolicy;
  folder?: string;
  tags: string[];
  note?: string;
};

/**
 * Outcome of an `open_connection` tool call.
 */
export type McpOpenConnectionOutcome =
  | { ok: true; connection: McpConnectionSummary }
  | {
      ok: false;
      reason: 'denied' | 'timeout' | 'server-not-found' | 'host-untrusted' | 'limit-reached' | 'failed';
      message: string;
    };

/**
 * Outcome of a `run_command` tool call.
 */
export type McpRunCommandOutcome =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      exitSignal: string | null;
      truncated: boolean;
      timedOut: boolean;
      durationMs: number;
    }
  | {
      ok: false;
      reason: 'denied' | 'timeout' | 'policy-off' | 'connection-not-found' | 'command-too-large' | 'failed';
      message: string;
    };

/**
 * Outcome of a `close_connection` tool call.
 */
export type McpCloseConnectionOutcome = { ok: true } | { ok: false; reason: 'connection-not-found'; message: string };

/**
 * Authenticated protocol-session context for one tool invocation.
 */
export type McpToolCaller = {
  mcpSessionId: string;
  client: McpClientInfo;
};

/**
 * High-level operations the tools delegate to. Implemented by {@link McpService}.
 */
export type McpToolRuntime = {
  listServers(input: McpToolCaller & { query?: string; signal: AbortSignal }): Promise<McpServerListEntry[]>;
  openConnection(
    input: {
      serverId: string;
      reason?: string;
      signal: AbortSignal;
    } & McpToolCaller,
  ): Promise<McpOpenConnectionOutcome>;
  listConnections(input: McpToolCaller): McpConnectionSummary[];
  runCommand(
    input: {
      connectionId: string;
      command: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
      signal: AbortSignal;
    } & McpToolCaller,
  ): Promise<McpRunCommandOutcome>;
  closeConnection(input: McpToolCaller & { connectionId: string }): Promise<McpCloseConnectionOutcome>;
};

type ToolTextResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Builds a JSON tool result, marking errors so agents can branch on failure.
 *
 * @param payload Structured payload serialized for the agent.
 * @param isError Whether the call failed.
 * @returns MCP tool result.
 */
const jsonResult = (payload: Record<string, unknown>, isError = false): ToolTextResult => {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
  };
};

/**
 * Registers the Cosmosh MCP tool surface on one protocol session's server.
 *
 * @param server Per-session MCP server instance.
 * @param runtime Privileged operation runtime.
 * @param resolveCaller Lazily resolves the authenticated session and client identity.
 */
export const registerMcpTools = (
  server: McpServer,
  runtime: McpToolRuntime,
  resolveCaller: () => McpToolCaller,
): void => {
  server.registerTool(
    'list_servers',
    {
      title: 'List SSH servers',
      description:
        'List the SSH servers configured in Cosmosh that this agent may connect to. Never returns credentials. Use the returned serverId with open_connection.',
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe('Optional case-insensitive filter over server name, host, or username.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      const caller = resolveCaller();
      const servers = await runtime.listServers({
        query: args.query,
        signal: extra.signal,
        ...caller,
      });
      return jsonResult({ servers, count: servers.length });
    },
  );

  server.registerTool(
    'open_connection',
    {
      title: 'Open SSH connection',
      description:
        'Request a new SSH connection to a Cosmosh server. The user must explicitly authorize every connection in the Cosmosh window; a denied or timed-out request returns an error — do not retry aggressively. Provide a short reason describing why the connection is needed.',
      inputSchema: {
        serverId: z.string().min(1).describe('Server id from list_servers.'),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe('Short human-readable intent shown in the authorization prompt.'),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const caller = resolveCaller();
      const outcome = await runtime.openConnection({
        serverId: args.serverId,
        reason: args.reason,
        signal: extra.signal,
        ...caller,
      });

      if (!outcome.ok) {
        return jsonResult({ error: outcome.reason, message: outcome.message }, true);
      }

      return jsonResult({ connection: outcome.connection });
    },
  );

  server.registerTool(
    'list_connections',
    {
      title: 'List open connections',
      description:
        'List the SSH connections currently open for agents. Reuse an existing connectionId with run_command instead of opening a new connection when possible.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const connections = runtime.listConnections(resolveCaller());
      return jsonResult({ connections, count: connections.length });
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run command',
      description:
        'Run one non-interactive command on an open SSH connection. Depending on the configured policy the user may need to approve each command. Output is byte-bounded and may be truncated; always inspect exitCode and stderr. Do not run interactive programs (editors, pagers, prompts).',
      inputSchema: {
        connectionId: z.string().min(1).describe('Connection id from open_connection or list_connections.'),
        command: z.string().min(1).max(MCP_MAX_COMMAND_BYTES).describe('Non-interactive shell command to execute.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MCP_MAX_COMMAND_TIMEOUT_MS)
          .optional()
          .describe(`Optional command timeout in milliseconds (max ${MCP_MAX_COMMAND_TIMEOUT_MS}).`),
        maxOutputBytes: z
          .number()
          .int()
          .positive()
          .max(MCP_MAX_OUTPUT_BYTES)
          .optional()
          .describe(`Optional combined stdout+stderr byte cap (max ${MCP_MAX_OUTPUT_BYTES}).`),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const caller = resolveCaller();
      const outcome = await runtime.runCommand({
        connectionId: args.connectionId,
        command: args.command,
        timeoutMs: args.timeoutMs,
        maxOutputBytes: args.maxOutputBytes,
        signal: extra.signal,
        ...caller,
      });

      if (!outcome.ok) {
        return jsonResult({ error: outcome.reason, message: outcome.message }, true);
      }

      return jsonResult({
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        exitSignal: outcome.exitSignal,
        truncated: outcome.truncated,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
      });
    },
  );

  server.registerTool(
    'close_connection',
    {
      title: 'Close SSH connection',
      description: 'Close an open SSH connection when finished. Closing does not require user authorization.',
      inputSchema: {
        connectionId: z.string().min(1).describe('Connection id to close.'),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const caller = resolveCaller();
      const outcome = await runtime.closeConnection({
        connectionId: args.connectionId,
        ...caller,
      });

      if (!outcome.ok) {
        return jsonResult({ error: outcome.reason, message: outcome.message }, true);
      }

      return jsonResult({ closed: true, connectionId: args.connectionId });
    },
  );
};
