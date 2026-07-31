/**
 * In-memory broker for approved Agent terminal launches.
 *
 * Launches are renderer work requests rather than SSH sessions. They remain
 * available through both events and REST listing until a renderer binds the
 * resulting normal SSH session, the Agent cancels, or the fixed deadline
 * expires.
 */

import { randomUUID } from 'node:crypto';

import type { McpClientInfo, McpConnectionSummary, McpPendingTerminalLaunch } from '@cosmosh/api-contract';

import type { McpConnectionCapacityReservation } from './connection-capacity.js';
import type { McpApprovedServerTarget } from './connection-registry.js';
import type { McpClock } from './types.js';
import { systemMcpClock } from './types.js';

/** Lifetime of one renderer-bindable terminal launch. */
export const MCP_TERMINAL_LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Hidden ownership and authorization data retained beside a renderer launch.
 */
export type McpTerminalLaunchRecord = {
  payload: McpPendingTerminalLaunch;
  ownerSessionId: string;
  approvedTarget: McpApprovedServerTarget;
  client: McpClientInfo;
  commandsPreApproved: boolean;
  requestId: string;
  reservation: McpConnectionCapacityReservation;
};

/**
 * Terminal launch completion observed by the waiting MCP tool call.
 */
export type McpTerminalLaunchResult =
  | { type: 'bound'; connection: McpConnectionSummary }
  | { type: 'cancelled' }
  | { type: 'expired' }
  | { type: 'failed'; reason: string };

type PendingLaunch = McpTerminalLaunchRecord & {
  resolve: (result: McpTerminalLaunchResult) => void;
  timer: NodeJS.Timeout;
};

/**
 * Ticket returned to the MCP request that waits for renderer binding.
 */
export type McpTerminalLaunchTicket = {
  launchId: string;
  result: Promise<McpTerminalLaunchResult>;
};

/**
 * Coordinates pending terminal creation across event reconnects and REST backfill.
 */
export class McpTerminalLaunchBroker {
  private readonly clock: McpClock;

  private readonly launches = new Map<string, PendingLaunch>();

  private readonly onRequested: (payload: McpPendingTerminalLaunch) => void;

  private readonly onResolved: (launchId: string) => void;

  /**
   * Creates a launch broker.
   *
   * @param options Injectable clock and lifecycle hooks.
   */
  public constructor(options: {
    clock?: McpClock;
    onRequested: (payload: McpPendingTerminalLaunch) => void;
    onResolved: (launchId: string) => void;
  }) {
    this.clock = options.clock ?? systemMcpClock;
    this.onRequested = options.onRequested;
    this.onResolved = options.onResolved;
  }

  /**
   * Registers an approved launch and starts its fixed deadline.
   *
   * @param input Authorized launch ownership and target data.
   * @returns Ticket awaited by the originating MCP call.
   */
  public request(input: Omit<McpTerminalLaunchRecord, 'payload'> & { reason?: string }): McpTerminalLaunchTicket {
    const launchId = randomUUID();
    const now = this.clock.now();
    const payload: McpPendingTerminalLaunch = {
      launchId,
      client: input.client,
      serverId: input.approvedTarget.serverId,
      serverName: input.approvedTarget.name,
      host: input.approvedTarget.host,
      port: input.approvedTarget.port,
      username: input.approvedTarget.username,
      reason: input.reason,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + MCP_TERMINAL_LAUNCH_TIMEOUT_MS).toISOString(),
    };

    let settle!: (result: McpTerminalLaunchResult) => void;
    const result = new Promise<McpTerminalLaunchResult>((resolve) => {
      settle = resolve;
    });
    const timer = this.clock.setTimeout(() => {
      this.finish(launchId, { type: 'expired' });
    }, MCP_TERMINAL_LAUNCH_TIMEOUT_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.launches.set(launchId, {
      ...input,
      payload,
      resolve: settle,
      timer,
    });
    this.onRequested(payload);

    return { launchId, result };
  }

  /**
   * Lists pending launches for renderer reconnect backfill.
   *
   * @returns Oldest-first renderer-safe launch payloads.
   */
  public list(): McpPendingTerminalLaunch[] {
    return [...this.launches.values()]
      .sort((left, right) => left.payload.createdAt.localeCompare(right.payload.createdAt))
      .map((launch) => launch.payload);
  }

  /**
   * Waits for renderer binding while allowing MCP request cancellation to
   * remove the pending launch without interrupting any SSH terminal.
   *
   * @param ticket Launch ticket returned by {@link request}.
   * @param signal MCP request cancellation signal.
   * @returns Terminal launch result.
   */
  public async waitForResult(ticket: McpTerminalLaunchTicket, signal: AbortSignal): Promise<McpTerminalLaunchResult> {
    if (signal.aborted) {
      this.cancel(ticket.launchId);
      return await ticket.result;
    }

    const handleAbort = (): void => {
      this.cancel(ticket.launchId);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    try {
      return await ticket.result;
    } finally {
      signal.removeEventListener('abort', handleAbort);
    }
  }

  /**
   * Reads one pending launch including its hidden ownership data.
   *
   * @param launchId Launch id.
   * @returns Pending launch record, or undefined after settlement.
   */
  public get(launchId: string): McpTerminalLaunchRecord | undefined {
    return this.launches.get(launchId);
  }

  /**
   * Resolves a launch after the renderer bound a normal SSH session.
   *
   * @param launchId Launch id.
   * @param connection Registered MCP connection.
   * @returns True when a pending launch matched.
   */
  public bind(launchId: string, connection: McpConnectionSummary): boolean {
    return this.finish(launchId, { type: 'bound', connection }, false);
  }

  /**
   * Cancels one launch and releases its capacity reservation.
   *
   * @param launchId Launch id.
   * @returns True when a pending launch matched.
   */
  public cancel(launchId: string): boolean {
    return this.finish(launchId, { type: 'cancelled' });
  }

  /**
   * Fails one launch with a stable reason and releases its reservation.
   *
   * @param launchId Launch id.
   * @param reason Stable failure reason.
   * @returns True when a pending launch matched.
   */
  public fail(launchId: string, reason: string): boolean {
    return this.finish(launchId, { type: 'failed', reason });
  }

  /**
   * Cancels every launch owned by one disconnected MCP session.
   *
   * @param ownerSessionId Protocol session id.
   */
  public cancelOwnedBySession(ownerSessionId: string): void {
    for (const launch of [...this.launches.values()]) {
      if (launch.ownerSessionId === ownerSessionId) {
        this.cancel(launch.payload.launchId);
      }
    }
  }

  /**
   * Cancels all pending launches during disable or shutdown.
   */
  public cancelAll(): void {
    for (const launchId of [...this.launches.keys()]) {
      this.cancel(launchId);
    }
  }

  /**
   * Returns the number of pending launches.
   *
   * @returns Pending launch count.
   */
  public count(): number {
    return this.launches.size;
  }

  /**
   * Settles and removes one launch exactly once.
   *
   * @param launchId Launch id.
   * @param result Terminal result delivered to the waiting tool.
   * @param releaseReservation Whether the launch still owns the capacity slot.
   * @returns True when settlement occurred.
   */
  private finish(launchId: string, result: McpTerminalLaunchResult, releaseReservation = true): boolean {
    const launch = this.launches.get(launchId);
    if (!launch) {
      return false;
    }

    this.launches.delete(launchId);
    this.clock.clearTimeout(launch.timer);
    if (releaseReservation) {
      launch.reservation.release();
    }
    launch.resolve(result);
    this.onResolved(launchId);
    return true;
  }
}
