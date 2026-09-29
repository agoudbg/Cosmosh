import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { executeShellEditorRequest, type ShellEditorResult } from '../../ssh/editor-exec.js';
import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { SshSessionService } from '../../ssh/session-service.js';
import { DeliveredTerminal } from '../../ssh/terminal-transport.js';
import { confirmShellEditorContext, ShellEditorController } from '../editor-controller.js';
import { applyShellContextEvent, createShellContext } from '../shell-context.js';
import { editorBinaryPath, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

const fish4 = '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish';
before(() => installFixtureEditor('fish'));

/** @param result Actual Shell or unavailable-adapter response. @returns Nothing; input must be absent. */
const assertPaused = (result: ShellEditorResult): void => {
  assert.ok(result.status === 'unavailable' || result.status === 'unsupported');
  assert.equal('snapshot' in result, false);
};

test(
  'Fish publishes final title readiness and preserves confirmed CWD when editor configuration is unsupported',
  { timeout: 30_000 },
  async (t) => {
    for (const supported of [true, false]) {
      await t.test(supported ? 'slow supported title' : 'slow unsupported profile', async () => {
        const terminal = await openFixtureTerminal('fish', fish4, {
          disableFishAutosuggestions: true,
          initialCommand:
            (supported ? '' : 'bind a,b self-insert; ') +
            'function fish_title; command sleep 0.45; builtin printf COSMOSH_SLOW_TITLE_DONE; end',
        });
        const session = {
          disposed: false,
          remoteEnhancementsRuntimeState: 'active',
          remoteEnhancementsRuntimeContract: { binaryPath: editorBinaryPath('fish') },
          shellContext: createShellContext(
            'fish-title',
            { cwd: true, input: true, history: false, paths: true, nativeCompletion: false },
            true,
          ),
          editorContextTimeout: undefined as NodeJS.Timeout | undefined,
          editorController: undefined as ShellEditorController | undefined,
        };
        // Use the production scheduler/controller/SSH worker. Only the surrounding session services
        // (database, WebSocket and UI) are outside this real PTY observation boundary.
        const service = Object.create(SshSessionService.prototype) as {
          scheduleEditorContextRefresh(current: typeof session): void;
        };
        const attempts: string[] = [];
        session.editorController = new ShellEditorController(
          () => session.shellContext,
          async (request, options) => {
            const result = await executeShellEditorRequest(terminal.client, editorBinaryPath('fish'), request, options);
            attempts.push(result.status);
            return result;
          },
          () => (terminal.channel instanceof DeliveredTerminal ? terminal.channel : null),
          (expected, snapshot) => {
            if (session.shellContext === expected) session.shellContext = confirmShellEditorContext(expected, snapshot);
          },
        );
        try {
          const parser = new RemoteShellEventOscParser();
          let offset = 0;
          let finalAvailability: boolean | undefined;
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline) {
            const output = terminal.readOutput(offset);
            offset += output.length;
            for (const frame of parser.parse(output)) {
              if (frame.type !== 'event') continue;
              const before = session.shellContext;
              session.shellContext = applyShellContextEvent(before, frame.event);
              if (before !== session.shellContext) session.editorController.invalidate();
              if (frame.event.event === 'editor-state') finalAvailability = frame.event.available;
              service.scheduleEditorContextRefresh(session);
            }
            if (
              finalAvailability === supported &&
              terminal.readOutput().includes('COSMOSH_SLOW_TITLE_DONE') &&
              session.shellContext.status === 'ready' &&
              (!supported || attempts.includes('ok'))
            )
              break;
            await delay(10);
          }
          assert.equal(finalAvailability, supported);
          assert.equal(session.shellContext.status, 'ready');
          assert.equal(session.shellContext.cwd?.logical, '/home/cosmosh-fish');
          assert.deepEqual(attempts, supported ? ['ok'] : [], 'no premature availability or manual retry is needed');
        } finally {
          session.disposed = true;
          if (session.editorContextTimeout) clearTimeout(session.editorContextTimeout);
          session.editorController.invalidate();
          terminal.close();
        }
      });
    }
  },
);

