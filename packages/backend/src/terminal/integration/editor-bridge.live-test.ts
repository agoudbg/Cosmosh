import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type {
  RemoteShellEventMessage,
  ShellEditorBuffer,
  ShellEditorRequest,
  ShellEditorSnapshot,
} from '@cosmosh/api-contract';
import type { ClientChannel } from 'ssh2';

import { executeShellEditorRequest } from '../../ssh/editor-exec.js';
import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { type FixtureTerminal, openFixtureTerminal } from './fixture-client.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const binary = path.join(workspace, '.cosmosh/terminal-fixture/cosmosh-bootstrap-linux-amd64');
const installedBinary = '/home/cosmosh-bash/.local/share/cosmosh/bootstrap/bin/cosmosh-bootstrap';
type EditorEvent = Extract<RemoteShellEventMessage, { event: 'editor-state' }>;

before(async () => {
  execFileSync('go', ['build', '-o', binary, './cmd/cosmosh-bootstrap'], {
    cwd: path.join(workspace, 'packages/remote-bootstrap'),
    env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
    timeout: 60_000,
    stdio: 'pipe',
  });
  const terminal = await openFixtureTerminal('bash');
  try {
    await new Promise<void>((resolve, reject) =>
      terminal.client.sftp((error, sftp) => {
        if (error) {
          reject(error);
          return;
        }
        sftp.fastPut(binary, '/home/cosmosh-bash/fixture-bootstrap', { mode: 0o700 }, (error) => {
          sftp.end();
          if (error) reject(error);
          else resolve();
        });
      }),
    );
    const result = await executeBoundedSshCommand(
      terminal.client,
      '/home/cosmosh-bash/fixture-bootstrap install --shell bash --version fixture-v3',
    );
    assert.match(result ?? '', /"state":"(?:ok|skipped)"/u);
  } finally {
    terminal.close();
  }
});

/** Real helper event observer; it never infers a prompt from rendered screen text. */
class EditorFixture {
  private parser = new RemoteShellEventOscParser();
  private offset = 0;
  private latest: EditorEvent | null = null;
  /** @param terminal Actual disposable SSH PTY. */
  constructor(readonly terminal: FixtureTerminal) {}
  /** @returns The latest original helper editor epoch. */
  collect(): EditorEvent | null {
    const output = this.terminal.readOutput(this.offset);
    this.offset += output.length;
    for (const frame of this.parser.parse(output))
      if (frame.type === 'event' && frame.event.event === 'editor-state') this.latest = frame.event;
    return this.latest;
  }
  /** @param after Previous epoch. @returns A newly observed real editor epoch. */
  async prompt(after = 0): Promise<EditorEvent> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const event = this.collect();
      if (event && event.promptGeneration > after) return event;
      await delay(10);
    }
    throw new Error('Actual editor epoch did not arrive: ' + JSON.stringify(this.latest));
  }
  /** @param command Fixture-owned command. @returns Its next editor epoch. */
  async run(command: string): Promise<EditorEvent> {
    const generation = this.collect()?.promptGeneration ?? 0;
    this.terminal.write(command + '\r');
    return await this.prompt(generation);
  }
  /** @param operation Requested permission scope. @param expected Exact previous buffer. @param replacement Data-only edit.
   * @returns A result from the actual Go worker and actual Bash Readline. */
  async request(
    operation: 'context' | 'snapshot' | 'apply',
    expected?: ShellEditorSnapshot,
    replacement?: ShellEditorBuffer,
  ) {
    const event = await this.prompt();
    assert.equal(event.available, true, 'real helper must own its editor bindings');
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      target: { instanceId: event.shellInstanceId, shell: 'bash', pid: event.pid, startTime: event.startTime },
      operation,
      promptGeneration: event.promptGeneration,
      includeDirectory: true,
      ...(expected ? { expected } : {}),
      ...(replacement ? { replacement } : {}),
    };
    return await executeShellEditorRequest(this.terminal.client, installedBinary, request, {
      signal: new AbortController().signal,
      isCurrent: () => true,
      trigger: () => this.terminal.write('\x1b[997;' + event.triggerNonce + '~'),
    });
  }
}

