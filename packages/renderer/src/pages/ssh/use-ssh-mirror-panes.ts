import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { ITerminalOptions } from '@xterm/xterm';
import React from 'react';

import { closeLocalTerminalSession, closeSshSession } from '../../lib/backend';
import { t } from '../../lib/i18n';
import { clearTerminalCommandMarkers } from './ssh-command-markers';
import { openTerminalSessionSocket } from './ssh-session-connectors';
import type { ResolvedTerminalTarget, ServerInboundMessage, TerminalPaneRuntime } from './ssh-types';
import { applyTerminalRuntimeOptions, reconcileSecondaryPaneRuntimes, sendClientMessage } from './ssh-utils';
import {
  createTerminalInstance,
  loadTerminalAddons,
  resolveTerminalCharacterWidthCompatibilityMode,
  syncTerminalWebglAddon,
  type TerminalExternalLinkHandler,
  type TerminalHardwareAccelerationState,
  type TerminalInlineImageSettings,
  type TerminalWebLinksSettings,
} from './terminal-addons';
import { registerTerminalPresentationIntegration } from './terminal-presentation-integration';
import type { TerminalPresentationStateAction } from './terminal-presentation-state';
import type { TerminalClipboardProvider } from './use-terminal-clipboard-provider';

type UseSshMirrorPanesParams = {
  isActive: boolean;
  sessionTargetReady: boolean;
  terminalPaneIds: string[];
  terminalLayoutRevision: string;
  terminalInitOptionsRef: React.RefObject<ITerminalOptions>;
  hardwareAccelerationStateRef: React.RefObject<TerminalHardwareAccelerationState>;
  characterWidthCompatibilityModeEnabledRef: React.RefObject<boolean>;
  paneContainerMapRef: React.RefObject<Map<string, HTMLDivElement>>;
  paneRuntimeMapRef: React.RefObject<Map<string, TerminalPaneRuntime>>;
  selectionPointerClientXRef: React.RefObject<number | null>;
  activePaneIdRef: React.RefObject<string>;
  socketRef: React.RefObject<WebSocket | null>;
  resolvedTerminalTargetRef: React.RefObject<ResolvedTerminalTarget | null>;
  sshConnectionTimeoutSecRef: React.RefObject<number>;
  terminalClipboardProvider: TerminalClipboardProvider;
  terminalInlineImageSettingsRef: React.RefObject<TerminalInlineImageSettings>;
  terminalWebLinksSettingsRef: React.RefObject<TerminalWebLinksSettings>;
  openExternalLinkRef: React.RefObject<TerminalExternalLinkHandler>;
  scheduleFitAndResizeSyncRef: React.RefObject<(() => void) | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  setActivePane: (paneId: string) => void;
  refreshSelectionAnchor: () => string | null;
  onTerminalSelectionChange: (selectionText: string) => void;
  handleAutocompleteTerminalKeyDownRef: React.RefObject<(event: KeyboardEvent) => void>;
  applyAutocompleteInputData: (paneId: string, data: string) => { shouldRequest: boolean; shouldClose: boolean };
  closeAutocompleteRef: React.RefObject<() => void>;
  resetPaneState: (paneId: string) => void;
  resetTerminalPresentationState: (paneId: string) => void;
  dispatchTerminalPresentationState: (action: TerminalPresentationStateAction) => void;
  acknowledgeTerminalBell: (paneId: string) => void;
  setPaneTransportState: (paneId: string, state: 'connecting' | 'connected' | 'failed', error?: string) => void;
  handlePaneServerMessage: (
    paneId: string,
    terminal: TerminalPaneRuntime['terminal'],
    payload: ServerInboundMessage,
  ) => void;
  recordPaneInputCommandMarker: (paneId: string, inputData: string) => void;
  refreshCommandTimeline: () => void;
  requestHostFingerprintTrust: (prompt: {
    serverId: string;
    host: string;
    port: number;
    algorithm: string;
    fingerprint: string;
  }) => Promise<boolean>;
  notifyWarning: (message: string) => void;
  notifyHardwareAccelerationContextLoss: () => void;
};

/**
 * Manages mirror terminal pane lifecycle, socket sessions, and pane resize syncing.
 *
 * @param params Dependencies and refs required to manage mirror pane runtime state.
 * @returns Nothing.
 */
