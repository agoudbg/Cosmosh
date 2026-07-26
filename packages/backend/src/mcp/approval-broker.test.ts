import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpApprovalDecision, McpClientInfo, McpPendingApprovalPayload } from '@cosmosh/api-contract';

import { McpApprovalBroker } from './approval-broker.js';
import type { McpApprovalRequestInput } from './types.js';
import type { McpClock } from './types.js';

const CLIENT: McpClientInfo = { name: 'claude-code', version: '1.0.0' };

/**
 * Builds a deterministic clock whose timers only fire when time is advanced.
 *
 * @returns Injectable clock and an advance helper.
 */
type ManualTimer = { fireAt: number; handler: () => void };

const createManualClock = (): {
  clock: McpClock;
  advance: (ms: number) => void;
} => {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, ManualTimer>();

  const clock: McpClock = {
    now: () => nowMs,
    setTimeout: (handler, delayMs) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fireAt: nowMs + delayMs, handler });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  };

  const advance = (ms: number): void => {
    nowMs += ms;
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.fireAt <= nowMs) {
        timers.delete(id);
        timer.handler();
      }
    }
  };

  return { clock, advance };
};

/**
 * Builds a minimal connection-open approval request.
 *
 * @param overrides Partial fields to merge over the defaults.
 * @returns Approval request input.
 */
const buildRequest = (overrides?: Partial<McpApprovalRequestInput>): McpApprovalRequestInput => {
  return {
    kind: 'connection-open',
    client: CLIENT,
    serverId: 'srv-1',
    serverName: 'prod-1',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides,
  };
};

test('request resolves with the timeout decision once the clock advances past expiry', async () => {
  const { clock, advance } = createManualClock();
  const broker = new McpApprovalBroker({ clock, timeoutMs: 1000 });

  const ticket = broker.request(buildRequest());
  assert.equal(broker.pendingCount(), 1);

  advance(1000);
  assert.equal(await ticket.decision, 'timeout');
  assert.equal(broker.pendingCount(), 0);
});

test('resolve settles the request exactly once and ignores later decisions', async () => {
  const { clock } = createManualClock();
  const resolved: { payload: McpPendingApprovalPayload; decision: McpApprovalDecision }[] = [];
  const broker = new McpApprovalBroker({
    clock,
    hooks: {
      onResolved: (payload, decision) => {
        resolved.push({ payload, decision });
      },
    },
  });

  const ticket = broker.request(buildRequest());

  assert.equal(broker.resolve(ticket.approvalId, 'approved'), true);
  // Second resolve finds no pending record and is a no-op.
  assert.equal(broker.resolve(ticket.approvalId, 'denied'), false);

  assert.equal(await ticket.decision, 'approved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.decision, 'approved');
  assert.equal(broker.pendingCount(), 0);
});

test('timeout no longer fires after an explicit decision clears the timer', async () => {
  const { clock, advance } = createManualClock();
  const broker = new McpApprovalBroker({ clock, timeoutMs: 1000 });

  const ticket = broker.request(buildRequest());
  broker.resolve(ticket.approvalId, 'approvedForConnection');

  // Advancing past the original expiry must not overwrite the settled decision.
  advance(5000);
  assert.equal(await ticket.decision, 'approvedForConnection');
});

test('resolve returns false for an unknown approval id', () => {
  const { clock } = createManualClock();
  const broker = new McpApprovalBroker({ clock });
  assert.equal(broker.resolve('missing', 'approved'), false);
});

test('denyAll settles every pending request with the shutdown decision', async () => {
  const { clock } = createManualClock();
  const broker = new McpApprovalBroker({ clock });

  const first = broker.request(buildRequest({ serverId: 'srv-1' }));
  const second = broker.request(buildRequest({ serverId: 'srv-2' }));
  assert.equal(broker.pendingCount(), 2);

  broker.denyAll('superseded');

  assert.equal(await first.decision, 'superseded');
  assert.equal(await second.decision, 'superseded');
  assert.equal(broker.pendingCount(), 0);
});

test('list returns pending payloads oldest first', () => {
  const { clock, advance } = createManualClock();
  const broker = new McpApprovalBroker({ clock, timeoutMs: 60_000 });

  const first = broker.request(buildRequest({ serverId: 'srv-1' }));
  advance(10);
  const second = broker.request(buildRequest({ serverId: 'srv-2' }));

  const pending = broker.list();
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.approvalId, first.approvalId);
  assert.equal(pending[1]?.approvalId, second.approvalId);
});