test(
  'real Bash editor captures Unicode, applies data atomically, and preserves native undo',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    terminal.write('echo 中文🐟 tail\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D');
    const result = await fixture.request('snapshot');
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.snapshot.buffer, { text: 'echo 中文🐟 tail', cursor: 9 });
    assert.equal(result.snapshot.directory?.logical, '/home/cosmosh-bash');
    const replaced = await fixture.request('apply', result.snapshot, {
      text: 'echo injected $(touch /tmp/cosmosh-editor-must-not-execute)',
      cursor: 5,
    });
    assert.deepEqual(replaced, { status: 'applied' });
    const actual = await fixture.request('snapshot');
    assert.equal(actual.status, 'ok');
    if (actual.status === 'ok') assert.equal(actual.snapshot.buffer?.cursor, 5);
    assert.equal(
      await executeBoundedSshCommand(terminal.client, 'test ! -e /tmp/cosmosh-editor-must-not-execute && printf safe'),
      'safe',
    );
    terminal.write('\x1f');
    const undone = await fixture.request('snapshot');
    assert.equal(undone.status, 'ok');
    if (undone.status === 'ok') assert.equal(undone.snapshot.buffer?.text, 'echo 中文🐟 tail');
    terminal.write('x');
    assert.deepEqual(await fixture.request('apply', result.snapshot, { text: 'echo stale', cursor: 10 }), {
      status: 'stale',
    });
    const context = await fixture.request('context');
    assert.equal(context.status, 'ok');
    if (context.status === 'ok')
      assert.equal('buffer' in context.snapshot, false, 'context permission must never transfer input');
    const generation = fixture.collect()!.promptGeneration;
    terminal.write('\x03');
    await fixture.prompt(generation);
    await fixture.run('false');
    terminal.write('printf "EXIT_STATUS:%s\\n" "$?"\r');
    await terminal.waitFor(/EXIT_STATUS:1\r?\n/u);
  },
);

test(
  'real Bash rejects PS2, read, vi command mode, and removed bindings without executing text',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    const initial = await fixture.prompt();
    terminal.write("echo ok\recho '\r");
    await fixture.prompt(initial.promptGeneration);
    assert.deepEqual(await fixture.request('context'), { status: 'unavailable' });
    let generation = fixture.collect()!.promptGeneration;
    terminal.write('\x03');
    await fixture.prompt(generation);
    terminal.write('read -e fixture_read\r');
    await terminal.waitFor(/read -e fixture_read/u);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unavailable' });
    generation = fixture.collect()!.promptGeneration;
    terminal.write('\x03');
    await fixture.prompt(generation);
    const vi = await fixture.run('set -o vi');
    assert.equal(vi.available, false, 'Bash vi keymaps currently keep native behavior with the editor bridge paused');
    await fixture.run('set -o emacs');
    const disabled = await fixture.run('bind -m emacs-standard -r "\\e[997;$__COSMOSH_EDITOR_NONCE~"');
    assert.equal(disabled.available, false);
    assert.equal(
      await executeBoundedSshCommand(terminal.client, 'test ! -e /tmp/cosmosh-editor-must-not-execute && printf safe'),
      'safe',
    );
  },
);

