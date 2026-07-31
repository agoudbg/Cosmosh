import type {
  AgentTerminalAttachmentStatus,
  components,
  RemoteBootstrapStatus as ApiRemoteBootstrapStatus,
  RemoteEnhancementRuntimeStatus as ApiRemoteEnhancementRuntimeStatus,
  RemoteShellEventMessage,
  SettingsValues,
  SshTerminalServerMessage,
  TerminalClientMessage,
} from '@cosmosh/api-contract';
import type { IClipboardProvider } from '@xterm/addon-clipboard';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { IMarker, Terminal } from '@xterm/xterm';

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
 * Latest remote bootstrap status surfaced by backend side-channel installation.
 */
export type RemoteBootstrapStatus = ApiRemoteBootstrapStatus;

/**
 * Remote shell status event emitted by the installed shell helper over OSC 777.
 */
export type RemoteShellEvent = RemoteShellEventMessage;

/**
 * Backend-owned trust state for the installed remote enhancement runtime.
 */
export type RemoteEnhancementRuntimeStatus = ApiRemoteEnhancementRuntimeStatus;

/** Renderer-owned state needed to publish one pane to the Agent selector. */
export type AgentTerminalPaneState = {
  sessionId: string | null;
  sessionType: TerminalPaneRuntime['sessionType'];
  connectionState: SshConnectionState;
  remoteEnhancementRuntimeStatus: RemoteEnhancementRuntimeStatus | null;
  atPrompt: boolean;
  lineLength: number;
  attachmentStatus: AgentTerminalAttachmentStatus | null;
};

/**
 * Timestamped remote enhancement event retained for SSH debug inspection.
 */
export type RemoteEnhancementsDebugEvent = {
  receivedAt: number;
  payload: RemoteBootstrapStatus | RemoteShellEvent | RemoteEnhancementRuntimeStatus;
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
  panelWidth: number;
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
 * Hidden input marker awaiting confirmation from a trusted `command-start` event.
 */
export type TerminalPendingCommandMarker = {
  marker: IMarker;
  recordedAt: number;
};

/**
 * One trusted user command retained in a pane-local visual timeline.
 *
 * The renderer keeps the full command only in memory. Separate xterm markers
 * preserve the input row used for navigation and the output interval used for
 * lifecycle cleanup without retaining command output.
 */
export type TerminalCommandMarker = {
  commandId: string;
  command: string;
  inputMarker: IMarker;
  outputStartMarker: IMarker;
  outputEndMarker: IMarker | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
};

/**
 * Serializable renderer view of one retained command timeline entry.
 */
export type TerminalCommandTimelineItem = {
  commandId: string;
  command: string;
};

/**
 * Pane-local command timeline state consumed by the SSH pane layout.
 */
export type TerminalCommandTimelineModel = {
  /** Whether the pane reserves the fixed command timeline rail. */
  railReserved: boolean;
  /** Whether normal-buffer depth and retained trusted history exceed the entry thresholds. */
  historyVisible: boolean;
  alternateScreenActive: boolean;
  items: TerminalCommandTimelineItem[];
  activeCommandId: string | null;
};

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
  pendingCommandMarkers: TerminalPendingCommandMarker[];
  commandMarkers: TerminalCommandMarker[];
  refreshCommandTimeline: () => void;
  reconnect: () => void;
  dispose: () => void;
};

/** Internal DnD mime marker for terminal-originated text payloads. */
export const INTERNAL_TERMINAL_TEXT_DRAG_MIME = 'application/x-cosmosh-terminal-text';
/** Estimated width used when clamping autocomplete popup placement. */
export const AUTOCOMPLETE_PANEL_ESTIMATED_WIDTH = 520;
/** Horizontal/vertical safety padding for autocomplete popup placement. */
export const AUTOCOMPLETE_PANEL_EDGE_PADDING = 8;
/** Debounce window for typing-triggered autocomplete requests. */
export const AUTOCOMPLETE_TYPING_DEBOUNCE_MS = 70;
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
