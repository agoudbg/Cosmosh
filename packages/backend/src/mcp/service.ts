/**
 * Cosmosh MCP service facade.
 *
 * Owns the full MCP runtime: pairing/discovery, the approval broker, the SSH
 * connection registry, the renderer event channel, and the protocol session
 * manager. It is gated by the `mcpEnabled` setting (default off) — while
 * disabled it binds no event socket, writes no discovery file, and rejects the
 * `/mcp` endpoint with 503. It also implements {@link McpToolRuntime}, enforcing
 * the server-list (setting-driven), connection-open (always), and
 * command-execute (policy-driven) authorization gates and auditing every
 * privileged action.
 */

import { randomUUID } from 'node:crypto';

import {
  type McpApprovalDecision,
  type McpApprovalUserDecision,
  type McpClientInfo,
  type McpCommandPolicy,
  type McpConnectionMode,
  type McpConnectionSummary,
  type McpEventMessage,
  type McpPendingApprovalPayload,
  type McpPendingTerminalLaunch,
  type McpRuntimeStatus,
  resolveEffectiveMcpCommandPolicy,
} from '@cosmosh/api-contract';
import type { PrismaClient } from '@prisma/client';

import type { AuditEventService } from '../audit/service.js';
import { readDefaultSettingsValues } from '../settings/read.js';
import { serverQueryInclude } from '../ssh/mappers.js';
import type { SshSessionService } from '../ssh/session-service.js';
import { McpApprovalBroker, type McpApprovalTicket } from './approval-broker.js';
import { McpConnectionCapacity } from './connection-capacity.js';
import {
  matchesApprovedTarget,
  type McpApprovedServerTarget,
  McpConnectionRegistry,
  type McpOpenSshClient,
} from './connection-registry.js';
import { MCP_DEFAULT_COMMAND_TIMEOUT_MS, MCP_DEFAULT_MAX_OUTPUT_BYTES, MCP_MAX_COMMAND_BYTES } from './constants.js';
import { type McpEventsChannelHandle, McpEventsService } from './events-service.js';
import { executeMcpSshCommand } from './exec.js';
import type { McpPairingService } from './pairing.js';
import { McpSessionManager } from './sessions.js';
import { McpTerminalLaunchBroker } from './terminal-launch-broker.js';
import type {
  McpAttachTerminalOutcome,
  McpCloseConnectionOutcome,
  McpListServersOutcome,
  McpOpenConnectionOutcome,
  McpRunCommandOutcome,
  McpToolRuntime,
} from './tools.js';
import type { McpApprovalRequestInput } from './types.js';

type GetDbClient = () => PrismaClient;

/**
 * Result of resolving one pending approval from the REST layer.
 */
export type McpResolveApprovalResult =
  | 'resolved'
  | 'not-found'
  | 'audit-unavailable'
  | 'terminal-not-found'
  | 'terminal-busy'
  | 'terminal-not-ready'
  | 'terminal-automation-unavailable';

/**
 * Result of binding a renderer-created SSH session to a pending launch.
 */
export type McpBindTerminalLaunchResult =
  | { type: 'success'; connection: McpConnectionSummary }
  | { type: 'launch-not-found' }
  | { type: 'server-changed' }
  | { type: 'terminal-not-found' }
  | { type: 'terminal-busy' }
  | { type: 'terminal-not-ready' }
  | { type: 'terminal-automation-unavailable' };

const MCP_AUDIT_UNAVAILABLE_MESSAGE =
  'The authorization request could not be recorded in the Cosmosh audit log. No remote action was performed.';
const MCP_LIST_SERVERS_AUDIT_UNAVAILABLE_MESSAGE =
  'The authorization request could not be recorded in the Cosmosh audit log. No server information was returned.';

/**
 * Facade coordinating the MCP runtime and its authorization gates.
 */
export class McpService implements McpToolRuntime {
  private readonly getDbClient: GetDbClient;

  private readonly auditEventService: AuditEventService;

  private readonly credentialEncryptionKey: Buffer;

  private readonly pairingService: McpPairingService;

  private readonly sshSessionService: SshSessionService;

  private readonly httpPort: number;

  private readonly eventsHost: string;

  private readonly eventsPort: number;

  private readonly appVersion: string;

  private readonly bridgeLauncherPath: string | undefined;

  private readonly broker: McpApprovalBroker;

  private readonly registry: McpConnectionRegistry;

  private readonly capacity: McpConnectionCapacity;

  private readonly terminalLaunchBroker: McpTerminalLaunchBroker;

  private readonly sessionManager: McpSessionManager;

