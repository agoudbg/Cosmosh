import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import {
  DEFAULT_SETTINGS_VALUES,
  type SettingsValues,
  type ShellEditorBuffer,
  type ShellEditorRequest,
  type ShellEditorSnapshot,
  type ShellHistoryView,
  type ShellPathQueryResult,
  type TerminalCompletionAcceptResult,
  type TerminalCompletionUpdate,
} from '@cosmosh/api-contract';

import type { ShellEditorResult } from '../../ssh/editor-exec.js';
import {
  confirmShellEditorContext,
  type EditorExecutor,
  type EditorInputTransport,
  ShellEditorController,
} from '../editor-controller.js';
import { normalizeTerminalClientMessage } from '../shared.js';
import {
  createShellContext,
  invalidateShellInput,
  resolveShellPermissions,
  type ShellContextState,
} from '../shell-context.js';
import { emptyPathResult, type RemotePathExecutor, RemotePathQueryController } from './remote-path-query.js';
import { SnapshotCompletionController } from './snapshot-completion.js';

/** @returns An explicitly controlled external operation/cleanup boundary. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

/** @param predicate Observable boundary condition. @returns Completion or a bounded, useful assertion failure. */
const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await setImmediate();
  assert.ok(predicate(), 'the expected transport/publication boundary was reached');
};

/** @param options Initial persisted preferences/input and explicit SSH executors. @returns Real editor/provider orchestration with isolated external I/O. */
const harness = (
  options: {
    settings?: Partial<SettingsValues>;
    buffer?: ShellEditorBuffer;
    shell?: 'bash' | 'zsh' | 'fish';
    execute?: EditorExecutor;
    paths?: RemotePathExecutor;
    readSettings?: () => Promise<SettingsValues>;
    onConfirm?: () => void;
    publish?: (message: TerminalCompletionUpdate | TerminalCompletionAcceptResult) => void;
    onIdle?: () => void;
  } = {},
) => {
  const settings: SettingsValues = { ...DEFAULT_SETTINGS_VALUES, ...options.settings };
  const transport: EditorInputTransport = {
    inputDelivery: { epoch: randomUUID(), sent: 0, delivered: 0 },
    originalShellPID: 42,
    waitForDelivery: async (sequence, signal) => !signal.aborted && sequence === transport.inputDelivery.delivered,
    authorizeEditor: async (_id, boundary, signal) =>
      !signal.aborted &&
      boundary.epoch === transport.inputDelivery.epoch &&
      boundary.sequence === transport.inputDelivery.sent &&
      boundary.sequence === transport.inputDelivery.delivered,
    revokeEditor: () => {},
  };
  let state: ShellContextState = {
    ...createShellContext('session', resolveShellPermissions(settings, true), true),
    shell: options.shell ?? 'fish',
    shellInstanceId: randomUUID(),
    status: 'ready',
    reason: null,
    promptGeneration: 1,
    capabilities: ['input-snapshot', 'input-apply', 'directory-read', 'history-read', 'native-completion'],
    editorBinding: {
      pid: 42,
      startTime: '100',
      triggerNonce: randomUUID(),
      promptGeneration: 1,
      notification: { signal: 'URG' },
    },
  };
  const snapshot: ShellEditorSnapshot = {
    promptGeneration: 1,
    editorMode: 'emacs',
    buffer: options.buffer ?? { text: 'git st', cursor: 6 },
    directory: { logical: '/work', physical: '/actual', home: '/home/test' },
  };
  let history: ShellHistoryView = {
    status: 'ok',
    source: { id: randomUUID(), shell: options.shell ?? 'fish', namespace: 'native' },
    entries: ['git status --short', 'git stash saved'],
  };
  const requests: ShellEditorRequest[] = [];
  const messages: Array<TerminalCompletionUpdate | TerminalCompletionAcceptResult> = [];
  const editor = new ShellEditorController(
    () => state,
    async (request, exchange) => {
      requests.push(request);
      if (options.execute) return await options.execute(request, exchange);
      if (request.operation === 'apply')
        return { status: (await exchange.authorize()) && exchange.isCurrent() ? 'applied' : 'stale' };
      if (request.operation === 'context')
        return { status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: snapshot.directory } };
      if (request.operation === 'native-completion')
        return { status: 'native-completions', completion: { status: 'ok', entries: [] } };
      return { status: 'ok', snapshot };
    },
    () => transport,
    (expected, captured) => {
      if (state === expected) state = confirmShellEditorContext(state, captured);
      options.onConfirm?.();
    },
  );
  const controller = new SnapshotCompletionController({
    editor,
    paths: new RemotePathQueryController(options.paths ?? (async () => emptyPathResult('ok'))),
    context: () => state,
    readSettings: options.readSettings ?? (async () => ({ ...settings })),
    history: () => history,
    publish: (message) => {
      messages.push(message);
      options.publish?.(message);
    },
    onIdle: options.onIdle,
  });
  return {
    controller,
    editor,
    transport,
    settings,
    snapshot,
    requests,
    messages,
    query: (trigger: 'typing' | 'manual' = 'manual', requestId = randomUUID()) => ({
      requestId,
      finished: controller.query({ type: 'completion-query', trigger, requestId }),
    }),
    updates: (): TerminalCompletionUpdate[] =>
      messages.filter((message): message is TerminalCompletionUpdate => message.type === 'completion-update'),
    results: (): TerminalCompletionAcceptResult[] =>
      messages.filter(
        (message): message is TerminalCompletionAcceptResult => message.type === 'completion-accept-result',
      ),
    state: () => state,
    setState: (next: ShellContextState): void => {
      state = next;
      controller.contextChanged();
    },
    setHistory: (view: ShellHistoryView): void => {
      history = view;
      controller.historyChanged();
    },
    input: (): void => {
      controller.invalidate();
      state = invalidateShellInput(state, 'x');
      transport.inputDelivery.sent += 1;
      transport.inputDelivery.delivered += 1;
    },
    close: (): void => controller.invalidate(true, false),
  };
};

