import { type ITerminalOptions, type Terminal } from '@xterm/xterm';
import React from 'react';

import type { TerminalAutocompleteMenuHandle } from '../../components/terminal/terminal-autocomplete-menu';
import { resolveTerminalTarget } from './ssh-target';
import {
  DEFAULT_TELEMETRY_STATE,
  type HostFingerprintPrompt,
  MAX_TERMINAL_PANES,
  type MirrorPaneRuntime,
  type ResolvedTerminalTarget,
  type SshTelemetryState,
  type TerminalAutocompleteAnchor,
  type TerminalSelectionAnchor,
  type TerminalSelectionBarPosition,
} from './ssh-types';
import { sendClientMessage } from './ssh-utils';
import { useSshAutocomplete } from './use-ssh-autocomplete';
import { useSshMirrorPanes } from './use-ssh-mirror-panes';
import { useSshPrimarySession } from './use-ssh-primary-session';
import { useSshSelectionBar } from './use-ssh-selection-bar';

/**
 * Connection lifecycle states for SSH page sessions.
 */
export type SshConnectionState = 'connecting' | 'connected' | 'failed';

/**
 * Runtime-only mutable resources that should not trigger React renders.
 */
type SshRuntimeState = {
  terminalContainer: HTMLDivElement | null;
  activeTerminal: Terminal | null;
  primaryTerminal: Terminal | null;
  activeSocket: WebSocket | null;
  primarySocket: WebSocket | null;
  paneContainerMap: Map<string, HTMLDivElement>;
  mirrorPaneRuntimeMap: Map<string, MirrorPaneRuntime>;
  resolvedTarget: ResolvedTerminalTarget | null;
  scheduleFitAndResizeSync: (() => void) | null;
  connectSession: (() => void) | null;
  selectionPointerClientX: number | null;
  paneIdSequence: number;
};

/**
 * Input parameters for `useSshCore`.
 */
export type UseSshCoreParams = {
  terminalInitOptions: ITerminalOptions;
  sshConnectionTimeoutSec: number;
  terminalAutoCompleteEnabled: boolean;
  terminalAutoCompleteMinChars: number;
  terminalAutoCompleteMaxItems: number;
  terminalAutoCompleteFuzzyMatch: boolean;
  terminalSelectionBarEnabled: boolean;
  onTabTitleChange?: (title: string) => void;
  requestHostFingerprintTrust?: (prompt: HostFingerprintPrompt) => Promise<boolean>;
  notifyWarning: (message: string) => void;
};

/**
 * Declarative state exposed by `useSshCore`.
 */
export type SshCoreState = {
  terminalPaneIds: string[];
  activePaneId: string;
  connectionState: SshConnectionState;
  connectionError: string;
  telemetryState: SshTelemetryState;
  hostFingerprintPrompt: HostFingerprintPrompt | null;
  canSplitTerminal: boolean;
  selectionAnchor: TerminalSelectionAnchor | null;
  selectionBarPosition: TerminalSelectionBarPosition | null;
  dismissedSelectionText: string | null;
  autocompleteItems: ReturnType<typeof useSshAutocomplete>['autocompleteItems'];
  autocompleteAnchor: TerminalAutocompleteAnchor | null;
};

/**
 * Declarative operations exposed by `useSshCore`.
 */
