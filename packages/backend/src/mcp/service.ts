/**
 * Cosmosh MCP service facade.
 *
 * Owns the full MCP runtime: pairing/discovery, the approval broker, the SSH
 * connection registry, the renderer event channel, and the protocol session
 * manager. It is gated by the `mcpEnabled` setting (default off) — while
 * disabled it binds no event socket, writes no discovery file, and rejects the
 * `/mcp` endpoint with 503. It also implements {@link McpToolRuntime}, enforcing
 * the connection-open (always) and command-execute (policy-driven) authorization
 * gates and auditing every privileged action.
 */

import { randomUUID } from 'node:crypto';

import {
  type McpApprovalDecision,
  type McpApprovalUserDecision,
  type McpClientInfo,
  type McpCommandPolicy,
  type McpConnectionSummary,
  type McpEventMessage,
  type McpPendingApprovalPayload,
  type McpRuntimeStatus,
  resolveEffectiveMcpCommandPolicy,
} from '@cosmosh/api-contract';
import type { PrismaClient } from '@prisma/client';

import type { AuditEventService } from '../audit/service.js';
import { readDefaultSettingsValues } from '../settings/read.js';
import { serverQueryInclude } from '../ssh/mappers.js';
import { McpApprovalBroker } from './approval-broker.js';
import { McpConnectionRegistry } from './connection-registry.js';
import { MCP_MAX_COMMAND_BYTES } from './constants.js';
import { type McpEventsChannelHandle, McpEventsService } from './events-service.js';
import { executeMcpSshCommand } from './exec.js';
import type { McpPairingService } from './pairing.js';
import { McpSessionManager } from './sessions.js';
import type {
  McpCloseConnectionOutcome,
  McpOpenConnectionOutcome,
  McpRunCommandOutcome,
  McpServerListEntry,
  McpToolRuntime,
} from './tools.js';

type GetDbClient = () => PrismaClient;

/**
 * Result of resolving one pending approval from the REST layer.
 */
export type McpResolveApprovalResult = 'resolved' | 'not-found';

/**
 * Facade coordinating the MCP runtime and its authorization gates.
 */
export class McpService implements McpToolRuntime {
  private readonly getDbClient: GetDbClient;

  private readonly auditEventService: AuditEventService;

  private readonly credentialEncryptionKey: Buffer;

  private readonly pairingService: McpPairingService;

  private readonly httpPort: number;

  private readonly eventsHost: string;

  private readonly eventsPort: number;

  private readonly appVersion: string;

  private readonly bridgeLauncherPath: string | undefined;

  private readonly broker: McpApprovalBroker;

  private readonly registry: McpConnectionRegistry;

  private readonly sessionManager: McpSessionManager;

  private eventsService: McpEventsService | null = null;

  private enabled = false;

