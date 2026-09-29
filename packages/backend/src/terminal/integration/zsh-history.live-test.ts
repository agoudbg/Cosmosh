import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';

import type { ShellEditorExecOptions } from '../../ssh/editor-exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

before(() => installFixtureEditor('zsh'));

/** @param text Literal fixture-owned data. @returns One Zsh ANSI-C quoted argument. */
const quoteHistory = (text: string): string =>
  "$'" + text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r') + "'";

/** @param fixture Original reader. @returns Nothing after creating a separate native memory history. */
const isolateHistory = async (fixture: EditorFixture): Promise<void> => {
  await fixture.prompt();
  await fixture.run(
    'unset HISTORY_IGNORE; unsetopt share_history inc_append_history inc_append_history_time hist_ignore_dups hist_ignore_all_dups hist_reduce_blanks; setopt hist_ignore_space; builtin fc -p /dev/null 10000 0',
  );
};

/** @param fixture Original reader. @param text Exact history data. @returns Its next native prompt. */
const appendHistory = async (fixture: EditorFixture, text: string) =>
  await fixture.run(' builtin print -s -r -- ' + quoteHistory(text), true);

/** @param fixture Original reader. @returns A positive native source result, never an unavailable tautology. */
const readHistory = async (fixture: EditorFixture) => {
  const result = await fixture.request('history');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('Original Zsh native history was unavailable');
  const history = result.snapshot.history;
  assert.ok(history);
  assert.equal('buffer' in result.snapshot, false);
  assert.equal('directory' in result.snapshot, false);
  return history;
};

/**
 * @param fixture Original reader. @param namespace Previously observed source.
 * @param text One exact selected record. @param options Explicit cancellation boundary.
 * @returns The real worker/native removal outcome.
 */
const deleteExact = async (
  fixture: EditorFixture,
  namespace: string,
  text: string,
  options?: Partial<ShellEditorExecOptions>,
) =>
  await fixture.request(
    'history-delete',
    {
      promptGeneration: (await fixture.prompt()).promptGeneration,
      editorMode: 'emacs',
      history: { status: 'ok', namespace, entries: [text] },
    },
    undefined,
    options,
  );

test('Zsh history preserves exact native order and excludes the current editor', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('zsh');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal, 'zsh');
  await isolateHistory(fixture);
  const records = ['echo OLDER_' + randomUUID(), 'echo 中文🐟 trailing  ', 'print first\n print second\n'];
  for (const record of records) await appendHistory(fixture, record);
  const draft = 'echo UNSUBMITTED_' + randomUUID();
  terminal.write(draft);
  const history = await readHistory(fixture);
  assert.equal(history.status, 'ok');
  assert.match(history.namespace ?? '', /^[a-f0-9-]{36}:[1-9][0-9]*$/u);
  assert.deepEqual(history.entries, [...records].reverse());
  assert.ok(!JSON.stringify(history).includes(draft));
  const buffer = await fixture.request('snapshot');
  assert.equal(buffer.status, 'ok');
  if (buffer.status === 'ok') assert.deepEqual(buffer.snapshot.buffer, { text: draft, cursor: draft.length });
});

