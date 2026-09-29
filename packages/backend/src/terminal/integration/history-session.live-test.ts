import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_SETTINGS_VALUES,
  type RemoteShellEventMessage,
  type ShellHistoryRemovalResult,
  type ShellHistoryView,
  type SshTerminalServerMessage,
} from '@cosmosh/api-contract';

import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { SshSessionService } from '../../ssh/session-service.js';
import { createCredentialFillState } from '../credential-fill.js';
import type { ShellEditorController } from '../editor-controller.js';
import { createShellContext, resolveShellPermissions } from '../shell-context.js';
import { editorBinaryPath, installFixtureEditor } from './editor-fixture.js';
import { type FixtureTerminal, openFixtureTerminal } from './fixture-client.js';

const fish4 = '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish';
const historyOnlySettings = {
  ...DEFAULT_SETTINGS_VALUES,
  remoteEnhancementsCwdEnabled: false,
  remoteEnhancementsInputEnabled: false,
};

before(() => installFixtureEditor('fish'));

/** @param terminal Real original-Shell PTY. @param event First fixture helper event. @param messages Captured websocket output. @returns A service-owned live session. */
const createLiveSession = (
  terminal: FixtureTerminal,
  event: RemoteShellEventMessage,
  messages: SshTerminalServerMessage[],
) => {
  const sessionId = randomUUID();
  return {
    sessionId,
    shellContext: createShellContext(sessionId, resolveShellPermissions(historyOnlySettings, true), true),
    editorController: undefined as ShellEditorController | undefined,
    editorContextTimeout: undefined as NodeJS.Timeout | undefined,
    client: terminal.client,
    stream: terminal.channel,
    enhancementsAllowed: true,
    remoteEnhancementsRuntimeState: 'pending' as 'pending' | 'active' | 'disabled',
    remoteEnhancementsRuntimeContract: {
      shell: 'fish' as const,
      helperVersion: event.helperVersion,
      protocolVersion: event.protocolVersion,
      capabilities: [...event.capabilities],
      binaryPath: editorBinaryPath('fish'),
    },
    remoteEnhancementsRuntimeCode: null as string | null,
    remoteEnhancementsRuntimeMessage: null as string | null,
    remoteEnhancementsHandshakeTimeout: null as NodeJS.Timeout | null,
    pendingStreamFrames: [],
    pendingStreamFrameBytes: 0,
    pendingStreamFrameDropCount: 0,
    pendingRemoteBootstrapStatuses: [],
    remoteShellReady: false,
    remoteShellForegroundCommand: null as string | null,
    lastRemoteCommand: null as string | null,
    lastRemoteCommandId: null as string | null,
    lastExitCode: null as number | null,
    lastCommandDurationMs: null as number | null,
    commandCount: 0,
    historySyncTimeout: null as NodeJS.Timeout | null,
    historySyncInFlight: false,
    historySyncPending: false,
    historyMutationInFlight: false,
    historyAbortController: undefined as AbortController | undefined,
    historyView: undefined as ShellHistoryView | undefined,
    historyOwnerInstanceId: undefined as string | undefined,
    lastHistorySyncStartedAtMs: 0,
    recentCommands: [] as string[],
    completionRecentCommands: [] as string[],
    loginPassword: null,
    credentialFillState: createCredentialFillState(),
    socket: {
      OPEN: 1,
      readyState: 1,
      send: (payload: string): void => {
        messages.push(JSON.parse(payload) as SshTerminalServerMessage);
      },
    },
    disposed: false,
  };
};

type LiveSession = ReturnType<typeof createLiveSession>;
type LiveService = {
  sessions: Map<string, LiveSession>;
  handleRemoteShellEvent(session: LiveSession, event: RemoteShellEventMessage): void;
  handleClientMessage(session: LiveSession, payload: Buffer): void;
  applyEnhancementSettings(snapshot: { revision: number; values: typeof historyOnlySettings }): void;
  clearRemoteHistory(session: LiveSession): void;
};

/** @param messages Actual service output. @returns Its latest native history view. */
const latestView = (messages: SshTerminalServerMessage[]): ShellHistoryView | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'shell-history') return message.view;
  }
  return null;
};

/** @param messages Actual service output. @param requestId Exact client action. @returns Its removal result. */
const removalResult = (messages: SshTerminalServerMessage[], requestId: string): ShellHistoryRemovalResult | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'shell-history-remove-result' && message.requestId === requestId) return message;
  }
  return null;
};

/** @param sample Current evidence sampler. @param pump Receive actual PTY helper events. @returns First matching evidence. */
const waitForEvidence = async <T>(sample: () => T | null, pump: () => void): Promise<T> => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    pump();
    const value = sample();
    if (value !== null) return value;
    await delay(20);
  }
  throw new Error('The fixture did not publish the expected native history state before the deadline.');
};

