/**
 * Registry of agent-opened SSH connections for the MCP runtime.
 *
 * Modeled on {@link PortForwardSessionService.startRuleInternal}: it resolves a
 * server plus keychain, gathers trusted host fingerprints, opens one ssh2 client
 * through {@link openSshClient}, and normalizes the ready / host-untrusted /
 * failed union. Each accepted connection is bounded by a hard cap and an idle
 * timeout so a misbehaving agent cannot exhaust local resources, and every
 * lifecycle transition is audited and broadcast to the renderer.
 */

import { randomUUID } from 'node:crypto';

import type { McpClientInfo, McpConnectionCloseReason, McpConnectionSummary } from '@cosmosh/api-contract';
import type { PrismaClient } from '@prisma/client';

import type { AuditEventService } from '../audit/service.js';
import { createI18n, type Locale } from '../i18n-bridge.js';
import { openSshClient } from '../ssh/connect.js';
import { MCP_CONNECT_TIMEOUT_SEC, MCP_CONNECTION_IDLE_TIMEOUT_MS, MCP_MAX_CONNECTIONS } from './constants.js';
import { type McpClock, type McpConnectionState, type McpEventEmitter, systemMcpClock } from './types.js';

type GetDbClient = () => PrismaClient;
type OpenSshClient = typeof openSshClient;

/**
 * Normalized outcome of an {@link McpConnectionRegistry.open} attempt.
 */
export type McpOpenConnectionResult =
  | { type: 'success'; summary: McpConnectionSummary }
  | { type: 'server-not-found' }
  | { type: 'limit-reached'; limit: number }
  | {
      type: 'host-untrusted';
      serverId: string;
      host: string;
      port: number;
      fingerprint: string;
    }
  | { type: 'failed'; message: string };

/**
 * Input required to open one agent connection.
 */
export type McpOpenConnectionInput = {
  serverId: string;
  ownerSessionId: string;
  client: McpClientInfo;
  reason?: string;
  requestId: string;
  locale?: Locale;
};

/**
 * Owns the set of live agent SSH connections and their lifecycle bookkeeping.
 */
export class McpConnectionRegistry {
  private readonly getDbClient: GetDbClient;

  private readonly auditEventService: AuditEventService;

  private readonly credentialEncryptionKey: Buffer;

  private readonly emitEvent: McpEventEmitter;

  private readonly openClient: OpenSshClient;

  private readonly clock: McpClock;

  private readonly connections = new Map<string, McpConnectionState>();

  public constructor(options: {
    getDbClient: GetDbClient;
    auditEventService: AuditEventService;
    credentialEncryptionKey: Buffer;
    emitEvent: McpEventEmitter;
    openClient?: OpenSshClient;
    clock?: McpClock;
  }) {
    this.getDbClient = options.getDbClient;
    this.auditEventService = options.auditEventService;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
    this.emitEvent = options.emitEvent;
    this.openClient = options.openClient ?? openSshClient;
    this.clock = options.clock ?? systemMcpClock;
  }

