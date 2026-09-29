import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS_VALUES, type ShellEditorSnapshot, type ShellInputBoundary } from '@cosmosh/api-contract';

import {
  confirmShellEditorContext,
  type EditorExecutor,
  type EditorInputTransport,
  ShellEditorController,
} from './editor-controller.js';
import { isSupportedBashEditorInput, normalizeEditorBuffer, normalizeEditorSnapshot } from './editor-protocol.js';
import { normalizeTerminalClientMessage } from './shared.js';
import {
  createShellContext,
  invalidateShellInput,
  resolveShellPermissions,
  type ShellContextState,
  updateShellPermissions,
} from './shell-context.js';

const epoch = '89abcdef-0123-4567-89ab-cdef01234567';

/** Explicit ordered SSH boundary double; controller identity, cache and permission checks stay real. */
class OrderedInputTransport implements EditorInputTransport {
  public inputDelivery = { epoch, sent: 0, delivered: 0 };
  public originalShellPID: number | null = 42;
  public waited: number[] = [];
  public authorized: Array<{ requestId: string; boundary: ShellInputBoundary; signal: AbortSignal }> = [];
  public revoked: string[] = [];

  /** @param sequence Sent revision. @param signal Operation lifetime. @returns The explicit remote delivery observation. */
  public async waitForDelivery(sequence: number, signal: AbortSignal): Promise<boolean> {
    this.waited.push(sequence);
    return !signal.aborted && sequence <= this.inputDelivery.delivered;
  }

  /** @param requestId Exact operation. @param boundary Delivered revision. @param signal Lifetime. @returns External grant. */
  public async authorizeEditor(requestId: string, boundary: ShellInputBoundary, signal: AbortSignal): Promise<boolean> {
    this.authorized.push({ requestId, boundary: { ...boundary }, signal });
    return !signal.aborted;
  }

  /** @param requestId Operation whose external authority is released. @returns Nothing. */
  public revokeEditor(requestId: string): void {
    this.revoked.push(requestId);
  }
}

/** @returns A stable per-test ordered SSH owner with an already delivered empty input boundary. */
const orderedTransport = (): (() => OrderedInputTransport) => {
  const transport = new OrderedInputTransport();
  return () => transport;
};

/** @returns A confirmed original editor context with no input text in public metadata. */
const readyState = (): ShellContextState => ({
  ...createShellContext('session', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true),
  shell: 'bash',
  shellInstanceId: '01234567-89ab-4def-8123-456789abcdef',
  status: 'ready',
  reason: null,
  promptGeneration: 1,
  capabilities: ['input-snapshot', 'input-apply'],
  editorBinding: {
    pid: 42,
    startTime: '100',
    triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
    promptGeneration: 1,
    notification: { callback: 'readline' },
  },
});
const snapshot: ShellEditorSnapshot = {
  promptGeneration: 1,
  editorMode: 'emacs',
  buffer: { text: 'echo 中文🐟', cursor: 8 },
  directory: { logical: '/link', physical: '/actual', home: '/home/user' },
};

test('native queries require permission and discard late results after input or permission changes', async () => {
  for (const invalidation of ['none', 'input', 'cwd', 'nativeCompletion', 'abort'] as const) {
    let state: ShellContextState = {
      ...readyState(),
      shell: 'fish',
      capabilities: ['input-snapshot', 'input-apply', 'native-completion'],
      permissions: { ...readyState().permissions, input: true, cwd: true, nativeCompletion: true },
      editorBinding: { ...readyState().editorBinding!, notification: { signal: 'URG' } },
    };
    const current: ShellEditorSnapshot = { ...snapshot, buffer: { text: 'git switch ', cursor: 11 } };
    let queries = 0;
    const lifetime = new AbortController();
    const editor = new ShellEditorController(
      () => state,
      async (request, options) => {
        if (request.operation === 'snapshot') return { status: 'ok', snapshot: current };
        queries += 1;
        assert.equal(request.operation, 'native-completion');
        assert.deepEqual(request.expected, current);
        options.trigger();
        if (invalidation === 'abort') lifetime.abort();
        else if (invalidation === 'input') {
          editor.invalidate();
          state = invalidateShellInput(state, 'x');
        } else if (invalidation !== 'none')
          state = updateShellPermissions(state, { ...state.permissions, [invalidation]: false });
        return { status: 'native-completions', completion: { status: 'ok', entries: [] } };
      },
      orderedTransport(),
      () => {},
    );
    const captured = await editor.snapshot();
    assert.ok(captured.snapshotId);
    assert.equal(
      (await editor.nativeCompletion(captured.snapshotId!, lifetime.signal)).status,
      invalidation === 'none' ? 'native-completions' : 'stale',
    );
    assert.equal(queries, 1);
    editor.invalidate();
  }
});

