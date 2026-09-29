import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { openDeliveredTerminal } from '../../ssh/terminal-transport.js';
import { editorBinaryPath, installFixtureEditor } from './editor-fixture.js';
import { type FixtureShell, openFixtureTerminal } from './fixture-client.js';

/** @param stream Actual event source. @param event Expected event. @returns A bounded remote event observation. */
const waitEvent = (stream: EventEmitter, event: string): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.off(event, onEvent);
      reject(new Error('Missing forwarder event: ' + event));
    }, 5000);
    /** @param values Actual event data. @returns Nothing. */
    const onEvent = (...values: unknown[]): void => {
      clearTimeout(timer);
      resolve(values);
    };
    stream.once(event, onEvent);
  });

/**
 * Opens the real production forwarder on the disposable SSH server.
 * @param shell Fixture account. @returns Bounded output capture and owned cleanup.
 */
const openForwarder = async (shell: FixtureShell = 'bash') => {
  const control = await openFixtureTerminal(shell);
  let output = '';
  let outputBytes = 0;
  const result = await openDeliveredTerminal(control.client, editorBinaryPath(shell), {
    rows: 32,
    cols: 120,
    term: 'xterm-256color',
    onOutput: (data) => {
      outputBytes += Buffer.byteLength(data, 'utf8');
      output += data;
      assert.ok(outputBytes <= 2 * 1024 * 1024, 'fixture output budget');
    },
  });
  if (result.status !== 'ready') {
    control.close();
    throw new Error('Actual input forwarder failed: ' + result.status);
  }
  const stream = result.stream;
  /** @param pattern Real PTY output. @param after Earlier capture position. @returns Actual matching bytes. */
  const expect = async (pattern: RegExp, after = 0): Promise<RegExpMatchArray> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = output.slice(after).match(pattern);
      if (found) return found;
      if (stream.destroyed) throw new Error('Actual forwarder closed before output: ' + pattern);
      await delay(10);
    }
    const visible = new RemoteShellEventOscParser()
      .parse(output)
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame.data)
      .join('');
    throw new Error(
      'Actual PTY output timed out: ' +
        pattern +
        ' prefix=' +
        JSON.stringify(visible.slice(0, 2200)) +
        ' tail=' +
        JSON.stringify(visible.slice(-200)),
    );
  };
  /** @param input Actual keyboard bytes. @returns Position preceding the write. */
  const write = (input: string): number => {
    const offset = output.length;
    stream.write(input);
    return offset;
  };
  /** @returns Delivery of all input accepted so far. */
  const delivered = () => stream.waitForDelivery(stream.inputDelivery.sent, new AbortController().signal);
  /** @returns Nothing; both channels belong only to this fixture test. */
  const close = (): void => {
    stream.close();
    control.close();
  };
  try {
    write("printf 'COSMOSH_%s\\n' 'FORWARDER_READY'\r");
    await expect(/COSMOSH_FORWARDER_READY/u);
    assert.equal(await delivered(), true);
    // Test-only keyboard pacing: delivery itself does not prove entry into Readline.
    await delay(100);
  } catch (error) {
    close();
    throw error;
  }
  return { stream, control, write, expect, delivered, close, read: () => output };
};

test(
  'forwarded login Shell retains terminal identity, UTF-8, dimensions and input acknowledgements',
  { timeout: 90_000 },
  async () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      await installFixtureEditor(shell);
      const f = await openForwarder(shell);
      try {
        let offset = f.write('printf \'TERM:%s\\n\' "$TERM"; tty; stty size\r');
        await f.expect(/TERM:xterm-256color\r?\n/u, offset);
        await f.expect(/\/dev\/pts\/\d+\r?\n/u, offset);
        await f.expect(/32 120\r?\n/u, offset);
        f.stream.setWindow(48, 160);
        offset = f.write("stty size; printf 'VALUE:%s\\n' '中文😀'\r");
        await f.expect(/48 160\r?\n/u, offset);
        await f.expect(/VALUE:中文😀\r?\n/u, offset);
        assert.equal(await f.delivered(), true);
        assert.equal(f.stream.inputDelivery.delivered, f.stream.inputDelivery.sent);
        if (shell === 'bash') {
          offset = f.write(
            'shopt -q login_shell && printf \'LOGIN_%s\\n\' yes; test "$SSH_TTY" = "$(tty)" && printf \'TTY_%s\\n\' yes\r',
          );
          await f.expect(/LOGIN_yes\r?\n/u, offset);
          await f.expect(/TTY_yes\r?\n/u, offset);
        }
      } finally {
        f.close();
      }
    }
  },
);

