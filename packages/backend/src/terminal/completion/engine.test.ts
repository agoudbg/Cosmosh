import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTerminalCompletions } from './engine.js';
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
    trigger?: 'typing' | 'manual';
    typingPathProviderTimeoutMs?: number;
  },
  pathProvider: (context: TerminalPathCompletionContext) => Promise<TerminalPathEntry[]>,
) => {
  return await resolveTerminalCompletions(
    {
      linePrefix: input.linePrefix,
      cursorIndex: input.cursorIndex,
      trigger: input.trigger ?? 'manual',
      includeHistory: false,
      includeBuiltInCommands: false,
      includePathSuggestions: true,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
      pathProvider,
      typingPathProviderTimeoutMs: input.typingPathProviderTimeoutMs,
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

test('typing path completion can use a remote-specific provider budget', async () => {
  const result = await runPathCompletion(
    {
      linePrefix: 'cat con',
      cursorIndex: 'cat con'.length,
      trigger: 'typing',
      typingPathProviderTimeoutMs: 120,
    },
    async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });

      return [{ name: 'config.json', kind: 'file' }];
    },
  );

  assert.deepEqual(
    result.items.map((item) => item.label),
    ['config.json'],
  );
});
