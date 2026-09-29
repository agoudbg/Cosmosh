import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { ShellEditorRequest, ShellInputBoundary } from '@cosmosh/api-contract';
import type { ClientChannel } from 'ssh2';

import { executeShellEditorRequest } from '../../ssh/editor-exec.js';
import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { type EditorEvent, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

const installedBinary = '/home/cosmosh-bash/.local/share/cosmosh/bootstrap/bin/cosmosh-bootstrap';

before(() => installFixtureEditor('bash'));

/** @param state Original-Shell metadata. @param inputBoundary Real delivered input. @returns A native callback request. */
const snapshotRequest = (state: EditorEvent, inputBoundary: ShellInputBoundary): ShellEditorRequest => {
  assert.deepEqual(state.notification, { callback: 'readline' });
  return {
    requestId: randomUUID(),
    inputBoundary,
    operation: 'snapshot',
    promptGeneration: state.promptGeneration,
    includeDirectory: false,
    notification: state.notification,
    target: { instanceId: state.shellInstanceId, shell: 'bash', pid: state.pid, startTime: state.startTime },
  };
};

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
    assert.deepEqual(result.snapshot.buffer, { text: 'echo 中文🐟 tail', cursor: 8 });
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
  'real Bash native callback rejects PS2, nested read, and vi mode without executing text',
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
    const restored = await fixture.run('set -o emacs');
    assert.deepEqual(restored.notification, { callback: 'readline' });
    assert.equal((await fixture.request('snapshot')).status, 'ok');
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
      const cancelled = new AbortController();
      const late = await executeShellEditorRequest(
        terminal.client,
        installedBinary,
        snapshotRequest(state, await fixture.inputBoundary()),
        {
          signal: cancelled.signal,
          isCurrent: () => true,
          authorize: async () => assert.fail('read-only request cannot authorize a mutation'),
          revoke: () => {},
          trigger: () => cancelled.abort(),
        },
      );
      assert.equal(late.status, 'unavailable');
      state = await fixture.run(String.raw`builtin printf "CANCELLED_CALLBACK_ALIVE:%s\n" "$?"`);
      assert.match(terminal.readOutput(), /CANCELLED_CALLBACK_ALIVE:1\r?\n/u);
      assert.equal(terminal.readOutput().includes('\r\nERR_TRAP_FIRED\r\n'), false);
      for (let iteration = 0; iteration < 2; iteration++) {
        state = await fixture.run('. /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh');
        assert.deepEqual(state.notification, { callback: 'readline' });
        const offset = terminal.write(
          String.raw`builtin printf '\nNATIVE_BINDINGS_BEGIN\n'; builtin bind -m emacs-standard -X; builtin printf 'NATIVE_BINDINGS_END\n'; if builtin cosmosh_editor status; then builtin printf 'NATIVE_STATUS:owned\n'; else builtin printf 'NATIVE_STATUS:missing\n'; fi` +
            '\r',
        );
        await terminal.waitFor(
          /\r?\nNATIVE_BINDINGS_BEGIN\r?\nNATIVE_BINDINGS_END\r?\nNATIVE_STATUS:owned\r?\n/u,
          offset,
        );
        await fixture.prompt(state.promptGeneration);
        assert.equal((await fixture.request('snapshot')).status, 'ok');
      }
      await fixture.run('bind() { :; }; . /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh');
      terminal.write('echo native-callback-still-owned');
      const shadowedBind = await fixture.request('snapshot');
      assert.equal(shadowedBind.status, 'ok');
      if (shadowedBind.status === 'ok')
        assert.equal(shadowedBind.snapshot.buffer?.text, 'echo native-callback-still-owned');
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
      assert.equal(disabled.status, 'ok', 'native input capture must not depend on the Shell printf builtin');
      if (disabled.status === 'ok') assert.equal(disabled.snapshot.buffer?.text, 'echo private-disabled-printf');
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
    const request = snapshotRequest(state, await fixture.inputBoundary());
    const cancelled = await executeShellEditorRequest(terminal.client, installedBinary, request, {
      signal: controller.signal,
      isCurrent: () => true,
      authorize: async () => assert.fail('read-only request cannot authorize a mutation'),
      revoke: () => {},
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
  'real native editor endpoints reject competing workers and same-user foreign clients without losing ownership',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    const state = await fixture.prompt();
    const reading = terminal.write("builtin read -e -p $'\\nNATIVE_READER_WAIT>' fixture_read\r");
    await terminal.waitFor(/\r?\nNATIVE_READER_WAIT>/u, reading);
    const request = snapshotRequest(state, await fixture.inputBoundary());
    const controller = new AbortController();
    let ready = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = executeShellEditorRequest(terminal.client, installedBinary, request, {
      signal: controller.signal,
      isCurrent: () => true,
      trigger: ready,
      authorize: async () => assert.fail('read-only request cannot authorize a mutation'),
      revoke: () => {},
    });
    try {
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
          authorize: async () => assert.fail('read-only request cannot authorize a mutation'),
          revoke: () => {},
          trigger: () => {
            throw new Error('Competing worker must not obtain the endpoint');
          },
        },
      );
      assert.equal(second.status, 'unavailable');
      const foreign = await executeBoundedSshCommand(terminal.client, 'python3 -', {
        timeoutMs: 1_000,
        // Speak the actual native hello, so rejection cannot pass merely because the old JSON
        // widget protocol is incompatible. Without the peer check, this receives an opcode-2 request.
        stdin: [
          'import os, socket, struct',
          `packet = struct.pack(">BBIQ", 2, 1, ${state.pid}, ${state.promptGeneration})`,
          `for value in [${JSON.stringify(state.shellInstanceId)}, ${JSON.stringify(state.startTime)}]:`,
          '    raw = value.encode("ascii")',
          '    packet += struct.pack(">I", len(raw)) + raw',
          'with socket.socket(socket.AF_UNIX) as peer:',
          '    peer.settimeout(0.75)',
          `    peer.connect("/tmp/cosmosh-editor-" + str(os.getuid()) + "/${state.shellInstanceId}.sock")`,
          '    try:',
          '        peer.sendall(struct.pack(">I", len(packet)) + packet)',
          '        response = peer.recv(1)',
          '    except (BrokenPipeError, ConnectionResetError):',
          '        response = b""',
          '    print("rejected" if response == b"" else "WRONG", end="")',
        ].join('\n'),
      });
      assert.equal(foreign, 'rejected', 'an independent SSH exec has no ancestry in the original PTY Shell');
      assert.equal(
        await executeBoundedSshCommand(
          terminal.client,
          'test -S /tmp/cosmosh-editor-$(id -u)/' + state.shellInstanceId + '.sock && printf owned',
        ),
        'owned',
        'both rejections must preserve the original in-flight endpoint',
      );
    } finally {
      controller.abort();
      await pending;
    }
    terminal.write('\x03');
    await fixture.prompt(state.promptGeneration);
    assert.equal((await fixture.request('snapshot')).status, 'ok');
  },
);

test('real worker cleans its socket after abrupt SSH channel closure', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  const state = await fixture.prompt();
  const request = snapshotRequest(state, await fixture.inputBoundary());
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

test(
  'real Bash native callback ignores PTY signal-key remapping and never injects input',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    const state = await fixture.run('stty intr 9');
    terminal.write('echo unchanged');
    const request = snapshotRequest(state, await fixture.inputBoundary());
    const result = await executeShellEditorRequest(terminal.client, installedBinary, request, {
      signal: new AbortController().signal,
      isCurrent: () => true,
      trigger: () => {},
      authorize: async () => assert.fail('read-only request cannot authorize a mutation'),
      revoke: () => {},
    });
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.deepEqual(result.snapshot.buffer, { text: 'echo unchanged', cursor: 14 });
    const context = await fixture.request('context');
    assert.equal(context.status, 'ok');
    if (context.status === 'ok') assert.equal('buffer' in context.snapshot, false);
    terminal.write('\x15');
    await fixture.run('stty intr ^C');
    const restored = await fixture.request('snapshot');
    assert.equal(restored.status, 'ok');
    if (restored.status === 'ok') assert.equal(restored.snapshot.buffer?.text, '');
  },
);

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