  private eventsService: McpEventsService | null = null;

  private readonly approvalTerminalSelections = new Map<
    string,
    { terminalSessionId: string; approvedTarget: McpApprovedServerTarget }
  >();

  private enabled = false;

  public constructor(options: {
    getDbClient: GetDbClient;
    auditEventService: AuditEventService;
    credentialEncryptionKey: Buffer;
    pairingService: McpPairingService;
    sshSessionService: SshSessionService;
    httpPort: number;
    eventsHost: string;
    eventsPort: number;
    appVersion: string;
    bridgeLauncherPath?: string;
    openClient?: McpOpenSshClient;
  }) {
    this.getDbClient = options.getDbClient;
    this.auditEventService = options.auditEventService;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
    this.pairingService = options.pairingService;
    this.sshSessionService = options.sshSessionService;
    this.httpPort = options.httpPort;
    this.eventsHost = options.eventsHost;
    this.eventsPort = options.eventsPort;
    this.appVersion = options.appVersion;
    this.bridgeLauncherPath = options.bridgeLauncherPath;

    this.broker = new McpApprovalBroker({
      hooks: {
        onResolved: (payload, decision) => {
          this.emit({ type: 'approval-resolved', approvalId: payload.approvalId, decision });
          if (decision === 'timeout' || decision === 'superseded') {
            this.auditApproval('authorization-resolved', payload, decision);
          }
          this.emitStatus();
        },
      },
    });

    this.capacity = new McpConnectionCapacity();
    this.registry = new McpConnectionRegistry({
      getDbClient: this.getDbClient,
      auditEventService: this.auditEventService,
      credentialEncryptionKey: this.credentialEncryptionKey,
      emitEvent: (message) => this.emit(message),
      openClient: options.openClient,
      capacity: this.capacity,
      onTerminalConnectionClose: (state, reason) => {
        const shouldCloseCreatedTerminal = state.mode === 'terminal' && (reason === 'tool' || reason === 'ui');
        if (shouldCloseCreatedTerminal) {
          this.sshSessionService.closeSession(state.terminalSessionId);
          return;
        }

        this.sshSessionService.detachAgentTerminal(state.connectionId);
      },
    });

    this.terminalLaunchBroker = new McpTerminalLaunchBroker({
      onRequested: (launch) => {
        this.emit({ type: 'terminal-launch-requested', launch });
        this.emitStatus();
      },
      onResolved: (launchId) => {
        this.emit({ type: 'terminal-launch-resolved', launchId });
        this.emitStatus();
      },
    });

    this.sshSessionService.onAgentTerminalClosed((sessionId) => {
      void this.registry.closeByTerminalSession(sessionId).finally(() => this.emitStatus());
    });
    this.sshSessionService.onAgentTerminalStatusChanged((sessionId, status) => {
      if (!status.connectionId) {
        return;
      }

      if (status.state === 'detached') {
        void this.registry.close(status.connectionId, 'detached').finally(() => this.emitStatus());
        return;
      }

      const snapshot = this.sshSessionService.getAgentTerminalSession(sessionId);
      this.registry.updateStatus(status.connectionId, snapshot?.atPrompt && !snapshot.busy ? 'ready' : 'busy');
    });

    this.sessionManager = new McpSessionManager({
      runtime: this,
      emitEvent: (message) => this.emit(message),
      auditEventService: this.auditEventService,
      appVersion: this.appVersion,
      httpPort: this.httpPort,
      onSessionEnded: async (mcpSessionId) => {
        this.terminalLaunchBroker.cancelOwnedBySession(mcpSessionId);
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
      pendingTerminalLaunchCount: this.terminalLaunchBroker.count(),
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
    this.broker.denyAll('superseded');
    this.terminalLaunchBroker.cancelAll();
    await this.sessionManager.closeAll();
    await this.registry.closeAll('client-disconnected');

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
  public async resolveApproval(
    approvalId: string,
    decision: McpApprovalUserDecision,
    terminalSessionId?: string,
  ): Promise<McpResolveApprovalResult> {
    const payload = this.broker.getPending(approvalId);
    if (!payload) {
      return 'not-found';
    }

    let auditedPayload = payload;
    if (payload.kind === 'terminal-attach' && decision !== 'denied') {
      if (!terminalSessionId) {
        return 'terminal-not-found';
      }

      const snapshot = this.sshSessionService.getAgentTerminalSession(terminalSessionId);
      if (!snapshot) {
        return 'terminal-not-found';
      }
      if (!snapshot.automationAvailable) {
        return 'terminal-automation-unavailable';
      }
      if (snapshot.attached || snapshot.busy) {
        return 'terminal-busy';
      }
      if (!snapshot.atPrompt) {
        return 'terminal-not-ready';
      }

      const server = await this.getDbClient().sshServer.findUnique({
        where: { id: snapshot.serverId },
        select: { id: true, name: true, host: true, port: true, username: true },
      });
      if (!server) {
        return 'terminal-not-found';
      }

      auditedPayload = {
        ...payload,
        serverId: server.id,
        serverName: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
      };
      this.approvalTerminalSelections.set(approvalId, {
        terminalSessionId,
        approvedTarget: {
          serverId: server.id,
          name: server.name,
          host: server.host,
          port: server.port,
          username: server.username,
        },
      });
    }

    try {
      await this.auditApprovalRequired('authorization-resolved', auditedPayload, decision);
    } catch (error: unknown) {
      this.approvalTerminalSelections.delete(approvalId);
      console.error('[mcp] Failed to persist a required authorization decision audit event.', error);
      return 'audit-unavailable';
    }

    const resolved = this.broker.resolve(approvalId, decision);
    if (!resolved) {
      this.approvalTerminalSelections.delete(approvalId);
    }
    return resolved ? 'resolved' : 'not-found';
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
   * Lists pending visible terminal launches for REST reconnect backfill.
   *
   * @returns Renderer-safe launch payloads.
   */
  public listTerminalLaunches(): McpPendingTerminalLaunch[] {
    return this.terminalLaunchBroker.list();
  }

  /**
   * Cancels one pending visible terminal launch.
   *
   * @param launchId Launch id.
   * @returns True when a pending launch matched.
   */
  public cancelTerminalLaunch(launchId: string): boolean {
    return this.terminalLaunchBroker.cancel(launchId);
  }

  /**
   * Binds a renderer-created normal SSH session to one approved launch.
   *
   * @param launchId Pending launch id.
   * @param terminalSessionId Renderer-owned SSH session id.
   * @returns Stable bind outcome.
   */
  public async bindTerminalLaunch(launchId: string, terminalSessionId: string): Promise<McpBindTerminalLaunchResult> {
    const launch = this.terminalLaunchBroker.get(launchId);
    if (!launch) {
      return { type: 'launch-not-found' };
    }

    const server = await this.getDbClient().sshServer.findUnique({
      where: { id: launch.approvedTarget.serverId },
      select: { id: true, name: true, host: true, port: true, username: true, updatedAt: true },
    });
    if (!server || !matchesApprovedTarget(server, launch.approvedTarget)) {
      this.terminalLaunchBroker.fail(launchId, 'server-changed');
      return { type: 'server-changed' };
    }

    const terminal = this.sshSessionService.getAgentTerminalSession(terminalSessionId);
    if (!terminal || terminal.serverId !== server.id) {
      this.terminalLaunchBroker.fail(launchId, 'terminal-launch-failed');
      return { type: 'terminal-not-found' };
    }

    const connectionId = randomUUID();
    const attachResult = this.sshSessionService.attachAgentTerminal({
      sessionId: terminalSessionId,
      connectionId,
      client: launch.client,
      mode: 'terminal',
      agentCreatedTab: true,
    });
    if (attachResult.type !== 'success') {
      this.terminalLaunchBroker.fail(launchId, attachResult.type);
      return { type: attachResult.type };
    }

    try {
      const connection = this.registry.registerTerminal({
        connectionId,
        terminalSessionId,
        mode: 'terminal',
        approvedTarget: launch.approvedTarget,
        serverPolicyUpdatedAt: server.updatedAt,
        ownerSessionId: launch.ownerSessionId,
        client: launch.client,
        commandsPreApproved: launch.commandsPreApproved,
        agentCreatedTab: true,
        requestId: launch.requestId,
        reservation: launch.reservation,
      });
      if (!this.terminalLaunchBroker.bind(launchId, connection)) {
        await this.registry.close(connection.connectionId, 'error', randomUUID());
        return { type: 'launch-not-found' };
      }
      this.emitStatus();
      return { type: 'success', connection };
    } catch (error: unknown) {
      this.sshSessionService.detachAgentTerminal(connectionId);
      this.terminalLaunchBroker.fail(launchId, error instanceof Error ? error.message : 'terminal-launch-failed');
      return { type: 'terminal-not-found' };
    }
  }

  /**
   * Explicitly detaches an Agent while preserving the visible terminal.
   *
   * @param connectionId MCP connection id.
   * @param requestId Correlating request id.
   * @returns True when a live visible attachment matched.
   */
  public async detachConnectionFromUi(connectionId: string, requestId: string): Promise<boolean> {
    const state = this.registry.list().find((connection) => connection.connectionId === connectionId);
    if (!state || state.mode === 'background') {
      return false;
    }

    return await this.registry.close(connectionId, 'detached', requestId);
  }

  /**
   * Sends Ctrl+C to the visible PTY currently running an Agent command.
   *
   * @param connectionId MCP connection id.
   * @returns True when a matching terminal received the interrupt.
   */
  public stopTerminalCommandFromUi(connectionId: string): boolean {
    return this.sshSessionService.stopAgentTerminalCommand(connectionId);
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
  }): Promise<McpListServersOutcome> {
    const db = this.getDbClient();
    const settings = await readDefaultSettingsValues(db);
    if (settings.mcpListServersRequiresApproval) {
      const ticket = await this.requestApproval({
        kind: 'server-list',
        client: input.client,
      });
      if (!ticket) {
        this.auditServerList({
          client: input.client,
          query: input.query,
          outcome: 'failure',
          reason: 'audit-unavailable',
        });
        return {
          ok: false,
          reason: 'audit-unavailable',
          message: MCP_LIST_SERVERS_AUDIT_UNAVAILABLE_MESSAGE,
        };
      }

      const decision = await this.broker.waitForDecision(ticket, input.signal);
      if (decision !== 'approved') {
        this.auditServerList({
          client: input.client,
          query: input.query,
          outcome: 'failure',
          reason: decision,
        });
        return { ok: false, reason: mapDenyReason(decision), message: denyMessage(decision) };
      }
      if (input.signal.aborted) {
        this.auditServerList({
          client: input.client,
          query: input.query,
          outcome: 'failure',
          reason: 'superseded',
        });
        return { ok: false, reason: 'denied', message: denyMessage('superseded') };
      }
    }

    const globalPolicy: McpCommandPolicy = settings.mcpCommandPolicy;
    const servers = await db.sshServer.findMany({
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

    this.auditServerList({
      client: input.client,
      query: input.query,
      outcome: 'success',
      count: entries.length,
    });

    return { ok: true, servers: entries };
  }

  /**
   * Authorizes and opens one connection (connection-open is always prompted).
   */
  public async openConnection(input: {
    serverId: string;
    reason?: string;
    mode?: Extract<McpConnectionMode, 'terminal' | 'background'>;
    mcpSessionId: string;
    client: McpClientInfo;
    signal: AbortSignal;
  }): Promise<McpOpenConnectionOutcome> {
    const server = await this.getDbClient().sshServer.findUnique({
      where: { id: input.serverId },
      select: { id: true, name: true, host: true, port: true, username: true },
    });

    if (!server) {
      this.auditConnectionOpenFailure({
        mode: input.mode ?? 'terminal',
        client: input.client,
        serverId: input.serverId,
        reason: 'server-not-found',
      });
      return { ok: false, reason: 'server-not-found', message: 'Server not found.' };
    }

    const ticket = await this.requestApproval({
      kind: 'connection-open',
      client: input.client,
      connectionMode: input.mode ?? 'terminal',
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      reason: input.reason,
    });
    if (!ticket) {
      return { ok: false, reason: 'audit-unavailable', message: MCP_AUDIT_UNAVAILABLE_MESSAGE };
    }

    const decision = await this.broker.waitForDecision(ticket, input.signal);
    if (decision !== 'approved' && decision !== 'approvedForConnection') {
      return { ok: false, reason: mapDenyReason(decision), message: denyMessage(decision) };
    }
    if (input.signal.aborted) {
      return { ok: false, reason: 'denied', message: denyMessage('superseded') };
    }

    const requestId = randomUUID();
    const approvedTarget: McpApprovedServerTarget = {
      serverId: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
    };
    const mode = input.mode ?? 'terminal';
    if (mode === 'terminal') {
      const reservation = this.capacity.tryReserve();
      if (!reservation) {
        this.auditConnectionOpenFailure({
          mode,
          client: input.client,
          target: approvedTarget,
          reason: 'connection-limit-reached',
        });
        return {
          ok: false,
          reason: 'limit-reached',
          message: `Too many open connections (max ${this.capacity.getLimit()}). Close one and retry.`,
        };
      }

      const launchTicket = this.terminalLaunchBroker.request({
        ownerSessionId: input.mcpSessionId,
        approvedTarget,
        client: input.client,
        commandsPreApproved: decision === 'approvedForConnection',
        requestId: randomUUID(),
        reservation,
        reason: input.reason,
      });
      const launchResult = await this.terminalLaunchBroker.waitForResult(launchTicket, input.signal);
      if (launchResult.type !== 'bound') {
        this.auditConnectionOpenFailure({
          mode,
          client: input.client,
          target: approvedTarget,
          reason: launchResult.type === 'failed' ? launchResult.reason : `terminal-launch-${launchResult.type}`,
        });
      }
      switch (launchResult.type) {
        case 'bound':
          return { ok: true, connection: launchResult.connection };
        case 'cancelled':
          return { ok: false, reason: 'denied', message: 'The visible terminal launch was cancelled.' };
        case 'expired':
          return {
            ok: false,
            reason: 'terminal-launch-failed',
            message: 'Cosmosh did not create the visible terminal before the launch expired.',
          };
        default:
          if (
            launchResult.reason === 'terminal-busy' ||
            launchResult.reason === 'terminal-not-ready' ||
            launchResult.reason === 'terminal-automation-unavailable'
          ) {
            return terminalAttachFailure(launchResult.reason);
          }
          return {
            ok: false,
            reason: 'terminal-launch-failed',
            message: `The visible terminal could not be created: ${launchResult.reason}`,
          };
      }
    }

    const result = await this.registry.open({
      serverId: server.id,
      approvedTarget,
      ownerSessionId: input.mcpSessionId,
      client: input.client,
      reason: input.reason,
      requestId,
      signal: input.signal,
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
      case 'target-changed':
        return {
          ok: false,
          reason: 'server-changed',
          message: 'The server destination changed after authorization. Review the server and approve a new request.',
        };
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
   * Requests access to one existing SSH pane selected only inside Cosmosh.
   *
   * @param input Agent identity, intent, ownership, and cancellation.
   * @returns Attached MCP connection or a stable failure.
   */
  public async attachTerminal(input: {
    reason?: string;
    mcpSessionId: string;
    client: McpClientInfo;
    signal: AbortSignal;
  }): Promise<McpAttachTerminalOutcome> {
    const ticket = await this.requestApproval({
      kind: 'terminal-attach',
      client: input.client,
      connectionMode: 'attached',
      reason: input.reason,
    });
    if (!ticket) {
      return { ok: false, reason: 'audit-unavailable', message: MCP_AUDIT_UNAVAILABLE_MESSAGE };
    }

    const decision = await this.broker.waitForDecision(ticket, input.signal);
    const selection = this.approvalTerminalSelections.get(ticket.approvalId);
    this.approvalTerminalSelections.delete(ticket.approvalId);
    if (decision !== 'approved' && decision !== 'approvedForConnection') {
      return { ok: false, reason: mapDenyReason(decision), message: denyMessage(decision) };
    }
    if (input.signal.aborted) {
      return { ok: false, reason: 'denied', message: denyMessage('superseded') };
    }
    if (!selection) {
      this.auditConnectionOpenFailure({
        mode: 'attached',
        client: input.client,
        reason: 'no-eligible-terminal',
      });
      return {
        ok: false,
        reason: 'no-eligible-terminal',
        message: 'No eligible terminal was selected in Cosmosh.',
      };
    }

    const currentServer = await this.getDbClient().sshServer.findUnique({
      where: { id: selection.approvedTarget.serverId },
      select: { id: true, name: true, host: true, port: true, username: true, updatedAt: true },
    });
    if (!currentServer || !matchesApprovedTarget(currentServer, selection.approvedTarget)) {
      this.auditConnectionOpenFailure({
        mode: 'attached',
        client: input.client,
        target: selection.approvedTarget,
        reason: 'server-changed',
      });
      return {
        ok: false,
        reason: 'server-changed',
        message: 'The selected terminal destination changed after authorization. Select and approve it again.',
      };
    }

    const reservation = this.capacity.tryReserve();
    if (!reservation) {
      this.auditConnectionOpenFailure({
        mode: 'attached',
        client: input.client,
        target: selection.approvedTarget,
        reason: 'connection-limit-reached',
      });
      return {
        ok: false,
        reason: 'limit-reached',
        message: `Too many open connections (max ${this.capacity.getLimit()}). Close one and retry.`,
      };
    }

    const connectionId = randomUUID();
    const attachResult = this.sshSessionService.attachAgentTerminal({
      sessionId: selection.terminalSessionId,
      connectionId,
      client: input.client,
      mode: 'attached',
      agentCreatedTab: false,
    });
    if (attachResult.type !== 'success') {
      reservation.release();
      this.auditConnectionOpenFailure({
        mode: 'attached',
        client: input.client,
        target: selection.approvedTarget,
        reason: attachResult.type,
      });
      return terminalAttachFailure(attachResult.type);
    }

    try {
      const connection = this.registry.registerTerminal({
        connectionId,
        terminalSessionId: selection.terminalSessionId,
        mode: 'attached',
        approvedTarget: selection.approvedTarget,
        serverPolicyUpdatedAt: currentServer.updatedAt,
        ownerSessionId: input.mcpSessionId,
        client: input.client,
        commandsPreApproved: decision === 'approvedForConnection',
        agentCreatedTab: false,
        requestId: randomUUID(),
        reason: input.reason,
        reservation,
      });
      this.emitStatus();
      return { ok: true, connection };
    } catch (error: unknown) {
      this.sshSessionService.detachAgentTerminal(connectionId);
      reservation.release();
      this.auditConnectionOpenFailure({
        mode: 'attached',
        client: input.client,
        target: selection.approvedTarget,
        reason: 'terminal-registration-failed',
      });
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : 'Failed to register the selected terminal.',
      };
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
    if (input.signal.aborted) {
      return { ok: false, reason: 'denied', message: denyMessage('superseded') };
    }

    if (Buffer.byteLength(input.command, 'utf8') > MCP_MAX_COMMAND_BYTES) {
      return {
        ok: false,
        reason: 'command-too-large',
        message: `Command exceeds the ${MCP_MAX_COMMAND_BYTES}-byte limit.`,
      };
    }
    if (state.mode !== 'background' && containsControlCharacter(input.command)) {
      return {
        ok: false,
        reason: 'invalid-terminal-command',
        message: 'Visible terminal commands must be one line and contain no control characters.',
      };
    }

    const db = this.getDbClient();
    const serverPolicy = await db.sshServer.findUnique({
      where: { id: state.serverId },
      select: { mcpCommandPolicy: true, updatedAt: true },
    });
    if (!serverPolicy) {
      await this.registry.closeOwned(state.connectionId, input.mcpSessionId, 'error');
      return { ok: false, reason: 'connection-not-found', message: 'Connection server no longer exists.' };
    }

    if (serverPolicy.updatedAt.getTime() !== state.serverPolicyUpdatedAt.getTime()) {
      state.commandsPreApproved = false;
      state.serverPolicyUpdatedAt = serverPolicy.updatedAt;
    }

    const settings = await readDefaultSettingsValues(db);
    const globalPolicy: McpCommandPolicy = settings.mcpCommandPolicy;
    const policy = resolveEffectiveMcpCommandPolicy(
      isServerCommandPolicy(serverPolicy.mcpCommandPolicy) ? serverPolicy.mcpCommandPolicy : 'default',
      globalPolicy,
    );
    if (policy !== 'allowWithinConnection') {
      state.commandsPreApproved = false;
    }

    if (policy === 'off') {
      void this.auditEventService.logEvent({
        category: 'mcp',
        action: 'command-execute',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'mcp-connection',
        entityId: state.connectionId,
        requestId: randomUUID(),
        metadata: {
          mode: state.mode,
          status: state.status,
          serverId: state.serverId,
          client: input.client.name,
          reason: 'policy-off',
        },
      });
      return {
        ok: false,
        reason: 'policy-off',
        message: 'Command execution is disabled for this server by policy.',
      };
    }

    const needsPrompt = !(policy === 'allowWithinConnection' && state.commandsPreApproved);
    if (needsPrompt) {
      const ticket = await this.requestApproval({
        kind: 'command-execute',
        client: input.client,
        connectionMode: state.mode,
        serverId: state.serverId,
        serverName: state.serverName,
        host: state.host,
        port: state.port,
        username: state.username,
        command: input.command,
        connectionId: state.connectionId,
      });
      if (!ticket) {
        return { ok: false, reason: 'audit-unavailable', message: MCP_AUDIT_UNAVAILABLE_MESSAGE };
      }

      const decision = await this.broker.waitForDecision(ticket, input.signal);
      if (decision !== 'approved' && decision !== 'approvedForConnection') {
        void this.auditEventService.logEvent({
          category: 'mcp',
          action: 'command-execute',
          outcome: 'failure',
          severity: 'warning',
          entityType: 'mcp-connection',
          entityId: state.connectionId,
          requestId: randomUUID(),
          metadata: {
            mode: state.mode,
            status: state.status,
            serverId: state.serverId,
            client: input.client.name,
            reason: decision,
          },
        });
        return { ok: false, reason: mapDenyReason(decision), message: denyMessage(decision) };
      }
      if (input.signal.aborted) {
        return { ok: false, reason: 'denied', message: denyMessage('superseded') };
      }

      if (decision === 'approvedForConnection') {
        this.registry.markPreApproved(state.connectionId);
      }
    }

    if (state.mode === 'background') {
      const result = await executeMcpSshCommand(state.client, input.command, {
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        signal: input.signal,
      });
      this.registry.touch(state.connectionId);

      if (result.error) {
        void this.auditEventService.logEvent({
          category: 'mcp',
          action: 'command-execute',
          outcome: 'failure',
          severity: 'warning',
          entityType: 'mcp-connection',
          entityId: state.connectionId,
          requestId: randomUUID(),
          metadata: {
            mode: state.mode,
            status: state.status,
            serverId: state.serverId,
            client: input.client.name,
            durationMs: result.durationMs,
            reason: 'ssh-exec-failed',
            policy,
          },
        });
        this.emitStatus();
        return { ok: false, reason: 'failed', message: result.error };
      }

      void this.auditEventService.logEvent({
        category: 'mcp',
        action: 'command-execute',
        outcome: 'success',
        severity: 'warning',
        entityType: 'mcp-connection',
        entityId: state.connectionId,
        requestId: randomUUID(),
        metadata: {
          mode: state.mode,
          status: state.status,
          serverId: state.serverId,
          client: input.client.name,
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
        mode: 'background',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        truncated: result.truncated,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      };
    }

    const terminalResult = await this.sshSessionService.runAgentTerminalCommand({
      sessionId: state.terminalSessionId,
      connectionId: state.connectionId,
      command: input.command,
      timeoutMs: input.timeoutMs ?? MCP_DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes ?? MCP_DEFAULT_MAX_OUTPUT_BYTES,
      signal: input.signal,
    });
    if (terminalResult.type !== 'success') {
      void this.auditEventService.logEvent({
        category: 'mcp',
        action: 'command-execute',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'mcp-connection',
        entityId: state.connectionId,
        requestId: randomUUID(),
        metadata: {
          mode: state.mode,
          status: state.status,
          serverId: state.serverId,
          client: input.client.name,
          reason: terminalResult.type,
          policy,
        },
      });
      return terminalCommandFailure(terminalResult.type);
    }

    const result = terminalResult.result;
    this.registry.touch(state.connectionId);
    if (result.type !== 'completed') {
      void this.auditEventService.logEvent({
        category: 'mcp',
        action: 'command-execute',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'mcp-connection',
        entityId: state.connectionId,
        requestId: randomUUID(),
        metadata: {
          mode: state.mode,
          status: state.status,
          serverId: state.serverId,
          client: input.client.name,
          reason: result.type,
          policy,
        },
      });
      this.emitStatus();
      return { ok: false, reason: 'failed', message: result.message };
    }

    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'command-execute',
      outcome: 'success',
      severity: 'warning',
      entityType: 'mcp-connection',
      entityId: state.connectionId,
      requestId: randomUUID(),
      metadata: {
        mode: state.mode,
        status: state.status,
        serverId: state.serverId,
        client: input.client.name,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
        userIntervened: result.userIntervened,
        policy,
      },
    });
    this.emitStatus();

    return {
      ok: true,
      mode: state.mode,
      output: result.output,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      userIntervened: result.userIntervened,
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
    this.terminalLaunchBroker.cancelAll();
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
        pendingTerminalLaunchCount: this.terminalLaunchBroker.count(),
      },
    });
  }

  /**
   * Creates an approval only after its request is durably recorded.
   *
   * @param input Approval prompt details.
   * @returns Pending approval ticket, or null when required auditing is unavailable.
   */
  private async requestApproval(input: McpApprovalRequestInput): Promise<McpApprovalTicket | null> {
    const ticket = this.broker.request(input);
    try {
      await this.auditApprovalRequired('authorization-requested', ticket.payload);
    } catch (error: unknown) {
      this.broker.cancel(ticket.approvalId, false);
      console.error('[mcp] Failed to persist a required authorization request audit event.', error);
      return null;
    }

    this.emit({ type: 'approval-requested', approval: ticket.payload });
    this.emitStatus();
    return ticket;
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
        mode: payload.connectionMode,
        client: payload.client.name,
        serverId: payload.serverId,
        host: payload.host,
        connectionId: payload.connectionId,
        reason: payload.reason,
        decision,
      },
    });
  }

  /**
   * Persists a security-critical approval transition before remote side effects.
   *
   * @param action Audit action name.
   * @param payload Approval payload.
   * @param decision Optional terminal decision.
   */
  private async auditApprovalRequired(
    action: 'authorization-requested' | 'authorization-resolved',
    payload: McpPendingApprovalPayload,
    decision?: McpApprovalDecision,
  ): Promise<void> {
    await this.auditEventService.logRequiredEvent({
      category: 'mcp',
      action,
      outcome: 'success',
      severity: 'info',
      entityType: 'mcp-approval',
      entityId: payload.approvalId,
      requestId: randomUUID(),
      metadata: {
        kind: payload.kind,
        mode: payload.connectionMode,
        client: payload.client.name,
        serverId: payload.serverId,
        host: payload.host,
        connectionId: payload.connectionId,
        reason: payload.reason,
        decision,
      },
    });
  }

  /**
   * Records one server-list result without including returned server metadata.
   *
   * @param input Agent identity, filter, outcome, and optional count or failure reason.
   */
  private auditServerList(input: {
    client: McpClientInfo;
    query?: string;
    outcome: 'success' | 'failure';
    count?: number;
    reason?: string;
  }): void {
    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'list-servers',
      outcome: input.outcome,
      severity: input.outcome === 'success' ? 'info' : 'warning',
      entityType: 'mcp-session',
      requestId: randomUUID(),
      metadata: {
        client: input.client.name,
        count: input.count,
        query: input.query,
        reason: input.reason,
      },
    });
  }

  /**
   * Records a connection failure without terminal ids, output, or input.
   *
   * @param input Mode, Agent identity, optional approved target, and stable failure reason.
   */
  private auditConnectionOpenFailure(input: {
    mode: McpConnectionMode;
    client: McpClientInfo;
    target?: McpApprovedServerTarget;
    serverId?: string;
    reason: string;
  }): void {
    void this.auditEventService.logEvent({
      category: 'mcp',
      action: 'connection-open',
      outcome: 'failure',
      severity: 'warning',
      entityType: 'mcp-connection',
      requestId: randomUUID(),
      metadata: {
        mode: input.mode,
        status: 'failed',
        serverId: input.target?.serverId ?? input.serverId,
        host: input.target?.host,
        port: input.target?.port,
        client: input.client.name,
        reason: input.reason,
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
 * Maps SSH terminal eligibility failures to stable Agent-facing tool errors.
 *
 * @param type Terminal service attach failure.
 * @returns MCP tool failure.
 */
const terminalAttachFailure = (
  type: 'terminal-not-found' | 'terminal-busy' | 'terminal-not-ready' | 'terminal-automation-unavailable',
): Exclude<McpAttachTerminalOutcome, { ok: true }> => {
  switch (type) {
    case 'terminal-busy':
      return {
        ok: false,
        reason: 'terminal-busy',
        message: 'The selected terminal is already attached to an Agent or running an Agent command.',
      };
    case 'terminal-not-ready':
      return {
        ok: false,
        reason: 'terminal-not-ready',
        message: 'The selected terminal is not at a trusted empty prompt.',
      };
    case 'terminal-automation-unavailable':
      return {
        ok: false,
        reason: 'terminal-automation-unavailable',
        message: 'Trusted Remote Enhancements automation is unavailable for the selected terminal.',
      };
    default:
      return {
        ok: false,
        reason: 'no-eligible-terminal',
        message: 'The selected terminal is no longer available.',
      };
  }
};

/**
 * Maps shared PTY execution readiness failures to stable tool errors.
 *
 * @param type SSH terminal execution failure.
 * @returns MCP command failure.
 */
const terminalCommandFailure = (
  type:
    | 'terminal-not-found'
    | 'terminal-busy'
    | 'terminal-not-ready'
    | 'terminal-automation-unavailable'
    | 'terminal-detached',
): Exclude<McpRunCommandOutcome, { ok: true }> => {
  switch (type) {
    case 'terminal-busy':
      return {
        ok: false,
        reason: 'terminal-busy',
        message: 'The terminal is still running an Agent command.',
      };
    case 'terminal-not-ready':
      return {
        ok: false,
        reason: 'terminal-not-ready',
        message: 'The terminal is not at a trusted empty prompt.',
      };
    case 'terminal-automation-unavailable':
      return {
        ok: false,
        reason: 'terminal-automation-unavailable',
        message: 'Trusted Remote Enhancements automation is unavailable for this terminal.',
      };
    default:
      return {
        ok: false,
        reason: 'connection-not-found',
        message: 'The attached terminal is no longer available.',
      };
  }
};

/**
 * Detects C0/C1 terminal control characters without embedding them in a regular expression.
 *
 * @param value Candidate visible-terminal command.
 * @returns True when the value contains a control character.
 */
const containsControlCharacter = (value: string): boolean => {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
  });
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
