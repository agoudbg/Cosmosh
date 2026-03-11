import { FitAddon } from '@xterm/addon-fit';
import { type ITerminalOptions, Terminal } from '@xterm/xterm';
import React from 'react';

import { closeLocalTerminalSession, closeSshSession } from '../../lib/backend';
import { t } from '../../lib/i18n';
import { openTerminalSessionSocket } from './ssh-session-connectors';
import { resolveTerminalTarget } from './ssh-target';
import type { ResolvedTerminalTarget, ServerInboundMessage, SshTelemetryState } from './ssh-types';
import { DEFAULT_TELEMETRY_STATE } from './ssh-types';
import { SECRET_PROMPT_PATTERN, sendClientMessage } from './ssh-utils';

type UseSshPrimarySessionParams = {
  terminalInitOptionsRef: React.RefObject<ITerminalOptions>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  primaryTerminalRef: React.RefObject<Terminal | null>;
  primaryPaneIdRef: React.RefObject<string>;
  activePaneIdRef: React.RefObject<string>;
  primarySocketRef: React.RefObject<WebSocket | null>;
  socketRef: React.RefObject<WebSocket | null>;
  resolvedTerminalTargetRef: React.RefObject<ResolvedTerminalTarget | null>;
  sshConnectionTimeoutSecRef: React.RefObject<number>;
  scheduleFitAndResizeSyncRef: React.RefObject<(() => void) | null>;
  connectSessionRef: React.RefObject<(() => void) | null>;
  selectionPointerClientXRef: React.RefObject<number | null>;
  onTabTitleChangeRef: React.RefObject<((title: string) => void) | undefined>;
  setConnectionState: React.Dispatch<React.SetStateAction<'connecting' | 'connected' | 'failed'>>;
  setConnectionError: React.Dispatch<React.SetStateAction<string>>;
  setTelemetryState: React.Dispatch<React.SetStateAction<SshTelemetryState>>;
  requestHostFingerprintTrust: (prompt: {
    serverId: string;
    host: string;
    port: number;
    algorithm: string;
    fingerprint: string;
  }) => Promise<boolean>;
  setActivePane: (paneId: string) => void;
  refreshSelectionAnchor: () => void;
  clearSelectionOverlay: () => void;
  applyAutocompleteInputData: (data: string) => { shouldRequest: boolean; shouldClose: boolean };
  closeAutocompleteRef: React.RefObject<() => void>;
  scheduleAutocompleteRequestRef: React.RefObject<(trigger: 'typing' | 'manual') => void>;
  handleAutocompleteTerminalKeyDownRef: React.RefObject<(event: KeyboardEvent) => void>;
  handleCompletionResponse: (
    payload: Extract<ServerInboundMessage, { type: 'completion-response' }>,
    paneId: string,
  ) => void;
};

/**
 * Owns primary terminal instance lifecycle and primary websocket session wiring.
 *
 * @param params Runtime refs, callbacks and state setters required by primary session effect.
 * @returns Nothing.
 */
