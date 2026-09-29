import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { ShellEditorExecOptions } from '../../ssh/editor-exec.js';
import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

const fish4 = '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish';
before(() => installFixtureEditor('fish'));

/** @returns A fresh native namespace that cannot touch another test's or the host user's history. */
const historyNamespace = (): string => 'cosmosh_history_' + randomUUID().replaceAll('-', '_');

/**
 * Uses the actual private request protocol; Shell and transport perform all deletion checks.
 * @param fixture Original disposable reader. @param namespace Previously observed source.
 * @param command Exact target. @param options Explicit transport race boundary.
 * @returns The real native deletion outcome.
 */
const deleteExact = async (
  fixture: EditorFixture,
  namespace: string,
  command: string,
  options?: Partial<ShellEditorExecOptions>,
) =>
  fixture.request(
    'history-delete',
    {
      promptGeneration: (await fixture.prompt()).promptGeneration,
      editorMode: 'emacs',
      history: { status: 'ok', namespace, entries: [command] },
    },
    undefined,
    options,
  );

/** @param record Fixture-owned native history data. @returns A data-only Fish startup expression. */
const nativeRecord = (record: string): string =>
  "(builtin printf '%s' '" +
  Buffer.from(record).toString('base64') +
  "' | command base64 -d | builtin string collect --no-trim-newlines --allow-empty)";

test(
  'real Fish distinguishes reader removal from failed saving for old and recent records',
  { timeout: 60_000 },
  async (t) => {
    for (const age of ['old', 'recent'])
      await t.test(age, async () => {
        const namespace = historyNamespace();
        const dataDirectory = '/tmp/cosmosh-fixture-history-' + randomUUID();
        const record = 'KEEP_UNWRITABLE_SAVED_HISTORY';
        const options = { disableFishAutosuggestions: true, fishHistoryDataDirectory: dataDirectory };
        let terminal = await openFixtureTerminal('fish', fish4, {
          ...options,
          initialCommand:
            'set -g fish_history ' + namespace + '; builtin history append ' + record + '; builtin history save',
        });
        t.after(() => terminal.close());
        await new EditorFixture(terminal, 'fish').prompt();
        if (age === 'old') {
          terminal.close();
          await delay(2100);
          terminal = await openFixtureTerminal('fish', fish4, {
            ...options,
            initialCommand: 'set -g fish_history ' + namespace,
          });
        }
        try {
          const fixture = new EditorFixture(terminal, 'fish');
          await fixture.prompt();
          const initial = await fixture.request('history');
          assert.equal(initial.status, 'ok');
          if (initial.status === 'ok') assert.ok(initial.snapshot.history?.entries.includes(record));
          const locked = await executeBoundedSshCommand(
            terminal.client,
            "chmod 0500 -- '" + dataDirectory + "/fish' && printf locked",
          );
          assert.equal(locked, 'locked');
          assert.equal(
            (await deleteExact(fixture, namespace, record)).status,
            age === 'old' ? 'unknown' : 'history-removed-from-reader',
          );
          const remaining = await fixture.request('history');
          assert.equal(remaining.status, 'ok');
          if (remaining.status === 'ok')
            assert.equal(remaining.snapshot.history?.entries.includes(record), age === 'old');
          // A separate native reader still sees the file record in both cases. The recent entry
          // disappearing from the first reader must never turn into a claim that saving succeeded.
          await delay(2100);
          const verifier = await openFixtureTerminal('fish', fish4, {
            ...options,
            initialCommand: 'set -g fish_history ' + namespace,
          });
          try {
            const reader = new EditorFixture(verifier, 'fish');
            await reader.prompt();
            const saved = await reader.request('history');
            assert.equal(saved.status, 'ok');
            if (saved.status === 'ok') assert.ok(saved.snapshot.history?.entries.includes(record));
          } finally {
            verifier.close();
          }
          const offset = terminal.write('builtin printf "HISTORY_%s\\n" SAVE_FAILURE_ALIVE\r');
          await terminal.waitFor(/HISTORY_SAVE_FAILURE_ALIVE\r?\n/u, offset);
        } finally {
          const restored = await executeBoundedSshCommand(
            terminal.client,
            "chmod 0700 -- '" + dataDirectory + "/fish' && printf restored",
          );
          terminal.close();
          assert.equal(restored, 'restored');
        }
      });
  },
);

