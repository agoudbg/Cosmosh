import type {
  components,
  SettingsValues,
  SshTerminalServerMessage,
  TerminalClientMessage,
} from '@cosmosh/api-contract';
import type { IClipboardProvider } from '@xterm/addon-clipboard';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

/**
 * Lightweight SSH server entry used by target resolution and tab title updates.
 */
export type SshServerListItem = components['schemas']['SshServerListItem'];

/**
 * Websocket payloads sent from renderer terminal to backend session runtime.
 */
export type ClientOutboundMessage = TerminalClientMessage;

/** Transport lifecycle state owned by one terminal pane. */
export type SshConnectionState = 'connecting' | 'connected' | 'failed';

/** Per-pane transport snapshot consumed by pane-scoped connection overlays. */
export type SshPaneConnectionSnapshot = {
  connectionState: SshConnectionState;
  connectionError: string;
};

/**
 * Websocket payloads received by renderer from backend session runtime.
 */
export type ServerInboundMessage = SshTerminalServerMessage;

/**
 * Aggregated telemetry state rendered in SSH sidebar cards.
 */
export type SshTelemetryState = {
  cpuUsagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
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
 * Runtime resources owned uniformly by every SSH terminal pane.
 */
export type TerminalPaneRuntime = {
  owner: 'primary' | 'secondary';
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  serializeAddon: SerializeAddon;
  clipboardProvider: IClipboardProvider;
  webglAddon: WebglAddon | null;
  containerElement: HTMLDivElement;
  socket: WebSocket | null;
  sessionId: string | null;
  sessionType: 'ssh-server' | 'local-terminal' | null;
  reconnect: () => void;
  dispose: () => void;
};

/** Internal DnD mime marker for terminal-originated text payloads. */
export const INTERNAL_TERMINAL_TEXT_DRAG_MIME = 'application/x-cosmosh-terminal-text';
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
};
