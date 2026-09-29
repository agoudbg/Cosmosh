import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { Client, ClientChannel } from 'ssh2';

import { createRemotePathExecutor } from './remote-path-query.js';

const request = { directory: '/actual', fragment: 'file', fuzzyMatch: false, directoriesOnly: false, limit: 20 };

/** Explicit SSH channel boundary with independently observable close request and close acknowledgement. */
class Channel extends EventEmitter {
  closeRequests = 0;
  terms = 0;
  destroyed = false;
  /** @returns Nothing; remote close acknowledgement is controlled separately. */
  close(): void {
    this.closeRequests += 1;
  }
  /** @returns Nothing; the stdin payload stays inside the explicit external boundary. */
  end(): void {}
  /** @param name Requested remote signal. @returns Nothing. */
  signal(name: string): void {
    assert.equal(name, 'TERM');
    this.terms += 1;
  }
  /** @returns Nothing; confirms local containment after the cleanup deadline. */
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

for (const delayOpen of [false, true]) {
  test('path cancellation awaits channel acknowledgement, including a late open=' + delayOpen, async () => {
    const channel = new Channel();
    let opened!: (error: Error | undefined, channel: ClientChannel) => void;
    const client = {
      exec: (_command: string, callback: typeof opened) => {
        opened = callback;
        if (!delayOpen) callback(undefined, channel as unknown as ClientChannel);
      },
    } as unknown as Client;
    const execute = createRemotePathExecutor(client, '/fixed/helper');
    const lifetime = new AbortController();
    let settled = false;
    const pending = execute(request, lifetime.signal).then((result) => {
      settled = true;
      return result;
    });
    lifetime.abort();
    await setImmediate();
    assert.equal(settled, false);
    if (delayOpen) opened(undefined, channel as unknown as ClientChannel);
    if (delayOpen) assert.doesNotThrow(() => channel.emit('error', new Error('canceled channel')));
    assert.equal(channel.closeRequests, 1);
    assert.equal(channel.terms, 1);
    assert.equal(settled, false);
    channel.emit('close');
    assert.equal((await pending).status, 'cancelled');
    assert.equal(channel.destroyed, false);
  });
}

test('an unconfirmed path close disables further remote path launches without blocking terminal ownership', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opens = 0;
  let opened!: (error: Error | undefined, channel: ClientChannel) => void;
  const client = {
    exec: (_command: string, callback: typeof opened) => {
      opens += 1;
      opened = callback;
    },
  } as unknown as Client;
  const execute = createRemotePathExecutor(client, '/fixed/helper');
  const lifetime = new AbortController();
  const pending = execute(request, lifetime.signal);
  lifetime.abort();
  t.mock.timers.tick(1750);
  assert.equal((await pending).status, 'cancelled');
  assert.equal((await execute(request, new AbortController().signal)).status, 'unavailable');
  assert.equal(opens, 1);
  const late = new Channel();
  opened(undefined, late as unknown as ClientChannel);
  assert.equal(late.closeRequests, 1);
  assert.equal(late.terms, 1);
  late.emit('close');
});
