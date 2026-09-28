import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_SETTINGS_VALUES,
  type RemoteShellCapability,
  type SshTerminalServerMessage,
} from '@cosmosh/api-contract';
import type { Client, ClientChannel } from 'ssh2';

import type { RemoteBootstrapResult, RemoteBootstrapStatus } from '../remote-bootstrap/service.js';
import type { DefaultSettingsSnapshot } from '../settings/read.js';
import {
  createCredentialFillState,
  type CredentialFillState,
  observeCredentialFillOutput,
} from '../terminal/credential-fill.js';
import { confirmShellEditorContext, ShellEditorController } from '../terminal/editor-controller.js';
import type { TerminalClientInboundMessage } from '../terminal/shared.js';
import {
  applyShellContextEvent,
  createShellContext,
  resolveShellPermissions,
  type ShellContextState,
  suspendShellContext,
  updateShellPermissions,
} from '../terminal/shell-context.js';
import type { OpenSshClientResult } from './connect.js';
import type { RemoteShellEventMessage, RemoteShellEventStreamFrame } from './remote-shell-events.js';
import {
  resolveRemoteEnhancementsSessionGate,
  SshSessionService,
  usesStructuredRemoteCommandLifecycle,
} from './session-service.js';

type RemoteShellEventSessionHarness = {
  shellContext: ShellContextState;
  editorController?: ShellEditorController;
  editorContextTimeout?: NodeJS.Timeout;
  client?: Client;
  stream?: { write(data: string): void };
  enhancementsAllowed: boolean;
  sessionId: string;
  credentialFillState: CredentialFillState;
  loginPassword: string | null;
  remoteEnhancementsRuntimeState: 'pending' | 'active' | 'disabled';
  remoteEnhancementsRuntimeContract: {
    shell: 'bash';
    helperVersion: string;
    protocolVersion: number;
    capabilities: RemoteShellCapability[];
    binaryPath?: string;
  } | null;
  remoteEnhancementsRuntimeCode: string | null;
  remoteEnhancementsRuntimeMessage: string | null;
  remoteEnhancementsHandshakeTimeout: NodeJS.Timeout | null;
  pendingStreamFrames: RemoteShellEventStreamFrame[];
  pendingStreamFrameBytes: number;
  pendingStreamFrameDropCount: number;
  pendingRemoteBootstrapStatuses: RemoteBootstrapStatus[];
  remoteShellReady: boolean;
  remoteShellForegroundCommand: string | null;
  lastRemoteCommand: string | null;
  lastRemoteCommandId: string | null;
  lastExitCode: number | null;
  lastCommandDurationMs: number | null;
  commandCount: number;
  socket: {
    OPEN: number;
    readyState: number;
    send(payload: string): void;
  } | null;
  disposed: boolean;
};

type RemoteShellEventServiceHarness = {
  handleClientMessage(session: RemoteShellEventSessionHarness, payload: Buffer): void;
  handleEditorRequest(
    session: RemoteShellEventSessionHarness,
    message: Extract<TerminalClientInboundMessage, { type: 'editor-snapshot' | 'editor-apply' }>,
  ): Promise<void>;
  applyRemoteShellEventState(session: RemoteShellEventSessionHarness, event: RemoteShellEventMessage): void;
  disableRemoteEnhancementsRuntime(session: RemoteShellEventSessionHarness, code: string, message: string): void;
  handleRemoteShellEvent(session: RemoteShellEventSessionHarness, event: RemoteShellEventMessage): void;
  onSessionAttached(session: RemoteShellEventSessionHarness): void;
  applyEnhancementSettings(snapshot: DefaultSettingsSnapshot): void;
  sendServerMessage(session: RemoteShellEventSessionHarness, payload: SshTerminalServerMessage): void;
  startRemoteEnhancementHandshakeTimeout(session: RemoteShellEventSessionHarness, timeoutMs?: number): void;
};

/** Minimal parser-owning session used to verify output/event forwarding order. */
type RemoteShellOutputSessionHarness = {
  remoteShellEventParser: {
    parse(data: string): RemoteShellEventStreamFrame[];
  };
};

/** Private session-service surface exercised by the ordered stream regression test. */
type RemoteShellOutputServiceHarness = {
  handleShellOutput(session: RemoteShellOutputSessionHarness, data: string): void;
};

