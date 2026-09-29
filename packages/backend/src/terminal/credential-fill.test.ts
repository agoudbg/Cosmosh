import assert from 'node:assert/strict';
import test from 'node:test';

import { createCredentialFillState, isFillableLoginPassword, observeCredentialFillOutput } from './credential-fill.js';
import { createCredentialServiceHarness, type CredentialTestSession } from './integration/credential-harness.js';
import { normalizeTerminalClientMessage } from './shared.js';

test('fragmented password prompts produce an opaque bounded offer, without extending its lifetime', () => {
  let state = observeCredentialFillOutput(createCredentialFillState(), '[sudo] Pass', 1_000);
  assert.equal(state.offer, null);
  state = observeCredentialFillOutput(state, 'word for fixture: ', 1_001);
  assert.ok(state.offer);
  assert.equal(state.offer.expiresAt, 46_001);
  assert.equal(observeCredentialFillOutput(state, '\x1b[0m ', 46_002).offer, state.offer);
  assert.equal(observeCredentialFillOutput(state, '\r\nDone\r\n$ ', 1_002).offer, null);
  assert.equal(
    observeCredentialFillOutput(createCredentialFillState(), 'Enter passphrase for key fixture: ', 1).offer,
    null,
  );
  assert.ok(observeCredentialFillOutput(createCredentialFillState(), 'x'.repeat(5_000), 1).outputTail.length <= 1_024);
});

test('credential fill rejects control characters and oversized values while preserving literal Unicode and spaces', () => {
  for (const password of [null, '', 'one\ntwo', 'one\rtwo', '\x03', '\x1b', '\t', '\u009b', 'x'.repeat(8_193)]) {
    assert.equal(isFillableLoginPassword(password), false);
  }
  assert.equal(isFillableLoginPassword('  口令 🔑 "\\$  '), true);
});

test('erase and cursor movement cannot reissue offers from hidden prompt text', () => {
  for (const output of ['\x1b[2K', '\x1b[2J', '\x1b[H', '\x1b[1A', '\b', '\x1b[2KPassword: ']) {
    const initial = observeCredentialFillOutput(createCredentialFillState(), 'Password: ', 1);
    const cleared = observeCredentialFillOutput(initial, output, 2);
    assert.deepEqual(cleared, createCredentialFillState());
    assert.equal(observeCredentialFillOutput(cleared, ' ', 3).offer, null);
    assert.ok(observeCredentialFillOutput(cleared, 'Password: ', 3).offer);
  }
});

test('the real Bash password transition survives every bracketed-paste control chunk boundary', () => {
  const output = '\r\n\x1b[?2004l\rPassword: ';
  for (let split = 0; split <= output.length; split += 1) {
    const old = observeCredentialFillOutput(createCredentialFillState(), 'Password: ', 1);
    const first = observeCredentialFillOutput(old, output.slice(0, split), 2);
    const next = observeCredentialFillOutput(first, output.slice(split), 3);
    assert.ok(next.offer, 'missing prompt at split ' + split);
    assert.notEqual(next.offer.token, old.offer!.token);
    assert.equal(next.outputTail.split('\n').at(-1), 'Password: ');
    assert.equal(next.pendingControl, undefined);
  }
  let state = createCredentialFillState();
  for (const char of output) state = observeCredentialFillOutput(state, char, 10);
  assert.ok(state.offer);
});

test('complete nonvisual mode switches preserve expiry but a new carriage return invalidates the old offer', () => {
  const initial = observeCredentialFillOutput(createCredentialFillState(), 'Password: ', 1);
  for (const control of ['\x1b[?2004h', '\x1b[?2004l', '\x1b[0m\x1b[?2004l ']) {
    assert.equal(observeCredentialFillOutput(initial, control, 50_000).offer, initial.offer);
    assert.equal(observeCredentialFillOutput(initial, control + '\r', 50_001).offer, null);
    const fresh = observeCredentialFillOutput(initial, control + '\rPassword: ', 50_002);
    assert.ok(fresh.offer);
    assert.notEqual(fresh.offer.token, initial.offer!.token);
    assert.equal(fresh.offer.expiresAt, 95_002);
    assert.equal(observeCredentialFillOutput(initial, control + '\x1b[2KPassword: ', 50_003).offer, null);
  }
});

