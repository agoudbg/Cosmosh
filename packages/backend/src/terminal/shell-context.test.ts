import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS_VALUES, type RemoteShellEventMessage } from '@cosmosh/api-contract';

import {
  applyShellContextEvent,
  canUseShellCapability,
  createShellContext,
  getShellContextSnapshot,
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
    physicalCwd: '/physical',
    homeDirectory: '/home/fixture',
    ...fields,
  }) as RemoteShellEventMessage;

/** Starts a real reducer-owned original Shell at its first confirmed prompt. */
const readyContext = () => {
  let context = createShellContext('session', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true);
  context = applyShellContextEvent(context, event({}));
  context = applyShellContextEvent(context, event({ event: 'cwd', cwd: '/fixture', promptGeneration: 1 }));
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

test('only a fresh directory report paired with its prompt becomes usable', () => {
  const before = readyContext();
  const submitted = invalidateShellInput(before, '\r');
  const missing = applyShellContextEvent(submitted, event({ event: 'prompt-ready', promptGeneration: 2 }));
  assert.equal(missing.cwd, null);
  assert.deepEqual(missing.lastKnownCwd, before.cwd, 'display-only metadata must not be reused by operations');
  const late = applyShellContextEvent(missing, event({ event: 'cwd', cwd: '/late', promptGeneration: 2 }));
  assert.equal(late, missing);
  const report = applyShellContextEvent(
    missing,
    event({
      event: 'cwd',
      cwd: '/link',
      physicalCwd: '/actual\n',
      homeDirectory: '/custom home',
      promptGeneration: 3,
    }),
  );
  assert.equal(report.cwd, null);
  assert.equal('pendingDirectory' in getShellContextSnapshot(report), false);
  assert.equal(applyShellContextEvent(report, event({ event: 'prompt-ready', promptGeneration: 4 })).cwd, null);
  const ready = applyShellContextEvent(report, event({ event: 'prompt-ready', promptGeneration: 3 }));
  assert.deepEqual(ready.cwd, { logical: '/link', physical: '/actual\n', home: '/custom home' });
  assert.ok(ready.cwdGeneration > before.cwdGeneration);
  const cancelled = invalidateShellInput(report, '\x03');
  assert.equal(applyShellContextEvent(cancelled, event({ event: 'prompt-ready', promptGeneration: 3 })).cwd, null);
  const noPhysical = applyShellContextEvent(
    invalidateShellInput(ready, '\r'),
    event({
      event: 'cwd',
      cwd: '/deleted',
      physicalCwd: null,
      homeDirectory: null,
      promptGeneration: 4,
    }),
  );
  assert.deepEqual(applyShellContextEvent(noPhysical, event({ event: 'prompt-ready', promptGeneration: 4 })).cwd, {
    logical: '/deleted',
    physical: null,
    home: null,
  });
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

test('a post-prompt directory mutation only invalidates the current generation', () => {
  const before = readyContext();
  const changed = applyShellContextEvent(before, event({ event: 'cwd-invalidated', promptGeneration: 1 }));
  assert.equal(changed.status, 'paused');
  assert.equal(changed.cwd, null);
  assert.deepEqual(changed.lastKnownCwd, before.cwd);
  assert.equal(applyShellContextEvent(before, event({ event: 'cwd-invalidated', promptGeneration: 2 })), before);
  const report = applyShellContextEvent(changed, event({ event: 'cwd', cwd: '/new', promptGeneration: 2 }));
  assert.equal(
    applyShellContextEvent(report, event({ event: 'prompt-ready', promptGeneration: 2 })).cwd?.logical,
    '/new',
  );
});

test('typeahead receipt cannot turn an earlier command prompt into confirmation of later input', () => {
  const first = invalidateShellInput(readyContext(), 'sleep 1\r', 'first');
  const busy = applyShellContextEvent(first, event({ event: 'command-start', command: 'sleep', commandId: 'first' }));
  const queued = invalidateShellInput(busy, 'cd /other\r', 'second');
  const report = applyShellContextEvent(queued, event({ event: 'cwd', cwd: '/old', promptGeneration: 2 }));
  const oldPrompt = applyShellContextEvent(report, event({ event: 'prompt-ready', promptGeneration: 2 }));
  assert.equal(oldPrompt.submissionToken, 'second', 'the token acknowledges Backend receipt only');
  assert.equal(oldPrompt.cwd, null, 'a verified editor exchange is required after ambiguous typeahead');
  assert.equal(oldPrompt.status, 'paused');
  assert.equal('requiresEditorConfirmation' in getShellContextSnapshot(oldPrompt), false);
});

test('multiple submission boundaries in one chunk also require editor confirmation', () => {
  for (const input of ['true\rcd /other\r', 'true\ncd /other\n', 'true\r\ncd /other\r\n', '\x03cd /other\r']) {
    const submitted = invalidateShellInput(readyContext(), input, 'batch');
    const report = applyShellContextEvent(submitted, event({ event: 'cwd', cwd: '/old', promptGeneration: 2 }));
    const prompt = applyShellContextEvent(report, event({ event: 'prompt-ready', promptGeneration: 2 }));
    assert.equal(prompt.status, 'paused');
    assert.equal(prompt.cwd, null);
  }
  assert.equal(invalidateShellInput(readyContext(), 'true\r\n').requiresEditorConfirmation, false);
});

test('interleaved nested Shell events cannot release ambiguous submissions to the parent', () => {
  const foreign = event({ shellInstanceId: 'child' });
  let context = applyShellContextEvent(readyContext(), foreign);
  context = invalidateShellInput(context, 'exit\r', 'child-exit');
  context = applyShellContextEvent(context, foreign);
  context = invalidateShellInput(context, 'cd /other\r', 'parent-command');
  context = applyShellContextEvent(context, event({ event: 'cwd', cwd: '/old', promptGeneration: 2 }));
  context = applyShellContextEvent(context, event({ event: 'prompt-ready', promptGeneration: 2 }));
  assert.equal(context.cwd, null);
  assert.equal(context.status, 'paused');
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
