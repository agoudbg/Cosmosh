import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShellEditorSnapshot, ShellPathQueryRequest } from '@cosmosh/api-contract';

import { buildShellCompletionReplacement, quoteShellPath } from './snapshot-edits.js';
import { resolveSnapshotPaths } from './snapshot-paths.js';

for (const shell of ['bash', 'zsh', 'fish'] as const) {
  test(shell + ' path source derives literal intent and precise replacement from the full snapshot', async () => {
    const cases = [
      { token: "'My Fi'", fragment: 'My Fi', directory: '/actual/', name: 'My File', insert: 'My File' },
      { token: "'a\\b'", fragment: 'a\\b', directory: '/actual/', name: 'a\\back', insert: 'a\\back' },
      { token: "'~/f'", fragment: 'f', directory: '/actual/~/', name: 'file', insert: '~/file' },
      { token: '~/f', fragment: 'f', directory: '/home/custom /', name: 'file', insert: '/home/custom /file' },
      { token: "''", fragment: '', directory: '/actual/', name: '-leading', insert: '-leading' },
    ];
    for (const item of cases) {
      const text = 'cat ' + item.token + ' tail';
      const snapshot: ShellEditorSnapshot = {
        promptGeneration: 1,
        editorMode: 'emacs',
        buffer: { text, cursor: Array.from('cat ' + item.token).length },
        directory: { logical: '/link', physical: '/actual', home: '/home/custom ' },
      };
      let queried: ShellPathQueryRequest | null = null;
      const result = await resolveSnapshotPaths(
        shell,
        snapshot,
        async (request) => {
          queried = request;
          return {
            status: 'ok',
            scanned: 1200,
            entries: [
              { name: item.name, kind: 'file' },
              { name: 'bad\nprintf unexpected\n', kind: 'file' },
              { name: 'bad\u001b', kind: 'file' },
            ],
          };
        },
        { fuzzyMatch: false, limit: 20 },
      );
      assert.deepEqual(queried, {
        directory: item.directory,
        fragment: item.fragment,
        directoriesOnly: false,
        fuzzyMatch: false,
        limit: 20,
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.drafts.length, 1, 'control filenames must never create an applicable edit');
      assert.equal(
        buildShellCompletionReplacement(snapshot.buffer!, result.drafts[0].edit)?.text,
        'cat ' + quoteShellPath(shell, item.insert) + ' tail',
      );
    }
  });
}

test('path source reports unavailable and unsupported scopes without querying a remote directory', async () => {
  let calls = 0;
  const query = async () => {
    calls += 1;
    return { status: 'denied' as const, scanned: 0, entries: [] };
  };
  const options = { fuzzyMatch: false, limit: 20 };
  const snapshot: ShellEditorSnapshot = {
    promptGeneration: 1,
    editorMode: 'emacs',
    buffer: { text: 'cat $HOME', cursor: 9 },
    directory: { logical: '/tmp', physical: '/tmp', home: '/home/user' },
  };
  assert.equal((await resolveSnapshotPaths('bash', snapshot, query, options)).status, 'unsupported');
  assert.equal(
    (await resolveSnapshotPaths('bash', { ...snapshot, directory: undefined }, query, options)).status,
    'unavailable',
  );
  assert.equal(calls, 0);
  const known = { ...snapshot, buffer: { text: 'cat file', cursor: 8 } };
  assert.deepEqual(await resolveSnapshotPaths('bash', known, query, options), { status: 'denied', drafts: [] });
  assert.equal(calls, 1);
});

test('path candidates obey the final matcher even when remote Unicode case folding differs', async () => {
  const result = await resolveSnapshotPaths(
    'bash',
    {
      promptGeneration: 1,
      editorMode: 'emacs',
      buffer: { text: 'cat find', cursor: 8 },
      directory: { logical: '/tmp', physical: '/tmp', home: null },
    },
    async () => ({
      status: 'ok',
      scanned: 2,
      entries: [
        { name: 'FİND', kind: 'file' },
        { name: 'find.txt', kind: 'file' },
      ],
    }),
    { fuzzyMatch: false, limit: 10 },
  );
  assert.deepEqual(
    result.drafts.map((item) => item.label),
    ['find.txt'],
  );
});

for (const shell of ['bash', 'zsh', 'fish'] as const) {
  test(shell + ' navigation candidates identify the exact listed directory and reject ambiguous parents', async () => {
    let queried: ShellPathQueryRequest | undefined;
    const snapshot: ShellEditorSnapshot = {
      promptGeneration: 1,
      editorMode: 'emacs',
      directory: { logical: '/usr', physical: '/usr', home: '/home/user' },
      buffer: { text: '', cursor: 0 },
    };
    const query = async (request: ShellPathQueryRequest) => {
      queried = request;
      return { status: 'ok' as const, scanned: 1, entries: [{ name: 'bin', kind: 'directory' as const }] };
    };
    for (const text of ['cd bi', 'pushd bi', 'cd ../bi', 'cd ./.././bi']) {
      const current = { ...snapshot, buffer: { text, cursor: text.length } };
      const result = await resolveSnapshotPaths(shell, current, query, { fuzzyMatch: false, limit: 10 });
      const target = text.includes('..') ? '/bin/' : '/usr/bin/';
      assert.equal(result.status, 'ok');
      assert.equal(queried?.directoriesOnly, true);
      assert.equal(result.drafts[0].label, target);
      assert.equal(result.drafts[0].edit.text, quoteShellPath(shell, target));
    }
    for (const text of [
      'cd link/../bi',
      'cd /usr/../bi',
      'cd ~/../bi',
      'bi',
      '',
      'cd -- bi',
      'cd -L ../bi',
      'pushd -n bi',
      'builtin cd bi',
      'command cd bi',
      'noglob cd bi',
      'nocorrect cd bi',
      'cd old new',
    ]) {
      queried = undefined;
      const result = await resolveSnapshotPaths(shell, { ...snapshot, buffer: { text, cursor: text.length } }, query, {
        fuzzyMatch: false,
        limit: 10,
      });
      assert.equal(result.status, 'unsupported', text);
      assert.equal(queried, undefined);
    }
    queried = undefined;
    assert.equal(
      (
        await resolveSnapshotPaths(shell, { ...snapshot, buffer: { text: 'cd old new', cursor: 6 } }, query, {
          fuzzyMatch: false,
          limit: 10,
        })
      ).status,
      'unsupported',
    );
    assert.equal(queried, undefined);
    for (const text of ['cd ../bi', 'cd ..']) {
      queried = undefined;
      const result = await resolveSnapshotPaths(
        shell,
        {
          ...snapshot,
          directory: { logical: '/link', physical: '/usr', home: null },
          buffer: { text, cursor: text.length },
        },
        query,
        { fuzzyMatch: false, limit: 10 },
      );
      assert.equal(result.status, 'unsupported');
      assert.equal(queried, undefined);
    }
    for (const text of ['./bi', '/usr/bi', '~/bi', 'rmdir link/../bi']) {
      const result = await resolveSnapshotPaths(shell, { ...snapshot, buffer: { text, cursor: text.length } }, query, {
        fuzzyMatch: false,
        limit: 10,
      });
      assert.equal(result.status, 'ok', text);
    }
  });
}
