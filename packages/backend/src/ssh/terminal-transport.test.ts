import assert from 'node:assert/strict';
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
    channel.frame({ type: 'hello', protocol: 1 });
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
  after.channel.frame({ type: 'hello', protocol: 1 });
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
