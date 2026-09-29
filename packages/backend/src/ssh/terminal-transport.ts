import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import type { Client, ClientChannel } from 'ssh2';

/** Minimal terminal surface shared by an ordinary SSH PTY and the framed remote PTY. */
export interface SshTerminalStream {
  readonly destroyed: boolean;
  /** @param input Original terminal bytes. @returns Transport backpressure state. */
  write(input: string | Uint8Array): boolean;
  /** @param rows Rows. @param cols Columns. @param height Pixel height. @param width Pixel width. @returns Nothing. */
  setWindow(rows: number, cols: number, height: number, width: number): void;
  /** @returns Nothing; closes the owning terminal. */
  close(): void;
  /** @param event Close event. @param listener Lifetime observer. @returns The event source. */
  on(event: 'close', listener: () => void): unknown;
  /** @param event Close event. @param listener Lifetime observer. @returns The event source. */
  off(event: 'close', listener: () => void): unknown;
}

/** Explicit session identity and input boundary; delivery is not Shell consumption. */
export type InputDelivery = { epoch: string; sent: number; delivered: number };

/** Startup outcome separates a safe pre-start fallback from an ambiguous Shell start. */
export type OpenDeliveredTerminalResult =
  { status: 'ready'; stream: DeliveredTerminal } | { status: 'unavailable' | 'failed' };

/** Required initial PTY dimensions and visible-output sink. */
export type DeliveredTerminalOptions = {
  cols: number;
  rows: number;
  term: string;
  onOutput: (data: string) => void;
};

const MAX_FRAME_BYTES = 96 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

/** @param value Untrusted JSON value. @returns Whether it is a plain protocol record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param value Encoded bytes. @returns Strictly decoded, bounded terminal bytes or null. */
const decodeData = (value: unknown): Buffer | null => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= MAX_INPUT_BYTES && bytes.toString('base64') === value ? bytes : null;
};

/**
 * Connection-scoped ordered terminal transport. It never retains decoded input after write,
 * never replays input, and never treats terminal output as a control frame.
 */
export class DeliveredTerminal extends EventEmitter {
  public destroyed = false;
  private readonly epoch = randomUUID();
  private readonly decoder = new StringDecoder('utf8');
  private readonly outputDecoder = new StringDecoder('utf8');
  private pending = '';
  private noiseBytes = 0;
  private started = false;
  private ready = false;
  private exited = false;
  private sentSequence = 0;
  private deliveredSequence = 0;
  private pendingInputBytes = 0;
  private readonly inputSizes = new Map<number, number>();
  private readonly startupTimer: NodeJS.Timeout;

  /**
   * @param channel Private SSH exec channel; no outer PTY.
   * @param options Initial terminal parameters and output callback.
   * @param complete One-shot startup result callback.
   */
  public constructor(
    private readonly channel: ClientChannel,
    private readonly options: DeliveredTerminalOptions,
    private readonly complete: (result: OpenDeliveredTerminalResult) => void,
  ) {
    super();
    this.startupTimer = setTimeout(() => this.fail(), 10_000);
    this.startupTimer.unref();
    channel.stderr.resume();
    channel.on('error', () => this.fail());
    channel.on('close', () => this.finish());
    channel.on('data', (chunk: Buffer) => this.receive(chunk));
  }

  /** @returns Current metadata without input bytes; reconnecting a WebSocket does not reset it. */
  public get inputDelivery(): InputDelivery {
    return { epoch: this.epoch, sent: this.sentSequence, delivered: this.deliveredSequence };
  }