test('a fragmented CSI cannot present its consumed final character as visible password text', () => {
  const initial = observeCredentialFillOutput(createCredentialFillState(), 'Password: ', 1);
  for (const prefix of ['\x1b[', '\x1b[12;', '\u009b']) {
    const pending = observeCredentialFillOutput(initial, prefix, 2);
    assert.equal(pending.offer, null);
    assert.equal(pending.outputTail, '');
    assert.ok(pending.pendingControl);
    // P finishes a delete-character control; the actual visible suffix is only "assword: ".
    const suffix = observeCredentialFillOutput(pending, 'Password: ', 3);
    assert.equal(suffix.offer, null);
    assert.equal(observeCredentialFillOutput(suffix, ' ', 4).offer, null);
    assert.ok(observeCredentialFillOutput(suffix, '\r\nPassword: ', 5).offer);
  }
  const partial = observeCredentialFillOutput(initial, '\x1b[3', 2);
  assert.ok(observeCredentialFillOutput(partial, '1mPassword: ', 3).offer);
  const lostPrefix = observeCredentialFillOutput(createCredentialFillState(), 'Pass\x1b[3', 2);
  assert.equal(observeCredentialFillOutput(lostPrefix, '1mword: ', 3).offer, null);
});

test('fragmented control-string payloads and their embedded newlines never become password prompts', () => {
  for (const [start, end] of [
    ['\x1b]', '\x07'],
    ['\x1b]', '\x1b\\'],
    ['\x1bP', '\x1b\\'],
    ['\x1bX', '\x1b\\'],
    ['\x1b^', '\x1b\\'],
    ['\x1b_', '\x1b\\'],
    ['\u009d', '\u009c'],
    ['\u0090', '\u009c'],
  ]) {
    const hidden = start + '0;\r\nPassword: ';
    for (let split = 0; split <= hidden.length; split += 1) {
      let state = observeCredentialFillOutput(createCredentialFillState(), hidden.slice(0, split), 1);
      state = observeCredentialFillOutput(state, hidden.slice(split), 2);
      assert.equal(state.offer, null);
      assert.equal(state.outputTail, '');
      assert.ok((state.pendingControl?.length ?? 0) <= 64);
      state = observeCredentialFillOutput(state, end + 'Password: ', 3);
      assert.equal(state.offer, null);
      assert.ok(observeCredentialFillOutput(state, '\r\nPassword: ', 4).offer);
    }
  }
});

test('oversized and canceled controls keep only bounded framing and cannot reuse an old prompt', () => {
  const initial = observeCredentialFillOutput(createCredentialFillState(), 'Password: ', 1);
  let csi = observeCredentialFillOutput(initial, '\x1b[' + '1'.repeat(8_192), 2);
  assert.equal(csi.offer, null);
  assert.ok((csi.pendingControl?.length ?? 0) <= 64);
  csi = observeCredentialFillOutput(csi, 'mPassword: ', 3);
  assert.equal(csi.offer, null);
  assert.ok(observeCredentialFillOutput(csi, '\r\nPassword: ', 4).offer);
  for (const cancel of ['\x18', '\x1a']) {
    const string = observeCredentialFillOutput(initial, '\x1b]0;' + 'x'.repeat(8_192), 2);
    assert.equal(string.pendingControl, '\x1b]');
    const cleared = observeCredentialFillOutput(string, cancel + 'Password: ', 3);
    assert.deepEqual(cleared, createCredentialFillState());
    assert.ok(observeCredentialFillOutput(cleared, '\r\nPassword: ', 4).offer);
  }
});

