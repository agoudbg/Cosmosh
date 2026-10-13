import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalTerminalSessionService } from '../local-terminal/session-service.js';
import { SshSessionService } from '../ssh/session-service.js';
import type { CompletionPromptState } from './completion/runtime-state.js';
import { normalizeTerminalClientMessage } from './shared.js';

/** Transport boundary used without starting a real SSH or local PTY session. */
type InputTransport = { write(data: string | Buffer): void };

/** Session fields read or written by the production terminal input handlers. */
type InputSession = {
  sessionId: string;
  stream: InputTransport;
  pty: InputTransport;
  t(key: string): string;
  completionLineBuffer: string;
  completionRecentCommands: string[];
  completionWorkingDirectory: string;
  completionHomeDirectory: string;
  completionPendingCwdCommands: string[];
  completionPromptState: CompletionPromptState;
  remoteEnhancementsRuntimeState: 'disabled';
  remoteEnhancementsRuntimeContract: null;
  commandCount: number;
};

/** External response and scheduling boundaries used by the input handlers. */
type InputServiceContext = {
  sendServerMessage(session: InputSession, message: { type: 'error'; message: string }): void;
  scheduleHistorySync(sessionId: string): void;
};

/** Protected service entry point invoked directly, following existing service tests. */
type InputServiceHarness = {
  handleClientMessage(this: InputServiceContext, session: InputSession, payload: Buffer): void;
};

/** Records the exact transport bytes and externally visible input side effects. */
type InputHarness = {
  session: InputSession;
  context: InputServiceContext;
  writes: { transport: 'ssh' | 'local'; data: string | Buffer }[];
  errors: string[];
  historySyncSessionIds: string[];
};

/**
 * Creates input state and transport recorders without running service constructors.
 *
 * @returns Harness for both production session handlers.
 */
const createInputHarness = (): InputHarness => {
  const writes: InputHarness['writes'] = [];
  const errors: string[] = [];
  const historySyncSessionIds: string[] = [];
  const session: InputSession = {
    sessionId: 'input-test-session',
    stream: { write: (data) => writes.push({ transport: 'ssh', data }) },
    pty: { write: (data) => writes.push({ transport: 'local', data }) },
    t: (key) => key,
    completionLineBuffer: 'keep',
    completionRecentCommands: ['previous'],
    completionWorkingDirectory: '/home/test',
    completionHomeDirectory: '/home/test',
    completionPendingCwdCommands: ['pending'],
    completionPromptState: { outputTail: 'Password:', promptDetectedAtMs: 1, shouldSuggestSecret: true },
    remoteEnhancementsRuntimeState: 'disabled',
    remoteEnhancementsRuntimeContract: null,
    commandCount: 7,
  };
  return {
    session,
    writes,
    errors,
    historySyncSessionIds,
    context: {
      sendServerMessage: (_session, message) => errors.push(message.message),
      scheduleHistorySync: (sessionId) => historySyncSessionIds.push(sessionId),
    },
  };
};

/**
 * Copies command bookkeeping so in-place mutations cannot hide regressions.
 *
 * @param session Session whose bookkeeping is observed.
 * @returns Independent snapshot excluding transport callbacks.
 */
const readBookkeeping = (session: InputSession) => {
  return structuredClone({
    lineBuffer: session.completionLineBuffer,
    recentCommands: session.completionRecentCommands,
    cwd: session.completionWorkingDirectory,
    home: session.completionHomeDirectory,
    pendingCwdCommands: session.completionPendingCwdCommands,
    promptState: session.completionPromptState,
    commandCount: session.commandCount,
  });
};

/**
 * Encodes trusted or deliberately malformed test messages as real WebSocket JSON.
 *
 * @param message JSON-compatible input payload.
 * @returns Raw UTF-8 WebSocket payload accepted by the production normalizer.
 */
const encodeMessage = (message: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify(message));

