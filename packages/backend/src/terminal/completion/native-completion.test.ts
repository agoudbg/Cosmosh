import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShellEditorSnapshot, ShellNativeCompletionResult } from '@cosmosh/api-contract';

import {
  buildNativeCompletionDrafts,
  canQueryNativeCompletion,
  normalizeNativeCompletionResult,
} from './native-completion.js';
import { buildShellCompletionReplacement } from './snapshot-edits.js';

const snapshot: ShellEditorSnapshot = {
  promptGeneration: 1,
  editorMode: 'emacs',
  buffer: { text: 'git switch fe', cursor: 13 },
  directory: { logical: '/repo', physical: '/repo', home: '/home/user' },
};

/** @param token Fish-authored token. @param value Native decoded value. @returns One bounded query result. */
const result = (token: string, value = token): ShellNativeCompletionResult => ({
  status: 'ok',
  entries: [{ token, value, detail: 'native description' }],
});

test('native completion normalizes bounded fields without retaining unsolicited environment', () => {
  assert.deepEqual(
    normalizeNativeCompletionResult({ ...result('feature'), environment: ['SECRET=x'] }),
    result('feature'),
  );
  for (const value of [
    result('a', '\u001b'),
    result('a', '\ud800'),
    result('a', 'x'.repeat(8193)),
    { status: 'timeout', entries: result('a').entries },
    { status: 'ok', entries: Array.from({ length: 129 }, () => result('a').entries[0]) },
    { status: 'ok', entries: [{ token: 'a', value: 'a', detail: '\n' }] },
  ])
    assert.equal(normalizeNativeCompletionResult(value), null);
  assert.deepEqual(normalizeNativeCompletionResult({ status: 'timeout', entries: [] }), {
    status: 'timeout',
    entries: [],
  });
});

test('native results replace the complete current token and preserve earlier exact input', () => {
  const drafts = buildNativeCompletionDrafts(snapshot, result('feature/main'));
  assert.equal(drafts.length, 1);
  assert.deepEqual(buildShellCompletionReplacement(snapshot.buffer!, drafts[0].edit), {
    text: "git switch 'feature/main'",
    cursor: 25,
  });
  for (const [token, value] of [
    ['two\\ words', 'two words'],
    ["'quote\\'name'", "quote'name"],
    ["'alpha;omega'", 'alpha;omega'],
    ['\\$HOME', '$HOME'],
    ["'🐟branch'", '🐟branch'],
  ]) {
    const selected = buildNativeCompletionDrafts(snapshot, result(token, value));
    assert.equal(selected.length, 1, token);
    assert.equal(selected[0].label, value);
    assert.ok(selected[0].edit.text.startsWith("'"));
    assert.equal(selected[0].edit.text.endsWith(' '), false);
  }
});

test('native unescape success cannot authorize expansions, multiple words or executable fragments', () => {
  for (const token of [
    'alpha omega',
    'alpha;omega',
    '$HOME/alpha',
    '(touch marker)',
    '`id`',
    '*.txt',
    '~other/alpha',
    'x\\u0020y',
  ])
    assert.deepEqual(buildNativeCompletionDrafts(snapshot, result(token)), [], token);
  assert.deepEqual(buildNativeCompletionDrafts(snapshot, result('alpha', 'different')), []);
  assert.deepEqual(buildNativeCompletionDrafts(snapshot, { status: 'timeout', entries: [] }), []);
});

test('native HOME candidates use same-observation HOME while quoted tilde stays literal', () => {
  assert.equal(buildNativeCompletionDrafts(snapshot, result('~/alpha'))[0].edit.text, "'/home/user/alpha'");
  assert.equal(buildNativeCompletionDrafts(snapshot, result("'~/alpha'", '~/alpha'))[0].edit.text, "'~/alpha'");
  assert.deepEqual(
    buildNativeCompletionDrafts({ ...snapshot, directory: { ...snapshot.directory!, home: null } }, result('~/alpha')),
    [],
  );
});

test('cursor-less native API rejects middle cursors and complex input without losing suffix text', () => {
  for (const buffer of [
    { text: 'git switch fe --quiet', cursor: 13 },
    { text: 'git switch fe', cursor: 12 },
    { text: 'echo $(id)', cursor: 10 },
    { text: 'git switch fe\n', cursor: 14 },
  ]) {
    const current = { ...snapshot, buffer };
    assert.equal(canQueryNativeCompletion(current), false);
    assert.deepEqual(buildNativeCompletionDrafts(current, result('feature')), []);
  }
  assert.equal(canQueryNativeCompletion(snapshot), true);
  assert.equal(canQueryNativeCompletion({ ...snapshot, directory: { ...snapshot.directory!, physical: null } }), false);
});

test('ambiguous description rows remain inert literal arguments and receive no automatic space', () => {
  const response: ShellNativeCompletionResult = {
    status: 'ok',
    entries: [
      { token: 'alpha', value: 'alpha', detail: 'first' },
      { token: 'omega', value: 'omega', detail: 'fake' },
      { token: 'x;touch marker', value: 'x;touch marker', detail: null },
    ],
  };
  assert.deepEqual(
    buildNativeCompletionDrafts(snapshot, response).map((draft) => draft.edit.text),
    ["'alpha'", "'omega'"],
  );
});