  public constructor(options: {
    getDbClient: GetDbClient;
    auditEventService: AuditEventService;
    credentialEncryptionKey: Buffer;
    pairingService: McpPairingService;
    httpPort: number;
    eventsHost: string;
    eventsPort: number;
    appVersion: string;
    bridgeLauncherPath?: string;
  }) {
    this.getDbClient = options.getDbClient;
    this.auditEventService = options.auditEventService;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
    this.pairingService = options.pairingService;
    this.httpPort = options.httpPort;
    this.eventsHost = options.eventsHost;
    this.eventsPort = options.eventsPort;
    this.appVersion = options.appVersion;
    this.bridgeLauncherPath = options.bridgeLauncherPath;

    this.broker = new McpApprovalBroker({
      hooks: {
        onRequested: (payload) => {
          this.emit({ type: 'approval-requested', approval: payload });
          this.auditApproval('authorization-requested', payload);
        },
        onResolved: (payload, decision) => {
          this.emit({ type: 'approval-resolved', approvalId: payload.approvalId, decision });
          this.auditApproval('authorization-resolved', payload, decision);
          this.emitStatus();
        },
      },
    });

    this.registry = new McpConnectionRegistry({
      getDbClient: this.getDbClient,
      auditEventService: this.auditEventService,
      credentialEncryptionKey: this.credentialEncryptionKey,
      emitEvent: (message) => this.emit(message),
    });

    this.sessionManager = new McpSessionManager({
      runtime: this,
      emitEvent: (message) => this.emit(message),
      auditEventService: this.auditEventService,
      appVersion: this.appVersion,
      httpPort: this.httpPort,
      onSessionEnded: async (mcpSessionId) => {
        await this.registry.closeOwnedBySession(mcpSessionId);
        this.emitStatus();
      },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Applies the persisted `mcpEnabled` setting on backend startup.
   */
  public async start(): Promise<void> {
    const settings = await readDefaultSettingsValues(this.getDbClient());
    await this.applyEnabled(settings.mcpEnabled === true);
  }

  /**
   * Re-reads the `mcpEnabled` setting and applies any enable/disable transition.
   */
  public async refreshEnabledState(): Promise<void> {
    const settings = await readDefaultSettingsValues(this.getDbClient());
    await this.applyEnabled(settings.mcpEnabled === true);
  }

  /**
   * Tears the runtime down during backend shutdown.
   */
  public async stop(): Promise<void> {
    await this.applyEnabled(false, 'shutdown');
  }

  /**
   * Whether the MCP endpoint is currently enabled.
   *
   * @returns True when enabled.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  // ── Endpoint ───────────────────────────────────────────────

  /**
   * Validates a bridge Bearer token against the active pairing token.
   *
   * @param token Presented bearer token.
   * @returns True when the token is valid.
   */
  public async validateBearer(token: string | undefined): Promise<boolean> {
    return await this.pairingService.validateBearer(token);
  }

  /**
   * Routes one `/mcp` streamable-HTTP request to the session manager.
   *
   * @param request Web Standard request (`c.req.raw`).
   * @returns Web Standard response.
   */
  public async handleRequest(request: Request): Promise<Response> {
    return await this.sessionManager.handleRequest(request);
  }

  // ── Management (REST) ──────────────────────────────────────

  /**
   * Builds the renderer-facing runtime status snapshot.
   *
   * @returns MCP runtime status with discovery metadata.
   */
  public async getStatus(): Promise<McpRuntimeStatus & { discoveryFilePath?: string; bridgeLauncherPath?: string }> {
    return {
      enabled: this.enabled,
      tokenConfigured: await this.pairingService.hasToken(),
      discoveryFilePath: this.pairingService.getDiscoveryFilePath(),
      bridgeLauncherPath: this.bridgeLauncherPath,
      activeClientCount: this.sessionManager.count(),
      activeConnectionCount: this.registry.count(),
      pendingApprovalCount: this.broker.pendingCount(),
    };
  }

  /**
   * Whether an active pairing token currently exists.
   *
   * @returns True when a token is configured.
   */
  public async hasPairingToken(): Promise<boolean> {
    return await this.pairingService.hasToken();
  }

  /**
   * Rotates the pairing token and rewrites the discovery file when enabled.
   *
   * @param requestId Correlating request id.
   * @returns Newly minted token plaintext and its creation time.
   */
  public async rotatePairingToken(requestId: string): Promise<{ token: string; createdAt: string }> {
    const token = await this.pairingService.rotateToken();
    if (this.enabled) {
      await this.pairingService.writeDiscoveryFile(this.httpPort);
    }

    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'pairing-token-generated',
      outcome: 'success',
      severity: 'warning',
      entityType: 'mcp-pairing-token',
      entityId: token.id,
      requestId,
      metadata: {},
    });
    this.emitStatus();

    return { token: token.plaintext, createdAt: token.createdAt.toISOString() };
  }

  /**
   * Revokes the active pairing token and removes the discovery file.
   *
   * @param requestId Correlating request id.
   */
  public async revokePairingToken(requestId: string): Promise<void> {
    await this.pairingService.revokeToken();
    await this.pairingService.removeDiscoveryFile();

    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'pairing-token-revoked',
      outcome: 'success',
      severity: 'warning',
      entityType: 'mcp-pairing-token',
      requestId,
      metadata: {},
    });
    this.emitStatus();
  }

  /**
   * Lists active protocol sessions.
   *
   * @returns Client session summaries.
   */
  public listClients(): ReturnType<McpSessionManager['listSessions']> {
    return this.sessionManager.listSessions();
  }

  /**
   * Lists pending authorization prompts.
   *
   * @returns Pending approval payloads.
   */
  public listApprovals(): McpPendingApprovalPayload[] {
    return this.broker.list();
  }

  /**
   * Applies one renderer-submitted authorization decision.
   *
   * @param approvalId Pending approval id.
   * @param decision User decision.
   * @returns Whether a pending approval matched.
   */
  public resolveApproval(approvalId: string, decision: McpApprovalUserDecision): McpResolveApprovalResult {
    return this.broker.resolve(approvalId, decision) ? 'resolved' : 'not-found';
  }

  /**
   * Closes one connection from the management UI.
   *
   * @param connectionId Connection id.
   * @param requestId Correlating request id.
   * @returns Whether a live connection was closed.
   */
  public async closeConnectionFromUi(connectionId: string, requestId: string): Promise<boolean> {
    return await this.registry.close(connectionId, 'ui', requestId);
  }

  /**
   * Lists live agent connections.
   *
   * @returns Connection summaries.
   */
  public listConnectionSummaries(): McpConnectionSummary[] {
    return this.registry.list();
  }

  /**
   * Creates one renderer authorization event channel.
   *
   * @returns WebSocket URL and one-time token, or null when disabled.
   */
  public createEventsChannel(): McpEventsChannelHandle | null {
    return this.eventsService?.createChannel() ?? null;
  }

  // ── McpToolRuntime ─────────────────────────────────────────

  /**
   * Lists connectable servers as non-sensitive descriptors.
   */
  public async listServers(input: {
    query?: string;
    mcpSessionId: string;
    client: McpClientInfo;
    signal: AbortSignal;
  }): Promise<McpServerListEntry[]> {
    const settings = await readDefaultSettingsValues(this.getDbClient());
    const globalPolicy: McpCommandPolicy = settings.mcpCommandPolicy;
    const servers = await this.getDbClient().sshServer.findMany({
      include: serverQueryInclude,
      orderBy: { name: 'asc' },
    });

    const query = input.query?.trim().toLowerCase();
    const entries = servers
      .filter((server) => {
        if (!query) {
          return true;
        }

        return (
          server.name.toLowerCase().includes(query) ||
          server.host.toLowerCase().includes(query) ||
          server.username.toLowerCase().includes(query)
        );
      })
      .map((server) => ({
        serverId: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        commandPolicy: resolveEffectiveMcpCommandPolicy(
          isServerCommandPolicy(server.mcpCommandPolicy) ? server.mcpCommandPolicy : 'default',
          globalPolicy,
        ),
        folder: server.folder?.name ?? undefined,
        tags: server.tags.map((entry) => entry.tag.name),
        note: server.note ?? undefined,
      }));

    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'list-servers',
      outcome: 'success',
      severity: 'info',
      entityType: 'mcp-session',
      requestId: randomUUID(),
      metadata: { client: input.client.name, count: entries.length, query: input.query },
    });

    return entries;
  }

  /**
   * Authorizes and opens one connection (connection-open is always prompted).
   */
  public async openConnection(input: {
    serverId: string;
    reason?: string;
    mcpSessionId: string;
    client: McpClientInfo;
    signal: AbortSignal;
  }): Promise<McpOpenConnectionOutcome> {
    const server = await this.getDbClient().sshServer.findUnique({
      where: { id: input.serverId },
      select: { id: true, name: true, host: true, port: true, username: true },
    });

    if (!server) {
      return { ok: false, reason: 'server-not-found', message: 'Server not found.' };
    }

    const ticket = this.broker.request({
      kind: 'connection-open',
      client: input.client,
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      reason: input.reason,
    });

    const decision = await ticket.decision;
    if (decision !== 'approved' && decision !== 'approvedForConnection') {
      return { ok: false, reason: mapDenyReason(decision), message: denyMessage(decision) };
    }

    const requestId = randomUUID();
    const result = await this.registry.open({
      serverId: server.id,
      ownerSessionId: input.mcpSessionId,
      client: input.client,
      reason: input.reason,
      requestId,
    });

    switch (result.type) {
      case 'success':
        if (decision === 'approvedForConnection') {
          this.registry.markPreApproved(result.summary.connectionId);
        }

        this.emitStatus();
        return { ok: true, connection: result.summary };
      case 'server-not-found':
        return { ok: false, reason: 'server-not-found', message: 'Server not found.' };
      case 'limit-reached':
        return {
          ok: false,
          reason: 'limit-reached',
          message: `Too many open connections (max ${result.limit}). Close one and retry.`,
        };
      case 'host-untrusted':
        return {
          ok: false,
          reason: 'host-untrusted',
          message:
            'Host key is not trusted. Connect to this server once in the Cosmosh window to trust its host key, then retry.',
        };
      default:
        return { ok: false, reason: 'failed', message: result.message };
    }
  }

  /**
   * Lists live connections for the `list_connections` tool.
   */
  public listConnections(input: { mcpSessionId: string; client: McpClientInfo }): McpConnectionSummary[] {
    return this.registry.listOwned(input.mcpSessionId);
  }

  /**
   * Authorizes (per policy) and runs one bounded command.
   */
  public async runCommand(input: {
    connectionId: string;
    command: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    mcpSessionId: string;
    client: McpClientInfo;
    signal: AbortSignal;
  }): Promise<McpRunCommandOutcome> {
    const state = this.registry.getOwned(input.connectionId, input.mcpSessionId);
    if (!state) {
      return { ok: false, reason: 'connection-not-found', message: 'Connection not found or already closed.' };
    }

    if (Buffer.byteLength(input.command, 'utf8') > MCP_MAX_COMMAND_BYTES) {
      return {
        ok: false,
        reason: 'command-too-large',
        message: `Command exceeds the ${MCP_MAX_COMMAND_BYTES}-byte limit.`,
      };
    }

    const settings = await readDefaultSettingsValues(this.getDbClient());
    const globalPolicy: McpCommandPolicy = settings.mcpCommandPolicy;
    const policy = resolveEffectiveMcpCommandPolicy(state.serverCommandPolicy, globalPolicy);

    if (policy === 'off') {
      void this.auditEventService.logEvent({
        category: 'mcp',
        action: 'command-execute',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'mcp-connection',
        entityId: state.connectionId,
        requestId: randomUUID(),
        metadata: { serverId: state.serverId, client: input.client.name, reason: 'policy-off' },
      });
      return {
        ok: false,
        reason: 'policy-off',
        message: 'Command execution is disabled for this server by policy.',
      };
    }

    const needsPrompt = !(policy === 'allowWithinConnection' && state.commandsPreApproved);
    if (needsPrompt) {
      const ticket = this.broker.request({
        kind: 'command-execute',
        client: input.client,
        serverId: state.serverId,
        serverName: state.serverName,
        host: state.host,
        port: state.port,
        username: state.username,
        command: input.command,
        connectionId: state.connectionId,
      });

      const decision = await ticket.decision;
      if (decision !== 'approved' && decision !== 'approvedForConnection') {
        void this.auditEventService.logEvent({
          category: 'mcp',
          action: 'command-execute',
          outcome: 'failure',
          severity: 'warning',
          entityType: 'mcp-connection',
          entityId: state.connectionId,
          requestId: randomUUID(),
          metadata: { serverId: state.serverId, client: input.client.name, reason: decision },
        });
        return { ok: false, reason: mapDenyReason(decision), message: denyMessage(decision) };
      }

      if (decision === 'approvedForConnection') {
        this.registry.markPreApproved(state.connectionId);
      }
    }

    const result = await executeMcpSshCommand(state.client, input.command, {
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
    });
    this.registry.touch(state.connectionId);

    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'command-execute',
      outcome: 'success',
      severity: 'warning',
      entityType: 'mcp-connection',
      entityId: state.connectionId,
      requestId: randomUUID(),
      metadata: {
        serverId: state.serverId,
        client: input.client.name,
        command: input.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
        policy,
      },
    });
    this.emitStatus();

    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      truncated: result.truncated,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
  }

  /**
   * Closes one connection from the `close_connection` tool.
   */
  public async closeConnection(input: {
    connectionId: string;
    mcpSessionId: string;
    client: McpClientInfo;
  }): Promise<McpCloseConnectionOutcome> {
    const closed = await this.registry.closeOwned(input.connectionId, input.mcpSessionId, 'tool');
    if (!closed) {
      return { ok: false, reason: 'connection-not-found', message: 'Connection not found or already closed.' };
    }

    this.emitStatus();
    return { ok: true };
  }

  // ── Internals ──────────────────────────────────────────────

  /**
   * Applies one enable/disable transition, idempotently.
   *
   * @param next Desired enabled state.
   * @param disableReason Connection close reason used when disabling.
   */
  private async applyEnabled(next: boolean, disableReason: 'disabled' | 'shutdown' = 'disabled'): Promise<void> {
    if (next === this.enabled) {
      return;
    }

    if (next) {
      await this.pairingService.ensureToken();
      this.eventsService = new McpEventsService({ host: this.eventsHost, port: this.eventsPort });
      await this.pairingService.writeDiscoveryFile(this.httpPort);
      this.enabled = true;
      this.emitStatus();
      return;
    }

    this.enabled = false;
    this.emitStatus();
    this.broker.denyAll('superseded');
    await this.sessionManager.closeAll();
    await this.registry.closeAll(disableReason);
    await this.pairingService.removeDiscoveryFile();
    if (this.eventsService) {
      await this.eventsService.stop();
      this.eventsService = null;
    }
  }

  /**
   * Broadcasts one event to the renderer channel when enabled.
   *
   * @param message Event message.
   */
  private emit(message: McpEventMessage): void {
    this.eventsService?.broadcast(message);
  }

  /**
   * Broadcasts a status-changed event reflecting current counters.
   */
  private emitStatus(): void {
    if (!this.eventsService) {
      return;
    }

    this.eventsService.broadcast({
      type: 'status-changed',
      status: {
        enabled: this.enabled,
        tokenConfigured: true,
        activeClientCount: this.sessionManager.count(),
        activeConnectionCount: this.registry.count(),
        pendingApprovalCount: this.broker.pendingCount(),
      },
    });
  }

  /**
   * Audits one authorization lifecycle transition.
   *
   * @param action Audit action name.
   * @param payload Approval payload.
   * @param decision Optional terminal decision (for resolved events).
   */
  private auditApproval(
    action: 'authorization-requested' | 'authorization-resolved',
    payload: McpPendingApprovalPayload,
    decision?: McpApprovalDecision,
  ): void {
    void this.auditEventService.logEvent({
      category: 'mcp',
      action,
      outcome: 'success',
      severity: 'info',
      entityType: 'mcp-approval',
      entityId: payload.approvalId,
      requestId: randomUUID(),
      metadata: {
        kind: payload.kind,
        client: payload.client.name,
        serverId: payload.serverId,
        host: payload.host,
        connectionId: payload.connectionId,
        command: payload.command,
        reason: payload.reason,
        decision,
      },
    });
  }
}

/**
 * Maps a non-approval terminal decision to a tool error reason.
 *
 * @param decision Terminal decision.
 * @returns Tool error reason.
 */
const mapDenyReason = (decision: McpApprovalDecision): 'denied' | 'timeout' => {
  return decision === 'timeout' ? 'timeout' : 'denied';
};

/**
 * Builds an agent-facing message for a non-approval decision.
 *
 * @param decision Terminal decision.
 * @returns Human-readable message.
 */
const denyMessage = (decision: McpApprovalDecision): string => {
  switch (decision) {
    case 'timeout':
      return 'Authorization request timed out. The user did not respond in the Cosmosh window.';
    case 'superseded':
      return 'Authorization request was superseded (MCP was disabled or the runtime restarted).';
    default:
      return 'The user denied this request in the Cosmosh window.';
  }
};

/**
 * Narrows a raw persisted per-server policy value.
 *
 * @param value Raw column value.
 * @returns True when the value is a supported per-server policy.
 */
const isServerCommandPolicy = (value: string): value is 'default' | 'off' | 'ask' | 'allowWithinConnection' => {
  return value === 'default' || value === 'off' || value === 'ask' || value === 'allowWithinConnection';
};