type RemoteBootstrapEnsureServiceHarness = {
  ensureRemoteEnhancementsBeforeShell(options: {
    openClient: (signal: AbortSignal) => Promise<OpenSshClientResult>;
    serverId: string;
    sessionId: string;
    requestId?: string;
    serverEnabled: boolean;
    signal?: AbortSignal;
    sendStatus: (status: RemoteBootstrapStatus) => void;
    ensureTimeoutMs?: number;
  }): Promise<RemoteBootstrapResult>;
};

/**
 * Builds the minimum session shape needed to exercise remote shell event gating.
 *
 * @param overrides Session field overrides for the specific test case.
 * @returns Mutable session harness.
 */
const createSessionHarness = (
  overrides: Partial<RemoteShellEventSessionHarness> = {},
): RemoteShellEventSessionHarness => ({
  shellContext:
    overrides.remoteEnhancementsRuntimeState === 'active'
      ? applyShellContextEvent(
          createShellContext('session-1', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true),
          createRemoteShellEvent({ event: 'integration-ready' }),
        )
      : createShellContext(
          'session-1',
          resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true),
          overrides.remoteEnhancementsRuntimeState === 'pending',
        ),
  enhancementsAllowed: true,
  sessionId: 'session-1',
  credentialFillState: createCredentialFillState(),
  loginPassword: null,
  remoteEnhancementsRuntimeState: 'disabled',
  remoteEnhancementsRuntimeContract: {
    shell: 'bash',
    helperVersion: '1.2.3',
    protocolVersion: 3,
    capabilities: ['cwd', 'command-start', 'command-end', 'foreground-command', 'prompt-ready'],
  },
  remoteEnhancementsRuntimeCode: null,
  remoteEnhancementsRuntimeMessage: null,
  remoteEnhancementsHandshakeTimeout: null,
  pendingStreamFrames: [],
  pendingStreamFrameBytes: 0,
  pendingStreamFrameDropCount: 0,
  pendingRemoteBootstrapStatuses: [],
  remoteShellReady: false,
  remoteShellForegroundCommand: null,
  lastRemoteCommand: null,
  lastRemoteCommandId: null,
  lastExitCode: null,
  lastCommandDurationMs: null,
  commandCount: 0,
  socket: null,
  disposed: false,
  ...overrides,
});

/**
 * Creates a normalized remote shell event payload for gate tests.
 *
 * @param overrides Event field overrides for the specific test case.
 * @returns Remote shell event message.
 */
const createRemoteShellEvent = (overrides: Partial<RemoteShellEventMessage> = {}): RemoteShellEventMessage => {
  return {
    type: 'remote-shell-event',
    event: 'cwd',
    shell: 'bash',
    helperVersion: '1.2.3',
    protocolVersion: 3,
    shellInstanceId: 'shell-1',
    promptGeneration: 1,
    capabilities: ['cwd', 'command-start', 'command-end', 'foreground-command', 'prompt-ready'],
    cwd: '/root',
    physicalCwd: '/root',
    homeDirectory: '/root',
    timestamp: 1_783_172_312_000,
    ...overrides,
  } as RemoteShellEventMessage;
};

test('Zsh input pauses directory operations before forwarding and coalesces context-only recovery', async (t) => {
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
  session.remoteEnhancementsRuntimeContract!.binaryPath = '/verified/helper';
  t.after(() => {
    if (session.editorContextTimeout) clearTimeout(session.editorContextTimeout);
  });
  session.shellContext = {
    ...session.shellContext,
    status: 'ready',
    reason: null,
    shell: 'zsh',
    promptGeneration: 1,
    capabilities: ['input-snapshot', 'input-apply'],
    cwd: { logical: '/old', physical: '/old', home: '/home' },
    editorBinding: {
      pid: 42,
      startTime: '100',
      promptGeneration: 1,
      triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
      notification: { fd: 19, inode: '100' },
    },
  };
  const writes: string[] = [];
  const requests: string[] = [];
  session.stream = {
    write: (data) => {
      assert.equal(session.shellContext.status, 'paused');
      assert.equal(session.shellContext.cwd, null);
      writes.push(data);
    },
  };
  session.editorController = new ShellEditorController(
    () => session.shellContext,
    async (request) => {
      requests.push(request.operation);
      return {
        status: 'ok',
        snapshot: {
          promptGeneration: 1,
          editorMode: 'emacs',
          directory: { logical: '/new', physical: '/new', home: '/home' },
        },
      };
    },
    () => assert.fail('Zsh refresh must not inject keyboard input'),
    (state, snapshot) => {
      session.shellContext = confirmShellEditorContext(state, snapshot);
    },
  );
  const service = Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness;
  for (const data of ['a', 'b', 'c'])
    service.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'input', data })));
  assert.deepEqual(writes, ['a', 'b', 'c']);
  assert.ok(session.shellContext.editorBinding?.notification);
  const deadline = Date.now() + 2000;
  while (requests.length === 0 && Date.now() < deadline) await delay(10);
  assert.deepEqual(requests, ['context']);
  assert.equal(session.shellContext.status, 'ready');
  assert.equal(session.shellContext.cwd?.physical, '/new');
});

