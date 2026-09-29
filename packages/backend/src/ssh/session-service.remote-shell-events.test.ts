import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_SETTINGS_VALUES,
  type RemoteShellCapability,
  type ShellEditorRequest,
  type ShellHistoryView,
  type SshTerminalServerMessage,
} from '@cosmosh/api-contract';
import type { Client, ClientChannel } from 'ssh2';

import type { RemoteBootstrapResult, RemoteBootstrapStatus } from '../remote-bootstrap/service.js';
import type { DefaultSettingsSnapshot } from '../settings/read.js';
import { emptyPathResult, RemotePathQueryController } from '../terminal/completion/remote-path-query.js';
import { SnapshotCompletionController } from '../terminal/completion/snapshot-completion.js';
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
import { DeliveredTerminal } from './terminal-transport.js';

/** External SSH peer for the ordered PTY; production framing, delivery and authorization remain real. */
class OrderedTerminalChannel extends Duplex {
  readonly stderr = new PassThrough();
  private epoch: string | null = null;
  private delivered = 0;

  /** @param onInput Observer for the original terminal bytes accepted by the remote PTY. */
  constructor(private readonly onInput: (data: string) => void) {
    super();
  }

  /** @returns Nothing; remote frames are emitted explicitly at the SSH boundary. */
  _read(): void {}

  /** @param chunk Private frame. @param _encoding Encoding. @param done SSH write callback. @returns Nothing. */
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    const frame = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
    if (frame.type === 'start') {
      assert.equal(frame.protocol, 2);
      assert.equal(typeof frame.epoch, 'string');
      this.epoch = frame.epoch as string;
      this.reply({ type: 'ready', epoch: this.epoch, pid: 42 });
    } else if (frame.type === 'input') {
      assert.equal(frame.epoch, this.epoch);
      assert.equal(frame.sequence, this.delivered + 1);
      assert.equal(typeof frame.data, 'string');
      this.onInput(Buffer.from(frame.data as string, 'base64').toString('utf8'));
      this.delivered += 1;
      this.reply({ type: 'delivered', epoch: this.epoch, sequence: this.delivered });
    } else if (frame.type === 'authorize-editor') {
      this.reply({
        type: 'editor-authorized',
        epoch: frame.epoch,
        sequence: frame.sequence,
        requestId: frame.requestId,
        approved: frame.epoch === this.epoch && frame.sequence === this.delivered,
      });
    } else {
      assert.ok(frame.type === 'revoke-editor' || frame.type === 'resize');
    }
    done();
  }

  /** @param frame Remote protocol reply. @returns Nothing. */
  reply(frame: Record<string, unknown>): void {
    this.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));
  }

  /** @returns Nothing; closes the external SSH channel. */
  close(): void {
    this.destroy();
  }
}

/**
 * Completes the real transport handshake and scopes its lifetime to the test.
 * @param t Test lifetime. @param onInput Observer for user input at the external PTY boundary.
 * @returns Ready production terminal with an authenticated original Shell PID.
 */
const createOrderedTerminal = (t: TestContext, onInput: (data: string) => void = () => {}): DeliveredTerminal => {
  const channel = new OrderedTerminalChannel(onInput);
  const terminal = new DeliveredTerminal(
    channel as unknown as ClientChannel,
    { rows: 32, cols: 120, term: 'xterm-256color', onOutput: () => {} },
    (result) => assert.equal(result.status, 'ready'),
  );
  t.after(() => terminal.close());
  channel.reply({ type: 'hello', protocol: 2 });
  assert.equal(terminal.originalShellPID, 42);
  return terminal;
};

type RemoteShellEventSessionHarness = {
  shellContext: ShellContextState;
  editorController?: ShellEditorController;
  completionController?: SnapshotCompletionController;
  editorContextTimeout?: NodeJS.Timeout;
  client?: Client;
  stream?: { write(data: string): void };
  enhancementsAllowed: boolean;
  sessionId: string;
  credentialFillState: CredentialFillState;
  loginPassword: string | null;
  remoteEnhancementsRuntimeState: 'pending' | 'active' | 'disabled';
  remoteEnhancementsRuntimeContract: {
    shell: 'bash' | 'zsh' | 'fish';
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
  historySyncTimeout: NodeJS.Timeout | null;
  historySyncInFlight: boolean;
  historySyncPending: boolean;
  historyAbortController?: AbortController;
  historyView?: ShellHistoryView;
  historyOwnerInstanceId?: string;
  historyMutationInFlight?: boolean;
  lastHistorySyncStartedAtMs: number;
  recentCommands: string[];
  completionRecentCommands: string[];
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
  historySyncTimeout: null,
  historySyncInFlight: false,
  historySyncPending: false,
  historyMutationInFlight: false,
  lastHistorySyncStartedAtMs: 0,
  recentCommands: [],
  completionRecentCommands: [],
  socket: null,
  disposed: false,
  ...overrides,
});

