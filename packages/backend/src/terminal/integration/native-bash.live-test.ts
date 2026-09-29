import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { editorBinaryPath, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

before(() => installFixtureEditor('bash'));

test('Bash native callback observes the idle reader without terminal bytes', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  const state = await fixture.prompt();
  assert.equal(state.available, true);
  assert.deepEqual(state.notification, { callback: 'readline' });
  terminal.write('echo native 中🐟');
  const result = await fixture.request('snapshot', undefined, undefined, { trigger: () => {} });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual(result.snapshot.buffer, { text: 'echo native 中🐟', cursor: 14 });
  assert.equal((await fixture.request('context')).status, 'ok');
  await fixture.cancel();
});

test('Bash read, silent read and Readline read never expose their input', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await fixture.prompt();
  for (const flags of ['-r', '-rs', '-re', '-res']) {
    const before = fixture.collect()!.promptGeneration;
    const offset = terminal.write(
      `builtin printf 'READER_OPEN\\n'; IFS= builtin read ${flags} native_secret; builtin printf 'READER_LENGTH:%s\\n' "${'${#native_secret}'}"\r`,
    );
    await terminal.waitFor(/READER_OPEN\r?\n/u, offset);
    const secret = 'PRIVATE_READER_' + randomUUID();
    const inputOffset = terminal.write(secret);
    const result = await fixture.request('snapshot');
    assert.equal(result.status, 'unavailable');
    terminal.write('\r');
    await terminal.waitFor(new RegExp('READER_LENGTH:' + secret.length + '\\r?\\n', 'u'), inputOffset);
    await fixture.prompt(before);
    if (flags.includes('s')) assert.equal(terminal.readOutput(inputOffset).includes(secret), false);
    const history = await fixture.request('history');
    assert.equal(history.status, 'ok');
    if (history.status === 'ok') {
      assert.equal(history.snapshot.buffer, undefined);
      assert.equal(history.snapshot.directory, undefined);
      assert.equal(
        history.snapshot.history?.entries.some((entry) => entry.includes(secret)),
        false,
      );
    }
  }
});

test(
  'Bash searches and incomplete keys postpone callbacks without changing native input',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    await fixture.run('echo search-native-marker');
    terminal.write('\x12search-native');
    assert.equal((await fixture.request('snapshot')).status, 'unavailable');
    await fixture.cancel();
    await fixture.run('bind "set keyseq-timeout 5000"');
    terminal.write('\x1b[');
    assert.equal((await fixture.request('snapshot')).status, 'unavailable');
    terminal.write('D');
    const resumed = await fixture.request('snapshot');
    assert.equal(resumed.status, 'ok');
    if (resumed.status === 'ok') assert.equal(resumed.snapshot.buffer?.text, '');
  },
);

test(
  'Bash canceled private workers do not delay typing or strand the native callback',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    terminal.write('echo unchanged');
    const snapshot = await fixture.request('snapshot');
    assert.equal(snapshot.status, 'ok');
    if (snapshot.status !== 'ok') return;
    const controller = new AbortController();
    const pending = fixture.request(
      'apply',
      snapshot.snapshot,
      { text: 'echo rejected', cursor: 13 },
      {
        signal: controller.signal,
        trigger: () => {
          terminal.write('-new');
          controller.abort();
        },
      },
    );
    assert.equal((await pending).status, 'unavailable');
    const current = await fixture.request('snapshot');
    assert.equal(current.status, 'ok');
    if (current.status === 'ok') assert.equal(current.snapshot.buffer?.text, 'echo unchanged-new');
    await fixture.cancel();
  },
);

test(
  'Bash module load failure leaves a usable Shell and reload recovers capability',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    const module = editorBinaryPath('bash').replace(/cosmosh-bootstrap$/u, 'cosmosh-bash.so');
    const backup = module + '.' + randomUUID();
    let failedFixture: EditorFixture | undefined;
    try {
      assert.equal(
        await executeBoundedSshCommand(terminal.client, `mv '${module}' '${backup}' && printf moved`),
        'moved',
      );
      // NODELETE deliberately keeps previously loaded code safe for chained hooks. A fresh process
      // tests an actual missing artifact without relying on the dynamic loader's same-path cache.
      const failedTerminal = await openFixtureTerminal('bash');
      t.after(() => failedTerminal.close());
      failedFixture = new EditorFixture(failedTerminal);
      await failedFixture.prompt();
      const unavailable = await failedFixture.run('builtin printf "NATIVE_LOAD_FAILURE_ALIVE\\n"');
      assert.equal(unavailable.available, false);
      assert.match(failedTerminal.readOutput(), /NATIVE_LOAD_FAILURE_ALIVE\r?\n/u);
    } finally {
      assert.equal(
        await executeBoundedSshCommand(terminal.client, `mv '${backup}' '${module}' && printf restored`),
        'restored',
      );
    }
    assert.ok(failedFixture);
    await failedFixture.run('builtin printf "NATIVE_RELOAD_ALIVE\\n"');
    await delay(50);
    assert.equal((await failedFixture.request('snapshot')).status, 'ok');
  },
);

