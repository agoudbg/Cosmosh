import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { ShellEditorRequest } from '@cosmosh/api-contract';
import type { ClientChannel } from 'ssh2';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { editorBinaryPath, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

before(() => installFixtureEditor('zsh'));

test(
  'real Zsh invalidates asynchronous directory changes and freshly observes HOME',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    await fixture.run(
      '__fixture_chpwd_count=0; __fixture_chpwd() { (( ++__fixture_chpwd_count )); }; chpwd_functions+=(__fixture_chpwd); TRAPALRM() { builtin cd /tmp; TMOUT=0; }; TMOUT=1',
    );
    const offset = terminal.readOutput().length;
    await delay(1300);
    const frames = new RemoteShellEventOscParser().parse(terminal.readOutput(offset));
    assert.ok(frames.some((frame) => frame.type === 'event' && frame.event.event === 'cwd-invalidated'));
    const moved = await fixture.request('context');
    assert.equal(moved.status, 'ok');
    if (moved.status === 'ok') assert.equal(moved.snapshot.directory?.physical, '/tmp');
    const generation = fixture.collect()!.promptGeneration;
    const boundary = terminal.write('builtin printf "USER_CHPWD:%s\\n" "$__fixture_chpwd_count"\r');
    await terminal.waitFor(/USER_CHPWD:1\r?\n/u, boundary);
    await fixture.prompt(generation);
    await fixture.run('TRAPALRM() { HOME=/tmp; TMOUT=0; }; TMOUT=1');
    await delay(1300);
    const home = await fixture.request('context');
    assert.equal(home.status, 'ok');
    if (home.status === 'ok') assert.equal(home.snapshot.directory?.home, '/tmp');
  },
);

test(
  'real Zsh confirms the final combining-character cursor after its widget returns',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    await fixture.run('setopt combiningchars');
    terminal.write('echo original');
    const before = await fixture.request('snapshot');
    assert.equal(before.status, 'ok');
    if (before.status !== 'ok') return;
    assert.deepEqual(await fixture.request('apply', before.snapshot, { text: 'echo e\u0301x', cursor: 6 }), {
      status: 'unknown',
    });
    const after = await fixture.request('snapshot');
    assert.equal(after.status, 'ok');
    if (after.status !== 'ok') return;
    assert.deepEqual(after.snapshot.buffer, { text: 'echo e\u0301x', cursor: 7 });
    assert.deepEqual(await fixture.request('apply', after.snapshot, { text: 'echo e\u0301x', cursor: 7 }), {
      status: 'applied',
    });
    assert.deepEqual(await fixture.request('apply', after.snapshot, { text: 'echo 👩‍💻e\u0301x', cursor: 6 }), {
      status: 'unknown',
    });
    const zwj = await fixture.request('snapshot');
    assert.equal(zwj.status, 'ok');
    if (zwj.status === 'ok') assert.deepEqual(zwj.snapshot.buffer, { text: 'echo 👩‍💻e\u0301x', cursor: 7 });
  },
);

test(
  'real Zsh captures Unicode and applies exact data without replacing native keys',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    const initial = await fixture.prompt();
    assert.ok(initial.notification);
    terminal.write('echo 中文🐟 tail\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D');
    const snapshot = await fixture.request('snapshot');
    assert.equal(snapshot.status, 'ok');
    if (snapshot.status !== 'ok') return;
    assert.deepEqual(snapshot.snapshot.buffer, { text: 'echo 中文🐟 tail', cursor: 8 });
    assert.equal(snapshot.snapshot.directory?.logical, '/home/cosmosh-zsh');
    const replacement = { text: 'echo $(touch /tmp/cosmosh-zsh-edit-must-not-execute) tail', cursor: 5 };
    assert.deepEqual(await fixture.request('apply', snapshot.snapshot, replacement), { status: 'applied' });
    const actual = await fixture.request('snapshot');
    assert.equal(actual.status, 'ok');
    if (actual.status === 'ok') assert.deepEqual(actual.snapshot.buffer, replacement);
    assert.equal(
      await executeBoundedSshCommand(
        terminal.client,
        'test ! -e /tmp/cosmosh-zsh-edit-must-not-execute && printf safe',
      ),
      'safe',
    );
    terminal.write('\x1f');
    const undone = await fixture.request('snapshot');
    assert.equal(undone.status, 'ok');
    if (undone.status === 'ok') assert.equal(undone.snapshot.buffer?.text, 'echo 中文🐟 tail');
    terminal.write('x');
    assert.deepEqual(await fixture.request('apply', snapshot.snapshot, { text: 'stale', cursor: 5 }), {
      status: 'stale',
    });
    const context = await fixture.request('context');
    assert.equal(context.status, 'ok');
    if (context.status === 'ok') assert.equal('buffer' in context.snapshot, false);
    await fixture.cancel();
    await fixture.run('false');
    assert.equal((await fixture.request('context')).status, 'ok');
    const status = terminal.write('builtin printf "ZSH_STATUS:%s\\n" "$?"\r');
    await terminal.waitFor(/ZSH_STATUS:1\r?\n/u, status);
  },
);

