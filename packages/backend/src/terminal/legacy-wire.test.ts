import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { TerminalServerMessage } from '@cosmosh/api-contract';

import { LocalTerminalSessionService } from '../local-terminal/session-service.js';
import { SshSessionService } from '../ssh/session-service.js';
import { normalizeTerminalClientMessage } from './shared.js';

/** Explicit PTY, process and WebSocket boundaries; all message normalization and routing remain real. */
type WireSession = {
  sessionId: string;
  socket: { OPEN: number; readyState: number; send(payload: string): void };
  disposed: boolean;
  t(key: string): string;
  pty: { write(data: string): void };
  stream: { write(data: string): void };
  client: { exec(): never };
  telemetryInterval: NodeJS.Timeout | null;
  historySyncTimeout: NodeJS.Timeout | null;
};

/** Protected service entry points exposed only to exercise the real normalized wire. */
type WireService = {
  handleClientMessage(session: WireSession, payload: Buffer): void;
  startSessionTelemetry(sessionId: string): void;
};

/** @param prototype Real production receiver. @returns A connected session with isolated external I/O. */
const harness = (prototype: object) => {
  const messages: TerminalServerMessage[] = [];
  const writes: string[] = [];
  const pty = {
    write: (data: string): void => {
      writes.push(data);
    },
  };
  const session: WireSession = {
    sessionId: 'wire-test',
    disposed: false,
    t: (key) => key,
    pty,
    stream: pty,
    client: { exec: () => assert.fail('rejected or unsupported public actions must not execute SSH commands') },
    socket: { OPEN: 1, readyState: 1, send: (payload) => messages.push(JSON.parse(payload) as TerminalServerMessage) },
    telemetryInterval: null,
    historySyncTimeout: null,
  };
  const service = Object.assign(Object.create(prototype) as WireService, {
    sessions: new Map([[session.sessionId, session]]),
  });
  return {
    session,
    service,
    messages,
    writes,
    send: (message: object): void => service.handleClientMessage(session, Buffer.from(JSON.stringify(message))),
  };
};

test('removed guessed-input, raw replacement and unbound history wires reject at both real service boundaries', () => {
  const id = randomUUID();
  const legacy = [
    {
      type: 'completion-request',
      requestId: id,
      linePrefix: 'PRIVATE_INPUT',
      cursorIndex: 13,
      workingDirectoryHint: '/private',
      trigger: 'manual',
    },
    { type: 'editor-snapshot', requestId: id },
    { type: 'editor-apply', requestId: id, snapshotId: id, replacement: { text: 'echo private', cursor: 12 } },
    { type: 'history-delete', command: 'PRIVATE_HISTORY' },
  ];
  for (const prototype of [SshSessionService.prototype, LocalTerminalSessionService.prototype]) {
    const h = harness(prototype);
    for (const message of legacy) {
      assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify(message))), null);
      h.send(message);
    }
    assert.equal(h.messages.length, legacy.length);
    assert.ok(h.messages.every((message) => message.type === 'error'));
    assert.equal(JSON.stringify(h.messages).includes('PRIVATE_'), false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.session.disposed, false);
  }
});

test('local snapshot completion stays explicitly unavailable while native keys and ordinary input pass unchanged', (t) => {
  const h = harness(LocalTerminalSessionService.prototype);
  t.after(() => {
    if (h.session.telemetryInterval) clearInterval(h.session.telemetryInterval);
  });
  const requestId = randomUUID();
  h.send({ type: 'completion-query', requestId, trigger: 'manual' });
  h.send({ type: 'completion-accept', requestId: randomUUID(), snapshotId: randomUUID(), candidateId: randomUUID() });
  h.send({ type: 'directory-query', requestId: randomUUID() });
  h.send({ type: 'completion-cancel', requestId });
  h.send({ type: 'directory-cancel', requestId });
  assert.deepEqual(
    h.messages.map((message) => ('status' in message ? message.status : message.type)),
    ['unavailable', 'unavailable', 'unavailable'],
  );
  for (const data of ['cat ./', '\t', '\x1b[Z', '\x12', 'PRIVATE_PASSWORD', '\r\n']) h.send({ type: 'input', data });
  assert.deepEqual(h.writes, ['cat ./', '\t', '\x1b[Z', '\x12', 'PRIVATE_PASSWORD', '\r\n']);
  assert.equal(h.session.historySyncTimeout, null);
  h.service.startSessionTelemetry(h.session.sessionId);
  assert.ok(h.session.telemetryInterval);
  assert.equal(h.session.historySyncTimeout, null);
  const telemetry = h.messages.at(-1);
  assert.ok(telemetry?.type === 'telemetry');
  assert.deepEqual(telemetry.recentCommands, []);
  assert.equal(JSON.stringify(h.messages).includes('PRIVATE_PASSWORD'), false);
});