test(
  'real Fish 4 reads Unicode, applies data atomically and keeps one native undo boundary',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    assert.deepEqual((await fixture.prompt()).notification, { signal: 'URG' });
    terminal.write('echo 中文🐟 tail\x02\x02\x02\x02\x02');
    const snapshot = await fixture.request('snapshot');
    assert.equal(snapshot.status, 'ok');
    if (snapshot.status !== 'ok') return;
    assert.deepEqual(snapshot.snapshot.buffer, { text: 'echo 中文🐟 tail', cursor: 8 });
    const marker = '/tmp/cosmosh-fish-must-not-execute-' + randomUUID();
    const replacement = { text: 'echo (touch ' + marker + ') tail', cursor: 5 };
    assert.deepEqual(await fixture.request('apply', snapshot.snapshot, replacement), { status: 'applied' });
    const actual = await fixture.request('snapshot');
    assert.equal(actual.status, 'ok');
    if (actual.status === 'ok') assert.deepEqual(actual.snapshot.buffer, replacement);
    assert.equal(await executeBoundedSshCommand(terminal.client, 'test ! -e ' + marker + ' && printf safe'), 'safe');
    terminal.write('\x1f');
    const undone = await fixture.request('snapshot');
    assert.equal(undone.status, 'ok');
    if (undone.status === 'ok') assert.deepEqual(undone.snapshot.buffer, snapshot.snapshot.buffer);
    terminal.write('x');
    assert.deepEqual(await fixture.request('apply', snapshot.snapshot, { text: 'stale', cursor: 5 }), {
      status: 'stale',
    });
    await fixture.cancel();
    const empty = await fixture.request('snapshot');
    assert.equal(empty.status, 'ok');
    if (empty.status !== 'ok') return;
    assert.deepEqual(empty.snapshot.buffer, { text: '', cursor: 0 });
    assert.deepEqual(await fixture.request('apply', empty.snapshot, { text: '', cursor: 0 }), { status: 'applied' });
    const context = await fixture.request('context');
    assert.equal(context.status, 'ok');
    if (context.status === 'ok') assert.equal('buffer' in context.snapshot, false);
  },
);

test(
  'Fish 3.6 keeps the terminal and directory reports without claiming live editor support',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    const event = await fixture.prompt();
    assert.equal(event.available, false);
    assert.equal(event.notification, undefined);
    const offset = terminal.write('builtin printf "FISH_%s\\n" ORDINARY_OK\r');
    await terminal.waitFor(/FISH_ORDINARY_OK\r?\n/u, offset);
  },
);

test(
  'Fish preserves native grey suggestions and pauses exact editing while they are enabled',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4);
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    assert.equal((await fixture.prompt()).available, false);
    await fixture.run('echo COSMOSH_NATIVE_GREY_SUGGESTION');
    const generation = fixture.collect()!.promptGeneration;
    const offset = terminal.write('echo COSMOSH_NATIVE_GREY');
    await terminal.waitFor(/_SUGGESTION/u, offset);
    terminal.write('\x1b[C\r');
    await terminal.waitFor(/COSMOSH_NATIVE_GREY_SUGGESTION\r?\n/u, offset);
    await fixture.prompt(generation);
    await fixture.run('set -g fish_autosuggestion_enabled 0');
    // Changing this option schedules a native repaint. Let it finish before a fresh prompt.
    await delay(150);
    await fixture.run('true');
    assert.equal((await fixture.request('snapshot')).status, 'ok');
    assert.equal((await fixture.run('set -g fish_autosuggestion_enabled 1')).available, false);
    const native = terminal.write('builtin printf "FISH_%s\\n" STILL_NATIVE\r');
    await terminal.waitFor(/FISH_STILL_NATIVE\r?\n/u, native);
  },
);

test(
  'Fish never reads a password reader and resumes after the original Shell returns',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    const generation = fixture.collect()!.promptGeneration;
    const offset = terminal.write('read --silent --prompt-str PRIVATE_READER: secret; set -e secret\r');
    await terminal.waitFor(/PRIVATE_READER:/u, offset);
    terminal.write('PRIVATE_SENTINEL');
    const result = await fixture.request('snapshot');
    assertPaused(result);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
    terminal.write('\r');
    await fixture.prompt(generation);
    assert.equal((await fixture.request('snapshot')).status, 'ok');
  },
);

test(
  'Fish rejects raw arrow extensions, printable aliases, combining prefixes and mode-changing key maps',
  { timeout: 90_000 },
  async (t) => {
    for (const mapping of [
      'bind \\e\\[Aq self-insert',
      'bind minus,a self-insert',
      'bind comma,a self-insert',
      'bind \\u0301,a self-insert',
      'bind -m other a forward-jump',
    ]) {
      await t.test(mapping, async (t) => {
        const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
        t.after(() => terminal.close());
        const fixture = new EditorFixture(terminal, 'fish');
        await fixture.prompt();
        assert.equal((await fixture.request('snapshot')).status, 'ok');
        await fixture.run(mapping, true);
        assertPaused(await fixture.request('snapshot'));
      });
    }
  },
);