test(
  'real Zsh rejects search, menus, continuations, recursive editing and partial keys',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    terminal.write('echo search\x12');
    await delay(100);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unsupported' });
    terminal.write('\x07');
    await delay(100);
    await fixture.cancel();
    await fixture.run(
      "zmodload zsh/complist; MENUSELECT=1; __fixture_complete() { compadd -Q alpha alpine amber; }; zle -C __fixture_menu menu-select __fixture_complete; bindkey '^Xc' __fixture_menu",
    );
    terminal.write('echo \x18c');
    await delay(100);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unsupported' });
    terminal.write('\x07');
    await delay(100);
    await fixture.cancel();
    terminal.write("echo '\r");
    await delay(100);
    assert.deepEqual(await fixture.request('context'), { status: 'unsupported' });
    await fixture.cancel();
    await fixture.run(
      "__fixture_recursive() { zle recursive-edit; }; zle -N __fixture_recursive; bindkey '^Xv' __fixture_recursive",
    );
    terminal.write('echo recursive\x18v');
    await delay(100);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unsupported' });
    terminal.write('\x07');
    await delay(100);
    await fixture.cancel();
    await fixture.run('KEYTIMEOUT=200');
    terminal.write('echo prefix\x1b');
    await delay(50);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unsupported' });
    terminal.write('[D');
    const resumed = await fixture.request('snapshot');
    assert.equal(resumed.status, 'ok');
    if (resumed.status === 'ok') assert.deepEqual(resumed.snapshot.buffer, { text: 'echo prefix', cursor: 10 });
    await fixture.cancel();
    await fixture.run('bindkey -v');
    terminal.write('echo vi');
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unsupported' });
  },
);

test(
  'real Zsh leaves password readers and queued commands alone, then resumes ordinary editing',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    const initial = await fixture.prompt();
    terminal.write('true\rread -r -s "fixture_secret?FIXTURE_SECRET> "\r');
    await terminal.waitFor(/FIXTURE_SECRET> /u);
    await fixture.prompt(initial.promptGeneration);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unavailable' });
    terminal.write('private-' + randomUUID() + '\r');
    await fixture.prompt(initial.promptGeneration + 1);
    terminal.write('echo resumed');
    const resumed = await fixture.request('snapshot');
    assert.equal(resumed.status, 'ok');
    if (resumed.status === 'ok') assert.equal(resumed.snapshot.buffer?.text, 'echo resumed');
    await fixture.cancel();
    terminal.write('fixture_value=original; vared fixture_value\r');
    await delay(100);
    assert.deepEqual(await fixture.request('snapshot'), { status: 'unsupported' });
    await fixture.cancel();
  },
);

test(
  'real Zsh cancels notification requests without retaining a key or disabling the prompt',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    terminal.write('echo cancel');
    const controller = new AbortController();
    assert.deepEqual(
      await fixture.request('snapshot', undefined, undefined, {
        signal: controller.signal,
        trigger: () => controller.abort(),
      }),
      { status: 'unavailable' },
    );
    const result = await fixture.request('snapshot');
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.equal(result.snapshot.buffer?.text, 'echo cancel');
    await fixture.cancel();
    const before = fixture.collect()!;
    const after = await fixture.run('source "$HOME/.config/cosmosh/bootstrap/helper.sh"');
    assert.deepEqual(after.notification, before.notification);
    const disabled = await fixture.run('zle -F "$__COSMOSH_EDITOR_NOTIFY_FD"');
    assert.equal(disabled.available, false, 'removed user callback ownership must never be silently reclaimed');
    terminal.write('builtin printf "ZSH_NATIVE_ALIVE\\n"\r');
    await terminal.waitFor(/ZSH_NATIVE_ALIVE\r?\n/u);
  },
);

