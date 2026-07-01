import assert from 'node:assert/strict';
import test from 'node:test';

import { localizeTerminalCompletionItems, resolveTerminalCompletions } from './engine.js';
import {
  loadInshellisenseCommandSpecs,
  resetCompletionResourceLoaderForTests,
  resolveInshellisenseDescription,
  setCompletionResourceLoaderOverridesForTests,
} from './resource-loader.js';
import type { TerminalCommandSpec, TerminalPathCompletionContext, TerminalPathEntry } from './types.js';

const fixtureCommandSpecs: ReadonlyArray<TerminalCommandSpec> = [
  {
    command: 'git',
    descriptionI18nKey: 'completion.inshellisenseDescriptions.git_00000000',
    subcommands: [
      {
        name: 'push',
        descriptionI18nKey: 'completion.inshellisenseDescriptions.git_push_00000000',
        options: [
          {
            name: '--force',
            descriptionI18nKey: 'completion.inshellisenseDescriptions.git_push_--force_00000000',
          },
          {
            name: '--set-upstream',
            descriptionI18nKey: 'completion.inshellisenseDescriptions.git_push_--set-upstream_00000000',
            takesValue: true,
            valueSuggestions: ['origin'],
          },
        ],
      },
    ],
  },
];

const useFixtureCompletionResources = (options?: {
  specLoader?: () => Promise<ReadonlyArray<TerminalCommandSpec>>;
}) => {
  setCompletionResourceLoaderOverridesForTests({
    specs: options?.specLoader ?? (async () => fixtureCommandSpecs),
    descriptions: async () => ({
      completion: {
        inshellisenseDescriptions: {
          git_00000000: 'Git command',
          git_push_00000000: 'Update remote refs',
          'git_push_--force_00000000': 'Force push',
          'git_push_--set-upstream_00000000': 'Set upstream branch',
        },
      },
    }),
  });
};

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

test.afterEach(() => {
  resetCompletionResourceLoaderForTests();
});

test('generated completion resources are readable zstd payloads', async () => {
  resetCompletionResourceLoaderForTests();

  const specs = await loadInshellisenseCommandSpecs();
  const gitSpec = specs.find((spec) => spec.command === 'git');

  assert.ok(gitSpec);
  assert.ok(gitSpec.descriptionI18nKey);
  assert.ok(gitSpec.subcommands?.some((subcommand) => subcommand.name === 'push'));

  const description = await resolveInshellisenseDescription(gitSpec.descriptionI18nKey);

  assert.ok(description);
});

test('built-in command completion loads lazy specs for root and nested candidates', async () => {
  let loadCount = 0;
  useFixtureCompletionResources({
    specLoader: async () => {
      loadCount += 1;
      return fixtureCommandSpecs;
    },
  });

  const rootResult = await resolveTerminalCompletions(
    {
      linePrefix: 'git p',
      cursorIndex: 'git p'.length,
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
  const nestedResult = await resolveTerminalCompletions(
    {
      linePrefix: 'git push -',
      cursorIndex: 'git push -'.length,
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

  assert.ok(loadCount >= 1);
  assert.ok(rootResult.items.some((item) => item.label === 'git push'));
  assert.ok(nestedResult.items.some((item) => item.label === 'git push --force'));
  assert.ok(nestedResult.items.some((item) => item.label === 'git push --set-upstream'));
});

test('built-in command completion can be disabled without loading specs', async () => {
  let loadCount = 0;
  useFixtureCompletionResources({
    specLoader: async () => {
      loadCount += 1;
      return fixtureCommandSpecs;
    },
  });

  const result = await resolveTerminalCompletions(
    {
      linePrefix: 'git',
      cursorIndex: 'git'.length,
      trigger: 'manual',
      includeHistory: true,
      includeBuiltInCommands: false,
      includePathSuggestions: false,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: ['git status'],
      tokenizerMode: 'posix',
    },
  );

  assert.equal(loadCount, 0);
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['git status'],
  );
});

test('built-in command loading failure degrades to history completion', async () => {
  useFixtureCompletionResources({
    specLoader: async () => [],
  });

  const result = await resolveTerminalCompletions(
    {
      linePrefix: 'git',
      cursorIndex: 'git'.length,
      trigger: 'manual',
      includeHistory: true,
      includeBuiltInCommands: true,
      includePathSuggestions: false,
      includePasswordSuggestions: false,
    },
    {
      recentCommands: ['git status'],
      tokenizerMode: 'posix',
    },
  );

  assert.deepEqual(
    result.items.map((item) => item.label),
    ['git status'],
  );
});

test('option value suggestions remain available from lazy command specs', async () => {
  useFixtureCompletionResources();

  const result = await resolveTerminalCompletions(
    {
      linePrefix: 'git push --set-upstream ',
      cursorIndex: 'git push --set-upstream '.length,
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

  assert.ok(result.items.some((item) => item.label === 'git push --set-upstream origin'));
});

test('completion descriptions resolve generated English source text', async () => {
  useFixtureCompletionResources();

  const localizedItems = await localizeTerminalCompletionItems(
    [
      {
        id: 'cmd:0:git',
        label: 'git',
        insertText: 'git',
        detail: null,
        detailI18nKey: 'completion.inshellisenseDescriptions.git_00000000',
        source: 'inshellisense',
        kind: 'command',
        score: 1,
      },
      {
        id: 'cmd:0:git push',
        label: 'git push',
        insertText: 'git push',
        detail: null,
        detailI18nKey: 'completion.inshellisenseDescriptions.git_push_00000000',
        source: 'inshellisense',
        kind: 'subcommand',
        score: 1,
      },
    ],
    (key) => (key === 'completion.labels.commandSpec' ? '命令规范' : key),
  );

  assert.equal(localizedItems[0]?.detail, 'Git command');
  assert.equal(localizedItems[1]?.detail, 'Update remote refs');
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