test('disabled native permission prevents query dispatch even with an available input snapshot', async () => {
  const state: ShellContextState = {
    ...readyState(),
    shell: 'fish',
    capabilities: ['input-snapshot', 'native-completion'],
    permissions: { ...readyState().permissions, input: true, cwd: true, nativeCompletion: false },
    editorBinding: { ...readyState().editorBinding!, notification: { signal: 'URG' } },
  };
  let calls = 0;
  const editor = new ShellEditorController(
    () => state,
    async () => {
      calls += 1;
      return { status: 'ok', snapshot: { ...snapshot, buffer: { text: 'git switch ', cursor: 11 } } };
    },
    orderedTransport(),
    () => {},
  );
  const captured = await editor.snapshot();
  assert.deepEqual(await editor.nativeCompletion(captured.snapshotId!, new AbortController().signal), {
    status: 'unavailable',
  });
  assert.equal(calls, 1);
  editor.invalidate();
});

test('editor buffers count codepoints and reject controls, oversized input, malformed Unicode and invalid cursors', () => {
  for (const buffer of [
    { text: '🐟', cursor: 2 },
    { text: '\ud800', cursor: 0 },
    { text: 'echo\nnext', cursor: 0 },
    { text: '\x1b', cursor: 0 },
    { text: 'x'.repeat(8193), cursor: 0 },
    { text: 'ok', cursor: -1 },
    { text: 'ok', cursor: 3 },
  ])
    assert.equal(normalizeEditorBuffer(buffer), null);
  assert.deepEqual(normalizeEditorBuffer({ text: '中🐟 e\u0301\t', cursor: 3 }), { text: '中🐟 e\u0301\t', cursor: 3 });
  assert.deepEqual(normalizeEditorBuffer({ text: '🐟', cursor: 1 }), { text: '🐟', cursor: 1 });
  const request = {
    requestId: '01234567-89ab-4def-8123-456789abcdef',
    inputBoundary: { epoch, sequence: 0 },
    target: { instanceId: '01234567-89ab-4def-8123-456789abcdef', shell: 'bash' as const, pid: 42, startTime: '100' },
    operation: 'context' as const,
    promptGeneration: 1,
    includeDirectory: true,
  };
  assert.equal(normalizeEditorSnapshot(snapshot, request), null, 'context-only must reject unsolicited input');
  assert.equal(
    normalizeEditorSnapshot({ ...snapshot, buffer: undefined }, request),
    null,
    'even an explicit undefined field violates the data boundary',
  );
  assert.deepEqual(
    normalizeEditorSnapshot({ promptGeneration: 1, editorMode: 'emacs', directory: snapshot.directory }, request),
    { promptGeneration: 1, editorMode: 'emacs', directory: snapshot.directory },
  );
  for (const replacement of [
    { text: 'rm -rf /\n', cursor: 0 },
    { text: '🐟', cursor: 2 },
  ])
    assert.equal(
      normalizeTerminalClientMessage(
        Buffer.from(
          JSON.stringify({
            type: 'editor-apply',
            requestId: request.requestId,
            snapshotId: request.requestId,
            replacement,
          }),
        ),
      ),
      null,
    );
});

test('Bash native completion, search, macros and unknown escapes invalidate the editor before forwarding', () => {
  for (const input of ['\t', '\x18\x12', '\x12', '\x1b\x05', '\x1b[993~', '\x1b', '\x0f', '\x07', '\x00'])
    assert.equal(isSupportedBashEditorInput(input), false);
  for (const input of ['echo 中文🐟', '\x1b[D\x1b[C', '\x1b[A\x1b[B', '\x01\x05\x7f', '\r\n', '\x03\x04'])
    assert.equal(isSupportedBashEditorInput(input), true);
});