test('Zsh context recovery survives client attachment and permission changes during cleanup', async (t) => {
  for (const change of ['attach', 'permission'] as const) {
    const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
    t.after(() => {
      if (session.editorContextTimeout) clearTimeout(session.editorContextTimeout);
    });
    session.remoteEnhancementsRuntimeContract!.binaryPath = '/verified/helper';
    session.shellContext = {
      ...session.shellContext,
      status: 'paused',
      shell: 'zsh',
      promptGeneration: 1,
      capabilities: ['input-snapshot'],
      requiresEditorConfirmation: true,
      editorBinding: {
        pid: 42,
        startTime: '100',
        promptGeneration: 1,
        triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
        notification: { fd: 19, inode: '100' },
      },
    };
    let requests = 0;
    let finishCancelled: (() => void) | undefined;
    session.editorController = new ShellEditorController(
      () => session.shellContext,
      async () => {
        requests += 1;
        if (requests === 1) {
          await new Promise<void>((resolve) => {
            finishCancelled = resolve;
          });
          return { status: 'unavailable' };
        }
        return {
          status: 'ok',
          snapshot: {
            promptGeneration: 1,
            editorMode: 'emacs',
            directory: { logical: '/new', physical: '/new', home: '/home' },
          },
        };
      },
      () => assert.fail('context recovery must not write a key'),
      (state, snapshot) => {
        session.shellContext = confirmShellEditorContext(state, snapshot);
      },
    );
    const service = Object.assign(Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness, {
      sessions: new Map([[session.sessionId, session]]),
      enhancementSettingsSnapshot: null,
    });
    const original = session.editorController.refreshContext();
    while (!finishCancelled) await delay(1);
    if (change === 'attach') service.onSessionAttached(session);
    else
      service.applyEnhancementSettings({
        revision: 1,
        values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsInputEnabled: false },
      });
    await delay(180);
    assert.equal(requests, 1, 'replacement waits for the previous channel cleanup');
    finishCancelled();
    await original;
    assert.equal(requests, 2);
    assert.equal(session.shellContext.status, 'ready');
    assert.equal(session.shellContext.cwd?.physical, '/new');
    if (change === 'permission') assert.equal(session.shellContext.permissions.input, false);
  }
});

