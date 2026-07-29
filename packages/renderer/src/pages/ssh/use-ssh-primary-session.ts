import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { type ITerminalOptions, type Terminal } from '@xterm/xterm';
import React from 'react';

import { closeLocalTerminalSession, closeSshSession } from '../../lib/backend';
import { t } from '../../lib/i18n';
import { resolveConnectMode, withResolvedSnapshot } from '../../lib/ssh-connection-intent';
import type { SshConnectionIntent, TabIconColorKey, TabIconKey } from '../../types/tabs';
import { clearTerminalCommandMarkers } from './ssh-command-markers';
import { openTerminalSessionSocket } from './ssh-session-connectors';
import {
  resolveTerminalTargetFromIntent,
  resolveTerminalTargetFromSnapshot,
  toResolvedTargetSnapshot,
} from './ssh-target';
import type { ResolvedTerminalTarget, ServerInboundMessage, TerminalPaneRuntime } from './ssh-types';
import { sendClientMessage } from './ssh-utils';
import {
  applyTerminalCharacterWidthCompatibilityMode,
  createTerminalInstance,
  loadTerminalAddons,
  resolveTerminalCharacterWidthCompatibilityMode,
  syncTerminalWebglAddon,
  type TerminalExternalLinkHandler,
  type TerminalHardwareAccelerationState,
  type TerminalInlineImageSettings,
  type TerminalWebglAddonRuntime,
  type TerminalWebLinksSettings,
} from './terminal-addons';
import { registerTerminalPresentationIntegration } from './terminal-presentation-integration';
import type { TerminalPresentationStateAction } from './terminal-presentation-state';
import type { TerminalClipboardProvider } from './use-terminal-clipboard-provider';

type UseSshPrimarySessionParams = {
  tabId: string;
  isActive: boolean;
  connectionIntent: SshConnectionIntent;
  onConnectionIntentChange: (nextIntent: SshConnectionIntent) => void;
  terminalInitOptionsRef: React.RefObject<ITerminalOptions>;
  hardwareAccelerationStateRef: React.RefObject<TerminalHardwareAccelerationState>;
  characterWidthCompatibilityModeEnabledRef: React.RefObject<boolean>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  primaryTerminalRef: React.RefObject<Terminal | null>;
  primarySearchAddonRef: React.RefObject<SearchAddon | null>;
  primarySerializeAddonRef: React.RefObject<SerializeAddon | null>;
  primaryWebglAddonRuntimeRef: React.RefObject<TerminalWebglAddonRuntime>;
  primaryPaneIdRef: React.RefObject<string>;
  activePaneIdRef: React.RefObject<string>;
  paneRuntimeMapRef: React.RefObject<Map<string, TerminalPaneRuntime>>;
  primarySocketRef: React.RefObject<WebSocket | null>;
  socketRef: React.RefObject<WebSocket | null>;
  resolvedTerminalTargetRef: React.RefObject<ResolvedTerminalTarget | null>;
  sshConnectionTimeoutSecRef: React.RefObject<number>;
  terminalClipboardProvider: TerminalClipboardProvider;
  terminalInlineImageSettingsRef: React.RefObject<TerminalInlineImageSettings>;
  terminalWebLinksSettingsRef: React.RefObject<TerminalWebLinksSettings>;
  openExternalLinkRef: React.RefObject<TerminalExternalLinkHandler>;
  scheduleFitAndResizeSyncRef: React.RefObject<(() => void) | null>;
  selectionPointerClientXRef: React.RefObject<number | null>;
  onTabTitleChangeRef: React.RefObject<((title: string) => void) | undefined>;
  onTabVisualChangeRef: React.RefObject<
    ((visual: { iconKey: TabIconKey; iconColorKey?: TabIconColorKey }) => void) | undefined
  >;
  resetPaneState: (paneId: string) => void;
  resetTerminalPresentationState: (paneId: string) => void;
  dispatchTerminalPresentationState: (action: TerminalPresentationStateAction) => void;
  acknowledgeTerminalBell: (paneId: string) => void;
  setPaneTransportState: (paneId: string, state: 'connecting' | 'connected' | 'failed', error?: string) => void;
  setSessionTargetReady: (ready: boolean) => void;
  handlePaneServerMessage: (paneId: string, terminal: Terminal, payload: ServerInboundMessage) => void;
  recordPaneInputCommandMarker: (paneId: string, inputData: string) => void;
  refreshCommandTimeline: () => void;
  requestHostFingerprintTrust: (prompt: {
    serverId: string;
    host: string;
    port: number;
    algorithm: string;
    fingerprint: string;
  }) => Promise<boolean>;
  setActivePane: (paneId: string) => void;
  refreshSelectionAnchor: () => string | null;
  onTerminalSelectionChange: (selectionText: string) => void;
  clearSelectionOverlay: () => void;
  applyAutocompleteInputData: (paneId: string, data: string) => { shouldRequest: boolean; shouldClose: boolean };
  closeAutocompleteRef: React.RefObject<() => void>;
  handleAutocompleteTerminalKeyDownRef: React.RefObject<(event: KeyboardEvent) => void>;
  notifyHardwareAccelerationContextLoss: () => void;
};

