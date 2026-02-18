import '@xterm/xterm/css/xterm.css';

import type { components } from '@cosmosh/api-contract';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { RefreshCw } from 'lucide-react';
import React from 'react';

import { Button } from '../components/ui/button';
import { Menubar } from '../components/ui/menubar';
import { closeSshSession, createSshSession, listSshServers, trustSshFingerprint } from '../lib/backend';
import { t } from '../lib/i18n';
import { getActiveSshServerId } from '../lib/ssh-target';

type SshServerListItem = components['schemas']['SshServerListItem'];

type ClientOutboundMessage =
  | {
      type: 'input';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    }
  | {
      type: 'close';
    }
  | {
      type: 'ping';
    };

type ServerInboundMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'exit';
      reason: string;
    }
  | {
      type: 'pong';
    };

const sendClientMessage = (socket: WebSocket, payload: ClientOutboundMessage): void => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
};

const resolveTargetServer = async (): Promise<SshServerListItem> => {
  const serverResponse = await listSshServers();
  const servers = serverResponse.data.items;

  if (servers.length === 0) {
    throw new Error('No SSH server is configured yet.');
  }

  const preferredServerId = getActiveSshServerId();
  if (preferredServerId) {
    const preferredServer = servers.find((item) => item.id === preferredServerId);
    if (preferredServer) {
      return preferredServer;
    }
  }

  return servers[0];
};

const SSH: React.FC = () => {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const connectSessionRef = React.useRef<(() => void) | null>(null);
  const [connectionState, setConnectionState] = React.useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connectionError, setConnectionError] = React.useState<string>('');

  const handleRetry = React.useCallback(() => {
    if (connectionState === 'connecting' || connectionState === 'connected') {
      return;
    }

    connectSessionRef.current?.();
  }, [connectionState]);

  React.useEffect(() => {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 10000,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      letterSpacing: 0,
      lineHeight: 1,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const containerElement = terminalContainerRef.current;
    if (!containerElement) {
      terminal.dispose();
      return;
    }

    terminal.open(containerElement);
    let disposed = false;

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
        terminal.refresh(0, Math.max(terminal.rows - 1, 0));
        return true;
      } catch {
        // Ignore fit races during StrictMode mount/unmount cycles.
        return false;
      }
    };

    const retryFitUntilVisible = (): void => {
      if (disposed) {
        return;
      }

      if (safeFit()) {
        return;
      }

      requestAnimationFrame(retryFitUntilVisible);
    };

    retryFitUntilVisible();

    let socket: WebSocket | null = null;
    let sessionId: string | null = null;

    const setupResizeSync = (): (() => void) => {
      const observer = new ResizeObserver(() => {
        const didFit = safeFit();

        if (disposed) {
          return;
        }

        if (didFit && socket && socket.readyState === WebSocket.OPEN) {
          sendClientMessage(socket, {
            type: 'resize',
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
      });

      if (wrapperRef.current) {
        observer.observe(wrapperRef.current);
      }

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
      } catch {
        setConnectionState('failed');
        setConnectionError(t('ssh.websocketMalformedMessage'));
      }
    };

    const connectSession = async (): Promise<void> => {
      try {
        setConnectionState('connecting');
        setConnectionError('');

        const targetServer = await resolveTargetServer();
        if (disposed) {
          return;
        }

        const createPayload = await createSshSession({
          serverId: targetServer.id,
          cols: terminal.cols,
          rows: terminal.rows,
          term: 'xterm-256color',
        });

        let createResult = createPayload;
        if (disposed) {
          if (createResult.success) {
            void closeSshSession(createResult.data.sessionId).catch(() => undefined);
          }
          return;
        }

        if (!createResult.success && createResult.code === 'SSH_HOST_UNTRUSTED') {
          const confirmed = window.confirm(
            `首次连接检测到未受信任指纹。\n\nHost: ${createResult.data.host}:${createResult.data.port}\nAlgorithm: ${createResult.data.algorithm}\nFingerprint: ${createResult.data.fingerprint}\n\n是否信任并继续连接？`,
          );

          if (!confirmed) {
            setConnectionState('failed');
            setConnectionError(t('ssh.hostFingerprintNotTrusted'));
            return;
          }

          await trustSshFingerprint({
            serverId: createResult.data.serverId,
            fingerprintSha256: createResult.data.fingerprint,
            algorithm: createResult.data.algorithm,
          });

          createResult = await createSshSession({
            serverId: targetServer.id,
            cols: terminal.cols,
            rows: terminal.rows,
            term: 'xterm-256color',
          });

          if (disposed) {
            if (createResult.success) {
              void closeSshSession(createResult.data.sessionId).catch(() => undefined);
            }
            return;
          }
        }

        if (!createResult.success) {
          throw new Error(createResult.message);
        }

        sessionId = createResult.data.sessionId;
        const websocketUrl = new URL(createResult.data.websocketUrl);
        websocketUrl.searchParams.set('token', createResult.data.websocketToken);

        if (disposed) {
          void closeSshSession(createResult.data.sessionId).catch(() => undefined);
          return;
        }

        socket = new WebSocket(websocketUrl.toString());
        socket.addEventListener('message', handleSocketMessage);

        socket.addEventListener('open', () => {
          if (disposed) {
            return;
          }

          setConnectionState('connected');
          setConnectionError('');

          sendClientMessage(socket!, { type: 'resize', cols: terminal.cols, rows: terminal.rows });
        });

        socket.addEventListener('close', () => {
          if (disposed) {
            return;
          }

          setConnectionState('failed');
          setConnectionError(t('ssh.websocketClosed'));
          return;
        });

        socket.addEventListener('error', () => {
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
    const disposeTerminalInput = terminal.onData((data) => {
      if (disposed) {
        return;
      }

      if (socket) {
        sendClientMessage(socket, {
          type: 'input',
          data,
        });
      }
    });

    connectSessionRef.current = connectSession;
    void connectSession();

    return () => {
      disposed = true;

      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          sendClientMessage(socket, { type: 'close' });
          socket.close();
        }
      } catch {
        // Ignore websocket close race conditions.
      }

      if (sessionId) {
        void closeSshSession(sessionId).catch(() => undefined);
      }

      connectSessionRef.current = null;
      disposeTerminalInput.dispose();
      disposeResize();
      terminal.dispose();
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full p-2"
    >
      <div
        ref={terminalContainerRef}
        className="h-full w-full p-2"
      />

      {connectionState !== 'connected' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-between px-4 py-12">
          <div></div>
          <div className="text-sm text-header-text">
            {connectionState === 'connecting' ? t('ssh.connecting') : connectionError}
          </div>
          <div className="flex items-center justify-center">
            <Menubar>
              <Button onClick={handleRetry}>
                <RefreshCw size={16} />
                {t('ssh.retry')}
              </Button>
            </Menubar>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default SSH;
