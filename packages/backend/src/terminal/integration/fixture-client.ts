import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, type ClientChannel } from 'ssh2';

/** Shells installed in the isolated real-SSH fixture. */
export const FIXTURE_SHELLS = ['bash', 'zsh', 'fish'] as const;
/** One explicitly configured fixture account. */
export type FixtureShell = (typeof FIXTURE_SHELLS)[number];

/** Validated connection data written by the fixture controller. */
export type FixtureConnection = {
  host: '127.0.0.1';
  port: number;
  privateKey: Buffer;
  hostFingerprint: string;
};

/**
 * Read fixture credentials only from the ignored, checkout-local descriptor.
 * @returns Validated loopback connection data; missing fixtures fail explicitly.
 */
export function readFixtureConnection(): FixtureConnection {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const configPath = path.join(workspace, '.cosmosh/terminal-fixture/connection.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error('Real terminal fixture is unavailable. Run pnpm terminal:fixture start first.', { cause: error });
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('host' in raw) ||
    raw.host !== '127.0.0.1' ||
    !('port' in raw) ||
    typeof raw.port !== 'number' ||
    !Number.isInteger(raw.port) ||
    raw.port < 1 ||
    raw.port > 65535 ||
    !('hostFingerprint' in raw) ||
    typeof raw.hostFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.hostFingerprint) ||
    !('privateKeyPath' in raw) ||
    typeof raw.privateKeyPath !== 'string' ||
    path.resolve(raw.privateKeyPath) !== path.join(path.dirname(configPath), 'id_ed25519')
  ) {
    throw new Error('Invalid isolated terminal fixture connection descriptor.');
  }
  return {
    host: raw.host,
    port: raw.port,
    hostFingerprint: raw.hostFingerprint,
    privateKey: readFileSync(raw.privateKeyPath),
  };
}

/** Actual SSH PTY with bounded output capture and deadline-based expectations. */
export class FixtureTerminal {
  private readonly events = new EventEmitter();
  private output = '';
  private failure: Error | null = null;
  private disposed = false;
  private channelClosed = false;
  private exitCode: number | null = null;

  /**
   * Capture the real channel; never synthesize Shell output.
   * @param client Authenticated client owned by this fixture session.
   * @param channel Interactive channel owned by this fixture session.
   */
  constructor(
    readonly client: Client,
    readonly channel: ClientChannel,
  ) {
    channel.setEncoding('utf8');
    channel.on('data', (data: string) => {
      if (this.disposed) return;
      this.output += data;
      if (Buffer.byteLength(this.output, 'utf8') > 2 * 1024 * 1024) {
        this.fail(new Error('Fixture output exceeded its 2 MiB capture limit.'));
        this.close();
        return;
      }
      this.events.emit('output');
    });
    channel.on('error', (error: Error) => this.fail(error));
    client.on('error', (error: Error) => this.fail(error));
    channel.on('exit', (code: number | null) => {
      this.exitCode = code;
    });
    channel.on('close', () => {
      this.channelClosed = true;
      this.fail(new Error('Fixture PTY closed.'));
      this.events.emit('closed');
    });
  }

  /**
   * Forward bytes without interpreting terminal editing behavior.
   * @param input UTF-8 terminal input.
   * @returns Capture offset immediately before the write.
   */
  write(input: string): number {
    if (this.disposed || this.failure) throw this.failure ?? new Error('Fixture PTY is disposed.');
    const offset = this.output.length;
    this.channel.write(input);
    return offset;
  }

  /**
   * Reads the already bounded fixture-only PTY capture for protocol integration assertions.
   * @param after Character offset previously consumed by the test parser.
   * @returns Actual remote output, including untouched OSC framing.
   */
  readOutput(after = 0): string {
    return this.output.slice(after);
  }

  /**
   * Wait for actual output after a specified input boundary.
   * @param pattern Expected output expression.
   * @param after Capture offset returned by write.
   * @param timeoutMs Maximum waiting time.
   * @returns The matched output.
   */
  async waitFor(pattern: RegExp, after = 0, timeoutMs = 10_000): Promise<RegExpMatchArray> {
    return await new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (error: Error | null, match?: RegExpMatchArray): void => {
        if (timer) clearTimeout(timer);
        this.events.off('output', inspect);
        if (error) reject(error);
        else if (match) resolve(match);
      };
      const inspect = (): void => {
        const match = this.output.slice(after).match(pattern);
        if (match) finish(null, match);
        else if (this.failure) finish(this.failure);
      };
      timer = setTimeout(
        () =>
          finish(
            new Error(`Fixture output did not match ${pattern}; tail: ${JSON.stringify(this.output.slice(-2000))}`),
          ),
        timeoutMs,
      );
      this.events.on('output', inspect);
      inspect();
    });
  }

  /**
   * Observe real channel termination instead of treating test cleanup as Shell exit.
   * @param timeoutMs Maximum time to wait for the remote Shell to exit.
   * @returns Remote exit code, or null if the server closed without an exit status.
   */
  async waitForExit(timeoutMs = 5_000): Promise<number | null> {
    if (this.channelClosed) return this.exitCode;
    return await new Promise((resolve, reject) => {
      const onClose = (): void => {
        clearTimeout(timer);
        resolve(this.exitCode);
      };
      const timer = setTimeout(() => {
        this.events.off('closed', onClose);
        reject(new Error('Fixture Shell did not exit within its deadline.'));
      }, timeoutMs);
      this.events.once('closed', onClose);
    });
  }

  /**
   * Dispose test-owned transport resources on either success or failure.
   * @returns Nothing.
   */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error('Fixture PTY disposed.'));
    this.channel.destroy();
    this.client.destroy();
  }

  /**
   * Wake pending expectations on transport failures.
   * @param error Terminal transport failure.
   * @returns Nothing.
   */
  private fail(error: Error): void {
    this.failure ??= error;
    this.events.emit('output');
  }
}

