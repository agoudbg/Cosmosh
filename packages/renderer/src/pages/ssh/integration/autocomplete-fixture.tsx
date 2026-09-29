import '@xterm/xterm/css/xterm.css';
import '../../../index.css';

import type {
  SettingsValues,
  ShellContext,
  TerminalClientMessage,
  TerminalCompletionAcceptResult,
  TerminalCompletionUpdate,
} from '@cosmosh/api-contract';
import { Terminal } from '@xterm/xterm';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { TerminalAutocompleteMenu } from '../../../components/terminal/terminal-autocomplete-menu';
import type { TerminalPaneRuntime } from '../ssh-types';
import { forwardTerminalInput } from '../ssh-utils';
import { useSshAutocomplete } from '../use-ssh-completion';

type FixtureSettings = {
  inputAllowed: boolean;
  historyEnabled: boolean;
  enabled: boolean;
  isActive: boolean;
  connected: boolean;
  acceptKeys: SettingsValues['terminalAutoCompleteAcceptKeys'];
};
type RecordedMessage = { paneId: string; payload: TerminalClientMessage };
type FixtureController = {
  messages: RecordedMessage[];
  warnings: string[];
  directInput: (data: string) => void;
  context: (changes: Partial<ShellContext>) => void;
  acceptResult: (status: TerminalCompletionAcceptResult['status']) => void;
  setInputAllowed: (allowed: boolean) => void;
  setHistoryEnabled: (enabled: boolean) => void;
  failNextMenuReset: () => void;
  accept: (index: number) => void;
  transportCallbackChanges: number;
  reset: (settings?: Partial<FixtureSettings>) => Promise<void>;
  show: () => void;
  respond: (changes?: Partial<TerminalCompletionUpdate>) => void;
  focusPane: (paneId: string) => void;
  alternate: (enabled: boolean) => Promise<void>;
  output: (data: string) => Promise<void>;
};

declare global {
  interface Window {
    terminalInteractionFixture?: FixtureController;
  }
}

const defaults: FixtureSettings = {
  inputAllowed: true,
  historyEnabled: true,
  enabled: true,
  isActive: true,
  connected: true,
  acceptKeys: 'tab',
};

/**
 * Renders the real hook, xterm, and suggestion menu; only WebSocket transport is substituted.
 *
 * @returns Browser-only regression fixture, unreachable from the application entry point.
 */
