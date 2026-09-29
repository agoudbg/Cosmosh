import { DEFAULT_SETTINGS_VALUES } from '@cosmosh/api-contract';

import type { EnhancementStatusInput } from '../remote-enhancement-status';

/** @returns Independent fixture observations; only the transport boundary is supplied by the fixture. */
export const createEnhancementStatusFixture = (): EnhancementStatusInput => ({
  connectionState: 'connected',
  serverEnabled: true,
  runtimeStatus: { type: 'remote-enhancement-runtime-status', state: 'active' },
  settings: { ...DEFAULT_SETTINGS_VALUES, terminalNativeCompletionMode: 'manual' },
  historyView: { status: 'ok', source: { id: 'source', shell: 'fish', namespace: 'fish' }, entries: [] },
  context: {
    sessionId: 'status-session',
    shellInstanceId: 'status-shell',
    shell: 'fish',
    helperVersion: 'fixture-helper',
    protocolVersion: 3,
    capabilities: ['cwd', 'input-snapshot', 'input-apply', 'directory-read', 'history-read', 'native-completion'],
    editorAvailable: true,
    permissions: { cwd: true, input: true, history: true, paths: true, nativeCompletion: true },
    status: 'ready',
    reason: null,
    revision: 1,
    inputGeneration: 0,
    submissionToken: null,
    promptGeneration: 1,
    cwdGeneration: 1,
    cwd: { logical: '/home/user/current', physical: '/home/user/current', home: '/home/user' },
    lastKnownCwd: { logical: '/old/private/path', physical: '/old/private/path', home: '/home/user' },
  },
});
