import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteShellCapability, SshTerminalServerMessage } from '@cosmosh/api-contract';

import type { RemoteBootstrapResult, RemoteBootstrapStatus } from '../remote-bootstrap/service.js';
import { AgentTerminalController } from './agent-terminal.js';
import type { OpenSshClientResult } from './connect.js';
import type { RemoteShellEventMessage, RemoteShellEventStreamFrame } from './remote-shell-events.js';
import {
  resolveRemoteEnhancementsSessionGate,
  SshSessionService,
  usesStructuredRemoteCommandLifecycle,
} from './session-service.js';

type RemoteShellEventSessionHarness = {
  sessionId: string;
  remoteEnhancementsRuntimeState: 'pending' | 'active' | 'disabled';
  remoteEnhancementsRuntimeContract: {
    shell: 'bash';
    helperVersion: string;
    protocolVersion: number;
    capabilities: RemoteShellCapability[];
  } | null;
  remoteEnhancementsRuntimeCode: string | null;
  remoteEnhancementsRuntimeMessage: string | null;
  remoteEnhancementsHandshakeTimeout: NodeJS.Timeout | null;
  pendingStreamFrames: RemoteShellEventStreamFrame[];
  pendingStreamFrameBytes: number;
  pendingStreamFrameDropCount: number;
  pendingRemoteBootstrapStatuses: RemoteBootstrapStatus[];
  completionWorkingDirectory: string | null;
  completionPendingCwdCommands: string[];
  remoteShellReady: boolean;
  remoteShellAtPrompt: boolean;
  remoteShellLineLength: number;
  remoteShellCwd: string | null;
  remoteShellForegroundCommand: string | null;
  lastRemoteCommand: string | null;
  lastRemoteCommandId: string | null;
  lastExitCode: number | null;
  lastCommandDurationMs: number | null;
  commandCount: number;
  agentTerminalController: AgentTerminalController;
  socket: {
    OPEN: number;
    readyState: number;
    send(payload: string): void;
  } | null;
  disposed: boolean;
};

type RemoteShellEventServiceHarness = {
  applyRemoteShellEventState(session: RemoteShellEventSessionHarness, event: RemoteShellEventMessage): void;
  disableRemoteEnhancementsRuntime(session: RemoteShellEventSessionHarness, code: string, message: string): void;
  handleRemoteShellEvent(session: RemoteShellEventSessionHarness, event: RemoteShellEventMessage): void;
  onSessionAttached(session: RemoteShellEventSessionHarness): void;
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
  sessionId: 'session-1',
  remoteEnhancementsRuntimeState: 'disabled',
  remoteEnhancementsRuntimeContract: {
    shell: 'bash',
    helperVersion: '1.2.3',
    protocolVersion: 2,
    capabilities: ['cwd', 'command-start', 'command-end', 'foreground-command', 'prompt-ready', 'line-state'],
  },
  remoteEnhancementsRuntimeCode: null,
  remoteEnhancementsRuntimeMessage: null,
  remoteEnhancementsHandshakeTimeout: null,
  pendingStreamFrames: [],
  pendingStreamFrameBytes: 0,
  pendingStreamFrameDropCount: 0,
  pendingRemoteBootstrapStatuses: [],
  completionWorkingDirectory: null,
  completionPendingCwdCommands: [],
  remoteShellReady: false,
  remoteShellAtPrompt: false,
  remoteShellLineLength: 0,
  remoteShellCwd: null,
  remoteShellForegroundCommand: null,
  lastRemoteCommand: null,
  lastRemoteCommandId: null,
  lastExitCode: null,
  lastCommandDurationMs: null,
  commandCount: 0,
  agentTerminalController: new AgentTerminalController({
    onStatusChanged: () => undefined,
  }),
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
    protocolVersion: 2,
    capabilities: ['cwd', 'command-start', 'command-end', 'foreground-command', 'prompt-ready', 'line-state'],
    cwd: '/root',
    timestamp: 1_783_172_312_000,
    ...overrides,
  } as RemoteShellEventMessage;
};

test('session request can disable but cannot override a persisted Remote Enhancements opt-out', () => {
  assert.equal(resolveRemoteEnhancementsSessionGate(true, undefined), true);
  assert.equal(resolveRemoteEnhancementsSessionGate(true, true), true);
  assert.equal(resolveRemoteEnhancementsSessionGate(true, false), false);
  assert.equal(resolveRemoteEnhancementsSessionGate(false, undefined), false);
  assert.equal(resolveRemoteEnhancementsSessionGate(false, true), false);
});

test('structured command lifecycle becomes authoritative only after matching capability activation', () => {
  assert.equal(usesStructuredRemoteCommandLifecycle('pending', ['command-start']), false);
  assert.equal(usesStructuredRemoteCommandLifecycle('disabled', ['command-start']), false);
  assert.equal(usesStructuredRemoteCommandLifecycle('active', ['cwd', 'prompt-ready']), false);
  assert.equal(usesStructuredRemoteCommandLifecycle('active', ['command-start', 'command-end']), true);
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

  assert.equal(session.remoteShellCwd, null);
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
    ['ready', 'remote-enhancement-runtime-status', 'agent-attachment-status', 'output', 'remote-shell-event', 'output'],
  );
  assert.deepEqual(sentMessages.slice(3), [
    { type: 'output', data: '\r\n' },
    transportedCommandStart,
    { type: 'output', data: 'result\r\n' },
  ]);
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
  assert.equal(session.remoteShellCwd, null);

  serviceHarness.handleRemoteShellEvent(
    session,
    createRemoteShellEvent({ event: 'integration-ready', cwd: undefined }),
  );

  assert.equal(session.remoteEnhancementsRuntimeState, 'active');
  assert.equal(session.remoteEnhancementsHandshakeTimeout, null);
  assert.equal(session.remoteShellReady, true);

  serviceHarness.handleRemoteShellEvent(session, createRemoteShellEvent({ cwd: '/home/dev' }));
  assert.equal(session.remoteShellCwd, '/home/dev');
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
    remoteShellCwd: '/tmp',
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
  assert.equal(session.remoteShellCwd, null);
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