export const useSshPrimarySession = (params: UseSshPrimarySessionParams): void => {
  const {
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
    requestHostFingerprintTrust,
    setActivePane,
    refreshSelectionAnchor,
    clearSelectionOverlay,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
  } = params;

  React.useEffect(() => {
    const terminal = new Terminal(terminalInitOptionsRef.current);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const containerElement = terminalContainerRef.current;
    if (!containerElement) {
      terminalRef.current = null;
      terminal.dispose();
      return;
    }

    terminal.open(containerElement);
    primaryTerminalRef.current = terminal;
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
    let lastSyncedCols: number | null = null;
    let lastSyncedRows: number | null = null;
    let fitFrameId: number | null = null;

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

        if (payload.type === 'output') {
          terminal.write(payload.data);
          if (SECRET_PROMPT_PATTERN.test(payload.data.trimEnd())) {
            scheduleAutocompleteRequestRef.current('manual');
          }
          return;
        }

        if (payload.type === 'error') {
          setConnectionState('failed');
          setConnectionError(payload.message);
          return;
        }

        if (payload.type === 'exit') {
          setConnectionState('failed');
          setConnectionError(payload.reason);
          return;
        }

        if (payload.type === 'ready') {
          return;
        }

        if (payload.type === 'telemetry') {
          setTelemetryState({
            cpuUsagePercent: payload.cpuUsagePercent,
            memoryUsedBytes: payload.memoryUsedBytes,
            memoryTotalBytes: payload.memoryTotalBytes,
            networkRxBytesPerSec: payload.networkRxBytesPerSec,
            networkTxBytesPerSec: payload.networkTxBytesPerSec,
            recentCommands: payload.recentCommands,
          });
          return;
        }

        if (payload.type === 'history') {
          setTelemetryState((previous) => ({
            ...previous,
            recentCommands: payload.recentCommands,
          }));
          return;
        }

        if (payload.type === 'completion-response') {
          handleCompletionResponse(payload, primaryPaneIdRef.current);
          return;
        }
      } catch {
        setConnectionState('failed');
        setConnectionError(t('ssh.websocketMalformedMessage'));
      }
    };

    const connectSession = async (): Promise<void> => {
      try {
        setConnectionState('connecting');
        setConnectionError('');
        setTelemetryState(DEFAULT_TELEMETRY_STATE);

        const target = await resolveTerminalTarget();
        if (disposed) {
          return;
        }
        resolvedTerminalTargetRef.current = target;

        if (target.type === 'ssh-server') {
          onTabTitleChangeRef.current?.(target.server.name.trim() || t('tabs.page.ssh'));
        } else {
          onTabTitleChangeRef.current?.(target.profileName?.trim() || t('tabs.page.localTerminal'));
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

        if (disposed) {
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
        primarySocketRef.current = socket;
        if (activePaneIdRef.current === primaryPaneIdRef.current) {
          socketRef.current = socket;
        }
        socket.addEventListener('message', handleSocketMessage);

        socket.addEventListener('open', () => {
          if (disposed) {
            return;
          }

          setConnectionState('connected');
          setConnectionError('');
          scheduleFitAndResizeSync();
        });

        socket.addEventListener('close', () => {
          primarySocketRef.current = null;
          if (activePaneIdRef.current === primaryPaneIdRef.current) {
            socketRef.current = null;
          }
          if (disposed) {
            return;
          }

          setConnectionState('failed');
          setConnectionError(t('ssh.websocketClosed'));
        });

        socket.addEventListener('error', () => {
          primarySocketRef.current = null;
          if (activePaneIdRef.current === primaryPaneIdRef.current) {
            socketRef.current = null;
          }
          if (disposed) {
            return;
          }

          setConnectionState('failed');
          setConnectionError(t('ssh.websocketTransportFailed'));
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : t('ssh.sessionInitFailed');
        setConnectionState('failed');
        setConnectionError(message);
      }
    };

    const disposeResize = setupResizeSync();
    const trackPointerPosition = (event: MouseEvent | PointerEvent): void => {
      selectionPointerClientXRef.current = event.clientX;
    };
    containerElement.addEventListener('pointerup', trackPointerPosition);
    containerElement.addEventListener('mouseup', trackPointerPosition);
    const disposeTerminalInput = terminal.onData((data) => {
      if (activePaneIdRef.current !== primaryPaneIdRef.current) {
        setActivePane(primaryPaneIdRef.current);
      }

      if (disposed) {
        return;
      }

      const autocompleteInputState = applyAutocompleteInputData(data);
      if (autocompleteInputState.shouldClose) {
        closeAutocompleteRef.current();
      }

      if (autocompleteInputState.shouldRequest) {
        scheduleAutocompleteRequestRef.current('typing');
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
      refreshSelectionAnchor();
    });
    const disposeSelectionScroll = terminal.onScroll(() => {
      refreshSelectionAnchor();
    });
    const disposeSelectionRender = terminal.onRender(() => {
      if (!terminal.hasSelection()) {
        return;
      }

      refreshSelectionAnchor();
    });
    const handleWindowResize = (): void => {
      refreshSelectionAnchor();
    };
    window.addEventListener('resize', handleWindowResize);
    refreshSelectionAnchor();

    connectSessionRef.current = connectSession;
    void connectSession();

    return () => {
      disposed = true;

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

      primarySocketRef.current = null;
      socketRef.current = null;

      if (sessionId) {
        if (sessionType === 'local-terminal') {
          void closeLocalTerminalSession(sessionId).catch(() => undefined);
        } else {
          void closeSshSession(sessionId).catch(() => undefined);
        }
      }

      connectSessionRef.current = null;
      scheduleFitAndResizeSyncRef.current = null;
      primaryTerminalRef.current = null;
      terminalRef.current = null;
      selectionPointerClientXRef.current = null;
      clearSelectionOverlay();
      disposeTerminalInput.dispose();
      disposeSelectionChange.dispose();
      disposeSelectionScroll.dispose();
      disposeSelectionRender.dispose();
      containerElement.removeEventListener('pointerup', trackPointerPosition);
      containerElement.removeEventListener('mouseup', trackPointerPosition);
      containerElement.removeEventListener('keydown', handleAutocompleteKeyDown, true);
      window.removeEventListener('resize', handleWindowResize);
      disposeResize();
      terminal.dispose();
    };
  }, [
    activePaneIdRef,
    applyAutocompleteInputData,
    clearSelectionOverlay,
    closeAutocompleteRef,
    connectSessionRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
    onTabTitleChangeRef,
    primaryPaneIdRef,
    primarySocketRef,
    primaryTerminalRef,
    refreshSelectionAnchor,
    requestHostFingerprintTrust,
    resolvedTerminalTargetRef,
    scheduleAutocompleteRequestRef,
    scheduleFitAndResizeSyncRef,
    selectionPointerClientXRef,
    setActivePane,
    setConnectionError,
    setConnectionState,
    setTelemetryState,
    socketRef,
    sshConnectionTimeoutSecRef,
    terminalContainerRef,
    terminalInitOptionsRef,
    terminalRef,
  ]);
};
