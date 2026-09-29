import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

before(() => installFixtureEditor('fish'));

test(
  'real native history excludes other Shell, interpreter and database input stores',
  { timeout: 30_000 },
  async (t) => {
    const root = '/tmp/cosmosh-fixture-history-' + randomUUID();
    const namespace = 'cosmosh_privacy_' + randomUUID().replaceAll('-', '_');
    const accepted = 'echo accepted-native-command';
    const sentinel = 'PRIVATE_UNRELATED_HISTORY_' + randomUUID().replaceAll('-', '_');
    const files = [
      '.bash_history',
      '.zsh_history',
      '.python_history',
      '.sqlite_history',
      '.mysql_history',
      '.lesshst',
      '.node_repl_history',
    ];
    const terminal = await openFixtureTerminal('fish', '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish', {
      disableFishAutosuggestions: true,
      fishHistoryDataDirectory: root,
      initialCommand: 'set -g fish_history ' + namespace + "; builtin history append '" + accepted + "'",
    });
    t.after(async () => {
      try {
        assert.match(root, /^\/tmp\/cosmosh-fixture-history-[a-f0-9-]{36}$/u);
        await executeBoundedSshCommand(terminal.client, 'rm -rf -- ' + root);
      } finally {
        terminal.close();
      }
    });
    const fixture = new EditorFixture(terminal, 'fish');
    await fixture.prompt();
    const setup = await executeBoundedSshCommand(
      terminal.client,
      'mkdir -p -- ' +
        root +
        '/home; and ' +
        files.map((file) => "printf '%s\\n' '" + sentinel + "' > " + root + '/home/' + file).join('; and ') +
        '; and printf ready',
    );
    assert.equal(setup, 'ready');
    // Fish keeps its native data directory from startup. These competing files belong only to
    // this test, and become visible through HOME without replacing the real native history source.
    await fixture.run('set -gx HOME ' + root + '/home');
    const result = await fixture.request('history');
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('Original Fish history did not respond');
    assert.equal(result.snapshot.history?.status, 'ok');
    assert.equal(result.snapshot.history?.namespace, namespace);
    assert.ok(result.snapshot.history?.entries.includes(accepted));
    assert.equal(
      result.snapshot.history.entries.some((command) => command.includes(sentinel)),
      false,
    );
    assert.equal(result.snapshot.buffer, undefined, 'history reading never borrows input permission');
    assert.equal(result.snapshot.directory, undefined, 'history reading never borrows directory permission');
  },
);
