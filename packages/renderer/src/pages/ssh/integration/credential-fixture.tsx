import '@xterm/xterm/css/xterm.css';
import '../../../index.css';

import type { TerminalCredentialFillResult } from '@cosmosh/api-contract';
import { Terminal } from '@xterm/xterm';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { TerminalCredentialFill } from '../../../components/terminal/terminal-credential-fill';
import { createSshPaneState, reduceSshPaneState } from '../ssh-pane-state';
import type { TerminalCommandTimelineModel } from '../ssh-types';
import { SSHTerminalPaneLayout } from '../SSHTerminalPaneLayout';

type CredentialFixtureController = {
  requests: Array<{ paneId: string; token: string }>;
  offer: (token: string, lifetimeMs?: number) => void;
  result: (payload: TerminalCredentialFillResult) => void;
  activate: (paneId: string) => void;
  disconnect: () => void;
};

declare global {
  interface Window {
    credentialFixture?: CredentialFixtureController;
  }
}

/** External actions unrelated to the tested credential flow. */
const unusedAction = (): void => {};

const inactiveTimeline: TerminalCommandTimelineModel = {
  railReserved: false,
  historyVisible: false,
  alternateScreenActive: false,
  items: [],
  activeCommandId: null,
};

/**
 * Exercises production split-pane placement, reducer, action and real xterm without autocomplete.
 * Only server-message delivery and request transport boundaries are substituted.
 * @returns Browser-only two-pane regression fixture.
 */
export const CredentialFixture = (): React.ReactNode => {
  const [panes, dispatch] = React.useReducer(reduceSshPaneState, {
    first: createSshPaneState(),
    second: createSshPaneState(),
  });
  const [activePaneId, setActivePaneId] = React.useState('first');
  const activePaneRef = React.useRef('first');
  const terminals = React.useRef(new Map<string, Terminal>());
  const requests = React.useRef<CredentialFixtureController['requests']>([]);
  const activate = React.useCallback((paneId: string): void => {
    activePaneRef.current = paneId;
    setActivePaneId(paneId);
    terminals.current.get(paneId)?.focus();
  }, []);
  /** Mount each real terminal once; layout ref refreshes must not recreate its runtime. */
  const setContainer = React.useCallback((paneId: string, element: HTMLDivElement | null): void => {
    if (!element || terminals.current.has(paneId)) return;
    element.dataset.fixturePane = paneId;
    const terminal = new Terminal({ cols: 40, rows: 16, fontSize: 14 });
    terminal.open(element);
    terminal.write('Password: ');
    terminals.current.set(paneId, terminal);
  }, []);
  React.useEffect(() => {
    const ownedTerminals = terminals.current;
    for (const paneId of ['first', 'second']) {
      dispatch({ type: 'transport-state', paneId, connectionState: 'connected' });
    }
    activate('first');
    window.credentialFixture = {
      requests: requests.current,
      offer: (token, lifetimeMs = 45_000) =>
        dispatch({
          type: 'server-message',
          paneId: activePaneRef.current,
          receivedAt: Date.now(),
          payload: { type: 'credential-fill-offer', offer: { token, expiresAt: Date.now() + lifetimeMs } },
        }),
      result: (payload) =>
        dispatch({ type: 'server-message', paneId: activePaneRef.current, receivedAt: Date.now(), payload }),
      activate,
      disconnect: () => dispatch({ type: 'transport-state', paneId: activePaneRef.current, connectionState: 'failed' }),
    };
    return () => {
      delete window.credentialFixture;
      ownedTerminals.forEach((terminal) => terminal.dispose());
      ownedTerminals.clear();
    };
  }, [activate]);
  const state = panes[activePaneId];
  return (
    <div className="h-96 p-4">
      <SSHTerminalPaneLayout
        terminalPaneIds={['first', 'second']}
        activePaneId={activePaneId}
        hasSelection={false}
        canSplitTerminal={false}
        copyShortcutLabel=""
        pasteShortcutLabel=""
        searchOnlineLabel=""
        openDirectoryInSftpLabel=""
        findShortcutLabel=""
        clearTerminalShortcutLabel=""
        rightClickAction="contextMenu"
        canOpenDirectoryInSftp={false}
        commandTimelineModels={{ first: inactiveTimeline, second: inactiveTimeline }}
        paneConnectionStates={panes}
        setPaneContainerElement={setContainer}
        setPrimaryPaneContainer={unusedAction}
        activePaneOverlay={
          <TerminalCredentialFill
            key={activePaneId}
            offer={state.credentialFillOffer}
            pending={state.credentialFillRequestToken !== null}
            result={state.credentialFillResult}
            onFill={(token) => {
              dispatch({ type: 'credential-fill-requested', paneId: activePaneId, token });
              requests.current.push({ paneId: activePaneId, token });
              terminals.current.get(activePaneId)?.focus();
            }}
          />
        }
        onPaneActivate={activate}
        onRetryPane={unusedAction}
        onCopy={unusedAction}
        onCopyAsHtml={unusedAction}
        onPaste={unusedAction}
        onSearchOnline={unusedAction}
        onOpenDirectoryInSftp={unusedAction}
        onFind={unusedAction}
        onSelectAll={unusedAction}
        onClearTerminal={unusedAction}
        onCopyCommand={unusedAction}
        onFocusPane={activate}
        onInsertCommand={unusedAction}
        onSelectCommand={unusedAction}
        onSplitPane={unusedAction}
        onClosePane={unusedAction}
      />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<CredentialFixture />);