test('failed initial or unavailable publications resolve and release private query state', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
  for (const enabled of [true, false]) {
    const h = harness({
      settings: { terminalAutoCompleteEnabled: enabled, terminalNativeCompletionMode: 'off' },
      publish: () => {
        throw new Error('private-candidate-notification');
      },
    });
    t.after(h.close);
    await assert.doesNotReject(h.query().finished);
    assert.equal(h.controller.busy, false);
    assert.equal(
      h.requests.some((request) => request.operation === 'native-completion'),
      false,
    );
    const id = h.updates()[0]?.snapshotId;
    if (id) assert.equal(h.editor.bindCandidates(id, []), null);
  }
  assert.equal(warnings.length, 2);
  assert.equal(JSON.stringify(warnings).includes('private-candidate-notification'), false);
});

test('input cancels sources and releases private state before a stale notification can fail', async (t) => {
  const cleanup = deferred<ShellPathQueryResult>();
  const warnings: unknown[][] = [];
  const observed: Array<{ busy: boolean; aborted: boolean }> = [];
  let sourceSignal: AbortSignal | null = null;
  t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
  const h = harness({
    settings: { terminalNativeCompletionMode: 'off' },
    paths: async (_request, signal) => {
      sourceSignal = signal;
      return cleanup.promise;
    },
    publish: (message) => {
      if (message.type !== 'completion-update' || message.status !== 'stale') return;
      observed.push({ busy: h.controller.busy, aborted: sourceSignal?.aborted ?? false });
      throw new Error('private-candidate-notification');
    },
  });
  t.after(h.close);
  const query = h.query();
  await until(() => sourceSignal !== null);
  const update = h.updates()[0];
  assert.doesNotThrow(h.input);
  assert.equal(h.transport.inputDelivery.sent, 1);
  assert.deepEqual(observed, [{ busy: false, aborted: true }]);
  assert.equal(h.editor.bindCandidates(update.snapshotId!, []), null);
  cleanup.resolve(emptyPathResult('cancelled'));
  await assert.doesNotReject(query.finished);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes('private-candidate-notification'), false);
});