test('credential request normalization accepts only a bounded opaque token', () => {
  assert.deepEqual(
    normalizeTerminalClientMessage(
      Buffer.from(
        JSON.stringify({
          type: 'credential-fill',
          token: 'opaque',
          password: 'must-not-be-forwarded',
        }),
      ),
    ),
    { type: 'credential-fill', token: 'opaque' },
  );
  for (const token of ['', 'x'.repeat(129), {}, 1, null]) {
    assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ type: 'credential-fill', token }))), null);
  }
});

test('input between output-control fragments invalidates offers without exposing the unfinished payload', () => {
  for (const [prefix, suffix, terminator] of [
    ['\x1b[', 'Password: ', ''],
    ['\x1b]0;', '\r\nPassword: ', '\x07'],
    ['\x1bP', '\r\nPassword: ', '\x1b\\'],
  ]) {
    const harness = createCredentialServiceHarness();
    harness.service.handleVisibleShellOutput(harness.session, prefix);
    const framing = harness.session.credentialFillState.pendingControl;
    assert.ok(framing);
    harness.service.handleClientMessage(harness.session, Buffer.from(JSON.stringify({ type: 'input', data: 'x' })));
    assert.equal(harness.session.credentialFillState.pendingControl, framing);
    assert.equal(harness.session.credentialFillState.offer, null);
    assert.deepEqual(harness.writes, ['x']);
    harness.service.handleVisibleShellOutput(harness.session, suffix);
    assert.equal(harness.session.credentialFillState.offer, null);
    if (terminator) harness.service.handleVisibleShellOutput(harness.session, terminator);
    harness.service.handleVisibleShellOutput(harness.session, '\r\nPassword: ');
    assert.ok(harness.session.credentialFillState.offer);
  }
});

test('same-stream reset preserves only unfinished framing while a new stream starts empty', () => {
  const previous = observeCredentialFillOutput(createCredentialFillState(), '\x1b[?2004', 1);
  const reset = createCredentialFillState(previous);
  assert.equal(reset.outputTail, '');
  assert.equal(reset.offer, null);
  assert.equal(reset.pendingControl, previous.pendingControl);
  assert.ok(observeCredentialFillOutput(reset, 'l\rPassword: ', 2).offer);
  assert.equal(createCredentialFillState().pendingControl, undefined);
});

test('the production action fills exactly once without Enter or secrets in WebSocket messages', async () => {
  const harness = createCredentialServiceHarness();
  const token = harness.session.credentialFillState.offer!.token;
  await Promise.all([
    harness.service.fillLoginPassword(harness.session, token),
    harness.service.fillLoginPassword(harness.session, token),
  ]);
  assert.deepEqual(harness.writes, [harness.session.loginPassword]);
  assert.equal(harness.session.credentialFillState.offer, null);
  assert.equal(
    harness.sent.filter((message) => message.type === 'credential-fill-result' && message.status === 'filled').length,
    1,
  );
  assert.ok(!JSON.stringify(harness.sent).includes(harness.session.loginPassword!));
});

