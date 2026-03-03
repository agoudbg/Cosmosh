import type { components, SettingsValues } from '@cosmosh/api-contract';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { TerminalAutocompleteItem } from '../../components/terminal/terminal-autocomplete-menu';

/**
 * Lightweight SSH server entry used by target resolution and tab title updates.
 */
export type SshServerListItem = components['schemas']['SshServerListItem'];

/**
 * Websocket payloads sent from renderer terminal to backend session runtime.
 */
export type ClientOutboundMessage =
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
    }
  | {
      type: 'history-delete';
      command: string;
    }
  | {
      type: 'completion-request';
      requestId: string;
      linePrefix: string;
      cursorIndex: number;
      limit?: number;
      fuzzyMatch?: boolean;
      trigger: 'typing' | 'manual';
    };

/**
 * Websocket payloads received by renderer from backend session runtime.
 */
export type ServerInboundMessage =
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
    }
  | {
      type: 'history';
      recentCommands: string[];
    }
  | {
      type: 'completion-response';
      requestId: string;
      replacePrefixLength: number;
      items: TerminalAutocompleteItem[];
    };

/**
 * Aggregated telemetry state rendered in SSH sidebar cards.
 */
export type SshTelemetryState = {
  cpuUsagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  recentCommands: string[];
};

/**
 * Data used by host-fingerprint trust dialog.
 */
export type HostFingerprintPrompt = {
  serverId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};

/**
 * Resolved terminal runtime target (remote SSH server or local profile).
 */
export type ResolvedTerminalTarget =
  | {
      type: 'ssh-server';
      server: SshServerListItem;
    }
  | {
      type: 'local-terminal';
      profileId: string;
      profileName: string | null;
    };

/**
 * Absolute geometry and content metadata for selected terminal text.
 */
export type TerminalSelectionAnchor = {
  selectionText: string;
  pointerClientX: number | null;
  anchorLeft: number;
  anchorRight: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
};

/**
 * Position where selection toolbar should be rendered.
 */
export type TerminalSelectionBarPosition = {
  top: number;
  left: number;
};

/**
 * Placement information for autocomplete popup.
 */
export type TerminalAutocompleteAnchor = {
  top: number;
  left: number;
  renderAbove: boolean;
};

/**
 * Selection bar behavior derived from settings store.
 */
export type TerminalSelectionSettings = {
  enabled: boolean;
  searchEngine: SettingsValues['terminalSelectionSearchEngine'];
  searchUrlTemplate: string;
};

/**
 * Bounding box fields reused by selection geometry calculations.
 */
export type TerminalSelectionBounds = Pick<
  TerminalSelectionAnchor,
  'anchorLeft' | 'anchorRight' | 'top' | 'left' | 'right' | 'bottom'
>;

/**
 * Runtime resources owned by each mirrored terminal pane.
 */
export type MirrorPaneRuntime = {
  terminal: Terminal;
  fitAddon: FitAddon;
  containerElement: HTMLDivElement;
  socket: WebSocket | null;
  sessionId: string | null;
  sessionType: 'ssh-server' | 'local-terminal' | null;
  dispose: () => void;
};

/** Internal DnD mime marker for terminal-originated text payloads. */
export const INTERNAL_TERMINAL_TEXT_DRAG_MIME = 'application/x-cosmosh-terminal-text';
/** Estimated width used when clamping autocomplete popup placement. */
export const AUTOCOMPLETE_PANEL_ESTIMATED_WIDTH = 520;
/** Horizontal/vertical safety padding for autocomplete popup placement. */
export const AUTOCOMPLETE_PANEL_EDGE_PADDING = 8;
/** Debounce window for typing-triggered autocomplete requests. */
export const AUTOCOMPLETE_TYPING_DEBOUNCE_MS = 180;
/** Hard limit of terminal panes visible in SSH page. */
export const MAX_TERMINAL_PANES = 4;

/**
 * Baseline telemetry state used on initial mount and reconnect attempts.
 */
export const DEFAULT_TELEMETRY_STATE: SshTelemetryState = {
  cpuUsagePercent: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  networkRxBytesPerSec: null,
  networkTxBytesPerSec: null,
  recentCommands: [],
};
