/**
 * MCP protocol session manager.
 *
 * Each connected agent gets its own {@link McpServer} bound to a stateful
 * {@link WebStandardStreamableHTTPServerTransport}. The transport owns the
 * `mcp-session-id` lifecycle; this manager maps that id to the server instance,
 * captures the client identity from the `initialize` handshake, and emits
 * session start/end events for the renderer and audit log. Requests are handled
 * with Web Standard `Request`/`Response` objects so the endpoint mounts directly
 * in Hono via `c.req.raw`.
 */

import { randomUUID } from 'node:crypto';

import type { McpClientInfo, McpClientSessionSummary } from '@cosmosh/api-contract';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { AuditEventService } from '../audit/service.js';
import { MCP_SERVER_NAME, MCP_SESSION_ID_HEADER } from './constants.js';
import { type McpToolRuntime, registerMcpTools } from './tools.js';
import { type McpClientSessionState, type McpClock, type McpEventEmitter, systemMcpClock } from './types.js';

const UNKNOWN_CLIENT: McpClientInfo = { name: 'unknown', version: '0.0.0' };

/**
 * Owns live MCP protocol sessions and routes streamable-HTTP requests.
 */
export class McpSessionManager {
  private readonly runtime: McpToolRuntime;

  private readonly emitEvent: McpEventEmitter;

  private readonly auditEventService: AuditEventService;

  private readonly appVersion: string;

  private readonly clock: McpClock;

  private readonly transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  private readonly servers = new Map<string, McpServer>();

  private readonly sessions = new Map<string, McpClientSessionState>();

  public constructor(options: {
    runtime: McpToolRuntime;
    emitEvent: McpEventEmitter;
    auditEventService: AuditEventService;
    appVersion: string;
    clock?: McpClock;
  }) {
    this.runtime = options.runtime;
    this.emitEvent = options.emitEvent;
    this.auditEventService = options.auditEventService;
    this.appVersion = options.appVersion;
    this.clock = options.clock ?? systemMcpClock;
  }

  /**
   * Handles one streamable-HTTP request, creating a session on initialize.
   *
   * @param request Web Standard request forwarded from Hono (`c.req.raw`).
   * @returns Web Standard response produced by the MCP transport.
   */
  public async handleRequest(request: Request): Promise<Response> {
    const sessionId = request.headers.get(MCP_SESSION_ID_HEADER) ?? undefined;
    if (sessionId) {
      const transport = this.transports.get(sessionId);
      if (!transport) {
        return jsonRpcError(-32001, 'Unknown or expired MCP session.', 404);
      }

      return await transport.handleRequest(request);
    }

    if (request.method !== 'POST') {
      return jsonRpcError(-32000, 'Missing MCP session id.', 400);
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.clone().json();
    } catch {
      return jsonRpcError(-32700, 'Malformed JSON-RPC request body.', 400);
    }

    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcError(-32000, 'A session must be established with an initialize request.', 400);
    }

    return await this.createSessionAndHandle(request, parsedBody);
  }

  /**
   * Lists active protocol sessions as renderer summaries (oldest first).
   *
   * @returns Client session summaries.
   */
  public listSessions(): McpClientSessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((session) => ({
        mcpSessionId: session.mcpSessionId,
        client: session.client,
        startedAt: session.startedAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      }));
  }

  /**
   * Number of active protocol sessions.
   *
   * @returns Active session count.
   */
  public count(): number {
    return this.sessions.size;
  }

  /**
   * Closes every session and disposes transports/servers during shutdown/disable.
   */
  public async closeAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.transports.clear();
    this.servers.clear();
    const endedSessionIds = [...this.sessions.keys()];
    this.sessions.clear();

    await Promise.all(
      entries.map(async ([, server]) => {
        try {
          await server.close();
        } catch {
          // Ignore close races during teardown.
        }
      }),
    );

    for (const mcpSessionId of endedSessionIds) {
      this.emitEvent({ type: 'client-session-ended', mcpSessionId });
    }
  }

  /**
   * Builds a fresh server+transport pair for an initialize request.
   *
   * @param request Original initialize request.
   * @param parsedBody Pre-parsed initialize body (avoids re-reading the stream).
   * @returns Initialization response from the transport.
   */
  private async createSessionAndHandle(request: Request, parsedBody: unknown): Promise<Response> {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: this.appVersion }, { capabilities: { tools: {} } });

    let sessionIdRef: string | null = null;
    const resolveClient = (): McpClientInfo => {
      const impl = server.server.getClientVersion();
      if (!impl) {
        return UNKNOWN_CLIENT;
      }

      return { name: impl.name, version: impl.version };
    };

    registerMcpTools(server, this.runtime, resolveClient);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
      onsessioninitialized: (sid) => {
        sessionIdRef = sid;
        this.transports.set(sid, transport);
        this.servers.set(sid, server);

        const now = new Date(this.clock.now());
        const client = resolveClient();
        const session: McpClientSessionState = {
          mcpSessionId: sid,
          client,
          startedAt: now,
          lastActivityAt: now,
        };
        this.sessions.set(sid, session);

        void this.auditEventService.logEvent({
          category: 'mcp',
          action: 'client-session-started',
          outcome: 'success',
          severity: 'info',
          entityType: 'mcp-session',
          entityId: sid,
          requestId: randomUUID(),
          metadata: { client: client.name, clientVersion: client.version },
        });
        this.emitEvent({
          type: 'client-session-started',
          session: {
            mcpSessionId: sid,
            client,
            startedAt: session.startedAt.toISOString(),
            lastActivityAt: session.lastActivityAt.toISOString(),
          },
        });
      },
    });

    transport.onclose = () => {
      const sid = sessionIdRef ?? transport.sessionId ?? null;
      if (sid) {
        this.disposeSession(sid);
      }
    };

    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody });
  }

  /**
   * Removes one session's bookkeeping and emits the ended event.
   *
   * @param mcpSessionId Session id.
   */
  private disposeSession(mcpSessionId: string): void {
    const existed = this.sessions.delete(mcpSessionId);
    this.transports.delete(mcpSessionId);
    this.servers.delete(mcpSessionId);

    if (!existed) {
      return;
    }

    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'client-session-ended',
      outcome: 'success',
      severity: 'info',
      entityType: 'mcp-session',
      entityId: mcpSessionId,
      requestId: randomUUID(),
      metadata: {},
    });
    this.emitEvent({ type: 'client-session-ended', mcpSessionId });
  }
}

/**
 * Builds a JSON-RPC error HTTP response for endpoint-level failures.
 *
 * @param code JSON-RPC error code.
 * @param message Human-readable error message.
 * @param status HTTP status code.
 * @returns Web Standard response.
 */
const jsonRpcError = (code: number, message: string, status: number): Response => {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
};
