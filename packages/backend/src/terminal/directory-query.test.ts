import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import {
  DEFAULT_SETTINGS_VALUES,
  type SettingsValues,
  type ShellEditorRequest,
  type TerminalDirectoryResult,
} from '@cosmosh/api-contract';

import type { ShellEditorResult } from '../ssh/editor-exec.js';
import { emptyPathResult, type RemotePathExecutor, RemotePathQueryController } from './completion/remote-path-query.js';
import { SnapshotCompletionController } from './completion/snapshot-completion.js';
import { DirectoryQueryController } from './directory-query.js';
import {
  confirmShellEditorContext,
  type EditorExecutor,
  type EditorInputTransport,
  ShellEditorController,
} from './editor-controller.js';
import { normalizeTerminalClientMessage } from './shared.js';
import {
  createShellContext,
  invalidateShellInput,
  resolveShellPermissions,
  type ShellContextState,
} from './shell-context.js';

/** @returns An explicitly controlled remote response, persistence or cleanup boundary. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

/** @param predicate Boundary condition. @returns Completion or a bounded assertion failure. */
const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await setImmediate();
  assert.ok(predicate(), 'the expected directory transport boundary was reached');
};

/** @param options Explicit external persistence, SSH and publication boundaries. @returns Real private controllers. */
const harness = (
  options: {
    settings?: Partial<SettingsValues>;
    readSettings?: () => Promise<SettingsValues>;
    execute?: EditorExecutor;
    paths?: RemotePathExecutor;
    publish?: () => void;
    onIdle?: () => void;
  } = {},
) => {
  const settings: SettingsValues = {
    ...DEFAULT_SETTINGS_VALUES,
    remoteEnhancementsInputEnabled: false,
    remoteEnhancementsHistoryEnabled: false,
    terminalAutoCompletePathEnabled: false,
    terminalNativeCompletionMode: 'off',
    ...options.settings,
  };
  let owner: object | null = {};
  let state: ShellContextState = {
    ...createShellContext('directory-session', resolveShellPermissions(settings, true), true),
    shell: 'fish',
    shellInstanceId: randomUUID(),
    status: 'ready',
    reason: null,
    promptGeneration: 1,
    cwd: { logical: '/retained', physical: '/retained', home: '/old-home' },
    lastKnownCwd: { logical: '/retained', physical: '/retained', home: '/old-home' },
    capabilities: ['directory-read', 'input-snapshot', 'input-apply', 'history-read', 'native-completion'],
    editorBinding: {
      pid: 42,
      startTime: '100',
      triggerNonce: randomUUID(),
      promptGeneration: 1,
      notification: { signal: 'URG' },
    },
  };
  const actual = { logical: '/fresh/link', physical: '/fresh/actual', home: '/fresh/home' };
  const transport: EditorInputTransport = {
    inputDelivery: { epoch: randomUUID(), sent: 0, delivered: 0 },
    originalShellPID: 42,
    waitForDelivery: async (sequence, signal) => !signal.aborted && sequence === transport.inputDelivery.delivered,
    authorizeEditor: async () => false,
    revokeEditor: () => {},
  };
  const requests: ShellEditorRequest[] = [];
  const results: TerminalDirectoryResult[] = [];
  const publications: string[] = [];
  const editor = new ShellEditorController(
    () => state,
    async (request, exchange) => {
      requests.push(request);
      if (options.execute) return await options.execute(request, exchange);
      return request.operation === 'snapshot'
        ? {
            status: 'ok',
            snapshot: {
              promptGeneration: 1,
              editorMode: 'emacs',
              directory: actual,
              buffer: { text: 'git st', cursor: 6 },
            },
          }
        : { status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: { ...actual } } };
    },
    () => transport,
    (expected, observation) => {
      if (state !== expected) return;
      state = confirmShellEditorContext(state, observation);
      publications.push('context:' + state.revision);
      controller.contextChanged();
    },
  );
  const completion = new SnapshotCompletionController({
    editor,
    paths: new RemotePathQueryController(options.paths ?? (async () => emptyPathResult('ok'))),
    context: () => state,
    readSettings: async () => ({ ...settings }),
    history: () => null,
    publish: () => {},
  });
  const controller = new DirectoryQueryController({
    editor,
    completion: () => completion,
    context: () => state,
    owner: () => owner,
    readSettings: options.readSettings ?? (async () => ({ ...settings })),
    publish: (message) => {
      results.push(message);
      publications.push('result:' + message.contextRevision);
      options.publish?.();
    },
    onIdle: options.onIdle,
  });
  return {
    controller,
    completion,
    editor,
    transport,
    settings,
    actual,
    requests,
    results,
    publications,
    state: () => state,
    query: (requestId = randomUUID()) => ({
      requestId,
      finished: controller.query({ type: 'directory-query', requestId }),
    }),
    input: (): void => {
      controller.invalidate();
      completion.invalidate();
      editor.invalidate();
      state = invalidateShellInput(state, 'x');
      transport.inputDelivery.sent += 1;
      transport.inputDelivery.delivered += 1;
    },
    setState: (next: ShellContextState): void => {
      state = next;
      controller.contextChanged();
    },
    replaceOwner: (): void => {
      owner = {};
      controller.contextChanged();
    },
    close: (): void => {
      owner = null;
      controller.invalidate();
      completion.invalidate(true, false);
      editor.invalidate();
    },
  };
};