test('Zsh history honors native ignore flags even after the user removes the hook', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('zsh');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal, 'zsh');
  await isolateHistory(fixture);
  const publicRecord = ': PUBLIC_' + randomUUID();
  await fixture.run(publicRecord);
  await fixture.run(' : PRIVATE_SPACE');
  assert.ok(!(await readHistory(fixture)).entries.some((entry) => entry.includes('PRIVATE_SPACE')));
  await fixture.run(' zshaddhistory() { [[ "$1" = *PRIVATE_TEMP* ]] && return 1; return 0; }');
  await fixture.run(': PRIVATE_TEMP');
  assert.ok(!(await readHistory(fixture)).entries.some((entry) => entry.includes('PRIVATE_TEMP')));
  await fixture.run(' zshaddhistory() { [[ "$1" = *PRIVATE_NOWRITE* ]] && return 2; return 0; }');
  await fixture.run(': PRIVATE_NOWRITE');
  await fixture.run(' unfunction zshaddhistory');
  const visible = await readHistory(fixture);
  assert.ok(visible.entries.includes(publicRecord));
  assert.ok(!visible.entries.some((entry) => entry.includes('PRIVATE_')));
  await fixture.run(" HISTORY_IGNORE='*PRIVATE_FILE_POLICY*'");
  assert.equal((await fixture.request('history')).status, 'unsupported');
  await fixture.run(' unset HISTORY_IGNORE');
  assert.equal((await fixture.request('history')).status, 'unsupported');
  await fixture.run(' builtin zmodload -u cosmosh_zsh');
  assert.equal((await fixture.request('history')).status, 'unsupported');
  assert.equal((await fixture.request('snapshot')).status, 'ok');
});

test(
  'Zsh exact removal preserves hash/ring consistency and never submits history text',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await isolateHistory(fixture);
    for (const record of [': duplicate', ': retained', ': duplicate', 'print MULTILINE_NEVER_EXECUTE\n\n'])
      await appendHistory(fixture, record);
    const initial = await readHistory(fixture);
    assert.ok(initial.namespace);
    assert.equal(initial.entries.filter((entry) => entry === ': duplicate').length, 2);
    const draft = 'echo KEEP_中文🐟';
    terminal.write(draft);
    const offset = terminal.readOutput().length;
    assert.equal((await deleteExact(fixture, initial.namespace, ': duplicate')).status, 'history-removed-from-reader');
    assert.equal(
      (await deleteExact(fixture, initial.namespace, 'print MULTILINE_NEVER_EXECUTE\n\n')).status,
      'history-removed-from-reader',
    );
    const remaining = await readHistory(fixture);
    assert.deepEqual(remaining.entries, [': retained']);
    const buffer = await fixture.request('snapshot');
    assert.equal(buffer.status, 'ok');
    if (buffer.status === 'ok') assert.equal(buffer.snapshot.buffer?.text, draft);
    assert.ok(!terminal.readOutput(offset).includes('MULTILINE_NEVER_EXECUTE'));
    await fixture.cancel();
    await fixture.run(': duplicate');
    const appended = await readHistory(fixture);
    assert.equal(appended.entries[0], ': duplicate');
    terminal.write('\x1b[A');
    const recalled = await fixture.request('snapshot');
    assert.equal(recalled.status, 'ok');
    if (recalled.status === 'ok') assert.equal(recalled.snapshot.buffer?.text, ': duplicate');
    assert.equal((await deleteExact(fixture, initial.namespace, ': duplicate')).status, 'unsupported');
    terminal.write('\x1b[B');
    assert.equal((await deleteExact(fixture, initial.namespace, ': duplicate')).status, 'unsupported');
    await fixture.cancel();
    assert.equal((await deleteExact(fixture, initial.namespace, ': duplicate')).status, 'history-removed-from-reader');
    await fixture.run(' builtin fc -p /dev/null 10000 0');
    await fixture.run(': only-record');
    const only = await readHistory(fixture);
    assert.ok(only.namespace);
    assert.deepEqual(only.entries, [': only-record']);
    assert.equal((await deleteExact(fixture, only.namespace, ': only-record')).status, 'history-removed-from-reader');
    assert.deepEqual((await readHistory(fixture)).entries, []);
    await fixture.run(': appended-after-empty');
    assert.deepEqual((await readHistory(fixture)).entries, [': appended-after-empty']);
    terminal.write('\x12appended-after-empty\x1b[C');
    const searched = await fixture.request('snapshot');
    assert.equal(searched.status, 'ok');
    if (searched.status === 'ok') assert.equal(searched.snapshot.buffer?.text, ': appended-after-empty');
  },
);

