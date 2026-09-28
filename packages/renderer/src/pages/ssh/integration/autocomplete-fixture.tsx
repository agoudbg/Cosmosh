import '@xterm/xterm/css/xterm.css';
import '../../../index.css';

import type { SettingsValues, TerminalClientMessage } from '@cosmosh/api-contract';
import { Terminal } from '@xterm/xterm';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { TerminalAutocompleteMenu } from '../../../components/terminal/terminal-autocomplete-menu';
import type { TerminalPaneRuntime } from '../ssh-types';
import { useSshAutocomplete } from '../use-ssh-autocomplete';

type FixtureSettings = {
  enabled: boolean;
  isActive: boolean;
  connected: boolean;
  acceptKeys: SettingsValues['terminalAutoCompleteAcceptKeys'];
};
type RecordedMessage = { paneId: string; payload: TerminalClientMessage };
type FixtureController = {
  messages: RecordedMessage[];
  transportCallbackChanges: number;
  reset: (settings?: Partial<FixtureSettings>) => Promise<void>;
  show: () => void;
  respond: () => void;
  focusPane: (paneId: string) => void;
  alternate: (enabled: boolean) => Promise<void>;
  output: (data: string) => Promise<void>;
};

declare global {
  interface Window {
    terminalInteractionFixture?: FixtureController;
  }
}

const defaults: FixtureSettings = { enabled: true, isActive: true, connected: true, acceptKeys: 'tab' };

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
  const autocomplete = useSshAutocomplete({
    isActive: settings.isActive,
    connectionState: settings.connected ? 'connected' : 'failed',
    terminalAutoCompleteEnabled: settings.enabled,
    terminalAutoCompleteHistoryEnabled: true,
    terminalAutoCompleteBuiltInCommandsEnabled: true,
    terminalAutoCompletePathEnabled: false,
    terminalAutoCompletePasswordEnabled: false,
    terminalAutoCompleteAcceptKeys: settings.acceptKeys,
    terminalAutoCompleteFocusShortcut: 'ctrlShiftSpace',
    terminalAutoCompleteMinChars: 1,
    terminalAutoCompleteMaxItems: 8,
    terminalAutoCompleteFuzzyMatch: false,
    terminalAutoCompletePromptRegex: '',
    wrapperRef,
    terminalContainerRef,
    terminalRef,
    activePaneIdRef,
    paneRuntimeMapRef,
    getPaneLineState: () => null,
    getPaneTrustedCwd: () => null,
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
        current.current.applyAutocompleteInputData(paneId, data);
        messages.push({ paneId, payload: { type: 'input', data } });
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
      transportCallbackChanges: 0,
      reset: async (next = {}) => {
        for (const paneId of runtimes.keys()) current.current.resetAutocompletePaneState(paneId);
        setSettings({ ...defaults, ...next });
        messages.length = 0;
        focusPane('pane-1');
        for (const pane of paneRuntimeMapRef.current.values()) {
          await new Promise<void>((resolve) => pane.terminal.write('\x1b[?1049l\x1bc$ gi', resolve));
        }
      },
      show: () => current.current.scheduleAutocompleteRequestRef.current(activePaneIdRef.current, 'manual'),
      respond: () => {
        const request = [...messages].reverse().find((entry) => entry.payload.type === 'completion-request');
        if (!request || request.payload.type !== 'completion-request') throw new Error('No completion request');
        current.current.handleCompletionResponse(
          {
            type: 'completion-response',
            requestId: request.payload.requestId,
            replacePrefixLength: 2,
            items: ['git status', 'git stash'].map((label, index) => ({
              id: `fixture-${index}`,
              label,
              insertText: label,
              detail: 'Fixture history',
              source: 'history',
              kind: 'history',
              score: 10 - index,
            })),
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
        onItemSelect={autocomplete.acceptAutocompleteAtIndex}
      />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<AutocompleteFixture />);