test('directory actions accept only opaque canonical UUIDs and reject path or permission guesses', () => {
  for (const type of ['directory-query', 'directory-cancel']) {
    const message = { type, requestId: randomUUID() };
    assert.deepEqual(normalizeTerminalClientMessage(Buffer.from(JSON.stringify(message))), message);
    for (const extra of [{ cwd: '/guess' }, { input: 'private' }, { permissions: { cwd: true } }])
      assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...message, ...extra }))), null);
    for (const requestId of ['', '-'.repeat(36), message.requestId.toUpperCase()])
      assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...message, requestId }))), null);
  }
});

test('directory lookup refreshes a ready context using CWD permission alone and publishes context first', async (t) => {
  const h = harness();
  t.after(h.close);
  await h.query().finished;
  assert.equal(h.results[0].status, 'ok');
  assert.deepEqual(h.results[0].directory, h.actual);
  assert.notEqual(h.results[0].directory?.physical, '/retained');
  assert.deepEqual(h.publications, ['context:1', 'result:1']);
  h.actual.physical = '/new-actual';
  await h.query().finished;
  assert.equal(h.results[1].directory?.physical, '/new-actual');
  assert.deepEqual(
    h.requests.map((request) => request.operation),
    ['context', 'context'],
  );
  for (const request of h.requests) {
    assert.equal(request.includeDirectory, true);
    assert.equal(request.expected, undefined);
    assert.equal(request.replacement, undefined);
  }
});

for (const operation of ['context', 'history'] as const) {
  for (const inputDuringWait of [false, true]) {
    test('directory waits for ' + operation + ' cleanup; input during wait=' + inputDuringWait, async (t) => {
      const cleanup = deferred<ShellEditorResult>();
      let first = true;
      const h = harness({
        settings: { remoteEnhancementsHistoryEnabled: true },
        execute: async (request) => {
          if (first && request.operation === operation) {
            first = false;
            return cleanup.promise;
          }
          return { status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: h.actual } };
        },
      });
      t.after(h.close);
      const background =
        operation === 'context' ? h.editor.refreshContext() : h.editor.history(new AbortController().signal);
      await until(() => !first);
      const query = h.query();
      await setImmediate();
      assert.equal(h.requests.length, 1);
      if (inputDuringWait) h.input();
      cleanup.resolve({ status: 'unavailable' });
      await Promise.all([query.finished, background]);
      assert.equal(h.results.at(-1)?.status, inputDuringWait ? 'stale' : 'ok');
      assert.equal(h.requests.length, inputDuringWait ? 1 : 2);
    });
  }
}

test('directory cancels completion but waits for path and native cleanup before its own context observation', async (t) => {
  const path = deferred<Awaited<ReturnType<RemotePathExecutor>>>();
  const native = deferred<ShellEditorResult>();
  let pathSignal: AbortSignal | null = null;
  let nativeSignal: AbortSignal | null = null;
  const h = harness({
    settings: {
      remoteEnhancementsInputEnabled: true,
      terminalAutoCompletePathEnabled: true,
      terminalNativeCompletionMode: 'manual',
    },
    paths: async (_request, signal) => {
      pathSignal = signal;
      return path.promise;
    },
    execute: async (request, exchange) => {
      if (request.operation === 'native-completion') {
        nativeSignal = exchange.signal;
        return native.promise;
      }
      return {
        status: 'ok',
        snapshot: {
          promptGeneration: 1,
          editorMode: 'emacs',
          directory: h.actual,
          ...(request.operation === 'snapshot' ? { buffer: { text: 'git st', cursor: 6 } } : {}),
        },
      };
    },
  });
  t.after(h.close);
  const completion = h.completion.query({ type: 'completion-query', requestId: randomUUID(), trigger: 'manual' });
  await until(() => pathSignal !== null && nativeSignal !== null);
  const query = h.query();
  assert.equal((pathSignal as AbortSignal | null)?.aborted, true);
  assert.equal((nativeSignal as AbortSignal | null)?.aborted, true);
  path.resolve(emptyPathResult('cancelled'));
  await setImmediate();
  assert.equal(
    h.requests.some((request) => request.operation === 'context'),
    false,
  );
  native.resolve({ status: 'unavailable' });
  await Promise.all([completion, query.finished]);
  assert.equal(h.results.at(-1)?.status, 'ok');
  assert.equal(h.requests.filter((request) => request.operation === 'context').length, 1);
});

test('input during persisted settings lookup rejects the original action before any directory observation', async (t) => {
  const settings = deferred<SettingsValues>();
  const h = harness({ readSettings: () => settings.promise });
  t.after(h.close);
  const query = h.query();
  h.input();
  await query.finished;
  assert.equal(h.results[0].status, 'stale');
  assert.equal(h.results[0].directory, null);
  settings.resolve(h.settings);
  await setImmediate();
  assert.deepEqual(h.requests, []);
});