test('optional WebSocket notification failures never prevent ordered input or retain private candidates', async (t) => {
  const session = createSessionHarness({
    remoteEnhancementsRuntimeState: 'active',
    credentialFillState: observeCredentialFillOutput(createCredentialFillState(), 'Password: ', Date.now()),
    loginPassword: 'fixture-only',
  });
  session.shellContext = {
    ...session.shellContext,
    shell: 'zsh',
    shellInstanceId: randomUUID(),
    status: 'ready',
    reason: null,
    promptGeneration: 1,
    capabilities: ['input-snapshot', 'input-apply'],
    editorBinding: {
      pid: 42,
      startTime: '100',
      promptGeneration: 1,
      triggerNonce: randomUUID(),
      notification: { fd: 19, inode: '100' },
    },
  };
  const writes: string[] = [];
  const attempted: string[] = [];
  const warnings: unknown[][] = [];
  let failPublications = false;
  const terminal = createOrderedTerminal(t, (data) => writes.push(data));
  session.stream = terminal;
  session.socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => {
      const message = JSON.parse(payload) as SshTerminalServerMessage;
      attempted.push(message.type);
      if (failPublications) throw new Error('private-payload-in-socket-error');
    },
  };
  const service = Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness;
  const editor = new ShellEditorController(
    () => session.shellContext,
    async () => ({
      status: 'ok',
      snapshot: { promptGeneration: 1, editorMode: 'emacs', buffer: { text: 'git st', cursor: 6 } },
    }),
    () => terminal,
    () => {},
  );
  session.editorController = editor;
  const completion = new SnapshotCompletionController({
    editor,
    paths: new RemotePathQueryController(async () => emptyPathResult('ok')),
    context: () => session.shellContext,
    readSettings: async () => ({
      ...DEFAULT_SETTINGS_VALUES,
      terminalNativeCompletionMode: 'off',
      terminalAutoCompletePathEnabled: false,
    }),
    history: () => null,
    publish: (message) => service.sendServerMessage(session, message),
  });
  session.completionController = completion;
  t.after(() => {
    completion.invalidate(true, false);
    if (session.editorContextTimeout) clearTimeout(session.editorContextTimeout);
  });
  await completion.query({ type: 'completion-query', trigger: 'manual', requestId: randomUUID() });
  assert.equal(completion.busy, true);
  attempted.length = 0;
  failPublications = true;
  t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
  assert.doesNotThrow(() =>
    service.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'input', data: 'private-input' }))),
  );
  assert.deepEqual(writes, ['private-input']);
  assert.deepEqual(attempted, ['completion-update', 'shell-context', 'credential-fill-offer']);
  assert.equal(completion.busy, false);
  assert.equal(session.credentialFillState.offer, null);
  assert.equal(session.shellContext.status, 'paused');
  assert.equal(warnings.length, 3);
  assert.equal(JSON.stringify(warnings).includes('private-'), false);
});