test('editor replies respect client and permission ownership through final publication', async () => {
  const service = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const channels: Array<
    EventEmitter & {
      stderr: PassThrough;
      writes: string[];
      destroyed: boolean;
      write(data: string): void;
      end(): void;
      destroy(): void;
    }
  > = [];
  const oldMessages: SshTerminalServerMessage[] = [];
  const newMessages: SshTerminalServerMessage[] = [];
  const oldSocket = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      oldMessages.push(JSON.parse(payload));
    },
  };
  const newSocket = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      newMessages.push(JSON.parse(payload));
    },
  };
  const client = {
    exec(_command: string, callback: (error: undefined, stream: ClientChannel) => void) {
      const events = new EventEmitter();
      const channel = Object.assign(events, {
        stderr: new PassThrough(),
        writes: [] as string[],
        destroyed: false,
        write(data: string) {
          this.writes.push(data);
        },
        end() {
          this.destroyed = true;
          events.emit('close');
        },
        destroy() {
          this.destroyed = true;
          events.emit('close');
        },
      });
      channels.push(channel);
      callback(undefined, channel as unknown as ClientChannel);
    },
  } as unknown as Client;
  const session = createSessionHarness({
    remoteEnhancementsRuntimeState: 'active',
    socket: oldSocket,
    client,
    stream: { write() {} },
  });
  session.remoteEnhancementsRuntimeContract!.binaryPath = '/verified/helper';
  session.shellContext = {
    ...session.shellContext,
    status: 'ready',
    reason: null,
    promptGeneration: 1,
    shellInstanceId: '01234567-89ab-4def-8123-456789abcdef',
    capabilities: ['input-snapshot', 'input-apply'],
    editorBinding: {
      pid: 42,
      startTime: '100',
      triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
      promptGeneration: 1,
    },
  };
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const observed = {
    promptGeneration: 1,
    editorMode: 'emacs',
    buffer: { text: 'PRIVATE_EDITOR_SENTINEL', cursor: 0 },
    directory: { logical: '/tmp', physical: '/tmp', home: null },
  };
  /** @param index External channel index. @param message Server reply fields. @returns Nothing. */
  const reply = (index: number, message: Record<string, unknown>): void => {
    const request = JSON.parse(channels[index]!.writes[0]!) as { requestId: string };
    channels[index]!.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'editor', requestId: request.requestId, ...message }) + '\n'),
    );
  };
  const first = service.handleEditorRequest(session, { type: 'editor-snapshot', requestId: id });
  reply(0, { phase: 'ready' });
  reply(0, { phase: 'done', status: 'ok', snapshot: observed });
  await first;
  const snapshot = oldMessages.find((message) => message.type === 'editor-snapshot-result' && message.status === 'ok');
  assert.ok(snapshot && snapshot.type === 'editor-snapshot-result' && snapshot.status === 'ok');
  const apply = service.handleEditorRequest(session, {
    type: 'editor-apply',
    requestId: id,
    snapshotId: snapshot.snapshotId,
    replacement: { text: 'echo new', cursor: 8 },
  });
  reply(1, { phase: 'ready' });
  session.socket = newSocket;
  service.onSessionAttached(session);
  reply(1, { phase: 'prepared', snapshot: observed });
  await apply;
  assert.equal(channels[1]!.writes.length, 1, 'old peer cannot authorize an edit after replacement');
  assert.equal(channels[1]!.destroyed, true);
  assert.equal(
    newMessages.some((message) => message.type === 'editor-apply-result'),
    false,
  );
  assert.equal(JSON.stringify(newMessages).includes('PRIVATE_EDITOR_SENTINEL'), false);
  for (const [index, permission] of (['input', 'cwd'] as const).entries()) {
    session.shellContext = {
      ...session.shellContext,
      permissions: { ...session.shellContext.permissions, input: true, cwd: true },
      editorBinding: { ...session.shellContext.editorBinding!, triggerNonce: id.slice(0, -1) + index },
    };
    const pending = service.handleEditorRequest(session, { type: 'editor-snapshot', requestId: id });
    const channelIndex = channels.length - 1;
    reply(channelIndex, { phase: 'ready' });
    reply(channelIndex, { phase: 'done', status: 'ok', snapshot: observed });
    // Revoke between the controller's resolved result and the service's final publication.
    queueMicrotask(() =>
      queueMicrotask(() => {
        session.shellContext = updateShellPermissions(session.shellContext, {
          ...session.shellContext.permissions,
          [permission]: false,
        });
        session.editorController!.invalidate();
      }),
    );
    await pending;
    assert.equal(session.shellContext.permissions[permission], false);
    assert.equal(JSON.stringify(newMessages).includes('PRIVATE_EDITOR_SENTINEL'), false);
    assert.deepEqual(newMessages.at(-1), { type: 'editor-snapshot-result', requestId: id, status: 'stale' });
  }
});

test('session request can disable but cannot override a persisted Remote Enhancements opt-out', () => {
  assert.equal(resolveRemoteEnhancementsSessionGate(true, undefined), true);
  assert.equal(resolveRemoteEnhancementsSessionGate(true, true), true);
  assert.equal(resolveRemoteEnhancementsSessionGate(true, false), false);
  assert.equal(resolveRemoteEnhancementsSessionGate(false, undefined), false);
  assert.equal(resolveRemoteEnhancementsSessionGate(false, true), false);
});