  /**
   * Assigns sequence numbers synchronously before transport buffering, including password fills.
   * @param input Original UTF-8 input or bytes. @returns Whether the SSH writer can accept more data.
   */
  public write(input: string | Uint8Array): boolean {
    if (!this.ready || this.destroyed || this.exited) throw new Error('Terminal transport is closed.');
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
    if (bytes.length === 0) return true;
    const chunks = Math.ceil(bytes.length / MAX_INPUT_BYTES);
    if (
      bytes.length + this.pendingInputBytes > MAX_PENDING_BYTES ||
      !Number.isSafeInteger(this.sentSequence + chunks)
    ) {
      this.fail();
      throw new Error('Terminal input exceeded its delivery budget.');
    }
    let writable = true;
    for (let offset = 0; offset < bytes.length; offset += MAX_INPUT_BYTES) {
      const chunk = bytes.subarray(offset, offset + MAX_INPUT_BYTES);
      this.sentSequence += 1;
      this.inputSizes.set(this.sentSequence, chunk.length);
      this.pendingInputBytes += chunk.length;
      writable =
        this.send({ type: 'input', epoch: this.epoch, sequence: this.sentSequence, data: chunk.toString('base64') }) &&
        writable;
    }
    return writable;
  }

  /** @param rows New rows. @param cols New columns. @returns Nothing; dimensions travel after preceding input. */
  public setWindow(rows: number, cols: number): void {
    if (this.destroyed || this.exited || !this.ready) return;
    if (!Number.isInteger(rows) || rows < 10 || rows > 200 || !Number.isInteger(cols) || cols < 20 || cols > 400)
      return;
    this.send({ type: 'resize', epoch: this.epoch, rows, cols });
  }

  /**
   * Waits for bytes to reach the remote PTY, never for the Shell to interpret them.
   * @param sequence Previously accepted sequence. @param signal Request cancellation.
   * @returns Whether the boundary was delivered while the session remained alive.
   */
  public waitForDelivery(sequence: number, signal: AbortSignal): Promise<boolean> {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sentSequence) return Promise.resolve(false);
    return new Promise((resolve) => {
      /** @param result Final result. @returns Nothing; all listeners are removed. */
      const finish = (result: boolean): void => {
        clearTimeout(timer);
        this.off('delivery', inspect);
        this.off('close', inspect);
        this.off('exit', inspect);
        signal.removeEventListener('abort', inspect);
        resolve(result);
      };
      /** @returns Nothing; sequence progress and cancellation are checked together. */
      const inspect = (): void => {
        if (signal.aborted || this.destroyed || this.exited) finish(false);
        else if (this.deliveredSequence >= sequence) finish(true);
      };
      const timer = setTimeout(() => finish(false), 3000);
      this.on('delivery', inspect);
      this.on('close', inspect);
      this.on('exit', inspect);
      signal.addEventListener('abort', inspect, { once: true });
      inspect();
    });
  }

  /** @returns Nothing; closing never falls back or replays already submitted input. */
  public close(): void {
    this.fail();
  }

  /** @param value Fixed protocol record. @returns The underlying SSH backpressure state. */
  private send(value: Record<string, unknown>): boolean {
    if (this.channel.writableLength > MAX_PENDING_BYTES * 2) {
      this.fail();
      throw new Error('Terminal transport exceeded its write budget.');
    }
    try {
      return this.channel.write(JSON.stringify(value) + '\n');
    } catch {
      this.fail();
      throw new Error('Terminal transport write failed.');
    }
  }

  /** @param chunk Private channel bytes. @returns Nothing; frames never enter terminal display directly. */
  private receive(chunk: Buffer): void {
    if (this.destroyed) return;
    this.pending += this.decoder.write(chunk);
    let newline = this.pending.indexOf('\n');
    while (newline >= 0 && !this.destroyed) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') >= MAX_FRAME_BYTES) {
        this.fail();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = null;
      }
      if (!this.started && (!isRecord(value) || value.type !== 'hello')) {
        // A noninteractive login configuration may emit a bounded banner before exec.
        // Discard it without logging; it is not evidence that a terminal Shell started.
        this.noiseBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (this.noiseBytes > 8192) {
          this.fail();
          return;
        }
      } else if (!isRecord(value) || !this.handleFrame(value)) {
        this.fail();
        return;
      }
      newline = this.pending.indexOf('\n');
    }
    if (Buffer.byteLength(this.pending, 'utf8') >= (this.started ? MAX_FRAME_BYTES : 8192)) this.fail();
  }

  /** @param value Validated record shape. @returns Whether the frame is valid in the current phase. */
  private handleFrame(value: Record<string, unknown>): boolean {
    if (!this.started) {
      if (value.type !== 'hello' || value.protocol !== 1 || Object.keys(value).length !== 2) return false;
      // Mark before writing: any ambiguous write failure after this point forbids fallback.
      this.started = true;
      try {
        this.send({
          type: 'start',
          protocol: 1,
          epoch: this.epoch,
          cols: this.options.cols,
          rows: this.options.rows,
          term: this.options.term,
        });
      } catch {
        return false;
      }
      return true;
    }
    if (value.epoch !== this.epoch || this.exited) return false;
    if (!this.ready) {
      if (
        value.type !== 'ready' ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        Object.keys(value).length !== 3
      )
        return false;
      this.ready = true;
      clearTimeout(this.startupTimer);
      this.complete({ status: 'ready', stream: this });
      return true;
    }
    if (Object.keys(value).length !== 3) return false;
    if (value.type === 'output') {
      const data = decodeData(value.data);
      if (!data) return false;
      this.options.onOutput(this.outputDecoder.write(data));
      return true;
    }
    if (value.type === 'delivered') {
      const sequence = value.sequence;
      if (
        !Number.isSafeInteger(sequence) ||
        sequence !== this.deliveredSequence + 1 ||
        (sequence as number) > this.sentSequence
      )
        return false;
      this.deliveredSequence = sequence as number;
      this.pendingInputBytes -= this.inputSizes.get(this.deliveredSequence) ?? 0;
      this.inputSizes.delete(this.deliveredSequence);
      this.emit('delivery');
      return true;
    }
    if (
      value.type === 'exit' &&
      Number.isInteger(value.code) &&
      (value.code as number) >= 0 &&
      (value.code as number) <= 255
    ) {
      this.exited = true;
      this.emit('exit', value.code);
      this.channel.close();
      return true;
    }
    return false;
  }

  /** @returns Nothing; only a known pre-start failure allows opening an ordinary SSH PTY. */
  private finish(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.startupTimer);
    if (!this.ready) this.complete({ status: this.started ? 'failed' : 'unavailable' });
    const tail = this.outputDecoder.end();
    if (tail) this.options.onOutput(tail);
    this.pending = '';
    this.inputSizes.clear();
    this.pendingInputBytes = 0;
    this.emit('close');
  }

  /** @returns Nothing; SSH EOF lets the helper hang up its owned PTY and reap its Shell. */
  private fail(): void {
    this.finish();
    this.channel.destroy();
  }
}

