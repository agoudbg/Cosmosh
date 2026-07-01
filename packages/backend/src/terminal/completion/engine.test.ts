import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { resolveTerminalCompletions } from './engine.js';
import {
  INSHELLISENSE_COMMAND_SPECS_COMPACT_SHA256,
  loadCompactInshellisenseCommandSpecs,
} from './generated-inshellisense.js';
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
      includePasswordSuggestions: false,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
      pathProvider,
      typingPathProviderTimeoutMs: input.typingPathProviderTimeoutMs,
    },
  );
};

test('generated inshellisense MessagePack payload matches generation hash', () => {
  const compactSpecs = loadCompactInshellisenseCommandSpecs();
  const actualHash = createHash('sha256').update(JSON.stringify(compactSpecs)).digest('hex');

  assert.equal(actualHash, INSHELLISENSE_COMMAND_SPECS_COMPACT_SHA256);
});

test('built-in completion keeps root command, subcommand and option suggestions', async () => {
  const rootResult = await resolveTerminalCompletions(
    {
      linePrefix: 'gi',
      cursorIndex: 'gi'.length,
      trigger: 'manual',
      includeHistory: false,
      includeBuiltInCommands: true,
      includePathSuggestions: false,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
    },
  );
  assert.ok(rootResult.items.some((item) => item.label === 'git'));

  const subcommandResult = await resolveTerminalCompletions(
    {
      linePrefix: 'git pu',
      cursorIndex: 'git pu'.length,
      trigger: 'manual',
      includeHistory: false,
      includeBuiltInCommands: true,
      includePathSuggestions: false,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
    },
  );
  assert.ok(subcommandResult.items.some((item) => item.label === 'git push'));

  const optionResult = await resolveTerminalCompletions(
    {
      linePrefix: 'git push --f',
      cursorIndex: 'git push --f'.length,
      trigger: 'manual',
      includeHistory: false,
      includeBuiltInCommands: true,
      includePathSuggestions: false,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
    },
  );
  assert.ok(optionResult.items.some((item) => item.label === 'git push --force'));
});

test('built-in completion keeps option value suggestions', async () => {
  const result = await resolveTerminalCompletions(
    {
      linePrefix: 'adb push -z b',
      cursorIndex: 'adb push -z b'.length,
      trigger: 'manual',
      includeHistory: false,
      includeBuiltInCommands: true,
      includePathSuggestions: false,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
    },
  );

  assert.ok(result.items.some((item) => item.label === 'adb push -z brotli' && item.insertText === 'brotli'));
});

test('completion keeps history, path and secret sources in one response', async () => {
  const result = await resolveTerminalCompletions(
    {
      linePrefix: 'cat con',
      cursorIndex: 'cat con'.length,
      trigger: 'manual',
      includeHistory: true,
      includeBuiltInCommands: false,
      includePathSuggestions: true,
      includePasswordSuggestions: true,
    },
    {
      recentCommands: ['cat config.old'],
      tokenizerMode: 'posix',
      promptState: {
        shouldSuggestSecret: true,
        secretValue: 'secret-value',
      },
      pathProvider: async () => [{ name: 'config.json', kind: 'file' }],
    },
  );

  assert.ok(result.items.some((item) => item.source === 'history' && item.label === 'cat config.old'));
  assert.ok(
    result.items.some((item) => item.source === 'runtime' && item.kind === 'path' && item.label === 'config.json'),
  );
  assert.ok(
    result.items.some((item) => item.source === 'runtime' && item.kind === 'secret' && item.label === 'Fill password'),
  );
});

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