test('Bash native extension keys cannot let queued primary prompts restore ambiguous editor ownership', () => {
  const service = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  for (const input of ['\t', '\x18e']) {
    const writes: string[] = [];
    const session = createSessionHarness({
      remoteEnhancementsRuntimeState: 'active',
      stream: {
        write(data) {
          writes.push(data);
        },
      },
    });
    session.shellContext = {
      ...session.shellContext,
      status: 'ready',
      reason: null,
      promptGeneration: 1,
      editorBinding: { pid: 42, startTime: '100', promptGeneration: 1, triggerNonce: 'epoch' },
    };
    service.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'input', data: 'echo ok\r' })));
    service.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'input', data: input })));
    assert.equal(session.shellContext.requiresEditorConfirmation, true);
    session.shellContext = applyShellContextEvent(
      session.shellContext,
      createRemoteShellEvent({
        event: 'prompt-ready',
        promptGeneration: 2,
      }),
    );
    assert.equal(session.shellContext.status, 'paused');
    assert.deepEqual(writes, ['echo ok\r', input], 'native input still reaches the PTY unchanged');
  }
});

test('ordinary input preserves disabled and unavailable enhancement reasons', () => {
  const service = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  for (const reason of ['permission-disabled', 'helper-unavailable'] as const) {
    const session = createSessionHarness({ stream: { write() {} } });
    session.shellContext = suspendShellContext({ ...session.shellContext, shell: 'bash' }, reason, true);
    service.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'input', data: 'x\t' })));
    assert.equal(session.shellContext.status, 'unavailable');
    assert.equal(session.shellContext.reason, reason);
  }
});

test('nested mismatched helper cannot disable or replace the original runtime', () => {
  const service = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
  service.handleRemoteShellEvent(session, createRemoteShellEvent({ event: 'prompt-ready', promptGeneration: 1 }));
  service.handleRemoteShellEvent(
    session,
    createRemoteShellEvent({
      event: 'integration-ready',
      shell: 'fish',
      shellInstanceId: 'child',
      helperVersion: 'different',
    }),
  );
  assert.equal(session.remoteEnhancementsRuntimeState, 'active');
  assert.equal(session.shellContext.reason, 'foreign-shell');
  assert.equal(session.shellContext.shellInstanceId, 'shell-1');
  service.handleRemoteShellEvent(session, createRemoteShellEvent({ event: 'prompt-ready', promptGeneration: 2 }));
  assert.equal(session.shellContext.status, 'ready');
});

test('late settings reads cannot restore cleared directory state or resurrect a disabled runtime', () => {
  const session = createSessionHarness({
    remoteEnhancementsRuntimeState: 'active',
  });
  const service = Object.assign(
    Object.create(SshSessionService.prototype) as {
      applyEnhancementSettings(snapshot: DefaultSettingsSnapshot): void;
      handleVisibleShellOutput(session: RemoteShellEventSessionHarness, output: string): void;
    },
    { sessions: new Map([[session.sessionId, session]]), enhancementSettingsSnapshot: null },
  );
  service.applyEnhancementSettings({
    revision: 2,
    values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsCwdEnabled: false },
  });
  service.applyEnhancementSettings({ revision: 1, values: DEFAULT_SETTINGS_VALUES });
  assert.equal(session.shellContext.permissions.cwd, false);
  service.handleVisibleShellOutput(session, 'fixture@host:/wrong$ ');
  assert.equal(session.shellContext.cwd, null);
  assert.equal(session.shellContext.lastKnownCwd, null);
  service.applyEnhancementSettings({
    revision: 3,
    values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsEnabled: false },
  });
  assert.equal(session.remoteEnhancementsRuntimeState, 'disabled');
  service.applyEnhancementSettings({ revision: 4, values: DEFAULT_SETTINGS_VALUES });
  assert.equal(
    session.remoteEnhancementsRuntimeState,
    'disabled',
    'global re-enable requires a new validated connection',
  );
});

test('structured command lifecycle becomes authoritative only after matching capability activation', () => {
  assert.equal(usesStructuredRemoteCommandLifecycle('pending', ['command-start']), false);
  assert.equal(usesStructuredRemoteCommandLifecycle('disabled', ['command-start']), false);
  assert.equal(usesStructuredRemoteCommandLifecycle('active', ['cwd', 'prompt-ready']), false);
  assert.equal(usesStructuredRemoteCommandLifecycle('active', ['command-start', 'command-end']), true);
});

test('a trusted shell prompt clears an outstanding credential offer without visible output', () => {
  const messages: SshTerminalServerMessage[] = [];
  const session = createSessionHarness({
    credentialFillState: observeCredentialFillOutput(createCredentialFillState(), 'Password: ', Date.now()),
    loginPassword: 'fixture-only',
  });
  const service = Object.assign(Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness, {
    sendServerMessage: (_session: RemoteShellEventSessionHarness, message: SshTerminalServerMessage) =>
      messages.push(message),
  });
  service.applyRemoteShellEventState(session, createRemoteShellEvent({ event: 'prompt-ready', cwd: undefined }));
  assert.equal(session.credentialFillState.offer, null);
  assert.deepEqual(messages, [{ type: 'credential-fill-offer', offer: null }]);
});

