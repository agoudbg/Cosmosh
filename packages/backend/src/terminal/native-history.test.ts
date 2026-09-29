import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShellEditorRequest, ShellEditorSnapshot } from '@cosmosh/api-contract';

import { type EditorInputTransport, ShellEditorController } from './editor-controller.js';
import { normalizeEditorSnapshot, normalizeNativeHistoryObservation } from './editor-protocol.js';
import { normalizeTerminalClientMessage } from './shared.js';
import { createShellContext, type ShellContextState } from './shell-context.js';

const observation: ShellEditorSnapshot = {
  promptGeneration: 1,
  editorMode: 'emacs',
  history: { status: 'ok', namespace: 'fish', entries: ['echo 中文🐟  ', 'begin\n echo next\nend'] },
};

const inputEpoch = '89abcdef-0123-4567-89ab-cdef01234567';

/**
 * Isolates the external SSH delivery boundary while preserving the real controller and permission checks.
 * @returns Stable original-Shell transport getter; this fixture has no terminal input writer.
 */
const orderedHistoryTransport = (): (() => EditorInputTransport) => {
  const inputDelivery = { epoch: inputEpoch, sent: 0, delivered: 0 };
  const transport: EditorInputTransport = {
    inputDelivery,
    originalShellPID: 42,
    /** @param sequence Accepted input revision. @param signal Operation lifetime. @returns Remote delivery observation. */
    waitForDelivery: async (sequence, signal) => !signal.aborted && sequence <= inputDelivery.delivered,
    /** @param _requestId Private operation. @param boundary Input revision. @param signal Lifetime. @returns Remote grant. */
    authorizeEditor: async (_requestId, boundary, signal) =>
      !signal.aborted &&
      boundary.epoch === inputDelivery.epoch &&
      boundary.sequence === inputDelivery.sent &&
      boundary.sequence === inputDelivery.delivered,
    /** @returns Nothing; the external peer has no retained authorization in these scope tests. */
    revokeEditor: () => {},
  };
  return () => transport;
};

/** @returns An original Fish editor with history permission only and no current input or directory. */
const historyState = () => ({
  ...createShellContext(
    'session',
    { history: true, input: false, cwd: false, paths: false, nativeCompletion: false },
    true,
  ),
  shell: 'fish' as const,
  shellInstanceId: '01234567-89ab-4def-8123-456789abcdef',
  status: 'paused' as const,
  requiresEditorConfirmation: true,
  promptGeneration: 1,
  capabilities: ['history-read' as const],
  editorBinding: {
    pid: 42,
    startTime: '100',
    triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
    promptGeneration: 1,
    notification: { signal: 'URG' as const },
  },
});

test('native history requests use only history permission and reject unsolicited input or directories', async () => {
  const state = historyState();
  const requests: ShellEditorRequest[] = [];
  const controller = new ShellEditorController(
    () => state,
    async (request) => {
      requests.push(request);
      return { status: 'ok', snapshot: observation };
    },
    orderedHistoryTransport(),
    () => assert.fail('history must not confirm unrelated context'),
  );
  assert.deepEqual(await controller.history(new AbortController().signal), { status: 'ok', snapshot: observation });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.operation, 'history');
  assert.equal(request.includeDirectory, false);
  assert.deepEqual(request.inputBoundary, { epoch: inputEpoch, sequence: 0 });
  assert.deepEqual(normalizeEditorSnapshot(observation, request), observation);
  for (const additional of [
    { buffer: { text: 'PRIVATE_INPUT', cursor: 0 } },
    { buffer: undefined },
    { directory: { logical: '/private' } },
  ])
    assert.equal(normalizeEditorSnapshot({ ...observation, ...additional }, request), null);
  assert.equal(normalizeEditorSnapshot(observation, { ...request, operation: 'context' }), null);
  assert.deepEqual(await controller.snapshot(), { status: 'unavailable' });
  state.permissions.history = false;
  assert.deepEqual(await controller.history(new AbortController().signal), { status: 'unavailable' });
  assert.equal(requests.length, 1);
});