export const useSshMirrorPanes = (params: UseSshMirrorPanesParams): void => {
  const {
    isActive,
    sessionTargetReady,
    terminalPaneIds,
    terminalLayoutRevision,
    terminalInitOptionsRef,
    hardwareAccelerationStateRef,
    characterWidthCompatibilityModeEnabledRef,
    paneContainerMapRef,
    paneRuntimeMapRef,
    selectionPointerClientXRef,
    activePaneIdRef,
    socketRef,
    resolvedTerminalTargetRef,
    sshConnectionTimeoutSecRef,
    terminalClipboardProvider,
    terminalInlineImageSettingsRef,
    terminalWebLinksSettingsRef,
    openExternalLinkRef,
    scheduleFitAndResizeSyncRef,
    wrapperRef,
    setActivePane,
    refreshSelectionAnchor,
    onTerminalSelectionChange,
    handleAutocompleteTerminalKeyDownRef,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    resetPaneState,
    resetTerminalPresentationState,
    dispatchTerminalPresentationState,
    acknowledgeTerminalBell,
    setPaneTransportState,
    handlePaneServerMessage,
    recordPaneInputCommandMarker,
    refreshCommandTimeline,
    requestHostFingerprintTrust,
    notifyWarning,
    notifyHardwareAccelerationContextLoss,
  } = params;
  const onTerminalSelectionChangeRef = React.useRef<(selectionText: string) => void>(onTerminalSelectionChange);

  React.useEffect(() => {
    onTerminalSelectionChangeRef.current = onTerminalSelectionChange;
  }, [onTerminalSelectionChange]);

  React.useEffect(() => {
    reconcileSecondaryPaneRuntimes(paneRuntimeMapRef.current, {
      desiredPaneIds: terminalPaneIds,
      isActive,
      sessionTargetReady,
    });

    if (!isActive || !sessionTargetReady) {
      return;
    }

    const desiredPaneIds = terminalPaneIds;

    desiredPaneIds.forEach((paneId) => {
      const containerElement = paneContainerMapRef.current.get(paneId);
      if (!containerElement) {
        return;
      }

      const existingRuntime = paneRuntimeMapRef.current.get(paneId);
      if (existingRuntime) {
        if (existingRuntime.owner === 'primary' || existingRuntime.containerElement === containerElement) {
          return;
        }

        existingRuntime.dispose();
        paneRuntimeMapRef.current.delete(paneId);
      }

      const resolvedTarget = resolvedTerminalTargetRef.current;
      const effectiveCharacterWidthCompatibilityModeEnabled = resolvedTarget
        ? resolveTerminalCharacterWidthCompatibilityMode(
            resolvedTarget,
            characterWidthCompatibilityModeEnabledRef.current,
          )
        : characterWidthCompatibilityModeEnabledRef.current;
      const terminal = createTerminalInstance(
        terminalInitOptionsRef.current,
        effectiveCharacterWidthCompatibilityModeEnabled,
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
      terminal.loadAddon(clipboardAddon);
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

      const runtime: TerminalPaneRuntime = {
        owner: 'secondary',
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
      paneRuntimeMapRef.current.set(paneId, runtime);
      refreshCommandTimeline();
      let disposed = false;
      let connectAttemptId = 0;

      /**
       * Refreshes declarative timeline geometry only while this pane owns markers.
       *
       * @returns Nothing.
       */
      const refreshRuntimeCommandTimeline = (): void => {
        if (runtime.pendingCommandMarkers.length === 0 && runtime.commandMarkers.length === 0) {
          return;
        }

        refreshCommandTimeline();
      };

      try {
        fitAddon.fit();
      } catch {
        // Ignore fit race during layout transitions.
      }

      const trackPointerPosition = (event: MouseEvent | PointerEvent): void => {
        selectionPointerClientXRef.current = event.clientX;
      };

      const handleAutocompleteKeyDown = (event: KeyboardEvent): void => {
        handleAutocompleteTerminalKeyDownRef.current(event);
      };

      const handleSetActivePane = (): void => {
        setActivePane(paneId);
      };

      const handleTerminalFocus = (): void => {
        setActivePane(paneId);
        acknowledgeTerminalBell(paneId);
      };

      const disposeTerminalInput = terminal.onData((data) => {
        if (activePaneIdRef.current !== paneId) {
          setActivePane(paneId);
        }

        recordPaneInputCommandMarker(paneId, data);
        const autocompleteInputState = applyAutocompleteInputData(paneId, data);
        if (autocompleteInputState.shouldClose) {
          closeAutocompleteRef.current();
        }

        const socket = runtime.socket;
        if (socket) {
          sendClientMessage(socket, {
            type: 'input',
            data,
          });
        }
      });

      const disposeSelectionChange = terminal.onSelectionChange(() => {
        if (activePaneIdRef.current === paneId) {
          const selectionText = refreshSelectionAnchor();
          if (selectionText) {
            onTerminalSelectionChangeRef.current(selectionText);
          }
        }
      });
      const disposeSelectionScroll = terminal.onScroll(() => {
        if (activePaneIdRef.current === paneId) {
          refreshSelectionAnchor();
        }
        refreshRuntimeCommandTimeline();
      });
      const disposeSelectionRender = terminal.onRender(() => {
        if (!terminal.hasSelection()) {
          return;
        }

        if (activePaneIdRef.current === paneId) {
          refreshSelectionAnchor();
        }
      });
      const disposeCommandTimelineWrite = terminal.onWriteParsed(refreshRuntimeCommandTimeline);
      const disposeCommandTimelineBuffer = terminal.buffer.onBufferChange(() => {
        refreshRuntimeCommandTimeline();
      });
      const disposeCommandTimelineResize = terminal.onResize(refreshRuntimeCommandTimeline);

      // The timeline rail can change pane width without resizing the outer SSH
      // workbench, so secondary panes observe their own xterm host geometry.
      const paneResizeObserver = new ResizeObserver(() => {
        if (disposed) {
          return;
        }

        try {
          fitAddon.fit();
          if (runtime.socket?.readyState === WebSocket.OPEN) {
            sendClientMessage(runtime.socket, {
              type: 'resize',
              cols: Math.max(20, terminal.cols || 120),
              rows: Math.max(10, terminal.rows || 30),
            });
          }
        } catch {
          // Ignore fit races while the timeline rail changes pane geometry.
        }
      });
      paneResizeObserver.observe(containerElement);

      containerElement.addEventListener('pointerup', trackPointerPosition);
      containerElement.addEventListener('mouseup', trackPointerPosition);
      containerElement.addEventListener('keydown', handleAutocompleteKeyDown, true);
      containerElement.addEventListener('mousedown', handleSetActivePane, true);
      containerElement.addEventListener('contextmenu', handleSetActivePane, true);
      containerElement.addEventListener('focusin', handleTerminalFocus);

      /**
       * Closes the current transport while preserving the pane's xterm instance.
       *
       * @returns Nothing.
       */
      const closeRuntimeSession = (): void => {
        const previousSocket = runtime.socket;
        const previousSessionId = runtime.sessionId;
        const previousSessionType = runtime.sessionType;

        runtime.socket = null;
        runtime.sessionId = null;
        runtime.sessionType = null;
        if (socketRef.current === previousSocket) {
          socketRef.current = null;
        }

        if (previousSocket) {
          try {
            if (previousSocket.readyState === WebSocket.OPEN) {
              sendClientMessage(previousSocket, { type: 'close' });
            }
            if (previousSocket.readyState === WebSocket.CONNECTING || previousSocket.readyState === WebSocket.OPEN) {
              previousSocket.close();
            }
          } catch {
            // Ignore websocket close races during retry and pane disposal.
          }
        }

        if (!previousSessionId) {
          return;
        }

        if (previousSessionType === 'local-terminal') {
          void closeLocalTerminalSession(previousSessionId).catch(() => undefined);
        } else {
          void closeSshSession(previousSessionId).catch(() => undefined);
        }
      };

      const connectPaneSession = async (): Promise<void> => {
        if (disposed) {
          return;
        }

        connectAttemptId += 1;
        const attemptId = connectAttemptId;
        closeRuntimeSession();
        resetPaneState(paneId);
        terminalPresentationIntegration.resetAfterPendingWrites(() => {
          resetTerminalPresentationState(paneId);
        });
        setPaneTransportState(paneId, 'connecting');

        try {
          const target = resolvedTerminalTargetRef.current;
          if (!target) {
            setPaneTransportState(paneId, 'failed', t('ssh.sessionInitFailed'));
            notifyWarning(t('ssh.sessionInitFailed'));
            return;
          }

          const sessionCols = Math.max(20, terminal.cols || 120);
          const sessionRows = Math.max(10, terminal.rows || 30);

          if (target.type === 'local-terminal') {
            terminal.options.windowsPty = { backend: 'conpty' };
            terminal.options.reflowCursorLine = false;
          } else {
            terminal.options.windowsPty = undefined;
            terminal.options.reflowCursorLine = true;
          }

          const openedSession = await openTerminalSessionSocket({
            target,
            cols: sessionCols,
            rows: sessionRows,
            term: 'xterm-256color',
            connectTimeoutSec: sshConnectionTimeoutSecRef.current,
            requestHostFingerprintTrust,
            hostFingerprintNotTrustedMessage: t('ssh.hostFingerprintNotTrusted'),
          });

          if (disposed || attemptId !== connectAttemptId) {
            if (openedSession.sessionType === 'local-terminal') {
              void closeLocalTerminalSession(openedSession.sessionId).catch(() => undefined);
            } else {
              void closeSshSession(openedSession.sessionId).catch(() => undefined);
            }
            openedSession.socket.close();
            return;
          }

          runtime.sessionType = openedSession.sessionType;
          runtime.sessionId = openedSession.sessionId;
          const socket = openedSession.socket;
          runtime.socket = socket;

          socket.addEventListener('message', (event) => {
            if (disposed || attemptId !== connectAttemptId) {
              return;
            }

            try {
              const payload = JSON.parse(event.data) as ServerInboundMessage;
              handlePaneServerMessage(paneId, terminal, payload);
            } catch {
              setPaneTransportState(paneId, 'failed', t('ssh.websocketMalformedMessage'));
              notifyWarning(t('ssh.websocketMalformedMessage'));
            }
          });

          socket.addEventListener('open', () => {
            if (disposed || attemptId !== connectAttemptId) {
              return;
            }

            if (activePaneIdRef.current === paneId) {
              socketRef.current = socket;
            }
            setPaneTransportState(paneId, 'connected');

            try {
              fitAddon.fit();
            } catch {
              // Ignore fit race after pane socket open.
            }

            sendClientMessage(socket, {
              type: 'resize',
              cols: Math.max(20, terminal.cols || 120),
              rows: Math.max(10, terminal.rows || 30),
            });
          });

          socket.addEventListener('close', () => {
            if (disposed || attemptId !== connectAttemptId) {
              return;
            }

            runtime.socket = null;
            if (activePaneIdRef.current === paneId) {
              socketRef.current = null;
            }
            setPaneTransportState(paneId, 'failed', t('ssh.websocketClosed'));
          });

          socket.addEventListener('error', () => {
            if (disposed || attemptId !== connectAttemptId) {
              return;
            }

            runtime.socket = null;
            notifyWarning(t('ssh.websocketTransportFailed'));
            if (activePaneIdRef.current === paneId) {
              socketRef.current = null;
            }
            setPaneTransportState(paneId, 'failed', t('ssh.websocketTransportFailed'));
          });
        } catch (error: unknown) {
          if (disposed || attemptId !== connectAttemptId) {
            return;
          }

          const message = error instanceof Error ? error.message : t('ssh.sessionInitFailed');
          setPaneTransportState(paneId, 'failed', message);
          notifyWarning(message);
        }
      };

      runtime.reconnect = () => {
        void connectPaneSession();
      };
      void connectPaneSession();

      runtime.dispose = () => {
        if (disposed) {
          return;
        }

        disposed = true;
        connectAttemptId += 1;
        closeRuntimeSession();
        runtime.reconnect = () => undefined;
        clearTerminalCommandMarkers(runtime);
        runtime.refreshCommandTimeline = () => undefined;
        if (paneRuntimeMapRef.current.get(paneId) === runtime) {
          paneRuntimeMapRef.current.delete(paneId);
        }
        disposeTerminalInput.dispose();
        disposeSelectionChange.dispose();
        disposeSelectionScroll.dispose();
        disposeSelectionRender.dispose();
        disposeCommandTimelineWrite.dispose();
        disposeCommandTimelineBuffer.dispose();
        disposeCommandTimelineResize.dispose();
        terminalPresentationIntegration.dispose();
        paneResizeObserver.disconnect();
        containerElement.removeEventListener('pointerup', trackPointerPosition);
        containerElement.removeEventListener('mouseup', trackPointerPosition);
        containerElement.removeEventListener('keydown', handleAutocompleteKeyDown, true);
        containerElement.removeEventListener('mousedown', handleSetActivePane, true);
        containerElement.removeEventListener('contextmenu', handleSetActivePane, true);
        containerElement.removeEventListener('focusin', handleTerminalFocus);
        terminal.dispose();
      };
    });

    paneRuntimeMapRef.current.forEach((runtime) => {
      applyTerminalRuntimeOptions(runtime.terminal, terminalInitOptionsRef.current);
      try {
        runtime.fitAddon.fit();
      } catch {
        // Ignore fit race while pane layout is transitioning.
      }
    });

    scheduleFitAndResizeSyncRef.current?.();
    setActivePane(activePaneIdRef.current);
  }, [
    acknowledgeTerminalBell,
    activePaneIdRef,
    applyAutocompleteInputData,
    characterWidthCompatibilityModeEnabledRef,
    closeAutocompleteRef,
    dispatchTerminalPresentationState,
    handleAutocompleteTerminalKeyDownRef,
    handlePaneServerMessage,
    hardwareAccelerationStateRef,
    paneRuntimeMapRef,
    isActive,
    openExternalLinkRef,
    paneContainerMapRef,
    refreshSelectionAnchor,
    requestHostFingerprintTrust,
    resolvedTerminalTargetRef,
    scheduleFitAndResizeSyncRef,
    selectionPointerClientXRef,
    setActivePane,
    socketRef,
    sshConnectionTimeoutSecRef,
    terminalClipboardProvider,
    terminalInitOptionsRef,
    terminalInlineImageSettingsRef,
    terminalWebLinksSettingsRef,
    terminalPaneIds,
    notifyWarning,
    notifyHardwareAccelerationContextLoss,
    recordPaneInputCommandMarker,
    refreshCommandTimeline,
    resetPaneState,
    resetTerminalPresentationState,
    sessionTargetReady,
    setPaneTransportState,
  ]);

  React.useEffect(() => {
    const paneRuntimeMap = paneRuntimeMapRef.current;

    return () => {
      paneRuntimeMap.forEach((runtime) => {
        if (runtime.owner === 'secondary') {
          runtime.dispose();
        }
      });
    };
  }, [paneRuntimeMapRef]);

  /**
   * Fits all mirror panes and synchronizes rows/cols with active sockets.
   *
   * @returns Nothing.
   */
  const fitAllTerminalPanes = React.useCallback(() => {
    scheduleFitAndResizeSyncRef.current?.();

    paneRuntimeMapRef.current.forEach((runtime) => {
      try {
        runtime.fitAddon.fit();
        if (runtime.socket && runtime.socket.readyState === WebSocket.OPEN) {
          sendClientMessage(runtime.socket, {
            type: 'resize',
            cols: Math.max(20, runtime.terminal.cols || 120),
            rows: Math.max(10, runtime.terminal.rows || 30),
          });
        }
      } catch {
        // Ignore fit race while host layout is transitioning.
      }
    });
  }, [paneRuntimeMapRef, scheduleFitAndResizeSyncRef]);

  React.useEffect(() => {
    const scheduleFitRefresh = (): void => {
      requestAnimationFrame(() => {
        fitAllTerminalPanes();
        requestAnimationFrame(() => {
          fitAllTerminalPanes();
        });
      });
    };

    const wrapperElement = wrapperRef.current;
    const resizeObserver = wrapperElement ? new ResizeObserver(scheduleFitRefresh) : null;
    if (wrapperElement && resizeObserver) {
      resizeObserver.observe(wrapperElement);
    }

    window.addEventListener('resize', scheduleFitRefresh);
    scheduleFitRefresh();

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleFitRefresh);
    };
  }, [fitAllTerminalPanes, terminalLayoutRevision, terminalPaneIds, wrapperRef]);
};
