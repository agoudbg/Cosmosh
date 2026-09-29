import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';

import type { ShellEditorExecOptions } from '../../ssh/editor-exec.js';
import { executeShellEditorRequest } from '../../ssh/editor-exec.js';
import { DeliveredTerminal } from '../../ssh/terminal-transport.js';
import { editorBinaryPath, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

before(() => installFixtureEditor('bash'));

/** @param value Literal fixture-owned history text. @returns A Bash ANSI-C quoted argument. */
const quoteHistory = (value: string): string =>
  "$'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r') + "'";

/** @param fixture Original Bash reader. @returns Nothing after isolating its native memory history. */
const isolateHistory = async (fixture: EditorFixture): Promise<void> => {
  await fixture.prompt();
  await fixture.run(
    'HISTFILE=/dev/null; HISTSIZE=10000; HISTCONTROL=ignorespace; unset HISTTIMEFORMAT; set -o history; builtin history -c',
  );
};

/** @param fixture Original reader. @param text Exact record. @returns Its next prompt. */
const appendHistory = async (fixture: EditorFixture, text: string) =>
  await fixture.run('builtin history -s ' + quoteHistory(text));

/** @param fixture Original reader. @returns Its exact native history response. */
const readHistory = async (fixture: EditorFixture) => {
  const result = await fixture.request('history');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('Original Bash native history was unavailable');
  assert.ok(result.snapshot.history);
  return result.snapshot;
};

/**
 * @param fixture Original reader. @param namespace Previously observed source.
 * @param text One exact record. @param options Optional transport race boundary.
 * @returns The real private deletion result.
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

test('Bash history returns accepted newest-first records without input or CWD', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await isolateHistory(fixture);
  const older = 'echo OLDER_' + randomUUID();
  const unicode = 'echo 中🐟 trailing  ';
  const multiline = 'echo FIRST_' + randomUUID() + '\n echo SECOND_中🐟  ';
  for (const record of [older, unicode, multiline]) await appendHistory(fixture, record);
  const draft = 'echo UNEXECUTED_' + randomUUID();
  terminal.write(draft);
  const snapshot = await readHistory(fixture);
  assert.equal('buffer' in snapshot, false);
  assert.equal('directory' in snapshot, false);
  assert.equal(snapshot.history?.status, 'ok');
  assert.match(snapshot.history?.namespace ?? '', /^[a-f0-9-]{36}:[1-9][0-9]*$/u);
  const entries = snapshot.history?.entries ?? [];
  assert.ok(entries.indexOf(multiline) < entries.indexOf(unicode));
  assert.ok(entries.indexOf(unicode) < entries.indexOf(older));
  assert.ok(entries.includes(multiline));
  assert.ok(entries.includes(unicode));
  assert.ok(!entries.includes(draft));
  assert.ok(entries.length <= 200);
  await fixture.cancel();
});

test('Bash history excludes ignored-space input and disabled/private sources', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await isolateHistory(fixture);
  const publicRecord = 'echo PUBLIC_' + randomUUID();
  const privateRecord = 'echo PRIVATE_' + randomUUID();
  await fixture.run(publicRecord);
  await fixture.run(' ' + privateRecord);
  const accepted = await readHistory(fixture);
  assert.ok(accepted.history?.entries.includes(publicRecord));
  assert.ok(!JSON.stringify(accepted.history).includes(privateRecord));
  await fixture.run('set +o history');
  const disabled = await readHistory(fixture);
  assert.deepEqual(disabled.history, {
    status: 'private',
    namespace: null,
    entries: [],
  });
  await fixture.run('set -o history; HISTFILE=');
  const emptyFile = await readHistory(fixture);
  assert.deepEqual(emptyFile.history, {
    status: 'private',
    namespace: null,
    entries: [],
  });
  await fixture.run('HISTFILE=/dev/null');
  const recovered = await readHistory(fixture);
  assert.ok(!recovered.history?.entries.includes(privateRecord));
});

test(
  'Bash removes all byte-exact duplicates while preserving variants and current editing',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await isolateHistory(fixture);
    const exact = 'echo EXACT_' + randomUUID() + '  ';
    const oneSpace = exact.slice(0, -1);
    const changedCase = exact.replace('EXACT_', 'exact_');
    for (const record of [exact, oneSpace, exact, changedCase]) await appendHistory(fixture, record);
    const original = await readHistory(fixture);
    assert.equal(original.history?.entries.filter((entry) => entry === exact).length, 2);
    terminal.write('echo untouched');
    terminal.write('\x01');
    const before = await fixture.request('snapshot');
    assert.equal(before.status, 'ok');
    if (before.status !== 'ok') return;
    assert.deepEqual(before.snapshot.buffer, {
      text: 'echo untouched',
      cursor: 0,
    });
    const namespace = original.history?.namespace;
    assert.ok(namespace);
    assert.equal((await deleteExact(fixture, namespace, exact)).status, 'history-removed-from-reader');
    const after = await fixture.request('snapshot');
    assert.equal(after.status, 'ok');
    if (after.status === 'ok') assert.deepEqual(after.snapshot.buffer, before.snapshot.buffer);
    const remaining = await readHistory(fixture);
    assert.ok(!remaining.history?.entries.includes(exact));
    assert.ok(remaining.history?.entries.includes(oneSpace));
    assert.ok(remaining.history?.entries.includes(changedCase));
    await fixture.cancel();
  },
);

test(
  'Bash deletion rejects missing and changed-source records and rotates opaque namespace',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await isolateHistory(fixture);
    const record = 'echo SOURCE_' + randomUUID();
    await appendHistory(fixture, record);
    const original = await readHistory(fixture);
    const namespace = original.history?.namespace;
    assert.ok(namespace);
    assert.equal((await deleteExact(fixture, namespace, 'MISSING_' + randomUUID())).status, 'stale');
    try {
      await fixture.run('HISTFILE=/dev/zero');
      const changed = await readHistory(fixture);
      assert.notEqual(changed.history?.namespace, namespace);
      assert.ok(changed.history?.entries.includes(record));
      assert.equal((await deleteExact(fixture, namespace, record)).status, 'stale');
    } finally {
      await fixture.run('HISTFILE=/dev/null');
    }
    const restored = await readHistory(fixture);
    assert.notEqual(restored.history?.namespace, namespace);
    assert.ok(restored.history?.entries.includes(record));
  },
);

test(
  'Bash deletion preserves a different recalled entry and refuses its active undo state',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await isolateHistory(fixture);
    const record = 'echo RECALL_' + randomUUID();
    await appendHistory(fixture, record);
    const active = 'echo ACTIVE_' + randomUUID();
    await appendHistory(fixture, active);
    const before = await readHistory(fixture);
    const namespace = before.history?.namespace;
    assert.ok(namespace);

    terminal.write('\x1b[A');
    const recalled = await fixture.request('snapshot');
    assert.equal(recalled.status, 'ok');
    if (recalled.status === 'ok') assert.equal(recalled.snapshot.buffer?.text, active);
    terminal.write(' edited');
    const edited = await fixture.request('snapshot');
    assert.equal(edited.status, 'ok');
    if (edited.status === 'ok') assert.equal(edited.snapshot.buffer?.text, active + ' edited');

    assert.equal((await deleteExact(fixture, namespace, active)).status, 'unsupported');
    assert.equal((await deleteExact(fixture, namespace, record)).status, 'history-removed-from-reader');
    const preserved = await fixture.request('snapshot');
    assert.equal(preserved.status, 'ok');
    if (preserved.status === 'ok') assert.equal(preserved.snapshot.buffer?.text, active + ' edited');
    assert.ok(!(await readHistory(fixture)).history?.entries.includes(record));

    terminal.write('\x1f');
    const undone = await fixture.request('snapshot');
    assert.equal(undone.status, 'ok');
    if (undone.status === 'ok') assert.equal(undone.snapshot.buffer?.text, active);
    terminal.write('\x1b[A');
    assert.equal((await fixture.request('snapshot')).status, 'ok');
    terminal.write('\x1b[B');
    assert.equal((await fixture.request('snapshot')).status, 'ok');
    await fixture.cancel();
    terminal.write('\x12RECALL_\x07');
    assert.equal((await fixture.request('snapshot')).status, 'ok');
    assert.ok(!(await readHistory(fixture)).history?.entries.includes(record));
  },
);

test('Bash history navigation survives deleting an older entry from a fresh draft', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await isolateHistory(fixture);
  const older = 'echo OLDER_' + randomUUID();
  const newer = 'echo NEWER_' + randomUUID();
  await appendHistory(fixture, older);
  await appendHistory(fixture, newer);
  const history = await readHistory(fixture);
  assert.ok(history.history?.namespace);
  assert.equal((await deleteExact(fixture, history.history.namespace, older)).status, 'history-removed-from-reader');
  terminal.write('\x1b[A');
  const recalled = await fixture.request('snapshot');
  assert.equal(recalled.status, 'ok');
  if (recalled.status === 'ok') assert.equal(recalled.snapshot.buffer?.text, newer);
  terminal.write('\x1b[B');
  assert.equal((await fixture.request('snapshot')).status, 'ok');
  await fixture.cancel();
  assert.ok(!(await readHistory(fixture)).history?.entries.includes(older));
});

test(
  'Bash excludes unsubmitted recalled edits and refuses duplicate deletion while they exist',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await isolateHistory(fixture);
    const record = 'echo DUPLICATE_' + randomUUID();
    const privateSuffix = ' NEVER_SUBMITTED_' + randomUUID();
    await appendHistory(fixture, record);
    await appendHistory(fixture, record);
    const original = await readHistory(fixture);
    const namespace = original.history?.namespace;
    assert.ok(namespace);
    assert.equal(original.history?.entries.filter((entry) => entry === record).length, 2);

    terminal.write('\x1b[A' + privateSuffix + '\x1b[A');
    const edited = await readHistory(fixture);
    assert.equal(edited.history?.status, 'partial');
    assert.ok(!JSON.stringify(edited.history).includes(privateSuffix));
    assert.equal(edited.history?.entries.filter((entry) => entry === record).length, 1);
    assert.equal((await deleteExact(fixture, namespace, record)).status, 'unsupported');

    await fixture.cancel();
    const canceled = await fixture.request('history');
    assert.equal(canceled.status, 'unavailable');
    assert.ok(!JSON.stringify(canceled).includes(privateSuffix));
    await fixture.run(' : next');
    const following = await fixture.request('history');
    assert.equal(following.status, 'unavailable');
    assert.ok(!JSON.stringify(following).includes(privateSuffix));
    assert.equal((await deleteExact(fixture, namespace, record)).status, 'unavailable');
  },
);

test(
  'Bash signal cleanup retains privacy without an intervening history observation',
  { timeout: 60_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    t.after(() => terminal.close());
    const fixture = new EditorFixture(terminal);
    await isolateHistory(fixture);
    const older = 'echo OLDER_' + randomUUID();
    const accepted = 'echo ACCEPTED_' + randomUUID();
    const privateSuffix = ' NEVER_SUBMITTED_' + randomUUID();
    await appendHistory(fixture, older);
    await appendHistory(fixture, accepted);

    terminal.write('\x1b[A' + privateSuffix + '\x1b[A\x1b[B');
    const recalled = await fixture.request('snapshot');
    assert.equal(recalled.status, 'ok');
    if (recalled.status === 'ok') assert.equal(recalled.snapshot.buffer?.text, accepted + privateSuffix);
    await fixture.cancel();
    const afterCancel = await fixture.request('history');
    assert.equal(afterCancel.status, 'unavailable');
    assert.ok(!JSON.stringify(afterCancel).includes(privateSuffix));

    terminal.write('\x1b[A');
    await fixture.cancel();
    const afterRecall = await fixture.request('history');
    assert.equal(afterRecall.status, 'unavailable');
    assert.ok(!JSON.stringify(afterRecall).includes(privateSuffix));
    await fixture.run(' : next');
    const afterCommand = await fixture.request('history');
    assert.equal(afterCommand.status, 'unavailable');
    assert.ok(!JSON.stringify(afterCommand).includes(privateSuffix));
    terminal.write('echo ordinary input');
    const ordinary = await fixture.request('snapshot');
    assert.equal(ordinary.status, 'ok');
    if (ordinary.status === 'ok') {
      assert.equal(ordinary.snapshot.buffer?.text, 'echo ordinary input');
      assert.ok(ordinary.snapshot.directory);
    }
    await fixture.cancel();
  },
);

test('Bash fresh-draft cancellation leaves native history available', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await isolateHistory(fixture);
  const accepted = 'echo ACCEPTED_' + randomUUID();
  await appendHistory(fixture, accepted);
  await fixture.cancel();
  const observed = await readHistory(fixture);
  assert.ok(observed.history?.entries.includes(accepted));
});

test('Bash keeps native history unavailable after a vi reader returns to Emacs', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await isolateHistory(fixture);
  assert.equal((await fixture.run('set -o vi')).available, false);
  await fixture.run(" builtin history -c; builtin history -s ': older'; builtin history -s ': accepted'");
  const generation = (await fixture.prompt()).promptGeneration;
  const privateSuffix = ' NEVER_SUBMITTED_' + randomUUID();
  terminal.write('\x1b[A' + privateSuffix + '\x1b[A\x1b[B\x1b0C: safely-submitted\r');
  await fixture.prompt(generation);
  assert.equal((await fixture.run('set -o emacs')).available, true);
  const history = await fixture.request('history');
  assert.equal(history.status, 'unavailable');
  assert.ok(!JSON.stringify(history).includes(privateSuffix));
  terminal.write('echo ordinary input');
  const ordinary = await fixture.request('snapshot');
  assert.equal(ordinary.status, 'ok');
  if (ordinary.status === 'ok') assert.equal(ordinary.snapshot.buffer?.text, 'echo ordinary input');
  await fixture.cancel();
});

test('Bash native deletion refuses an ordered grant revoked by later input', { timeout: 60_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const fixture = new EditorFixture(terminal);
  await isolateHistory(fixture);
  const record = 'echo REVOKED_' + randomUUID();
  await appendHistory(fixture, record);
  const history = await readHistory(fixture);
  const namespace = history.history?.namespace;
  assert.ok(namespace);
  const event = await fixture.prompt();
  const transport = terminal.channel;
  assert.ok(transport instanceof DeliveredTerminal);
  const inputBoundary = await fixture.inputBoundary();
  const request = {
    requestId: randomUUID(),
    inputBoundary,
    target: {
      instanceId: event.shellInstanceId,
      shell: 'bash' as const,
      pid: event.pid,
      startTime: event.startTime,
    },
    operation: 'history-delete' as const,
    promptGeneration: event.promptGeneration,
    includeDirectory: false,
    ...(event.notification ? { notification: event.notification } : {}),
    expected: {
      promptGeneration: event.promptGeneration,
      editorMode: 'emacs' as const,
      history: { status: 'ok' as const, namespace, entries: [record] },
    },
  };
  const signal = new AbortController().signal;
  const result = await executeShellEditorRequest(terminal.client, editorBinaryPath('bash'), request, {
    signal,
    // Keep the desktop callback true here to exercise the Shell's independent ordered check.
    isCurrent: () => true,
    trigger: () => {},
    authorize: async () => {
      const approved = await transport.authorizeEditor(request.requestId, inputBoundary, signal);
      assert.equal(approved, true);
      terminal.write('x');
      const later = transport.inputDelivery.sent;
      assert.equal(await transport.waitForDelivery(later, signal), true);
      return approved;
    },
    revoke: () => transport.revokeEditor(request.requestId),
  });
  assert.equal(result.status, 'stale');
  const retained = await readHistory(fixture);
  assert.ok(retained.history?.entries.includes(record));
  await fixture.cancel();
});

test(
  'Bash refuses deletion beyond match and byte scan caps without partial mutation',
  { timeout: 90_000 },
  async (t) => {
    for (const [name, setup] of [
      ['more than 200 matches', 'for ((i=0; i<201; i++)); do builtin history -s BASH_CAP_RECORD; done'],
      [
        'oversized entry',
        "builtin history -s BASH_CAP_RECORD; printf -v long '%*s' 8200 ''; builtin history -s \"${long// /x}\"",
      ],
    ] as const) {
      await t.test(name, async () => {
        const terminal = await openFixtureTerminal('bash');
        try {
          const fixture = new EditorFixture(terminal);
          await isolateHistory(fixture);
          await fixture.run(setup);
          const before = await readHistory(fixture);
          const namespace = before.history?.namespace;
          assert.ok(namespace);
          const count = name === 'more than 200 matches' ? 201 : 1;
          const offset = terminal.write(
            'builtin history | command awk \'$2 == "BASH_CAP_RECORD" && NF == 2 { n++ } END { printf "NATIVE_COUNT:%d\\n", n }\'\r',
          );
          await terminal.waitFor(new RegExp('NATIVE_COUNT:' + count + '\\r?\\n', 'u'), offset);
          await fixture.prompt(before.promptGeneration);
          assert.equal((await deleteExact(fixture, namespace, 'BASH_CAP_RECORD')).status, 'unavailable');
          const afterOffset = terminal.write(
            'builtin history | command awk \'$2 == "BASH_CAP_RECORD" && NF == 2 { n++ } END { printf "NATIVE_COUNT:%d\\n", n }\'\r',
          );
          await terminal.waitFor(new RegExp('NATIVE_COUNT:' + count + '\\r?\\n', 'u'), afterOffset);
        } finally {
          terminal.close();
        }
      });
    }
  },
);