test('input and resize transport exceptions close only their session and never expose payloads', (t) => {
  for (const message of [
    { type: 'input', data: 'private-password' },
    { type: 'resize', rows: 32, cols: 120 },
  ]) {
    const session = createSessionHarness();
    session.stream = Object.assign(
      {
        write: () => {
          throw new Error('private-password');
        },
      },
      {
        setWindow: () => {
          throw new Error('private-password');
        },
      },
    );
    const closed: string[] = [];
    const warnings: unknown[][] = [];
    const log = t.mock.method(console, 'warn', (...values: unknown[]) => warnings.push(values));
    const service = Object.assign(Object.create(SshSessionService.prototype), {
      disposeSession: (id: string) => closed.push(id),
    }) as RemoteShellEventServiceHarness;
    assert.doesNotThrow(() => service.handleClientMessage(session, Buffer.from(JSON.stringify(message))));
    assert.deepEqual(closed, [session.sessionId]);
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes('private-password'), false);
    log.mock.restore();
  }
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
  const terminal = createOrderedTerminal(t, (data) => {
    assert.equal(session.shellContext.status, 'paused');
    assert.equal(session.shellContext.cwd, null);
    writes.push(data);
  });
  session.stream = terminal;
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
    () => terminal,
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
    const terminal = createOrderedTerminal(t, () => assert.fail('context recovery must not write a key'));
    session.stream = terminal;
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
      () => terminal,
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

test('editor replies respect client and permission ownership through final publication', async (t) => {
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
    stream: createOrderedTerminal(t, () => assert.fail('editor requests must not inject terminal input')),
  });
  const service = Object.assign(Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness, {
    sessions: new Map([[session.sessionId, session]]),
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
      notification: { signal: 'URG' },
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
  await Promise.resolve();
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
  await Promise.resolve();
  reply(1, { phase: 'ready' });
  session.socket = newSocket;
  service.onSessionAttached(session);
  reply(1, { phase: 'prepared', snapshot: observed });
  await apply;
  assert.equal(channels[1]!.writes.length, 2, 'only the request and pre-cancellation activation were sent');
  assert.ok(
    channels[1]!.writes.every((value) => !value.includes('"apply":true')),
    'old peer cannot authorize an edit after replacement',
  );
  assert.equal(channels[1]!.destroyed, true);
  assert.equal(
    newMessages.some((message) => message.type === 'editor-apply-result'),
    false,
  );
  assert.equal(JSON.stringify(newMessages).includes('PRIVATE_EDITOR_SENTINEL'), false);
  for (const [index, permission] of (['input', 'cwd'] as const).entries()) {
    session.shellContext = {
      ...session.shellContext,
      status: 'ready',
      reason: null,
      requiresEditorConfirmation: false,
      permissions: { ...session.shellContext.permissions, input: true, cwd: true },
      editorBinding: { ...session.shellContext.editorBinding!, triggerNonce: id.slice(0, -1) + index },
    };
    const channelIndex = channels.length;
    const pending = service.handleEditorRequest(session, { type: 'editor-snapshot', requestId: id });
    await Promise.resolve();
    assert.equal(channels.length, channelIndex + 1, 'the replacement peer starts a fresh editor request');
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
  const sentMessages: SshTerminalServerMessage[] = [];
  const commandStart = createRemoteShellEvent({
    event: 'command-start',
    command: 'echo',
    commandId: 'cmd-1',
    cwd: undefined,
  });
  const transportedCommandStart = JSON.parse(JSON.stringify(commandStart)) as RemoteShellEventMessage;
  const session = createSessionHarness({ remoteEnhancementsRuntimeState: 'active' });
  const serviceHarness = Object.assign(Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness, {
    sessions: new Map([[session.sessionId, session]]),
  });

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
      'shell-history',
      'credential-fill-offer',
    ],
  );
  assert.deepEqual(sentMessages.slice(3, -2), [
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
  const serviceHarness = Object.assign(Object.create(SshSessionService.prototype) as RemoteShellEventServiceHarness, {
    sessions: new Map<string, RemoteShellEventSessionHarness>(),
  });
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
  const writes: string[] = [];
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
    stream: Object.assign(
      { write: (data: string) => writes.push(data) },
      {
        close: () => assert.fail('Permission revocation cannot close the terminal transport'),
        destroy: () => assert.fail('Permission revocation cannot destroy the terminal transport'),
      },
    ),
  });

  serviceHarness.disableRemoteEnhancementsRuntime(session, 'TEST_DISABLED', 'disabled for test');
  serviceHarness.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'input', data: 'ordinary input' })));
  assert.deepEqual(writes, ['ordinary input']);

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

/** Production history owner exercised through a request-scoped SSH channel boundary. */
type HistoryServiceHarness = RemoteShellEventServiceHarness & {
  disposeSession(sessionId: string, reasonKey: string): void;
  syncRemoteHistory(sessionId: string): Promise<void>;
  scheduleHistorySync(sessionId: string, options?: { immediate?: boolean }): void;
  clearRemoteHistory(session: RemoteShellEventSessionHarness): void;
  deleteRemoteHistoryEntry(
    session: RemoteShellEventSessionHarness,
    message: Extract<TerminalClientInboundMessage, { type: 'shell-history-remove' }>,
  ): Promise<void>;
  handleCompletionRequest(
    session: RemoteShellEventSessionHarness,
    message: Extract<TerminalClientInboundMessage, { type: 'completion-request' }>,
  ): Promise<void>;
};

/** Models the private helper protocol without replacing the editor controller or transport. */
class HistoryChannel extends EventEmitter {
  stderr = new PassThrough();
  writes: string[] = [];
  closed = false;
  private opened = false;

  constructor(private readonly callback: (error: undefined, channel: ClientChannel) => void) {
    super();
  }

  /** @returns The authenticated request sent through private stdin. */
  get request(): ShellEditorRequest {
    return JSON.parse(this.writes[0]!) as ShellEditorRequest;
  }

