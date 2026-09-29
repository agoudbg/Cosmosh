import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';

import type { ClientChannel } from 'ssh2';

import { DeliveredTerminal, type OpenDeliveredTerminalResult } from './terminal-transport.js';

/** External SSH boundary double; core framing and delivery accounting remain real. */
class Channel extends Duplex {
  public readonly stderr = new PassThrough();
  public writes: Record<string, unknown>[] = [];
  public deferClose = false;
  /** @returns Nothing; the remote peer explicitly emits its own data. */
  public _read(): void {}
  /** @param chunk Encoded protocol bytes. @param _encoding Encoding. @param done Transport acceptance. @returns Nothing. */
  public _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.writes.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
    done();
  }
  /** @returns Nothing; simulates remote channel close. */
  public close(): void {
    if (!this.deferClose) this.destroy();
  }
  /** @param value Remote frame. @returns Nothing. */
  public frame(value: Record<string, unknown>): void {
    this.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  }
}

/** @returns Real transport with an explicit external channel and bounded test output. */
const fixture = () => {
  const channel = new Channel();
  const output: string[] = [];
  const outcomes: OpenDeliveredTerminalResult[] = [];
  const stream = new DeliveredTerminal(
    channel as unknown as ClientChannel,
    {
      cols: 120,
      rows: 32,
      term: 'xterm-256color',
      onOutput: (data) => output.push(data),
    },
    (result) => outcomes.push(result),
  );
  /** @returns Nothing; completes the actual production handshake. */
  const start = (): void => {
    channel.frame({ type: 'hello', protocol: 2 });
    channel.frame({ type: 'ready', epoch: stream.inputDelivery.epoch, pid: 123 });
  };
  return { channel, output, outcomes, stream, start };
};

test('all writes are numbered synchronously and only remote confirmations advance delivery', async () => {
  const f = fixture();
  f.start();
  try {
    f.stream.write('first');
    f.stream.write('password\r');
    const { epoch } = f.stream.inputDelivery;
    assert.deepEqual(f.stream.inputDelivery, { epoch, sent: 2, delivered: 0 });
    assert.equal(f.channel.writes[1]?.data, Buffer.from('first').toString('base64'));
    assert.equal(f.channel.writes[2]?.data, Buffer.from('password\r').toString('base64'));
    const signal = new AbortController();
    let resolved = false;
    const wait = f.stream.waitForDelivery(2, signal.signal).then((value) => {
      resolved = true;
      return value;
    });
    f.channel.frame({ type: 'delivered', epoch, sequence: 1 });
    await Promise.resolve();
    assert.equal(resolved, false);
    f.channel.frame({ type: 'delivered', epoch, sequence: 2 });
    assert.equal(await wait, true);
    assert.deepEqual(f.stream.inputDelivery, { epoch, sent: 2, delivered: 2 });
  } finally {
    f.stream.close();
  }
});

test('unknown, duplicate, skipped and foreign acknowledgements terminate instead of guessing', () => {
  for (const kind of ['unknown', 'duplicate', 'skipped', 'foreign'] as const) {
    const f = fixture();
    f.start();
    const { epoch } = f.stream.inputDelivery;
    if (kind !== 'unknown') f.stream.write('x');
    if (kind === 'skipped') f.stream.write('y');
    if (kind === 'duplicate') f.channel.frame({ type: 'delivered', epoch, sequence: 1 });
    f.channel.frame({
      type: 'delivered',
      epoch: kind === 'foreign' ? 'other' : epoch,
      sequence: kind === 'skipped' ? 2 : 1,
    });
    assert.equal(f.stream.destroyed, true, kind);
  }
});

test('terminal output cannot forge control frames and split UTF-8 stays intact', () => {
  const f = fixture();
  f.start();
  try {
    const { epoch } = f.stream.inputDelivery;
    const data = Buffer.from('中文😀\n{"type":"delivered","sequence":1}\n');
    for (const byte of data) f.channel.frame({ type: 'output', epoch, data: Buffer.from([byte]).toString('base64') });
    assert.equal(f.output.join(''), data.toString('utf8'));
    assert.equal(f.stream.inputDelivery.delivered, 0);
  } finally {
    f.stream.close();
  }
});

test('large paste preserves every byte and sizes travel on the same channel', () => {
  const f = fixture();
  f.start();
  try {
    const data = Buffer.from('😀中\r\n'.repeat(16000));
    f.stream.write(data);
    const input = f.channel.writes.filter((value) => value.type === 'input');
    assert.equal(input.length, Math.ceil(data.length / 65536));
    assert.deepEqual(Buffer.concat(input.map((value) => Buffer.from(value.data as string, 'base64'))), data);
    f.stream.setWindow(48, 160);
    assert.equal(f.channel.writes.at(-1)?.type, 'resize');
    assert.equal(f.channel.writes.at(-1)?.rows, 48);
    assert.equal(f.channel.writes.at(-1)?.cols, 160);
  } finally {
    f.stream.close();
  }
});

