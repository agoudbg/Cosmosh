import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { ShellEditorRequest, ShellEditorSnapshot } from '@cosmosh/api-contract';
import type { Client, ClientChannel } from 'ssh2';

import { ShellEditorController } from '../terminal/editor-controller.js';
import { createShellContext, type ShellContextState } from '../terminal/shell-context.js';
import { executeShellEditorRequest } from './editor-exec.js';

const snapshot: ShellEditorSnapshot = {
  promptGeneration: 1,
  editorMode: 'emacs',
  buffer: { text: 'echo 中文🐟', cursor: 8 },
};
const request: ShellEditorRequest = {
  requestId: '01234567-89ab-4def-8123-456789abcdef',
  target: { instanceId: 'abcdef01-2345-6789-abcd-ef0123456789', shell: 'bash', pid: 42, startTime: '100' },
  operation: 'snapshot',
  promptGeneration: 1,
  includeDirectory: false,
};

/** SSH channel boundary double; protocol validation and cancellation execute production code. */
class Channel extends EventEmitter {
  stderr = new PassThrough();
  writes: string[] = [];
  destroyed = false;
  ended = false;
  /** @returns Nothing; models a worker exiting after EOF without forced channel closure. */
  end(): void {
    this.ended = true;
    this.emit('close');
  }
  /** @param data stdin bytes. @returns Nothing. */
  write(data: string): void {
    this.writes.push(data);
  }
  /** @returns Nothing; lifecycle is idempotent. */
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
  /** @param message Server protocol fields. @returns Nothing. */
  reply(message: Record<string, unknown>): void {
    this.emit('data', Buffer.from(JSON.stringify({ type: 'editor', requestId: request.requestId, ...message }) + '\n'));
  }
}

/** @param channel Owned transport. @param commands Observed OS command strings. @returns Fake external SSH boundary. */
const clientFor = (channel: Channel, commands: string[] = []): Client =>
  ({
    exec(command: string, callback: (error: undefined, stream: ClientChannel) => void) {
      commands.push(command);
      callback(undefined, channel as unknown as ClientChannel);
    },
  }) as unknown as Client;

test('native completion transport accepts only the requested bounded result and no unsolicited snapshot', async () => {
  const completion = { status: 'ok', entries: [{ token: 'feature', value: 'feature', detail: null }] };
  for (const operation of ['native-completion', 'snapshot'] as const) {
    for (const extra of [{}, { snapshot }, { applied: true }]) {
      const channel = new Channel();
      const response = executeShellEditorRequest(
        clientFor(channel),
        '/helper',
        {
          ...request,
          operation,
          target: { ...request.target, shell: 'fish' },
          notification: { signal: 'URG' },
        },
        { signal: new AbortController().signal, isCurrent: () => true, trigger: () => {} },
      );
      channel.reply({ phase: 'ready' });
      channel.reply({ phase: 'done', status: 'native-completions', completion, ...extra });
      assert.deepEqual(
        await response,
        operation === 'native-completion' && Object.keys(extra).length === 0
          ? { status: 'native-completions', completion }
          : { status: 'unavailable' },
      );
      assert.ok(channel.writes.every((value) => !value.includes('"apply":true')));
    }
  }
});

test('native history deletion requires an exact prepared target and keeps uncertain outcomes explicit', async () => {
  const expected: ShellEditorSnapshot = {
    promptGeneration: 1,
    editorMode: 'emacs',
    history: { status: 'ok', namespace: 'fish', entries: ['begin\n echo TARGET  \nend\n'] },
  };
  const deletion: ShellEditorRequest = {
    ...request,
    target: { ...request.target, shell: 'fish' },
    operation: 'history-delete',
    notification: { signal: 'URG' },
    expected,
  };
  for (const changed of [
    { ...expected, history: { ...expected.history!, namespace: 'other' } },
    { ...expected, history: { ...expected.history!, entries: [] } },
    { ...expected, buffer: { text: 'UNSOLICITED_INPUT', cursor: 0 } },
  ]) {
    const channel = new Channel();
    const response = executeShellEditorRequest(clientFor(channel), '/helper', deletion, {
      signal: new AbortController().signal,
      isCurrent: () => true,
      trigger: () => {},
    });
    channel.reply({ phase: 'ready' });
    channel.reply({ phase: 'prepared', snapshot: changed });
    assert.deepEqual(await response, { status: 'stale' });
    assert.ok(channel.writes.every((value) => !value.includes('"apply":true')));
  }
  for (const acknowledge of [false, true]) {
    const channel = new Channel();
    const commands: string[] = [];
    const lifetime = new AbortController();
    const response = executeShellEditorRequest(clientFor(channel, commands), '/helper', deletion, {
      signal: lifetime.signal,
      isCurrent: () => true,
      trigger: () => {},
    });
    channel.reply({ phase: 'ready' });
    channel.reply({ phase: 'prepared', snapshot: expected });
    assert.ok(channel.writes.some((value) => value.includes('"apply":true')));
    assert.ok(commands.every((value) => !value.includes('TARGET')));
    if (acknowledge) channel.reply({ phase: 'done', status: 'history-removed-from-reader', applied: true });
    else lifetime.abort();
    assert.deepEqual(await response, { status: acknowledge ? 'history-removed-from-reader' : 'unknown' });
  }
});