test('editor permission is checked before any transport and after awaited capture', async () => {
  let state = readyState();
  let calls = 0;
  const editor = new ShellEditorController(
    () => state,
    async (_request, options) => {
      calls += 1;
      options.trigger();
      state = updateShellPermissions(state, { ...state.permissions, input: false });
      assert.equal(options.isCurrent(), false);
      return { status: 'ok', snapshot };
    },
    orderedTransport(),
    () => {},
  );
  assert.deepEqual(await editor.snapshot(), { status: 'stale' });
  assert.deepEqual(await editor.snapshot(), { status: 'unavailable' });
  assert.equal(calls, 1);
});

test('snapshots bind one application to the exact context and are erased by input', async () => {
  let state = readyState();
  const operations: string[] = [];
  const editor = new ShellEditorController(
    () => state,
    async (request) => {
      operations.push(request.operation);
      return request.operation === 'apply' ? { status: 'applied' } : { status: 'ok', snapshot };
    },
    orderedTransport(),
    (expected, observed) => {
      state = confirmShellEditorContext(expected, observed);
    },
  );
  const first = await editor.snapshot();
  assert.equal(first.status, 'ok');
  assert.ok(first.snapshotId);
  editor.invalidate();
  state = invalidateShellInput(state, 'x');
  assert.deepEqual(await editor.apply(first.snapshotId!, { text: 'echo new', cursor: 8 }), { status: 'stale' });
  const second = await editor.snapshot();
  assert.deepEqual(await editor.apply(second.snapshotId!, { text: 'echo new', cursor: 8 }), { status: 'applied' });
  assert.deepEqual(await editor.apply(second.snapshotId!, { text: 'echo again', cursor: 10 }), { status: 'stale' });
  assert.deepEqual(operations, ['snapshot', 'snapshot', 'apply']);
  assert.equal(state.inputGeneration, 2);
  assert.equal(JSON.stringify(state).includes('echo'), false);
});

test('candidate identifiers own immutable edits and expire with their session snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let state = readyState();
  const requests: string[] = [];
  const editor = new ShellEditorController(
    () => state,
    async (request) => {
      requests.push(request.operation);
      if (request.operation === 'apply') {
        assert.deepEqual(request.replacement, { text: "echo '完成🐟'", cursor: 10 });
        return { status: 'applied' };
      }
      return { status: 'ok', snapshot };
    },
    orderedTransport(),
    () => {},
  );
  const draft = {
    label: '完成🐟',
    detail: null,
    source: 'runtime' as const,
    kind: 'path' as const,
    edit: { start: 5, end: 8, text: "'完成🐟'" },
  };
  const first = (await editor.snapshot()).snapshotId!;
  const candidate = editor.bindCandidates(first, [draft])![0];
  assert.deepEqual(Object.keys(candidate).sort(), ['detail', 'id', 'kind', 'label', 'source']);
  draft.edit.text = 'mutated';
  assert.deepEqual(await editor.applyCandidate('another-snapshot', candidate.id), { status: 'stale' });
  assert.deepEqual(await editor.applyCandidate(first, 'another-candidate'), { status: 'stale' });
  assert.deepEqual(await editor.applyCandidate(first, candidate.id), { status: 'applied' });
  assert.deepEqual(await editor.applyCandidate(first, candidate.id), { status: 'stale' });
  const second = (await editor.snapshot()).snapshotId!;
  const later = editor.bindCandidates(second, [draft])![0];
  assert.deepEqual(await editor.applyCandidate(second, candidate.id), { status: 'stale' });
  state = invalidateShellInput(state, 'x');
  assert.equal(editor.bindCandidates(second, [draft]), null);
  assert.deepEqual(await editor.applyCandidate(second, later.id), { status: 'stale' });
  const third = (await editor.snapshot()).snapshotId!;
  const expired = editor.bindCandidates(third, [draft])![0];
  t.mock.timers.tick(10_000);
  assert.equal(editor.bindCandidates(third, [draft]), null);
  assert.deepEqual(await editor.applyCandidate(third, expired.id), { status: 'stale' });
  assert.deepEqual(requests, ['snapshot', 'apply', 'snapshot', 'snapshot']);
});

