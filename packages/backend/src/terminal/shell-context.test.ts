import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS_VALUES, type RemoteShellEventMessage } from '@cosmosh/api-contract';

import {
  applyShellContextEvent,
  canUseShellCapability,
  createShellContext,
  invalidateShellInput,
  resolveShellPermissions,
  suspendShellContext,
  updateShellPermissions,
} from './shell-context.js';

/** Builds normalized helper events with explicit process identity for transition scenarios. */
const event = (fields: Partial<RemoteShellEventMessage>): RemoteShellEventMessage =>
  ({
    type: 'remote-shell-event',
    event: 'integration-ready',
    shell: 'bash',
    shellInstanceId: 'original',
    helperVersion: 'fixture-v3',
    protocolVersion: 3,
    capabilities: ['cwd', 'prompt-ready', 'command-start', 'input-snapshot', 'input-apply'],
    timestamp: 1,
    ...fields,
  }) as RemoteShellEventMessage;

/** Starts a real reducer-owned original Shell at its first confirmed prompt. */
const readyContext = () => {
  let context = createShellContext('session', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true);
  context = applyShellContextEvent(context, event({}));
  context = applyShellContextEvent(context, event({ event: 'cwd', cwd: '/fixture' }));
  return applyShellContextEvent(context, event({ event: 'prompt-ready', promptGeneration: 1 }));
};

test('nested Shell events cannot replace identity or directory, and only a newer parent prompt resumes', () => {
  const ready = readyContext();
  assert.equal(canUseShellCapability(ready, 'cwd'), true);
  const foreign = applyShellContextEvent(ready, event({ shellInstanceId: 'child', shell: 'fish' }));
  assert.equal(foreign.reason, 'foreign-shell');
  assert.equal(foreign.shellInstanceId, 'original');
  assert.equal(foreign.cwd, null);
  assert.equal(foreign.lastKnownCwd?.logical, '/fixture');
  const ignored = applyShellContextEvent(foreign, event({ shellInstanceId: 'child', event: 'cwd', cwd: '/wrong' }));
  assert.equal(ignored, foreign);
  assert.equal(applyShellContextEvent(foreign, event({ event: 'prompt-ready', promptGeneration: 1 })), foreign);
  const resumed = applyShellContextEvent(foreign, event({ event: 'prompt-ready', promptGeneration: 2 }));
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.shellInstanceId, 'original');
});

test('input invalidates pending operations without retaining text and submission requires a fresh prompt', () => {
  for (const input of ['PRIVATE_INPUT_SENTINEL', '\r', '\n', '\x03', '\x04', 'pasted\nmultiple\rcommands']) {
    const before = readyContext();
    const after = invalidateShellInput(before, input);
    assert.ok(after.revision > before.revision);
    assert.equal(after.inputGeneration, before.inputGeneration + 1);
    assert.equal(JSON.stringify(after).includes('PRIVATE_INPUT_SENTINEL'), false);
    assert.equal(after.status, input === 'PRIVATE_INPUT_SENTINEL' ? 'ready' : 'paused');
    if (after.status === 'paused') assert.equal(after.cwd, null);
  }
  const submitted = invalidateShellInput(readyContext(), '\r');
  const ended = applyShellContextEvent(
    submitted,
    event({ event: 'command-end', command: 'vim', commandId: '1', exitCode: 0, durationMs: 1 }),
  );
  assert.equal(ended.status, 'busy');
  assert.equal(canUseShellCapability(ended, 'input-apply'), false);
  assert.equal(applyShellContextEvent(ended, event({ event: 'prompt-ready', promptGeneration: 2 })).status, 'ready');
});

test('capability advertisement and each permission independently restrict enhancement operations', () => {
  const ready = readyContext();
  assert.equal(canUseShellCapability(ready, 'input-snapshot'), true);
  assert.equal(canUseShellCapability(ready, 'native-completion'), false);
  assert.equal(canUseShellCapability(ready, 'directory-read'), false, 'a permission cannot invent a helper capability');
  const noInput = updateShellPermissions(ready, { ...ready.permissions, input: false });
  assert.equal(canUseShellCapability(noInput, 'input-snapshot'), false);
  assert.equal(canUseShellCapability(noInput, 'cwd'), true);
  const noCwd = updateShellPermissions(noInput, { ...noInput.permissions, cwd: false });
  assert.equal(noCwd.cwd, null);
  assert.equal(noCwd.lastKnownCwd, null);
  assert.equal(applyShellContextEvent(noCwd, event({ event: 'cwd', cwd: '/must-not-cache' })), noCwd);
  const reenabled = updateShellPermissions(noCwd, ready.permissions);
  assert.equal(canUseShellCapability(reenabled, 'cwd'), false, 're-enabling must wait for a fresh directory report');
  for (const settings of [DEFAULT_SETTINGS_VALUES, { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsEnabled: false }]) {
    assert.ok(Object.values(resolveShellPermissions(settings, false)).every((value) => value === false));
  }
  assert.ok(
    Object.values(
      resolveShellPermissions({ ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsEnabled: false }, true),
    ).every((value) => value === false),
  );
});

test('unavailable runtimes cannot be revived by buffered events and sessions do not share permission objects', () => {
  const first = readyContext();
  const other = readyContext();
  first.permissions.input = false;
  assert.equal(other.permissions.input, true);
  const closed = suspendShellContext(first, 'transport-closed', true);
  assert.deepEqual(closed.capabilities, []);
  assert.equal(applyShellContextEvent(closed, event({ event: 'prompt-ready', promptGeneration: 99 })), closed);
});

test('generation-less sh/ash prompts keep confirmed CWD without inventing editor capabilities', () => {
  for (const shell of ['sh', 'ash'] as const) {
    let context = createShellContext('session', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true);
    context = applyShellContextEvent(context, event({ shell, capabilities: ['cwd', 'prompt-ready'] }));
    context = applyShellContextEvent(context, event({ event: 'cwd', shell, cwd: '/degraded' }));
    context = applyShellContextEvent(context, event({ event: 'prompt-ready', shell }));
    assert.equal(canUseShellCapability(context, 'cwd'), true);
    assert.equal(canUseShellCapability(context, 'input-snapshot'), false);
    assert.equal(context.promptGeneration, null);
  }
  assert.equal(applyShellContextEvent(readyContext(), event({ event: 'prompt-ready' })).reason, 'unsupported-editor');
});