test(
  'real Bash keeps errexit alive, preserves source ownership, and never routes editor text through user printf or tracing',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    const tracePath = '/home/cosmosh-bash/editor-trace-' + randomUUID();
    const printfPath = '/home/cosmosh-bash/editor-printf-' + randomUUID();
    try {
      let state = await fixture.run(String.raw`set -e; trap 'builtin printf "ERR_TRAP_FIRED\n"' ERR`);
      state = await fixture.run('false && true');
      assert.equal(
        (await fixture.request('snapshot')).status,
        'ok',
        'nonzero previous status must not terminate a successful widget under errexit',
      );
      terminal.write('\x1b[997;' + state.triggerNonce + '~');
      await delay(200);
      state = await fixture.run(String.raw`builtin printf "LATE_KEY_ALIVE:%s\n" "$?"`);
      assert.match(terminal.readOutput(), /LATE_KEY_ALIVE:1\r?\n/u);
      assert.equal(terminal.readOutput().includes('\r\nERR_TRAP_FIRED\r\n'), false);
      await fixture.run('. /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh');
      const count = terminal.write(
        String.raw`builtin bind -m emacs-standard -X | command grep -c __cosmosh_bash_editor; builtin printf "BIND_COUNT_END\n"` +
          '\r',
      );
      await terminal.waitFor(/2\r?\nBIND_COUNT_END/u, count);
      await fixture.prompt(state.promptGeneration + 1);
      await fixture.run('bind() { :; }; . /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh');
      terminal.write('echo binding-still-owned');
      const shadowedBind = await fixture.request('snapshot');
      assert.equal(shadowedBind.status, 'ok');
      if (shadowedBind.status === 'ok') assert.equal(shadowedBind.snapshot.buffer?.text, 'echo binding-still-owned');
      const shadowGeneration = fixture.collect()!.promptGeneration;
      terminal.write('\x03');
      await fixture.prompt(shadowGeneration);
      await fixture.run('unset -f bind');
      await fixture.run(
        String.raw`set +e; exec 9>` +
          tracePath +
          String.raw`; BASH_XTRACEFD=9; __COSMOSH_BASH_PREV_DEBUG_CMD='builtin printf "%s\n" "$BASH_COMMAND" >&9'; printf() { builtin printf "%s\n" "$*" >>` +
          printfPath +
          '; builtin printf "$@"; }; set -xT',
      );
      const secret = 'PRIVATE_EDITOR_' + randomUUID();
      terminal.write('echo ' + secret);
      const result = await fixture.request('snapshot');
      assert.equal(result.status, 'ok');
      if (result.status === 'ok') assert.equal(result.snapshot.buffer?.text, 'echo ' + secret);
      const context = await fixture.request('context');
      assert.equal(context.status, 'ok');
      const trace = await executeBoundedSshCommand(terminal.client, 'cat ' + tracePath + ' ' + printfPath);
      assert.equal(
        trace?.includes(secret),
        false,
        'unexecuted editor text must not reach xtrace, user DEBUG or printf override',
      );
      const generation = fixture.collect()!.promptGeneration;
      terminal.write('\x03');
      await fixture.prompt(generation);
      await fixture.run('set +xT; unset __COSMOSH_BASH_PREV_DEBUG_CMD; unset -f printf; enable -n printf');
      terminal.write('echo private-disabled-printf');
      const disabled = await fixture.request('snapshot');
      assert.equal(disabled.status, 'unavailable', 'disabled builtin must fail closed without external printf argv');
      terminal.write('\x03');
    } finally {
      await executeBoundedSshCommand(terminal.client, 'rm -f -- ' + tracePath + ' ' + printfPath);
    }
  },
);

test(
  'real Bash rejects user macros and prompt replacement without reclaiming user configuration',
  { timeout: 60_000 },
  async (t) => {
    for (const command of [
      String.raw`bind '"\e[993~": "echo macro-one\C-Mread -s fixture_secret\C-M"'`,
      String.raw`bind '"x": shell-expand-line'`,
      String.raw`PS2='user continuation> '`,
      'shopt -u promptvars',
    ]) {
      const terminal = await openFixtureTerminal('bash');
      t.after(() => terminal.close());
      try {
        const fixture = new EditorFixture(terminal);
        await fixture.prompt();
        const state = await fixture.run(command);
        assert.equal(state.available, false, 'unsupported user configuration must withdraw private editor access');
        if (command.startsWith('PS2=')) {
          const offset = terminal.write(String.raw`builtin printf 'PS2_VALUE:%s\n' "$PS2"` + '\r');
          await terminal.waitFor(/PS2_VALUE:user continuation> \r?\n/u, offset);
        }
      } finally {
        terminal.close();
      }
    }
  },
);

test(
  'real Bash bounds complete input, preserves read-only undo and cleans cancelled worker sockets',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    let state = await fixture.prompt();
    terminal.write('echo untouched');
    assert.equal((await fixture.request('snapshot')).status, 'ok');
    terminal.write('\x1f');
    const undone = await fixture.request('snapshot');
    assert.equal(undone.status, 'ok');
    if (undone.status === 'ok')
      assert.equal(undone.snapshot.buffer?.text, '', 'read-only snapshots must not add an undo entry');
    terminal.write('x'.repeat(8192));
    const maximum = await fixture.request('snapshot');
    assert.equal(maximum.status, 'ok');
    if (maximum.status === 'ok') assert.equal(maximum.snapshot.buffer?.text.length, 8192);
    terminal.write('x');
    assert.equal((await fixture.request('snapshot')).status, 'unavailable');
    terminal.write('\x03');
    state = await fixture.prompt(state.promptGeneration);
    const controller = new AbortController();
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      operation: 'snapshot',
      promptGeneration: state.promptGeneration,
      includeDirectory: false,
      target: { instanceId: state.shellInstanceId, shell: 'bash', pid: state.pid, startTime: state.startTime },
    };
    const cancelled = await executeShellEditorRequest(terminal.client, installedBinary, request, {
      signal: controller.signal,
      isCurrent: () => true,
      trigger: () => controller.abort(),
    });
    assert.equal(cancelled.status, 'unavailable');
    const cleaned = await executeBoundedSshCommand(
      terminal.client,
      String.raw`for endpoint in /tmp/cosmosh-editor-*/` +
        state.shellInstanceId +
        String.raw`.sock; do if [ -e "$endpoint" ]; then exit 1; fi; done; printf clean`,
    );
    assert.equal(cleaned, 'clean');
    assert.equal((await fixture.request('context')).status, 'ok');
  },
);