test('late sources append within a fixed candidate bound without invalidating already displayed identifiers', async () => {
  const state = readyState();
  const editor = new ShellEditorController(
    () => state,
    async (request) => (request.operation === 'apply' ? { status: 'applied' } : { status: 'ok', snapshot }),
    orderedTransport(),
    () => {},
  );
  const id = (await editor.snapshot()).snapshotId!;
  const draft = {
    label: 'file',
    detail: null,
    source: 'runtime' as const,
    kind: 'path' as const,
    edit: { start: 5, end: 8, text: "'file'" },
  };
  assert.deepEqual(editor.bindCandidates(id, [{ ...draft, edit: { ...draft.edit, end: 9 } }]), []);
  const first = editor.bindCandidates(id, [draft])![0];
  assert.equal(
    editor.bindCandidates(
      id,
      Array.from({ length: 200 }, () => draft),
    )!.length,
    127,
  );
  assert.deepEqual(editor.bindCandidates(id, [draft]), []);
  assert.deepEqual(await editor.applyCandidate(id, first.id), { status: 'applied' });
});

test('ordinary SSH, an unknown notification and a different Shell process never dispatch an editor request', async () => {
  for (const unavailable of ['ordinary', 'notification', 'process', 'closed'] as const) {
    const state = readyState();
    const transport = new OrderedInputTransport();
    if (unavailable === 'notification') delete state.editorBinding!.notification;
    if (unavailable === 'process') transport.originalShellPID = 43;
    if (unavailable === 'closed') transport.originalShellPID = null;
    const editor = new ShellEditorController(
      () => state,
      async () => assert.fail('an unverified owner must not open an editor channel'),
      () => (unavailable === 'ordinary' ? null : transport),
      () => assert.fail('an unverified owner cannot confirm context'),
    );
    assert.deepEqual(await editor.snapshot(), { status: 'unavailable' });
    assert.equal(await editor.refreshContext(), false);
    assert.deepEqual(transport.waited, []);
    assert.deepEqual(transport.authorized, []);
  }
});

test('idle private snapshots are actively erased after ten seconds and replacement resets retention', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = readyState();
  const editor = new ShellEditorController(
    () => state,
    async () => ({ status: 'ok', snapshot }),
    orderedTransport(),
    () => {},
  );
  const retained = editor as unknown as { cached: unknown; expiryTimer: unknown };
  await editor.snapshot();
  t.mock.timers.tick(9_000);
  assert.notEqual(retained.cached, null);
  await editor.snapshot();
  t.mock.timers.tick(1_000);
  assert.notEqual(retained.cached, null);
  t.mock.timers.tick(9_000);
  assert.equal(retained.cached, null);
  assert.equal(retained.expiryTimer, null);
  await editor.snapshot();
  editor.invalidate();
  assert.equal(retained.cached, null);
  assert.equal(retained.expiryTimer, null);
});

test('context refresh respects input and directory permissions independently', async () => {
  let state = readyState();
  const operations: Array<{ operation: string; includeDirectory: boolean }> = [];
  const execute: EditorExecutor = async (request) => {
    operations.push(request);
    return {
      status: 'ok',
      snapshot: {
        promptGeneration: 1,
        editorMode: 'emacs',
        ...(request.includeDirectory ? { directory: snapshot.directory } : {}),
      },
    };
  };
  let current: ShellContextState = { ...state, permissions: { ...state.permissions, input: false } };
  const editor = new ShellEditorController(
    () => current,
    execute,
    orderedTransport(),
    (expected, observed) => {
      current = confirmShellEditorContext(expected, observed);
    },
  );
  assert.equal(await editor.refreshContext(), true);
  assert.equal(current.status, 'ready');
  assert.deepEqual(current.cwd, snapshot.directory);
  state = { ...state, permissions: { ...state.permissions, cwd: false } };
  current = state;
  assert.equal(await editor.refreshContext(), true);
  assert.equal(current.cwd, null);
  assert.deepEqual(
    operations.map(({ operation, includeDirectory }) => ({ operation, includeDirectory })),
    [
      { operation: 'context', includeDirectory: true },
      { operation: 'context', includeDirectory: false },
    ],
  );
});

test('an ambiguous queued prompt cannot authorize a context probe into a later silent reader', async () => {
  const state = { ...readyState(), status: 'paused' as const, requiresEditorConfirmation: true };
  delete state.editorBinding!.notification;
  let requests = 0;
  const editor = new ShellEditorController(
    () => state,
    async () => {
      requests += 1;
      return { status: 'unavailable' };
    },
    orderedTransport(),
    () => {},
  );
  assert.equal(await editor.refreshContext(), false);
  assert.deepEqual(await editor.snapshot(), { status: 'unavailable' });
  assert.equal(requests, 0);
});