test('failed acceptance acknowledgements and idle observers never reject or repeat a verified edit', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
  const h = harness({
    settings: { terminalNativeCompletionMode: 'off', terminalAutoCompletePathEnabled: false },
    publish: (message) => {
      if (message.type === 'completion-accept-result') throw new Error('private-acknowledgement');
    },
    onIdle: () => {
      throw new Error('private-background-observer');
    },
  });
  t.after(h.close);
  await h.query().finished;
  const update = h.updates()[0];
  const selected = {
    type: 'completion-accept' as const,
    requestId: randomUUID(),
    snapshotId: update.snapshotId!,
    candidateId: update.items[0].id,
  };
  await assert.doesNotReject(h.controller.accept(selected));
  assert.equal(h.controller.busy, false);
  assert.equal(h.results()[0].status, 'applied');
  await assert.doesNotReject(h.controller.accept({ ...selected, requestId: randomUUID() }));
  assert.equal(h.results()[1].status, 'stale');
  assert.equal(h.requests.filter((request) => request.operation === 'apply').length, 1);
  assert.equal(warnings.length, 3);
  assert.equal(JSON.stringify(warnings).includes('private-'), false);
});

test('new messages accept only canonical opaque identifiers and reject input/settings guesses', () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const messages = [
    { type: 'completion-query', requestId: id, trigger: 'typing' },
    { type: 'completion-cancel', requestId: id },
    { type: 'completion-accept', requestId: id, snapshotId: randomUUID(), candidateId: randomUUID() },
  ];
  for (const message of messages) {
    assert.deepEqual(normalizeTerminalClientMessage(Buffer.from(JSON.stringify(message))), message);
    for (const extra of [
      { linePrefix: 'secret' },
      { workingDirectoryHint: '/' },
      { replacement: { text: 'bad', cursor: 3 } },
      { includePathSuggestions: true },
    ])
      assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...message, ...extra }))), null);
    for (const requestId of ['-'.repeat(36), id.toUpperCase(), id.replace('-4', '-1'), '', id + 'x'])
      assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...message, requestId }))), null);
  }
  assert.equal(
    normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...messages[0], trigger: 'unknown' }))),
    null,
  );
});

test('immediate history/metadata stay visible while path and Fish sources append stable opaque IDs', async (t) => {
  const path = deferred<ShellPathQueryResult>();
  const native = deferred<ShellEditorResult>();
  const h = harness({
    settings: { terminalAutoCompleteMaxItems: 20, terminalAutoCompleteFuzzyMatch: false },
    paths: async () => path.promise,
    execute: async (request) =>
      request.operation === 'native-completion' ? native.promise : { status: 'ok', snapshot: h.snapshot },
  });
  t.after(h.close);
  const query = h.query();
  await until(() => h.updates().length === 1);
  const first = h.updates()[0];
  assert.equal(first.complete, false);
  assert.ok(first.items.some((item) => item.source === 'history'));
  assert.ok(first.items.some((item) => item.source === 'inshellisense'));
  assert.deepEqual(first.sources, { history: 'ok', metadata: 'ok', paths: 'loading', native: 'loading' });
  path.resolve({ status: 'ok', scanned: 1, entries: [{ name: 'st-file', kind: 'file' }] });
  await until(() => h.updates().length === 2);
  native.resolve({
    status: 'native-completions',
    completion: { status: 'ok', entries: [{ token: 'stash-new', value: 'stash-new', detail: 'branch' }] },
  });
  await query.finished;
  const last = h.updates().at(-1)!;
  assert.equal(last.complete, true);
  assert.equal(last.snapshotId, first.snapshotId);
  assert.equal(last.contextRevision, first.contextRevision);
  assert.ok(last.items.some((item) => item.source === 'fish'));
  assert.ok(last.items.some((item) => item.kind === 'path'));
  for (const item of first.items) {
    const retained = last.items.find((candidate) => candidate.label === item.label);
    if (retained) assert.equal(retained.id, item.id);
  }
  for (const item of last.items) {
    for (const key of ['edit', 'insertText', 'replacement', 'buffer', 'replacePrefixLength'])
      assert.equal(key in item, false);
  }
});