const ALL_INPUT_BYTES = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const INVALID_BINARY_MESSAGES: Record<string, unknown>[] = [
  ...[null, 'utf8', 'base64', 1, true, {}, []].map((encoding) => ({ type: 'input', data: 'text', encoding })),
  ...[undefined, null, 42, {}, [], '\u0100', 'prefix\ud800', '\udfff', '报告', '😀'].map((data) => ({
    type: 'input',
    data,
    encoding: 'binary',
  })),
];

test('terminal input parser preserves every byte through JSON and keeps legacy Unicode text', () => {
  const binaryMessage = { type: 'input', data: ALL_INPUT_BYTES.toString('latin1'), encoding: 'binary' };
  const parsed = normalizeTerminalClientMessage(encodeMessage(binaryMessage));
  assert.deepEqual(parsed, binaryMessage);
  assert.ok(parsed?.type === 'input');
  assert.deepEqual(Buffer.from(parsed.data, 'latin1'), ALL_INPUT_BYTES);

  const textMessage = { type: 'input', data: '报告😀\r' };
  assert.deepEqual(normalizeTerminalClientMessage(encodeMessage(textMessage)), textMessage);
});

test('terminal input parser rejects invalid encodings and non-byte binary strings', () => {
  for (const message of INVALID_BINARY_MESSAGES) {
    assert.equal(normalizeTerminalClientMessage(encodeMessage(message)), null, JSON.stringify(message));
  }
});

const SERVICES = [
  { name: 'SSH', transport: 'ssh', prototype: SshSessionService.prototype as unknown as InputServiceHarness },
  {
    name: 'local',
    transport: 'local',
    prototype: LocalTerminalSessionService.prototype as unknown as InputServiceHarness,
  },
] as const;

for (const service of SERVICES) {
  test(`${service.name} binary input preserves all bytes without changing command bookkeeping`, () => {
    const harness = createInputHarness();
    const previousBookkeeping = readBookkeeping(harness.session);
    service.prototype.handleClientMessage.call(
      harness.context,
      harness.session,
      encodeMessage({ type: 'input', data: ALL_INPUT_BYTES.toString('latin1'), encoding: 'binary' }),
    );

    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].transport, service.transport);
    assert.ok(Buffer.isBuffer(harness.writes[0].data));
    assert.deepEqual(harness.writes[0].data, ALL_INPUT_BYTES);
    assert.deepEqual(readBookkeeping(harness.session), previousBookkeeping);
    assert.deepEqual(harness.historySyncSessionIds, []);
    assert.deepEqual(harness.errors, []);
  });

  test(`${service.name} rejects malformed binary input before transport writes or bookkeeping`, () => {
    for (const message of INVALID_BINARY_MESSAGES) {
      const harness = createInputHarness();
      const previousBookkeeping = readBookkeeping(harness.session);
      service.prototype.handleClientMessage.call(harness.context, harness.session, encodeMessage(message));

      assert.deepEqual(harness.writes, [], JSON.stringify(message));
      assert.deepEqual(harness.errors, ['ws.invalidWebsocketMessageFormat']);
      assert.deepEqual(harness.historySyncSessionIds, []);
      assert.deepEqual(readBookkeeping(harness.session), previousBookkeeping);
    }
  });

  test(`${service.name} legacy Unicode input and carriage return retain normal command handling`, () => {
    const harness = createInputHarness();
    for (const data of ['报告😀', '\r']) {
      service.prototype.handleClientMessage.call(
        harness.context,
        harness.session,
        encodeMessage({ type: 'input', data }),
      );
    }

    assert.deepEqual(harness.writes, [
      { transport: service.transport, data: '报告😀' },
      { transport: service.transport, data: '\r' },
    ]);
    assert.equal(harness.session.completionLineBuffer, '');
    assert.deepEqual(harness.session.completionRecentCommands, ['keep报告😀', 'previous']);
    assert.equal(harness.session.completionPromptState.shouldSuggestSecret, false);
    assert.deepEqual(harness.historySyncSessionIds, [harness.session.sessionId]);
    assert.equal(harness.session.commandCount, service.transport === 'ssh' ? 8 : 7);
    assert.deepEqual(harness.errors, []);
  });
}
