import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShellContext, TerminalCompletionUpdate } from '@cosmosh/api-contract';

import {
  bindCompletionViewUpdate,
  canRequestTerminalCompletion,
  completionQueryNotice,
  type CompletionViewRequest,
  retainsCompletionView,
  shouldQueryAfterTerminalInput,
} from './terminal-completion-state';

/** @returns A confirmed original Shell with independent permissions. */
const context = (): ShellContext => ({
  sessionId: 'session',
  shellInstanceId: 'shell',
  shell: 'bash',
  helperVersion: 'test',
  protocolVersion: 3,
  capabilities: ['input-snapshot', 'input-apply'],
  permissions: { input: true, history: true, cwd: false, paths: false, nativeCompletion: false },
  editorAvailable: true,
  status: 'ready',
  reason: null,
  revision: 10,
  inputGeneration: 4,
  submissionToken: null,
  promptGeneration: 3,
  cwdGeneration: 0,
  cwd: null,
  lastKnownCwd: null,
});
/** @returns Pending authority before the Backend has confirmed the input. */
const request = (): CompletionViewRequest => ({
  paneId: 'pane-1',
  requestId: 'query',
  trigger: 'typing',
  sessionId: 'session',
  shellInstanceId: 'shell',
  promptGeneration: 3,
  snapshotId: null,
  contextRevision: null,
});
/** @returns An empty first batch, followed later by independently completed sources. */
const update = (): TerminalCompletionUpdate => ({
  type: 'completion-update',
  requestId: 'query',
  snapshotId: 'snapshot',
  contextRevision: 10,
  status: 'ready',
  complete: false,
  items: [],
  sources: { history: 'ok', metadata: 'ok', paths: 'loading', native: 'disabled' },
});

test('queries tolerate their initial editor confirmation without giving an old displayed menu a new revision', () => {
  const pending = request();
  const waiting = { ...context(), status: 'paused' as const, reason: 'waiting-for-prompt' as const };
  assert.equal(canRequestTerminalCompletion(waiting), true);
  assert.equal(retainsCompletionView(pending, waiting), true);
  const confirmed = { ...context(), revision: 12, inputGeneration: 5 };
  assert.equal(retainsCompletionView(pending, confirmed), true);
  const bound = bindCompletionViewUpdate(pending, 'pane-1', confirmed, { ...update(), contextRevision: 12 });
  assert.ok(bound);
  assert.equal(retainsCompletionView(bound, confirmed), true);
  assert.equal(retainsCompletionView(bound, { ...confirmed, revision: 13 }), false);
  assert.equal(
    bindCompletionViewUpdate(bound, 'pane-1', { ...confirmed, revision: 13 }, { ...update(), contextRevision: 13 }),
    null,
  );
});

test('results cannot cross a pane, query, Shell, session, prompt or snapshot boundary', () => {
  assert.equal(bindCompletionViewUpdate(request(), 'pane-2', context(), update()), null);
  assert.equal(
    bindCompletionViewUpdate(request(), 'pane-1', context(), { ...update(), requestId: 'older-query' }),
    null,
  );
  for (const changed of [{ sessionId: 'new-session' }, { shellInstanceId: 'nested-shell' }, { promptGeneration: 4 }]) {
    assert.equal(retainsCompletionView(request(), { ...context(), ...changed }), false);
  }
  const bound = bindCompletionViewUpdate(request(), 'pane-1', context(), update());
  assert.ok(bound);
  assert.equal(
    bindCompletionViewUpdate(bound, 'pane-1', context(), { ...update(), snapshotId: 'different-snapshot' }),
    null,
  );
  assert.equal(
    bindCompletionViewUpdate(bound, 'pane-1', context(), { ...update(), complete: true })?.snapshotId,
    'snapshot',
  );
});

test('unsupported editor states and revoked permissions immediately remove query authority', () => {
  assert.equal(canRequestTerminalCompletion(null), false);
  assert.equal(canRequestTerminalCompletion({ ...context(), editorAvailable: false }), false);
  assert.equal(retainsCompletionView(request(), { ...context(), editorAvailable: false }), false);
  for (const state of ['unavailable', 'initializing', 'busy'] as const) {
    assert.equal(retainsCompletionView(request(), { ...context(), status: state }), false);
  }
  for (const reason of ['input-submitted', 'foreign-shell', 'unsupported-editor', 'permission-disabled'] as const) {
    assert.equal(canRequestTerminalCompletion({ ...context(), status: 'paused', reason }), false);
  }
  assert.equal(
    retainsCompletionView(request(), { ...context(), permissions: { ...context().permissions, input: false } }),
    false,
  );
  assert.equal(retainsCompletionView(request(), { ...context(), capabilities: ['input-snapshot'] }), false);
  for (const status of ['stale', 'unsupported', 'unavailable', 'unknown'] as const) {
    assert.equal(bindCompletionViewUpdate(request(), 'pane-1', context(), { ...update(), status }), null);
  }
});

test('only final empty queries explain fixed source failures without exposing private diagnostics', () => {
  assert.equal(completionQueryNotice(update()), null);
  assert.equal(completionQueryNotice({ ...update(), complete: true, status: 'stale' }), null);
  const complete = {
    ...update(),
    complete: true,
    sources: { history: 'ok', metadata: 'ok', paths: 'ok', native: 'disabled' },
  } as const;
  assert.equal(completionQueryNotice(complete), 'ssh.autocomplete.noMatches');
  for (const [source, reason] of [
    ['timeout', 'queryTimeout'],
    ['private', 'queryPrivate'],
    ['unavailable', 'queryUnavailable'],
    ['unsupported', 'queryUnsupported'],
  ] as const) {
    assert.equal(
      completionQueryNotice({ ...complete, sources: { ...complete.sources, native: source } }),
      'ssh.enhancementStatus.reasons.' + reason,
    );
  }
});

test('input is only classified for scheduling; controls never become guessed command text', () => {
  for (const data of ['g', 'git status', '中文🐟', '\x7f', '\b'])
    assert.equal(shouldQueryAfterTerminalInput(data), true);
  for (const data of ['', '\r', '\n', '\x03', '\t', '\x1b[D', '\x12', '\x1b[200~text\x1b[201~', 'two\nlines']) {
    assert.equal(shouldQueryAfterTerminalInput(data), false);
  }
});
