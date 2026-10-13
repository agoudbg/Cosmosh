import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTerminalCompletions } from './engine.js';
import { createRemotePathProvider } from './path-providers.js';
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

test('path completion rejects C0, DEL, and C1 controls without changing safe Unicode paths', async () => {
  const controlCodePoints = [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => 0x7f + index),
  ];
  const safePath = 'folder/报告-😀.txt';

  for (const codePoint of controlCodePoints) {
    const result = await runPathCompletion({ linePrefix: 'cat ', cursorIndex: 4 }, async () => [
      { name: `folder/${String.fromCodePoint(codePoint)}file.txt`, kind: 'file' },
      { name: safePath, kind: 'file' },
    ]);

    assert.deepEqual(
      result.items.map((item) => ({ label: item.label, insertText: item.insertText })),
      [{ label: safePath, insertText: safePath }],
      `Control U+${codePoint.toString(16).padStart(4, '0')} must not reach terminal input`,
    );
  }
});

test('remote filenames cannot inject input controls or become separate completion entries', async () => {
  const provider = createRemotePathProvider({
    resolveCwd: async () => '/tmp',
    executeCommand: async () =>
      'F\tplain.txt\0F\treport\nF\taliased.txt\0F\treport\rprintf SAFE_PROBE\r.txt\0D\tsafe-dir\0',
  });

  const result = await runPathCompletion({ linePrefix: 'cat ', cursorIndex: 4, trigger: 'typing' }, provider);

  assert.deepEqual(
    result.items.map((item) => item.insertText),
    ['safe-dir/', 'plain.txt'],
  );
});

test('path control filtering preserves explicit password submission', async () => {
  const result = await resolveTerminalCompletions(
    {
      linePrefix: 'cat ',
      cursorIndex: 4,
      trigger: 'manual',
      includeHistory: false,
      includeBuiltInCommands: false,
      includePathSuggestions: true,
      includePasswordSuggestions: true,
    },
    {
      recentCommands: [],
      tokenizerMode: 'posix',
      pathProvider: async () => [
        { name: 'unsafe\rfile', kind: 'file' },
        { name: 'safe.txt', kind: 'file' },
      ],
      promptState: { shouldSuggestSecret: true, secretValue: 'test-password' },
    },
  );

  assert.deepEqual(
    result.items.map((item) => ({ kind: item.kind, insertText: item.insertText })),
    [
      { kind: 'secret', insertText: 'test-password\n' },
      { kind: 'path', insertText: 'safe.txt' },
    ],
  );
});