test('a verified notification adapter can recover paused context without reading input or injecting keys', async () => {
  let state: ShellContextState = {
    ...readyState(),
    shell: 'zsh',
    status: 'paused',
    requiresEditorConfirmation: true,
    editorBinding: { ...readyState().editorBinding!, notification: { fd: 12, inode: '12345' } },
    permissions: { ...readyState().permissions, input: false },
  };
  let attempts = 0;
  const editor = new ShellEditorController(
    () => state,
    async (request, options) => {
      attempts += 1;
      assert.equal(request.operation, 'context');
      assert.deepEqual(request.notification, { fd: 12, inode: '12345' });
      options.trigger();
      if (attempts === 1) return { status: 'unavailable' };
      return { status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: snapshot.directory } };
    },
    orderedTransport(),
    (expected, observed) => {
      state = confirmShellEditorContext(expected, observed);
    },
  );
  assert.equal(await editor.refreshContext(), false);
  assert.equal(await editor.refreshContext(), true, 'a canceled notification must not lock the prompt epoch');
  assert.equal(state.status, 'ready');
  assert.equal(state.requiresEditorConfirmation, false);
  assert.deepEqual(state.cwd, snapshot.directory);
  assert.deepEqual(await editor.snapshot(), { status: 'unavailable' });
  state = updateShellPermissions(state, { ...state.permissions, cwd: false });
  assert.equal(await editor.refreshContext(), false);
  assert.equal(attempts, 2);
});

test('ZLE context recovery coalesces latest input while an older request waits for channel cleanup', async () => {
  let state: ShellContextState = {
    ...readyState(),
    shell: 'zsh',
    editorBinding: { ...readyState().editorBinding!, notification: { fd: 12, inode: '12345' } },
  };
  let release: (() => void) | null = null;
  let calls = 0;
  const controller = new ShellEditorController(
    () => state,
    async (_request, options) => {
      calls += 1;
      options.trigger();
      if (calls === 1)
        return await new Promise((resolve) => {
          release = () => resolve({ status: 'unavailable' });
        });
      return { status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: snapshot.directory } };
    },
    orderedTransport(),
    (expected, observed) => {
      state = confirmShellEditorContext(expected, observed);
    },
  );
  const previous = controller.snapshot();
  await Promise.resolve();
  controller.invalidate();
  state = { ...invalidateShellInput(state, 'x'), status: 'paused', requiresEditorConfirmation: true, cwd: null };
  const refresh = controller.refreshContext();
  state = invalidateShellInput(state, 'y');
  assert.equal(controller.refreshContext(), refresh, 'only one pending recovery may wait for cleanup');
  assert.equal(calls, 1);
  (release as (() => void) | null)?.();
  assert.equal((await previous).status, 'unavailable');
  assert.equal(await refresh, true);
  assert.equal(calls, 2, 'cleanup must be followed by exactly one request for the latest context');
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.cwd, snapshot.directory);
});

test('input cancellation closes the active request, rejects overlap and releases retained text', async () => {
  const state = readyState();
  let calls = 0;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const editor = new ShellEditorController(
    () => state,
    async (_request, options) => {
      calls += 1;
      if (calls > 1) return { status: 'unavailable' };
      options.trigger();
      entered?.();
      return await new Promise((resolve) =>
        options.signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true }),
      );
    },
    orderedTransport(),
    () => {},
  );
  const active = editor.snapshot();
  await started;
  assert.deepEqual(await editor.snapshot(), { status: 'unavailable' });
  editor.invalidate();
  assert.deepEqual(await active, { status: 'unavailable' });
  assert.deepEqual(await editor.snapshot(), { status: 'unavailable' });
  assert.equal(calls, 2, 'a canceled native operation does not permanently lock the prompt');
});

