import '@xterm/xterm/css/xterm.css';

import type { components } from '@cosmosh/api-contract';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import classNames from 'classnames';
import { ArrowUpDown, Cpu, MemoryStick, RefreshCw, Search, Send, Sparkles } from 'lucide-react';
import React from 'react';

import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Menubar } from '../components/ui/menubar';
import {
  closeLocalTerminalSession,
  closeSshSession,
  createLocalTerminalSession,
  createSshSession,
  listSshServers,
  trustSshFingerprint,
} from '../lib/backend';
import { t } from '../lib/i18n';
import { getActiveSshServerId, parseTerminalTarget } from '../lib/ssh-target';

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
    }
  | {
      type: 'telemetry';
      cpuUsagePercent: number | null;
      memoryUsedBytes: number | null;
      memoryTotalBytes: number | null;
      networkRxBytesPerSec: number | null;
      networkTxBytesPerSec: number | null;
      recentCommands: string[];
    };

type SshTelemetryState = {
  cpuUsagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  recentCommands: string[];
};

type HostFingerprintPrompt = {
  serverId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};

const DEFAULT_TELEMETRY_STATE: SshTelemetryState = {
  cpuUsagePercent: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  networkRxBytesPerSec: null,
  networkTxBytesPerSec: null,
  recentCommands: [],
};

const formatCompactBytes = (value: number): string => {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const units = ['B', 'K', 'M', 'G', 'T'];
  let scaled = safeValue;
  let unitIndex = 0;

  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(scaled)}${units[unitIndex]}`;
  }

  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${units[unitIndex]}`;
};

const formatCpuPercent = (value: number | null): string => {
  if (value === null) {
    return 'N/A';
  }

  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `${safeValue.toFixed(1)}%`;
};

const formatMemoryUsage = (usedBytes: number | null, totalBytes: number | null): string => {
  if (usedBytes === null || totalBytes === null) {
    return 'N/A';
  }

  return `${formatCompactBytes(usedBytes)}/${formatCompactBytes(totalBytes)}`;
};

const formatTrafficRate = (bytesPerSecond: number | null): string => {
  if (bytesPerSecond === null) {
    return 'N/A';
  }

  return formatCompactBytes(bytesPerSecond);
};

const sendClientMessage = (socket: WebSocket, payload: ClientOutboundMessage): void => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
};

type ResolvedTerminalTarget =
  | {
      type: 'ssh-server';
      server: SshServerListItem;
    }
  | {
      type: 'local-terminal';
      profileId: string;
    };

const resolveTerminalTarget = async (): Promise<ResolvedTerminalTarget> => {
  const activeTarget = parseTerminalTarget(getActiveSshServerId());
  if (activeTarget?.type === 'local-terminal') {
    return {
      type: 'local-terminal',
      profileId: activeTarget.id,
    };
  }

  const serverResponse = await listSshServers();
  const servers = serverResponse.data.items;

  if (servers.length === 0) {
    throw new Error('No SSH server is configured yet.');
  }

  const preferredTarget = parseTerminalTarget(getActiveSshServerId());
  const preferredServerId = preferredTarget?.type === 'ssh-server' ? preferredTarget.id : null;
  if (preferredServerId) {
    const preferredServer = servers.find((item) => item.id === preferredServerId);
    if (preferredServer) {
      return {
        type: 'ssh-server',
        server: preferredServer,
      };
    }
  }

  return {
    type: 'ssh-server',
    server: servers[0],
  };
};

