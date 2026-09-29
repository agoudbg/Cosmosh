import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreCompletionMatch } from './matching.js';
import { buildShellCompletionReplacement, type ShellCompletionDraft } from './snapshot-edits.js';
import { normalizeShellHistory, rankSnapshotSuggestions, resolveSnapshotSuggestions } from './snapshot-suggestions.js';

test('native history preserves newest-first exact records without merging stale or duplicate text', () => {
  assert.deepEqual(normalizeShellHistory(['echo new', ' echo spaced ', 'echo old', 'echo new', 'echo a\necho b']), [
    'echo new',
    ' echo spaced ',
    'echo old',
    'echo a\necho b',
  ]);
  assert.deepEqual(normalizeShellHistory(['\u0000', '\ud800', 'x'.repeat(8193), '\t ', 'echo valid']), ['echo valid']);
  assert.equal(normalizeShellHistory(Array.from({ length: 500 }, (_, index) => 'echo ' + index)).length, 200);
  const bounded = normalizeShellHistory(Array.from({ length: 200 }, (_, index) => 'echo ' + index + 'x'.repeat(8000)));
  assert.ok(Buffer.byteLength(bounded.join('')) <= 64 * 1024);
});

test('matching preserves literal whitespace and handles Unicode subsequences without surrogate matching', () => {
  assert.equal(scoreCompletionMatch(' file ', 'file', true), 0);
  assert.ok(scoreCompletionMatch('🐟β', '🐟alphaβ', true) > 0);
  assert.equal(scoreCompletionMatch('🐟β', '🐟alphaβ', false), 0);
  assert.equal(scoreCompletionMatch('🐟', '🐠', true), 0);
});

for (const shell of ['bash', 'zsh', 'fish'] as const) {
  test(shell + ' metadata edits preserve the full suffix and complete the active subcommand', () => {
    const buffer = { text: 'git st --later', cursor: 6 };
    const items = resolveSnapshotSuggestions(shell, buffer, ['git stash unrelated'], {
      history: true,
      metadata: true,
      fuzzyMatch: false,
    });
    assert.equal(
      items.some((item) => item.source === 'history'),
      false,
    );
    const status = items.find((item) => item.label === 'git status');
    assert.ok(status);
    assert.equal(buildShellCompletionReplacement(buffer, status.edit)?.text, 'git status --later');
    const exact = { text: 'git status', cursor: 10 };
    const exactItems = resolveSnapshotSuggestions(shell, exact, [], {
      history: false,
      metadata: true,
      fuzzyMatch: false,
    });
    assert.ok(exactItems.some((item) => item.label === 'git status'));
    assert.equal(
      exactItems.some((item) => item.label.startsWith('git status --')),
      false,
    );
    const option = { text: 'git status --sho', cursor: 16 };
    assert.deepEqual(
      rankSnapshotSuggestions(exact, exactItems),
      [],
      'an already complete word does not create a quote-only edit',
    );
    const options = resolveSnapshotSuggestions(shell, option, [], {
      history: false,
      metadata: true,
      fuzzyMatch: false,
    });
    assert.ok(options.some((item) => item.label.endsWith('--short')));
    const valueBuffer = { text: 'code --category data', cursor: 20 };
    const values = resolveSnapshotSuggestions(shell, valueBuffer, [], {
      history: false,
      metadata: true,
      fuzzyMatch: false,
    });
    const category = values.find((item) => item.label.endsWith('data science'));
    assert.ok(category);
    assert.equal(buildShellCompletionReplacement(valueBuffer, category.edit)?.text, "code --category 'data science'");
    for (const text of [
      "git ' status' --",
      "git 'status ' --",
      'git STATUS --sho',
      'git status -- --short',
      'git --unknown status --sho',
    ]) {
      assert.deepEqual(
        resolveSnapshotSuggestions(shell, { text, cursor: text.length }, [], {
          history: false,
          metadata: true,
          fuzzyMatch: false,
        }),
        [],
        text,
      );
    }
    const quotedCommand = { text: "'git status' --sho", cursor: 18 };
    assert.deepEqual(
      resolveSnapshotSuggestions(shell, quotedCommand, [], { history: false, metadata: true, fuzzyMatch: false }),
      [],
    );
  });
}

test('history suggestions respect enablement, recency and complete-line editing boundaries', () => {
  const buffer = { text: 'echo ', cursor: 5 };
  const history = ['echo latest', 'echo oldest', 'echo latest', 'echo unsafe\nsecond', 'echo \u001b'];
  const items = resolveSnapshotSuggestions('bash', buffer, history, {
    history: true,
    metadata: false,
    fuzzyMatch: false,
  });
  assert.deepEqual(
    rankSnapshotSuggestions(buffer, items).map((item) => item.label),
    ['echo latest', 'echo oldest'],
  );
  const latestLong = 'echo ' + 'x'.repeat(100);
  const longHistory = resolveSnapshotSuggestions('bash', buffer, [latestLong, 'echo old', latestLong], {
    history: true,
    metadata: false,
    fuzzyMatch: false,
  });
  assert.deepEqual(
    rankSnapshotSuggestions(buffer, longHistory).map((item) => item.label),
    [latestLong, 'echo old'],
  );
  assert.deepEqual(
    resolveSnapshotSuggestions('bash', buffer, history, { history: false, metadata: false, fuzzyMatch: false }),
    [],
  );
  assert.deepEqual(
    resolveSnapshotSuggestions('bash', { text: 'echo  tail', cursor: 5 }, history, {
      history: true,
      metadata: false,
      fuzzyMatch: false,
    }),
    [],
  );
});

test('combined ranking deduplicates complete edits, keeps distinct same-label edits and bounds results', () => {
  const buffer = { text: 'fi tail', cursor: 2 };
  const draft: ShellCompletionDraft = {
    label: 'file',
    detail: null,
    source: 'runtime',
    kind: 'path',
    score: 100,
    edit: { start: 0, end: 2, text: "'file'" },
  };
  const duplicate = { ...draft, source: 'history' as const, score: 200 };
  const other = { ...draft, edit: { ...draft.edit, text: "'other'" } };
  const invalid = { ...draft, score: 9999, edit: { start: 0, end: 100, text: 'oops' } };
  const unchanged = { ...draft, edit: { ...draft.edit, text: 'fi' } };
  const ranked = rankSnapshotSuggestions(buffer, [draft, duplicate, other, invalid, unchanged]);
  assert.deepEqual(ranked, [duplicate, other]);
  assert.equal(rankSnapshotSuggestions(buffer, ranked, 1).length, 1);
});