test('real output transitions invalidate a pending fill even when the next prompt also requests a password', async () => {
  for (const output of [
    '\r\nPassword for another-user: ',
    '\r\nPassword: ',
    '\x1b[2K\rPassword: ',
    '\r\n\x1b[?2004l\rPassword: ',
  ]) {
    let release!: (rows: Array<{ payloadJson: string }>) => void;
    const harness = createCredentialServiceHarness({
      readSettings: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const oldToken = harness.session.credentialFillState.offer!.token;
    const pending = harness.service.fillLoginPassword(harness.session, oldToken);
    harness.service.handleVisibleShellOutput(harness.session, output);
    assert.notEqual(harness.session.credentialFillState.offer?.token, oldToken);
    release([]);
    await pending;
    assert.deepEqual(harness.writes, []);
    assert.ok(
      harness.sent.some(
        (message) =>
          message.type === 'credential-fill-result' && message.status === 'rejected' && message.reason === 'stale',
      ),
    );
  }
});

test('current settings permission and missing/control-containing passwords prevent filling', async () => {
  const disabled = createCredentialServiceHarness({
    readSettings: async () => [{ payloadJson: JSON.stringify({ terminalAutoCompletePasswordEnabled: false }) }],
  });
  await disabled.service.fillLoginPassword(disabled.session, disabled.session.credentialFillState.offer!.token);
  assert.deepEqual(disabled.writes, []);
  assert.ok(
    disabled.sent.some(
      (message) =>
        message.type === 'credential-fill-result' && message.status === 'rejected' && message.reason === 'disabled',
    ),
  );
  for (const password of [null, 'value\n']) {
    const harness = createCredentialServiceHarness({ password });
    await harness.service.fillLoginPassword(harness.session, harness.session.credentialFillState.offer!.token);
    assert.deepEqual(harness.writes, []);
  }
});

test('input arriving while permission is loading invalidates the prompt before any password write', async () => {
  let release!: (rows: Array<{ payloadJson: string }>) => void;
  const harness = createCredentialServiceHarness({
    readSettings: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const fill = harness.service.fillLoginPassword(harness.session, harness.session.credentialFillState.offer!.token);
  harness.service.handleClientMessage(harness.session, Buffer.from(JSON.stringify({ type: 'input', data: 'x' })));
  release([]);
  await fill;
  assert.deepEqual(harness.writes, ['x']);
  assert.equal(harness.session.credentialFillState.offer, null);
  assert.ok(!JSON.stringify(harness.sent).includes(harness.session.loginPassword!));
});

const staleTransitions: Array<[string, (session: CredentialTestSession) => void]> = [
  [
    'disposed session',
    (session) => {
      session.disposed = true;
    },
  ],
  [
    'changed socket',
    (session) => {
      session.socket = { OPEN: 1, readyState: 1 };
    },
  ],
  [
    'closed socket',
    (session) => {
      session.socket!.readyState = 3;
    },
  ],
  [
    'closed stream',
    (session) => {
      session.stream.destroyed = true;
    },
  ],
  [
    'expired offer',
    (session) => {
      session.credentialFillState.offer!.expiresAt = 0;
    },
  ],
  [
    'changed prompt',
    (session) => {
      session.credentialFillState = observeCredentialFillOutput(createCredentialFillState(), 'Password: ', Date.now());
    },
  ],
];
for (const [name, transition] of staleTransitions) {
  test(`permission lookup cannot revive a ${name}`, async () => {
    let release!: (rows: Array<{ payloadJson: string }>) => void;
    const harness = createCredentialServiceHarness({
      readSettings: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const fill = harness.service.fillLoginPassword(harness.session, harness.session.credentialFillState.offer!.token);
    transition(harness.session);
    release([]);
    await fill;
    assert.deepEqual(harness.writes, []);
  });
}

test('a replaced session and a database error cannot fill or disclose a password', async (context) => {
  const replaced = createCredentialServiceHarness();
  replaced.service.sessions.delete(replaced.session.sessionId);
  await replaced.service.fillLoginPassword(replaced.session, replaced.session.credentialFillState.offer!.token);
  assert.deepEqual(replaced.writes, []);
  const warning = context.mock.method(console, 'warn', () => {});
  const failed = createCredentialServiceHarness({
    readSettings: async () => {
      throw new Error('database unavailable');
    },
  });
  await failed.service.fillLoginPassword(failed.session, failed.session.credentialFillState.offer!.token);
  assert.deepEqual(failed.writes, []);
  assert.ok(
    failed.sent.some(
      (message) =>
        message.type === 'credential-fill-result' && message.status === 'rejected' && message.reason === 'failed',
    ),
  );
  assert.equal(warning.mock.callCount(), 1);
  assert.ok(!JSON.stringify(warning.mock.calls[0].arguments).includes(failed.session.loginPassword!));
});
