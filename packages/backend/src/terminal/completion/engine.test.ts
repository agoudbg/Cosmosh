import assert from 'node:assert/strict';
import test from 'node:test';

import { localizeTerminalCompletionItems, resolveTerminalCompletions } from './engine.js';
import type { TerminalPathCompletionContext, TerminalPathEntry } from './types.js';

/**
 * Runs completion with deterministic runtime options for path-provider behavior tests.
 * @param input request line prefix and cursor position.
 * @param pathProvider mocked runtime path provider.
 * @returns completion response for assertions.
 */
const runPathCompletion = async (
  input: {
    linePrefix: string;
    cursorIndex: number;
  },
  pathProvider: (context: TerminalPathCompletionContext) => Promise<TerminalPathEntry[]>,
) => {
  return await resolveTerminalCompletions(
    {
      linePrefix: input.linePrefix,
      cursorIndex: input.cursorIndex,
      trigger: 'manual',
      includeHistory: false,
      includeBuiltInCommands: false,
      includePathSuggestions: true,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
      pathProvider,
    },
  );
};

test('cd keeps directory-only path completion', async () => {
  const contexts: TerminalPathCompletionContext[] = [];

  const result = await runPathCompletion(
    {
      linePrefix: 'cd /ho',
      cursorIndex: 'cd /ho'.length,
    },
    async (context) => {
      contexts.push(context);
      return [
        { name: '/home/', kind: 'directory' },
        { name: '/hosts', kind: 'file' },
      ];
    },
  );

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.directoriesOnly, true);
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['/home/'],
  );
});

test('grep supports file and directory path completion', async () => {
  const contexts: TerminalPathCompletionContext[] = [];

  const result = await runPathCompletion(
    {
      linePrefix: 'grep /va',
      cursorIndex: 'grep /va'.length,
    },
    async (context) => {
      contexts.push(context);
      return [
        { name: '/var/', kind: 'directory' },
        { name: '/var/log', kind: 'file' },
      ];
    },
  );

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.directoriesOnly, false);
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['/var/', '/var/log'],
  );
});

test('commands without path rules do not invoke path provider', async () => {
  let invokeCount = 0;

  const result = await runPathCompletion(
    {
      linePrefix: 'echo /va',
      cursorIndex: 'echo /va'.length,
    },
    async () => {
      invokeCount += 1;
      return [{ name: '/var/', kind: 'directory' }];
    },
  );

  assert.equal(invokeCount, 0);
  assert.equal(result.items.length, 0);
});

test('localizeTerminalCompletionItems uses generated description resolver before backend i18n', async () => {
  const items = await localizeTerminalCompletionItems(
    [
      {
        id: 'git',
        label: 'git',
        insertText: 'git',
        detail: null,
        detailI18nKey: 'completion.inshellisenseDescriptions.git_123',
        source: 'inshellisense',
        kind: 'command',
        score: 100,
      },
    ],
    (key) => key,
    async (key) => (key === 'completion.inshellisenseDescriptions.git_123' ? 'Generated Git description' : null),
  );

  assert.equal(items[0]?.detail, 'Generated Git description');
});

test('localizeTerminalCompletionItems falls back to backend labels when generated description is absent', async () => {
  const items = await localizeTerminalCompletionItems(
    [
      {
        id: 'git',
        label: 'git',
        insertText: 'git',
        detail: null,
        detailI18nKey: 'completion.inshellisenseDescriptions.git_123',
        source: 'inshellisense',
        kind: 'command',
        score: 100,
      },
    ],
    (key) => (key === 'completion.labels.commandSpec' ? 'Command spec label' : key),
    async () => null,
  );

  assert.equal(items[0]?.detail, 'Command spec label');
});