test('editor transport rejects a history acknowledgement for an input edit and the inverse', async () => {
  for (const operation of ['apply', 'history-delete'] as const) {
    const expected: ShellEditorSnapshot =
      operation === 'apply'
        ? snapshot
        : {
            promptGeneration: 1,
            editorMode: 'emacs',
            history: { status: 'ok', namespace: 'fish', entries: ['exact record'] },
          };
    const channel = new Channel();
    const response = executeShellEditorRequest(
      clientFor(channel),
      '/helper',
      {
        ...request,
        operation,
        expected,
        ...(operation === 'apply'
          ? { replacement: snapshot.buffer }
          : { target: { ...request.target, shell: 'fish' }, notification: { signal: 'URG' } }),
      },
      { signal: new AbortController().signal, isCurrent: () => true, trigger: () => {} },
    );
    channel.reply({ phase: 'ready' });
    channel.reply({ phase: 'prepared', snapshot: expected });
    assert.ok(channel.writes.some((value) => value.includes('"apply":true')));
    channel.reply({
      phase: 'done',
      status: operation === 'apply' ? 'history-removed-from-reader' : 'applied',
      applied: true,
    });
    assert.deepEqual(await response, { status: 'unknown' });
  }
});

test('synchronous SSH disconnect, write and trigger failures resolve without escaping the transport boundary', async () => {
  const disconnected = {
    exec() {
      throw new Error('Not connected');
    },
  } as unknown as Client;
  const options = { signal: new AbortController().signal, isCurrent: () => true, trigger: () => {} };
  assert.deepEqual(await executeShellEditorRequest(disconnected, '/helper', request, options), {
    status: 'unavailable',
  });
  const brokenWrite = new Channel();
  brokenWrite.write = () => {
    throw new Error('Channel closed');
  };
  brokenWrite.destroy = () => {
    throw new Error('Already closed');
  };
  assert.deepEqual(await executeShellEditorRequest(clientFor(brokenWrite), '/helper', request, options), {
    status: 'unavailable',
  });
  const brokenTrigger = new Channel();
  const result = executeShellEditorRequest(clientFor(brokenTrigger), '/helper', request, {
    ...options,
    trigger: () => {
      throw new Error('PTY closed');
    },
  });
  brokenTrigger.reply({ phase: 'ready' });
  assert.deepEqual(await result, { status: 'unavailable' });
});

test('editor transport preserves split UTF-8 and keeps input out of command arguments', async () => {
  const channel = new Channel();
  const commands: string[] = [];
  let triggers = 0;
  const response = executeShellEditorRequest(clientFor(channel, commands), "/home/user's/bin/helper", request, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    trigger: () => {
      triggers += 1;
    },
  });
  channel.reply({ phase: 'ready' });
  const payload = Buffer.from(
    JSON.stringify({ type: 'editor', requestId: request.requestId, phase: 'done', status: 'ok', snapshot }) + '\n',
  );
  for (const byte of payload) channel.emit('data', Buffer.from([byte]));
  assert.deepEqual(await response, { status: 'ok', snapshot });
  assert.equal(triggers, 1);
  assert.equal(commands[0], "'/home/user'\\''s/bin/helper' editor-request");
  assert.equal(channel.ended, true);
  assert.equal(channel.destroyed, false);
});

test('permission loss before ready prevents any private PTY trigger', async () => {
  const channel = new Channel();
  let current = true;
  let triggers = 0;
  const response = executeShellEditorRequest(clientFor(channel), '/helper', request, {
    signal: new AbortController().signal,
    isCurrent: () => current,
    trigger: () => {
      triggers += 1;
    },
  });
  current = false;
  channel.reply({ phase: 'ready' });
  assert.deepEqual(await response, { status: 'unavailable' });
  assert.equal(triggers, 0);
});