test('SshSessionService forwards visible output and helper events in original PTY order', () => {
  const commandStart = createRemoteShellEvent({
    event: 'command-start',
    command: 'echo',
    commandId: 'cmd-1',
    cwd: undefined,
  });
  const frames: RemoteShellEventStreamFrame[] = [
    { type: 'output', data: '\r\n' },
    { type: 'event', event: commandStart },
    { type: 'output', data: 'result\r\n' },
  ];
  const forwarded: string[] = [];
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellOutputServiceHarness;
  const serviceContext = {
    handleVisibleShellOutput: (_session: RemoteShellOutputSessionHarness, data: string): void => {
      forwarded.push(`output:${JSON.stringify(data)}`);
    },
    handleRemoteShellEvent: (_session: RemoteShellOutputSessionHarness, event: RemoteShellEventMessage): void => {
      forwarded.push(`event:${event.event}`);
    },
  };
  const session: RemoteShellOutputSessionHarness = {
    remoteShellEventParser: {
      parse: () => frames,
    },
  };

  serviceHarness.handleShellOutput.call(serviceContext, session, 'raw-pty-chunk');

  assert.deepEqual(forwarded, ['output:"\\r\\n"', 'event:command-start', 'output:"result\\r\\n"']);
});

test('SshSessionService ignores remote shell events while the runtime is disabled', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness();
  const event = createRemoteShellEvent();

  serviceHarness.handleRemoteShellEvent(session, event);

  assert.equal(session.shellContext.cwd, null);
  assert.equal(session.remoteShellReady, false);
  assert.deepEqual(session.pendingStreamFrames, []);
});

test('SshSessionService preserves detached output and helper event ordering on attach', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const sentMessages: SshTerminalServerMessage[] = [];
  const commandStart = createRemoteShellEvent({
    event: 'command-start',
    command: 'echo',
    commandId: 'cmd-1',
    cwd: undefined,
  });
  const transportedCommandStart = JSON.parse(JSON.stringify(commandStart)) as RemoteShellEventMessage;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });

  serviceHarness.sendServerMessage(session, { type: 'output', data: '\r\n' });
  serviceHarness.sendServerMessage(session, commandStart);
  serviceHarness.sendServerMessage(session, { type: 'output', data: 'result\r\n' });

  assert.deepEqual(
    session.pendingStreamFrames.map((frame) => frame.type),
    ['output', 'event', 'output'],
  );

  session.socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string): void => {
      sentMessages.push(JSON.parse(payload) as SshTerminalServerMessage);
    },
  };
  serviceHarness.onSessionAttached(session);

  assert.deepEqual(
    sentMessages.map((message) => message.type),
    [
      'ready',
      'remote-enhancement-runtime-status',
      'shell-context',
      'output',
      'remote-shell-event',
      'output',
      'credential-fill-offer',
    ],
  );
  assert.deepEqual(sentMessages.slice(3, -1), [
    { type: 'output', data: '\r\n' },
    transportedCommandStart,
    { type: 'output', data: 'result\r\n' },
  ]);
  assert.deepEqual(sentMessages.at(-1), { type: 'credential-fill-offer', offer: null });
  assert.deepEqual(session.pendingStreamFrames, []);
  assert.equal(session.pendingStreamFrameBytes, 0);
});

test('SshSessionService bounds the detached stream queue by frame count and bytes', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const countBoundSession = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
  for (let index = 0; index < 2_049; index += 1) {
    serviceHarness.sendServerMessage(countBoundSession, { type: 'output', data: `line-${index}` });
  }

  assert.equal(countBoundSession.pendingStreamFrames.length, 2_048);
  assert.ok(countBoundSession.pendingStreamFrameBytes <= 1024 * 1024);
  assert.equal(countBoundSession.pendingStreamFrameDropCount, 1);
  assert.deepEqual(countBoundSession.pendingStreamFrames[0], { type: 'output', data: 'line-1' });

  const byteBoundSession = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
  serviceHarness.sendServerMessage(byteBoundSession, { type: 'output', data: 'a'.repeat(700 * 1024) });
  serviceHarness.sendServerMessage(byteBoundSession, { type: 'output', data: 'b'.repeat(700 * 1024) });

  assert.equal(byteBoundSession.pendingStreamFrames.length, 1);
  assert.ok(byteBoundSession.pendingStreamFrameBytes <= 1024 * 1024);
  assert.equal(byteBoundSession.pendingStreamFrameDropCount, 1);
});