for (const crowdedSource of ['directory', 'history', 'both'] as const) {
  test('Fish priority survives crowded ' + crowdedSource + ' and retains bound IDs', async (t) => {
    const native = deferred<ShellEditorResult>();
    let nativeStarted = false;
    const h = harness({
      buffer: { text: 'git switch ', cursor: 11 },
      settings: {
        terminalAutoCompleteMaxItems: 20,
        terminalAutoCompleteHistoryEnabled: crowdedSource !== 'directory',
        terminalAutoCompletePathEnabled: crowdedSource !== 'history',
        terminalAutoCompleteBuiltInCommandsEnabled: false,
        terminalNativeCompletionMode: 'manual',
      },
      paths: async () => ({
        status: 'ok',
        scanned: 40,
        entries: Array.from({ length: 40 }, (_, index) => ({ name: 'generic-file-' + index, kind: 'file' })),
      }),
      execute: async (request, exchange) => {
        if (request.operation === 'native-completion') {
          nativeStarted = true;
          return native.promise;
        }
        if (request.operation === 'apply') return { status: (await exchange.authorize()) ? 'applied' : 'stale' };
        return { status: 'ok', snapshot: h.snapshot };
      },
    });
    t.after(h.close);
    h.setHistory({
      status: 'ok',
      source: { id: randomUUID(), shell: 'fish', namespace: 'native' },
      entries: Array.from({ length: 40 }, (_, index) => 'git switch historical-' + index),
    });
    const query = h.query();
    await until(
      () =>
        nativeStarted && h.updates().some((update) => update.items.length === 20 && update.sources.paths !== 'loading'),
    );
    const before = h.updates().at(-1)!;
    const selectedBeforeNative = before.items.at(-1)!;
    native.resolve({
      status: 'native-completions',
      completion: {
        status: 'ok',
        entries: [
          { token: 'feature/z-first', value: 'feature/z-first', detail: 'Current branch choice' },
          { token: 'feature/a-second', value: 'feature/a-second', detail: 'Another branch choice' },
        ],
      },
    });
    await query.finished;
    const after = h.updates().at(-1)!;
    assert.equal(after.sources.native, 'ok');
    assert.equal(after.items.length, 20);
    assert.deepEqual(
      after.items.slice(0, 2).map((item) => [item.source, item.label]),
      [
        ['fish', 'feature/z-first'],
        ['fish', 'feature/a-second'],
      ],
    );
    assert.equal(
      after.items.some((item) => item.id === selectedBeforeNative.id),
      false,
    );
    for (const retained of after.items.slice(2)) {
      assert.equal(retained.id, before.items.find((item) => item.label === retained.label)?.id);
    }
    // Renderer may retain its focused row inside the visible item limit; its immutable edit remains bound.
    await h.controller.accept({
      type: 'completion-accept',
      requestId: randomUUID(),
      snapshotId: before.snapshotId!,
      candidateId: selectedBeforeNative.id,
    });
    assert.equal(h.results().at(-1)?.status, 'applied');
    assert.equal(h.requests.filter((request) => request.operation === 'apply').length, 1);
  });
}

for (const inputDuringCleanup of [false, true]) {
  test(
    'accept waits for real source cleanup, preserving the selection; input during cleanup=' + inputDuringCleanup,
    async (t) => {
      const pathCleanup = deferred<ShellPathQueryResult>();
      const nativeCleanup = deferred<ShellEditorResult>();
      let pathSignal: AbortSignal | null = null;
      let nativeSignal: AbortSignal | null = null;
      const h = harness({
        paths: async (_request, signal) => {
          pathSignal = signal;
          return pathCleanup.promise;
        },
        execute: async (request, exchange) => {
          if (request.operation === 'native-completion') {
            nativeSignal = exchange.signal;
            return nativeCleanup.promise;
          }
          if (request.operation === 'apply') return { status: (await exchange.authorize()) ? 'applied' : 'stale' };
          return { status: 'ok', snapshot: h.snapshot };
        },
      });
      t.after(h.close);
      const query = h.query();
      await until(() => pathSignal !== null && nativeSignal !== null);
      const update = h.updates()[0];
      const selected = update.items.find((item) => item.source === 'history')!;
      assert.ok(selected);
      const accepting = h.controller.accept({
        type: 'completion-accept',
        requestId: randomUUID(),
        snapshotId: update.snapshotId!,
        candidateId: selected.id,
      });
      assert.equal((pathSignal as AbortSignal | null)?.aborted, true);
      assert.equal((nativeSignal as AbortSignal | null)?.aborted, true);
      assert.equal(
        h.requests.some((request) => request.operation === 'apply'),
        false,
      );
      pathCleanup.resolve(emptyPathResult('cancelled'));
      await setImmediate();
      assert.equal(
        h.requests.some((request) => request.operation === 'apply'),
        false,
      );
      if (inputDuringCleanup) h.input();
      nativeCleanup.resolve({ status: 'unavailable' });
      await Promise.all([query.finished, accepting]);
      assert.equal(h.results().at(-1)?.status, inputDuringCleanup ? 'stale' : 'applied');
      const apply = h.requests.find((request) => request.operation === 'apply');
      assert.equal(Boolean(apply), !inputDuringCleanup);
      if (apply)
        assert.deepEqual(apply.replacement, { text: selected.label, cursor: Array.from(selected.label).length });
    },
  );
}

