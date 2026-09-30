import assert from 'node:assert/strict';
import test from 'node:test';

import type { SshResolvedTargetSnapshot } from '../types/tabs';
import {
  createSshConnectionIntent,
  resolveConnectMode,
  resolveMirrorPaneSnapshot,
  resolveRetrySnapshot,
  shouldIgnoreAttemptResult,
  withResolvedSnapshot,
} from './ssh-connection-intent';

test('multi-tab retry remains bound to each tab snapshot', () => {
  const tabA = withResolvedSnapshot(createSshConnectionIntent('server-a'), {
    type: 'ssh-server',
    serverId: 'server-a',
    serverName: 'Server A',
    strictHostKey: true,
    enableSshCompression: false,
    disableCharacterWidthCompatibilityMode: false,
    terminalClipboardAccess: 'off',
    capturedAt: 1,
  });

  const tabB = withResolvedSnapshot(createSshConnectionIntent('server-b'), {
    type: 'ssh-server',
    serverId: 'server-b',
    serverName: 'Server B',
    strictHostKey: false,
    enableSshCompression: true,
    disableCharacterWidthCompatibilityMode: true,
    terminalClipboardAccess: 'readWrite',
    capturedAt: 2,
  });

  const tabBSnapshot = resolveRetrySnapshot(tabB);
  const tabASnapshot = resolveRetrySnapshot(tabA);
  assert.equal(tabBSnapshot.type, 'ssh-server');
  assert.equal(tabASnapshot.type, 'ssh-server');
  assert.equal(tabBSnapshot.serverId, 'server-b');
  assert.equal(tabASnapshot.serverId, 'server-a');
});

test('stale attempt result is ignored', () => {
  assert.equal(shouldIgnoreAttemptResult(5, 4), true);
  assert.equal(shouldIgnoreAttemptResult(5, 5), false);
});

test('retry connect mode falls back to initial when no snapshot exists', () => {
  const intentWithoutSnapshot = createSshConnectionIntent('server-a');
  assert.equal(resolveConnectMode(intentWithoutSnapshot, 'retry'), 'initial');

  const intentWithSnapshot = withResolvedSnapshot(intentWithoutSnapshot, {
    type: 'ssh-server',
    serverId: 'server-a',
    serverName: 'Server A',
    strictHostKey: true,
    enableSshCompression: false,
    disableCharacterWidthCompatibilityMode: false,
    terminalClipboardAccess: 'off',
    capturedAt: 1,
  });
  assert.equal(resolveConnectMode(intentWithSnapshot, 'retry'), 'retry');
});

test('mirror pane reuses primary snapshot semantics', () => {
  const snapshot: SshResolvedTargetSnapshot = {
    type: 'ssh-server' as const,
    serverId: 'server-b',
    serverName: 'Server B',
    strictHostKey: true,
    enableSshCompression: true,
    disableCharacterWidthCompatibilityMode: true,
    terminalClipboardAccess: 'askAlways',
    capturedAt: 33,
  };

  assert.deepEqual(resolveMirrorPaneSnapshot(snapshot), snapshot);
});
