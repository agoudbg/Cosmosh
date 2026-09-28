import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { SFTPWrapper } from 'ssh2';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import {
  createRemotePathExecutor,
  prepareRemotePathQuery,
  RemotePathQueryController,
} from '../completion/remote-path-query.js';
import { buildShellCompletionReplacement, quoteShellLiteral } from '../completion/snapshot-edits.js';
import { resolveSnapshotPaths } from '../completion/snapshot-paths.js';
import { editorBinaryPath, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

before(() => installFixtureEditor('bash'));

for (const shell of ['bash', 'zsh', 'fish'] as const) {
  test(
    'real ' + shell + ' navigation fills the listed directory despite CDPATH and guards logical parents',
    { timeout: 60_000 },
    async (t) => {
      await installFixtureEditor(shell);
      const terminal = await openFixtureTerminal(
        shell,
        shell === 'fish' ? '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish' : undefined,
        shell === 'fish' ? { disableFishAutosuggestions: true } : undefined,
      );
      t.after(() => terminal.close());
      const fixture = new EditorFixture(terminal, shell);
      const query = createRemotePathExecutor(terminal.client, editorBinaryPath(shell));
      await fixture.prompt();
      await fixture.run(shell === 'fish' ? 'set -gx CDPATH /usr/local' : 'CDPATH=/usr/local');
      for (const [cwd, text] of [
        ['/usr', 'cd bi'],
        ['/usr/local', 'cd ../bi'],
      ]) {
        await fixture.run('builtin cd ' + cwd);
        terminal.write(text);
        const captured = await fixture.request('snapshot');
        assert.equal(captured.status, 'ok');
        if (captured.status !== 'ok' || !captured.snapshot.buffer) return;
        const candidates = await resolveSnapshotPaths(
          shell,
          captured.snapshot,
          (request) => query(request, new AbortController().signal),
          { fuzzyMatch: false, limit: 20 },
        );
        const candidate = candidates.drafts.find((draft) => draft.label === '/usr/bin/');
        assert.ok(candidate);
        const replacement = buildShellCompletionReplacement(captured.snapshot.buffer, candidate.edit);
        assert.ok(replacement);
        assert.deepEqual(await fixture.request('apply', captured.snapshot, replacement), { status: 'applied' });
        const generation = fixture.collect()!.promptGeneration;
        terminal.write('\r');
        await fixture.prompt(generation);
        const navigated = await fixture.request('context');
        assert.equal(navigated.status, 'ok');
        if (navigated.status === 'ok') assert.equal(navigated.snapshot.directory?.physical, '/usr/bin');
      }
      await fixture.run('builtin cd /dev/fd');
      terminal.write('cd ..');
      const captured = await fixture.request('snapshot');
      assert.equal(captured.status, 'ok');
      if (captured.status !== 'ok') return;
      assert.notEqual(captured.snapshot.directory?.logical, captured.snapshot.directory?.physical);
      const candidates = await resolveSnapshotPaths(
        shell,
        captured.snapshot,
        async () => assert.fail('ambiguous logical parents must not query a physical directory'),
        { fuzzyMatch: false, limit: 20 },
      );
      assert.deepEqual(candidates, { status: 'unsupported', drafts: [] });
    },
  );
}

test(
  'real structured path queries preserve filenames, find late entries and classify failures',
  { timeout: 45_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    const query = createRemotePathExecutor(terminal.client, editorBinaryPath('bash'));
    const controller = new RemotePathQueryController(query);
    let openedSftp: SFTPWrapper | undefined = undefined;
    const root = '/home/cosmosh-bash/path-query-' + randomUUID();
    const names = [' space ', 'quote\'"\\$;🐟', 'line\nname', 'tab\tname', '-leading'];
    const created: string[] = [];
    t.after(async () => {
      controller.clear();
      const sftp = openedSftp;
      if (!sftp) {
        terminal.close();
        return;
      }
      try {
        await new Promise<void>((resolve) => sftp.chmod(root + '/denied', 0o700, () => resolve()));
        for (const name of [...created, 'blocked'])
          await new Promise<void>((resolve) => sftp.unlink(root + '/' + name, () => resolve()));
        await new Promise<void>((resolve) => sftp.rmdir(root + '/denied', () => resolve()));
        await new Promise<void>((resolve) => sftp.rmdir(root, () => resolve()));
        sftp.end();
      } finally {
        terminal.close();
      }
    });
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
      terminal.client.sftp((error, value) => (error ? reject(error) : resolve(value))),
    );
    openedSftp = sftp;
    await new Promise<void>((resolve, reject) => sftp.mkdir(root, (error) => (error ? reject(error) : resolve())));
    for (const name of names) {
      await new Promise<void>((resolve, reject) =>
        sftp.writeFile(root + '/' + name, '', (error) => (error ? reject(error) : resolve())),
      );
      created.push(name);
    }
    const request = { directory: root, fragment: '', directoriesOnly: false, fuzzyMatch: false, limit: 128 };
    const listed = await controller.query(request);
    assert.equal(listed.status, 'ok');
    assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), [...names].sort());
    const late = await controller.query({
      ...request,
      directory: '/home/cosmosh-bash/fixtures/large',
      fragment: 'zz-target',
      limit: 1,
    });
    assert.equal(late.status, 'ok');
    assert.ok(late.scanned >= 1000);
    assert.deepEqual(late.entries, [{ name: 'zz-target.txt', kind: 'file' }]);
    assert.equal((await controller.query({ ...request, directory: root + '/missing' })).status, 'missing');
    assert.equal((await controller.query({ ...request, directory: root + '/' + names[0] })).status, 'not-directory');
    await new Promise<void>((resolve, reject) =>
      sftp.mkdir(root + '/denied', { mode: 0o000 }, (error) => (error ? reject(error) : resolve())),
    );
    assert.equal((await controller.query({ ...request, directory: root + '/denied' })).status, 'denied');
    const code = 'import os; os.mkfifo(' + JSON.stringify(root + '/blocked') + '); print("CREATED")';
    assert.match(
      (await executeBoundedSshCommand(terminal.client, 'python3 -c ' + quoteShellLiteral('bash', code))) ?? '',
      /CREATED/u,
    );
    const blocked = { ...request, directory: root + '/blocked' };
    assert.equal((await controller.query(blocked)).status, 'timeout');
    const pending = controller.query(blocked);
    await delay(60);
    controller.cancel();
    assert.equal((await pending).status, 'cancelled');
    const offset = terminal.write("printf 'PATH_QUERY_RESPONSIVE\\n'\r");
    await terminal.waitFor(/PATH_QUERY_RESPONSIVE\r?\n/u, offset);
  },
);

test(
  'path lookup takes CWD and HOME from the actual editor observation at use time',
  { timeout: 30_000 },
  async (t) => {
    await installFixtureEditor('zsh');
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await fixture.prompt();
    await fixture.run('TRAPALRM() { HOME=/tmp; builtin cd /tmp; TMOUT=0; }; TMOUT=1');
    await delay(1300);
    const actual = await fixture.request('context');
    assert.equal(actual.status, 'ok');
    if (actual.status !== 'ok' || !actual.snapshot.directory) return;
    const lookup = prepareRemotePathQuery({ prefix: '~/', homeRelative: true }, actual.snapshot.directory, {
      directoriesOnly: false,
      fuzzyMatch: false,
      limit: 2,
    });
    assert.ok(lookup);
    assert.equal(lookup.request.directory, '/tmp/');
    const result = await createRemotePathExecutor(terminal.client, editorBinaryPath('zsh'))(
      lookup.request,
      new AbortController().signal,
    );
    assert.ok(result.status === 'ok' || result.status === 'partial');
  },
);