test('SshSessionService activates only after a matching integration-ready handshake', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'pending' });
  serviceHarness.startRemoteEnhancementHandshakeTimeout(session, 1_000);

  serviceHarness.handleRemoteShellEvent(session, createRemoteShellEvent());
  assert.equal(session.remoteEnhancementsRuntimeState, 'pending');
  assert.equal(session.shellContext.cwd, null);

  serviceHarness.handleRemoteShellEvent(
    session,
    createRemoteShellEvent({ event: 'integration-ready', cwd: undefined }),
  );

  assert.equal(session.remoteEnhancementsRuntimeState, 'active');
  assert.equal(session.remoteEnhancementsHandshakeTimeout, null);
  assert.equal(session.remoteShellReady, true);

  serviceHarness.handleRemoteShellEvent(session, createRemoteShellEvent({ cwd: '/home/dev' }));
  assert.equal(session.shellContext.cwd, null, 'report is pending until the matching prompt');
  serviceHarness.handleRemoteShellEvent(session, createRemoteShellEvent({ event: 'prompt-ready' }));
  assert.deepEqual(session.shellContext.cwd, { logical: '/home/dev', physical: '/root', home: '/root' });
});

test('SshSessionService disables a pending runtime when the helper handshake times out', async () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'pending' });

  serviceHarness.startRemoteEnhancementHandshakeTimeout(session, 5);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

  assert.equal(session.remoteEnhancementsRuntimeState, 'disabled');
  assert.equal(session.remoteEnhancementsRuntimeCode, 'HELPER_HANDSHAKE_TIMEOUT');
  assert.equal(session.remoteEnhancementsHandshakeTimeout, null);
});

test('SshSessionService disables a pending runtime when the helper contract mismatches', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'pending' });

  serviceHarness.handleRemoteShellEvent(
    session,
    createRemoteShellEvent({ event: 'integration-ready', helperVersion: '1.2.2' }),
  );

  assert.equal(session.remoteEnhancementsRuntimeState, 'disabled');
  assert.equal(session.remoteEnhancementsRuntimeCode, 'HELPER_CONTRACT_MISMATCH');
  assert.equal(session.remoteShellReady, false);
});

test('SshSessionService resets remote shell state when Remote Enhancements runtime is disabled', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const event = createRemoteShellEvent();
  const session = createSessionHarness({
    lastCommandDurationMs: 25,
    lastExitCode: 1,
    lastRemoteCommand: 'false',
    pendingStreamFrames: [
      { type: 'output', data: 'before' },
      { type: 'event', event },
      { type: 'output', data: 'after' },
    ],
    pendingStreamFrameBytes: 999,
    remoteEnhancementsRuntimeState: 'active',
    remoteShellForegroundCommand: 'vim',
    remoteShellReady: true,
  });

  serviceHarness.disableRemoteEnhancementsRuntime(session, 'TEST_DISABLED', 'disabled for test');

  assert.equal(session.remoteEnhancementsRuntimeState, 'disabled');
  assert.equal(session.remoteEnhancementsRuntimeCode, 'TEST_DISABLED');
  assert.equal(session.remoteEnhancementsHandshakeTimeout, null);
  assert.deepEqual(session.pendingStreamFrames, [
    { type: 'output', data: 'before' },
    { type: 'output', data: 'after' },
  ]);
  assert.equal(session.pendingStreamFrameBytes, 11);
  assert.equal(session.remoteShellReady, false);
  assert.equal(session.shellContext.cwd, null);
  assert.equal(session.remoteShellForegroundCommand, null);
  assert.equal(session.lastRemoteCommand, null);
  assert.equal(session.lastExitCode, null);
  assert.equal(session.lastCommandDurationMs, null);
});