test(
  'real Fish helper events publish source-bound history and enforce native deletion and opt-out',
  { timeout: 60_000 },
  async (t) => {
    const firstNamespace = 'cosmosh_session_' + randomUUID().replaceAll('-', '_');
    const secondNamespace = 'cosmosh_session_' + randomUUID().replaceAll('-', '_');
    const firstRecord = 'SESSION_FIRST_' + randomUUID().replaceAll('-', '_');
    const secondRecord = 'SESSION_SECOND_' + randomUUID().replaceAll('-', '_');
    const terminal = await openFixtureTerminal('fish', fish4, {
      disableFishAutosuggestions: true,
      initialCommand: 'set -g fish_history ' + firstNamespace + '; builtin history append ' + firstRecord,
    });
    const messages: SshTerminalServerMessage[] = [];
    const parser = new RemoteShellEventOscParser();
    let offset = 0;
    let session: LiveSession | null = null;
    let service: LiveService | null = null;
    const originalExec = terminal.client.exec;
    let execCount = 0;
    Object.assign(terminal.client, {
      exec(...args: unknown[]) {
        execCount += 1;
        return Reflect.apply(originalExec, terminal.client, args);
      },
    });
    t.after(() => {
      if (session && service) {
        service.clearRemoteHistory(session);
        if (session.editorContextTimeout) clearTimeout(session.editorContextTimeout);
        session.editorController?.invalidate();
        service.sessions.clear();
      }
      Object.assign(terminal.client, { exec: originalExec });
      terminal.close();
    });

    /** @returns Nothing; forwards only actual OSC events to production service methods. */
    const pump = (): void => {
      const output = terminal.readOutput(offset);
      offset += output.length;
      for (const frame of parser.parse(output)) {
        if (frame.type !== 'event') continue;
        const event = frame.event;
        if (!session && event.event === 'integration-ready') {
          assert.equal(event.shell, 'fish');
          assert.ok(event.capabilities.includes('history-read'));
          session = createLiveSession(terminal, event, messages);
          service = Object.assign(Object.create(SshSessionService.prototype) as LiveService, {
            sessions: new Map([[session.sessionId, session]]),
            enhancementSettingsSnapshot: { revision: 0, values: historyOnlySettings },
          });
        }
        if (session && service) service.handleRemoteShellEvent(session, event);
      }
    };

    const initial = await waitForEvidence(() => {
      const view = latestView(messages);
      if (!view?.source) return null;
      return view.source.namespace === firstNamespace && view.entries.includes(firstRecord) ? view : null;
    }, pump);
    assert.equal(initial.status, 'ok');
    assert.equal(initial.source?.shell, 'fish');
    const liveSession = session as LiveSession | null;
    const liveService = service as LiveService | null;
    assert.ok(liveSession && liveService);
    assert.ok(liveSession.recentCommands.includes(firstRecord));

    terminal.write('set -g fish_history ' + secondNamespace + '; builtin history append ' + secondRecord + '\r');
    const changed = await waitForEvidence(() => {
      const view = latestView(messages);
      if (!view?.source) return null;
      return view.source.namespace === secondNamespace && view.entries.includes(secondRecord) ? view : null;
    }, pump);
    assert.notEqual(changed.source?.id, initial.source?.id);
    assert.equal(changed.entries.includes(firstRecord), false);
    assert.equal(liveSession.recentCommands.includes(firstRecord), false);

    const execBeforeOldSource = execCount;
    const oldSourceRequestId = randomUUID();
    liveService.handleClientMessage(
      liveSession,
      Buffer.from(
        JSON.stringify({
          type: 'shell-history-remove',
          requestId: oldSourceRequestId,
          sourceId: initial.source!.id,
          command: firstRecord,
        }),
      ),
    );
    assert.equal((await waitForEvidence(() => removalResult(messages, oldSourceRequestId), pump)).status, 'stale');
    assert.equal(execCount, execBeforeOldSource, 'an old source never opens a private SSH worker');

    const removeId = randomUUID();
    liveService.handleClientMessage(
      liveSession,
      Buffer.from(
        JSON.stringify({
          type: 'shell-history-remove',
          requestId: removeId,
          sourceId: changed.source!.id,
          command: secondRecord,
        }),
      ),
    );
    const removed = await waitForEvidence(() => removalResult(messages, removeId), pump);
    assert.equal(removed.status, 'removed-from-reader');
    assert.equal(
      latestView(messages)?.entries.some((entry) => entry === secondRecord),
      false,
    );

    liveService.applyEnhancementSettings({
      revision: 1,
      values: { ...historyOnlySettings, remoteEnhancementsHistoryEnabled: false },
    });
    assert.deepEqual(latestView(messages), { status: 'disabled', source: null, entries: [] });
    assert.deepEqual(liveSession.recentCommands, []);
    assert.deepEqual(liveSession.completionRecentCommands, []);
    const execBeforeStaleAction = execCount;
    const staleId = randomUUID();
    liveService.handleClientMessage(
      liveSession,
      Buffer.from(
        JSON.stringify({
          type: 'shell-history-remove',
          requestId: staleId,
          sourceId: changed.source!.id,
          command: secondRecord,
        }),
      ),
    );
    const stale = await waitForEvidence(() => removalResult(messages, staleId), pump);
    assert.equal(stale.status, 'stale');
    assert.equal(execCount, execBeforeStaleAction, 'revoked history never opens a private SSH worker');
  },
);