/**
 * Authenticate against a pinned, loopback-only fixture and open a real PTY.
 * @param shell Fixture account and Shell to exercise.
 * @param executable Optional versioned fixture runtime; Bash can also use COSMOSH_FIXTURE_BASH_EXECUTABLE.
 * @param options Explicit fixture configuration, applied before the native reader starts.
 * @returns A session whose owner must close it in test cleanup.
 */
export async function openFixtureTerminal(
  shell: FixtureShell,
  executable?: string,
  options: {
    disableFishAutosuggestions?: boolean;
    privateFishHistory?: boolean;
    initialCommand?: string;
    fishHistoryDataDirectory?: string;
  } = {},
): Promise<FixtureTerminal> {
  executable ??= shell === 'bash' ? process.env.COSMOSH_FIXTURE_BASH_EXECUTABLE : undefined;
  if (
    (options.disableFishAutosuggestions ||
      options.privateFishHistory ||
      options.initialCommand ||
      options.fishHistoryDataDirectory) &&
    (!executable || shell !== 'fish')
  )
    throw new Error('Startup fixture configuration requires a versioned Fish runtime.');
  if (
    executable !== undefined &&
    !(
      (shell === 'fish' && /^\/opt\/cosmosh-fixture\/fish-[0-9.]+\/runtime\/bin\/fish$/u.test(executable)) ||
      (shell === 'bash' && /^\/opt\/cosmosh-fixture\/bash-[0-9.]+\/bin\/bash$/u.test(executable))
    )
  )
    throw new Error('Unsupported fixture Shell version path.');
  if (
    options.fishHistoryDataDirectory !== undefined &&
    !/^\/tmp\/cosmosh-fixture-history-[a-f0-9-]{36}$/u.test(options.fishHistoryDataDirectory)
  )
    throw new Error('History data directory must belong to a disposable fixture.');
  const connection = readFixtureConnection();
  const client = new Client();
  return await new Promise<FixtureTerminal>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => onError(new Error('Fixture PTY startup timed out.')), 15_000);
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      reject(error);
    };
    client.once('error', onError);
    client.once('ready', () => {
      /** @param error Real SSH startup failure. @param stream Opened fixture PTY. @returns Nothing. */
      const onOpen = (error: Error | undefined, stream: ClientChannel): void => {
        if (settled) {
          stream?.destroy();
          return;
        }
        if (error) {
          onError(error);
          return;
        }
        const terminal = new FixtureTerminal(client, stream);
        settled = true;
        client.off('error', onError);
        clearTimeout(timeout);
        resolve(terminal);
      };
      if (executable) {
        const commands = [
          options.disableFishAutosuggestions ? 'set -g fish_autosuggestion_enabled 0' : '',
          options.initialCommand,
        ]
          .filter(Boolean)
          .join('; ');
        const initializer = commands ? " --init-command '" + commands.replaceAll("'", "'\\''") + "'" : '';
        // Fish caches its data directory during startup, so set it before launching that process.
        const environment = options.fishHistoryDataDirectory
          ? "env XDG_DATA_HOME='" + options.fishHistoryDataDirectory + "' "
          : '';
        client.exec(
          shell === 'bash'
            ? executable + ' --noprofile --rcfile /home/cosmosh-bash/.bashrc -i'
            : environment +
                executable +
                ' --interactive' +
                (options.privateFishHistory ? ' --private' : '') +
                initializer,
          {
            pty: { term: 'xterm-256color', cols: 120, rows: 32 },
            env: { LANG: 'C.UTF-8', LC_CTYPE: 'C.UTF-8' },
          },
          onOpen,
        );
        return;
      }
      client.shell(
        { term: 'xterm-256color', cols: 120, rows: 32 },
        {
          env: { LANG: 'C.UTF-8', LC_CTYPE: 'C.UTF-8' },
        },
        onOpen,
      );
    });
    client.connect({
      ...connection,
      username: `cosmosh-${shell}`,
      readyTimeout: 10_000,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => fingerprint === connection.hostFingerprint,
    });
  });
}