test(
  'Zsh removal refuses whitespace conflicts and canceled authorization without changes',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await isolateHistory(fixture);
    for (const record of [': matching', ':  matching', ': keep-canceled']) await appendHistory(fixture, record);
    const initial = await readHistory(fixture);
    assert.ok(initial.namespace);
    assert.equal((await deleteExact(fixture, initial.namespace, ': matching')).status, 'unsupported');
    assert.equal(
      (await deleteExact(fixture, initial.namespace, ': keep-canceled', { authorize: async () => false })).status,
      'stale',
    );
    assert.deepEqual((await readHistory(fixture)).entries, initial.entries);
    assert.equal((await deleteExact(fixture, initial.namespace, ': missing')).status, 'unsupported');
  },
);

test(
  'Zsh source identity rotates across native history contexts, private mode and module reload',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('zsh');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal, 'zsh');
    await isolateHistory(fixture);
    await appendHistory(fixture, ': retained');
    const initial = await readHistory(fixture);
    assert.ok(initial.namespace);
    await fixture.run(' HISTSIZE=1');
    assert.deepEqual(await readHistory(fixture), { status: 'private', namespace: null, entries: [] });
    await fixture.run(' HISTSIZE=10000');
    const enabled = await readHistory(fixture);
    assert.notEqual(enabled.namespace, initial.namespace);
    await fixture.run(' HISTFILE=/dev/null/changed');
    const changed = await readHistory(fixture);
    assert.notEqual(changed.namespace, enabled.namespace);
    await fixture.run(' HISTFILE=/dev/null; builtin fc -p /dev/null 10000 0');
    const pushed = await readHistory(fixture);
    assert.notEqual(pushed.namespace, changed.namespace);
    await fixture.run(' builtin fc -P');
    const popped = await readHistory(fixture);
    assert.notEqual(popped.namespace, pushed.namespace);
    await fixture.run(' builtin zmodload -u cosmosh_zsh');
    const reloaded = await readHistory(fixture);
    assert.notEqual(reloaded.namespace, popped.namespace);
    await appendHistory(fixture, ': retained');
    assert.equal((await deleteExact(fixture, initial.namespace, ': retained')).status, 'unsupported');
  },
);

test('Zsh native bounds remain partial and tracing never prints returned history', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('zsh');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal, 'zsh');
  await isolateHistory(fixture);
  await fixture.run(' for i in {1..205}; do builtin print -s -r -- ": bounded $i"; done');
  const bounded = await readHistory(fixture);
  assert.equal(bounded.status, 'partial');
  assert.equal(bounded.entries.length, 200);
  assert.equal(bounded.entries[0], ': bounded 205');
  assert.equal(bounded.entries.at(-1), ': bounded 6');
  await fixture.run(' builtin fc -p /dev/null 10000 0');
  const record = ': PRIVATE_RETURN_' + randomUUID();
  await appendHistory(fixture, record);
  await appendHistory(fixture, 'x'.repeat(8193));
  const limited = await readHistory(fixture);
  assert.equal(limited.status, 'partial');
  assert.deepEqual(limited.entries, [record]);
  await fixture.run(' TRAPDEBUG() { builtin print -r -- DEBUG_CALLBACK; }; setopt xtrace');
  const offset = terminal.readOutput().length;
  const traced = await readHistory(fixture);
  assert.ok(traced.entries.includes(record));
  assert.ok(!terminal.readOutput(offset).includes(record));
  const userCommandOffset = terminal.readOutput().length;
  await fixture.run('false');
  const afterCommand = terminal.readOutput(userCommandOffset);
  assert.ok(afterCommand.includes('DEBUG_CALLBACK'));
  const events = new RemoteShellEventOscParser().parse(afterCommand);
  assert.ok(
    events.some((frame) => frame.type === 'event' && frame.event.event === 'command-end' && frame.event.exitCode === 1),
  );
  assert.ok((await readHistory(fixture)).entries.includes(record));
});