test(
  'real Zsh never consumes a reused descriptor and removes only its own failed callback',
  { timeout: 60_000 },
  async (t) => {
    for (const failure of ['reused', 'eof', 'replaced'] as const) {
      const terminal = await openFixtureTerminal('zsh');
      t.after(() => terminal.close());
      const fixture = new EditorFixture(terminal, 'zsh');
      const event = await fixture.prompt();
      assert.ok(event.notification && 'fd' in event.notification);
      const fd = event.notification.fd;
      if (failure === 'reused') {
        const boundary = terminal.write(
          'exec {__COSMOSH_EDITOR_NOTIFY_FD}<&-; exec {__fixture_spare_fd}</etc/hostname; exec {__fixture_reused_fd}</etc/hostname; builtin printf "REUSED_FD:%s\\n" "$__fixture_reused_fd"\r',
        );
        await terminal.waitFor(new RegExp('REUSED_FD:' + fd + '\\r?\\n', 'u'), boundary);
      } else if (failure === 'eof') {
        await fixture.run('exec {__COSMOSH_EDITOR_NOTIFY_KEEP_FD}>&-');
      } else {
        const boundary = terminal.write(
          '__fixture_notify() { :; }; builtin zle -F "$__COSMOSH_EDITOR_NOTIFY_FD" __fixture_notify; __cosmosh_zsh_editor_notify "$__COSMOSH_EDITOR_NOTIFY_FD" hup; builtin zle -F -L "$__COSMOSH_EDITOR_NOTIFY_FD"\r',
        );
        await terminal.waitFor(new RegExp('zle -F ' + fd + ' __fixture_notify\\r?\\n', 'u'), boundary);
      }
      await delay(100);
      assert.equal(fixture.collect()?.available, false);
      if (failure === 'reused') {
        const info = await executeBoundedSshCommand(terminal.client, 'cat /proc/' + event.pid + '/fdinfo/' + fd);
        assert.match(
          info ?? '',
          /pos:\s+0\s/u,
          'the original descriptor now belongs to user code and must remain unread',
        );
      }
      if (failure !== 'replaced') {
        const boundary = terminal.write(
          '[[ -z "$(builtin zle -F -L ' + fd + ' 2>/dev/null)" ]] && builtin printf "UNWATCHED_OK\\n"\r',
        );
        await terminal.waitFor(/UNWATCHED_OK\r?\n/u, boundary);
      }
      terminal.close();
    }
  },
);

test(
  'real Zsh read-only snapshots preserve continuous native kill and yank behavior',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    const first = await fixture.request('context');
    assert.equal(first.status, 'ok', 'the first prompt must be safe before any key has been pressed');
    terminal.write('one two three\x17');
    const read = await fixture.request('snapshot');
    assert.equal(read.status, 'ok');
    terminal.write('\x17\x19');
    // Moving does not alter the kill buffer; this observation should see the complete native restoration.
    terminal.write('\x02');
    const result = await fixture.request('snapshot');
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.equal(result.snapshot.buffer?.text, 'one two three');
    await fixture.cancel();
  },
);

test('real Zsh preserves user DEBUG handlers and excludes input from tracing', { timeout: 60_000 }, async (t) => {
  for (const kind of ['string', 'function']) {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    const trace = '/home/cosmosh-zsh/editor-trace-' + randomUUID();
    const handler =
      kind === 'string'
        ? 'trap \'(( ++__fixture_debug_calls )); builtin print -r -- "$ZSH_DEBUG_CMD" >&9\' DEBUG'
        : 'TRAPDEBUG() { (( ++__fixture_debug_calls )); builtin print -r -- "$ZSH_DEBUG_CMD" >&9; return 0; }';
    await fixture.run(
      'exec 9>' +
        trace +
        '; exec 2>&9; __fixture_debug_calls=0; ' +
        handler +
        '; __fixture_debug_saved="$(builtin trap)"; setopt xtrace',
    );
    const sentinel = 'private-input-' + randomUUID();
    terminal.write('echo ' + sentinel);
    const result = await fixture.request('snapshot');
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.equal(result.snapshot.buffer?.text, 'echo ' + sentinel);
    await fixture.cancel();
    const boundary = terminal.write(
      'unsetopt xtrace; [[ "$(builtin trap)" = "$__fixture_debug_saved" && "$__fixture_debug_calls" -gt 0 ]] && builtin printf "DEBUG_PRESERVED\n"' +
        '\r',
    );
    await terminal.waitFor(/DEBUG_PRESERVED\r?\n/u, boundary);
    const log = await executeBoundedSshCommand(terminal.client, 'cat ' + trace, { maxOutputBytes: 2 * 1024 * 1024 });
    assert.notEqual(log, null, 'fixture tracing must remain bounded and readable');
    assert.equal(log!.includes(sentinel), false, 'private snapshot contents must not enter Shell trace output');
    await executeBoundedSshCommand(terminal.client, 'rm -f ' + trace);
    terminal.close();
  }
});