test('notification activation is private, permission checked, and suppressed after synchronous cancellation', async () => {
  for (const cancel of [false, true]) {
    const channel = new Channel();
    const controller = new AbortController();
    const notificationRequest: ShellEditorRequest = {
      ...request,
      target: { ...request.target, shell: 'zsh' },
      notification: { fd: 12, inode: '12345' },
    };
    const response = executeShellEditorRequest(clientFor(channel), '/helper', notificationRequest, {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      trigger: () => {
        if (cancel) controller.abort();
      },
    });
    assert.equal(channel.writes.length, 1);
    channel.reply({ phase: 'ready' });
    if (cancel) {
      assert.equal(channel.writes.length, 1, 'EOF cancellation cannot be followed by a new activation');
      assert.deepEqual(await response, { status: 'unavailable' });
    } else {
      assert.deepEqual(JSON.parse(channel.writes[1]!), { requestId: request.requestId, activate: true });
      channel.reply({ phase: 'done', status: 'ok', snapshot });
      assert.deepEqual(await response, { status: 'ok', snapshot });
    }
  }
});

test('cancellation waits for remote cleanup after EOF without forcing channel closure', async () => {
  const channel = new Channel();
  channel.end = () => {
    channel.ended = true;
  };
  const controller = new AbortController();
  let resolved = false;
  const result = executeShellEditorRequest(clientFor(channel), '/helper', request, {
    signal: controller.signal,
    isCurrent: () => true,
    trigger: () => controller.abort(),
  }).then((value) => {
    resolved = true;
    return value;
  });
  channel.reply({ phase: 'ready' });
  await Promise.resolve();
  assert.equal(channel.ended, true);
  assert.equal(channel.destroyed, false);
  assert.equal(resolved, false);
  channel.emit('close');
  assert.deepEqual(await result, { status: 'unavailable' });
});

test('native history rejects a parsed done response if permission ends while SSH cleanup is pending', async () => {
  const channel = new Channel();
  channel.end = () => {
    channel.ended = true;
  };
  const lifetime = new AbortController();
  const state: ShellContextState = {
    ...createShellContext(
      'session',
      { history: true, input: false, cwd: false, paths: false, nativeCompletion: false },
      true,
    ),
    shell: 'fish',
    shellInstanceId: request.target.instanceId,
    status: 'ready',
    promptGeneration: 1,
    capabilities: ['history-read'],
    editorBinding: {
      pid: 42,
      startTime: '100',
      triggerNonce: request.requestId,
      promptGeneration: 1,
      notification: { signal: 'URG' },
    },
  };
  const controller = new ShellEditorController(
    () => state,
    (request, options) => executeShellEditorRequest(clientFor(channel), '/helper', request, options),
    () => assert.fail('history must not inject input'),
    () => {},
  );
  let resolved = false;
  const result = controller.history(lifetime.signal).then((value) => {
    resolved = true;
    return value;
  });
  const actualRequest = JSON.parse(channel.writes[0]) as ShellEditorRequest;
  channel.reply({ requestId: actualRequest.requestId, phase: 'ready' });
  channel.reply({
    requestId: actualRequest.requestId,
    phase: 'done',
    status: 'ok',
    snapshot: {
      promptGeneration: 1,
      editorMode: 'emacs',
      history: { status: 'ok', namespace: 'fish', entries: ['echo private response'] },
    },
  });
  await Promise.resolve();
  assert.equal(channel.ended, true);
  assert.equal(resolved, false);
  lifetime.abort();
  channel.emit('close');
  assert.deepEqual(await result, { status: 'stale' });
  assert.equal(channel.destroyed, false);
});

test('application requires exact prepared state and reports unknown when acknowledgement is lost', async () => {
  for (const changed of [false, true]) {
    const channel = new Channel();
    const controller = new AbortController();
    const response = executeShellEditorRequest(
      clientFor(channel),
      '/helper',
      {
        ...request,
        operation: 'apply',
        expected: snapshot,
        replacement: { text: 'echo new', cursor: 8 },
      },
      { signal: controller.signal, isCurrent: () => true, trigger: () => {} },
    );
    channel.reply({ phase: 'ready' });
    channel.reply({
      phase: 'prepared',
      snapshot: changed ? { ...snapshot, buffer: { text: 'echo other', cursor: 8 } } : snapshot,
    });
    controller.abort();
    assert.deepEqual(await response, { status: changed ? 'stale' : 'unknown' });
    assert.equal(channel.writes.length, changed ? 1 : 2);
  }
});

test('context-only transport rejects unsolicited input and malformed lifecycle replies', async () => {
  for (const response of [
    { phase: 'done', status: 'ok', snapshot },
    { phase: 'prepared', snapshot },
    { phase: 'ready' },
  ]) {
    const channel = new Channel();
    const pending = executeShellEditorRequest(
      clientFor(channel),
      '/helper',
      { ...request, operation: 'context' },
      {
        signal: new AbortController().signal,
        isCurrent: () => true,
        trigger: () => {},
      },
    );
    channel.reply({ phase: 'ready' });
    channel.reply(response);
    assert.deepEqual(await pending, { status: 'unavailable' });
  }
});
