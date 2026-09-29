import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShellContext, ShellDirectoryContext, TerminalClientMessage } from '@cosmosh/api-contract';

import { type DirectoryRequestOwner, TerminalDirectoryRequests } from './terminal-directory-requests';

const directory: ShellDirectoryContext = { logical: '/linked/app', physical: '/actual/app', home: '/home/user' };

/** @param timeoutMs Optional bounded timeout. @returns Real directory request state with an isolated transport boundary. */
const harness = (timeoutMs?: number) => {
  const messages: TerminalClientMessage[] = [];
  const context: ShellContext = {
    sessionId: 'session',
    shellInstanceId: 'original-shell',
    shell: 'bash',
    helperVersion: 'test',
    protocolVersion: 3,
    capabilities: ['cwd'],
    status: 'ready',
    reason: null,
    editorAvailable: false,
    permissions: { cwd: true, input: false, history: false, paths: false, nativeCompletion: false },
    revision: 3,
    inputGeneration: 2,
    promptGeneration: 1,
    cwdGeneration: 1,
    submissionToken: null,
    cwd: { ...directory, physical: '/outdated' },
    lastKnownCwd: null,
  };
  let owner: DirectoryRequestOwner | null = { socket: {}, context, send: (message) => messages.push(message) };
  const requests = new TerminalDirectoryRequests(() => owner, timeoutMs);
  /** @param changes New metadata. @returns Nothing after publishing the current owner. */
  const update = (changes: Partial<ShellContext>): void => {
    assert.ok(owner);
    owner = { ...owner, context: { ...owner.context, ...changes } };
    requests.contextChanged('pane', owner.context);
  };
  /** @param requestId The original query ID. @param revision Claimed fresh revision. @returns Nothing after receipt. */
  const reply = (requestId: string, revision = owner?.context.revision ?? 0): void =>
    requests.receive('pane', {
      type: 'directory-result',
      requestId,
      contextRevision: revision,
      status: 'ok',
      directory,
    });
  /** @returns The current query identifier. */
  const queryId = (): string => {
    const message = [...messages].reverse().find((value) => value.type === 'directory-query');
    assert.ok(message?.type === 'directory-query');
    return message.requestId;
  };
  return {
    messages,
    requests,
    update,
    reply,
    queryId,
    get owner() {
      return owner;
    },
    set owner(value: DirectoryRequestOwner | null) {
      owner = value;
    },
  };
};

test('relative directory use requests a fresh original observation with only CWD permission', async () => {
  const h = harness();
  const result = h.requests.request('pane');
  const id = h.queryId();
  assert.deepEqual(Object.keys(h.messages[0]).sort(), ['requestId', 'type']);
  h.update({ revision: 4, cwd: directory });
  h.reply(id);
  assert.deepEqual(await result, directory);
});

test('input, pane closure and cancellation reject a late successful directory reply', async () => {
  for (const reason of ['input', 'credential-fill', 'pane-close', 'all']) {
    const h = harness();
    const result = h.requests.request('pane');
    const id = h.queryId();
    h.requests.invalidate(reason === 'all' ? undefined : 'pane');
    h.reply(id);
    assert.equal(await result, null);
    assert.equal(h.messages.at(-1)?.type, 'directory-cancel');
  }
});

test('changed original identities, permissions and program states cannot reuse old directories', async () => {
  for (const change of [
    { sessionId: 'reconnected' },
    { shellInstanceId: 'nested-shell' },
    { promptGeneration: 2 },
    { status: 'busy' as const },
    { permissions: { cwd: false, input: true, history: true, paths: false, nativeCompletion: false } },
  ]) {
    const h = harness();
    const result = h.requests.request('pane');
    const id = h.queryId();
    h.update(change);
    h.reply(id);
    assert.equal(await result, null);
  }
});

test('acknowledging input sent before the query preserves a fresh directory action', async () => {
  const h = harness();
  const result = h.requests.request('pane');
  const id = h.queryId();
  h.update({ inputGeneration: 3, revision: 4, status: 'paused', reason: 'waiting-for-prompt', cwd: null });
  h.update({ revision: 5, status: 'ready', reason: null, cwd: directory });
  h.reply(id);
  assert.deepEqual(await result, directory);
});

test('socket replacement and mismatched confirmation revision reject success replies', async () => {
  for (const replacement of [true, false]) {
    const h = harness();
    const result = h.requests.request('pane');
    const id = h.queryId();
    if (replacement) h.owner = { ...h.owner!, socket: {} };
    h.reply(id, replacement ? 3 : 2);
    assert.equal(await result, null);
  }
});

test('a late canceled reply cannot resolve a later request for the same pane', async () => {
  const h = harness();
  const first = h.requests.request('pane');
  const oldId = h.queryId();
  const second = h.requests.request('pane');
  const newId = h.queryId();
  h.reply(oldId);
  assert.equal(await first, null);
  h.update({ revision: 4 });
  h.reply(newId);
  assert.deepEqual(await second, directory);
});

test('timeout resolves unavailable and cancels only its original request', async () => {
  const h = harness(5);
  assert.equal(await h.requests.request('pane'), null);
  assert.equal(h.messages.at(-1)?.type, 'directory-cancel');
});

test('optional send failures cannot retain a request or interrupt ordinary input cancellation', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
  const h = harness();
  const owner = h.owner!;
  h.owner = {
    ...owner,
    send: () => {
      throw new Error('private transport detail');
    },
  };
  assert.equal(await h.requests.request('pane'), null);
  h.owner = {
    ...owner,
    send: (message) => {
      if (message.type === 'directory-cancel') throw new Error('private transport detail');
      h.messages.push(message);
    },
  };
  const pending = h.requests.request('pane');
  assert.doesNotThrow(() => h.requests.invalidate('pane'));
  assert.equal(await pending, null);
  assert.equal(warnings.length, 2);
  assert.equal(JSON.stringify(warnings).includes('private transport detail'), false);
});