  /** @returns Nothing; supplies ssh2's asynchronous channel callback. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.callback(undefined, this as unknown as ClientChannel);
  }

  /** @param data Private stdin bytes. @returns Nothing. */
  write(data: string): void {
    this.writes.push(data);
  }

  /** @returns Nothing; models worker EOF and transport release. */
  end(): void {
    this.close();
  }

  /** @returns Nothing; models forced transport closure. */
  destroy(): void {
    this.close();
  }

  /** @returns Nothing; emits one close event. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /** @param fields Private helper response fields. @returns Nothing. */
  reply(fields: Record<string, unknown>): void {
    this.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'editor', requestId: this.request.requestId, ...fields }) + '\n'),
    );
  }
}

/** @param overrides Event fields. @returns One matching original Fish helper event. */
const fishHistoryEvent = (overrides: Partial<RemoteShellEventMessage> = {}): RemoteShellEventMessage =>
  createRemoteShellEvent({
    shell: 'fish',
    capabilities: ['cwd', 'command-start', 'command-end', 'prompt-ready', 'history-read'],
    ...overrides,
  });

/**
 * Keeps the production controller and two-phase transport while substituting only ssh2.
 * @param t Test lifetime.
 * @param openImmediately Whether ssh2 delivers its exec callback synchronously.
 * @returns Mutable session and request-scoped worker channels.
 */
const createHistoryServiceHarness = (t: TestContext, openImmediately = true) => {
  const messages: SshTerminalServerMessage[] = [];
  const channels: HistoryChannel[] = [];
  const commands: string[] = [];
  const session = Object.assign(createSessionHarness({ remoteEnhancementsRuntimeState: 'active' }), {
    stream: createOrderedTerminal(t, () => assert.fail('history requests must not inject terminal input')),
    t: (key: string) => key,
    socket: {
      OPEN: 1,
      readyState: 1,
      send: (payload: string) => messages.push(JSON.parse(payload) as SshTerminalServerMessage),
      close: () => undefined,
    },
  });
  session.remoteEnhancementsRuntimeContract = {
    shell: 'fish',
    helperVersion: '1.2.3',
    protocolVersion: 3,
    capabilities: fishHistoryEvent().capabilities,
    binaryPath: '/verified/helper',
  };
  let context = createShellContext(session.sessionId, resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true);
  context = applyShellContextEvent(context, fishHistoryEvent({ event: 'integration-ready' }));
  context = applyShellContextEvent(context, fishHistoryEvent({ event: 'prompt-ready', promptGeneration: 1 }));
  session.shellContext = applyShellContextEvent(
    context,
    fishHistoryEvent({
      event: 'editor-state',
      promptGeneration: 1,
      available: true,
      pid: 42,
      startTime: '100',
      triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
      notification: { signal: 'URG' },
    }),
  );
  session.client = {
    end: () => undefined,
    exec: (command: string, callback: (error: undefined, channel: ClientChannel) => void) => {
      commands.push(command);
      const channel = new HistoryChannel(callback);
      channels.push(channel);
      if (openImmediately) channel.open();
    },
  } as unknown as Client;
  const service = Object.assign(Object.create(SshSessionService.prototype) as HistoryServiceHarness, {
    sessions: new Map([[session.sessionId, session]]),
    enhancementSettingsSnapshot: null,
    auditEventService: { logEvent: async () => undefined },
  });
  return { session, service, channels, messages, commands };
};

/**
 * Completes one actual private history request.
 * @param channel Worker channel. @param entries Exact newest-first records.
 * @param status Native observation state. @param namespace Current Fish namespace.
 * @returns Nothing.
 */
const completeHistory = (
  channel: HistoryChannel,
  entries: string[],
  status: 'ok' | 'partial' | 'private' = 'ok',
  namespace: string | null = 'fish',
): void => {
  assert.equal(channel.request.operation, 'history');
  channel.reply({ phase: 'ready' });
  channel.reply({
    phase: 'done',
    status: 'ok',
    snapshot: {
      promptGeneration: 1,
      editorMode: 'emacs',
      history: { status, namespace, entries },
    },
  });
};

/** @param sourceId Displayed source. @param command Exact displayed record. @returns Client removal request. */
const removalRequest = (sourceId: string, command: string) =>
  ({ type: 'shell-history-remove', requestId: 'remove-1', sourceId, command }) as const;

/** @param messages Sent messages. @returns Last published native view. */
const lastHistoryView = (messages: SshTerminalServerMessage[]): ShellHistoryView => {
  const message = messages.filter((item) => item.type === 'shell-history').at(-1);
  assert.ok(message?.type === 'shell-history');
  return message.view;
};