test('real Zsh composes with suggestion, highlighting, completion and prompt hooks', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('zsh');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal, 'zsh');
  await fixture.prompt();
  const enabled = await fixture.run(
    'source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh; ' +
      'source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh; ' +
      'autoload -Uz compinit; compinit -D; ' +
      '__fixture_complete() { compadd -Q alpha; }; compdef __fixture_complete fixturecmd; ' +
      'builtin print -s -- "echo plugin-suggestion"',
  );
  assert.equal(enabled.available, true, 'plugins must not take over the private write widget');
  terminal.write('echo plu');
  await delay(200);
  const suggestion = await fixture.request('snapshot');
  assert.equal(suggestion.status, 'ok');
  if (suggestion.status === 'ok') {
    assert.equal(suggestion.snapshot.buffer?.text, 'echo plu');
    assert.deepEqual(await fixture.request('apply', suggestion.snapshot, { text: 'echo plugin-edited', cursor: 18 }), {
      status: 'applied',
    });
    const edited = await fixture.request('snapshot');
    assert.equal(edited.status, 'ok');
    if (edited.status === 'ok') assert.deepEqual(edited.snapshot.buffer, { text: 'echo plugin-edited', cursor: 18 });
  }
  await fixture.cancel();
  terminal.write('fixturecmd al\t');
  await delay(200);
  terminal.write('\x02');
  const completed = await fixture.request('snapshot');
  assert.equal(completed.status, 'ok');
  // The first backward motion removes Zsh's temporary completion suffix space.
  if (completed.status === 'ok') assert.deepEqual(completed.snapshot.buffer, { text: 'fixturecmd alpha', cursor: 15 });
  await fixture.cancel();
  await fixture.run('__fixture_late_prompt() { cd "$HOME/fixtures"; }; precmd_functions+=(__fixture_late_prompt)');
  const current = await fixture.request('context');
  assert.equal(current.status, 'ok');
  if (current.status === 'ok') assert.equal(current.snapshot.directory?.physical, '/home/cosmosh-zsh/fixtures');
});

test('real Zsh rejects edits when permission or input changes during the exchange', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('zsh');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal, 'zsh');
  await fixture.prompt();
  terminal.write('echo retained');
  const snapshot = await fixture.request('snapshot');
  assert.equal(snapshot.status, 'ok');
  if (snapshot.status !== 'ok') return;
  let checks = 0;
  const result = await fixture.request(
    'apply',
    snapshot.snapshot,
    { text: 'echo changed', cursor: 12 },
    {
      isCurrent: () => {
        checks += 1;
        if (checks === 4) {
          terminal.write('x');
          return false;
        }
        return true;
      },
    },
  );
  assert.deepEqual(result, { status: 'stale' });
  const actual = await fixture.request('snapshot');
  assert.equal(actual.status, 'ok');
  if (actual.status === 'ok') assert.equal(actual.snapshot.buffer?.text, 'echo retainedx');
});

test(
  'real Zsh ignores a leftover notification until the current request is explicitly activated',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    const event = await fixture.prompt();
    assert.ok(event.notification && 'fd' in event.notification);
    terminal.write('echo retained-before-activation');
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      terminal.client.exec(editorBinaryPath('zsh') + ' editor-request', (error, channel) => {
        if (error) reject(error);
        else resolve(channel);
      }),
    );
    t.after(() => stream.close());
    stream.stderr.resume();
    let output = '';
    stream.on('data', (data: Buffer) => {
      output = (output + data.toString('utf8')).slice(0, 8192);
    });
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      target: { instanceId: event.shellInstanceId, shell: 'zsh', pid: event.pid, startTime: event.startTime },
      operation: 'snapshot',
      promptGeneration: event.promptGeneration,
      includeDirectory: true,
      notification: event.notification,
    };
    stream.write(JSON.stringify(request) + '\n');
    const deadline = Date.now() + 2000;
    while (!output.includes('"phase":"ready"') && Date.now() < deadline) await delay(10);
    assert.match(output, /"phase":"ready"/u);
    await executeBoundedSshCommand(
      terminal.client,
      "printf '\\001' > /proc/" + event.pid + '/fd/' + event.notification.fd,
    );
    await delay(100);
    assert.equal(output.includes('"snapshot"'), false);
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    stream.end();
    await closed;
    assert.equal(output.includes('retained-before-activation'), false);
    assert.equal(output.includes('"status":"ok"'), false);
    await delay(50);
    const resumed = await fixture.request('snapshot');
    assert.equal(resumed.status, 'ok');
    if (resumed.status === 'ok') assert.equal(resumed.snapshot.buffer?.text, 'echo retained-before-activation');
  },
);
