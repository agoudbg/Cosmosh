import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES, RemoteShellEventOscParser } from './remote-shell-events.js';

const ESCAPE = '\u001b';
const BELL = '\u0007';
const RUNTIME_CONTRACT = {
  helperVersion: '1.2.3',
  protocolVersion: 3,
  shellInstanceId: 'shell-1',
  capabilities: ['cwd', 'command-start', 'command-end', 'foreground-command', 'prompt-ready'],
};

/**
 * Encodes one dynamic helper field without relying on JSON string escaping.
 *
 * @param value UTF-8 field value.
 * @returns Canonical base64 representation.
 */
const encodeField = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

/**
 * Encodes one remote shell event payload in the OSC 777 transport format.
 *
 * @param value Event payload object without the WebSocket message wrapper.
 * @returns OSC control sequence.
 */
const encodeCosmoshOsc = (value: Record<string, unknown>): string => {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `${ESCAPE}]777;cosmosh;${encoded}${BELL}`;
};

test('v3 rejects missing/invalid instance identity and legacy protocol without leaking envelope text', () => {
  for (const fields of [
    { shellInstanceId: undefined },
    { shellInstanceId: '' },
    { shellInstanceId: 'bad\nid' },
    { shellInstanceId: 'x'.repeat(257) },
    { protocolVersion: 2 },
    { protocolVersion: 4 },
  ]) {
    const parser = new RemoteShellEventOscParser();
    const result = parser.parse(
      'before' +
        encodeCosmoshOsc({
          ...RUNTIME_CONTRACT,
          event: 'integration-ready',
          shell: 'bash',
          timestamp: 1,
          ...fields,
        }) +
        'after',
    );
    assert.deepEqual(result, [{ type: 'output', data: 'beforeafter' }]);
  }
});

test('v3 bounds decoded JSON separately from the encoded OSC budget and rejects noncanonical Base64', () => {
  const data = { ...RUNTIME_CONTRACT, event: 'integration-ready', shell: 'bash', timestamp: 1 };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
  const whitespace = encoded.slice(0, 4) + '\n' + encoded.slice(4);
  assert.deepEqual(new RemoteShellEventOscParser().parse(ESCAPE + ']777;cosmosh;' + whitespace + BELL), []);
  const large = encodeCosmoshOsc({ ...data, padding: 'a'.repeat(33 * 1024) });
  assert.ok(Buffer.byteLength(large) < REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES);
  assert.deepEqual(new RemoteShellEventOscParser().parse(large + 'visible'), [{ type: 'output', data: 'visible' }]);
});

test('parser strips Cosmosh OSC events while preserving their position among visible output', () => {
  const parser = new RemoteShellEventOscParser();
  const firstEvent = {
    ...RUNTIME_CONTRACT,
    event: 'cwd',
    shell: 'zsh',
    cwdBase64: encodeField('/tmp\tworkspace'),
    timestamp: 1_717_000_000_000,
  };
  const secondEvent = {
    ...RUNTIME_CONTRACT,
    event: 'command-end',
    shell: 'zsh',
    commandBase64: encodeField('false'),
    exitCode: 1,
    durationMs: 42,
    commandId: 'cmd-1',
    timestamp: 1_717_000_000_100,
  };

  const result = parser.parse(`before${encodeCosmoshOsc(firstEvent)} middle ${encodeCosmoshOsc(secondEvent)}after`);

  assert.deepEqual(result, [
    { type: 'output', data: 'before' },
    {
      type: 'event',
      event: {
        type: 'remote-shell-event',
        ...RUNTIME_CONTRACT,
        event: 'cwd',
        shell: 'zsh',
        cwd: '/tmp\tworkspace',
        timestamp: 1_717_000_000_000,
      },
    },
    { type: 'output', data: ' middle ' },
    {
      type: 'event',
      event: {
        type: 'remote-shell-event',
        ...RUNTIME_CONTRACT,
        event: 'command-end',
        shell: 'zsh',
        command: 'false',
        exitCode: 1,
        durationMs: 42,
        commandId: 'cmd-1',
        timestamp: 1_717_000_000_100,
      },
    },
    { type: 'output', data: 'after' },
  ]);
});

