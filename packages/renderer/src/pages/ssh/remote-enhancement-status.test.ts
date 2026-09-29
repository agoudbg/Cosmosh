import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnhancementStatusFixture } from './integration/enhancement-status-fixture-data';
import { resolveEnhancementStatus } from './remote-enhancement-status';

test('advertised capabilities never imply enabled precise filling or menu integration', () => {
  const model = resolveEnhancementStatus(createEnhancementStatusFixture());
  assert.equal(model.summary, 'helperConnected');
  assert.equal(model.features.find((feature) => feature.id === 'input')?.reason, 'verifiedEditingPending');
  assert.equal(model.features.find((feature) => feature.id === 'paths')?.reason, 'pathMenuPending');
  assert.equal(model.features.find((feature) => feature.id === 'nativeCompletion')?.reason, 'nativeMenuPending');
  assert.equal(model.features.find((feature) => feature.id === 'history')?.state, 'available');
});

test('offline and reconnecting panes never display a retained active helper or directory', () => {
  for (const connectionState of ['failed', 'connecting'] as const) {
    const input = createEnhancementStatusFixture();
    input.connectionState = connectionState;
    const model = resolveEnhancementStatus(input);
    assert.equal(model.summary, connectionState === 'failed' ? 'disconnected' : 'connecting');
    assert.equal(model.directory, null);
    assert.ok(model.features.every((feature) => feature.state !== 'available'));
    input.settings.remoteEnhancementsEnabled = false;
    input.serverEnabled = false;
    assert.equal(resolveEnhancementStatus(input).summary, model.summary);
  }
});

test('native query mode preserves opt-outs and never promises a connected menu', () => {
  const input = createEnhancementStatusFixture();
  for (const mode of ['off', 'manual', 'automatic'] as const) {
    input.settings.terminalNativeCompletionMode = mode;
    const feature = resolveEnhancementStatus(input).features.find((item) => item.id === 'nativeCompletion')!;
    assert.equal(feature.allowed, mode !== 'off');
    assert.equal(feature.reason, mode === 'off' ? 'permissionDisabled' : 'nativeMenuPending');
    assert.notEqual(feature.state, 'available');
  }
});

test('history is independent of paused input and directory permissions, including an empty successful read', () => {
  const input = createEnhancementStatusFixture();
  input.context = { ...input.context!, status: 'paused', reason: 'input-submitted', cwd: null };
  input.settings.remoteEnhancementsInputEnabled = false;
  input.settings.remoteEnhancementsCwdEnabled = false;
  const model = resolveEnhancementStatus(input);
  assert.equal(model.features.find((feature) => feature.id === 'history')?.reason, 'historyReady');
  assert.equal(model.directory, null);
  assert.ok(!JSON.stringify(model).includes('/old/private/path'));
});

test('opt-outs immediately override older successful observations and preserve separate permission preference', () => {
  const input = createEnhancementStatusFixture();
  input.settings.remoteEnhancementsHistoryEnabled = false;
  input.settings.remoteEnhancementsCwdEnabled = false;
  const model = resolveEnhancementStatus(input);
  for (const id of ['directory', 'history']) {
    const feature = model.features.find((item) => item.id === id)!;
    assert.equal(feature.allowed, false);
    assert.equal(feature.state, 'disabled');
  }
  assert.equal(model.directory, null);
  input.connectionState = 'failed';
  assert.equal(resolveEnhancementStatus(input).features.find((feature) => feature.id === 'input')?.allowed, true);
});

test('logical-only directories are partial, and paused states never reuse the last known directory', () => {
  const input = createEnhancementStatusFixture();
  input.context!.cwd!.physical = null;
  assert.equal(resolveEnhancementStatus(input).features[0].reason, 'directoryLogicalOnly');
  for (const reason of ['foreign-shell', 'unsupported-editor', 'waiting-for-prompt', 'command-running'] as const) {
    input.context = { ...input.context!, status: 'paused', reason };
    const model = resolveEnhancementStatus(input);
    assert.equal(model.directory, null);
    assert.notEqual(model.features[0].state, 'available');
  }
});

test('private, partial and unsupported history use the native source result without command text', () => {
  const input = createEnhancementStatusFixture();
  input.historyView = { status: 'private', source: null, entries: [] };
  assert.equal(resolveEnhancementStatus(input).features[1].reason, 'historyPrivate');
  input.historyView = {
    status: 'partial',
    source: { id: 'source', shell: 'fish', namespace: 'private-name' },
    entries: ['sensitive command'],
  };
  const model = resolveEnhancementStatus(input);
  assert.equal(model.features[1].reason, 'historyPartial');
  assert.ok(!JSON.stringify(model).includes('sensitive'));
  assert.ok(!JSON.stringify(model).includes('private-name'));
  input.context!.shell = 'bash';
  assert.equal(resolveEnhancementStatus(input).features[1].reason, 'unsupported');
});

test('helper failure codes explain supported causes and do not guess the operating system', () => {
  const input = createEnhancementStatusFixture();
  const cases = {
    HELPER_CONTRACT_MISMATCH: 'helperMismatch',
    HELPER_HANDSHAKE_TIMEOUT: 'helperTimeout',
    BOOTSTRAP_ENSURE_TIMEOUT: 'helperTimeout',
    PERMISSION_DISABLED: 'reconnectRequired',
    REMOTE_ENHANCEMENTS_DISABLED: 'reconnectRequired',
    PROBE_FAILED: 'helperUnavailable',
  } as const;
  for (const [code, reason] of Object.entries(cases)) {
    input.runtimeStatus = { type: 'remote-enhancement-runtime-status', state: 'disabled', code };
    assert.equal(resolveEnhancementStatus(input).summary, reason);
  }
  input.settings.remoteEnhancementsEnabled = false;
  assert.equal(resolveEnhancementStatus(input).summary, 'globalDisabled');
  input.settings.remoteEnhancementsEnabled = true;
  input.serverEnabled = false;
  assert.equal(resolveEnhancementStatus(input).summary, 'serverDisabled');
});

test('dependent sources explain disabled input, directory and suggestion settings', () => {
  const input = createEnhancementStatusFixture();
  input.settings.remoteEnhancementsInputEnabled = false;
  assert.equal(resolveEnhancementStatus(input).features[3].reason, 'inputRequired');
  input.settings.remoteEnhancementsInputEnabled = true;
  input.settings.remoteEnhancementsCwdEnabled = false;
  assert.equal(resolveEnhancementStatus(input).features[3].reason, 'directoryRequired');
  input.settings.terminalAutoCompleteEnabled = false;
  assert.equal(resolveEnhancementStatus(input).features[3].reason, 'suggestionsDisabled');
});