test('startup fallback is allowed only before sending start', () => {
  const before = fixture();
  before.channel.emit('data', Buffer.from('profile banner\n'));
  before.stream.close();
  assert.deepEqual(before.outcomes, [{ status: 'unavailable' }]);
  const after = fixture();
  after.channel.frame({ type: 'hello', protocol: 2 });
  after.stream.close();
  assert.deepEqual(after.outcomes, [{ status: 'failed' }]);
});

test('frame and queued input bounds close without replay or partial local acceptance', () => {
  const f = fixture();
  f.start();
  assert.throws(() => f.stream.write('x'.repeat(1024 * 1024 + 1)), /budget/u);
  assert.equal(f.stream.inputDelivery.sent, 0);
  assert.equal(f.stream.destroyed, true);
  const overlong = fixture();
  overlong.channel.emit('data', Buffer.from('x'.repeat(8192)));
  assert.equal(overlong.stream.destroyed, true);
  const malformed = fixture();
  malformed.start();
  malformed.channel.frame({ type: 'output', epoch: malformed.stream.inputDelivery.epoch, data: 'not base64' });
  assert.equal(malformed.stream.destroyed, true);
});

test('remote exit invalidates delivered and pending boundaries before asynchronous channel close', async () => {
  const f = fixture();
  f.start();
  f.channel.deferClose = true;
  try {
    f.stream.write('delivered');
    f.stream.write('pending');
    const { epoch } = f.stream.inputDelivery;
    f.channel.frame({ type: 'delivered', epoch, sequence: 1 });
    const wait = f.stream.waitForDelivery(2, new AbortController().signal);
    f.channel.frame({ type: 'exit', epoch, code: 0 });
    assert.equal(f.stream.destroyed, false, 'actual close acknowledgement is deliberately delayed');
    assert.equal(await wait, false);
    assert.equal(await f.stream.waitForDelivery(1, new AbortController().signal), false);
    assert.throws(() => f.stream.write('late'), /closed/u);
    const writes = f.channel.writes.length;
    f.stream.setWindow(48, 160);
    assert.equal(f.channel.writes.length, writes);
  } finally {
    f.stream.close();
  }
});

test('cancellation and close finish delivery waiters without marking input delivered', async () => {
  const f = fixture();
  f.start();
  f.stream.write('pending');
  const cancel = new AbortController();
  const cancelled = f.stream.waitForDelivery(1, cancel.signal);
  cancel.abort();
  assert.equal(await cancelled, false);
  const closed = f.stream.waitForDelivery(1, new AbortController().signal);
  f.stream.close();
  assert.equal(await closed, false);
  assert.equal(f.stream.inputDelivery.delivered, 0);
});

test('protocol 2 validates the original Shell PID and rejects older handshakes before start', () => {
  for (const protocol of [undefined, 1, 3, '2']) {
    const f = fixture();
    f.channel.frame({ type: 'hello', protocol });
    assert.deepEqual(f.outcomes, [{ status: 'unavailable' }]);
    assert.equal(f.channel.writes.length, 0);
    assert.equal(f.stream.originalShellPID, null);
  }
  for (const pid of [undefined, 0, 1, -1, 1.5, 2147483648, '123']) {
    const f = fixture();
    f.channel.frame({ type: 'hello', protocol: 2 });
    assert.equal(f.channel.writes[0]?.protocol, 2);
    f.channel.frame({ type: 'ready', epoch: f.stream.inputDelivery.epoch, pid });
    assert.deepEqual(f.outcomes, [{ status: 'failed' }]);
    assert.equal(f.stream.originalShellPID, null);
  }
  for (const pid of [2, 123, 2147483647]) {
    const f = fixture();
    assert.equal(f.stream.originalShellPID, null);
    f.channel.frame({ type: 'hello', protocol: 2 });
    f.channel.frame({ type: 'ready', epoch: f.stream.inputDelivery.epoch, pid });
    assert.equal(f.stream.originalShellPID, pid);
    f.stream.close();
    assert.equal(f.stream.originalShellPID, null);
  }
});