/**
 * Opens the installed helper over a private exec channel, then performs a two-phase start.
 * @param client Authenticated session owner. @param binaryPath Previously validated helper path.
 * @param options PTY parameters and display output. @returns Ready transport or bounded failure.
 */
export const openDeliveredTerminal = (
  client: Client,
  binaryPath: string,
  options: DeliveredTerminalOptions,
): Promise<OpenDeliveredTerminalResult> =>
  new Promise((resolve) => {
    if (
      !binaryPath.startsWith('/') ||
      binaryPath.includes('\0') ||
      Buffer.byteLength(binaryPath, 'utf8') > 4096 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/u.test(options.term)
    ) {
      resolve({ status: 'unavailable' });
      return;
    }
    let settled = false;
    /** @param result Handshake outcome. @returns Nothing; late callbacks cannot create another terminal. */
    const finish = (result: OpenDeliveredTerminalResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'unavailable' }), 10_000);
    timer.unref();
    try {
      client.exec(
        "'" + binaryPath.replaceAll("'", "'\\''") + "' session",
        { env: { LANG: 'C.UTF-8', LC_CTYPE: 'C.UTF-8' } },
        (error, channel) => {
          if (settled) {
            channel?.destroy();
            return;
          }
          if (error) {
            finish({ status: 'unavailable' });
            return;
          }
          clearTimeout(timer);
          new DeliveredTerminal(channel, options, finish);
        },
      );
    } catch {
      finish({ status: 'unavailable' });
    }
  });