test('SshSessionService suppresses completion through command-end until the next prompt-ready event', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });

  serviceHarness.handleRemoteShellEvent(
    session,
    createRemoteShellEvent({
      event: 'foreground-command',
      command: 'vim',
      commandId: 'cmd-1',
      cwd: undefined,
    }),
  );
  serviceHarness.handleRemoteShellEvent(
    session,
    createRemoteShellEvent({
      event: 'command-end',
      command: 'vim',
      commandId: 'cmd-1',
      cwd: undefined,
      exitCode: 0,
      durationMs: 20,
    }),
  );

  assert.equal(session.remoteShellForegroundCommand, 'vim');

  serviceHarness.handleRemoteShellEvent(session, createRemoteShellEvent({ event: 'prompt-ready', cwd: undefined }));
  assert.equal(session.remoteShellForegroundCommand, null);
});

test('SshSessionService counts and refreshes each structured command id exactly once', () => {
  const serviceHarness = SshSessionService.prototype as unknown as RemoteShellEventServiceHarness;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
  const scheduledSessionIds: string[] = [];
  const serviceContext = {
    scheduleHistorySync: (sessionId: string): void => {
      scheduledSessionIds.push(sessionId);
    },
  };
  const firstCommand = createRemoteShellEvent({
    event: 'command-start',
    command: 'git',
    commandId: 'cmd-1',
    cwd: undefined,
  });

  serviceHarness.applyRemoteShellEventState.call(serviceContext, session, firstCommand);
  serviceHarness.applyRemoteShellEventState.call(serviceContext, session, firstCommand);
  serviceHarness.applyRemoteShellEventState.call(
    serviceContext,
    session,
    createRemoteShellEvent({
      event: 'command-start',
      command: 'pwd',
      commandId: 'cmd-2',
      cwd: undefined,
    }),
  );

  assert.equal(session.commandCount, 2);
  assert.equal(session.lastRemoteCommandId, 'cmd-2');
  assert.equal(session.lastRemoteCommand, 'pwd');
  assert.deepEqual(scheduledSessionIds, ['session-1', 'session-1']);
});

test('SshSessionService stops waiting when the optional bootstrap exceeds its total connection budget', async () => {
  const statuses: RemoteBootstrapStatus[] = [];
  const reportedStatuses: RemoteBootstrapStatus[] = [];
  const reportedContexts: Array<{ serverId: string; sessionId: string; requestId?: string }> = [];
  let receivedSignal: AbortSignal | undefined;
  const serviceContext = {
    getDbClient: () => ({
      $queryRaw: async () => [],
    }),
    remoteBootstrapService: {
      runForSession: async (options: { signal?: AbortSignal }): Promise<RemoteBootstrapResult> => {
        receivedSignal = options.signal;
        return await new Promise<RemoteBootstrapResult>(() => undefined);
      },
      reportStatus: (
        context: {
          serverId: string;
          sessionId: string;
          requestId?: string;
          sendStatus: (status: RemoteBootstrapStatus) => void;
        },
        status: RemoteBootstrapStatus,
      ): void => {
        reportedContexts.push({
          serverId: context.serverId,
          sessionId: context.sessionId,
          requestId: context.requestId,
        });
        reportedStatuses.push(status);
        context.sendStatus(status);
      },
    },
  };
  const serviceHarness = SshSessionService.prototype as unknown as RemoteBootstrapEnsureServiceHarness;
  const startedAt = Date.now();
  const keepAlive = setTimeout(() => undefined, 1_000);

  const result = await serviceHarness.ensureRemoteEnhancementsBeforeShell
    .call(serviceContext, {
      openClient: async () => {
        throw new Error('bootstrap client should stay lazy while no command is requested');
      },
      serverId: 'server-1',
      sessionId: 'session-1',
      requestId: 'request-1',
      serverEnabled: true,
      sendStatus: (status) => statuses.push(status),
      ensureTimeoutMs: 5,
    })
    .finally(() => clearTimeout(keepAlive));

  assert.equal(result.state, 'disabled');
  assert.equal(result.state === 'disabled' ? result.code : null, 'BOOTSTRAP_ENSURE_TIMEOUT');
  assert.equal(statuses.at(-1)?.code, 'BOOTSTRAP_ENSURE_TIMEOUT');
  assert.equal(reportedStatuses.at(-1)?.code, 'BOOTSTRAP_ENSURE_TIMEOUT');
  assert.deepEqual(reportedContexts, [
    {
      serverId: 'server-1',
      sessionId: 'session-1',
      requestId: 'request-1',
    },
  ]);
  assert.equal(receivedSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});