export type SshCoreActions = {
  /**
   * Activates a pane and routes follow-up input/socket interactions to it.
   *
   * @param paneId Logical pane identifier to activate.
   * @returns Nothing.
   */
  activatePane: (paneId: string) => void;
  /**
   * Splits terminal layout by creating one mirrored pane when capacity allows.
   *
   * @returns Nothing.
   */
  splitPane: () => void;
  /**
   * Closes one pane and keeps the remaining active pane deterministic.
   *
   * @param paneId Logical pane identifier to close.
   * @returns Nothing.
   */
  closePane: (paneId: string) => void;
  /**
   * Retries session connection when page is in failed state.
   *
   * @returns Nothing.
   */
  retryConnection: () => void;
  /**
   * Sends raw input data to current active pane session.
   *
   * @param data Raw terminal input bytes encoded as string.
   * @returns Nothing.
   */
  sendInput: (data: string) => void;
  /**
   * Sends command-history deletion request for current active session.
   *
   * @param command Normalized command string to remove.
   * @returns Nothing.
   */
  deleteHistoryCommand: (command: string) => void;
  /**
   * Selects all text in currently active terminal.
   *
   * @returns Nothing.
   */
  selectAll: () => void;
  /**
   * Returns current terminal selection text from active pane.
   *
   * @returns Selection text, or empty string.
   */
  getSelectionText: () => string;
  /**
   * Focuses currently active terminal instance.
   *
   * @returns Nothing.
   */
  focusActiveTerminal: () => void;
  /**
   * Sends ANSI clear-screen control sequence to current active session.
   *
   * @returns Nothing.
   */
  clearTerminalScreen: () => void;
  /**
   * Registers pane container element for runtime routing and layout sync.
   *
   * @param paneId Logical pane identifier.
   * @param element Current pane DOM element.
   * @returns Nothing.
   */
  setPaneContainerElement: (paneId: string, element: HTMLDivElement | null) => void;
  /**
   * Registers primary pane container for xterm mounting.
   *
   * @param element Primary pane container element.
   * @returns Nothing.
   */
  setPrimaryPaneContainer: (element: HTMLDivElement | null) => void;
  /**
   * Resolves host fingerprint prompt and unblocks pending connect flow.
   *
   * @param accepted Whether user accepted trust.
   * @returns Nothing.
   */
  resolveHostFingerprintPrompt: (accepted: boolean) => void;
  /**
   * Dismisses current floating selection toolbar.
   *
   * @returns Nothing.
   */
  dismissSelectionBar: () => void;
  /**
   * Accepts one autocomplete candidate by list index.
   *
   * @param index Candidate index in current suggestion list.
   * @returns Nothing.
   */
  acceptAutocompleteAtIndex: (index: number) => void;
};

/**
 * Ref handles required by SSH view/container-level interaction wiring.
 */
export type SshCoreRefs = {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  selectionBarRef: React.RefObject<HTMLDivElement | null>;
  autocompleteMenuRef: React.RefObject<TerminalAutocompleteMenuHandle | null>;
};

/**
 * Complete return type for `useSshCore`.
 */
export type UseSshCoreResult = {
  state: SshCoreState;
  actions: SshCoreActions;
  refs: SshCoreRefs;
};

/**
 * Central SSH runtime coordinator with declarative state and actions.
 *
 * This hook consolidates connection status, pane activation, host-trust dialog
 * state, and terminal runtime resources under one stable API so `SSH.tsx`
 * can remain view-focused and avoid imperative ref orchestration.
 *
 * @param params Settings-driven behavior and host trust callback dependencies.
 * @returns Declarative SSH page model (state + actions + required DOM refs).
 */