test('password reads receive exact bytes without echo through the forwarder', { timeout: 30_000 }, async () => {
  const f = await openForwarder();
  try {
    const offset = f.write(
      'IFS= read -rs -p "$(printf \'SECRET_%s\' READY)" value; printf \'\\nRECEIVED:%s\\n\' "${#value}"\r',
    );
    await f.expect(/SECRET_READY/u, offset);
    const secret = 'fixture-' + randomUUID();
    const inputOffset = f.write(secret + '\r');
    await f.expect(new RegExp('RECEIVED:' + secret.length + '\\r?\\n', 'u'), inputOffset);
    assert.equal(f.read().slice(offset).includes(secret), false);
    assert.equal(await f.delivered(), true);
  } finally {
    f.close();
  }
});

test('Ctrl+C and native job suspend/resume keep foreground control', { timeout: 30_000 }, async () => {
  const f = await openForwarder();
  try {
    f.write("printf 'SLEEP_%s\\n' READY; sleep 30\r");
    await f.expect(/SLEEP_READY/u);
    f.write('\x03');
    let offset = f.write("printf 'INTERRUPTED_%s\\n' yes\r");
    await f.expect(/INTERRUPTED_yes\r?\n/u, offset);
    offset = f.write("printf 'JOB_%s\\n' READY; sleep 30\r");
    await f.expect(/JOB_READY/u, offset);
    offset = f.write('\x1a');
    await f.expect(/Stopped/u, offset);
    offset = f.write('fg\r');
    await f.expect(/sleep 30/u, offset);
    f.write('\x03');
    offset = f.write("printf 'RESUMED_%s\\n' yes\r");
    await f.expect(/RESUMED_yes\r?\n/u, offset);
  } finally {
    f.close();
  }
});

test('Vim and bracketed paste preserve native editing', { timeout: 30_000 }, async () => {
  const f = await openForwarder();
  const path = '/tmp/cosmosh-forwarder-' + randomUUID();
  try {
    let offset = f.write('vi -Nu NONE -n -i NONE -- ' + path + '\r');
    await f.expect(/\[\?1049h/u, offset);
    f.write('i中文 forwarder\x1b:wq\r');
    await f.expect(/\[\?1049l/u, offset);
    offset = f.write('cat -- ' + path + '; rm -- ' + path + '\r');
    await f.expect(/中文 forwarder\r?\n/u, offset);
    offset = f.write("\x1b[200~printf 'PASTE:%s\\n' 'space 中文'\x1b[201~\r");
    await f.expect(/PASTE:space 中文\r?\n/u, offset);
  } finally {
    f.close();
  }
});

test('exit status and Ctrl+D terminate the forwarded Shell once', { timeout: 30_000 }, async () => {
  for (const input of ['exit 7\r', '\x04']) {
    const f = await openForwarder();
    try {
      const exit = waitEvent(f.stream, 'exit');
      const closed = waitEvent(f.stream, 'close');
      const finished = Promise.all([exit, closed]);
      f.write(input);
      const [exitValues] = await finished;
      assert.deepEqual(exitValues, [input.startsWith('exit') ? 7 : 0]);
      assert.equal(f.stream.destroyed, true);
    } finally {
      f.close();
    }
  }
});

test(
  'Shell exit drains its tail but does not wait for a background process holding the PTY',
  { timeout: 30_000 },
  async () => {
    const f = await openForwarder();
    try {
      const closed = waitEvent(f.stream, 'close');
      const started = Date.now();
      const offset = f.write("sleep 3 & printf 'FINAL_%s\\n' OUTPUT; exit\r");
      await closed;
      assert.match(f.read().slice(offset), /FINAL_OUTPUT\r?\n/u);
      assert.ok(Date.now() - started < 2000, 'background PTY holder retained the connection');
    } finally {
      f.close();
    }
  },
);

test('disconnect interrupts heavy output and pending input without replay', { timeout: 30_000 }, async () => {
  const f = await openForwarder();
  try {
    f.write("printf 'OUTPUT_%s\\n' READY; yes x\r");
    await f.expect(/OUTPUT_READY/u);
    const epoch = f.stream.inputDelivery.epoch;
    const closed = waitEvent(f.stream, 'close');
    f.stream.close();
    await closed;
    assert.throws(() => f.stream.write('must-not-replay'), /closed/u);
    assert.equal(f.stream.inputDelivery.epoch, epoch);
  } finally {
    f.close();
  }
});
