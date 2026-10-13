import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemotePathProvider } from './path-providers.js';

test('remote path provider avoids non-portable basename flags and returns ranked entries', async () => {
  let capturedCommand = '';
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/home/dev',
    executeCommand: async (command) => {
      capturedCommand = command;
      return 'F\tbeta.txt\0D\talpha\0';
    },
  });

  const entries = await provider({
    partialPath: '',
    directoriesOnly: false,
    fuzzyMatch: false,
    limit: 10,
  });

  assert.equal(capturedCommand.includes('basename --'), false);
  assert.ok(capturedCommand.includes('name=${p##*/}'));
  assert.ok(capturedCommand.includes('printf "D\\t%s\\000"'));
  assert.ok(capturedCommand.includes('printf "F\\t%s\\000"'));
  assert.deepEqual(entries, [
    {
      name: 'alpha/',
      kind: 'directory',
    },
    {
      name: 'beta.txt',
      kind: 'file',
    },
  ]);
});

test('remote path provider expands home-relative paths while preserving typed prefix', async () => {
  let capturedCommand = '';
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/tmp',
    resolveHomeDirectory: async () => '/home/dev',
    executeCommand: async (command) => {
      capturedCommand = command;
      return 'D\tprojects\0F\t.profile\0';
    },
  });

  const entries = await provider({
    partialPath: '~/',
    directoriesOnly: true,
    fuzzyMatch: false,
    limit: 10,
  });

  assert.ok(capturedCommand.includes('/home/dev'));
  assert.deepEqual(entries, [
    {
      name: '~/projects/',
      kind: 'directory',
    },
  ]);
});

test('remote path provider preserves whole filenames and their surrounding whitespace', async () => {
  const names = [' leading.txt', 'trailing.txt ', 'report\nF\talias.txt', 'report\rname', 'tab\tname', '报告-😀.txt'];
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/tmp',
    executeCommand: async () => names.map((name) => `F\t${name}\0`).join(''),
  });

  const entries = await provider({ partialPath: '', directoriesOnly: false, fuzzyMatch: false, limit: 10 });

  assert.equal(entries.length, names.length);
  assert.deepEqual(new Set(entries.map((entry) => entry.name)), new Set(names));
  assert.ok(entries.every((entry) => entry.kind === 'file'));
});

test('remote path provider ignores malformed or incomplete records', async () => {
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/tmp',
    executeCommand: async () => 'X\tunknown\0F\t\0not-a-record\0D\tvalid\0F\tunfinished',
  });

  const entries = await provider({ partialPath: '', directoriesOnly: false, fuzzyMatch: false, limit: 10 });

  assert.deepEqual(entries, [{ name: 'valid/', kind: 'directory' }]);
});