test(
  'real Fish deletes exact native records without trimming, executing or changing current input',
  { timeout: 45_000 },
  async (t) => {
    const namespace = historyNamespace();
    const records = [
      '--leading-dash',
      'echo exact  ',
      'begin\n echo 中文🐟\nend\n',
      "echo 'quoted'; echo NEVER_EXECUTE_HISTORY_DELETE",
    ];
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand:
        'set -g fish_history ' +
        namespace +
        '; builtin history append -- ' +
        [...records, 'ECHO EXACT  ', 'echo exact'].map(nativeRecord).join(' '),
    });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    await fixture.run('set -g fish_trace 1');
    const outputOffset = terminal.readOutput().length;
    for (const record of records) {
      assert.equal((await deleteExact(fixture, namespace, record)).status, 'history-removed-from-reader');
      const remaining = await fixture.request('history');
      assert.equal(remaining.status, 'ok');
      if (remaining.status === 'ok') {
        assert.ok(!remaining.snapshot.history?.entries.includes(record));
        assert.ok(remaining.snapshot.history?.entries.includes('ECHO EXACT  '));
        assert.ok(remaining.snapshot.history?.entries.includes('echo exact'));
      }
    }
    assert.ok(!terminal.readOutput(outputOffset).includes('NEVER_EXECUTE_HISTORY_DELETE'));
    const input = await fixture.request('snapshot');
    assert.equal(input.status, 'ok');
    if (input.status === 'ok') assert.deepEqual(input.snapshot.buffer, { text: '', cursor: 0 });
  },
);

test(
  'real Fish deletion refuses a missing record, changed namespace and revoked authorization',
  { timeout: 45_000 },
  async (t) => {
    const namespace = historyNamespace();
    const record = 'KEEP_NATIVE_HISTORY_RECORD';
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand: 'set -g fish_history ' + namespace + '; builtin history append ' + record,
    });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    assert.equal((await deleteExact(fixture, namespace, 'MISSING_RECORD')).status, 'stale');
    assert.equal((await deleteExact(fixture, namespace + '_other', record)).status, 'unsupported');
    let checks = 0;
    const revoked = await deleteExact(fixture, namespace, record, { isCurrent: () => ++checks <= 3 });
    assert.equal(revoked.status, 'stale');
    const retained = await fixture.request('history');
    assert.equal(retained.status, 'ok');
    if (retained.status === 'ok') assert.ok(retained.snapshot.history?.entries.includes(record));
    await fixture.run("set -g fish_history ''");
    assert.equal((await deleteExact(fixture, namespace, record)).status, 'unsupported');
  },
);

test(
  'real Fish verifies removal of older saved entries and preserves unrelated saved text',
  { timeout: 45_000 },
  async (t) => {
    const namespace = historyNamespace();
    const record = 'DELETE_OLD_SAVED_RECORD';
    const retained = 'KEEP_OLD_SAVED_RECORD';
    const setup = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand:
        'set -g fish_history ' +
        namespace +
        '; builtin history append ' +
        record +
        ' ' +
        retained +
        '; builtin history save',
    });
    try {
      await new EditorFixture(setup, 'fish').prompt();
    } finally {
      setup.close();
    }
    // Fish can timestamp startup-second additions one second ahead. Cross-process assertions
    // must wait for its native history visibility boundary rather than mistake it for deletion.
    await delay(2100);
    for (const deleting of [true, false]) {
      const terminal = await openFixtureTerminal('fish', fish4, {
        disableFishAutosuggestions: true,
        initialCommand: 'set -g fish_history ' + namespace,
      });
      t.after(() => terminal.close());
      const fixture = new EditorFixture(terminal, 'fish');
      await fixture.prompt();
      const history = await fixture.request('history');
      assert.equal(history.status, 'ok');
      if (history.status === 'ok') {
        assert.equal(history.snapshot.history?.entries.includes(record), deleting);
        assert.ok(history.snapshot.history?.entries.includes(retained));
      }
      if (deleting) assert.equal((await deleteExact(fixture, namespace, record)).status, 'history-removed-from-reader');
      terminal.close();
    }
  },
);

test(
  'real Fish retains the privacy decision after an ignored command erases its history hook',
  { timeout: 45_000 },
  async (t) => {
    for (const setup of ['startup', 'native-grey', 'late-prompt', 'late-title']) {
      await t.test(setup, async () => {
        const policy = 'function fish_should_add_to_history; return 1; end';
        const installPolicy = setup.startsWith('late-')
          ? 'function fish_' +
            (setup === 'late-title' ? 'title' : 'prompt') +
            '; if not set -q COSMOSH_TEST_POLICY_CREATED; set -g COSMOSH_TEST_POLICY_CREATED 1; ' +
            policy +
            '; end; end'
          : policy;
        const terminal = await openFixtureTerminal('fish', fish4, {
          disableFishAutosuggestions: setup === 'startup',
          initialCommand: 'set -g fish_history ' + historyNamespace() + '; ' + installPolicy,
        });
        try {
          const fixture = new EditorFixture(terminal, 'fish');
          assert.equal((await fixture.prompt()).available, false);
          await fixture.run(
            'functions --erase fish_should_add_to_history; set -g fish_autosuggestion_enabled 0; builtin echo PRIVATE_IGNORED_POLICY_REMOVAL',
          );
          // Input inspection may recover; history privacy must retain the previous policy decision.
          const result = await fixture.request('history');
          assert.ok(result.status === 'unsupported' || result.status === 'unavailable');
          assert.ok(!JSON.stringify(result).includes('PRIVATE_IGNORED_POLICY_REMOVAL'));
          // An empty Enter allows native repaint recovery without adding a normal history record.
          await fixture.run('');
          assert.equal(fixture.collect()?.available, true);
          assert.equal((await fixture.request('history')).status, 'unsupported');
        } finally {
          terminal.close();
        }
      });
    }
  },
);

