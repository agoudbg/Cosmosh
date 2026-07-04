import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemoteShellInputState,
  takeSubmittedRemoteShellCommand,
  updateRemoteShellInputState,
} from './terminal-input-state.js';

test('remote shell input tracker emits live input changes and submitted commands', () => {
  const state = createRemoteShellInputState();
  const first = updateRemoteShellInputState(state, 'vim foo', { timestamp: 1000 });
  const second = updateRemoteShellInputState(state, '\r', { timestamp: 1001 });

  assert.deepEqual(first, [
    {
      type: 'remote-shell-input',
      event: 'input-change',
      timestamp: 1000,
      line: 'vim foo',
    },
  ]);
  assert.deepEqual(second, [
    {
      type: 'remote-shell-input',
      event: 'input-submit',
      timestamp: 1001,
      command: 'vim foo',
      line: '',
    },
    {
      type: 'remote-shell-input',
      event: 'input-change',
      timestamp: 1001,
      line: '',
    },
  ]);
  assert.equal(takeSubmittedRemoteShellCommand(state), 'vim foo');
  assert.equal(takeSubmittedRemoteShellCommand(state), null);
});

test('remote shell input tracker applies basic line editing controls', () => {
  const state = createRemoteShellInputState();

  updateRemoteShellInputState(state, 'abc\x7fd', { timestamp: 1000 });
  const events = updateRemoteShellInputState(state, '\u0017ef', { timestamp: 1001 });

  assert.deepEqual(events, [
    {
      type: 'remote-shell-input',
      event: 'input-change',
      timestamp: 1001,
      line: 'ef',
    },
  ]);
});

test('remote shell input tracker clears without recording suppressed input', () => {
  const state = createRemoteShellInputState();

  updateRemoteShellInputState(state, 'sudo ', { timestamp: 1000 });
  const events = updateRemoteShellInputState(state, 'secret', {
    timestamp: 1001,
    suppressedReason: 'secret-prompt',
  });

  assert.deepEqual(events, [
    {
      type: 'remote-shell-input',
      event: 'input-clear',
      timestamp: 1001,
      line: '',
      reason: 'secret-prompt',
    },
  ]);
  assert.equal(takeSubmittedRemoteShellCommand(state), null);
});

test('remote shell input tracker queues multiple submitted commands from one paste', () => {
  const state = createRemoteShellInputState();
  const events = updateRemoteShellInputState(state, 'pwd\ncd /tmp\n', { timestamp: 1000 });

  assert.equal(events.filter((event) => event.event === 'input-submit').length, 2);
  assert.equal(takeSubmittedRemoteShellCommand(state), 'pwd');
  assert.equal(takeSubmittedRemoteShellCommand(state), 'cd /tmp');
  assert.equal(takeSubmittedRemoteShellCommand(state), null);
});
