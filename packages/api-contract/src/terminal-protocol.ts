/** Renderer-to-Backend messages supported by interactive terminal sessions. */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' }
  | { type: 'ping' };

/** Messages common to local and SSH terminal WebSocket sessions. */
export type TerminalServerMessage =
  | { type: 'ready' }
  | { type: 'output'; data: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; reason: string }
  | { type: 'pong' }
  | {
      type: 'telemetry';
      cpuUsagePercent: number | null;
      memoryUsedBytes: number | null;
      memoryTotalBytes: number | null;
      networkRxBytesPerSec: number | null;
      networkTxBytesPerSec: number | null;
    };

/** Complete Backend-to-Renderer message contract for SSH terminal sessions. */
export type SshTerminalServerMessage = TerminalServerMessage;