test(
  'Fish rejects native search, zero-width selection, vi mode and multiline input',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    await fixture.run('echo COSMOSH_SEARCH_HISTORY');
    terminal.write('COSMOSH_SEARCH\x12');
    await delay(80);
    assertPaused(await fixture.request('snapshot'));
    await fixture.cancel();
    await fixture.run('bind ctrl-o begin-selection');
    terminal.write('echo selection\x0f');
    assertPaused(await fixture.request('snapshot'));
    await fixture.cancel();
    await fixture.run('bind --erase ctrl-o; fish_vi_key_bindings');
    assertPaused(await fixture.request('snapshot'));
    await fixture.run('fish_default_key_bindings');
    terminal.write('\x1b[200~echo first\necho second\x1b[201~');
    await delay(80);
    assertPaused(await fixture.request('snapshot'));
  },
);

test(
  'Fish rejects autoloadable history hooks without executing them during inspection',
  { timeout: 30_000 },
  async () => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    const fixture = new EditorFixture(terminal, 'fish');
    const directory = '/tmp/cosmosh-fish-hook-' + randomUUID();
    const file = directory + '/fish_should_add_to_history.fish';
    const marker = directory + '/loaded';
    try {
      await fixture.prompt();
      assert.equal((await fixture.request('snapshot')).status, 'ok');
      assert.equal(
        await executeBoundedSshCommand(
          terminal.client,
          'mkdir ' +
            directory +
            "; printf '%s\\n' 'command touch " +
            marker +
            "' 'function fish_should_add_to_history' 'builtin return 0' 'end' > " +
            file +
            '; printf created',
        ),
        'created',
      );
      await fixture.run('set -p fish_function_path ' + directory);
      assertPaused(await fixture.request('snapshot'));
      assert.equal(
        await executeBoundedSshCommand(terminal.client, 'test ! -e ' + marker + ' && printf untouched'),
        'untouched',
      );
    } finally {
      try {
        await executeBoundedSshCommand(terminal.client, 'rm -f -- ' + file + ' ' + marker + '; rmdir -- ' + directory);
      } finally {
        terminal.close();
      }
    }
  },
);

test(
  'Fish recovers after qualified native Tab and search while script bindings remain unavailable',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    terminal.write('cat /home/cosmosh-fish/.conf\t');
    let result = await fixture.request('snapshot');
    const deadline = Date.now() + 5000;
    while (result.status !== 'ok' && Date.now() < deadline) {
      await delay(30);
      result = await fixture.request('snapshot');
    }
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.match(result.snapshot.buffer?.text ?? '', /\.config\/$/u);
    await fixture.cancel();
    await fixture.run('echo COSMOSH_ORDERED_SEARCH_HISTORY');
    terminal.write('COSMOSH_ORDERED_SEARCH\x12');
    await delay(80);
    assertPaused(await fixture.request('snapshot'));
    await fixture.cancel();
    assert.equal((await fixture.request('snapshot')).status, 'ok');
    for (const binding of [
      "bind tab 'commandline -i CUSTOM'",
      'bind tab,a self-insert',
      "bind ctrl-r 'commandline -i CUSTOM'",
    ]) {
      const state = await fixture.run(binding);
      assert.equal(state.available, false, 'newly recognized keys must also reject script and prefix bindings');
      assertPaused(await fixture.request('snapshot'));
      await fixture.run('bind --erase --all; fish_default_key_bindings', true);
      assert.equal((await fixture.request('snapshot')).status, 'ok');
    }
  },
);

test(
  'Fish rejects custom printable prefixes and native functions awaiting another key',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    await fixture.run('bind abc execute');
    terminal.write('a');
    assertPaused(await fixture.request('snapshot'));
    terminal.write('bc');
    await delay(300);
    await fixture.cancel();
    await fixture.run('bind --erase abc; bind ctrl-a forward-jump', true);
    terminal.write('echo target\x01');
    const pending = await fixture.request('snapshot');
    assert.ok(pending.status === 'unsupported' || pending.status === 'unavailable');
    terminal.write('t');
    await delay(300);
    await fixture.cancel();
    await fixture.run('bind --erase ctrl-a', true);
    assert.equal((await fixture.request('snapshot')).status, 'ok');
  },
);