test(
  'real editor endpoints reject competing workers and same-user foreign widgets without losing ownership',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    const state = await fixture.prompt();
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      operation: 'snapshot',
      promptGeneration: state.promptGeneration,
      includeDirectory: false,
      target: { instanceId: state.shellInstanceId, shell: 'bash', pid: state.pid, startTime: state.startTime },
    };
    let ready = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = executeShellEditorRequest(terminal.client, installedBinary, request, {
      signal: new AbortController().signal,
      isCurrent: () => true,
      trigger: ready,
    });
    await Promise.race([
      waiting,
      pending.then(() => {
        throw new Error('First worker did not become ready');
      }),
    ]);
    const second = await executeShellEditorRequest(
      terminal.client,
      installedBinary,
      { ...request, requestId: randomUUID() },
      {
        signal: new AbortController().signal,
        isCurrent: () => true,
        trigger: () => {
          throw new Error('Competing worker must not obtain the endpoint');
        },
      },
    );
    assert.equal(second.status, 'unavailable');
    const foreign = await executeBoundedSshCommand(
      terminal.client,
      installedBinary +
        ' editor-widget mode ' +
        state.shellInstanceId +
        ' bash ' +
        state.pid +
        ' ' +
        state.startTime +
        ' ' +
        state.promptGeneration +
        ' emacs && printf WRONG || printf rejected',
    );
    assert.equal(foreign, 'rejected', 'an independent SSH exec has no ancestry in the original PTY Shell');
    terminal.write('\x1b[997;' + state.triggerNonce + '~');
    const result = await pending;
    assert.equal(result.status, 'ok', 'legitimate widget still owns the original endpoint after both rejections');
    assert.equal((await fixture.request('snapshot')).status, 'ok');
  },
);

test('real worker cleans its socket after abrupt SSH channel closure', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  const state = await fixture.prompt();
  const request: ShellEditorRequest = {
    requestId: randomUUID(),
    operation: 'snapshot',
    promptGeneration: state.promptGeneration,
    includeDirectory: false,
    target: { instanceId: state.shellInstanceId, shell: 'bash', pid: state.pid, startTime: state.startTime },
  };
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    terminal.client.exec(installedBinary + ' editor-request', (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
  channel.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    let pending = '';
    channel.on('error', reject);
    channel.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      if (pending.includes('"phase":"ready"')) resolve();
    });
    channel.write(JSON.stringify(request) + '\n');
  });
  const closed = new Promise<void>((resolve) => channel.once('close', resolve));
  channel.destroy();
  await closed;
  const deadline = Date.now() + 2_000;
  let cleaned = false;
  while (Date.now() < deadline) {
    cleaned =
      (await executeBoundedSshCommand(
        terminal.client,
        'test ! -e /tmp/cosmosh-editor-$(id -u)/' + state.shellInstanceId + '.sock && printf clean',
      )) === 'clean';
    if (cleaned) break;
    await delay(20);
  }
  assert.equal(cleaned, true, 'abrupt channel loss must not strand an endpoint that blocks later requests');
  assert.equal((await fixture.request('snapshot')).status, 'ok');
});

