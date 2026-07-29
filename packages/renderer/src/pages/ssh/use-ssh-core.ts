import { type ISearchOptions, type SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { type ITerminalOptions, type Terminal } from '@xterm/xterm';
import React from 'react';

import type { TerminalAutocompleteMenuHandle } from '../../components/terminal/terminal-autocomplete-menu';
import { t } from '../../lib/i18n';
import type { SshConnectionIntent, TabIconColorKey, TabIconKey } from '../../types/tabs';
import {
  applyRemoteCommandMarkerEvent,
  clearTerminalCommandMarkers,
  createTerminalCommandTimelineModel,
  recordPendingCommandMarker,
  scrollToTerminalCommandMarker,
} from './ssh-command-markers';
import {
  createSshPaneState,
  reduceSshPaneState,
  type SshPaneStateAction,
  type SshPaneStateMap,
} from './ssh-pane-state';
import {
  type HostFingerprintPrompt,
  MAX_TERMINAL_PANES,
  type RemoteBootstrapStatus,
  type RemoteEnhancementRuntimeStatus,
  type RemoteEnhancementsDebugEvent,
  type ResolvedTerminalTarget,
  type ServerInboundMessage,
  type SshConnectionState,
  type SshPaneConnectionSnapshot,
  type SshTelemetryState,
  type TerminalAutocompleteAnchor,
  type TerminalCommandTimelineModel,
  type TerminalPaneRuntime,
  type TerminalSelectionAnchor,
  type TerminalSelectionBarPosition,
} from './ssh-types';
import {
  compilePromptPrefixRegex,
  resolveTerminalPaneCloseTransition,
  SECRET_PROMPT_PATTERN,
  sendClientMessage,
  shouldReconnectTerminalPaneOnActivation,
} from './ssh-utils';
import {
  disposeTerminalWebglAddon,
  syncTerminalWebglAddon,
  type TerminalExternalLinkHandler,
  type TerminalHardwareAccelerationState,
  type TerminalInlineImageSettings,
  type TerminalWebglAddonRuntime,
  type TerminalWebLinksSettings,
} from './terminal-addons';
import {
  createTerminalPresentationState,
  reduceTerminalPresentationState,
  type TerminalPresentationStateAction,
  type TerminalPresentationStateMap,
} from './terminal-presentation-state';
import { useSshAutocomplete } from './use-ssh-autocomplete';
import { useSshMirrorPanes } from './use-ssh-mirror-panes';
import { useSshPrimarySession } from './use-ssh-primary-session';
import { useSshSelectionBar } from './use-ssh-selection-bar';
import type { TerminalClipboardProvider } from './use-terminal-clipboard-provider';

/** Re-exported pane transport types for existing hook-API consumers. */
export type { SshConnectionState, SshPaneConnectionSnapshot } from './ssh-types';
export type TerminalSearchDirection = 'previous' | 'next' | 'first' | 'last';
export type TerminalSearchOptions = Pick<ISearchOptions, 'caseSensitive' | 'regex'>;

/**
 * Runtime-only mutable resources that should not trigger React renders.
 */
type PaneSessionRuntime = {
  paneId: string;
  isPrimary: boolean;
  terminal: Terminal | null;
  socket: WebSocket | null;
  container: HTMLDivElement | null;
};

/**
 * Active-pane terminal search resources used to execute xterm search actions.
 */
type ActiveSearchResources = {
  addon: SearchAddon;
  terminal: Terminal;
};

/**
 * Runtime session coordinator for pane-level socket/terminal routing.
 */
class SshRuntimeCoordinator {
  public primaryPaneId = 'pane-1';
  public activePaneId = 'pane-1';
  public paneIdSequence = 1;
  public activeTerminal: Terminal | null = null;
  public primaryTerminal: Terminal | null = null;
  public primarySearchAddon: SearchAddon | null = null;
  public primarySerializeAddon: SerializeAddon | null = null;
  public primaryWebglAddonRuntime: TerminalWebglAddonRuntime = {
    webglAddon: null,
  };
  public activeSocket: WebSocket | null = null;
  public primarySocket: WebSocket | null = null;
  public activeContainer: HTMLDivElement | null = null;
  public resolvedTarget: ResolvedTerminalTarget | null = null;
  public scheduleFitAndResizeSync: (() => void) | null = null;
  public selectionPointerClientX: number | null = null;
  public readonly paneContainerMap: Map<string, HTMLDivElement> = new Map();
  public readonly paneRuntimeMap: Map<string, TerminalPaneRuntime> = new Map();
  public readonly sessionMap: Map<string, PaneSessionRuntime> = new Map();

  /**
   * Returns existing pane session entry or creates one lazily.
   *
   * @param paneId Logical pane identifier.
   * @returns Mutable pane session runtime entry.
   */
  public ensureSession(paneId: string): PaneSessionRuntime {
    const existing = this.sessionMap.get(paneId);
    if (existing) {
      return existing;
    }

    const created: PaneSessionRuntime = {
      paneId,
      isPrimary: paneId === this.primaryPaneId,
      terminal: null,
      socket: null,
      container: null,
    };
    this.sessionMap.set(paneId, created);
    return created;
  }

  /**
   * Applies active pane routing to terminal/socket/container handles.
   *
   * @param paneId Pane id that should become active.
   * @param terminalContainerRef Mutable active container ref used by view hooks.
   * @returns Nothing.
   */
  public applyActivePane(paneId: string, terminalContainerRef: React.MutableRefObject<HTMLDivElement | null>): void {
    this.activePaneId = paneId;
    const session = this.ensureSession(paneId);

    this.activeTerminal = session.terminal;
    this.activeSocket = session.socket;
    this.activeContainer = session.container;

    terminalContainerRef.current = session.container;
  }
}

/**
 * Creates a stable mutable ref adapter over a runtime object field.
 *
 * @param runtimeRef Runtime container ref.
 * @param getValue Getter for target field.
 * @param setValue Setter for target field.
 * @returns Mutable ref facade compatible with existing hooks.
 */
const useRuntimeFieldRef = <T>(
  runtimeRef: React.MutableRefObject<SshRuntimeCoordinator>,
  getValue: (runtime: SshRuntimeCoordinator) => T,
  setValue: (runtime: SshRuntimeCoordinator, value: T) => void,
): React.MutableRefObject<T> => {
  const fieldRef = React.useRef<React.MutableRefObject<T> | null>(null);

  if (!fieldRef.current) {
    const refFacade: React.MutableRefObject<T> = {
      get current(): T {
        return getValue(runtimeRef.current);
      },
      set current(value: T) {
        setValue(runtimeRef.current, value);
      },
    };

    fieldRef.current = refFacade;
  }

  return fieldRef.current;
};

/**
 * Determines whether a Backend-authenticated helper can drive the renderer's
 * command timeline for one pane.
 *
 * @param status Latest pane-local Remote Enhancements trust status.
 * @returns `true` only while the runtime is active and advertises `command-start`.
 */
const supportsTrustedCommandTimeline = (status: RemoteEnhancementRuntimeStatus | null | undefined): boolean =>
  status?.state === 'active' && status.capabilities?.includes('command-start') === true;

/**
 * Input parameters for `useSshCore`.
 */
export type UseSshCoreParams = {
  tabId: string;
  isActive: boolean;
  connectionIntent: SshConnectionIntent;
  onConnectionIntentChange: (nextIntent: SshConnectionIntent) => void;
  terminalInitOptions: ITerminalOptions;
  sshConnectionTimeoutSec: number;
  terminalAutoCompleteEnabled: boolean;
  terminalAutoCompleteHistoryEnabled: boolean;
  terminalAutoCompleteBuiltInCommandsEnabled: boolean;
  terminalAutoCompletePathEnabled: boolean;
  terminalAutoCompletePasswordEnabled: boolean;
  terminalAutoCompleteAcceptKeys: 'tab' | 'enter' | 'tabEnter';
  terminalAutoCompleteMinChars: number;
  terminalAutoCompleteMaxItems: number;
  terminalAutoCompleteFuzzyMatch: boolean;
  terminalAutoCompletePromptRegex: string;
  terminalBracketedPasteEnabled: boolean;
  characterWidthCompatibilityModeEnabled: boolean;
  terminalClipboardProvider: TerminalClipboardProvider;
  terminalHardwareAccelerationEnabled: boolean;
  terminalInlineImageSettings: TerminalInlineImageSettings;
  terminalWebLinksSettings: TerminalWebLinksSettings;
  terminalCommandTimelineEnabled: boolean;
  terminalSelectionBarEnabled: boolean;
  sshReconnectOnFocus: boolean;
  onTabTitleChange?: (title: string) => void;
  onTabVisualChange?: (visual: { iconKey: TabIconKey; iconColorKey?: TabIconColorKey }) => void;
  requestHostFingerprintTrust?: (prompt: HostFingerprintPrompt) => Promise<boolean>;
  openExternalLink: TerminalExternalLinkHandler;
  onTerminalSelectionChange: (selectionText: string) => void;
  notifyWarning: (message: string) => void;
};

/**
 * Declarative state exposed by `useSshCore`.
 */
export type SshCoreState = {
  terminalPaneIds: string[];
  activePaneId: string;
  connectionState: SshConnectionState;
  connectionError: string;
  paneConnectionStates: Record<string, SshPaneConnectionSnapshot>;
  telemetryState: SshTelemetryState;
  remoteBootstrapStatus: RemoteBootstrapStatus | null;
  remoteEnhancementRuntimeStatus: RemoteEnhancementRuntimeStatus | null;
  remoteEnhancementsDebugEvents: RemoteEnhancementsDebugEvent[];
  trustedCwd: string | null;
  commandTimelineModels: Record<string, TerminalCommandTimelineModel>;
  terminalPresentationStates: TerminalPresentationStateMap;
  hostFingerprintPrompt: HostFingerprintPrompt | null;
  canSplitTerminal: boolean;
  selectionAnchor: TerminalSelectionAnchor | null;
  selectionBarPosition: TerminalSelectionBarPosition | null;
  dismissedSelectionText: string | null;
  autocompleteItems: ReturnType<typeof useSshAutocomplete>['autocompleteItems'];
  autocompleteAnchor: TerminalAutocompleteAnchor | null;
};

/**
 * Declarative operations exposed by `useSshCore`.
 */
export type SshCoreActions = {
  /**
   * Activates a pane and routes follow-up input/socket interactions to it.
   *
   * @param paneId Logical pane identifier to activate.
   * @returns Nothing.
   */
  activatePane: (paneId: string) => void;
  /**
   * Splits terminal layout by creating one mirrored pane when capacity allows.
   *
   * @returns Nothing.
   */
  splitPane: () => void;
  /**
   * Closes one pane and keeps the remaining active pane deterministic.
   *
   * @param paneId Logical pane identifier to close.
   * @returns Nothing.
   */
  closePane: (paneId: string) => void;
  /**
   * Retries one pane's failed session using that pane's own connector.
   *
   * @param paneId Logical pane identifier to reconnect.
   * @returns Nothing.
   */
  retryPaneConnection: (paneId: string) => void;
  /**
   * Sends raw input data to current active pane session.
   *
   * @param data Raw terminal input bytes encoded as string.
   * @returns `true` when payload is sent to an open socket, otherwise `false`.
   */
  sendInput: (data: string) => boolean;
  /**
   * Pastes text into active pane input path.
   *
   * @param text Clipboard or dropped text payload.
   * @returns `true` when payload is delivered, otherwise `false`.
   */
  pasteInput: (text: string) => boolean;
  /**
   * Sends command-history deletion request for current active session.
   *
   * @param command Normalized command string to remove.
   * @returns Nothing.
   */
  deleteHistoryCommand: (command: string) => void;
  /**
   * Selects all text in currently active terminal.
   *
   * @returns Nothing.
   */
  selectAll: () => void;
  /**
   * Returns current terminal selection text from active pane.
   *
   * @returns Selection text, or empty string.
   */
  getSelectionText: () => string;
  /**
   * Returns current terminal selection serialized as HTML from active pane.
   *
   * @returns Selection HTML, or empty string when serialization is unavailable.
   */
  getSelectionHtml: () => string;
  /**
   * Focuses currently active terminal instance.
   *
   * @returns Nothing.
   */
  focusActiveTerminal: () => void;
  /**
   * Sends ANSI clear-screen control sequence to current active session.
   *
   * @returns Nothing.
   */
  clearTerminalScreen: () => void;
  /**
   * Scrolls one pane to a command selected directly from its timeline.
   *
   * @param paneId Source pane id.
   * @param commandId Retained command marker id.
   * @returns Nothing.
   */
  scrollToPaneCommand: (paneId: string, commandId: string) => void;
  /**
   * Runs active-pane terminal text search and updates the highlighted match.
   *
   * @param query Search text.
   * @param direction Navigation direction or boundary jump.
   * @param options Search behavior flags shared by command-palette toggles.
   * @returns `true` when at least one match is found.
   */
  findActiveTerminalText: (
    query: string,
    direction: TerminalSearchDirection,
    options: TerminalSearchOptions,
  ) => boolean;
  /**
   * Clears active-pane search decorations and search-driven selection highlight.
   *
   * @returns void.
   */
  clearActiveTerminalSearch: () => void;
  /**
   * Registers pane container element for runtime routing and layout sync.
   *
   * @param paneId Logical pane identifier.
   * @param element Current pane DOM element.
   * @returns Nothing.
   */
  setPaneContainerElement: (paneId: string, element: HTMLDivElement | null) => void;
  /**
   * Registers primary pane container for xterm mounting.
   *
   * @param element Primary pane container element.
   * @returns Nothing.
   */
  setPrimaryPaneContainer: (element: HTMLDivElement | null) => void;
  /**
   * Resolves host fingerprint prompt and unblocks pending connect flow.
   *
   * @param accepted Whether user accepted trust.
   * @returns Nothing.
   */
  resolveHostFingerprintPrompt: (accepted: boolean) => void;
  /**
   * Dismisses current floating selection toolbar.
   *
   * @returns Nothing.
   */
  dismissSelectionBar: () => void;
  /**
   * Accepts one autocomplete candidate by list index.
   *
   * @param index Candidate index in current suggestion list.
   * @returns Nothing.
   */
  acceptAutocompleteAtIndex: (index: number) => void;
};

/**
 * Ref handles required by SSH view/container-level interaction wiring.
 */
export type SshCoreRefs = {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  selectionBarRef: React.RefObject<HTMLDivElement | null>;
  autocompleteMenuRef: React.RefObject<TerminalAutocompleteMenuHandle | null>;
};

/**
 * Complete return type for `useSshCore`.
 */
export type UseSshCoreResult = {
  state: SshCoreState;
  actions: SshCoreActions;
  refs: SshCoreRefs;
};

/**
 * Central SSH runtime coordinator with declarative state and actions.
 *
 * This hook consolidates connection status, pane activation, host-trust dialog
 * state, and terminal runtime resources under one stable API so `SSH.tsx`
 * can remain view-focused and avoid imperative ref orchestration.
 *
 * @param params Settings-driven behavior and host trust callback dependencies.
 * @returns Declarative SSH page model (state + actions + required DOM refs).
 */
export const useSshCore = (params: UseSshCoreParams): UseSshCoreResult => {
  /**
   * Reads the latest trusted line-state calibration for one pane.
   *
   * @param paneId Source pane id.
   * @returns Latest line-state metadata, or `null` when unsupported/stale.
   */
  const getPaneLineState = React.useCallback((paneId: string) => {
    return paneStateMapRef.current[paneId]?.lineState ?? null;
  }, []);

  /**
   * Reads the latest helper-reported working directory for one pane.
   *
   * @param paneId Source pane id.
   * @returns Trusted absolute cwd, or `null` before a cwd event is received.
   */
  const getPaneTrustedCwd = React.useCallback((paneId: string): string | null => {
    return paneStateMapRef.current[paneId]?.trustedCwd ?? null;
  }, []);

  const {
    tabId,
    isActive,
    connectionIntent,
    onConnectionIntentChange,
    terminalInitOptions,
    sshConnectionTimeoutSec,
    terminalAutoCompleteEnabled,
    terminalAutoCompleteHistoryEnabled,
    terminalAutoCompleteBuiltInCommandsEnabled,
    terminalAutoCompletePathEnabled,
    terminalAutoCompletePasswordEnabled,
    terminalAutoCompleteAcceptKeys,
    terminalAutoCompleteMinChars,
    terminalAutoCompleteMaxItems,
    terminalAutoCompleteFuzzyMatch,
    terminalAutoCompletePromptRegex,
    terminalBracketedPasteEnabled,
    characterWidthCompatibilityModeEnabled,
    terminalClipboardProvider,
    terminalHardwareAccelerationEnabled,
    terminalInlineImageSettings,
    terminalWebLinksSettings,
    terminalCommandTimelineEnabled,
    terminalSelectionBarEnabled,
    sshReconnectOnFocus,
    onTabTitleChange,
    onTabVisualChange,
    requestHostFingerprintTrust,
    openExternalLink,
    onTerminalSelectionChange,
    notifyWarning,
  } = params;

  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const selectionBarRef = React.useRef<HTMLDivElement | null>(null);
  const runtimeRef = React.useRef(new SshRuntimeCoordinator());
  const primaryPaneIdRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primaryPaneId,
    (runtime, value) => {
      runtime.primaryPaneId = value;
    },
  );
  const activePaneIdRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.activePaneId,
    (runtime, value) => {
      runtime.activePaneId = value;
    },
  );
  const onTabTitleChangeRef = React.useRef<UseSshCoreParams['onTabTitleChange']>(onTabTitleChange);
  const onTabVisualChangeRef = React.useRef<UseSshCoreParams['onTabVisualChange']>(onTabVisualChange);
  const fingerprintPromptResolverRef = React.useRef<((accepted: boolean) => void) | null>(null);

  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const terminalRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.activeTerminal,
    (runtime, value) => {
      runtime.activeTerminal = value;
    },
  );
  const primaryTerminalRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primaryTerminal,
    (runtime, value) => {
      runtime.primaryTerminal = value;
    },
  );
  const primarySearchAddonRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primarySearchAddon,
    (runtime, value) => {
      runtime.primarySearchAddon = value;
    },
  );
  const primarySerializeAddonRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primarySerializeAddon,
    (runtime, value) => {
      runtime.primarySerializeAddon = value;
    },
  );
  const primaryWebglAddonRuntimeRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primaryWebglAddonRuntime,
    (runtime, value) => {
      runtime.primaryWebglAddonRuntime = value;
    },
  );
  const primarySocketRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.primarySocket,
    (runtime, value) => {
      runtime.primarySocket = value;
    },
  );
  const socketRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.activeSocket,
    (runtime, value) => {
      runtime.activeSocket = value;
    },
  );
  const resolvedTerminalTargetRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.resolvedTarget,
    (runtime, value) => {
      runtime.resolvedTarget = value;
    },
  );
  const paneContainerMapRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.paneContainerMap,
    () => undefined,
  );
  const paneRuntimeMapRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.paneRuntimeMap,
    () => undefined,
  );
  const scheduleFitAndResizeSyncRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.scheduleFitAndResizeSync,
    (runtime, value) => {
      runtime.scheduleFitAndResizeSync = value;
    },
  );
  const selectionPointerClientXRef = useRuntimeFieldRef(
    runtimeRef,
    (runtime) => runtime.selectionPointerClientX,
    (runtime, value) => {
      runtime.selectionPointerClientX = value;
    },
  );
  const terminalInitOptionsRef = React.useRef<ITerminalOptions>(terminalInitOptions);
  const characterWidthCompatibilityModeEnabledRef = React.useRef<boolean>(characterWidthCompatibilityModeEnabled);
  const sshConnectionTimeoutSecRef = React.useRef<number>(sshConnectionTimeoutSec);
  const sshReconnectOnFocusRef = React.useRef<boolean>(sshReconnectOnFocus);
  const wasActiveRef = React.useRef<boolean>(isActive);
  const hasEverBeenActiveRef = React.useRef<boolean>(isActive);
  const terminalInlineImageSettingsRef = React.useRef<TerminalInlineImageSettings>(terminalInlineImageSettings);
  const terminalWebLinksSettingsRef = React.useRef<TerminalWebLinksSettings>(terminalWebLinksSettings);
  const openExternalLinkRef = React.useRef<TerminalExternalLinkHandler>(openExternalLink);
  const hardwareAccelerationStateRef = React.useRef<TerminalHardwareAccelerationState>({
    isEnabledBySettings: terminalHardwareAccelerationEnabled,
    isRuntimeDisabled: false,
    hasShownContextLossWarning: false,
  });

  const [terminalPaneIds, setTerminalPaneIds] = React.useState<string[]>(['pane-1']);
  const [activePaneId, setActivePaneId] = React.useState<string>('pane-1');
  const [paneStateMap, dispatchPaneStateReducer] = React.useReducer(reduceSshPaneState, {
    'pane-1': createSshPaneState(),
  });
  const paneStateMapRef = React.useRef<SshPaneStateMap>(paneStateMap);
  const [terminalPresentationStates, dispatchTerminalPresentationStateReducer] = React.useReducer(
    reduceTerminalPresentationState,
    {
      'pane-1': createTerminalPresentationState(),
    },
  );
  const terminalPresentationStatesRef = React.useRef<TerminalPresentationStateMap>(terminalPresentationStates);
  const [sessionTargetReady, setSessionTargetReady] = React.useState<boolean>(false);
  const [, setCommandMarkerRevision] = React.useState<number>(0);
  const commandTimelineRefreshFrameRef = React.useRef<number | null>(null);
  const [hostFingerprintPrompt, setHostFingerprintPrompt] = React.useState<HostFingerprintPrompt | null>(null);
  const activePaneState = paneStateMap[activePaneId] ?? createSshPaneState();
  const connectionState = activePaneState.connectionState;
  const connectionError = activePaneState.connectionError;
  const telemetryState = activePaneState.telemetryState;
  const remoteBootstrapStatus: RemoteBootstrapStatus | null = activePaneState.remoteBootstrapStatus;
  const remoteEnhancementRuntimeStatus: RemoteEnhancementRuntimeStatus | null =
    activePaneState.remoteEnhancementRuntimeStatus;
  const remoteEnhancementsDebugEvents: RemoteEnhancementsDebugEvent[] = activePaneState.remoteEnhancementsDebugEvents;
  const paneConnectionStates: Record<string, SshPaneConnectionSnapshot> = {};
  terminalPaneIds.forEach((paneId) => {
    const paneState = paneStateMap[paneId] ?? createSshPaneState();
    paneConnectionStates[paneId] = {
      connectionState: paneState.connectionState,
      connectionError: paneState.connectionError,
    };
  });
  const compiledPromptPrefixRegex = React.useMemo(
    () => compilePromptPrefixRegex(terminalAutoCompletePromptRegex),
    [terminalAutoCompletePromptRegex],
  );
  // Read through a ref inside pane message handling so a settings edit never
  // changes handlePaneServerMessage identity: the primary-session effect
  // depends on that callback and would otherwise dispose and reconnect every
  // live terminal.
  const compiledPromptPrefixRegexRef = React.useRef<RegExp | null>(compiledPromptPrefixRegex);

  React.useEffect(() => {
    compiledPromptPrefixRegexRef.current = compiledPromptPrefixRegex;
  }, [compiledPromptPrefixRegex]);

  /**
   * Coalesces xterm write, scroll, and marker-disposal updates into one React
   * render per animation frame across all panes.
   *
   * @returns Nothing.
   */
  const refreshCommandTimeline = React.useCallback((): void => {
    if (commandTimelineRefreshFrameRef.current !== null) {
      return;
    }

    commandTimelineRefreshFrameRef.current = requestAnimationFrame(() => {
      commandTimelineRefreshFrameRef.current = null;
      setCommandMarkerRevision((previous) => previous + 1);
    });
  }, []);

  React.useEffect(
    () => () => {
      if (commandTimelineRefreshFrameRef.current !== null) {
        cancelAnimationFrame(commandTimelineRefreshFrameRef.current);
        commandTimelineRefreshFrameRef.current = null;
      }
    },
    [],
  );

  const commandTimelineModels: Record<string, TerminalCommandTimelineModel> = {};
  terminalPaneIds.forEach((paneId) => {
    const paneRuntime = paneRuntimeMapRef.current.get(paneId);
    if (!paneRuntime) {
      commandTimelineModels[paneId] = {
        railReserved: false,
        historyVisible: false,
        alternateScreenActive: false,
        items: [],
        activeCommandId: null,
      };
      return;
    }

    commandTimelineModels[paneId] = createTerminalCommandTimelineModel(
      paneRuntime,
      terminalCommandTimelineEnabled &&
        supportsTrustedCommandTimeline(paneStateMap[paneId]?.remoteEnhancementRuntimeStatus),
    );
  });
  /**
   * Changes only when CSS starts or stops reserving the pane-local command rail.
   *
   * The xterm host keeps a stable outer width, so this explicit layout signal
   * lets the existing fit pipeline observe descendant padding changes.
   */
  const commandTimelineRailReservationKey = terminalPaneIds
    .filter((paneId) => commandTimelineModels[paneId]?.railReserved)
    .join('|');

  /**
   * Dispatches pane state synchronously to the imperative routing ref and React reducer.
   *
   * @param action Pane lifecycle or inbound-message action.
   * @returns Nothing.
   */
  const dispatchPaneState = React.useCallback((action: SshPaneStateAction): void => {
    paneStateMapRef.current = reduceSshPaneState(paneStateMapRef.current, action);
    dispatchPaneStateReducer(action);
  }, []);

  /**
   * Dispatches presentation state synchronously to the lifecycle ref and React reducer.
   *
   * @param action Pane lifecycle or xterm presentation action.
   * @returns Nothing.
   */
  const dispatchTerminalPresentationState = React.useCallback((action: TerminalPresentationStateAction): void => {
    terminalPresentationStatesRef.current = reduceTerminalPresentationState(
      terminalPresentationStatesRef.current,
      action,
    );
    dispatchTerminalPresentationStateReducer(action);
  }, []);

  /**
   * Clears application-owned presentation state before one pane reconnects.
   *
   * @param paneId Pane whose previous terminal application state is stale.
   * @returns Nothing.
   */
  const resetTerminalPresentationState = React.useCallback(
    (paneId: string): void => {
      dispatchTerminalPresentationState({ type: 'reset-pane', paneId });
    },
    [dispatchTerminalPresentationState],
  );

  React.useEffect(() => {
    paneStateMapRef.current = paneStateMap;
  }, [paneStateMap]);

  React.useEffect(() => {
    terminalPresentationStatesRef.current = terminalPresentationStates;
  }, [terminalPresentationStates]);

  React.useEffect(() => {
    onTabTitleChangeRef.current = onTabTitleChange;
  }, [onTabTitleChange]);

  React.useEffect(() => {
    onTabVisualChangeRef.current = onTabVisualChange;
  }, [onTabVisualChange]);

  React.useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId, activePaneIdRef]);

  React.useEffect(() => {
    terminalPaneIds.forEach((paneId) => {
      dispatchPaneState({ type: 'ensure-pane', paneId });
      dispatchTerminalPresentationState({ type: 'ensure-pane', paneId });
    });

    Object.keys(paneStateMapRef.current).forEach((paneId) => {
      if (!terminalPaneIds.includes(paneId)) {
        dispatchPaneState({ type: 'remove-pane', paneId });
      }
    });

    Object.keys(terminalPresentationStatesRef.current).forEach((paneId) => {
      if (!terminalPaneIds.includes(paneId)) {
        dispatchTerminalPresentationState({ type: 'remove-pane', paneId });
      }
    });
  }, [dispatchPaneState, dispatchTerminalPresentationState, terminalPaneIds]);

  React.useEffect(() => {
    terminalInitOptionsRef.current = terminalInitOptions;
  }, [terminalInitOptions]);

  React.useEffect(() => {
    characterWidthCompatibilityModeEnabledRef.current = characterWidthCompatibilityModeEnabled;
  }, [characterWidthCompatibilityModeEnabled]);

  React.useEffect(() => {
    sshConnectionTimeoutSecRef.current = sshConnectionTimeoutSec;
  }, [sshConnectionTimeoutSec]);

  React.useEffect(() => {
    sshReconnectOnFocusRef.current = sshReconnectOnFocus;
  }, [sshReconnectOnFocus]);

  React.useEffect(() => {
    terminalInlineImageSettingsRef.current = terminalInlineImageSettings;
  }, [terminalInlineImageSettings]);

  React.useEffect(() => {
    terminalWebLinksSettingsRef.current = terminalWebLinksSettings;
  }, [terminalWebLinksSettings]);

  React.useEffect(() => {
    openExternalLinkRef.current = openExternalLink;
  }, [openExternalLink]);

  const notifyHardwareAccelerationContextLoss = React.useCallback(() => {
    const accelerationState = hardwareAccelerationStateRef.current;
    if (accelerationState.hasShownContextLossWarning) {
      return;
    }

    accelerationState.hasShownContextLossWarning = true;
    runtimeRef.current.paneRuntimeMap.forEach((runtime) => {
      disposeTerminalWebglAddon(runtime);
    });
    notifyWarning(t('ssh.terminalHardwareAccelerationDisabled'));
  }, [notifyWarning]);

  React.useEffect(() => {
    const accelerationState = hardwareAccelerationStateRef.current;
    const wasEnabled = accelerationState.isEnabledBySettings;

    accelerationState.isEnabledBySettings = terminalHardwareAccelerationEnabled;
    if (terminalHardwareAccelerationEnabled && !wasEnabled) {
      accelerationState.isRuntimeDisabled = false;
      accelerationState.hasShownContextLossWarning = false;
    }

    if (!terminalHardwareAccelerationEnabled) {
      runtimeRef.current.paneRuntimeMap.forEach((runtime) => {
        disposeTerminalWebglAddon(runtime);
      });
      return;
    }

    if (accelerationState.isRuntimeDisabled) {
      return;
    }

    runtimeRef.current.paneRuntimeMap.forEach((runtime) => {
      syncTerminalWebglAddon(runtime.terminal, runtime, accelerationState, notifyHardwareAccelerationContextLoss);
    });
  }, [notifyHardwareAccelerationContextLoss, terminalHardwareAccelerationEnabled]);

  const {
    autocompleteItems,
    autocompleteAnchor,
    autocompleteMenuRef,
    acceptAutocompleteAtIndex,
    applyAutocompleteInputData,
    notifyAutocompleteOutputEchoRef,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
  } = useSshAutocomplete({
    connectionState,
    terminalAutoCompleteEnabled,
    terminalAutoCompleteHistoryEnabled,
    terminalAutoCompleteBuiltInCommandsEnabled,
    terminalAutoCompletePathEnabled,
    terminalAutoCompletePasswordEnabled,
    terminalAutoCompleteAcceptKeys,
    terminalAutoCompleteMinChars,
    terminalAutoCompleteMaxItems,
    terminalAutoCompleteFuzzyMatch,
    terminalAutoCompletePromptRegex,
    wrapperRef,
    terminalContainerRef,
    terminalRef,
    activePaneIdRef,
    paneRuntimeMapRef,
    getPaneLineState,
    getPaneTrustedCwd,
  });

  /**
   * Applies one pane transport transition to the shared reducer.
   *
   * @param paneId Source pane id.
   * @param nextState Next transport state.
   * @param error Optional localized failure reason.
   * @returns Nothing.
   */
  const setPaneTransportState = React.useCallback(
    (paneId: string, nextState: SshConnectionState, error = ''): void => {
      dispatchPaneState({
        type: 'transport-state',
        paneId,
        connectionState: nextState,
        connectionError: error,
      });
    },
    [dispatchPaneState],
  );

  /**
   * Resets all declarative state for one new pane connection attempt.
   *
   * @param paneId Source pane id.
   * @returns Nothing.
   */
  const resetPaneState = React.useCallback(
    (paneId: string): void => {
      const paneRuntime = paneRuntimeMapRef.current.get(paneId);
      if (paneRuntime) {
        clearTerminalCommandMarkers(paneRuntime);
      }
      dispatchPaneState({ type: 'reset-pane', paneId });
    },
    [dispatchPaneState, paneRuntimeMapRef],
  );

  /**
   * Routes every valid Backend message through one pane-aware side-effect and state path.
   *
   * @param paneId Source pane id.
   * @param terminal Source pane xterm instance.
   * @param payload Validated Backend-to-Renderer terminal message.
   * @returns Nothing.
   */
  const handlePaneServerMessage = React.useCallback(
    (paneId: string, terminal: Terminal, payload: ServerInboundMessage): void => {
      if (payload.type === 'output') {
        terminal.write(payload.data);
        notifyAutocompleteOutputEchoRef.current(paneId);
        // Only the active pane may open the secret-prompt suggestion flow:
        // a background pane's password prompt must not cancel or close the
        // autocomplete session the user is interacting with.
        if (paneId === activePaneIdRef.current && SECRET_PROMPT_PATTERN.test(payload.data.trimEnd())) {
          scheduleAutocompleteRequestRef.current(paneId, 'secretPrompt');
        }
        return;
      }

      if (payload.type === 'completion-response') {
        handleCompletionResponse(payload, paneId);
        return;
      }

      const receivedAt = Date.now();
      const paneRuntime = paneRuntimeMapRef.current.get(paneId);
      if (
        payload.type === 'remote-enhancement-runtime-status' &&
        paneRuntime &&
        !supportsTrustedCommandTimeline(payload)
      ) {
        clearTerminalCommandMarkers(paneRuntime);
      }

      if (payload.type === 'remote-shell-event') {
        const timelineIsTrusted = supportsTrustedCommandTimeline(
          paneStateMapRef.current[paneId]?.remoteEnhancementRuntimeStatus,
        );
        if (paneRuntime && timelineIsTrusted) {
          // An empty write callback runs after previously queued output parsing,
          // so lifecycle markers observe the cursor row that produced the event.
          terminal.write('', () => {
            if (
              paneRuntimeMapRef.current.get(paneId) !== paneRuntime ||
              !supportsTrustedCommandTimeline(paneStateMapRef.current[paneId]?.remoteEnhancementRuntimeStatus)
            ) {
              return;
            }

            applyRemoteCommandMarkerEvent(paneRuntime, payload, receivedAt, compiledPromptPrefixRegexRef.current);
          });
        }
      }

      dispatchPaneState({
        type: 'server-message',
        paneId,
        payload,
        receivedAt,
      });
    },
    [
      dispatchPaneState,
      activePaneIdRef,
      handleCompletionResponse,
      notifyAutocompleteOutputEchoRef,
      paneRuntimeMapRef,
      scheduleAutocompleteRequestRef,
    ],
  );

  /**
   * Records a hidden local Enter marker only while trusted command-start events
   * can confirm whether it represents a real submitted command.
   *
   * @param paneId Source pane id.
   * @param inputData Raw xterm input chunk.
   * @returns Nothing.
   */
  const recordPaneInputCommandMarker = React.useCallback(
    (paneId: string, inputData: string): void => {
      if (!/\r|\n/u.test(inputData)) {
        return;
      }

      const paneState = paneStateMapRef.current[paneId];
      if (!supportsTrustedCommandTimeline(paneState?.remoteEnhancementRuntimeStatus)) {
        return;
      }

      const paneRuntime = paneRuntimeMapRef.current.get(paneId);
      if (paneRuntime) {
        recordPendingCommandMarker(paneRuntime, Date.now());
      }
    },
    [paneRuntimeMapRef],
  );

  const {
    selectionAnchor,
    selectionBarPosition,
    dismissedSelectionText,
    refreshSelectionAnchor,
    dismissSelectionBar,
    clearSelectionOverlay,
  } = useSshSelectionBar({
    terminalRef,
    terminalContainerRef,
    wrapperRef,
    selectionBarRef,
    selectionPointerClientXRef,
    enabled: terminalSelectionBarEnabled,
  });

  const refreshSelectionAnchorRef = React.useRef(refreshSelectionAnchor);
  const clearSelectionOverlayRef = React.useRef(clearSelectionOverlay);

  React.useEffect(() => {
    refreshSelectionAnchorRef.current = refreshSelectionAnchor;
    clearSelectionOverlayRef.current = clearSelectionOverlay;
  }, [clearSelectionOverlay, refreshSelectionAnchor]);

  /**
   * Switches active pane routing for terminal, socket and geometry tracking.
   *
   * @param paneId Logical pane identifier to activate.
   * @returns Nothing.
   */
  const activatePane = React.useCallback(
    (paneId: string) => {
      const didPaneChange = activePaneIdRef.current !== paneId;
      const runtime = runtimeRef.current;
      runtime.activePaneId = paneId;
      setActivePaneId(paneId);

      const paneRuntime = runtime.paneRuntimeMap.get(paneId);
      const paneSession = runtime.ensureSession(paneId);
      paneSession.isPrimary = paneId === runtime.primaryPaneId;
      paneSession.terminal = paneRuntime ? paneRuntime.terminal : paneSession.terminal;
      paneSession.socket = paneRuntime ? paneRuntime.socket : paneSession.socket;
      paneSession.container = runtime.paneContainerMap.get(paneId) ?? paneSession.container;
      runtime.applyActivePane(paneId, terminalContainerRef);

      if (didPaneChange) {
        closeAutocompleteRef.current();
      }

      refreshSelectionAnchorRef.current();
    },
    [activePaneIdRef, closeAutocompleteRef],
  );

  React.useEffect(() => {
    if (!terminalPaneIds.includes(activePaneIdRef.current)) {
      activatePane(terminalPaneIds[0] ?? primaryPaneIdRef.current);
    }
  }, [activatePane, activePaneIdRef, primaryPaneIdRef, terminalPaneIds]);

  /**
   * Registers or unregisters pane container elements used by split runtimes.
   *
   * @param paneId Logical pane id.
   * @param element Pane container element, or `null` on unmount.
   * @returns Nothing.
   */
  const setPaneContainerElement = React.useCallback((paneId: string, element: HTMLDivElement | null) => {
    const runtime = runtimeRef.current;
    const existingElement = runtime.paneContainerMap.get(paneId) ?? null;

    if (element) {
      if (existingElement === element) {
        return;
      }

      runtime.paneContainerMap.set(paneId, element);
      runtime.ensureSession(paneId).container = element;
      if (runtime.activePaneId === paneId) {
        terminalContainerRef.current = element;
        runtime.activeContainer = element;
      }
      return;
    }

    if (!existingElement) {
      return;
    }

    runtime.paneContainerMap.delete(paneId);
    runtime.ensureSession(paneId).container = null;
    if (runtime.activePaneId === paneId && terminalContainerRef.current === existingElement) {
      terminalContainerRef.current = null;
      runtime.activeContainer = null;
    }
  }, []);

  /**
   * Registers primary pane container for initial xterm mount.
   *
   * @param element Primary pane container or `null` on unmount.
   * @returns Nothing.
   */
  const setPrimaryPaneContainer = React.useCallback((element: HTMLDivElement | null) => {
    const runtime = runtimeRef.current;
    if (runtime.paneRuntimeMap.get(runtime.primaryPaneId)?.owner !== 'primary') {
      return;
    }

    runtime.ensureSession(runtime.primaryPaneId).container = element;

    if (runtime.activePaneId === runtime.primaryPaneId) {
      terminalContainerRef.current = element;
      runtime.activeContainer = element;
    }
  }, []);

  /**
   * Adds one mirrored pane until hard pane limit is reached.
   *
   * @returns Nothing.
   */
  const splitPane = React.useCallback(() => {
    setTerminalPaneIds((previous) => {
      if (previous.length >= MAX_TERMINAL_PANES) {
        return previous;
      }

      runtimeRef.current.paneIdSequence += 1;
      return [...previous, `pane-${runtimeRef.current.paneIdSequence}`];
    });
  }, []);

  /**
   * Removes one mirrored pane and preserves stable active pane routing.
   *
   * @param paneId Pane id to remove.
   * @returns Nothing.
   */
  const closePane = React.useCallback(
    (paneId: string) => {
      const transition = resolveTerminalPaneCloseTransition(terminalPaneIds, activePaneIdRef.current, paneId);
      if (!transition) {
        return;
      }

      if (activePaneIdRef.current === paneId) {
        activatePane(transition.activePaneId);
      }

      const paneRuntime = runtimeRef.current.paneRuntimeMap.get(paneId);
      paneRuntime?.dispose();
      runtimeRef.current.paneRuntimeMap.delete(paneId);
      runtimeRef.current.sessionMap.delete(paneId);
      dispatchPaneState({ type: 'remove-pane', paneId });
      dispatchTerminalPresentationState({ type: 'remove-pane', paneId });
      closeAutocompleteRef.current();
      setTerminalPaneIds(transition.paneIds);
    },
    [
      activatePane,
      activePaneIdRef,
      closeAutocompleteRef,
      dispatchPaneState,
      dispatchTerminalPresentationState,
      terminalPaneIds,
    ],
  );

  /**
   * Resolves pending fingerprint trust prompt and unblocks connect flow.
   *
   * @param accepted User trust decision.
   * @returns Nothing.
   */
  const resolveHostFingerprintPrompt = React.useCallback((accepted: boolean) => {
    const resolver = fingerprintPromptResolverRef.current;
    fingerprintPromptResolverRef.current = null;
    setHostFingerprintPrompt(null);
    resolver?.(accepted);
  }, []);

  /**
   * Opens host trust dialog and waits for user confirmation.
   *
   * @param prompt Prompt payload shown in trust dialog.
   * @returns Promise resolving to trust decision.
   */
  const requestHostFingerprintTrustInternal = React.useCallback((prompt: HostFingerprintPrompt): Promise<boolean> => {
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

  useSshPrimarySession({
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
    setPaneTransportState,
    setSessionTargetReady,
    handlePaneServerMessage,
    recordPaneInputCommandMarker,
    refreshCommandTimeline,
    requestHostFingerprintTrust: requestHostFingerprintTrust ?? requestHostFingerprintTrustInternal,
    setActivePane: activatePane,
    refreshSelectionAnchor,
    onTerminalSelectionChange,
    clearSelectionOverlay,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    handleAutocompleteTerminalKeyDownRef,
    notifyHardwareAccelerationContextLoss,
  });

  useSshMirrorPanes({
    isActive,
    sessionTargetReady,
    terminalPaneIds,
    terminalLayoutRevision: commandTimelineRailReservationKey,
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
    setActivePane: activatePane,
    refreshSelectionAnchor,
    onTerminalSelectionChange,
    handleAutocompleteTerminalKeyDownRef,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    resetPaneState,
    resetTerminalPresentationState,
    dispatchTerminalPresentationState,
    setPaneTransportState,
    handlePaneServerMessage,
    recordPaneInputCommandMarker,
    refreshCommandTimeline,
    requestHostFingerprintTrust: requestHostFingerprintTrust ?? requestHostFingerprintTrustInternal,
    notifyWarning,
    notifyHardwareAccelerationContextLoss,
  });

  React.useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!isActive || wasActive) {
      return;
    }

    const isFirstActivation = !hasEverBeenActiveRef.current;
    hasEverBeenActiveRef.current = true;
    paneRuntimeMapRef.current.forEach((paneRuntime, paneId) => {
      const connectionState = paneStateMapRef.current[paneId]?.connectionState ?? 'connecting';
      if (
        shouldReconnectTerminalPaneOnActivation({
          owner: paneRuntime.owner,
          connectionState,
          socketReadyState: paneRuntime.socket?.readyState ?? null,
          isFirstActivation,
          reconnectOnFocus: sshReconnectOnFocusRef.current,
        })
      ) {
        paneRuntime.reconnect();
      }
    });
  }, [isActive, paneRuntimeMapRef, sshReconnectOnFocusRef]);

  React.useEffect(() => {
    const runtime = runtimeRef.current;
    const primarySession = runtime.ensureSession(runtime.primaryPaneId);
    primarySession.isPrimary = true;
    primarySession.terminal = runtime.primaryTerminal;
    primarySession.socket = runtime.primarySocket;
    primarySession.container = runtime.paneContainerMap.get(runtime.primaryPaneId) ?? primarySession.container;

    runtime.paneRuntimeMap.forEach((paneRuntime, paneId) => {
      const session = runtime.ensureSession(paneId);
      session.isPrimary = paneId === runtime.primaryPaneId;
      session.terminal = paneRuntime.terminal;
      session.socket = paneRuntime.socket;
      session.container = runtime.paneContainerMap.get(paneId) ?? paneRuntime.containerElement ?? session.container;
    });

    runtime.sessionMap.forEach((_, paneId) => {
      if (!terminalPaneIds.includes(paneId)) {
        runtime.sessionMap.delete(paneId);
      }
    });

    runtime.applyActivePane(activePaneId, terminalContainerRef);
  }, [connectionState, terminalPaneIds, activePaneId]);

  /**
   * Retries one pane's failed terminal connection using that pane's connector.
   *
   * @param paneId Logical pane identifier to reconnect.
   * @returns Nothing.
   */
  const retryPaneConnection = React.useCallback(
    (paneId: string): void => {
      const paneConnectionState = paneStateMapRef.current[paneId]?.connectionState;
      if (paneConnectionState === 'connecting' || paneConnectionState === 'connected') {
        return;
      }

      paneRuntimeMapRef.current.get(paneId)?.reconnect();
    },
    [paneRuntimeMapRef, paneStateMapRef],
  );

  /**
   * Sends input bytes to active pane websocket.
   *
   * @param data Raw input payload.
   * @returns `true` when input is sent to an open socket, otherwise `false`.
   */
  const sendInput = React.useCallback(
    (data: string): boolean => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      sendClientMessage(socket, {
        type: 'input',
        data,
      });
      recordPaneInputCommandMarker(activePaneIdRef.current, data);

      return true;
    },
    [activePaneIdRef, recordPaneInputCommandMarker, socketRef],
  );

  /**
   * Routes pasted payload through xterm paste semantics when enabled.
   *
   * @param text Clipboard or dropped text payload.
   * @returns `true` when payload is delivered, otherwise `false`.
   */
  const pasteInput = React.useCallback(
    (text: string): boolean => {
      if (!text) {
        return false;
      }

      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (terminalBracketedPasteEnabled) {
        const terminal = terminalRef.current;
        if (terminal) {
          terminal.paste(text);
          return true;
        }
      }

      return sendInput(text);
    },
    [sendInput, socketRef, terminalBracketedPasteEnabled, terminalRef],
  );

  /**
   * Requests deletion of one command from active pane history source.
   *
   * @param command Command text selected in sidebar history list.
   * @returns Nothing.
   */
  const deleteHistoryCommand = React.useCallback(
    (command: string) => {
      const normalizedCommand = command.trim();
      if (!normalizedCommand) {
        return;
      }

      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      sendClientMessage(socket, {
        type: 'history-delete',
        command: normalizedCommand,
      });
    },
    [socketRef],
  );

  /**
   * Selects all content in active terminal instance.
   *
   * @returns Nothing.
   */
  const selectAll = React.useCallback(() => {
    terminalRef.current?.selectAll();
  }, [terminalRef]);

  /**
   * Reads active terminal selected text.
   *
   * @returns Current selected text or empty string.
   */
  const getSelectionText = React.useCallback((): string => {
    return terminalRef.current?.getSelection() ?? '';
  }, [terminalRef]);

  /**
   * Serializes active terminal selected text as clipboard-ready HTML.
   *
   * @returns HTML fragment from xterm's SerializeAddon, or empty string when unavailable.
   */
  const getSelectionHtml = React.useCallback((): string => {
    const terminal = terminalRef.current;
    if (!terminal?.hasSelection()) {
      return '';
    }

    const serializeAddon = paneRuntimeMapRef.current.get(activePaneIdRef.current)?.serializeAddon ?? null;
    if (!serializeAddon) {
      return '';
    }

    try {
      return serializeAddon.serializeAsHTML({
        includeGlobalBackground: true,
        onlySelection: true,
      });
    } catch (error: unknown) {
      console.warn('Failed to serialize terminal selection as HTML.', error);
      return '';
    }
  }, [activePaneIdRef, paneRuntimeMapRef, terminalRef]);

  /**
   * Focuses active terminal instance.
   *
   * @returns Nothing.
   */
  const focusActiveTerminal = React.useCallback(() => {
    terminalRef.current?.focus();
  }, [terminalRef]);

  /**
   * Sends Ctrl+L clear-screen sequence to active session.
   *
   * @returns Nothing.
   */
  const clearTerminalScreen = React.useCallback(() => {
    sendInput('\x0c');
  }, [sendInput]);

  /**
   * Reveals one directly selected command input marker in an explicitly addressed pane.
   *
   * @param paneId Source pane id.
   * @param commandId Retained command marker id.
   * @returns Nothing.
   */
  const scrollToPaneCommand = React.useCallback(
    (paneId: string, commandId: string): void => {
      const paneRuntime = paneRuntimeMapRef.current.get(paneId);
      if (!paneRuntime) {
        return;
      }

      activatePane(paneId);
      if (scrollToTerminalCommandMarker(paneRuntime, commandId)) {
        paneRuntime.terminal.focus();
      }
    },
    [activatePane, paneRuntimeMapRef],
  );

  /**
   * Resolves active-pane search resources from primary or mirror runtime state.
   *
   * @returns Active terminal/search-addon pair. Returns `null` when primary pane resources
   * are not mounted yet, or when the active mirror pane runtime is not created/ready.
   */
  const resolveActiveSearchResources = React.useCallback((): ActiveSearchResources | null => {
    const runtime = paneRuntimeMapRef.current.get(activePaneIdRef.current);
    if (!runtime) {
      return null;
    }

    return {
      addon: runtime.searchAddon,
      terminal: runtime.terminal,
    };
  }, [activePaneIdRef, paneRuntimeMapRef]);

  /**
   * Clears active-pane search decorations when search UI exits or query is empty.
   *
   * @returns void.
   */
  const clearActiveTerminalSearch = React.useCallback((): void => {
    const resources = resolveActiveSearchResources();
    if (!resources) {
      return;
    }

    resources.addon.clearDecorations();
  }, [resolveActiveSearchResources]);

  /**
   * Finds and highlights text in active terminal by direction semantics.
   *
   * @param query Search text.
   * @param direction Navigation direction or boundary jump.
   * @param options Search behavior flags from command-palette toggles.
   * @returns `true` when a match is found. Returns `false` when search resources are unavailable
   * or when no match exists for the current query/direction.
   */
  const findActiveTerminalText = React.useCallback(
    (query: string, direction: TerminalSearchDirection, options: TerminalSearchOptions): boolean => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return false;
      }

      const resources = resolveActiveSearchResources();
      if (!resources) {
        return false;
      }

      const { addon, terminal } = resources;

      if (direction === 'first' || direction === 'last') {
        terminal.clearSelection();
      }

      if (direction === 'first') {
        terminal.scrollToTop();
      }

      if (direction === 'last') {
        terminal.scrollToBottom();
      }

      const searchOptions: ISearchOptions = {
        caseSensitive: options.caseSensitive,
        regex: options.regex,
      };

      try {
        // "last" reuses backward scan from bottom so the nearest trailing match is highlighted first.
        return direction === 'previous' || direction === 'last'
          ? addon.findPrevious(normalizedQuery, searchOptions)
          : addon.findNext(normalizedQuery, searchOptions);
      } catch (error: unknown) {
        console.warn('Failed to execute terminal search.', error);
        return false;
      }
    },
    [resolveActiveSearchResources],
  );

  return {
    state: {
      terminalPaneIds,
      activePaneId,
      connectionState,
      connectionError,
      paneConnectionStates,
      telemetryState,
      remoteBootstrapStatus,
      remoteEnhancementRuntimeStatus,
      remoteEnhancementsDebugEvents,
      trustedCwd: activePaneState.trustedCwd,
      commandTimelineModels,
      terminalPresentationStates,
      hostFingerprintPrompt,
      canSplitTerminal: terminalPaneIds.length < MAX_TERMINAL_PANES,
      selectionAnchor,
      selectionBarPosition,
      dismissedSelectionText,
      autocompleteItems,
      autocompleteAnchor,
    },
    actions: {
      activatePane,
      splitPane,
      closePane,
      retryPaneConnection,
      sendInput,
      pasteInput,
      deleteHistoryCommand,
      selectAll,
      getSelectionText,
      getSelectionHtml,
      focusActiveTerminal,
      clearTerminalScreen,
      scrollToPaneCommand,
      findActiveTerminalText,
      clearActiveTerminalSearch,
      setPaneContainerElement,
      setPrimaryPaneContainer,
      resolveHostFingerprintPrompt,
      dismissSelectionBar,
      acceptAutocompleteAtIndex,
    },
    refs: {
      wrapperRef,
      terminalContainerRef,
      selectionBarRef,
      autocompleteMenuRef,
    },
  };
};