test('native history starts only after the Fish handshake and editor binding, including a late registration', async (t) => {
  for (const registered of [true, false]) {
    const { session, service, channels, messages } = createHistoryServiceHarness(t);
    t.after(() => service.clearRemoteHistory(session));
    session.remoteEnhancementsRuntimeState = 'pending';
    session.shellContext = createShellContext(
      session.sessionId,
      resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true),
      true,
    );
    if (!registered) service.sessions.delete(session.sessionId);
    service.scheduleHistorySync(session.sessionId, { immediate: true });
    assert.equal(session.historySyncTimeout, null);
    service.handleRemoteShellEvent(session, fishHistoryEvent({ event: 'integration-ready' }));
    assert.equal(channels.length, 0);
    service.handleRemoteShellEvent(session, fishHistoryEvent({ event: 'prompt-ready', promptGeneration: 1 }));
    service.handleRemoteShellEvent(
      session,
      fishHistoryEvent({
        event: 'editor-state',
        promptGeneration: 1,
        available: true,
        pid: 42,
        startTime: '100',
        triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
        notification: { signal: 'URG' },
      }),
    );
    if (!registered) service.sessions.set(session.sessionId, session);
    if (session.historySyncTimeout) clearTimeout(session.historySyncTimeout);
    session.historySyncTimeout = null;
    const pending = service.syncRemoteHistory(session.sessionId);
    await Promise.resolve();
    assert.equal(channels.length, 1);
    completeHistory(channels[0]!, ['echo earlier']);
    await pending;
    const view = lastHistoryView(messages);
    assert.deepEqual(view.entries, ['echo earlier']);
    assert.equal(view.source?.shell, 'fish');
    service.handleRemoteShellEvent(session, fishHistoryEvent({ event: 'integration-ready' }));
    assert.deepEqual(lastHistoryView(messages), view, 'duplicate handshake keeps the source');
    assert.equal(channels.length, 1);
  }
});

test('history opt-out during handshake and unsupported shells never execute a native request', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  session.remoteEnhancementsRuntimeState = 'pending';
  session.shellContext = createShellContext(
    session.sessionId,
    resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true),
    true,
  );
  service.applyEnhancementSettings({
    revision: 1,
    values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsHistoryEnabled: false },
  });
  service.handleRemoteShellEvent(session, fishHistoryEvent({ event: 'integration-ready' }));
  assert.equal(session.shellContext.permissions.history, false);
  assert.equal(lastHistoryView(messages).status, 'disabled');
  await service.syncRemoteHistory(session.sessionId);
  assert.equal(channels.length, 0);

  const unsupported = createHistoryServiceHarness(t);
  t.after(() => unsupported.service.clearRemoteHistory(unsupported.session));
  unsupported.session.shellContext = { ...unsupported.session.shellContext, shell: 'sh' };
  unsupported.service.scheduleHistorySync(unsupported.session.sessionId, { immediate: true });
  await unsupported.service.syncRemoteHistory(unsupported.session.sessionId);
  assert.equal(unsupported.channels.length, 0);
  assert.equal(unsupported.session.historySyncTimeout, null);
});

test('native observations replace namespace and private state without reusing source IDs or parsing records', async (t) => {
  const { session, service, channels, messages, commands } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const first = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['multi\nline', 'echo  trailing  ']);
  await first;
  const original = lastHistoryView(messages);
  assert.equal(original.status, 'ok');
  assert.deepEqual(original.entries, ['multi\nline', 'echo  trailing  ']);
  assert.deepEqual(session.recentCommands, ['echo  trailing  ', 'multi\nline']);
  assert.deepEqual(session.completionRecentCommands, ['echo  trailing  ']);
  const second = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[1]!, ['new only'], 'partial', 'project_history');
  await second;
  const changed = lastHistoryView(messages);
  assert.equal(changed.status, 'partial');
  assert.notEqual(changed.source?.id, original.source?.id);
  assert.deepEqual(changed.entries, ['new only']);
  const third = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[2]!, [], 'private', null);
  await third;
  assert.deepEqual(lastHistoryView(messages), { status: 'private', source: null, entries: [] });
  assert.deepEqual(session.recentCommands, []);
  assert.ok(commands.every((command) => !command.includes('multi') && !command.includes('trailing')));
});