test(
  'real Fish history preserves complete multiline records and keeps tracing out of the private response',
  { timeout: 30_000 },
  async (t) => {
    const record = 'begin\n echo HISTORY_MULTILINE_RECORD\nend\n';
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand: 'set -g fish_history ' + historyNamespace() + "; builtin history append '" + record + "'",
    });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    await fixture.run('set -g fish_trace 1');
    const offset = terminal.readOutput().length;
    const result = await fixture.request('history');
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.ok(result.snapshot.history?.entries.includes(record));
    assert.ok(!terminal.readOutput(offset).includes('HISTORY_MULTILINE_RECORD'));
  },
);

test(
  'real Fish history reports an incomplete native read as unavailable and leaves ordinary input usable',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand:
        'set -g fish_history ' +
        historyNamespace() +
        '; builtin history append HISTORY_EARLIER_PUBLIC (builtin string repeat -n 11000 x)',
    });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    assert.equal((await fixture.prompt()).available, true);
    const bounded = await fixture.request('history');
    assert.equal(bounded.status, 'ok');
    if (bounded.status === 'ok') {
      assert.equal(bounded.snapshot.history?.status, 'partial');
      assert.ok(bounded.snapshot.history?.entries.includes('HISTORY_EARLIER_PUBLIC'));
    }
    assert.equal((await fixture.run('set -g fish_read_limit 10000')).available, true);
    const result = await fixture.request('history');
    assert.equal(result.status, 'unavailable');
    const offset = terminal.write('builtin printf "HISTORY_%s\\n" LIMIT_ALIVE\r');
    await terminal.waitFor(/HISTORY_LIMIT_ALIVE\r?\n/u, offset);
  },
);

test(
  'real Fish history keeps exact newest-first records and never reads current input or CWD',
  { timeout: 30_000 },
  async (t) => {
    const namespace = historyNamespace();
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand: 'set -g fish_history ' + namespace,
    });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    await fixture.run("builtin history append 'older entry' 'exact 中文🐟  ' 'older entry'");
    const result = await fixture.request('history');
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal('buffer' in result.snapshot, false);
    assert.equal('directory' in result.snapshot, false);
    assert.equal(result.snapshot.history?.namespace, namespace);
    assert.deepEqual(result.snapshot.history?.entries.slice(0, 2), ['older entry', 'exact 中文🐟  ']);
    assert.equal(result.snapshot.history?.entries.filter((entry) => entry === 'older entry').length, 1);
    const offset = terminal.write('builtin printf "HISTORY_%s\\n" STILL_USABLE\r');
    await terminal.waitFor(/HISTORY_STILL_USABLE\r?\n/u, offset);
  },
);

test(
  'real Fish filters ephemeral leading-space commands before private history transfer',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand: 'set -g fish_history ' + historyNamespace(),
    });
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    await fixture.run('echo PUBLIC_HISTORY_MARKER');
    await fixture.run(' echo PRIVATE_EPHEMERAL_MARKER');
    const offset = terminal.readOutput().length;
    const result = await fixture.request('history');
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.ok(result.snapshot.history?.entries.includes('echo PUBLIC_HISTORY_MARKER'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_EPHEMERAL_MARKER'));
    assert.ok(!terminal.readOutput(offset).includes('PUBLIC_HISTORY_MARKER'), 'native records must not enter the PTY');
  },
);

test(
  'real Fish refuses disabled history and custom history policies without changing native input',
  { timeout: 45_000 },
  async (t) => {
    for (const [name, initialCommand] of [
      ['private mode', 'builtin history append PRIVATE_DISABLED_MARKER'],
      ['empty namespace', "set -g fish_history ''; builtin history append PRIVATE_DISABLED_MARKER"],
      [
        'custom policy',
        'set -g fish_history ' + historyNamespace() + '; function fish_should_add_to_history; return 1; end',
      ],
    ]) {
      await t.test(name, async () => {
        const terminal = await openFixtureTerminal('fish', fish4, {
          disableFishAutosuggestions: true,
          privateFishHistory: name === 'private mode',
          initialCommand,
        });
        try {
          const fixture = new EditorFixture(terminal, 'fish');
          await fixture.prompt();
          const result = await fixture.request('history');
          if (name !== 'custom policy') {
            assert.equal(result.status, 'ok');
            if (result.status === 'ok')
              assert.deepEqual(result.snapshot.history, { status: 'private', namespace: null, entries: [] });
          } else assert.equal(result.status, 'unavailable');
          assert.ok(!JSON.stringify(result).includes('PRIVATE_DISABLED_MARKER'));
          const offset = terminal.write('builtin printf "HISTORY_%s\\n" NATIVE_OK\r');
          await terminal.waitFor(/HISTORY_NATIVE_OK\r?\n/u, offset);
        } finally {
          terminal.close();
        }
      });
    }
  },
);
