import '../../../index.css';

import type { ShellContext, ShellHistoryRemovalResult, ShellHistoryView } from '@cosmosh/api-contract';
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ViteHotContext } from 'vite/types/hot.d.ts';

import { createSshPaneState, reduceSshPaneState, type SshPaneStateMap } from '../ssh-pane-state';
import { SSHSidebar } from '../SSHSidebar';

const context: ShellContext = {
  sessionId: 'history-browser',
  shellInstanceId: 'fish-browser',
  shell: 'fish',
  helperVersion: 'fixture',
  protocolVersion: 3,
  capabilities: ['history-read'],
  editorAvailable: false,
  permissions: { history: true, input: false, cwd: false, paths: false, nativeCompletion: false },
  status: 'paused',
  reason: 'input-submitted',
  revision: 1,
  promptGeneration: 1,
  inputGeneration: 0,
  submissionToken: null,
  cwdGeneration: 0,
  cwd: null,
  lastKnownCwd: null,
};
const initialView: ShellHistoryView = {
  status: 'ok',
  source: { id: 'source-one', shell: 'fish', namespace: 'work' },
  entries: ['echo newest  ', 'printf "two\nlines"', 'echo oldest'],
};
/** @returns Real reducer state for two separate history panes. */
const initialState = (): SshPaneStateMap => {
  let state: SshPaneStateMap = {};
  for (const paneId of ['pane-1', 'pane-2']) {
    state[paneId] = createSshPaneState();
    state = reduceSshPaneState(state, { type: 'transport-state', paneId, connectionState: 'connected' });
    state = reduceSshPaneState(state, {
      type: 'server-message',
      paneId,
      receivedAt: 1,
      payload: { type: 'shell-context', context },
    });
    state = reduceSshPaneState(state, {
      type: 'server-message',
      paneId,
      receivedAt: 1,
      payload: {
        type: 'shell-history',
        view:
          paneId === 'pane-1'
            ? initialView
            : { ...initialView, source: { ...initialView.source!, id: 'source-two' }, entries: ['echo second pane'] },
      },
    });
  }
  return state;
};
type HistoryFixtureController = {
  actions: Array<{ kind: string; command: string; sourceId?: string | null }>;
  setView: (view: ShellHistoryView) => void;
  permission: (allowed: boolean) => void;
  pane: (paneId: string) => void;
  respond: (status: ShellHistoryRemovalResult['status']) => void;
  reset: () => void;
};
declare global {
  interface Window {
    terminalHistoryFixture: HistoryFixtureController;
  }
}

/** @returns The production history sidebar and reducer with only transport/actions recorded. */
export const HistoryFixture = (): React.ReactNode => {
  const [state, dispatch] = React.useReducer(reduceSshPaneState, undefined, initialState);
  const [activePaneId, setActivePaneId] = React.useState('pane-1');
  const actions = React.useRef<HistoryFixtureController['actions']>([]);
  const pane = state[activePaneId]!;
  /** @param kind Explicit UI action. @param command Unchanged record. @returns Nothing. */
  const record = (kind: string, command: string): void => {
    actions.current.push({ kind, command });
  };
  window.terminalHistoryFixture = {
    actions: actions.current,
    pane: setActivePaneId,
    setView: (view) =>
      dispatch({
        type: 'server-message',
        paneId: activePaneId,
        receivedAt: 2,
        payload: { type: 'shell-history', view },
      }),
    permission: (allowed) => dispatch({ type: 'history-read-permission', paneId: activePaneId, allowed }),
    respond: (status) => {
      const pending = pane.historyRemoval;
      if (pending)
        dispatch({
          type: 'server-message',
          paneId: activePaneId,
          receivedAt: 3,
          payload: {
            type: 'shell-history-remove-result',
            requestId: pending.requestId,
            sourceId: pending.sourceId,
            status,
          },
        });
    },
    reset: () => {
      actions.current.length = 0;
      setActivePaneId('pane-1');
      for (const paneId of ['pane-1', 'pane-2']) {
        dispatch({ type: 'reset-pane', paneId });
        dispatch({ type: 'transport-state', paneId, connectionState: 'connected' });
        dispatch({ type: 'server-message', paneId, receivedAt: 1, payload: { type: 'shell-context', context } });
        dispatch({
          type: 'server-message',
          paneId,
          receivedAt: 1,
          payload: {
            type: 'shell-history',
            view:
              paneId === 'pane-1'
                ? initialView
                : {
                    ...initialView,
                    source: { ...initialView.source!, id: 'source-two' },
                    entries: ['echo second pane'],
                  },
          },
        });
      }
    },
  };
  return (
    <main className="bg-bg-base text-text-main flex h-screen justify-center p-4">
      <SSHSidebar
        canSplitTerminal
        activePaneId={activePaneId}
        terminalPaneIds={['pane-1', 'pane-2']}
        telemetryState={pane.telemetryState}
        historyView={pane.historyView}
        historyRemoval={pane.historyRemoval}
        onInsertRecentCommand={(command) => record('insert', command)}
        onInsertRecentCommandToPane={(command) => record('insert-other', command)}
        onSplitTerminalAndInsertRecentCommand={(command) => record('split-insert', command)}
        onRunRecentCommand={(command) => record('run', command)}
        onRunRecentCommandToPane={(command) => record('run-other', command)}
        onSplitTerminalAndRunRecentCommand={(command) => record('split-run', command)}
        onCopyRecentCommand={(command) => record('copy', command)}
        onDeleteRecentCommand={(command, sourceId) => {
          actions.current.push({ kind: 'remove', command, sourceId });
          if (sourceId)
            dispatch({
              type: 'history-removal-requested',
              paneId: activePaneId,
              sourceId,
              requestId: crypto.randomUUID(),
            });
        }}
      />
    </main>
  );
};
const fixtureRoot = createRoot(document.getElementById('root')!);
fixtureRoot.render(<HistoryFixture />);
const fixtureHot = (import.meta as ImportMeta & { hot?: ViteHotContext }).hot;
fixtureHot?.dispose(() => fixtureRoot.unmount());
