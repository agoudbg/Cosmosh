import { FitAddon } from '@xterm/addon-fit';
import { type ITerminalOptions, Terminal } from '@xterm/xterm';
import React from 'react';

import { closeLocalTerminalSession, closeSshSession } from '../../lib/backend';
import { t } from '../../lib/i18n';
import { openTerminalSessionSocket } from './ssh-session-connectors';
import type { MirrorPaneRuntime, ResolvedTerminalTarget, ServerInboundMessage } from './ssh-types';
import { applyTerminalRuntimeOptions, sendClientMessage } from './ssh-utils';

type UseSshMirrorPanesParams = {
  connectionState: 'connecting' | 'connected' | 'failed';
  terminalPaneIds: string[];
  terminalInitOptionsRef: React.RefObject<ITerminalOptions>;
  paneContainerMapRef: React.RefObject<Map<string, HTMLDivElement>>;
  mirrorPaneRuntimeMapRef: React.RefObject<Map<string, MirrorPaneRuntime>>;
  selectionPointerClientXRef: React.RefObject<number | null>;
  activePaneIdRef: React.RefObject<string>;
  socketRef: React.RefObject<WebSocket | null>;
  resolvedTerminalTargetRef: React.RefObject<ResolvedTerminalTarget | null>;
  sshConnectionTimeoutSecRef: React.RefObject<number>;
  scheduleFitAndResizeSyncRef: React.RefObject<(() => void) | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  setActivePane: (paneId: string) => void;
  refreshSelectionAnchor: () => void;
  handleAutocompleteTerminalKeyDownRef: React.RefObject<(event: KeyboardEvent) => void>;
  applyAutocompleteInputData: (data: string) => { shouldRequest: boolean; shouldClose: boolean };
  closeAutocompleteRef: React.RefObject<() => void>;
  scheduleAutocompleteRequestRef: React.RefObject<(trigger: 'typing' | 'manual') => void>;
  handleCompletionResponse: (
    payload: Extract<ServerInboundMessage, { type: 'completion-response' }>,
    paneId: string,
  ) => void;
  requestHostFingerprintTrust: (prompt: {
    serverId: string;
    host: string;
    port: number;
    algorithm: string;
    fingerprint: string;
  }) => Promise<boolean>;
  resolveTerminalTarget: () => Promise<ResolvedTerminalTarget>;
  notifyWarning: (message: string) => void;
};

/**
 * Manages mirror terminal pane lifecycle, socket sessions, and pane resize syncing.
 *
 * @param params Dependencies and refs required to manage mirror pane runtime state.
 * @returns Nothing.
 */