for (const operation of ['context', 'history'] as const) {
  for (const inputWhileWaiting of [false, true]) {
    test('query waits for ' + operation + ' cleanup without rebasing later input=' + inputWhileWaiting, async (t) => {
      const gate = deferred<void>();
      let observed = false;
      const h = harness({
        settings: { terminalNativeCompletionMode: 'off', terminalAutoCompletePathEnabled: false },
        execute: async (request) => {
          if (request.operation === operation && !observed) {
            observed = true;
            await gate.promise;
          }
          if (request.operation === 'context')
            return {
              status: 'ok',
              snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: h.snapshot.directory },
            };
          if (request.operation === 'history')
            return {
              status: 'ok',
              snapshot: {
                promptGeneration: 1,
                editorMode: 'emacs',
                history: { status: 'ok', namespace: 'native', entries: [] },
              },
            };
          return { status: 'ok', snapshot: h.snapshot };
        },
      });
      t.after(h.close);
      if (operation === 'context') h.setState({ ...h.state(), status: 'paused', requiresEditorConfirmation: true });
      const background =
        operation === 'context' ? h.editor.refreshContext() : h.editor.history(new AbortController().signal);
      await until(() => observed);
      const originalGeneration = h.state().inputGeneration;
      const query = h.query();
      await setImmediate();
      assert.equal(
        h.requests.some((request) => request.operation === 'snapshot'),
        false,
      );
      if (inputWhileWaiting) h.input();
      gate.resolve();
      await Promise.all([background, query.finished]);
      const ready = h.updates().filter((update) => update.status === 'ready');
      assert.equal(ready.length > 0, !inputWhileWaiting);
      if (!inputWhileWaiting) {
        assert.equal(h.state().inputGeneration, originalGeneration);
        assert.equal(ready[0].contextRevision, h.state().revision);
      } else
        assert.equal(
          h.requests.some((request) => request.operation === 'snapshot'),
          false,
        );
    });
  }
}

test('replacement queries wait for canceled remote sources before dispatching another source', async (t) => {
  const firstCleanup = deferred<ShellPathQueryResult>();
  let calls = 0;
  let concurrent = 0;
  let maximum = 0;
  const h = harness({
    settings: { terminalNativeCompletionMode: 'off' },
    paths: async () => {
      calls += 1;
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      try {
        return calls === 1 ? await firstCleanup.promise : emptyPathResult('ok');
      } finally {
        concurrent -= 1;
      }
    },
  });
  t.after(h.close);
  const first = h.query();
  await until(() => calls === 1);
  const second = h.query();
  h.controller.cancel(first.requestId);
  await setImmediate();
  assert.equal(calls, 1);
  firstCleanup.resolve(emptyPathResult('cancelled'));
  await Promise.all([first.finished, second.finished]);
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  assert.equal(h.updates().at(-1)?.requestId, second.requestId);
});