test('snapshot dispatch waits for actual delivery and binds that exact boundary to authorization', async () => {
  const state = readyState();
  const transport = new OrderedInputTransport();
  transport.inputDelivery = { epoch, sent: 2, delivered: 1 };
  let delivered: ((value: boolean) => void) | undefined;
  transport.waitForDelivery = async (sequence, signal) => {
    assert.equal(sequence, 2);
    assert.equal(signal.aborted, false);
    if (transport.inputDelivery.delivered === 2) return true;
    return await new Promise<boolean>((resolve) => {
      delivered = resolve;
    });
  };
  let calls = 0;
  const editor = new ShellEditorController(
    () => state,
    async (request, options) => {
      calls += 1;
      assert.deepEqual(request.inputBoundary, { epoch, sequence: 2 });
      assert.equal(options.isCurrent(), true);
      if (request.operation === 'snapshot') return { status: 'ok', snapshot };
      assert.equal(await options.authorize(), true);
      assert.equal(transport.authorized.at(-1)?.requestId, request.requestId);
      assert.deepEqual(transport.authorized.at(-1)?.boundary, request.inputBoundary);
      assert.equal(transport.authorized.at(-1)?.signal, options.signal);
      return { status: 'applied' };
    },
    () => transport,
    () => {},
  );
  const pending = editor.snapshot();
  await Promise.resolve();
  assert.equal(calls, 0, 'a local send must not start an editor observation');
  transport.inputDelivery.delivered = 2;
  delivered?.(true);
  const captured = await pending;
  assert.equal(captured.status, 'ok');
  assert.ok(captured.snapshotId);
  assert.deepEqual(await editor.apply(captured.snapshotId!, { text: 'echo accepted', cursor: 13 }), {
    status: 'applied',
  });
  assert.equal(calls, 2);
  assert.equal(transport.revoked.at(-1), transport.authorized.at(-1)?.requestId);
});

test('delivery failure and identity changes during its wait reject before opening an editor channel', async () => {
  for (const change of ['delivery', 'input', 'epoch', 'process', 'owner', 'cancel'] as const) {
    const state = readyState();
    let transport = new OrderedInputTransport();
    const original = transport;
    let delivered: ((value: boolean) => void) | undefined;
    original.waitForDelivery = async () =>
      await new Promise<boolean>((resolve) => {
        delivered = resolve;
      });
    const editor = new ShellEditorController(
      () => state,
      async () => assert.fail('a stale delivery wait must not open an editor channel'),
      () => transport,
      () => {},
    );
    const pending = editor.snapshot();
    if (change === 'input') original.inputDelivery = { epoch, sent: 1, delivered: 1 };
    if (change === 'epoch') original.inputDelivery.epoch = 'fedcba98-7654-4321-89ab-0123456789ab';
    if (change === 'process') original.originalShellPID = 43;
    if (change === 'owner') transport = new OrderedInputTransport();
    if (change === 'cancel') editor.invalidate();
    delivered?.(change !== 'delivery');
    assert.deepEqual(await pending, { status: 'stale' }, change);
    assert.equal(original.revoked.length, 1);
  }
});

test('new delivery invalidates retained candidates even when public Shell metadata has not changed', async () => {
  const state = readyState();
  const transport = new OrderedInputTransport();
  const editor = new ShellEditorController(
    () => state,
    async () => ({ status: 'ok', snapshot }),
    () => transport,
    () => {},
  );
  const draft = {
    label: 'new',
    detail: null,
    source: 'runtime' as const,
    kind: 'path' as const,
    edit: { start: 5, end: 8, text: 'new' },
  };
  const captured = await editor.snapshot();
  const candidate = editor.bindCandidates(captured.snapshotId!, [draft])![0];
  transport.inputDelivery = { epoch, sent: 1, delivered: 1 };
  assert.equal(editor.bindCandidates(captured.snapshotId!, [draft]), null);
  assert.deepEqual(await editor.applyCandidate(captured.snapshotId!, candidate.id), { status: 'stale' });
  assert.deepEqual(transport.authorized, []);
  editor.invalidate();
});

test('input advancing during a private observation discards the late snapshot without caching it', async () => {
  const state = readyState();
  const transport = new OrderedInputTransport();
  const editor = new ShellEditorController(
    () => state,
    async (_request, options) => {
      transport.inputDelivery = { epoch, sent: 1, delivered: 1 };
      assert.equal(options.isCurrent(), false);
      assert.equal(await options.authorize(), false);
      return { status: 'ok', snapshot };
    },
    () => transport,
    () => {},
  );
  assert.deepEqual(await editor.snapshot(), { status: 'stale' });
  assert.deepEqual(transport.authorized, []);
});