test('parser preserves non-Cosmosh OSC sequences and normal ANSI text', () => {
  const parser = new RemoteShellEventOscParser();
  const nonCosmoshOsc = `${ESCAPE}]0;window title${BELL}`;
  const result = parser.parse(`plain ${ESCAPE}[31mred${ESCAPE}[0m ${nonCosmoshOsc} tail`);

  assert.deepEqual(result, [{ type: 'output', data: `plain ${ESCAPE}[31mred${ESCAPE}[0m ${nonCosmoshOsc} tail` }]);
});

test('parser decodes Cosmosh OSC split across chunks', () => {
  const parser = new RemoteShellEventOscParser();
  const sequence = encodeCosmoshOsc({
    ...RUNTIME_CONTRACT,
    event: 'prompt-ready',
    shell: 'bash',
    timestamp: 1_717_000_000_000,
  });
  const first = parser.parse(`left${sequence.slice(0, 16)}`);
  const second = parser.parse(`${sequence.slice(16)}right`);

  assert.deepEqual(first, [{ type: 'output', data: 'left' }]);
  assert.deepEqual(second, [
    {
      type: 'event',
      event: {
        type: 'remote-shell-event',
        ...RUNTIME_CONTRACT,
        event: 'prompt-ready',
        shell: 'bash',
        timestamp: 1_717_000_000_000,
      },
    },
    { type: 'output', data: 'right' },
  ]);
});

test('parser drops invalid Cosmosh JSON without affecting surrounding output', () => {
  const parser = new RemoteShellEventOscParser();
  const invalidPayload = Buffer.from('{bad json', 'utf8').toString('base64');
  const result = parser.parse(`before${ESCAPE}]777;cosmosh;${invalidPayload}${BELL}after`);

  assert.deepEqual(result, [{ type: 'output', data: 'beforeafter' }]);
});

test('parser drops legacy helper events without a runtime contract', () => {
  const parser = new RemoteShellEventOscParser();
  const result = parser.parse(
    encodeCosmoshOsc({
      event: 'cwd',
      shell: 'bash',
      cwdBase64: encodeField('/legacy'),
      timestamp: 1_717_000_000_000,
    }),
  );

  assert.deepEqual(result, []);
});

test('parser drops oversized Cosmosh payloads until sequence terminator', () => {
  const parser = new RemoteShellEventOscParser();
  const oversizedPayload = 'x'.repeat(REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES + 1);
  const result = parser.parse(`before${ESCAPE}]777;cosmosh;${oversizedPayload}${BELL}after`);

  assert.deepEqual(result, [{ type: 'output', data: 'beforeafter' }]);
});

test('parser recovers when the payload cap lands on the ESC of an ST terminator', () => {
  const parser = new RemoteShellEventOscParser();
  // Payload exactly at the cap: the ST terminator's ESC is the byte that
  // crosses it, so discard mode must remember the half-seen terminator.
  const cappedPayload = 'x'.repeat(REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES);
  const result = parser.parse(`before${ESCAPE}]777;cosmosh;${cappedPayload}${ESCAPE}\\after`);

  assert.deepEqual(result, [{ type: 'output', data: 'beforeafter' }]);
  assert.deepEqual(parser.parse('SUBSEQUENT-OUTPUT'), [{ type: 'output', data: 'SUBSEQUENT-OUTPUT' }]);
});

test('parser streams non-Cosmosh OSC without retaining its unbounded payload', () => {
  const parser = new RemoteShellEventOscParser();
  const nonterminatedOsc = `${ESCAPE}]0;${'x'.repeat(256 * 1024)}`;
  const result = parser.parse(`before${nonterminatedOsc}`);

  assert.deepEqual(result, [{ type: 'output', data: `before${nonterminatedOsc}` }]);
  assert.equal(parser.flush(), '');
});

test('parser flushes an incomplete prefix that may still belong to Cosmosh', () => {
  const parser = new RemoteShellEventOscParser();
  const candidate = `${ESCAPE}]777;cos`;
  const result = parser.parse(`before${candidate}`);

  assert.deepEqual(result, [{ type: 'output', data: 'before' }]);
  assert.equal(parser.flush(), candidate);
});