  /**
   * Opens one authorized agent SSH connection and registers it.
   *
   * @param input Connection request (already authorized by the caller).
   * @returns Normalized open result.
   */
  public async open(input: McpOpenConnectionInput): Promise<McpOpenConnectionResult> {
    if (this.connections.size >= MCP_MAX_CONNECTIONS) {
      this.audit('connection-open', 'failure', 'warning', input.requestId, {
        serverId: input.serverId,
        reason: 'connection-limit-reached',
        limit: MCP_MAX_CONNECTIONS,
        client: input.client.name,
      });
      return { type: 'limit-reached', limit: MCP_MAX_CONNECTIONS };
    }

    const db = this.getDbClient();
    const server = await db.sshServer.findUnique({
      where: {
        id: input.serverId,
      },
      include: {
        keychain: true,
      },
    });

    if (!server) {
      return { type: 'server-not-found' };
    }

    const i18n = createI18n({ locale: input.locale ?? 'en', fallbackLocale: 'en' });
    const trustedKeys = await db.sshKnownHost.findMany({
      where: {
        host: server.host,
        port: server.port,
        trusted: true,
        keyType: 'sha256',
      },
      select: {
        fingerprint: true,
      },
    });

    const openResult = await this.openClient(server, {
      connectTimeoutSec: MCP_CONNECT_TIMEOUT_SEC,
      db,
      strictHostKey: server.strictHostKey,
      trustedFingerprintSet: new Set(trustedKeys.map((item) => item.fingerprint)),
      credentialEncryptionKey: this.credentialEncryptionKey,
      t: i18n.t,
    });

    if (openResult.type === 'host-untrusted') {
      this.audit('connection-open', 'failure', 'warning', input.requestId, {
        serverId: server.id,
        host: server.host,
        port: server.port,
        reason: 'host-untrusted',
        fingerprint: openResult.fingerprint,
        client: input.client.name,
      });
      return {
        type: 'host-untrusted',
        serverId: server.id,
        host: server.host,
        port: server.port,
        fingerprint: openResult.fingerprint,
      };
    }

    if (openResult.type === 'failed') {
      this.audit('connection-open', 'failure', 'warning', input.requestId, {
        serverId: server.id,
        host: server.host,
        port: server.port,
        reason: openResult.message,
        client: input.client.name,
      });
      return { type: 'failed', message: openResult.message };
    }

    const now = new Date(this.clock.now());
    const connectionId = randomUUID();
    const state: McpConnectionState = {
      connectionId,
      ownerSessionId: input.ownerSessionId,
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      client: openResult.client,
      clientInfo: input.client,
      serverCommandPolicy: isServerCommandPolicy(server.mcpCommandPolicy) ? server.mcpCommandPolicy : 'default',
      lifecycleMonitor: openResult.lifecycleMonitor,
      openedAt: now,
      lastUsedAt: now,
      commandCount: 0,
      commandsPreApproved: false,
      idleTimer: null,
      disposed: false,
    };

    const handleClientClose = (): void => {
      void this.finalizeUnexpectedClose(connectionId, 'error');
    };
    const handleClientError = (): void => {
      void this.finalizeUnexpectedClose(connectionId, 'error');
    };

    openResult.client.on('close', handleClientClose);
    openResult.client.on('error', handleClientError);
    openResult.lifecycleMonitor.release();

    const guardedError = openResult.lifecycleMonitor.readError();
    if (guardedError || openResult.lifecycleMonitor.isClosed()) {
      openResult.client.removeListener('close', handleClientClose);
      openResult.client.removeListener('error', handleClientError);
      openResult.client.end();
      const message = guardedError?.message ?? i18n.t('errors.mcp.connectionClosed');
      this.audit('connection-open', 'failure', 'warning', input.requestId, {
        serverId: server.id,
        host: server.host,
        port: server.port,
        reason: message,
        client: input.client.name,
      });
      return { type: 'failed', message };
    }

    this.connections.set(connectionId, state);
    this.armIdleTimer(state);

    const summary = toSummary(state);
    this.audit('connection-open', 'success', 'warning', input.requestId, {
      connectionId,
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      client: input.client.name,
      clientVersion: input.client.version,
      reason: input.reason,
    });
    this.emitEvent({ type: 'connection-opened', connection: summary });

    return { type: 'success', summary };
  }

  /**
   * Returns one live connection only when it belongs to the calling session.
   *
   * @param connectionId Connection id.
   * @param ownerSessionId Calling MCP session id.
   * @returns Owned connection state, or undefined when unknown, closed, or owned by another session.
   */
  public getOwned(connectionId: string, ownerSessionId: string): McpConnectionState | undefined {
    const state = this.connections.get(connectionId);
    return state?.ownerSessionId === ownerSessionId ? state : undefined;
  }

  /**
   * Lists all live connections as renderer/tool summaries (oldest first).
   *
   * @returns Connection summaries.
   */
  public list(): McpConnectionSummary[] {
    return [...this.connections.values()]
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
      .map((state) => toSummary(state));
  }

  /**
   * Lists connections owned by one MCP protocol session.
   *
   * @param ownerSessionId Owning MCP session id.
   * @returns Connection summaries visible to that session.
   */
  public listOwned(ownerSessionId: string): McpConnectionSummary[] {
    return [...this.connections.values()]
      .filter((state) => state.ownerSessionId === ownerSessionId)
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
      .map((state) => toSummary(state));
  }

  /**
   * Number of live connections.
   *
   * @returns Live connection count.
   */
  public count(): number {
    return this.connections.size;
  }

  /**
   * Refreshes a connection's last-used timestamp and idle timer.
   *
   * @param connectionId Connection id.
   */
  public touch(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) {
      return;
    }