export const AutocompleteFixture = (): React.ReactNode => {
  const [settings, setSettings] = React.useState(defaults);
  const [, setReady] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const firstRef = React.useRef<HTMLDivElement>(null);
  const secondRef = React.useRef<HTMLDivElement>(null);
  const terminalContainerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<Terminal>(null);
  const activePaneIdRef = React.useRef('pane-1');
  const paneRuntimeMapRef = React.useRef(new Map<string, Pick<TerminalPaneRuntime, 'terminal' | 'socket'>>());
  const warningsRef = React.useRef<string[]>([]);
  const contextRef = React.useRef<ShellContext>({
    sessionId: 'fixture-session',
    shellInstanceId: '94eb0ed9-993f-4517-925a-d28e5139fce0',
    shell: 'bash',
    helperVersion: 'fixture',
    protocolVersion: 3,
    capabilities: ['input-snapshot', 'input-apply'],
    editorAvailable: true,
    permissions: { input: true, history: true, cwd: false, paths: false, nativeCompletion: false },
    status: 'ready',
    reason: null,
    revision: 1,
    inputGeneration: 0,
    submissionToken: null,
    promptGeneration: 1,
    cwdGeneration: 0,
    cwd: null,
    lastKnownCwd: null,
  });
  const autocomplete = useSshAutocomplete({
    getPaneContext: () => contextRef.current,
    notifyWarning: (message) => warningsRef.current.push(message),
    isActive: settings.isActive,
    connectionState: settings.connected ? 'connected' : 'failed',
    terminalAutoCompleteEnabled: settings.enabled && settings.inputAllowed,
    terminalAutoCompleteHistoryEnabled: settings.historyEnabled,
    terminalAutoCompleteBuiltInCommandsEnabled: true,
    terminalAutoCompletePathEnabled: false,
    terminalAutoCompleteAcceptKeys: settings.acceptKeys,
    terminalAutoCompleteFocusShortcut: 'ctrlShiftSpace',
    terminalAutoCompleteMinChars: 1,
    terminalAutoCompleteMaxItems: 8,
    terminalAutoCompleteFuzzyMatch: false,
    terminalNativeCompletionMode: 'off',
    wrapperRef,
    terminalContainerRef,
    terminalRef,
    activePaneIdRef,
    paneRuntimeMapRef,
  });
  const current = React.useRef(autocomplete);
  React.useLayoutEffect(() => {
    const fixture = window.terminalInteractionFixture;
    if (
      fixture &&
      (current.current.handleCompletionResponse !== autocomplete.handleCompletionResponse ||
        current.current.applyAutocompleteInputData !== autocomplete.applyAutocompleteInputData)
    ) {
      fixture.transportCallbackChanges += 1;
    }
    current.current = autocomplete;
  });

  React.useEffect(() => {
    const messages: RecordedMessage[] = [];
    const runtimes = paneRuntimeMapRef.current;
    const containers = [firstRef.current!, secondRef.current!];
    const cleanup: Array<() => void> = [];
    for (const [index, container] of containers.entries()) {
      const paneId = `pane-${index + 1}`;
      const terminal = new Terminal({ cols: 55, rows: 14, fontSize: 14 });
      terminal.open(container);
      // This is the explicit network boundary: all parsing, key handling, and menu state stay real.
      const socket = {
        readyState: WebSocket.OPEN,
        send: (data: string): void => {
          messages.push({ paneId, payload: JSON.parse(data) as TerminalClientMessage });
        },
      } as WebSocket;
      paneRuntimeMapRef.current.set(paneId, { terminal, socket });
      const input = terminal.onData((data) => {
        forwardTerminalInput({
          socket,
          paneId,
          data,
          updateAutocomplete: () => current.current.applyAutocompleteInputData(paneId, data),
        });
      });
      const keydown = (event: KeyboardEvent): void =>
        current.current.handleAutocompleteTerminalKeyDownRef.current(event, paneId);
      container.addEventListener('keydown', keydown, true);
      cleanup.push(() => {
        container.removeEventListener('keydown', keydown, true);
        input.dispose();
        terminal.dispose();
      });
    }
    /** Selects a real terminal and applies the production pane-change dismissal. */
    const focusPane = (paneId: string): void => {
      current.current.closeAutocompleteRef.current();
      activePaneIdRef.current = paneId;
      terminalRef.current = paneRuntimeMapRef.current.get(paneId)!.terminal;
      terminalContainerRef.current = paneId === 'pane-1' ? firstRef.current : secondRef.current;
      terminalRef.current.focus();
    };
    focusPane('pane-1');
    window.terminalInteractionFixture = {
      messages,
      warnings: warningsRef.current,
      directInput: (data) => {
        const paneId = activePaneIdRef.current;
        forwardTerminalInput({
          socket: runtimes.get(paneId)!.socket,
          paneId,
          data,
          updateAutocomplete: () => current.current.applyAutocompleteInputData(paneId, data),
        });
      },
      context: (changes) => {
        contextRef.current = { ...contextRef.current, ...changes };
        current.current.handleAutocompleteContext(activePaneIdRef.current, contextRef.current);
      },
      acceptResult: (status) => {
        const request = [...messages].reverse().find((entry) => entry.payload.type === 'completion-accept');
        if (!request || request.payload.type !== 'completion-accept') throw new Error('No accepted suggestion');
        current.current.handleCompletionAcceptResult(
          { type: 'completion-accept-result', requestId: request.payload.requestId, status },
          request.paneId,
        );
      },
      setInputAllowed: (allowed) => setSettings((previous) => ({ ...previous, inputAllowed: allowed })),
      setHistoryEnabled: (enabled) => setSettings((previous) => ({ ...previous, historyEnabled: enabled })),
      failNextMenuReset: () => {
        const menu = current.current.autocompleteMenuRef.current!;
        const reset = menu.reset;
        menu.reset = () => {
          menu.reset = reset;
          throw new Error('Controlled optional menu failure');
        };
      },
      accept: (index) =>
        current.current.acceptAutocompleteCandidate(current.current.autocompleteItems[index]?.id ?? null),
      transportCallbackChanges: 0,
      reset: async (next = {}) => {
        for (const paneId of runtimes.keys()) current.current.resetAutocompletePaneState(paneId);
        setSettings({ ...defaults, ...next });
        contextRef.current = {
          ...contextRef.current,
          editorAvailable: true,
          status: 'ready',
          reason: null,
          revision: 1,
          sessionId: 'fixture-session',
          shellInstanceId: '94eb0ed9-993f-4517-925a-d28e5139fce0',
          promptGeneration: 1,
        };
        warningsRef.current.length = 0;
        messages.length = 0;
        focusPane('pane-1');
        for (const pane of paneRuntimeMapRef.current.values()) {
          await new Promise<void>((resolve) => pane.terminal.write('\x1b[?1049l\x1bc$ gi', resolve));
        }
      },
      show: () => current.current.scheduleAutocompleteRequestRef.current(activePaneIdRef.current, 'typing'),
      respond: (changes = {}) => {
        const request = [...messages].reverse().find((entry) => entry.payload.type === 'completion-query');
        if (!request || request.payload.type !== 'completion-query') throw new Error('No completion request');
        current.current.handleCompletionResponse(
          {
            type: 'completion-update',
            requestId: request.payload.requestId,
            snapshotId: 'f29c8bcf-f1ba-4a11-9aa8-b81dce3e0375',
            contextRevision: contextRef.current.revision,
            status: 'ready',
            complete: true,
            sources: { history: 'ok', metadata: 'disabled', paths: 'disabled', native: 'disabled' },
            items: ['git status', 'git stash'].map((label, index) => ({
              id: `10e2fbb0-d264-40f0-a99c-a28290ce324${index}`,
              label,
              detail: 'Fixture history',
              source: 'history',
              kind: 'history',
            })),
            ...changes,
          },
          request.paneId,
        );
      },
      focusPane,
      output: (data) => new Promise<void>((resolve) => terminalRef.current!.write(data, resolve)),
      alternate: (enabled) =>
        new Promise<void>((resolve) => terminalRef.current!.write(enabled ? '\x1b[?1049h' : '\x1b[?1049l', resolve)),
    };
    setReady(true);
    return () => {
      delete window.terminalInteractionFixture;
      cleanup.forEach((dispose) => dispose());
      runtimes.clear();
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative p-4"
    >
      <button
        type="button"
        id="outside"
      >
        Outside terminal
      </button>
      <div className="flex gap-4">
        <div
          ref={firstRef}
          id="pane-1"
        />
        <div
          ref={secondRef}
          id="pane-2"
        />
      </div>
      <TerminalAutocompleteMenu
        ref={autocomplete.autocompleteMenuRef}
        open={autocomplete.autocompleteItems.length > 0 && autocomplete.autocompleteAnchor !== null}
        focused={autocomplete.autocompleteFocused}
        inputElement={autocomplete.autocompleteInputElement}
        focusShortcutLabel="Ctrl+Shift+Space"
        anchorTop={autocomplete.autocompleteAnchor?.top ?? 0}
        anchorLeft={autocomplete.autocompleteAnchor?.left ?? 0}
        panelWidth={autocomplete.autocompleteAnchor?.panelWidth ?? 340}
        renderAbove={false}
        items={autocomplete.autocompleteItems}
        onFocusList={autocomplete.focusAutocomplete}
        onRequestList={autocomplete.requestAutocompleteFocus}
        onItemSelect={autocomplete.acceptAutocompleteCandidate}
      />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<AutocompleteFixture />);