export const useSshMirrorPanes = (params: UseSshMirrorPanesParams): void => {
  const {
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
    setActivePane,
    refreshSelectionAnchor,
    handleAutocompleteTerminalKeyDownRef,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleCompletionResponse,
    requestHostFingerprintTrust,
    resolveTerminalTarget,
    notifyWarning,
  } = params;

  React.useEffect(() => {
    if (connectionState !== 'connected') {
      return;
    }

    const desiredMirrorPaneIds = terminalPaneIds.slice(1);

    mirrorPaneRuntimeMapRef.current.forEach((runtime, paneId) => {
      if (desiredMirrorPaneIds.includes(paneId)) {
        return;
      }

      runtime.dispose();
      mirrorPaneRuntimeMapRef.current.delete(paneId);
    });

    desiredMirrorPaneIds.forEach((paneId) => {
      const containerElement = paneContainerMapRef.current.get(paneId);
      if (!containerElement) {
        return;
      }

      const existingRuntime = mirrorPaneRuntimeMapRef.current.get(paneId);
      if (existingRuntime) {
        if (existingRuntime.containerElement === containerElement) {
          return;
        }

        existingRuntime.dispose();
        mirrorPaneRuntimeMapRef.current.delete(paneId);
      }

      const terminal = new Terminal(terminalInitOptionsRef.current);
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerElement);

      const runtime: MirrorPaneRuntime = {
        terminal,
        fitAddon,
        containerElement,
        socket: null,
        sessionId: null,
        sessionType: null,
        dispose: () => undefined,
      };
      mirrorPaneRuntimeMapRef.current.set(paneId, runtime);

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

      const disposeTerminalInput = terminal.onData((data) => {
        if (activePaneIdRef.current !== paneId) {
          setActivePane(paneId);
        }

        const autocompleteInputState = applyAutocompleteInputData(data);
        if (autocompleteInputState.shouldClose) {
          closeAutocompleteRef.current();
        }

        if (autocompleteInputState.shouldRequest) {
          scheduleAutocompleteRequestRef.current('typing');
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
          refreshSelectionAnchor();
        }
      });
      const disposeSelectionScroll = terminal.onScroll(() => {
        if (activePaneIdRef.current === paneId) {
          refreshSelectionAnchor();
        }
      });
      const disposeSelectionRender = terminal.onRender(() => {
        if (!terminal.hasSelection()) {
          return;
        }

        if (activePaneIdRef.current === paneId) {
          refreshSelectionAnchor();
        }
      });

      containerElement.addEventListener('pointerup', trackPointerPosition);
      containerElement.addEventListener('mouseup', trackPointerPosition);
      containerElement.addEventListener('keydown', handleAutocompleteKeyDown, true);
      containerElement.addEventListener('mousedown', handleSetActivePane, true);
      containerElement.addEventListener('contextmenu', handleSetActivePane, true);

      const connectPaneSession = async (): Promise<void> => {
        try {
          const target = resolvedTerminalTargetRef.current ?? (await resolveTerminalTarget());
          resolvedTerminalTargetRef.current = target;
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

          runtime.sessionType = openedSession.sessionType;
          runtime.sessionId = openedSession.sessionId;
          const socket = openedSession.socket;
          runtime.socket = socket;

          socket.addEventListener('message', (event) => {
            try {
              const payload = JSON.parse(event.data) as ServerInboundMessage;
              if (payload.type === 'output') {
                terminal.write(payload.data);
                return;
              }

              if (payload.type === 'completion-response') {
                handleCompletionResponse(payload, paneId);
              }
            } catch {
              notifyWarning(t('ssh.websocketMalformedMessage'));
            }
          });

          socket.addEventListener('open', () => {
            if (activePaneIdRef.current === paneId) {
              socketRef.current = socket;
            }

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
            runtime.socket = null;
            if (activePaneIdRef.current === paneId) {
              socketRef.current = null;
            }
          });

          socket.addEventListener('error', () => {
            runtime.socket = null;
            notifyWarning(t('ssh.websocketTransportFailed'));
            if (activePaneIdRef.current === paneId) {
              socketRef.current = null;
            }
          });
        } catch (error: unknown) {
          notifyWarning(error instanceof Error ? error.message : t('ssh.sessionInitFailed'));
        }
      };

      void connectPaneSession();

      runtime.dispose = () => {
        if (runtime.socket && runtime.socket.readyState === WebSocket.OPEN) {
          sendClientMessage(runtime.socket, { type: 'close' });
          runtime.socket.close();
        }

        if (runtime.sessionId) {
          if (runtime.sessionType === 'local-terminal') {
            void closeLocalTerminalSession(runtime.sessionId).catch(() => undefined);
          } else {
            void closeSshSession(runtime.sessionId).catch(() => undefined);
          }
        }

        runtime.socket = null;
        runtime.sessionId = null;
        runtime.sessionType = null;
        disposeTerminalInput.dispose();
        disposeSelectionChange.dispose();
        disposeSelectionScroll.dispose();
        disposeSelectionRender.dispose();
        containerElement.removeEventListener('pointerup', trackPointerPosition);
        containerElement.removeEventListener('mouseup', trackPointerPosition);
        containerElement.removeEventListener('keydown', handleAutocompleteKeyDown, true);
        containerElement.removeEventListener('mousedown', handleSetActivePane, true);
        containerElement.removeEventListener('contextmenu', handleSetActivePane, true);
        terminal.dispose();
      };
    });

    mirrorPaneRuntimeMapRef.current.forEach((runtime) => {
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
    activePaneIdRef,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    connectionState,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
    mirrorPaneRuntimeMapRef,
    paneContainerMapRef,
    refreshSelectionAnchor,
    requestHostFingerprintTrust,
    resolveTerminalTarget,
    resolvedTerminalTargetRef,
    scheduleAutocompleteRequestRef,
    scheduleFitAndResizeSyncRef,
    selectionPointerClientXRef,
    setActivePane,
    socketRef,
    sshConnectionTimeoutSecRef,
    terminalInitOptionsRef,
    terminalPaneIds,
    notifyWarning,
  ]);

  React.useEffect(() => {
    const mirrorRuntimeMap = mirrorPaneRuntimeMapRef.current;

    return () => {
      mirrorRuntimeMap.forEach((runtime) => {
        runtime.dispose();
      });
      mirrorRuntimeMap.clear();
    };
  }, [mirrorPaneRuntimeMapRef]);

  /**
   * Fits all mirror panes and synchronizes rows/cols with active sockets.
   *
   * @returns Nothing.
   */
  const fitAllTerminalPanes = React.useCallback(() => {
    scheduleFitAndResizeSyncRef.current?.();

    mirrorPaneRuntimeMapRef.current.forEach((runtime) => {
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
  }, [mirrorPaneRuntimeMapRef, scheduleFitAndResizeSyncRef]);

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
  }, [fitAllTerminalPanes, terminalPaneIds, wrapperRef]);
};