    state.lastUsedAt = new Date(this.clock.now());
    state.commandCount += 1;
    this.armIdleTimer(state);
  }

  /**
   * Marks every future command on a connection as pre-approved.
   *
   * @param connectionId Connection id.
   */
  public markPreApproved(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.commandsPreApproved = true;
    }
  }

  /**
   * Closes one connection and audits/broadcasts the teardown.
   *
   * @param connectionId Connection id.
   * @param reason Close cause.
   * @param requestId Optional correlating request id.
   * @returns True when a live connection was closed.
   */
  public async close(connectionId: string, reason: McpConnectionCloseReason, requestId?: string): Promise<boolean> {
    const state = this.connections.get(connectionId);
    if (!state) {
      return false;
    }

    this.connections.delete(connectionId);
    this.disposeState(state);

    this.audit('connection-close', 'success', 'info', requestId ?? randomUUID(), {
      connectionId,
      serverId: state.serverId,
      host: state.host,
      port: state.port,
      client: state.clientInfo.name,
      reason,
      commandCount: state.commandCount,
    });
    this.emitEvent({ type: 'connection-closed', connectionId, reason });

    return true;
  }

  /**
   * Closes one connection only when it belongs to the calling MCP session.
   *
   * @param connectionId Connection id.
   * @param ownerSessionId Calling MCP session id.
   * @param reason Close cause.
   * @param requestId Optional correlating request id.
   * @returns True when an owned live connection was closed.
   */
  public async closeOwned(
    connectionId: string,
    ownerSessionId: string,
    reason: McpConnectionCloseReason,
    requestId?: string,
  ): Promise<boolean> {
    if (!this.getOwned(connectionId, ownerSessionId)) {
      return false;
    }

    return await this.close(connectionId, reason, requestId);
  }

  /**
   * Closes every connection owned by one disconnected MCP session.
   *
   * @param ownerSessionId Disconnected MCP session id.
   */
  public async closeOwnedBySession(ownerSessionId: string): Promise<void> {
    const ids = [...this.connections.values()]
      .filter((state) => state.ownerSessionId === ownerSessionId)
      .map((state) => state.connectionId);
    for (const id of ids) {
      await this.close(id, 'client-disconnected');
    }
  }

  /**
   * Closes all connections during runtime disable or backend shutdown.
   *
   * @param reason Close cause applied to every connection.
   */
  public async closeAll(reason: McpConnectionCloseReason): Promise<void> {
    const ids = [...this.connections.keys()];
    for (const id of ids) {
      await this.close(id, reason);
    }
  }

  /**
   * Rearms the idle timer for one connection.
   *
   * @param state Connection state.
   */
  private armIdleTimer(state: McpConnectionState): void {
    if (state.idleTimer) {
      this.clock.clearTimeout(state.idleTimer);
    }

    state.idleTimer = this.clock.setTimeout(() => {
      void this.close(state.connectionId, 'idle');
    }, MCP_CONNECTION_IDLE_TIMEOUT_MS);

    if (typeof state.idleTimer.unref === 'function') {
      state.idleTimer.unref();
    }
  }

  /**
   * Finalizes a connection that closed outside an explicit tool/UI request.
   *
   * @param connectionId Connection id.
   * @param reason Close cause.
   */
  private async finalizeUnexpectedClose(connectionId: string, reason: McpConnectionCloseReason): Promise<void> {
    const state = this.connections.get(connectionId);
    if (!state || state.disposed) {
      return;
    }

    this.connections.delete(connectionId);
    this.disposeState(state);
    this.audit('connection-close', 'success', 'info', randomUUID(), {
      connectionId,
      serverId: state.serverId,
      host: state.host,
      port: state.port,
      client: state.clientInfo.name,
      reason,
      commandCount: state.commandCount,
    });
    this.emitEvent({ type: 'connection-closed', connectionId, reason });
  }

  /**
   * Tears down one connection's timers and ssh2 client.
   *
   * @param state Connection state.
   */
  private disposeState(state: McpConnectionState): void {
    if (state.disposed) {
      return;
    }

    state.disposed = true;
    if (state.idleTimer) {
      this.clock.clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    state.lifecycleMonitor.releaseAfterClose();
    try {
      state.client.end();
    } catch {
      // Ignore teardown races; a destroyed client is already effectively closed.
    }
  }

  /**
   * Writes one MCP audit event without blocking the caller.
   *
   * @param action Audit action name.
   * @param outcome Success or failure.
   * @param severity Event severity.
   * @param requestId Correlating request id.
   * @param metadata Non-sensitive metadata payload.
   */
  private audit(
    action: string,
    outcome: 'success' | 'failure',
    severity: 'info' | 'warning' | 'critical',
    requestId: string,
    metadata: Record<string, unknown>,
  ): void {
    void this.auditEventService.logEvent({
      category: 'mcp',
      action,
      outcome,
      severity,
      entityType: 'mcp-connection',
      entityId: typeof metadata.connectionId === 'string' ? metadata.connectionId : undefined,
      requestId,
      metadata,
    });
  }
}

/**
 * Converts internal connection state into the shared summary shape.
 *
 * @param state Connection state.
 * @returns Connection summary DTO.
 */
const toSummary = (state: McpConnectionState): McpConnectionSummary => {
  return {
    connectionId: state.connectionId,
    serverId: state.serverId,
    serverName: state.serverName,
    host: state.host,
    port: state.port,
    username: state.username,
    client: state.clientInfo,
    openedAt: state.openedAt.toISOString(),
    lastUsedAt: state.lastUsedAt.toISOString(),
    commandCount: state.commandCount,
    commandsPreApproved: state.commandsPreApproved,
  };
};

/**
 * Narrows a raw persisted per-server policy value.
 *
 * @param value Raw column value.
 * @returns True when the value is a supported per-server policy.
 */
const isServerCommandPolicy = (value: string): value is McpConnectionState['serverCommandPolicy'] => {
  return value === 'default' || value === 'off' || value === 'ask' || value === 'allowWithinConnection';
};