test('Bash and Zsh publish their actual native source under history-only permission', async (t) => {
  for (const shell of ['bash', 'zsh'] as const) {
    const { session, service, channels, messages } = createHistoryServiceHarness(t);
    t.after(() => service.clearRemoteHistory(session));
    session.remoteEnhancementsRuntimeContract!.shell = shell;
    session.shellContext = {
      ...session.shellContext,
      shell,
      permissions: { input: false, cwd: false, paths: false, nativeCompletion: false, history: true },
      editorBinding: {
        ...session.shellContext.editorBinding!,
        notification: shell === 'bash' ? { callback: 'readline' } : { fd: 13, inode: '100' },
      },
    };
    const pending = service.syncRemoteHistory(session.sessionId);
    await Promise.resolve();
    assert.equal(channels.length, 1);
    assert.equal(channels[0].request.target.shell, shell);
    assert.equal(channels[0].request.includeDirectory, false);
    completeHistory(channels[0], ['echo native 中🐟  '], 'ok', 'opaque-native-source');
    await pending;
    const view = lastHistoryView(messages);
    assert.equal(view.source?.shell, shell);
    assert.deepEqual(view.entries, ['echo native 中🐟  ']);
    service.applyEnhancementSettings({
      revision: 1,
      values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsHistoryEnabled: false },
    });
    assert.deepEqual(lastHistoryView(messages), { status: 'disabled', source: null, entries: [] });
    await service.syncRemoteHistory(session.sessionId);
    assert.equal(channels.length, 1);
  }
});

test('known native removal limitations preserve the record and report an explicit unsupported result', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const read = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0], ['echo keep']);
  await read;
  const sourceId = lastHistoryView(messages).source!.id;
  const removal = service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo keep'));
  await Promise.resolve();
  assert.equal(channels[1].request.operation, 'history-delete');
  channels[1].reply({ phase: 'ready' });
  channels[1].reply({ phase: 'done', status: 'unsupported' });
  await removal;
  assert.deepEqual(lastHistoryView(messages).entries, ['echo keep']);
  assert.deepEqual(messages.filter((message) => message.type === 'shell-history-remove-result').at(-1), {
    type: 'shell-history-remove-result',
    requestId: 'remove-1',
    sourceId,
    status: 'unsupported',
  });
});

test('revocation clears queued and active native work, including an SSH callback delivered after cancellation', async (t) => {
  for (const openImmediately of [true, false]) {
    const { session, service, channels, messages } = createHistoryServiceHarness(t, openImmediately);
    t.after(() => service.clearRemoteHistory(session));
    session.historyView = {
      status: 'ok',
      source: { id: 'old', shell: 'fish', namespace: 'fish' },
      entries: ['echo cached'],
    };
    session.historyOwnerInstanceId = 'shell-1';
    session.recentCommands = ['echo cached'];
    session.completionRecentCommands = ['echo cached'];
    service.scheduleHistorySync(session.sessionId);
    assert.ok(session.historySyncTimeout);
    const pending = service.syncRemoteHistory(session.sessionId);
    await Promise.resolve();
    const lifetime = session.historyAbortController!.signal;
    service.applyEnhancementSettings({
      revision: 1,
      values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsHistoryEnabled: false },
    });
    if (!openImmediately) channels[0]!.open();
    await pending;
    assert.equal(lifetime.aborted, true);
    assert.equal(channels[0]!.closed, true);
    assert.deepEqual(lastHistoryView(messages), { status: 'disabled', source: null, entries: [] });
    assert.deepEqual(session.recentCommands, []);
    assert.deepEqual(session.completionRecentCommands, []);
    assert.equal(session.historySyncTimeout, null);
  }
});

test('off-on permission races cannot publish the old reply and eventually refresh the new lifetime', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const old = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  const oldSignal = session.historyAbortController!.signal;
  channels[0]!.reply({ phase: 'ready' });
  service.applyEnhancementSettings({
    revision: 1,
    values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsHistoryEnabled: false },
  });
  service.applyEnhancementSettings({ revision: 2, values: DEFAULT_SETTINGS_VALUES });
  await old;
  assert.equal(oldSignal.aborted, true);
  assert.equal(JSON.stringify(messages).includes('PRIVATE_OLD_RESPONSE'), false);
  if (session.historySyncTimeout) clearTimeout(session.historySyncTimeout);
  session.historySyncTimeout = null;
  const fresh = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  assert.notEqual(session.historyAbortController!.signal, oldSignal);
  completeHistory(channels.at(-1)!, ['echo fresh']);
  await fresh;
  assert.deepEqual(lastHistoryView(messages).entries, ['echo fresh']);
});

