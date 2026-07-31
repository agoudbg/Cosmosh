import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { Client, ClientChannel } from 'ssh2';

import { executeMcpSshCommand } from './exec.js';

type FakeChannel = EventEmitter & {
  stderr: EventEmitter;
  close: () => void;
};

/**
 * Creates an ssh2 channel double exposing stdout, stderr, and a close hook.
 *
 * @returns Channel and a close-state accessor.
 */
const createFakeChannel = (): { channel: FakeChannel; wasClosed: () => boolean } => {
  let closed = false;
  const channel = new EventEmitter() as FakeChannel;
  channel.stderr = new EventEmitter();
  channel.close = () => {
    closed = true;
    channel.emit('close');
  };

  return {
    channel,
    wasClosed: () => closed,
  };
};

test('executeMcpSshCommand captures stdout, stderr, and exit code', async () => {
  const { channel } = createFakeChannel();
  const client = {
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      callback(undefined, channel as unknown as ClientChannel);
      channel.emit('data', Buffer.from('out-line'));
      channel.stderr.emit('data', Buffer.from('err-line'));
      channel.emit('exit', 3);
      channel.emit('close');
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'run');
  assert.equal(result.stdout, 'out-line');
  assert.equal(result.stderr, 'err-line');
  assert.equal(result.exitCode, 3);
  assert.equal(result.exitSignal, null);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test('executeMcpSshCommand truncates combined output past the byte budget and closes the channel', async () => {
  const { channel, wasClosed } = createFakeChannel();
  const client = {
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      callback(undefined, channel as unknown as ClientChannel);
      channel.emit('data', Buffer.from('abcdef'));
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'cat big', { maxOutputBytes: 4 });
  assert.equal(result.stdout, 'abcd');
  assert.equal(result.truncated, true);
  assert.equal(wasClosed(), true);
});

test('executeMcpSshCommand reports an exec callback error as an infrastructure failure', async () => {
  const { channel } = createFakeChannel();
  const client = {
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      callback(new Error('exec failed'), channel as unknown as ClientChannel);
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'boom');
  assert.equal(result.error, 'exec failed');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, null);
});

test('executeMcpSshCommand reports a channel error as an infrastructure failure', async () => {
  const { channel, wasClosed } = createFakeChannel();
  const client = {
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      callback(undefined, channel as unknown as ClientChannel);
      channel.emit('error', new Error('channel failed'));
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'boom');
  assert.equal(result.error, 'channel failed');
  assert.equal(result.stderr, '');
  assert.equal(wasClosed(), true);
});

test('executeMcpSshCommand reports a thrown exec error as an infrastructure failure', async () => {
  const client = {
    exec: () => {
      throw new Error('exec threw');
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'boom');
  assert.equal(result.error, 'exec threw');
  assert.equal(result.exitCode, null);
});

test('executeMcpSshCommand times out when the channel never closes', async () => {
  const { channel, wasClosed } = createFakeChannel();
  const client = {
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      callback(undefined, channel as unknown as ClientChannel);
      // No exit/close is ever emitted.
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'sleep forever', { timeoutMs: 5 });
  assert.equal(result.timedOut, true);
  assert.equal(wasClosed(), true);
  assert.equal(result.error, null);
});

test('executeMcpSshCommand returns immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = {
    exec: () => {
      throw new Error('exec must not be called for a pre-aborted signal');
    },
  } as unknown as Client;

  const result = await executeMcpSshCommand(client, 'noop', { signal: controller.signal });
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, '');
});
