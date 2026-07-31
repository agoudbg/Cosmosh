import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpConnectionSummary } from '@cosmosh/api-contract';

import { McpConnectionCapacity } from './connection-capacity.js';
import { MCP_TERMINAL_LAUNCH_TIMEOUT_MS, McpTerminalLaunchBroker } from './terminal-launch-broker.js';
import type { McpClock } from './types.js';

type FakeTimer = {
  dueAt: number;
  handler: () => void;
};

/**
 * Deterministic timer harness for launch expiry.
 */
class FakeClock implements McpClock {
  private currentMs = 1_000;

  private nextTimerId = 1;

  private readonly timers = new Map<number, FakeTimer>();

  /** @returns Current fake timestamp. */
  public now = (): number => this.currentMs;

  /**
   * Registers a fake timer.
   *
   * @param handler Timer callback.
   * @param delayMs Delay from the fake current time.
   * @returns Opaque Node timer handle.
   */
  public setTimeout = (handler: () => void, delayMs: number): NodeJS.Timeout => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, { dueAt: this.currentMs + delayMs, handler });
    return { id, unref: () => undefined } as unknown as NodeJS.Timeout;
  };

  /**
   * Removes one fake timer.
   *
   * @param handle Opaque fake handle.
   */
  public clearTimeout = (handle: NodeJS.Timeout): void => {
    this.timers.delete((handle as unknown as { id: number }).id);
  };

  /**
   * Advances time and executes every newly due callback.
   *
   * @param deltaMs Milliseconds to advance.
   */
  public advance(deltaMs: number): void {
    this.currentMs += deltaMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.currentMs)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.handler();
    }
  }
}

const TARGET = {
  serverId: 'server-1',
  name: 'Server One',
  host: 'server.example',
  port: 22,
  username: 'operator',
};

/**
 * Builds one pending launch with a shared capacity reservation.
 *
 * @param broker Launch broker.
 * @param capacity Capacity coordinator.
 * @returns Launch ticket.
 */
const requestLaunch = (broker: McpTerminalLaunchBroker, capacity: McpConnectionCapacity) => {
  const reservation = capacity.tryReserve();
  assert.ok(reservation);
  return broker.request({
    ownerSessionId: 'mcp-session-1',
    approvedTarget: TARGET,
    client: { name: 'test-agent', version: '1.0.0' },
    commandsPreApproved: false,
    requestId: 'request-1',
    reservation,
  });
};

test('pending launches replay through list and transfer capacity on bind', async () => {
  const clock = new FakeClock();
  const capacity = new McpConnectionCapacity(1);
  const requested: string[] = [];
  const resolved: string[] = [];
  const broker = new McpTerminalLaunchBroker({
    clock,
    onRequested: (launch) => requested.push(launch.launchId),
    onResolved: (launchId) => resolved.push(launchId),
  });
  const ticket = requestLaunch(broker, capacity);

  assert.deepEqual(requested, [ticket.launchId]);
  assert.deepEqual(
    broker.list().map((launch) => launch.launchId),
    [ticket.launchId],
  );
  assert.equal(capacity.count(), 1);

  const connection: McpConnectionSummary = {
    connectionId: 'connection-1',
    serverId: TARGET.serverId,
    serverName: TARGET.name,
    host: TARGET.host,
    port: TARGET.port,
    username: TARGET.username,
    client: { name: 'test-agent', version: '1.0.0' },
    openedAt: new Date(clock.now()).toISOString(),
    lastUsedAt: new Date(clock.now()).toISOString(),
    commandCount: 0,
    commandsPreApproved: false,
    mode: 'terminal',
    status: 'ready',
    userVisible: true,
    agentCreatedTab: true,
  };
  assert.equal(broker.bind(ticket.launchId, connection), true);
  assert.deepEqual(await ticket.result, { type: 'bound', connection });
  assert.equal(broker.count(), 0);
  assert.equal(capacity.count(), 1);
  assert.deepEqual(resolved, [ticket.launchId]);
});

test('expired and cancelled launches release their reserved capacity', async () => {
  const clock = new FakeClock();
  const capacity = new McpConnectionCapacity(1);
  const broker = new McpTerminalLaunchBroker({
    clock,
    onRequested: () => undefined,
    onResolved: () => undefined,
  });

  const expired = requestLaunch(broker, capacity);
  clock.advance(MCP_TERMINAL_LAUNCH_TIMEOUT_MS);
  assert.deepEqual(await expired.result, { type: 'expired' });
  assert.equal(capacity.count(), 0);

  const cancelled = requestLaunch(broker, capacity);
  assert.equal(broker.cancel(cancelled.launchId), true);
  assert.deepEqual(await cancelled.result, { type: 'cancelled' });
  assert.equal(capacity.count(), 0);
});

test('disconnect cancellation only removes launches owned by that MCP session', async () => {
  const clock = new FakeClock();
  const capacity = new McpConnectionCapacity(2);
  const broker = new McpTerminalLaunchBroker({
    clock,
    onRequested: () => undefined,
    onResolved: () => undefined,
  });
  const first = requestLaunch(broker, capacity);
  const secondReservation = capacity.tryReserve();
  assert.ok(secondReservation);
  const second = broker.request({
    ownerSessionId: 'mcp-session-2',
    approvedTarget: TARGET,
    client: { name: 'other-agent', version: '1.0.0' },
    commandsPreApproved: false,
    requestId: 'request-2',
    reservation: secondReservation,
  });

  broker.cancelOwnedBySession('mcp-session-1');
  assert.deepEqual(await first.result, { type: 'cancelled' });
  assert.equal(broker.get(second.launchId)?.ownerSessionId, 'mcp-session-2');
  assert.equal(capacity.count(), 1);

  broker.cancel(second.launchId);
  await second.result;
});