/**
 * Owns primary terminal instance lifecycle and primary websocket session wiring.
 *
 * @param params Runtime refs, callbacks and state setters required by primary session effect.
 * @returns Nothing.
 */
export const useSshPrimarySession = (params: UseSshPrimarySessionParams): void => {
  const {
    tabId,
    isActive,
    connectionIntent,
    onConnectionIntentChange,
    terminalInitOptionsRef,
    hardwareAccelerationStateRef,
    characterWidthCompatibilityModeEnabledRef,
    terminalContainerRef,
    terminalRef,
    primaryTerminalRef,
    primarySearchAddonRef,
    primarySerializeAddonRef,
    primaryWebglAddonRuntimeRef,
    primaryPaneIdRef,
    activePaneIdRef,
    paneRuntimeMapRef,
    primarySocketRef,
    socketRef,
    resolvedTerminalTargetRef,
    sshConnectionTimeoutSecRef,
    terminalClipboardProvider,
    terminalInlineImageSettingsRef,
    terminalWebLinksSettingsRef,
    openExternalLinkRef,
    scheduleFitAndResizeSyncRef,
    selectionPointerClientXRef,
    onTabTitleChangeRef,
    onTabVisualChangeRef,
    resetPaneState,
    resetTerminalPresentationState,
    dispatchTerminalPresentationState,
    acknowledgeTerminalBell,
    setPaneTransportState,
    setSessionTargetReady,
    handlePaneServerMessage,
    recordPaneInputCommandMarker,
    refreshCommandTimeline,
    requestHostFingerprintTrust,
    setActivePane,
    refreshSelectionAnchor,
    onTerminalSelectionChange,
    clearSelectionOverlay,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    handleAutocompleteTerminalKeyDownRef,
    notifyHardwareAccelerationContextLoss,
  } = params;

  const isActiveRef = React.useRef<boolean>(isActive);
  const connectionIntentRef = React.useRef<SshConnectionIntent>(connectionIntent);
  const tabIdRef = React.useRef<string>(tabId);
  const onConnectionIntentChangeRef = React.useRef<(nextIntent: SshConnectionIntent) => void>(onConnectionIntentChange);
  const onTerminalSelectionChangeRef = React.useRef<(selectionText: string) => void>(onTerminalSelectionChange);

  React.useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  React.useEffect(() => {
    connectionIntentRef.current = connectionIntent;
  }, [connectionIntent]);

  React.useEffect(() => {
    tabIdRef.current = tabId;
  }, [tabId]);

  React.useEffect(() => {
    onConnectionIntentChangeRef.current = onConnectionIntentChange;
  }, [onConnectionIntentChange]);

  React.useEffect(() => {
    onTerminalSelectionChangeRef.current = onTerminalSelectionChange;
  }, [onTerminalSelectionChange]);

  React.useEffect(() => {
    const paneId = primaryPaneIdRef.current;
    const terminal = createTerminalInstance(
      terminalInitOptionsRef.current,
      characterWidthCompatibilityModeEnabledRef.current,
    );
    const clipboardAddon = new ClipboardAddon(undefined, terminalClipboardProvider);
    const addonRuntime = loadTerminalAddons(
      terminal,
      terminalInlineImageSettingsRef.current,
      terminalWebLinksSettingsRef.current,
      (targetUrl) => {
        openExternalLinkRef.current(targetUrl);
      },
    );
    const { fitAddon, searchAddon, serializeAddon } = addonRuntime;
    primaryWebglAddonRuntimeRef.current = addonRuntime;
    terminal.loadAddon(clipboardAddon);

    const containerElement = terminalContainerRef.current;
    if (!containerElement) {
      terminalRef.current = null;
      primarySearchAddonRef.current = null;
      primarySerializeAddonRef.current = null;
      primaryWebglAddonRuntimeRef.current = { webglAddon: null };
      terminal.dispose();
      return;
    }

    resetTerminalPresentationState(paneId);
    const terminalPresentationIntegration = registerTerminalPresentationIntegration({
      paneId,
      terminal,
      dispatch: dispatchTerminalPresentationState,
    });
    terminal.open(containerElement);
    syncTerminalWebglAddon(
      terminal,
      addonRuntime,
      hardwareAccelerationStateRef.current,
      notifyHardwareAccelerationContextLoss,
    );
    primaryTerminalRef.current = terminal;
    primarySearchAddonRef.current = searchAddon;
    primarySerializeAddonRef.current = serializeAddon;
    terminalRef.current = terminal;
    let disposed = false;
    let retryFitFrameId: number | null = null;

    const hasRenderableSize = (): boolean => {
      const rect = containerElement.getBoundingClientRect();
      return rect.width > 16 && rect.height > 16;
    };

    const safeFit = (): boolean => {
      if (disposed) {
        return false;
      }

      if (!hasRenderableSize()) {
        return false;
      }

      try {
        fitAddon.fit();
        return true;
      } catch {
        return false;
      }
    };

    const retryFitUntilVisible = (): void => {
      if (disposed) {
        return;
      }

      if (safeFit()) {
        retryFitFrameId = null;
        return;
      }

      retryFitFrameId = requestAnimationFrame(retryFitUntilVisible);
    };

    retryFitUntilVisible();

    let socket: WebSocket | null = null;
    let sessionId: string | null = null;
    let sessionType: 'ssh-server' | 'local-terminal' | null = null;
    let connectAttemptId = 0;
    let connectAbortController: AbortController | null = null;
    let lastSyncedCols: number | null = null;
    let lastSyncedRows: number | null = null;
    let fitFrameId: number | null = null;
    const paneRuntime: TerminalPaneRuntime = {
      owner: 'primary',
      terminal,
      fitAddon,
      searchAddon,
      serializeAddon,
      clipboardProvider: terminalClipboardProvider,
      webglAddon: addonRuntime.webglAddon,
      containerElement,
      socket: null,
      sessionId: null,
      sessionType: null,
      pendingCommandMarkers: [],
      commandMarkers: [],
      refreshCommandTimeline,
      reconnect: () => undefined,
      dispose: () => undefined,
    };
    paneRuntimeMapRef.current.set(paneId, paneRuntime);
    refreshCommandTimeline();

    /**
     * Refreshes declarative timeline geometry only while this pane owns markers.
     *
     * @returns Nothing.
     */
    const refreshRuntimeCommandTimeline = (): void => {
      if (paneRuntime.pendingCommandMarkers.length === 0 && paneRuntime.commandMarkers.length === 0) {
        return;
      }

      refreshCommandTimeline();
    };

    const isStaleAttempt = (attemptId: number): boolean => {
      return disposed || attemptId !== connectAttemptId;
    };

    const syncResizeIfNeeded = (): void => {
      if (disposed || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (terminal.cols === lastSyncedCols && terminal.rows === lastSyncedRows) {
        return;
      }

      lastSyncedCols = terminal.cols;
      lastSyncedRows = terminal.rows;
      sendClientMessage(socket, {
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const scheduleFitAndResizeSync = (): void => {
      if (disposed || fitFrameId !== null) {
        return;
      }

      fitFrameId = requestAnimationFrame(() => {
        fitFrameId = null;

        const didFit = safeFit();
        if (!didFit || disposed) {
          return;
        }

        syncResizeIfNeeded();
        refreshSelectionAnchor();
      });
    };
    scheduleFitAndResizeSyncRef.current = scheduleFitAndResizeSync;

    void document.fonts.ready.then(() => {
      if (disposed) {
        return;
      }

      scheduleFitAndResizeSync();
    });

    const setupResizeSync = (): (() => void) => {
      const observer = new ResizeObserver(() => {
        scheduleFitAndResizeSync();
        refreshSelectionAnchor();
      });

      observer.observe(containerElement);

      return () => observer.disconnect();
    };

    const handleSocketMessage = (event: MessageEvent<string>): void => {
      if (disposed) {
        return;
      }

      try {
        const payload = JSON.parse(event.data) as ServerInboundMessage;
        handlePaneServerMessage(paneId, terminal, payload);
      } catch {
        setPaneTransportState(paneId, 'failed', t('ssh.websocketMalformedMessage'));
      }
    };

    const connectSession = async (mode: 'initial' | 'retry'): Promise<void> => {
      try {
        if (!isActiveRef.current) {
          return;
        }

        connectAbortController?.abort();
        connectAbortController = new AbortController();
        connectAttemptId += 1;
        const attemptId = connectAttemptId;

        resetPaneState(paneId);
        terminalPresentationIntegration.resetAfterPendingWrites(() => {
          resetTerminalPresentationState(paneId);
        });
        setPaneTransportState(paneId, 'connecting');
        setSessionTargetReady(false);

        const activeIntent = connectionIntentRef.current;
        if (mode === 'retry' && !activeIntent.lastResolvedSnapshot) {
          throw new Error('Cannot retry without a resolved target snapshot.');
        }

        const target =
          mode === 'retry'
            ? await resolveTerminalTargetFromSnapshot(activeIntent.lastResolvedSnapshot!, connectAbortController.signal)
            : await resolveTerminalTargetFromIntent(activeIntent, connectAbortController.signal);

        if (isStaleAttempt(attemptId)) {
          return;
        }

        resolvedTerminalTargetRef.current = target;
        terminalClipboardProvider.setActiveTarget(target);
        onConnectionIntentChangeRef.current(withResolvedSnapshot(activeIntent, toResolvedTargetSnapshot(target)));
        applyTerminalCharacterWidthCompatibilityMode(
          terminal,
          resolveTerminalCharacterWidthCompatibilityMode(target, characterWidthCompatibilityModeEnabledRef.current),
        );

        if (target.type === 'ssh-server') {
          onTabTitleChangeRef.current?.(target.server.name.trim() || t('tabs.page.ssh'));
          onTabVisualChangeRef.current?.({
            iconKey: target.server.iconKey?.trim() || 'Server',
            iconColorKey: target.server.colorKey ?? undefined,
          });
        } else {
          onTabTitleChangeRef.current?.(target.profileName?.trim() || t('tabs.page.localTerminal'));
          onTabVisualChangeRef.current?.({ iconKey: 'terminal', iconColorKey: undefined });
        }

        if (target.type === 'local-terminal') {
          terminal.options.windowsPty = { backend: 'conpty' };
          terminal.options.reflowCursorLine = false;
        } else {
          terminal.options.windowsPty = undefined;
          terminal.options.reflowCursorLine = true;
        }

        const openedSession = await openTerminalSessionSocket({
          target,
          cols: terminal.cols,
          rows: terminal.rows,
          term: 'xterm-256color',
          connectTimeoutSec: sshConnectionTimeoutSecRef.current,
          requestHostFingerprintTrust,
          hostFingerprintNotTrustedMessage: t('ssh.hostFingerprintNotTrusted'),
        });

        if (isStaleAttempt(attemptId)) {
          if (openedSession.sessionType === 'local-terminal') {
            void closeLocalTerminalSession(openedSession.sessionId).catch(() => undefined);
          } else {
            void closeSshSession(openedSession.sessionId).catch(() => undefined);
          }
          return;
        }

        sessionType = openedSession.sessionType;
        sessionId = openedSession.sessionId;
        socket = openedSession.socket;
        paneRuntime.sessionType = sessionType;
        paneRuntime.sessionId = sessionId;
        paneRuntime.socket = socket;
        primarySocketRef.current = socket;
        if (activePaneIdRef.current === paneId) {
          socketRef.current = socket;
        }
        socket.addEventListener('message', (event) => {
          if (isStaleAttempt(attemptId)) {
            return;
          }

          handleSocketMessage(event);
        });

        socket.addEventListener('open', () => {
          if (isStaleAttempt(attemptId)) {
            return;
          }

          setPaneTransportState(paneId, 'connected');
          setSessionTargetReady(true);
          scheduleFitAndResizeSync();
        });

        socket.addEventListener('close', () => {
          if (isStaleAttempt(attemptId)) {
            return;
          }

          primarySocketRef.current = null;
          paneRuntime.socket = null;
          if (activePaneIdRef.current === paneId) {
            socketRef.current = null;
          }

          setPaneTransportState(paneId, 'failed', t('ssh.websocketClosed'));
        });

        socket.addEventListener('error', () => {
          if (isStaleAttempt(attemptId)) {
            return;
          }

          primarySocketRef.current = null;
          paneRuntime.socket = null;
          if (activePaneIdRef.current === paneId) {
            socketRef.current = null;
          }

          setPaneTransportState(paneId, 'failed', t('ssh.websocketTransportFailed'));
        });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        const message = error instanceof Error ? error.message : t('ssh.sessionInitFailed');
        setPaneTransportState(paneId, 'failed', message);
        console.warn('[ssh][connect] Failed to initialize SSH session.', {
          tabId: tabIdRef.current,
          mode,
          intentId: connectionIntentRef.current.intentId,
          reason: message,
        });
      }
    };

    const disposeResize = setupResizeSync();
    const trackPointerPosition = (event: MouseEvent | PointerEvent): void => {
      selectionPointerClientXRef.current = event.clientX;
    };
    const handleTerminalFocus = (): void => {
      setActivePane(paneId);
      acknowledgeTerminalBell(paneId);
    };
    containerElement.addEventListener('pointerup', trackPointerPosition);
    containerElement.addEventListener('mouseup', trackPointerPosition);
    containerElement.addEventListener('focusin', handleTerminalFocus);
    const disposeTerminalInput = terminal.onData((data) => {
      if (activePaneIdRef.current !== paneId) {
        setActivePane(paneId);
      }

      if (disposed) {
        return;
      }

      recordPaneInputCommandMarker(paneId, data);
      const autocompleteInputState = applyAutocompleteInputData(paneId, data);
      if (autocompleteInputState.shouldClose) {
        closeAutocompleteRef.current();
      }

      if (socket) {
        sendClientMessage(socket, {
          type: 'input',
          data,
        });
      }
    });
    const handleAutocompleteKeyDown = (event: KeyboardEvent): void => {
      handleAutocompleteTerminalKeyDownRef.current(event);
    };
    containerElement.addEventListener('keydown', handleAutocompleteKeyDown, true);
    const disposeSelectionChange = terminal.onSelectionChange(() => {
      const selectionText = refreshSelectionAnchor();
      if (selectionText) {
        onTerminalSelectionChangeRef.current(selectionText);
      }
    });
    const disposeSelectionScroll = terminal.onScroll(() => {
      refreshSelectionAnchor();
      refreshRuntimeCommandTimeline();
    });
    const disposeSelectionRender = terminal.onRender(() => {
      if (!terminal.hasSelection()) {
        return;
      }

      refreshSelectionAnchor();
    });
    const disposeCommandTimelineWrite = terminal.onWriteParsed(refreshRuntimeCommandTimeline);
    const disposeCommandTimelineBuffer = terminal.buffer.onBufferChange(() => {
      refreshRuntimeCommandTimeline();
    });
    const disposeCommandTimelineResize = terminal.onResize(refreshRuntimeCommandTimeline);
    const handleWindowResize = (): void => {
      refreshSelectionAnchor();
    };
    window.addEventListener('resize', handleWindowResize);
    refreshSelectionAnchor();

    const reconnectPane = (): void => {
      const mode = resolveConnectMode(connectionIntentRef.current, 'retry');
      void connectSession(mode);
    };
    paneRuntime.reconnect = reconnectPane;

    if (isActiveRef.current) {
      void connectSession('initial');
    }

    const disposeRuntime = (): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      connectAbortController?.abort();

      if (retryFitFrameId !== null) {
        cancelAnimationFrame(retryFitFrameId);
        retryFitFrameId = null;
      }

      if (fitFrameId !== null) {
        cancelAnimationFrame(fitFrameId);
        fitFrameId = null;
      }

      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          sendClientMessage(socket, { type: 'close' });
          socket.close();
        }
      } catch {
        // Ignore websocket close race conditions.
      }

      if (primarySocketRef.current === socket) {
        primarySocketRef.current = null;
      }
      if (activePaneIdRef.current === paneId && socketRef.current === socket) {
        socketRef.current = null;
      }

      if (sessionId) {
        if (sessionType === 'local-terminal') {
          void closeLocalTerminalSession(sessionId).catch(() => undefined);
        } else {
          void closeSshSession(sessionId).catch(() => undefined);
        }
      }

      scheduleFitAndResizeSyncRef.current = null;
      if (primaryTerminalRef.current === terminal) {
        primaryTerminalRef.current = null;
      }
      if (primarySearchAddonRef.current === searchAddon) {
        primarySearchAddonRef.current = null;
      }
      if (primarySerializeAddonRef.current === serializeAddon) {
        primarySerializeAddonRef.current = null;
      }
      primaryWebglAddonRuntimeRef.current = { webglAddon: null };
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      if (paneRuntimeMapRef.current.get(paneId) === paneRuntime) {
        paneRuntimeMapRef.current.delete(paneId);
      }
      if (paneRuntimeMapRef.current.size === 0) {
        terminalClipboardProvider.setActiveTarget(null);
      }
      paneRuntime.socket = null;
      paneRuntime.sessionId = null;
      paneRuntime.sessionType = null;
      paneRuntime.reconnect = () => undefined;
      clearTerminalCommandMarkers(paneRuntime);
      paneRuntime.refreshCommandTimeline = () => undefined;
      selectionPointerClientXRef.current = null;
      clearSelectionOverlay();
      disposeTerminalInput.dispose();
      disposeSelectionChange.dispose();
      disposeSelectionScroll.dispose();
      disposeSelectionRender.dispose();
      disposeCommandTimelineWrite.dispose();
      disposeCommandTimelineBuffer.dispose();
      disposeCommandTimelineResize.dispose();
      terminalPresentationIntegration.dispose();
      containerElement.removeEventListener('pointerup', trackPointerPosition);
      containerElement.removeEventListener('mouseup', trackPointerPosition);
      containerElement.removeEventListener('focusin', handleTerminalFocus);
      containerElement.removeEventListener('keydown', handleAutocompleteKeyDown, true);
      window.removeEventListener('resize', handleWindowResize);
      disposeResize();
      terminal.dispose();
    };
    paneRuntime.dispose = disposeRuntime;

    return disposeRuntime;
  }, [
    acknowledgeTerminalBell,
    activePaneIdRef,
    applyAutocompleteInputData,
    characterWidthCompatibilityModeEnabledRef,
    clearSelectionOverlay,
    closeAutocompleteRef,
    handlePaneServerMessage,
    handleAutocompleteTerminalKeyDownRef,
    hardwareAccelerationStateRef,
    openExternalLinkRef,
    notifyHardwareAccelerationContextLoss,
    onTabTitleChangeRef,
    onTabVisualChangeRef,
    primaryPaneIdRef,
    primarySocketRef,
    primaryTerminalRef,
    primarySearchAddonRef,
    primarySerializeAddonRef,
    primaryWebglAddonRuntimeRef,
    paneRuntimeMapRef,
    recordPaneInputCommandMarker,
    refreshCommandTimeline,
    refreshSelectionAnchor,
    resetPaneState,
    resetTerminalPresentationState,
    requestHostFingerprintTrust,
    resolvedTerminalTargetRef,
    scheduleFitAndResizeSyncRef,
    selectionPointerClientXRef,
    setActivePane,
    setPaneTransportState,
    setSessionTargetReady,
    socketRef,
    sshConnectionTimeoutSecRef,
    terminalContainerRef,
    terminalInitOptionsRef,
    terminalClipboardProvider,
    terminalRef,
    dispatchTerminalPresentationState,
    terminalInlineImageSettingsRef,
    terminalWebLinksSettingsRef,
  ]);
};
