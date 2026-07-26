/**
 * MCP authorization broker.
 *
 * Every connection-open and (policy-dependent) command-execute operation is
 * gated by an explicit user decision. The broker turns an authorization request
 * into a Promise that settles when the renderer submits a decision, when the
 * request expires, or when the runtime is torn down. Timers are injectable so
 * the timeout path is deterministic under test.
 */

import { randomUUID } from 'node:crypto';

import type { McpApprovalDecision, McpApprovalUserDecision, McpPendingApprovalPayload } from '@cosmosh/api-contract';

import { MCP_APPROVAL_TIMEOUT_MS } from './constants.js';
import { type McpApprovalRecord, type McpApprovalRequestInput, type McpClock, systemMcpClock } from './types.js';

/**
 * Callbacks invoked when an approval is raised or settled, used to fan events
 * out to the renderer channel and the audit log.
 */
export type McpApprovalBrokerHooks = {
  onRequested?: (payload: McpPendingApprovalPayload) => void;
  onResolved?: (payload: McpPendingApprovalPayload, decision: McpApprovalDecision) => void;
};

/**
 * Result of raising an authorization request.
 */
export type McpApprovalTicket = {
  approvalId: string;
  payload: McpPendingApprovalPayload;
  /** Settles with the terminal decision. */
  decision: Promise<McpApprovalDecision>;
};

/**
 * Tracks pending authorization prompts and resolves them exactly once.
 */
export class McpApprovalBroker {
  private readonly pending = new Map<string, McpApprovalRecord>();

  private readonly clock: McpClock;

  private readonly timeoutMs: number;

  private readonly hooks: McpApprovalBrokerHooks;

  public constructor(options?: { clock?: McpClock; timeoutMs?: number; hooks?: McpApprovalBrokerHooks }) {
    this.clock = options?.clock ?? systemMcpClock;
    this.timeoutMs = Math.max(1, options?.timeoutMs ?? MCP_APPROVAL_TIMEOUT_MS);
    this.hooks = options?.hooks ?? {};
  }

  /**
   * Raises one authorization prompt and returns a ticket that settles on decision or timeout.
   *
   * @param input Approval prompt details.
   * @returns Ticket exposing the approval id and terminal decision promise.
   */
  public request(input: McpApprovalRequestInput): McpApprovalTicket {
    const approvalId = randomUUID();
    const createdAtMs = this.clock.now();
    const payload: McpPendingApprovalPayload = {
      approvalId,
      kind: input.kind,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.timeoutMs).toISOString(),
      client: input.client,
      serverId: input.serverId,
      serverName: input.serverName,
      host: input.host,
      port: input.port,
      username: input.username,
      reason: input.reason,
      command: input.command,
      connectionId: input.connectionId,
    };

    const decision = new Promise<McpApprovalDecision>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.settle(approvalId, 'timeout');
      }, this.timeoutMs);

      this.pending.set(approvalId, {
        payload,
        resolve,
        timer,
      });
    });

    this.hooks.onRequested?.(payload);

    return { approvalId, payload, decision };
  }

  /**
   * Applies one renderer-submitted decision.
   *
   * @param approvalId Pending approval id.
   * @param decision User decision.
   * @returns True when a pending approval matched and was resolved.
   */
  public resolve(approvalId: string, decision: McpApprovalUserDecision): boolean {
    if (!this.pending.has(approvalId)) {
      return false;
    }

    this.settle(approvalId, decision);
    return true;
  }

  /**
   * Lists all pending authorization payloads (oldest first).
   *
   * @returns Pending approval payloads.
   */
  public list(): McpPendingApprovalPayload[] {
    return [...this.pending.values()]
      .map((record) => record.payload)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Number of currently pending approvals.
   *
   * @returns Pending count.
   */
  public pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Rejects every pending approval, used when the runtime is disabled or shut down.
   *
   * @param decision Terminal decision applied to each pending request.
   */
  public denyAll(decision: Extract<McpApprovalDecision, 'denied' | 'timeout' | 'superseded'> = 'superseded'): void {
    for (const approvalId of [...this.pending.keys()]) {
      this.settle(approvalId, decision);
    }
  }

  /**
   * Settles one pending approval exactly once and fires resolution hooks.
   *
   * @param approvalId Pending approval id.
   * @param decision Terminal decision.
   */
  private settle(approvalId: string, decision: McpApprovalDecision): void {
    const record = this.pending.get(approvalId);
    if (!record) {
      return;
    }

    this.pending.delete(approvalId);
    this.clock.clearTimeout(record.timer);
    record.resolve(decision);
    this.hooks.onResolved?.(record.payload, decision);
  }
}
