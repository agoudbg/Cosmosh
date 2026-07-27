import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteShellCapability, RemoteShellEventMessage } from '@cosmosh/api-contract';

import type { McpClock } from '../mcp/types.js';
import { AgentTerminalController } from './agent-terminal.js';

type FakeTimer = {
  dueAt: number;
  handler: () => void;
};

/**
 * Deterministic timer harness for command timeout behavior.
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
   * @returns Opaque timer handle.
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
   * Advances time and executes newly due callbacks.
   *
   * @param deltaMs Milliseconds to advance.
   */
  public advance(deltaMs: number): void {
    this.currentMs += deltaMs;
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.dueAt <= this.currentMs) {
        this.timers.delete(id);
        timer.handler();
      }
    }
  }
}

/**
 * Builds one trusted helper command lifecycle event.
 *
 * @param event Command event name.
 * @param commandId Trusted helper command id.
 * @returns Complete remote shell event.
 */
const commandEvent = (event: 'command-start' | 'command-end', commandId: string): RemoteShellEventMessage => {
  const base = {
    type: 'remote-shell-event' as const,
    shell: 'bash' as const,
    helperVersion: '1.0.0',
    protocolVersion: 2,
    capabilities: ['command-start', 'command-end', 'prompt-ready', 'line-state'] satisfies RemoteShellCapability[],
    timestamp: 1_000,
    command: 'printf',
    commandId,
  };

  return event === 'command-start' ? { ...base, event } : { ...base, event, exitCode: 7, durationMs: 42 };
};

test('one attachment captures only its commandId output and reports user intervention', async () => {
  const clock = new FakeClock();
  const statuses: string[] = [];
  const writes: string[] = [];
  const controller = new AgentTerminalController({
    clock,
    onStatusChanged: (status) => statuses.push(status.state),
  });
  assert.equal(
    controller.attach({
      connectionId: 'connection-1',
      client: { name: 'test-agent', version: '1.0.0' },
      mode: 'attached',
      agentCreatedTab: false,
    }),
    true,
  );
  assert.equal(
    controller.attach({
      connectionId: 'connection-2',
      client: { name: 'other-agent', version: '1.0.0' },
      mode: 'attached',
      agentCreatedTab: false,
    }),
    false,
  );

  const resultPromise = controller.runCommand({
    connectionId: 'connection-1',
    command: 'printf test',
    timeoutMs: 1_000,
    maxOutputBytes: 5,
    signal: new AbortController().signal,
    write: (data) => writes.push(data),
  });
  assert.deepEqual(writes, ['printf test\r']);
  controller.handleOutput('ignored before start');
  controller.handleRemoteShellEvent(commandEvent('command-start', 'command-1'));
  controller.handleOutput('你ab');
  controller.markUserIntervened();
  controller.handleRemoteShellEvent(commandEvent('command-end', 'other-command'));
  assert.equal(controller.isBusy(), true);
  controller.handleRemoteShellEvent(commandEvent('command-end', 'command-1'));

  assert.deepEqual(await resultPromise, {
    type: 'completed',
    output: '你ab',
    exitCode: 7,
    truncated: false,
    timedOut: false,
    durationMs: 42,
    userIntervened: true,
  });
  assert.equal(controller.isBusy(), false);
  assert.deepEqual(statuses, ['idle', 'running', 'idle']);
});

test('UTF-8 truncation never splits a Unicode scalar value', async () => {
  const controller = new AgentTerminalController({
    onStatusChanged: () => undefined,
  });
  controller.attach({
    connectionId: 'connection-1',
    client: { name: 'test-agent', version: '1.0.0' },
    mode: 'terminal',
    agentCreatedTab: true,
  });
  const resultPromise = controller.runCommand({
    connectionId: 'connection-1',
    command: 'printf unicode',
    timeoutMs: 1_000,
    maxOutputBytes: 4,
    signal: new AbortController().signal,
    write: () => undefined,
  });
  controller.handleRemoteShellEvent(commandEvent('command-start', 'command-1'));
  controller.handleOutput('你好');
  controller.handleRemoteShellEvent(commandEvent('command-end', 'command-1'));

  const result = await resultPromise;
  assert.equal(result.type, 'completed');
  if (result.type === 'completed') {
    assert.equal(result.output, '你');
    assert.equal(result.truncated, true);
  }
});

test('timeout stops waiting but keeps the PTY busy until trusted command-end', async () => {
  const clock = new FakeClock();
  const controller = new AgentTerminalController({
    clock,
    onStatusChanged: () => undefined,
  });
  controller.attach({
    connectionId: 'connection-1',
    client: { name: 'test-agent', version: '1.0.0' },
    mode: 'terminal',
    agentCreatedTab: true,
  });
  const resultPromise = controller.runCommand({
    connectionId: 'connection-1',
    command: 'sleep 10',
    timeoutMs: 100,
    maxOutputBytes: 1_024,
    signal: new AbortController().signal,
    write: () => undefined,
  });
  controller.handleRemoteShellEvent(commandEvent('command-start', 'command-1'));
  clock.advance(100);

  const result = await resultPromise;
  assert.equal(result.type, 'completed');
  if (result.type === 'completed') {
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  }
  assert.equal(controller.isBusy(), true);

  const overlapping = await controller.runCommand({
    connectionId: 'connection-1',
    command: 'pwd',
    timeoutMs: 100,
    maxOutputBytes: 1_024,
    signal: new AbortController().signal,
    write: () => undefined,
  });
  assert.equal(overlapping.type, 'write-failed');

  controller.handleRemoteShellEvent(commandEvent('command-end', 'command-1'));
  assert.equal(controller.isBusy(), false);
});

test('MCP cancellation does not write Ctrl+C and leaves command ownership active', async () => {
  const writes: string[] = [];
  const controller = new AgentTerminalController({
    onStatusChanged: () => undefined,
  });
  controller.attach({
    connectionId: 'connection-1',
    client: { name: 'test-agent', version: '1.0.0' },
    mode: 'attached',
    agentCreatedTab: false,
  });
  const abortController = new AbortController();
  const resultPromise = controller.runCommand({
    connectionId: 'connection-1',
    command: 'tail -f log',
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    signal: abortController.signal,
    write: (data) => writes.push(data),
  });
  controller.handleRemoteShellEvent(commandEvent('command-start', 'command-1'));
  abortController.abort();

  assert.equal((await resultPromise).type, 'cancelled');
  assert.deepEqual(writes, ['tail -f log\r']);
  assert.equal(controller.isBusy(), true);
});

test('a pre-cancelled MCP request never writes to the PTY', async () => {
  const writes: string[] = [];
  const controller = new AgentTerminalController({
    onStatusChanged: () => undefined,
  });
  controller.attach({
    connectionId: 'connection-1',
    client: { name: 'test-agent', version: '1.0.0' },
    mode: 'attached',
    agentCreatedTab: false,
  });
  const abortController = new AbortController();
  abortController.abort();

  const result = await controller.runCommand({
    connectionId: 'connection-1',
    command: 'touch must-not-run',
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    signal: abortController.signal,
    write: (data) => writes.push(data),
  });

  assert.equal(result.type, 'cancelled');
  assert.deepEqual(writes, []);
  assert.equal(controller.isBusy(), false);
});