export const useSshCore = (params: UseSshCoreParams): UseSshCoreResult => {
  const {
    terminalInitOptions,
    sshConnectionTimeoutSec,
    terminalAutoCompleteEnabled,
    terminalAutoCompleteMinChars,
    terminalAutoCompleteMaxItems,
    terminalAutoCompleteFuzzyMatch,
    terminalSelectionBarEnabled,
    onTabTitleChange,
    requestHostFingerprintTrust,
    notifyWarning,
  } = params;

  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const selectionBarRef = React.useRef<HTMLDivElement | null>(null);
  const primaryPaneIdRef = React.useRef<string>('pane-1');
  const activePaneIdRef = React.useRef<string>('pane-1');
  const onTabTitleChangeRef = React.useRef<UseSshCoreParams['onTabTitleChange']>(onTabTitleChange);
  const fingerprintPromptResolverRef = React.useRef<((accepted: boolean) => void) | null>(null);

  const terminalRef = React.useRef<Terminal | null>(null);
  const primaryTerminalRef = React.useRef<Terminal | null>(null);
  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const primarySocketRef = React.useRef<WebSocket | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const resolvedTerminalTargetRef = React.useRef<ResolvedTerminalTarget | null>(null);
  const paneContainerMapRef = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const mirrorPaneRuntimeMapRef = React.useRef<Map<string, MirrorPaneRuntime>>(new Map());
  const scheduleFitAndResizeSyncRef = React.useRef<(() => void) | null>(null);
  const connectSessionRef = React.useRef<(() => void) | null>(null);
  const selectionPointerClientXRef = React.useRef<number | null>(null);
  const terminalInitOptionsRef = React.useRef<ITerminalOptions>(terminalInitOptions);
  const sshConnectionTimeoutSecRef = React.useRef<number>(sshConnectionTimeoutSec);

  const runtimeRef = React.useRef<SshRuntimeState>({
    terminalContainer: null,
    activeTerminal: null,
    primaryTerminal: null,
    activeSocket: null,
    primarySocket: null,
    paneContainerMap: paneContainerMapRef.current,
    mirrorPaneRuntimeMap: mirrorPaneRuntimeMapRef.current,
    resolvedTarget: null,
    scheduleFitAndResizeSync: null,
    connectSession: null,
    selectionPointerClientX: null,
    paneIdSequence: 1,
  });

  const [terminalPaneIds, setTerminalPaneIds] = React.useState<string[]>(['pane-1']);
  const [activePaneId, setActivePaneId] = React.useState<string>('pane-1');
  const [connectionState, setConnectionState] = React.useState<SshConnectionState>('connecting');
  const [connectionError, setConnectionError] = React.useState<string>('');
  const [telemetryState, setTelemetryState] = React.useState<SshTelemetryState>(DEFAULT_TELEMETRY_STATE);
  const [hostFingerprintPrompt, setHostFingerprintPrompt] = React.useState<HostFingerprintPrompt | null>(null);

  React.useEffect(() => {
    onTabTitleChangeRef.current = onTabTitleChange;
  }, [onTabTitleChange]);

  React.useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  React.useEffect(() => {
    terminalInitOptionsRef.current = terminalInitOptions;
  }, [terminalInitOptions]);

  React.useEffect(() => {
    sshConnectionTimeoutSecRef.current = sshConnectionTimeoutSec;
  }, [sshConnectionTimeoutSec]);

  const {
    autocompleteItems,
    autocompleteAnchor,
    autocompleteMenuRef,
    acceptAutocompleteAtIndex,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
  } = useSshAutocomplete({
    connectionState,
    terminalAutoCompleteEnabled,
    terminalAutoCompleteMinChars,
    terminalAutoCompleteMaxItems,
    terminalAutoCompleteFuzzyMatch,
    wrapperRef,
    terminalContainerRef,
    terminalRef,
    socketRef,
    primaryPaneIdRef,
    activePaneIdRef,
    primarySocketRef,
    primaryTerminalRef,
    mirrorPaneRuntimeMapRef,
  });

  const {
    selectionAnchor,
    selectionBarPosition,
    dismissedSelectionText,
    refreshSelectionAnchor,
    dismissSelectionBar,
    clearSelectionOverlay,
  } = useSshSelectionBar({
    terminalRef,
    terminalContainerRef,
    wrapperRef,
    selectionBarRef,
    selectionPointerClientXRef,
    enabled: terminalSelectionBarEnabled,
  });

  const refreshSelectionAnchorRef = React.useRef(refreshSelectionAnchor);
  const clearSelectionOverlayRef = React.useRef(clearSelectionOverlay);

  React.useEffect(() => {
    refreshSelectionAnchorRef.current = refreshSelectionAnchor;
    clearSelectionOverlayRef.current = clearSelectionOverlay;
  }, [clearSelectionOverlay, refreshSelectionAnchor]);

  /**
   * Switches active pane routing for terminal, socket and geometry tracking.
   *
   * @param paneId Logical pane identifier to activate.
   * @returns Nothing.
   */
  const activatePane = React.useCallback(
    (paneId: string) => {
      const didPaneChange = activePaneIdRef.current !== paneId;
      activePaneIdRef.current = paneId;
      setActivePaneId(paneId);

      const isPrimaryPane = paneId === primaryPaneIdRef.current;
      const nextTerminal = isPrimaryPane
        ? primaryTerminalRef.current
        : (mirrorPaneRuntimeMapRef.current.get(paneId)?.terminal ?? null);
      const nextContainer = paneContainerMapRef.current.get(paneId) ?? null;
      const nextSocket = isPrimaryPane
        ? primarySocketRef.current
        : (mirrorPaneRuntimeMapRef.current.get(paneId)?.socket ?? null);

      if (nextTerminal) {
        terminalRef.current = nextTerminal;
      }

      if (nextContainer) {
        terminalContainerRef.current = nextContainer;
      }

      socketRef.current = nextSocket;
      runtimeRef.current.activeTerminal = terminalRef.current;
      runtimeRef.current.activeSocket = socketRef.current;
      runtimeRef.current.terminalContainer = terminalContainerRef.current;

      if (didPaneChange) {
        closeAutocompleteRef.current();
      }

      refreshSelectionAnchorRef.current();
    },
    [closeAutocompleteRef],
  );

  React.useEffect(() => {
    const nextPrimaryPaneId = terminalPaneIds[0] ?? 'pane-1';
    primaryPaneIdRef.current = nextPrimaryPaneId;

    if (!terminalPaneIds.includes(activePaneIdRef.current)) {
      activatePane(nextPrimaryPaneId);
    }
  }, [activatePane, terminalPaneIds]);

  /**
   * Registers or unregisters pane container elements used by split runtimes.
   *
   * @param paneId Logical pane id.
   * @param element Pane container element, or `null` on unmount.
   * @returns Nothing.
   */
  const setPaneContainerElement = React.useCallback((paneId: string, element: HTMLDivElement | null) => {
    const existingElement = paneContainerMapRef.current.get(paneId) ?? null;

    if (element) {
      if (existingElement === element) {
        return;
      }

      paneContainerMapRef.current.set(paneId, element);
      runtimeRef.current.paneContainerMap = paneContainerMapRef.current;
      return;
    }

    if (!existingElement) {
      return;
    }

    paneContainerMapRef.current.delete(paneId);
    runtimeRef.current.paneContainerMap = paneContainerMapRef.current;
  }, []);

  /**
   * Registers primary pane container for initial xterm mount.
   *
   * @param element Primary pane container or `null` on unmount.
   * @returns Nothing.
   */
  const setPrimaryPaneContainer = React.useCallback((element: HTMLDivElement | null) => {
    if (activePaneIdRef.current === primaryPaneIdRef.current) {
      terminalContainerRef.current = element;
      runtimeRef.current.terminalContainer = element;
    }
  }, []);

  /**
   * Adds one mirrored pane until hard pane limit is reached.
   *
   * @returns Nothing.
   */
  const splitPane = React.useCallback(() => {
    setTerminalPaneIds((previous) => {
      if (previous.length >= MAX_TERMINAL_PANES) {
        return previous;
      }

      runtimeRef.current.paneIdSequence += 1;
      return [...previous, `pane-${runtimeRef.current.paneIdSequence}`];
    });
  }, []);

  /**
   * Removes one mirrored pane and preserves stable active pane routing.
   *
   * @param paneId Pane id to remove.
   * @returns Nothing.
   */
  const closePane = React.useCallback(
    (paneId: string) => {
      setTerminalPaneIds((previous) => {
        if (previous.length <= 1) {
          return previous;
        }

        const index = previous.indexOf(paneId);
        if (index < 0) {
          return previous;
        }

        const next = previous.filter((item) => item !== paneId);
        if (next.length === 0) {
          return previous;
        }

        if (activePaneIdRef.current === paneId) {
          const nextPaneId = next[Math.max(0, index - 1)] ?? next[0] ?? primaryPaneIdRef.current;
          activatePane(nextPaneId);
        }

        return next;
      });
    },
    [activatePane],
  );

  /**
   * Resolves pending fingerprint trust prompt and unblocks connect flow.
   *
   * @param accepted User trust decision.
   * @returns Nothing.
   */
  const resolveHostFingerprintPrompt = React.useCallback((accepted: boolean) => {
    const resolver = fingerprintPromptResolverRef.current;
    fingerprintPromptResolverRef.current = null;
    setHostFingerprintPrompt(null);
    resolver?.(accepted);
  }, []);

  /**
   * Opens host trust dialog and waits for user confirmation.
   *
   * @param prompt Prompt payload shown in trust dialog.
   * @returns Promise resolving to trust decision.
   */
  const requestHostFingerprintTrustInternal = React.useCallback((prompt: HostFingerprintPrompt): Promise<boolean> => {
    return new Promise((resolve) => {
      fingerprintPromptResolverRef.current = resolve;
      setHostFingerprintPrompt(prompt);
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (fingerprintPromptResolverRef.current) {
        fingerprintPromptResolverRef.current(false);
        fingerprintPromptResolverRef.current = null;
      }
    };
  }, []);

  useSshPrimarySession({
    terminalInitOptionsRef,
    terminalContainerRef,
    terminalRef,
    primaryTerminalRef,
    primaryPaneIdRef,
    activePaneIdRef,
    primarySocketRef,
    socketRef,
    resolvedTerminalTargetRef,
    sshConnectionTimeoutSecRef,
    scheduleFitAndResizeSyncRef,
    connectSessionRef,
    selectionPointerClientXRef,
    onTabTitleChangeRef,
    setConnectionState,
    setConnectionError,
    setTelemetryState,
    requestHostFingerprintTrust: requestHostFingerprintTrust ?? requestHostFingerprintTrustInternal,
    setActivePane: activatePane,
    refreshSelectionAnchor,
    clearSelectionOverlay,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
  });

  useSshMirrorPanes({
    connectionState,
    terminalPaneIds,
    terminalInitOptionsRef,
    paneContainerMapRef,
    mirrorPaneRuntimeMapRef,
    primaryTerminalRef,
    selectionPointerClientXRef,
    activePaneIdRef,
    socketRef,
    resolvedTerminalTargetRef,
    sshConnectionTimeoutSecRef,
    scheduleFitAndResizeSyncRef,
    wrapperRef,
    setActivePane: activatePane,
    refreshSelectionAnchor,
    handleAutocompleteTerminalKeyDownRef,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleCompletionResponse,
    requestHostFingerprintTrust: requestHostFingerprintTrust ?? requestHostFingerprintTrustInternal,
    resolveTerminalTarget,
    notifyWarning,
  });

  React.useEffect(() => {
    runtimeRef.current.activeTerminal = terminalRef.current;
    runtimeRef.current.primaryTerminal = primaryTerminalRef.current;
    runtimeRef.current.activeSocket = socketRef.current;
    runtimeRef.current.primarySocket = primarySocketRef.current;
    runtimeRef.current.resolvedTarget = resolvedTerminalTargetRef.current;
    runtimeRef.current.scheduleFitAndResizeSync = scheduleFitAndResizeSyncRef.current;
    runtimeRef.current.connectSession = connectSessionRef.current;
    runtimeRef.current.selectionPointerClientX = selectionPointerClientXRef.current;
  }, [connectionState, terminalPaneIds, activePaneId]);

  /**
   * Retries failed terminal connection using current session connector.
   *
   * @returns Nothing.
   */
  const retryConnection = React.useCallback(() => {
    if (connectionState === 'connecting' || connectionState === 'connected') {
      return;
    }

    connectSessionRef.current?.();
  }, [connectionState]);

  /**
   * Sends input bytes to active pane websocket.
   *
   * @param data Raw input payload.
   * @returns Nothing.
   */
  const sendInput = React.useCallback((data: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'input',
      data,
    });
  }, []);

  /**
   * Requests deletion of one command from active pane history source.
   *
   * @param command Command text selected in sidebar history list.
   * @returns Nothing.
   */
  const deleteHistoryCommand = React.useCallback((command: string) => {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'history-delete',
      command: normalizedCommand,
    });
  }, []);

  /**
   * Selects all content in active terminal instance.
   *
   * @returns Nothing.
   */
  const selectAll = React.useCallback(() => {
    terminalRef.current?.selectAll();
  }, []);

  /**
   * Reads active terminal selected text.
   *
   * @returns Current selected text or empty string.
   */
  const getSelectionText = React.useCallback((): string => {
    return terminalRef.current?.getSelection() ?? '';
  }, []);

  /**
   * Focuses active terminal instance.
   *
   * @returns Nothing.
   */
  const focusActiveTerminal = React.useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  /**
   * Sends Ctrl+L clear-screen sequence to active session.
   *
   * @returns Nothing.
   */
  const clearTerminalScreen = React.useCallback(() => {
    sendInput('\x0c');
  }, [sendInput]);

  return {
    state: {
      terminalPaneIds,
      activePaneId,
      connectionState,
      connectionError,
      telemetryState,
      hostFingerprintPrompt,
      canSplitTerminal: terminalPaneIds.length < MAX_TERMINAL_PANES,
      selectionAnchor,
      selectionBarPosition,
      dismissedSelectionText,
      autocompleteItems,
      autocompleteAnchor,
    },
    actions: {
      activatePane,
      splitPane,
      closePane,
      retryConnection,
      sendInput,
      deleteHistoryCommand,
      selectAll,
      getSelectionText,
      focusActiveTerminal,
      clearTerminalScreen,
      setPaneContainerElement,
      setPrimaryPaneContainer,
      resolveHostFingerprintPrompt,
      dismissSelectionBar,
      acceptAutocompleteAtIndex,
    },
    refs: {
      wrapperRef,
      terminalContainerRef,
      selectionBarRef,
      autocompleteMenuRef,
    },
  };
};