test('native history cancellation is independent and at most one editor request runs', async () => {
  const state = historyState();
  let calls = 0;
  const controller = new ShellEditorController(
    () => state,
    async (_request, options) => {
      calls += 1;
      return await new Promise((resolve) =>
        options.signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true }),
      );
    },
    orderedHistoryTransport(),
    () => {},
  );
  const lifetime = new AbortController();
  const pending = controller.history(lifetime.signal);
  const waitingLifetime = new AbortController();
  const waiting = controller.history(waitingLifetime.signal);
  await Promise.resolve();
  assert.equal(calls, 1, 'waiting must not start a second private exchange');
  waitingLifetime.abort();
  assert.deepEqual(await waiting, { status: 'unavailable' });
  assert.equal(lifetime.signal.aborted, false, 'cancelling the waiter must not cancel its predecessor');
  lifetime.abort();
  assert.deepEqual(await pending, { status: 'unavailable' });
  assert.deepEqual(await controller.history(lifetime.signal), { status: 'unavailable' });
  assert.equal(calls, 1);
});

test('native history validates exact records, privacy flags, Unicode and all memory bounds', () => {
  assert.deepEqual(normalizeNativeHistoryObservation(observation.history), observation.history);
  assert.deepEqual(normalizeNativeHistoryObservation({ status: 'private', namespace: null, entries: [] }), {
    status: 'private',
    namespace: null,
    entries: [],
  });
  for (const value of [
    { status: 'private', namespace: 'fish', entries: [] },
    { status: 'private', namespace: null, entries: ['SECRET'] },
    { status: 'ok', namespace: '', entries: [] },
    { status: 'ok', namespace: 'fish', entries: [' private'] },
    { status: 'ok', namespace: 'fish', entries: ['\uD800'] },
    { status: 'ok', namespace: 'fish', entries: ['before\0after'] },
    { status: 'ok', namespace: 'fish', entries: ['x'.repeat(8193)] },
    { status: 'ok', namespace: 'fish', entries: Array.from({ length: 201 }, () => 'x') },
    { status: 'ok', namespace: 'fish', entries: Array.from({ length: 9 }, () => 'x'.repeat(8192)) },
  ])
    assert.equal(normalizeNativeHistoryObservation(value), null);
});

test('source-bound removal validates IDs and exact native records at the client boundary', () => {
  const request = {
    type: 'shell-history-remove',
    requestId: '01234567-89ab-4def-8123-456789abcdef',
    sourceId: 'fedcba98-7654-4321-8123-456789abcdef',
    command: 'printf "中文🐟\nnext"  ',
  };
  assert.deepEqual(
    normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...request, namespace: 'other', path: '/private' }))),
    request,
  );
  for (const overrides of [
    { requestId: '' },
    { requestId: 123 },
    { sourceId: 'other-source' },
    { sourceId: null },
    { command: '' },
    { command: ' ignored' },
    { command: 'before\0after' },
    { command: '\uD800' },
    { command: '🐟'.repeat(2049) },
    { command: ['echo'] },
  ])
    assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...request, ...overrides }))), null);
});

test('history opt-out after a transport result resolves still rejects that private result', async () => {
  const state = historyState();
  const lifetime = new AbortController();
  const controller = new ShellEditorController(
    () => state,
    async () => {
      lifetime.abort();
      return { status: 'ok', snapshot: observation };
    },
    orderedHistoryTransport(),
    () => {},
  );
  assert.deepEqual(await controller.history(lifetime.signal), { status: 'stale' });
});

test('history deletion preserves exact text and cannot borrow input or CWD permissions', async () => {
  const state: ShellContextState = historyState();
  const requests: ShellEditorRequest[] = [];
  const controller = new ShellEditorController(
    () => state,
    async (request) => {
      requests.push(request);
      return { status: 'history-removed-from-reader' };
    },
    orderedHistoryTransport(),
    () => assert.fail('history deletion cannot confirm input or CWD'),
  );
  const signal = new AbortController().signal;
  const command = 'begin\n echo 中文🐟  \nend\n';
  assert.deepEqual(await controller.deleteHistory('fish', command, signal), { status: 'history-removed-from-reader' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'history-delete');
  assert.equal(requests[0].includeDirectory, false);
  assert.deepEqual(requests[0].inputBoundary, { epoch: inputEpoch, sequence: 0 });
  assert.deepEqual(requests[0].expected, {
    promptGeneration: 1,
    editorMode: 'emacs',
    history: { status: 'ok', namespace: 'fish', entries: [command] },
  });
  for (const invalid of ['', ' private', 'before\0after', 'x'.repeat(8193)])
    assert.deepEqual(await controller.deleteHistory('fish', invalid, signal), { status: 'unavailable' });
  state.permissions.history = false;
  assert.deepEqual(await controller.deleteHistory('fish', command, signal), { status: 'unavailable' });
  state.permissions.history = true;
  state.promptGeneration = null;
  assert.deepEqual(await controller.deleteHistory('fish', command, signal), { status: 'unavailable' });
  assert.equal(requests.length, 1);
});
