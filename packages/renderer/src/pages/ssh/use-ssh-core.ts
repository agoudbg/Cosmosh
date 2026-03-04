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
type PaneSessionRuntime = {
  paneId: string;
  isPrimary: boolean;
  terminal: Terminal | null;
  socket: WebSocket | null;
  container: HTMLDivElement | null;
};

/**
 * Runtime session coordinator for pane-level socket/terminal routing.
 */
class SshRuntimeCoordinator {
  public primaryPaneId = 'pane-1';
  public activePaneId = 'pane-1';
  public paneIdSequence = 1;
  public activeTerminal: Terminal | null = null;
  public primaryTerminal: Terminal | null = null;
  public activeSocket: WebSocket | null = null;
  public primarySocket: WebSocket | null = null;
  public activeContainer: HTMLDivElement | null = null;
  public resolvedTarget: ResolvedTerminalTarget | null = null;
  public scheduleFitAndResizeSync: (() => void) | null = null;
  public connectSession: (() => void) | null = null;
  public selectionPointerClientX: number | null = null;
  public readonly paneContainerMap: Map<string, HTMLDivElement> = new Map();
  public readonly mirrorPaneRuntimeMap: Map<string, MirrorPaneRuntime> = new Map();
  public readonly sessionMap: Map<string, PaneSessionRuntime> = new Map();

  /**
   * Returns existing pane session entry or creates one lazily.
   *
   * @param paneId Logical pane identifier.
   * @returns Mutable pane session runtime entry.
   */
  public ensureSession(paneId: string): PaneSessionRuntime {
    const existing = this.sessionMap.get(paneId);
    if (existing) {
      return existing;
    }

    const created: PaneSessionRuntime = {
      paneId,
      isPrimary: paneId === this.primaryPaneId,
      terminal: null,
      socket: null,
      container: null,
    };
    this.sessionMap.set(paneId, created);
    return created;
  }

  /**
   * Applies active pane routing to terminal/socket/container handles.
   *
   * @param paneId Pane id that should become active.
   * @param terminalContainerRef Mutable active container ref used by view hooks.
   * @returns Nothing.
   */
  public applyActivePane(paneId: string, terminalContainerRef: React.MutableRefObject<HTMLDivElement | null>): void {
    this.activePaneId = paneId;
    const session = this.ensureSession(paneId);

    this.activeTerminal = session.terminal;
    this.activeSocket = session.socket;
    this.activeContainer = session.container;

    if (session.container) {
      terminalContainerRef.current = session.container;
    }
  }
}

/**
 * Creates a stable mutable ref adapter over a runtime object field.
 *
 * @param runtimeRef Runtime container ref.
 * @param getValue Getter for target field.
 * @param setValue Setter for target field.
 * @returns Mutable ref facade compatible with existing hooks.
 */