test('a transport sequence change during cleanup rejects the queued query even without a context event', async (t) => {
  const cleanup = deferred<ShellPathQueryResult>();
  const h = harness({ settings: { terminalNativeCompletionMode: 'off' }, paths: async () => cleanup.promise });
  t.after(h.close);
  const first = h.query();
  await until(() => h.updates().length > 0);
  const second = h.query();
  h.transport.inputDelivery.sent += 1;
  h.transport.inputDelivery.delivered += 1;
  cleanup.resolve(emptyPathResult('cancelled'));
  await Promise.all([first.finished, second.finished]);
  assert.equal(h.requests.filter((request) => request.operation === 'snapshot').length, 1);
  assert.equal(h.updates().at(-1)?.status, 'stale');
  assert.equal(h.controller.busy, false);
});

test('manual native default, disabled input and typing threshold are enforced using persisted settings', async (t) => {
  for (const mode of ['manual', 'automatic'] as const) {
    const h = harness({ settings: { terminalNativeCompletionMode: mode } });
    t.after(h.close);
    await h.query('typing').finished;
    assert.equal(
      h.requests.some((request) => request.operation === 'native-completion'),
      mode === 'automatic',
    );
  }
  for (const settings of [{ terminalAutoCompleteEnabled: false }, { remoteEnhancementsInputEnabled: false }]) {
    const h = harness({ settings });
    t.after(h.close);
    await h.query().finished;
    assert.equal(h.requests.length, 0);
    assert.equal(h.updates().at(-1)?.status, 'unavailable');
  }
  const h = harness({ settings: { terminalAutoCompleteMinChars: 8 } });
  t.after(h.close);
  await h.query('typing').finished;
  assert.deepEqual(h.updates().at(-1)?.items, []);
  assert.deepEqual(
    h.requests.map((request) => request.operation),
    ['snapshot'],
  );
});

test('accept rereads settings and rejects changes even before their notification arrives', async (t) => {
  const h = harness({ settings: { terminalNativeCompletionMode: 'off', terminalAutoCompletePathEnabled: false } });
  t.after(h.close);
  await h.query().finished;
  const update = h.updates().at(-1)!;
  h.settings.terminalAutoCompleteHistoryEnabled = false;
  await h.controller.accept({
    type: 'completion-accept',
    requestId: randomUUID(),
    snapshotId: update.snapshotId!,
    candidateId: update.items[0].id,
  });
  assert.equal(h.results().at(-1)?.status, 'stale');
  assert.equal(
    h.requests.some((request) => request.operation === 'apply'),
    false,
  );
});

test('permission/settings cancellation drops late results while source failure preserves other suggestions', async (t) => {
  for (const revoke of [false, true]) {
    const path = deferred<ShellPathQueryResult>();
    let signal: AbortSignal | null = null;
    const h = harness({
      settings: { terminalNativeCompletionMode: 'off' },
      paths: async (_request, lifetime) => {
        signal = lifetime;
        return path.promise;
      },
    });
    t.after(h.close);
    const query = h.query();
    await until(() => signal !== null);
    if (revoke) {
      h.settings.terminalAutoCompletePathEnabled = false;
      h.controller.settingsChanged(h.settings);
      assert.equal((signal as AbortSignal | null)?.aborted, true);
    }
    path.resolve(emptyPathResult('timeout'));
    await query.finished;
    const update = h.updates().at(-1)!;
    assert.equal(update.status, revoke ? 'stale' : 'ready');
    if (!revoke) {
      assert.equal(update.sources.paths, 'timeout');
      assert.ok(update.items.length > 0);
    } else assert.deepEqual(update.items, []);
  }
});