for (const mode of ['signal-read', 'signal-silent-read', 'removed-debug-silent-read'] as const) {
  test('Bash native callback keeps ' + mode + ' private', { timeout: 60_000 }, async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    assert.equal(
      (await fixture.request('snapshot')).status,
      'ok',
      'the main reader must be supported before testing privacy',
    );
    const flags = mode === 'signal-read' ? '-e' : '-es';
    const reader = String.raw`builtin read ${flags} -p $'\nNATIVE_PRIVATE_READER>' native_private; builtin printf '\nNATIVE_PRIVATE_DONE\n'`;
    let offset: number;
    if (mode === 'removed-debug-silent-read') {
      await fixture.run('trap - DEBUG');
      offset = terminal.write(reader + '\r');
    } else {
      const state = await fixture.run("trap '" + reader.replaceAll("'", "'\\''") + "' INT");
      offset = terminal.readOutput().length;
      assert.equal(
        await executeBoundedSshCommand(terminal.client, 'kill -INT ' + state.pid + ' && printf sent'),
        'sent',
      );
    }
    await terminal.waitFor(/\r?\nNATIVE_PRIVATE_READER>/u, offset);
    const secret = 'PRIVATE_NATIVE_READER_' + randomUUID();
    const inputOffset = terminal.write(secret);
    assert.equal((await fixture.request('snapshot')).status, 'unavailable', 'nested readers must never expose input');
    assert.equal(
      (await fixture.request('context')).status,
      'unavailable',
      'nested readers must not impersonate a main prompt',
    );
    const readerGeneration = fixture.collect()!.promptGeneration;
    terminal.write('\r');
    await terminal.waitFor(/\r?\nNATIVE_PRIVATE_DONE\r?\n/u, inputOffset);
    if (flags.includes('s')) assert.equal(terminal.readOutput(inputOffset).includes(secret), false);
    await fixture.prompt(readerGeneration);
    await fixture.run(String.raw`builtin printf 'NATIVE_PRIVATE_RECOVERED\n'`);
    assert.equal(
      (await fixture.request('snapshot')).status,
      'ok',
      'ordinary editing must recover after the private reader',
    );
  });
}

/**
 * @param fixture Original disposable Bash reader.
 * @param text Exact fixture-owned text expected in its current editor.
 * @returns The actual private snapshot after checking its text.
 */
const expectNativeBuffer = async (fixture: EditorFixture, text: string) => {
  const result = await fixture.request('snapshot');
  assert.equal(result.status, 'ok');
  assert.ok(result.status === 'ok');
  assert.equal(result.snapshot.buffer?.text, text);
  return result.snapshot;
};

test(
  'Bash repeated full history searches recover an empty primary reader and preserve native abort',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    const marker = 'native-search-' + randomUUID();
    await fixture.run('echo ' + marker);
    for (let iteration = 0; iteration < 3; iteration++) {
      const original = 'echo unexecuted-' + iteration;
      terminal.write(original);
      await expectNativeBuffer(fixture, original);
      const searchOffset = terminal.write('\x12' + marker);
      await terminal.waitFor(/reverse-i-search/u, searchOffset);
      assert.equal((await fixture.request('snapshot')).status, 'unavailable');
      await fixture.cancel();
      // Query before any intervening key or command can clear an abandoned dispatch flag.
      const fresh = await expectNativeBuffer(fixture, '');
      assert.equal(fresh.buffer?.cursor, 0);
      terminal.write('echo fresh-' + iteration);
      const before = await expectNativeBuffer(fixture, 'echo fresh-' + iteration);
      const replacement = 'echo replacement-' + iteration;
      assert.deepEqual(await fixture.request('apply', before, { text: replacement, cursor: replacement.length }), {
        status: 'applied',
      });
      terminal.write('\x1f');
      await expectNativeBuffer(fixture, 'echo fresh-' + iteration);
      await fixture.cancel();

      terminal.write(original);
      await expectNativeBuffer(fixture, original);
      terminal.write('\x12' + marker);
      assert.equal((await fixture.request('snapshot')).status, 'unavailable');
      terminal.write('\x07');
      const aborted = await expectNativeBuffer(fixture, original);
      assert.equal(aborted.buffer?.cursor, original.length);
      await fixture.cancel();
    }
  },
);

test(
  'Bash native callback survives repeated unload and helper reload with native keys and undo',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await fixture.prompt();
    for (let iteration = 0; iteration < 3; iteration++) {
      const unloaded = await fixture.run('__COSMOSH_NATIVE_PACKAGED=0; builtin enable -d cosmosh_editor');
      assert.equal(unloaded.available, false);
      const offset = terminal.write("builtin printf '\\nNATIVE_UNLOADED_%s\\n' " + iteration + '\r');
      await terminal.waitFor(new RegExp('\\r?\\nNATIVE_UNLOADED_' + iteration + '\\r?\\n', 'u'), offset);
      await fixture.prompt(unloaded.promptGeneration);
      const reloaded = await fixture.run('. /home/cosmosh-bash/.config/cosmosh/bootstrap/helper.sh');
      assert.equal(reloaded.available, true);
      assert.deepEqual(reloaded.notification, { callback: 'readline' });
      await expectNativeBuffer(fixture, '');

      const original = 'echo reload-' + iteration + ' 中🐟';
      terminal.write(original + '\x1b[D');
      const before = await expectNativeBuffer(fixture, original);
      assert.equal(before.buffer?.cursor, Array.from(original).length - 1);
      const replacement = 'echo replacement-' + iteration;
      assert.deepEqual(await fixture.request('apply', before, { text: replacement, cursor: replacement.length }), {
        status: 'applied',
      });
      terminal.write('\x1f');
      await expectNativeBuffer(fixture, original);
      terminal.write('\x01\x06');
      const moved = await expectNativeBuffer(fixture, original);
      assert.equal(moved.buffer?.cursor, 1);
      await fixture.cancel();
    }
  },
);