test('real editor refuses a private key that the PTY would interpret as a signal', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await fixture.prompt();
  const state = await fixture.run('stty intr 9');
  let triggered = false;
  const request: ShellEditorRequest = {
    requestId: randomUUID(),
    operation: 'snapshot',
    promptGeneration: state.promptGeneration,
    includeDirectory: false,
    target: { instanceId: state.shellInstanceId, shell: 'bash', pid: state.pid, startTime: state.startTime },
  };
  const result = await executeShellEditorRequest(terminal.client, installedBinary, request, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    trigger: () => {
      triggered = true;
      terminal.write('\x1b[997;' + state.triggerNonce + '~');
    },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(triggered, false, 'terminal line discipline must be checked before any private PTY bytes');
  await fixture.run('stty intr ^C');
  const restored = await fixture.request('snapshot');
  assert.equal(restored.status, 'ok');
  if (restored.status === 'ok') assert.equal(restored.snapshot.buffer?.text, '');
});

test(
  'real Bash preserves user prompt status and order under errexit and cancellation',
  { timeout: 60_000 },
  async (t) => {
    for (const array of [false, true]) {
      const terminal = await openFixtureTerminal('bash');
      t.after(() => terminal.close());
      try {
        const fixture = new EditorFixture(terminal);
        await fixture.prompt();
        const first = String.raw`builtin printf 'FIRST_STATUS:%s\n' "$?";`;
        const second = String.raw`builtin printf 'SECOND_STATUS:%s\n' "$?"`;
        /** @param value Fixture-owned literal command. @returns Shell data preserving literal status expansions. */
        const quoted = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
        const command = array
          ? 'PROMPT_COMMAND=(' + quoted(first) + ' ' + quoted(second) + ')'
          : 'PROMPT_COMMAND=' + quoted(first);
        await fixture.run(
          'trap - DEBUG; unset __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED; ' +
            command +
            '; . /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh',
        );
        let state = await fixture.run('set -e');
        const failed = terminal.write('false && true\r');
        state = await fixture.prompt(state.promptGeneration);
        await terminal.waitFor(/FIRST_STATUS:1\r?\n/u, failed);
        if (array) await terminal.waitFor(/SECOND_STATUS:1\r?\n/u, failed);
        const cancelled = terminal.write('\x03');
        await fixture.prompt(state.promptGeneration);
        await terminal.waitFor(/FIRST_STATUS:130\r?\n/u, cancelled);
        if (array) await terminal.waitFor(/SECOND_STATUS:130\r?\n/u, cancelled);
        terminal.write(
          "trap - DEBUG; unset __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED; PROMPT_COMMAND='false'; . /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh\r",
        );
        assert.equal(await terminal.waitForExit(), 1, 'existing user prompt failures retain native errexit behavior');
      } finally {
        terminal.close();
      }
    }
  },
);

test(
  'real Bash preserves user DEBUG status, extdebug skipping and native errexit failures',
  { timeout: 60_000 },
  async (t) => {
    for (const extended of [false, true]) {
      const terminal = await openFixtureTerminal('bash');
      t.after(() => terminal.close());
      try {
        const fixture = new EditorFixture(terminal);
        await fixture.prompt();
        await fixture.run(String.raw`__COSMOSH_BASH_PREV_DEBUG_CMD='builtin printf "DEBUG_STATUS:%s\n" "$?"'`);
        const state = await fixture.run('false && true');
        const observed = terminal.write(String.raw`builtin printf "TARGET_STATUS:%s\n" "$?"` + '\r');
        await fixture.prompt(state.promptGeneration);
        await terminal.waitFor(/DEBUG_STATUS:1\r?\n/u, observed);
        await terminal.waitFor(/TARGET_STATUS:1\r?\n/u, observed);
        await fixture.run('shopt ' + (extended ? '-s' : '-u') + ' extdebug');
        const guarded = await fixture.run(
          String.raw`__COSMOSH_BASH_PREV_DEBUG_CMD='case "$BASH_COMMAND" in *MUST_SKIP_COMMAND*) return 1 ;; esac'`,
        );
        const output = terminal.write(String.raw`builtin printf "MUST_SKIP_COMMAND\n"` + '\r');
        await fixture.prompt(guarded.promptGeneration);
        assert.equal(/MUST_SKIP_COMMAND\r?\n/u.test(terminal.readOutput(output)), !extended);
        await fixture.run('set -e');
        terminal.write(String.raw`builtin printf "MUST_SKIP_COMMAND\n"` + '\r');
        assert.equal(await terminal.waitForExit(), 1, 'user DEBUG failures keep native errexit behavior');
      } finally {
        terminal.close();
      }
    }
  },
);