for (const change of ['input', 'sequence', 'shell', 'prompt', 'socket', 'permission', 'close'] as const) {
  test('directory response cannot cross a changed ' + change + ' boundary', async (t) => {
    const reply = deferred<ShellEditorResult>();
    let signal: AbortSignal | null = null;
    const h = harness({
      execute: async (_request, exchange) => {
        signal = exchange.signal;
        return reply.promise;
      },
    });
    t.after(h.close);
    const query = h.query();
    await until(() => signal !== null);
    if (change === 'input') h.input();
    if (change === 'sequence') h.transport.inputDelivery.sent += 1;
    if (change === 'shell') h.setState({ ...h.state(), shellInstanceId: randomUUID() });
    if (change === 'prompt') h.setState({ ...h.state(), promptGeneration: 2 });
    if (change === 'socket') h.replaceOwner();
    if (change === 'permission') {
      h.settings.remoteEnhancementsCwdEnabled = false;
      h.controller.settingsChanged(h.settings);
      h.setState({ ...h.state(), permissions: { ...h.state().permissions, cwd: false } });
    }
    if (change === 'close') h.close();
    reply.resolve({ status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: h.actual } });
    await query.finished;
    assert.equal(
      h.results.some((result) => result.status === 'ok'),
      false,
    );
    if (change === 'socket' || change === 'close') assert.deepEqual(h.results, []);
    else assert.equal(h.results[0].directory, null);
  });
}

test('late cancellation cannot abort a replacement directory request or its fresh observation', async (t) => {
  const firstReply = deferred<ShellEditorResult>();
  const secondReply = deferred<ShellEditorResult>();
  const signals: AbortSignal[] = [];
  const h = harness({
    execute: async (_request, exchange) => {
      signals.push(exchange.signal);
      return signals.length === 1 ? firstReply.promise : secondReply.promise;
    },
  });
  t.after(h.close);
  const first = h.query();
  await until(() => signals.length === 1);
  const second = h.query();
  assert.equal(signals[0].aborted, true);
  firstReply.resolve({ status: 'unavailable' });
  await until(() => signals.length === 2);
  h.controller.cancel(first.requestId);
  assert.equal(signals[1].aborted, false);
  secondReply.resolve({ status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: h.actual } });
  await Promise.all([first.finished, second.finished]);
  assert.equal(h.results.find((result) => result.requestId === second.requestId)?.status, 'ok');
});

test('timeouts and unusable fresh observations return no retained directory', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settings = deferred<SettingsValues>();
  const timed = harness({ readSettings: () => settings.promise });
  t.after(timed.close);
  const query = timed.query();
  t.mock.timers.tick(10_000);
  await query.finished;
  assert.equal(timed.results[0].status, 'unavailable');
  assert.equal(timed.results[0].directory, null);
  settings.resolve(timed.settings);
  for (const result of [
    { status: 'unavailable' as const },
    { status: 'ok' as const, snapshot: { promptGeneration: 1, editorMode: 'emacs' as const } },
  ]) {
    const h = harness({ execute: async () => result });
    t.after(h.close);
    await h.query().finished;
    assert.equal(h.results[0].status, 'unavailable');
    assert.equal(h.results[0].directory, null);
  }
});

test('directory observers cannot reject the public handler or retain private ownership', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
  const h = harness({
    publish: () => {
      throw new Error('/private-directory');
    },
    onIdle: () => {
      throw new Error('/private-idle');
    },
  });
  t.after(h.close);
  await assert.doesNotReject(h.query().finished);
  assert.equal(h.controller.busy, false);
  assert.equal(warnings.length, 2);
  assert.equal(JSON.stringify(warnings).includes('/private'), false);
});

test('a boundary change during release cannot publish a successful but superseded directory', async (t) => {
  const h = harness({ onIdle: () => h.input() });
  t.after(h.close);
  await h.query().finished;
  assert.equal(h.results[0].status, 'stale');
  assert.equal(h.results[0].directory, null);
});

test('an idle retained completion controller cannot cancel an unrelated native history read', async (t) => {
  const observed = deferred<ShellEditorResult>();
  let historySignal: AbortSignal | null = null;
  const h = harness({
    settings: { remoteEnhancementsHistoryEnabled: true },
    execute: async (request, exchange) => {
      if (request.operation === 'history') {
        historySignal = exchange.signal;
        return observed.promise;
      }
      return { status: 'ok', snapshot: { promptGeneration: 1, editorMode: 'emacs', directory: h.actual } };
    },
  });
  t.after(h.close);
  const history = h.editor.history(new AbortController().signal);
  await until(() => historySignal !== null);
  const directory = h.query();
  await setImmediate();
  assert.equal((historySignal as AbortSignal | null)?.aborted, false);
  assert.equal(h.requests.length, 1);
  observed.resolve({ status: 'unavailable' });
  await Promise.all([history, directory.finished]);
  assert.equal(h.results[0].status, 'ok');
});
