import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemotePathProvider } from './path-providers.js';

test('remote path provider avoids non-portable basename flags and returns ranked entries', async () => {
  let capturedCommand = '';
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/home/dev',
    executeCommand: async (command) => {
      capturedCommand = command;
      return 'F\tbeta.txt\nD\talpha\n';
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

test('remote lookup preserves symlink parents and whitespace in confirmed directory metadata', async () => {
  const commands: string[] = [];
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/actual/space folder ',
    resolveHomeDirectory: async () => '/home/custom ',
    executeCommand: async (command) => {
      commands.push(command);
      return 'F\tfile\n';
    },
  });
  await provider({ partialPath: './link/../f', directoriesOnly: false, fuzzyMatch: false, limit: 10 });
  assert.ok(commands[0]?.includes('/actual/space folder /./link/../'));
  await provider({ partialPath: '~/f', directoriesOnly: false, fuzzyMatch: false, limit: 10 });
  assert.ok(commands[1]?.includes('/home/custom /'));
});

test('remote path provider expands home-relative paths while preserving typed prefix', async () => {
  let capturedCommand = '';
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/tmp',
    resolveHomeDirectory: async () => '/home/dev',
    executeCommand: async (command) => {
      capturedCommand = command;
      return 'D\tprojects\nF\t.profile\n';
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
