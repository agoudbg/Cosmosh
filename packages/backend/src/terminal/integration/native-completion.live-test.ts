import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { ShellEditorSnapshot } from '@cosmosh/api-contract';
import type { SFTPWrapper } from 'ssh2';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { buildNativeCompletionDrafts } from '../completion/native-completion.js';
import { quoteShellLiteral } from '../completion/snapshot-edits.js';
import { EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

const fish4 = '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish';
before(() => installFixtureEditor('fish'));

/** @param value Fixture-owned data. @returns A literal Fish argument. */
const quote = (value: string): string => quoteShellLiteral('fish', value)!;

/** @param fixture Actual original reader. @param text Single-line fixture command. @returns Actual full snapshot. */
const capture = async (fixture: EditorFixture, text: string): Promise<ShellEditorSnapshot> => {
  const empty = await fixture.request('snapshot');
  assert.equal(empty.status, 'ok');
  if (empty.status !== 'ok') throw new Error('No original input snapshot');
  assert.equal(
    (await fixture.request('apply', empty.snapshot, { text, cursor: Array.from(text).length })).status,
    'applied',
  );
  const observed = await fixture.request('snapshot');
  assert.equal(observed.status, 'ok');
  if (observed.status !== 'ok') throw new Error('No observed input snapshot');
  assert.equal(observed.snapshot.buffer?.text, text);
  return observed.snapshot;
};

test(
  'real SSH Fish queries saved completions using original exports and confirmed CWD',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('fish', fish4, { disableFishAutosuggestions: true });
    const fixture = new EditorFixture(terminal, 'fish');
    const root = '/tmp/cosmosh-native-' + randomUUID();
    const resources: { sftp?: SFTPWrapper } = {};
    t.after(async () => {
      try {
        // The root is created by this test and cannot name another user's files.
        assert.match(root, /^\/tmp\/cosmosh-native-[a-f0-9-]{36}$/u);
        await executeBoundedSshCommand(terminal.client, 'rm -rf -- ' + quote(root));
      } finally {
        resources.sftp?.end();
        terminal.close();
      }
    });
    await fixture.prompt();
    assert.equal(
      await executeBoundedSshCommand(
        terminal.client,
        'mkdir -p -- ' +
          quote(root + '/config/fish/completions') +
          ' ' +
          quote(root + '/repo') +
          '; and git -C ' +
          quote(root + '/repo') +
          ' init -q' +
          '; and git -C ' +
          quote(root + '/repo') +
          ' -c user.name=fixture -c user.email=fixture@example.invalid commit --allow-empty -qm initial' +
          '; and git -C ' +
          quote(root + '/repo') +
          ' branch feature-native; and printf ready',
      ),
      'ready',
    );
    const channel = await new Promise<SFTPWrapper>((resolve, reject) =>
      terminal.client.sftp((error, channel) => (error ? reject(error) : resolve(channel))),
    );
    resources.sftp = channel;
    /** @param name Owned relative path. @param text Saved test configuration. @returns Successful SFTP write. */
    const save = async (name: string, text: string): Promise<void> =>
      await new Promise((resolve, reject) =>
        channel.writeFile(root + '/' + name, text, (error) => (error ? reject(error) : resolve())),
      );
    await save(
      'config/fish/config.fish',
      "printf 'CONFIGURATION_CHATTER\\n'\ncd /\n" +
        'function cosmosh_native; builtin return 0; end\nfunction cosmosh_slow; builtin return 0; end\n',
    );
    await save(
      'config/fish/completions/cosmosh_native.fish',
      "complete -c cosmosh_native -f -a '$ORIGINAL_EXPORT (builtin pwd)' -d 'saved configuration'\n",
    );
    await save(
      'config/fish/completions/cosmosh_slow.fish',
      'function __cosmosh_query_slow\n' +
        ' command sh -c \'printf "%s" "$$" > "$1"; exec sleep 30\' sh ' +
        quote(root + '/child.pid') +
        '\n' +
        " printf slow\nend\ncomplete -c cosmosh_slow -f -a '(__cosmosh_query_slow)'\n",
    );
    await fixture.run(
      'set -gx XDG_CONFIG_HOME ' +
        quote(root + '/config') +
        '; set -gx ORIGINAL_EXPORT exported-from-original; set -g ONLY_ORIGINAL local-only; cd ' +
        quote(root + '/repo'),
    );

    await t.test('native Git branches and installed custom completion files', async () => {
      for (const [input, expected] of [
        ['git switch feature-', 'feature-native'],
        ['cosmosh_native ', 'exported-from-original'],
      ]) {
        const snapshot = await capture(fixture, input);
        const response = await fixture.request('native-completion', snapshot);
        assert.equal(response.status, 'native-completions');
        if (response.status !== 'native-completions') continue;
        assert.equal(response.completion.status, 'ok');
        assert.ok(
          response.completion.entries.some((entry) => entry.value === expected),
          JSON.stringify(response.completion),
        );
        assert.ok(!response.completion.entries.some((entry) => entry.value === 'CONFIGURATION_CHATTER'));
        if (input === 'cosmosh_native ')
          assert.ok(response.completion.entries.some((entry) => entry.value === root + '/repo'));
        assert.ok(buildNativeCompletionDrafts(snapshot, response.completion).some((draft) => draft.label === expected));
      }
    });

    await t.test('temporary definitions and unexported variables are not copied', async () => {
      await fixture.cancel();
      await fixture.run('complete -c cosmosh_native -f -a TEMPORARY_SESSION_ONLY');
      await save(
        'config/fish/completions/cosmosh_native.fish',
        "complete -c cosmosh_native -f -a '$ORIGINAL_EXPORT $ONLY_ORIGINAL' -d saved\n",
      );
      const response = await fixture.request('native-completion', await capture(fixture, 'cosmosh_native '));
      assert.equal(response.status, 'native-completions');
      if (response.status === 'native-completions')
        assert.deepEqual(
          response.completion.entries.map((entry) => entry.value),
          ['exported-from-original'],
        );
    });

    await t.test('stale input cannot query an earlier observation', async () => {
      const snapshot = await capture(fixture, 'cosmosh_native ');
      assert.equal((await fixture.request('apply', snapshot, { text: 'echo changed', cursor: 12 })).status, 'applied');
      assert.deepEqual(await fixture.request('native-completion', snapshot), { status: 'stale' });
    });

    await t.test('slow query leaves original reader responsive and cancellation kills its child', async () => {
      const snapshot = await capture(fixture, 'cosmosh_slow ');
      const lifetime = new AbortController();
      let finished = false;
      const pending = fixture
        .request('native-completion', snapshot, undefined, {
          signal: lifetime.signal,
          isCurrent: () => !lifetime.signal.aborted,
        })
        .then((value) => {
          finished = true;
          return value;
        });
      t.after(() => lifetime.abort());
      let pid = '';
      for (let attempt = 0; attempt < 30 && !pid; attempt += 1) {
        pid = await new Promise<string>((resolve) =>
          channel.readFile(root + '/child.pid', (error, bytes) => resolve(error ? '' : bytes.toString())),
        );
        if (!pid) await delay(10);
      }
      assert.match(pid, /^[1-9][0-9]*$/u);
      await fixture.cancel();
      const offset = terminal.write("printf 'QUERY_RESPONSIVE\\n'\r");
      // OSC/ANSI metadata can precede output; the echoed printf has a literal backslash-n after the marker.
      await terminal.waitFor(/QUERY_RESPONSIVE\r?\n/u, offset);
      assert.equal(finished, false, 'the original reader must respond while the native script is still running');
      lifetime.abort();
      assert.equal((await pending).status, 'unavailable');
      const state = await executeBoundedSshCommand(terminal.client, 'ps -o stat= -p ' + pid + '; true');
      assert.ok(!state?.trim() || state.trim().startsWith('Z'), 'query child must no longer execute');
      await fixture.prompt(snapshot.promptGeneration);
    });
  },
);