const useRuntimeFieldRef = <T>(
  runtimeRef: React.MutableRefObject<SshRuntimeCoordinator>,
  getValue: (runtime: SshRuntimeCoordinator) => T,
  setValue: (runtime: SshRuntimeCoordinator, value: T) => void,
): React.MutableRefObject<T> => {
  const fieldRef = React.useRef<React.MutableRefObject<T> | null>(null);

  if (!fieldRef.current) {
    const refFacade: React.MutableRefObject<T> = {
      get current(): T {
        return getValue(runtimeRef.current);
      },
      set current(value: T) {
        setValue(runtimeRef.current, value);
      },
    };

    fieldRef.current = refFacade;
  }

  return fieldRef.current;
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
  const runtimeRef = React.useRef(new SshRuntimeCoordinator());
  const primaryPaneIdRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primaryPaneId,
    (runtime, value) => {
      runtime.primaryPaneId = value;
    },
  );
  const activePaneIdRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.activePaneId,
    (runtime, value) => {
      runtime.activePaneId = value;
    },
  );
  const onTabTitleChangeRef = React.useRef<UseSshCoreParams['onTabTitleChange']>(onTabTitleChange);
  const fingerprintPromptResolverRef = React.useRef<((accepted: boolean) => void) | null>(null);

  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const terminalRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.activeTerminal,
    (runtime, value) => {
      runtime.activeTerminal = value;
    },
  );
  const primaryTerminalRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primaryTerminal,
    (runtime, value) => {
      runtime.primaryTerminal = value;
    },
  );
  const primarySocketRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primarySocket,
    (runtime, value) => {
      runtime.primarySocket = value;
    },
  );
  const socketRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.activeSocket,
    (runtime, value) => {
      runtime.activeSocket = value;
    },
  );
  const resolvedTerminalTargetRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.resolvedTarget,
    (runtime, value) => {
      runtime.resolvedTarget = value;
    },
  );
  const paneContainerMapRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.paneContainerMap,
    () => undefined,
  );
  const mirrorPaneRuntimeMapRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.mirrorPaneRuntimeMap,
    () => undefined,
  );
  const scheduleFitAndResizeSyncRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.scheduleFitAndResizeSync,
    (runtime, value) => {
      runtime.scheduleFitAndResizeSync = value;
    },
  );
  const connectSessionRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.connectSession,
    (runtime, value) => {
      runtime.connectSession = value;
    },
  );
  const selectionPointerClientXRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.selectionPointerClientX,
    (runtime, value) => {
      runtime.selectionPointerClientX = value;
    },
  );
  const terminalInitOptionsRef = React.useRef<ITerminalOptions>(terminalInitOptions);
  const sshConnectionTimeoutSecRef = React.useRef<number>(sshConnectionTimeoutSec);

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
  }, [activePaneId, activePaneIdRef]);

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
      const runtime = runtimeRef.current;
      runtime.activePaneId = paneId;
      setActivePaneId(paneId);

      const mirrorRuntime = runtime.mirrorPaneRuntimeMap.get(paneId);
      const paneSession = runtime.ensureSession(paneId);
      paneSession.isPrimary = paneId === runtime.primaryPaneId;
      paneSession.terminal = paneSession.isPrimary
        ? runtime.primaryTerminal
        : (mirrorRuntime?.terminal ?? paneSession.terminal);
      paneSession.socket = paneSession.isPrimary
        ? runtime.primarySocket
        : (mirrorRuntime?.socket ?? paneSession.socket);
      paneSession.container = runtime.paneContainerMap.get(paneId) ?? paneSession.container;
      runtime.applyActivePane(paneId, terminalContainerRef);

      if (didPaneChange) {
        closeAutocompleteRef.current();
      }

      refreshSelectionAnchorRef.current();
    },
    [activePaneIdRef, closeAutocompleteRef],
  );

  React.useEffect(() => {
    const nextPrimaryPaneId = terminalPaneIds[0] ?? 'pane-1';
    primaryPaneIdRef.current = nextPrimaryPaneId;

    if (!terminalPaneIds.includes(activePaneIdRef.current)) {
      activatePane(nextPrimaryPaneId);
    }
  }, [activatePane, activePaneIdRef, primaryPaneIdRef, terminalPaneIds]);

  /**
   * Registers or unregisters pane container elements used by split runtimes.
   *
   * @param paneId Logical pane id.
   * @param element Pane container element, or `null` on unmount.
   * @returns Nothing.
   */
  const setPaneContainerElement = React.useCallback((paneId: string, element: HTMLDivElement | null) => {
    const runtime = runtimeRef.current;
    const existingElement = runtime.paneContainerMap.get(paneId) ?? null;

    if (element) {
      if (existingElement === element) {
        return;
      }

      runtime.paneContainerMap.set(paneId, element);
      runtime.ensureSession(paneId).container = element;
      return;
    }

    if (!existingElement) {
      return;
    }

    runtime.paneContainerMap.delete(paneId);
    runtime.ensureSession(paneId).container = null;
  }, []);

  /**
   * Registers primary pane container for initial xterm mount.
   *
   * @param element Primary pane container or `null` on unmount.
   * @returns Nothing.
   */
  const setPrimaryPaneContainer = React.useCallback((element: HTMLDivElement | null) => {
    const runtime = runtimeRef.current;
    runtime.ensureSession(runtime.primaryPaneId).container = element;

    if (runtime.activePaneId === runtime.primaryPaneId) {
      terminalContainerRef.current = element;
      runtime.activeContainer = element;
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
    [activatePane, activePaneIdRef, primaryPaneIdRef],
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
    const runtime = runtimeRef.current;
    const primarySession = runtime.ensureSession(runtime.primaryPaneId);
    primarySession.isPrimary = true;
    primarySession.terminal = runtime.primaryTerminal;
    primarySession.socket = runtime.primarySocket;
    primarySession.container = runtime.paneContainerMap.get(runtime.primaryPaneId) ?? primarySession.container;

    runtime.mirrorPaneRuntimeMap.forEach((mirrorRuntime, paneId) => {
      const session = runtime.ensureSession(paneId);
      session.isPrimary = paneId === runtime.primaryPaneId;
      session.terminal = mirrorRuntime.terminal;
      session.socket = mirrorRuntime.socket;
      session.container = runtime.paneContainerMap.get(paneId) ?? mirrorRuntime.containerElement ?? session.container;
    });

    runtime.sessionMap.forEach((_, paneId) => {
      if (!terminalPaneIds.includes(paneId)) {
        runtime.sessionMap.delete(paneId);
      }
    });

    runtime.applyActivePane(activePaneId, terminalContainerRef);
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
  }, [connectSessionRef, connectionState]);

  /**
   * Sends input bytes to active pane websocket.
   *
   * @param data Raw input payload.
   * @returns Nothing.
   */
  const sendInput = React.useCallback(
    (data: string) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      sendClientMessage(socket, {
        type: 'input',
        data,
      });
    },
    [socketRef],
  );

  /**
   * Requests deletion of one command from active pane history source.
   *
   * @param command Command text selected in sidebar history list.
   * @returns Nothing.
   */
  const deleteHistoryCommand = React.useCallback(
    (command: string) => {
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
    },
    [socketRef],
  );

  /**
   * Selects all content in active terminal instance.
   *
   * @returns Nothing.
   */
  const selectAll = React.useCallback(() => {
    terminalRef.current?.selectAll();
  }, [terminalRef]);

  /**
   * Reads active terminal selected text.
   *
   * @returns Current selected text or empty string.
   */
  const getSelectionText = React.useCallback((): string => {
    return terminalRef.current?.getSelection() ?? '';
  }, [terminalRef]);

  /**
   * Focuses active terminal instance.
   *
   * @returns Nothing.
   */
  const focusActiveTerminal = React.useCallback(() => {
    terminalRef.current?.focus();
  }, [terminalRef]);

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