const SSH: React.FC = () => {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const connectSessionRef = React.useRef<(() => void) | null>(null);
  const fingerprintPromptResolverRef = React.useRef<((accepted: boolean) => void) | null>(null);
  const [connectionState, setConnectionState] = React.useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connectionError, setConnectionError] = React.useState<string>('');
  const [telemetryState, setTelemetryState] = React.useState<SshTelemetryState>(DEFAULT_TELEMETRY_STATE);
  const [hostFingerprintPrompt, setHostFingerprintPrompt] = React.useState<HostFingerprintPrompt | null>(null);

  const resolveHostFingerprintPrompt = React.useCallback((accepted: boolean) => {
    const resolver = fingerprintPromptResolverRef.current;
    fingerprintPromptResolverRef.current = null;
    setHostFingerprintPrompt(null);
    resolver?.(accepted);
  }, []);

  const requestHostFingerprintTrust = React.useCallback((prompt: HostFingerprintPrompt): Promise<boolean> => {
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
      fontSize: 15,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      letterSpacing: 0,
      lineHeight: 1,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue('--color-ssh-card-bg') || '#000000',
      },
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
    let sessionType: 'ssh-server' | 'local-terminal' | null = null;

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

        if (payload.type === 'telemetry') {
          setTelemetryState({
            cpuUsagePercent: payload.cpuUsagePercent,
            memoryUsedBytes: payload.memoryUsedBytes,
            memoryTotalBytes: payload.memoryTotalBytes,
            networkRxBytesPerSec: payload.networkRxBytesPerSec,
            networkTxBytesPerSec: payload.networkTxBytesPerSec,
            // Backend already caps and de-duplicates commands; keep latest at top in the view layer.
            recentCommands: payload.recentCommands,
          });
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

        if (target.type === 'local-terminal') {
          const createResult = await createLocalTerminalSession({
            profileId: target.profileId,
            cols: terminal.cols,
            rows: terminal.rows,
            term: 'xterm-256color',
          });

          if (disposed) {
            void closeLocalTerminalSession(createResult.data.sessionId).catch(() => undefined);
            return;
          }

          sessionType = 'local-terminal';
          sessionId = createResult.data.sessionId;
          const websocketUrl = new URL(createResult.data.websocketUrl);
          websocketUrl.searchParams.set('token', createResult.data.websocketToken);

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
          });

          socket.addEventListener('error', () => {
            if (disposed) {
              return;
            }

            setConnectionState('failed');
            setConnectionError(t('ssh.websocketTransportFailed'));
          });

          return;
        }

        const createPayload = await createSshSession({
          serverId: target.server.id,
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
          const confirmed = await requestHostFingerprintTrust({
            serverId: createResult.data.serverId,
            host: createResult.data.host,
            port: createResult.data.port,
            algorithm: createResult.data.algorithm,
            fingerprint: createResult.data.fingerprint,
          });

          if (disposed) {
            return;
          }

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
            serverId: target.server.id,
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

        sessionType = 'ssh-server';
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
        if (sessionType === 'local-terminal') {
          void closeLocalTerminalSession(sessionId).catch(() => undefined);
        } else {
          void closeSshSession(sessionId).catch(() => undefined);
        }
      }

      connectSessionRef.current = null;
      disposeTerminalInput.dispose();
      disposeResize();
      terminal.dispose();
    };
  }, [requestHostFingerprintTrust]);

  // Card style
  const cardStyle = 'bg-ssh-card-bg h-full w-full flex-1 rounded-[18px] p-1';
  const cardHiddenArea =
    'overflow-hidden hof:my-[-38px] hof:py-[42px] hof:z-20 hof:shadow-lg transition-all duration-300 ease-in-out';
  const hiddenHeaderStyle = 'h-[34px] mt-[-38px]';

  const commandButtonStyle =
    '!justify-start overflow-hidden text-ellipsis text-start w-full whitespace-nowrap flex-shrink-0';

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full w-full gap-2.5"
    >
      {/* SSH */}
      <div className={cardStyle}>
        <div
          ref={terminalContainerRef}
          className="h-full w-full p-2"
        />
      </div>

      {/* Sidebar */}
      <div className="flex w-[300px] flex-col items-center justify-between gap-2.5 overflow-auto">
        {/* Usage */}
        <div
          className={classNames(
            cardStyle,
            'px-3 py-2 flex items-center justify-between gap-2 flex-grow-0 flex-shrink-0',
          )}
        >
          {/* CPU */}
          <div className="flex flex-grow items-center gap-1">
            <Cpu size={14} />
            <span className="text-sm">{formatCpuPercent(telemetryState.cpuUsagePercent)}</span>
          </div>

          {/* Memory */}
          <div className="flex flex-grow items-center gap-1">
            <MemoryStick size={14} />
            <span className="text-sm">
              {formatMemoryUsage(telemetryState.memoryUsedBytes, telemetryState.memoryTotalBytes)}
            </span>
          </div>

          {/* Transit */}
          <div className="flex flex-grow items-center gap-1">
            <ArrowUpDown size={14} />
            <span className="text-sm">
              {formatTrafficRate(telemetryState.networkTxBytesPerSec)}/
              {formatTrafficRate(telemetryState.networkRxBytesPerSec)}
            </span>
          </div>
        </div>

        {/* Recent commands */}
        <div className={classNames(cardStyle, cardHiddenArea)}>
          <div className={classNames(hiddenHeaderStyle, 'flex items-center justify-between flex-shrink-0')}>
            <Button>Commands</Button>
            <div className="flex">
              <Button
                aria-label="Search"
                variant="icon"
              >
                <Search size={16} />
              </Button>
            </div>
          </div>
          <div className="flex h-[178px] flex-col overflow-auto">
            {telemetryState.recentCommands.length === 0 ? (
              <div className="text-muted-text flex h-full items-center justify-center text-xs">No recent commands</div>
            ) : (
              [...telemetryState.recentCommands].reverse().map((command, index) => (
                <Button
                  key={`${command}-${index}`}
                  className={commandButtonStyle}
                >
                  {command}
                </Button>
              ))
            )}
          </div>
        </div>

        {/* Files */}
        <div className={cardStyle}>
          <span>1</span>
        </div>

        {/* Shortcuts */}
        <div className={cardStyle}>
          <span>1</span>
        </div>

        {/* Ask AI */}
        <div className={classNames(cardStyle, 'flex-grow-0')}>
          <div className="flex h-full w-full items-center justify-center">
            <Button
              variant="icon"
              aria-label="Ask AI"
            >
              <Sparkles size={16} />
            </Button>
            <Input placeholder="Ask AI Anything..." />
            <Button
              variant="icon"
              aria-label="Send"
            >
              <Send size={16} />
            </Button>
          </div>
        </div>
      </div>

      {connectionState !== 'connected' ? (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-between bg-bg px-4 py-12">
          <div></div>
          <div className="text-sm text-header-text">
            {connectionState === 'connecting' ? t('ssh.connecting') : connectionError}
          </div>
          {connectionState !== 'connecting' ? (
            <div className="flex items-center justify-center">
              <Menubar>
                <Button onClick={handleRetry}>
                  <RefreshCw size={16} />
                  {t('ssh.retry')}
                </Button>
              </Menubar>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={hostFingerprintPrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            resolveHostFingerprintPrompt(false);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            resolveHostFingerprintPrompt(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ssh.hostFingerprintDialogTitle')}</DialogTitle>
            <DialogDescription>{t('ssh.hostFingerprintDialogDescription')}</DialogDescription>
          </DialogHeader>

          {hostFingerprintPrompt ? (
            <div className="space-y-2 rounded-md border border-home-divider p-3 text-sm">
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogHost')}: </span>
                <span>
                  {hostFingerprintPrompt.host}:{hostFingerprintPrompt.port}
                </span>
              </div>
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogAlgorithm')}: </span>
                <span>{hostFingerprintPrompt.algorithm}</span>
              </div>
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogFingerprint')}: </span>
                <span className="break-all">{hostFingerprintPrompt.fingerprint}</span>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <DialogSecondaryButton onClick={() => resolveHostFingerprintPrompt(false)}>
              {t('ssh.hostFingerprintDialogCancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton onClick={() => resolveHostFingerprintPrompt(true)}>
              {t('ssh.hostFingerprintDialogTrustContinue')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SSH;