test('hiding suggestions retains native reads while renderer completion respects display permission', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const pending = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  const signal = session.historyAbortController!.signal;
  service.applyEnhancementSettings({
    revision: 1,
    values: { ...DEFAULT_SETTINGS_VALUES, terminalAutoCompleteHistoryEnabled: false },
  });
  assert.equal(signal.aborted, false);
  completeHistory(channels[0]!, ['echo retained']);
  await pending;
  session.shellContext = { ...session.shellContext, status: 'ready', reason: null };
  const request = {
    type: 'completion-request' as const,
    requestId: 'display-only',
    linePrefix: 'echo',
    cursorIndex: 4,
    includeHistory: true,
    includeBuiltInCommands: false,
    includePathSuggestions: false,
    trigger: 'manual' as const,
  };
  await service.handleCompletionRequest(session, request);
  const hidden = messages.at(-1);
  assert.ok(hidden?.type === 'completion-response');
  assert.deepEqual(hidden.items, []);
  service.applyEnhancementSettings({ revision: 2, values: DEFAULT_SETTINGS_VALUES });
  await service.handleCompletionRequest(session, request);
  const visible = messages.at(-1);
  assert.ok(visible?.type === 'completion-response');
  assert.ok(visible.items.some((item) => item.source === 'history'));
});

test('stale IDs and exact records cannot authorize deletion; legacy deletion is ignored', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const read = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['echo exact', 'echo other']);
  await read;
  const sourceId = lastHistoryView(messages).source!.id;
  await service.deleteRemoteHistoryEntry(session, removalRequest('old-source', 'echo exact'));
  await service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo changed'));
  assert.equal(channels.length, 1);
  assert.deepEqual(
    messages.filter((message) => message.type === 'shell-history-remove-result').map((message) => message.status),
    ['stale', 'stale'],
  );
  service.handleClientMessage(session, Buffer.from(JSON.stringify({ type: 'history-delete', command: 'echo exact' })));
  assert.equal(channels.length, 1);
  assert.deepEqual(lastHistoryView(messages).entries, ['echo exact', 'echo other']);
});

test('exact native deletion requires a prepared match and reports current-reader removal only', async (t) => {
  const { session, service, channels, messages, commands } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const read = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['echo exact', 'echo other', 'echo exact']);
  await read;
  const sourceId = lastHistoryView(messages).source!.id;
  const pending = service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo exact'));
  await Promise.resolve();
  const channel = channels[1]!;
  assert.equal(channel.request.operation, 'history-delete');
  assert.equal(channel.request.expected?.history?.namespace, 'fish');
  assert.deepEqual(channel.request.expected?.history?.entries, ['echo exact']);
  channel.reply({ phase: 'ready' });
  channel.reply({ phase: 'prepared', snapshot: channel.request.expected });
  await Promise.resolve();
  assert.ok(channel.writes.some((value) => value.includes('"apply":true')));
  channel.reply({ phase: 'done', status: 'history-removed-from-reader', applied: true });
  await pending;
  assert.equal(messages.at(-1)?.type, 'shell-history-remove-result');
  assert.deepEqual(messages.at(-1), {
    type: 'shell-history-remove-result',
    requestId: 'remove-1',
    sourceId,
    status: 'removed-from-reader',
  });
  assert.deepEqual(lastHistoryView(messages).entries, ['echo other']);
  assert.ok(commands.every((command) => !command.includes('echo exact')));
});

test('deletion fails closed for a changed native snapshot and leaves the displayed record', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const read = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['echo exact']);
  await read;
  const sourceId = lastHistoryView(messages).source!.id;
  const pending = service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo exact'));
  await Promise.resolve();
  channels[1]!.reply({ phase: 'ready' });
  channels[1]!.reply({
    phase: 'prepared',
    snapshot: {
      ...channels[1]!.request.expected,
      history: { status: 'ok', namespace: 'different', entries: ['echo exact'] },
    },
  });
  await pending;
  assert.ok(channels[1]!.writes.every((value) => !value.includes('"apply":true')));
  assert.deepEqual(lastHistoryView(messages).entries, ['echo exact']);
  assert.deepEqual(messages.at(-1), {
    type: 'shell-history-remove-result',
    requestId: 'remove-1',
    sourceId,
    status: 'stale',
  });
});

test('read/delete competition and uncertain deletion never fabricate a removed result', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const initial = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['echo exact']);
  await initial;
  const sourceId = lastHistoryView(messages).source!.id;
  const reading = service.syncRemoteHistory(session.sessionId);
  await service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo exact'));
  assert.equal(channels.length, 2, 'delete while reading cannot execute');
  const blocked = messages.at(-1);
  assert.ok(blocked?.type === 'shell-history-remove-result');
  assert.equal(blocked.status, 'unavailable');
  completeHistory(channels[1]!, ['echo exact']);
  await reading;
  const deleting = service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo exact'));
  await Promise.resolve();
  channels[2]!.reply({ phase: 'ready' });
  channels[2]!.reply({ phase: 'prepared', snapshot: channels[2]!.request.expected });
  await Promise.resolve();
  assert.ok(channels[2]!.writes.some((value) => value.includes('"apply":true')));
  channels[2]!.close();
  await deleting;
  const uncertain = messages.at(-1);
  assert.ok(uncertain?.type === 'shell-history-remove-result');
  assert.equal(uncertain.status, 'unknown');
  assert.deepEqual(lastHistoryView(messages).entries, ['echo exact']);
});