test('only an exact pre-ready start rejection permits fallback after sending start', () => {
  const rejected = fixture();
  rejected.channel.frame({ type: 'hello', protocol: 2 });
  rejected.channel.frame({ type: 'start-rejected', epoch: rejected.stream.inputDelivery.epoch });
  assert.deepEqual(rejected.outcomes, [{ status: 'unavailable' }]);
  assert.equal(rejected.stream.destroyed, true);
  assert.equal(rejected.channel.writes.length, 1);
  for (const mutation of [{ epoch: 'foreign' }, { extra: true }]) {
    const f = fixture();
    f.channel.frame({ type: 'hello', protocol: 2 });
    f.channel.frame({ type: 'start-rejected', epoch: f.stream.inputDelivery.epoch, ...mutation });
    assert.deepEqual(f.outcomes, [{ status: 'failed' }]);
  }
  const afterReady = fixture();
  afterReady.start();
  afterReady.channel.frame({ type: 'start-rejected', epoch: afterReady.stream.inputDelivery.epoch });
  assert.equal(afterReady.stream.destroyed, true);
  assert.equal(afterReady.outcomes.length, 1);
  assert.equal(afterReady.outcomes[0]?.status, 'ready');
});

test('authorization rejects invalid identities and undelivered or stale boundaries without sending', async () => {
  const beforeReady = fixture();
  assert.equal(
    await beforeReady.stream.authorizeEditor(
      randomUUID(),
      { epoch: beforeReady.stream.inputDelivery.epoch, sequence: 0 },
      new AbortController().signal,
    ),
    false,
  );
  beforeReady.stream.close();
  const f = fixture();
  f.start();
  try {
    const { epoch } = f.stream.inputDelivery;
    const signal = new AbortController().signal;
    for (const requestId of [
      '',
      'secret',
      'ABCDEF01-2345-4678-89AB-CDEF01234567',
      '00000000-0000-1000-8000-000000000000',
    ]) {
      assert.equal(await f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, signal), false);
    }
    for (const boundary of [
      { epoch: randomUUID(), sequence: 0 },
      { epoch, sequence: -1 },
      { epoch, sequence: 0.5 },
      { epoch, sequence: 1 },
      { epoch, sequence: Number.MAX_SAFE_INTEGER + 1 },
    ])
      assert.equal(await f.stream.authorizeEditor(randomUUID(), boundary, signal), false);
    assert.equal(await f.stream.authorizeEditor(randomUUID(), { epoch, sequence: 0 }, AbortSignal.abort()), false);
    f.stream.write('pending');
    assert.equal(await f.stream.authorizeEditor(randomUUID(), { epoch, sequence: 1 }, signal), false);
    f.channel.frame({ type: 'delivered', epoch, sequence: 1 });
    assert.equal(await f.stream.authorizeEditor(randomUUID(), { epoch, sequence: 0 }, signal), false);
    assert.equal(
      f.channel.writes.some((frame) => frame.type === 'authorize-editor'),
      false,
    );
  } finally {
    f.stream.close();
  }
});

test('only the matching private acknowledgement grants one bounded editor authorization', async () => {
  const f = fixture();
  f.start();
  try {
    const { epoch } = f.stream.inputDelivery;
    const requestId = randomUUID();
    const signal = new AbortController().signal;
    let settled = false;
    const authorization = f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, signal).then((approved) => {
      settled = true;
      return approved;
    });
    const ack = { type: 'editor-authorized', epoch, sequence: 0, requestId, approved: true };
    assert.deepEqual(f.channel.writes.at(-1), { type: 'authorize-editor', epoch, sequence: 0, requestId });
    assert.equal(await f.stream.authorizeEditor(randomUUID(), { epoch, sequence: 0 }, signal), false);
    assert.equal(f.channel.writes.filter((frame) => frame.type === 'authorize-editor').length, 1);
    f.channel.frame({ type: 'output', epoch, data: Buffer.from(JSON.stringify(ack)).toString('base64') });
    f.channel.frame({ ...ack, requestId: randomUUID() });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.output.join(''), JSON.stringify(ack));
    f.channel.frame(ack);
    assert.equal(await authorization, true);
    f.channel.frame({ ...ack, approved: false });
    assert.equal(f.stream.destroyed, false, 'a duplicate acknowledgement cannot reverse or renew the grant');
    f.stream.revokeEditor(randomUUID());
    assert.equal(f.channel.writes.at(-1)?.type, 'authorize-editor');
    f.stream.revokeEditor(requestId);
    assert.deepEqual(f.channel.writes.at(-1), { type: 'revoke-editor', epoch, requestId });
    assert.equal(await f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, signal), false);
    const deniedId = randomUUID();
    const denied = f.stream.authorizeEditor(deniedId, { epoch, sequence: 0 }, signal);
    f.channel.frame({ ...ack, requestId: deniedId, approved: false });
    assert.equal(await denied, false);
    assert.equal(f.stream.destroyed, false);
  } finally {
    f.stream.close();
  }
});