test('private history, foreign candidate IDs, cancellation and expiry never apply an old edit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ settings: { terminalNativeCompletionMode: 'off', terminalAutoCompletePathEnabled: false } });
  t.after(h.close);
  await h.query().finished;
  let update = h.updates().at(-1)!;
  await h.controller.accept({
    type: 'completion-accept',
    requestId: randomUUID(),
    snapshotId: update.snapshotId!,
    candidateId: randomUUID(),
  });
  assert.equal(h.results().at(-1)?.status, 'stale');
  h.setHistory({ status: 'private', source: null, entries: [] });
  await h.controller.accept({
    type: 'completion-accept',
    requestId: randomUUID(),
    snapshotId: update.snapshotId!,
    candidateId: update.items[0].id,
  });
  assert.equal(h.results().at(-1)?.status, 'stale');
  await h.query().finished;
  update = h.updates().at(-1)!;
  assert.equal(update.sources.history, 'private');
  assert.equal(
    update.items.some((item) => item.source === 'history'),
    false,
  );
  t.mock.timers.tick(10_000);
  await h.controller.accept({
    type: 'completion-accept',
    requestId: randomUUID(),
    snapshotId: update.snapshotId!,
    candidateId: update.items[0].id,
  });
  assert.equal(h.results().at(-1)?.status, 'stale');
  assert.equal(h.controller.busy, false);
  assert.equal(
    h.requests.some((request) => request.operation === 'apply'),
    false,
  );
});

test('path results are reused only in the same session and expire after two seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const h = harness({
    settings: { terminalNativeCompletionMode: 'off' },
    paths: async () => {
      calls += 1;
      return { status: 'ok', scanned: 1, entries: [{ name: 'stash-dir', kind: 'directory' }] };
    },
  });
  t.after(h.close);
  await h.query().finished;
  await h.query().finished;
  assert.equal(calls, 1);
  t.mock.timers.tick(2001);
  await h.query().finished;
  assert.equal(calls, 2);
  h.controller.invalidate(true);
  await h.query().finished;
  assert.equal(calls, 3);
});

test('input during the persisted settings read cannot turn an old query into a new snapshot', async (t) => {
  const settings = deferred<SettingsValues>();
  let reading = false;
  const h = harness({
    readSettings: async () => {
      reading = true;
      return settings.promise;
    },
  });
  t.after(h.close);
  const query = h.query();
  await until(() => reading);
  h.input();
  settings.resolve({ ...DEFAULT_SETTINGS_VALUES });
  await query.finished;
  assert.deepEqual(h.requests, []);
  assert.equal(
    h.updates().some((update) => update.status === 'ready'),
    false,
  );
});

test('acceptance ID cancellation preserves an unknown result after external authorization and never retries', async (t) => {
  let approved = false;
  let applySignal: AbortSignal | null = null;
  const h = harness({
    settings: { terminalNativeCompletionMode: 'off', terminalAutoCompletePathEnabled: false },
    execute: async (request, exchange) => {
      if (request.operation !== 'apply') return { status: 'ok', snapshot: h.snapshot };
      approved = await exchange.authorize();
      assert.equal(approved, true);
      applySignal = exchange.signal;
      await new Promise<void>((resolve) => exchange.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'unknown' };
    },
  });
  t.after(h.close);
  await h.query().finished;
  const update = h.updates().at(-1)!;
  const requestId = randomUUID();
  const message = {
    type: 'completion-accept' as const,
    requestId,
    snapshotId: update.snapshotId!,
    candidateId: update.items[0].id,
  };
  const accepted = h.controller.accept(message);
  await until(() => approved && applySignal !== null);
  await h.controller.accept({ ...message, requestId: randomUUID() });
  assert.equal(h.results().at(-1)?.status, 'stale');
  assert.equal((applySignal as AbortSignal | null)?.aborted, false);
  h.controller.cancel(requestId);
  await accepted;
  assert.deepEqual(h.results().at(-1), { type: 'completion-accept-result', requestId, status: 'unknown' });
  assert.equal(h.requests.filter((request) => request.operation === 'apply').length, 1);
});

test('a confirmation publication exception after apply remains unknown and never repeats the edit', async (t) => {
  const h = harness({
    settings: { terminalNativeCompletionMode: 'off', terminalAutoCompletePathEnabled: false },
    onConfirm: () => {
      throw new Error('closed metadata publication boundary');
    },
  });
  t.after(h.close);
  await h.query().finished;
  const update = h.updates().at(-1)!;
  await h.controller.accept({
    type: 'completion-accept',
    requestId: randomUUID(),
    snapshotId: update.snapshotId!,
    candidateId: update.items[0].id,
  });
  assert.equal(h.results().at(-1)?.status, 'unknown');
  assert.equal(h.requests.filter((request) => request.operation === 'apply').length, 1);
});
