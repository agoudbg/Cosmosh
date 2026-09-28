import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildShellCompletionReplacement,
  parseShellCompletionContext,
  quoteShellLiteral,
  quoteShellPath,
} from './snapshot-edits.js';

const shells = ['bash', 'zsh', 'fish'] as const;

for (const shell of shells) {
  test(shell + ' selects the complete literal word while decoding only the prefix before the cursor', () => {
    for (const text of ["cat 'My File' tail", 'cat "My File" tail', 'cat My\\ File tail']) {
      const cursor = text.indexOf('File') + 2;
      const context = parseShellCompletionContext(shell, { text, cursor });
      assert.ok(context);
      assert.equal(context.word.value, 'My File');
      assert.equal(context.word.prefix, 'My Fi');
      assert.equal(context.wordIndex, 1);
      const replacement = buildShellCompletionReplacement(
        { text, cursor },
        { ...context.word, text: quoteShellPath(shell, 'My Finish')! },
      );
      assert.deepEqual(replacement, { text: "cat 'My Finish' tail", cursor: 15 });
    }
    assert.equal(parseShellCompletionContext(shell, { text: "cat 'My File", cursor: 8 })?.word.prefix, 'My ');
    assert.equal(parseShellCompletionContext(shell, { text: 'cat ~/fi', cursor: 8 })?.word.homeRelative, true);
    assert.equal(parseShellCompletionContext(shell, { text: "cat '~/fi'", cursor: 10 })?.word.homeRelative, false);
    assert.equal(parseShellCompletionContext(shell, { text: 'cat a\u00a0b', cursor: 7 })?.word.value, 'a\u00a0b');
    assert.equal(parseShellCompletionContext(shell, { text: 'cat ', cursor: 4 })?.word.start, 4);
    assert.deepEqual(parseShellCompletionContext(shell, { text: 'cat  tail', cursor: 4 })?.words, ['cat', '', 'tail']);
    assert.equal(
      parseShellCompletionContext(shell, { text: 'cmd --format=json', cursor: 17 })?.word.value,
      '--format=json',
    );
  });

  test(shell + ' rejects ambiguous syntax, controls and split escape sequences', () => {
    for (const text of [
      'cat $HOME/f',
      'cat "$(pwd)"',
      'cat `pwd`',
      'cat *.txt',
      'cat x; pwd',
      'cat x | sort',
      'cat >file',
      'cat (pwd)',
      'cat [ab]',
      'cat {a,b}',
      'cat !x',
      'cat ~user/f',
      'if true',
      'A=x cat',
      'cat =ls',
      'cat x\nnext',
      'cat \\',
    ])
      assert.equal(parseShellCompletionContext(shell, { text, cursor: Array.from(text).length }), null, text);
    assert.equal(parseShellCompletionContext(shell, { text: 'cat a\\ b', cursor: 6 }), null);
    assert.equal(parseShellCompletionContext(shell, { text: "cat 'unfinished", cursor: 1 }), null);
    assert.equal(quoteShellLiteral(shell, 'bad\nname'), null);
    assert.equal(quoteShellLiteral(shell, '\ud800'), null);
    assert.equal(quoteShellPath(shell, '-danger'), "'./-danger'");
    assert.equal(quoteShellLiteral(shell, ''), "''");
  });
}

test('Shell-specific quote and escape rules remain literal', () => {
  assert.equal(quoteShellLiteral('fish', "a'\\b"), "'a\\'\\\\b'");
  for (const shell of ['bash', 'zsh'] as const) assert.equal(quoteShellLiteral(shell, "a'\\b"), "'a'\\''\\b'");
  assert.equal(parseShellCompletionContext('fish', { text: 'cat \\n', cursor: 6 }), null);
  assert.equal(parseShellCompletionContext('bash', { text: 'cat \\n', cursor: 6 })?.word.value, 'n');
  assert.equal(parseShellCompletionContext('zsh', { text: "cat 'a''b'", cursor: 10 }), null);
  assert.equal(parseShellCompletionContext('bash', { text: "cat 'a''b'", cursor: 10 })?.word.value, 'ab');
  for (const shell of shells) {
    const value = 'a b\'\\$;"!中文🐟';
    const text = 'cat ' + quoteShellLiteral(shell, value);
    assert.equal(parseShellCompletionContext(shell, { text, cursor: Array.from(text).length })?.word.value, value);
  }
});

test('codepoint ranges preserve unrelated text around emoji, ZWJ and combining characters', () => {
  const buffer = { text: 'cat 👩‍💻e\u0301 tail', cursor: 7 };
  const context = parseShellCompletionContext('bash', buffer)!;
  assert.deepEqual(context.word, { start: 4, end: 9, value: '👩‍💻e\u0301', prefix: '👩‍💻', homeRelative: false });
  assert.deepEqual(buildShellCompletionReplacement(buffer, { ...context.word, text: "'新🐟'" }), {
    text: "cat '新🐟' tail",
    cursor: 8,
  });
  for (const edit of [
    { start: -1, end: 9, text: 'x' },
    { start: 4.5, end: 9, text: 'x' },
    { start: 8, end: 9, text: 'x' },
    { start: 4, end: 6, text: 'x' },
    { start: 4, end: 100, text: 'x' },
    { start: 4, end: 9, text: 'x\n' },
    { start: 4, end: 9, text: 'x'.repeat(8192) },
  ])
    assert.equal(buildShellCompletionReplacement(buffer, edit), null);
});