test('history waits for an active private editor exchange and then reads the current binding', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  session.shellContext = {
    ...session.shellContext,
    status: 'ready',
    reason: null,
    requiresEditorConfirmation: false,
    capabilities: [...session.shellContext.capabilities, 'input-snapshot'],
  };
  const editor = service.handleEditorRequest(session, {
    type: 'editor-snapshot',
    requestId: '01234567-89ab-4def-8123-456789abcdef',
  });
  await Promise.resolve();
  assert.equal(channels[0]!.request.operation, 'snapshot');
  const history = service.syncRemoteHistory(session.sessionId);
  assert.equal(channels.length, 1, 'history waits until the editor channel releases its binding');
  channels[0]!.reply({ phase: 'ready' });
  channels[0]!.reply({
    phase: 'done',
    status: 'ok',
    snapshot: { promptGeneration: 1, editorMode: 'emacs', buffer: { text: 'private input', cursor: 0 } },
  });
  await editor;
  await Promise.resolve();
  assert.equal(channels[1]!.request.operation, 'history');
  completeHistory(channels[1]!, ['echo after editor']);
  await history;
  assert.deepEqual(lastHistoryView(messages).entries, ['echo after editor']);
  assert.equal(
    JSON.stringify(messages.filter((item) => item.type === 'shell-history')).includes('private input'),
    false,
  );
});

test('stale editor-state cannot clear a current Fish source or abort its permission lifetime', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const read = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['echo current']);
  await read;
  const view = lastHistoryView(messages);
  const signal = session.historyAbortController!.signal;
  service.handleRemoteShellEvent(
    session,
    fishHistoryEvent({
      event: 'editor-state',
      promptGeneration: 0,
      available: false,
      pid: 42,
      startTime: '100',
      triggerNonce: 'abcdef01-2345-6789-abcd-ef0123456789',
      notification: { signal: 'URG' },
    }),
  );
  assert.deepEqual(lastHistoryView(messages), view);
  assert.equal(session.historyAbortController!.signal, signal);
  assert.equal(signal.aborted, false);
});

test('permission re-enable during cancelled deletion schedules the new history lifetime', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  const initial = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[0]!, ['echo old']);
  await initial;
  const sourceId = lastHistoryView(messages).source!.id;
  const deleting = service.deleteRemoteHistoryEntry(session, removalRequest(sourceId, 'echo old'));
  await Promise.resolve();
  assert.equal(channels[1]!.request.operation, 'history-delete');
  service.applyEnhancementSettings({
    revision: 1,
    values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsHistoryEnabled: false },
  });
  service.applyEnhancementSettings({ revision: 2, values: DEFAULT_SETTINGS_VALUES });
  await service.syncRemoteHistory(session.sessionId);
  assert.equal(session.historySyncPending, true);
  await deleting;
  assert.ok(session.historySyncTimeout, 'the new lifetime receives a refresh after old deletion cleanup');
  clearTimeout(session.historySyncTimeout);
  session.historySyncTimeout = null;
  const fresh = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  completeHistory(channels[2]!, ['echo new']);
  await fresh;
  assert.deepEqual(lastHistoryView(messages).entries, ['echo new']);
  assert.notEqual(lastHistoryView(messages).source?.id, sourceId);
});

test('disconnect closes active native history before session transport', async (t) => {
  const { session, service, channels, messages } = createHistoryServiceHarness(t);
  t.after(() => service.clearRemoteHistory(session));
  let transportClosed = false;
  session.stream.on('close', () => {
    assert.equal(channels[0]!.closed, true);
    transportClosed = true;
  });
  const pending = service.syncRemoteHistory(session.sessionId);
  await Promise.resolve();
  service.disposeSession(session.sessionId, 'ws.clientRequestedClose');
  await pending;
  assert.equal(transportClosed, true);
  assert.equal(session.disposed, true);
  assert.equal(service.sessions.has(session.sessionId), false);
  assert.deepEqual(session.recentCommands, []);
  assert.equal(JSON.stringify(messages).includes('PRIVATE_LATE_CLOSE'), false);
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