test('new input cancels authorization immediately and late approval cannot grant a newer request', async () => {
  const f = fixture();
  f.start();
  try {
    const { epoch } = f.stream.inputDelivery;
    const requestId = randomUUID();
    const pending = f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, new AbortController().signal);
    f.stream.write('ordinary input');
    assert.equal(await pending, false);
    assert.equal(f.channel.writes.at(-1)?.type, 'input');
    assert.equal(
      f.channel.writes.some((frame) => frame.type === 'revoke-editor'),
      false,
    );
    assert.deepEqual(f.stream.inputDelivery, { epoch, sent: 1, delivered: 0 });
    f.channel.frame({ type: 'delivered', epoch, sequence: 1 });
    const nextId = randomUUID();
    let settled = false;
    const next = f.stream
      .authorizeEditor(nextId, { epoch, sequence: 1 }, new AbortController().signal)
      .then((value) => {
        settled = true;
        return value;
      });
    f.channel.frame({ type: 'editor-authorized', epoch, sequence: 0, requestId, approved: true });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.stream.destroyed, false);
    f.channel.frame({ type: 'editor-authorized', epoch, sequence: 1, requestId: nextId, approved: true });
    assert.equal(await next, true);
    f.stream.write('still responsive');
    assert.equal(f.channel.writes.at(-1)?.type, 'input');
  } finally {
    f.stream.close();
  }
});

test('abort and explicit revocation finish pending requests and revoke acknowledged grants', async () => {
  const f = fixture();
  f.start();
  try {
    const { epoch } = f.stream.inputDelivery;
    for (const approved of [false, true]) {
      const requestId = randomUUID();
      const cancel = new AbortController();
      const pending = f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, cancel.signal);
      if (approved) {
        f.channel.frame({ type: 'editor-authorized', epoch, sequence: 0, requestId, approved: true });
        assert.equal(await pending, true);
      }
      cancel.abort();
      assert.equal(await pending, approved);
      assert.deepEqual(f.channel.writes.at(-1), { type: 'revoke-editor', epoch, requestId });
      f.channel.frame({ type: 'editor-authorized', epoch, sequence: 0, requestId, approved: true });
      assert.equal(f.stream.destroyed, false);
    }
    const requestId = randomUUID();
    const pending = f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, new AbortController().signal);
    f.stream.revokeEditor(requestId);
    assert.equal(await pending, false);
    const count = f.channel.writes.length;
    f.stream.revokeEditor(requestId);
    assert.equal(f.channel.writes.length, count);
  } finally {
    f.stream.close();
  }
});

test('authorization timeout revokes without blocking input and duplicate replies never extend the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.start();
  try {
    const { epoch } = f.stream.inputDelivery;
    for (const approved of [false, true]) {
      const requestId = randomUUID();
      const pending = f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, new AbortController().signal);
      const ack = { type: 'editor-authorized', epoch, sequence: 0, requestId, approved: true };
      if (approved) {
        f.channel.frame(ack);
        assert.equal(await pending, true);
      }
      t.mock.timers.tick(1000);
      if (approved) f.channel.frame(ack);
      t.mock.timers.tick(500);
      assert.equal(await pending, approved);
      assert.deepEqual(f.channel.writes.at(-1), { type: 'revoke-editor', epoch, requestId });
      f.channel.frame(ack);
      assert.equal(f.stream.destroyed, false);
    }
    f.stream.write('after timeout');
    assert.equal(f.channel.writes.at(-1)?.type, 'input');
  } finally {
    f.stream.close();
  }
});

test('malformed or foreign authorization acknowledgements fail closed and finish their request', async () => {
  for (const mutation of [
    { epoch: randomUUID() },
    { requestId: 'not-a-uuid' },
    { sequence: -1 },
    { sequence: 1 },
    { sequence: 0.5 },
    { approved: 'true' },
    { approved: undefined },
    { extra: true },
  ]) {
    const f = fixture();
    f.start();
    const { epoch } = f.stream.inputDelivery;
    const requestId = randomUUID();
    const pending = f.stream.authorizeEditor(requestId, { epoch, sequence: 0 }, new AbortController().signal);
    f.channel.frame({ type: 'editor-authorized', epoch, sequence: 0, requestId, approved: true, ...mutation });
    assert.equal(await pending, false);
    assert.equal(f.stream.destroyed, true);
    assert.equal(
      f.channel.writes.some((frame) => frame.type === 'input'),
      false,
    );
  }
});

test('exit and close cancel editor authorization before an asynchronous channel close', async () => {
  for (const ending of ['exit', 'close'] as const) {
    const f = fixture();
    f.start();
    f.channel.deferClose = true;
    const { epoch } = f.stream.inputDelivery;
    const pending = f.stream.authorizeEditor(randomUUID(), { epoch, sequence: 0 }, new AbortController().signal);
    if (ending === 'exit') f.channel.frame({ type: 'exit', epoch, code: 0 });
    else f.stream.close();
    assert.equal(await pending, false);
    assert.equal(f.stream.originalShellPID, null);
    assert.equal(
      await f.stream.authorizeEditor(randomUUID(), { epoch, sequence: 0 }, new AbortController().signal),
      false,
    );
    f.stream.close();
  }
});
