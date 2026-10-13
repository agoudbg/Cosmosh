import { type Terminal } from '@xterm/xterm';
import React from 'react';

import type {
  TerminalAutocompleteItem,
  TerminalAutocompleteMenuHandle,
} from '../../components/terminal/terminal-autocomplete-menu';
import type { SshPaneLineState } from './ssh-pane-state';
import type { ServerInboundMessage, TerminalAutocompleteAnchor, TerminalPaneRuntime } from './ssh-types';
import {
  AUTOCOMPLETE_PANEL_EDGE_PADDING,
  AUTOCOMPLETE_PANEL_ESTIMATED_WIDTH,
  AUTOCOMPLETE_TYPING_DEBOUNCE_MS,
} from './ssh-types';
import {
  calibrateAutocompleteCommandPrefix,
  compilePromptPrefixRegex,
  resolveAutocompleteCommandPrefix,
  resolvePromptWorkingDirectoryHint,
  resolveTerminalCurrentLinePrefix,
  sendClientMessage,
  shouldHandleTerminalAutocompleteKeyEvent,
} from './ssh-utils';

type UseSshAutocompleteParams = {
  connectionState: 'connecting' | 'connected' | 'failed';
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
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  activePaneIdRef: React.RefObject<string>;
  paneRuntimeMapRef: React.RefObject<Map<string, TerminalPaneRuntime>>;
  getPaneLineState: (paneId: string) => SshPaneLineState | null;
  getPaneTrustedCwd: (paneId: string) => string | null;
};

type UseSshAutocompleteResult = {
  autocompleteItems: TerminalAutocompleteItem[];
  autocompleteAnchor: TerminalAutocompleteAnchor | null;
  autocompleteMenuRef: React.RefObject<TerminalAutocompleteMenuHandle | null>;
  acceptAutocompleteAtIndex: (index: number) => void;
  applyAutocompleteInputData: (paneId: string, data: string) => { shouldRequest: boolean; shouldClose: boolean };
  resetAutocompletePaneState: (paneId: string) => void;
  notifyAutocompleteOutputEchoRef: React.RefObject<(paneId: string) => void>;
  closeAutocompleteRef: React.RefObject<() => void>;
  resolveAutocompleteAnchorRef: React.RefObject<
    (commandStartColumn: number, cursorRow: number) => TerminalAutocompleteAnchor | null
  >;
  scheduleAutocompleteRequestRef: React.RefObject<
    (paneId: string, trigger: 'typing' | 'manual' | 'secretPrompt') => void
  >;
  handleAutocompleteTerminalKeyDownRef: React.RefObject<(event: KeyboardEvent) => void>;
  latestAutocompletePaneIdRef: React.RefObject<string>;
  latestAutocompleteRequestIdRef: React.RefObject<string>;
  latestAutocompleteCommandStartColumnRef: React.RefObject<number>;
  latestAutocompleteCursorRowRef: React.RefObject<number>;
  autocompleteReplacePrefixLengthRef: React.RefObject<number>;
  handleCompletionResponse: (
    payload: Extract<ServerInboundMessage, { type: 'completion-response' }>,
    paneId: string,
  ) => void;
};

/**
 * Manages terminal autocomplete state, keyboard interaction and backend requests.
 *
 * @param params Hook dependencies and runtime refs used by the autocomplete subsystem.
 * @returns Autocomplete state, handlers and refs consumed by SSH session effects.
 */
export const useSshAutocomplete = (params: UseSshAutocompleteParams): UseSshAutocompleteResult => {
  const {
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
  } = params;

  const autocompleteRequestSequenceRef = React.useRef<number>(0);
  const autocompleteRequestTimeoutRef = React.useRef<number | null>(null);
  const latestAutocompleteRequestKeyRef = React.useRef<string>('');
  const latestAutocompleteLinePrefixRef = React.useRef<string>('');
  const latestAutocompleteWorkingDirectoryHintRef = React.useRef<string | null>(null);
  const latestAutocompleteRequestIdRef = React.useRef<string>('');
  const latestAutocompletePaneIdRef = React.useRef<string>('pane-1');
  const autocompleteReplacePrefixLengthRef = React.useRef<number>(0);
  const latestAutocompleteCommandStartColumnRef = React.useRef<number>(0);
  const latestAutocompleteCursorRowRef = React.useRef<number>(0);
  const autocompleteMenuRef = React.useRef<TerminalAutocompleteMenuHandle | null>(null);
  const localAutocompleteCommandPrefixByPaneRef = React.useRef<Map<string, string>>(new Map());
  const localAutocompletePrefixNeedsRenderedContextByPaneRef = React.useRef<Set<string>>(new Set());
  const pendingTypingRequestPaneSetRef = React.useRef<Set<string>>(new Set());
  const compiledPromptPrefixRegex = React.useMemo<RegExp | null>(() => {
    return compilePromptPrefixRegex(terminalAutoCompletePromptRegex);
  }, [terminalAutoCompletePromptRegex]);

  const [autocompleteItems, setAutocompleteItems] = React.useState<TerminalAutocompleteItem[]>([]);
  const [autocompleteAnchor, setAutocompleteAnchor] = React.useState<TerminalAutocompleteAnchor | null>(null);

  /**
   * Determines whether xterm is currently rendering the alternate screen buffer.
   * Full-screen TUIs/editors (vim/less/top) run in alternate buffer and should not show shell autocomplete.
   *
   * @param terminal Active xterm instance.
   * @returns `true` when terminal is in alternate buffer.
   */
  const isAlternateScreenBufferActive = React.useCallback((terminal: Terminal): boolean => {
    return terminal.buffer.active === terminal.buffer.alternate;
  }, []);

  /**
   * Clears pending typing debounce timer if one exists.
   *
   * @returns Nothing.
   */
  const clearScheduledAutocompleteRequest = React.useCallback(() => {
    if (autocompleteRequestTimeoutRef.current !== null) {
      window.clearTimeout(autocompleteRequestTimeoutRef.current);
      autocompleteRequestTimeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      clearScheduledAutocompleteRequest();
    };
  }, [clearScheduledAutocompleteRequest]);

  React.useEffect(() => {
    if (connectionState !== 'connected' || !terminalAutoCompleteEnabled) {
      setAutocompleteItems([]);
      autocompleteMenuRef.current?.reset();
      setAutocompleteAnchor(null);
      autocompleteReplacePrefixLengthRef.current = 0;
      latestAutocompleteRequestIdRef.current = '';
      latestAutocompleteRequestKeyRef.current = '';
      localAutocompleteCommandPrefixByPaneRef.current.clear();
      localAutocompletePrefixNeedsRenderedContextByPaneRef.current.clear();
      pendingTypingRequestPaneSetRef.current.clear();
    }
  }, [connectionState, terminalAutoCompleteEnabled]);

  /**
   * Resets autocomplete UI and request bookkeeping state.
   *
   * @returns Nothing.
   */
  const closeAutocomplete = React.useCallback(() => {
    clearScheduledAutocompleteRequest();
    pendingTypingRequestPaneSetRef.current.clear();
    setAutocompleteItems([]);
    autocompleteMenuRef.current?.reset();
    setAutocompleteAnchor(null);
    autocompleteReplacePrefixLengthRef.current = 0;
    latestAutocompleteRequestIdRef.current = '';
    latestAutocompleteRequestKeyRef.current = '';
  }, [clearScheduledAutocompleteRequest]);

  /**
   * Releases command-prefix and request state that belongs to one ending PTY session.
   *
   * @param paneId Pane whose backend session is being replaced.
   * @returns Nothing.
   */
  const resetAutocompletePaneState = React.useCallback(
    (paneId: string): void => {
      localAutocompleteCommandPrefixByPaneRef.current.delete(paneId);
      localAutocompletePrefixNeedsRenderedContextByPaneRef.current.delete(paneId);
      pendingTypingRequestPaneSetRef.current.delete(paneId);

      if (latestAutocompletePaneIdRef.current === paneId) {
        closeAutocomplete();
      }
    },
    [closeAutocomplete],
  );

  /**
   * Resolves popup placement for autocomplete panel from cursor and terminal geometry.
   *
   * @param commandStartColumn Command start column in current terminal row.
   * @param cursorRow Current cursor row.
   * @returns Popup anchor or `null` when layout information is unavailable.
   */
  const resolveAutocompleteAnchor = React.useCallback(
    (commandStartColumn: number, cursorRow: number): TerminalAutocompleteAnchor | null => {
      const wrapperElement = wrapperRef.current;
      const containerElement = terminalContainerRef.current;
      const terminal = terminalRef.current;

      if (!wrapperElement || !containerElement || !terminal) {
        return null;
      }

      const containerRect = containerElement.getBoundingClientRect();
      const wrapperRect = wrapperElement.getBoundingClientRect();

      const internalTerminal = terminal as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: {
                cell?: {
                  width?: number;
                  height?: number;
                };
              };
            };
          };
        };
      };

      const cellWidth = internalTerminal._core?._renderService?.dimensions?.css?.cell?.width ?? 9;
      const cellHeight = internalTerminal._core?._renderService?.dimensions?.css?.cell?.height ?? 18;
      const availablePanelWidth = Math.max(180, wrapperRect.width - AUTOCOMPLETE_PANEL_EDGE_PADDING * 2);
      const panelWidth = Math.min(AUTOCOMPLETE_PANEL_ESTIMATED_WIDTH, availablePanelWidth);
      const left = containerRect.left - wrapperRect.left + commandStartColumn * cellWidth;
      const maxLeft = Math.max(
        AUTOCOMPLETE_PANEL_EDGE_PADDING,
        wrapperRect.width - panelWidth - AUTOCOMPLETE_PANEL_EDGE_PADDING,
      );
      const cursorBaselineTop = containerRect.top - wrapperRect.top + cursorRow * cellHeight;
      const estimatedPanelHeight = 280;
      const renderAbove = cursorBaselineTop - estimatedPanelHeight - 8 >= 8;

      return {
        left: Math.max(AUTOCOMPLETE_PANEL_EDGE_PADDING, Math.min(left, maxLeft)),
        top: renderAbove ? cursorBaselineTop - 8 : cursorBaselineTop + cellHeight + 8,
        panelWidth,
        renderAbove,
      };
    },
    [terminalContainerRef, terminalRef, wrapperRef],
  );

  /**
   * Sends autocomplete request for current active pane command line.
   *
   * @param trigger Trigger source (`typing` or `manual`).
   * @returns Nothing.
   */
  const dispatchCompletionRequest = React.useCallback(
    (params: {
      socket: WebSocket;
      paneId: string;
      linePrefix: string;
      cursorRow: number;
      trigger: 'typing' | 'manual' | 'secretPrompt';
      workingDirectoryHint: string | null;
    }): void => {
      const requestKey = `${params.paneId}:${params.cursorRow}:${params.linePrefix}`;
      if (params.trigger === 'typing' && requestKey === latestAutocompleteRequestKeyRef.current) {
        return;
      }

      latestAutocompleteRequestKeyRef.current = requestKey;
      const requestId = `cmp-${Date.now()}-${(autocompleteRequestSequenceRef.current += 1)}`;
      latestAutocompleteRequestIdRef.current = requestId;
      latestAutocompletePaneIdRef.current = params.paneId;
      latestAutocompleteLinePrefixRef.current = params.linePrefix;
      latestAutocompleteWorkingDirectoryHintRef.current = params.workingDirectoryHint;

      sendClientMessage(params.socket, {
        type: 'completion-request',
        requestId,
        linePrefix: params.linePrefix,
        cursorIndex: params.linePrefix.length,
        workingDirectoryHint: params.workingDirectoryHint ?? undefined,
        limit: terminalAutoCompleteMaxItems,
        fuzzyMatch: terminalAutoCompleteFuzzyMatch,
        includeHistory: terminalAutoCompleteHistoryEnabled,
        includeBuiltInCommands: terminalAutoCompleteBuiltInCommandsEnabled,
        includePathSuggestions: terminalAutoCompletePathEnabled,
        includePasswordSuggestions: terminalAutoCompletePasswordEnabled,
        trigger: params.trigger === 'typing' ? 'typing' : 'manual',
      });
    },
    [
      terminalAutoCompleteBuiltInCommandsEnabled,
      terminalAutoCompleteFuzzyMatch,
      terminalAutoCompleteHistoryEnabled,
      terminalAutoCompleteMaxItems,
      terminalAutoCompletePasswordEnabled,
      terminalAutoCompletePathEnabled,
    ],
  );

  const requestAutocomplete = React.useCallback(
    (paneId: string, trigger: 'typing' | 'manual' | 'secretPrompt') => {
      const paneRuntime = paneRuntimeMapRef.current.get(paneId);
      const socket = paneRuntime?.socket ?? null;
      const terminal = paneRuntime?.terminal ?? null;

      if (
        paneId !== activePaneIdRef.current ||
        !terminalAutoCompleteEnabled ||
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        !terminal ||
        connectionState !== 'connected'
      ) {
        closeAutocomplete();
        return;
      }

      if (isAlternateScreenBufferActive(terminal)) {
        closeAutocomplete();
        return;
      }

      const lineContext = resolveTerminalCurrentLinePrefix(terminal, {
        promptPrefixRegex: compiledPromptPrefixRegex,
      });
      if (!lineContext) {
        closeAutocomplete();
        return;
      }

      const shadowCommandPrefix = localAutocompleteCommandPrefixByPaneRef.current.get(paneId);
      const uncalibratedCommandPrefix = resolveAutocompleteCommandPrefix(
        lineContext.commandPrefix,
        shadowCommandPrefix,
        {
          localPrefixNeedsRenderedContext: localAutocompletePrefixNeedsRenderedContextByPaneRef.current.has(paneId),
        },
      );
      const lineState = getPaneLineState(paneId);
      const commandPrefix = calibrateAutocompleteCommandPrefix(uncalibratedCommandPrefix, lineState);
      const trimmedCommandPrefix = commandPrefix.trim();
      if (trimmedCommandPrefix.length === 0 && trigger !== 'secretPrompt') {
        closeAutocomplete();
        return;
      }

      if (trimmedCommandPrefix.length > 0 && trimmedCommandPrefix.length < terminalAutoCompleteMinChars) {
        closeAutocomplete();
        return;
      }

      latestAutocompleteCommandStartColumnRef.current = lineContext.commandStartColumn;
      latestAutocompleteCursorRowRef.current = lineContext.cursorRow;

      const workingDirectoryHint =
        getPaneTrustedCwd(paneId) ??
        resolvePromptWorkingDirectoryHint(lineContext.fullLinePrefix, lineContext.commandPrefixStartOffset) ??
        null;
      dispatchCompletionRequest({
        socket,
        paneId,
        linePrefix: commandPrefix,
        cursorRow: lineContext.cursorRow,
        trigger,
        workingDirectoryHint,
      });
    },
    [
      activePaneIdRef,
      closeAutocomplete,
      connectionState,
      dispatchCompletionRequest,
      getPaneLineState,
      getPaneTrustedCwd,
      localAutocompleteCommandPrefixByPaneRef,
      paneRuntimeMapRef,
      isAlternateScreenBufferActive,
      compiledPromptPrefixRegex,
      terminalAutoCompleteEnabled,
      terminalAutoCompleteMinChars,
    ],
  );

  /**
   * Debounces typing trigger and allows immediate manual trigger.
   *
   * @param trigger Trigger source (`typing` or `manual`).
   * @returns Nothing.
   */
  const scheduleAutocompleteRequest = React.useCallback(
    (paneId: string, trigger: 'typing' | 'manual' | 'secretPrompt') => {
      if (trigger === 'manual') {
        clearScheduledAutocompleteRequest();
        requestAutocomplete(paneId, trigger);
        return;
      }

      if (trigger === 'secretPrompt') {
        clearScheduledAutocompleteRequest();
        requestAutocomplete(paneId, trigger);
        return;
      }

      clearScheduledAutocompleteRequest();
      autocompleteRequestTimeoutRef.current = window.setTimeout(() => {
        autocompleteRequestTimeoutRef.current = null;
        requestAutocomplete(paneId, 'typing');
      }, AUTOCOMPLETE_TYPING_DEBOUNCE_MS);
    },
    [clearScheduledAutocompleteRequest, requestAutocomplete],
  );

  /**
   * Accepts selected completion candidate and applies insertion to active socket.
   *
   * @param index Candidate index from autocomplete list.
   * @returns Nothing.
   */
  const acceptAutocompleteAtIndex = React.useCallback(
    (index: number) => {
      const paneId = latestAutocompletePaneIdRef.current;
      const paneRuntime = paneRuntimeMapRef.current.get(paneId);
      const socket = paneRuntime?.socket ?? null;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        closeAutocomplete();
        return;
      }

      const targetItem = autocompleteItems[index];
      if (!targetItem) {
        return;
      }

      const terminal = paneRuntime?.terminal ?? null;
      const deleteCount = Math.max(0, targetItem.replacePrefixLength ?? autocompleteReplacePrefixLengthRef.current);
      const deletePrefix = '\x7f'.repeat(Math.max(0, deleteCount));
      sendClientMessage(socket, {
        type: 'input',
        data: `${deletePrefix}${targetItem.insertText}`,
      });
      terminal?.focus();
      closeAutocomplete();

      const previousLinePrefix = latestAutocompleteLinePrefixRef.current;
      const nextLinePrefix = `${previousLinePrefix.slice(0, Math.max(0, previousLinePrefix.length - deleteCount))}${targetItem.insertText}`;
      localAutocompleteCommandPrefixByPaneRef.current.set(paneId, nextLinePrefix);
      localAutocompletePrefixNeedsRenderedContextByPaneRef.current.delete(paneId);

      const shouldTriggerPathChain = targetItem.kind === 'path' && targetItem.insertText.endsWith('/');
      if (shouldTriggerPathChain) {
        dispatchCompletionRequest({
          socket,
          paneId,
          linePrefix: nextLinePrefix,
          cursorRow: latestAutocompleteCursorRowRef.current,
          trigger: 'manual',
          workingDirectoryHint: latestAutocompleteWorkingDirectoryHintRef.current,
        });
      }
    },
    [
      autocompleteItems,
      closeAutocomplete,
      dispatchCompletionRequest,
      localAutocompleteCommandPrefixByPaneRef,
      paneRuntimeMapRef,
    ],
  );

  /**
   * Reduces raw terminal input into autocomplete control decisions.
   *
   * @param data Raw xterm data chunk.
   * @returns Flags indicating whether to request or close autocomplete.
   */
  const applyAutocompleteInputData = React.useCallback(
    (paneId: string, data: string): { shouldRequest: boolean; shouldClose: boolean } => {
      let shouldRequest = false;
      let shouldClose = false;
      let canTrackCommandPrefix = true;
      let nextLocalCommandPrefix = localAutocompleteCommandPrefixByPaneRef.current.get(paneId) ?? '';

      for (let index = 0; index < data.length; index += 1) {
        const char = data[index] ?? '';

        if (char === '\x1b') {
          // Escape sequences are frequently cursor movement/edit commands; stop shadow tracking.
          canTrackCommandPrefix = false;
          localAutocompleteCommandPrefixByPaneRef.current.delete(paneId);
          localAutocompletePrefixNeedsRenderedContextByPaneRef.current.add(paneId);
          pendingTypingRequestPaneSetRef.current.delete(paneId);
          return {
            shouldRequest: false,
            shouldClose: true,
          };
        }

        if (char === '\r' || char === '\n' || char === '\u0003') {
          shouldRequest = false;
          shouldClose = true;
          nextLocalCommandPrefix = '';
          localAutocompletePrefixNeedsRenderedContextByPaneRef.current.delete(paneId);
          continue;
        }

        if (char === '\x7f' || char === '\b') {
          shouldRequest = true;
          nextLocalCommandPrefix = nextLocalCommandPrefix.slice(0, Math.max(0, nextLocalCommandPrefix.length - 1));
          continue;
        }

        if (char === '\t' || char === '\u0000') {
          continue;
        }

        if (char >= ' ') {
          shouldRequest = true;
          nextLocalCommandPrefix += char;
          continue;
        }

        canTrackCommandPrefix = false;
        shouldClose = true;
      }

      if (canTrackCommandPrefix) {
        localAutocompleteCommandPrefixByPaneRef.current.set(paneId, nextLocalCommandPrefix);
      } else {
        localAutocompleteCommandPrefixByPaneRef.current.delete(paneId);
        localAutocompletePrefixNeedsRenderedContextByPaneRef.current.add(paneId);
      }

      const shouldQueueTypingRequest = shouldRequest && !shouldClose;
      if (shouldQueueTypingRequest) {
        pendingTypingRequestPaneSetRef.current.add(paneId);
      }

      if (shouldClose) {
        pendingTypingRequestPaneSetRef.current.delete(paneId);
      }

      return {
        shouldRequest: shouldQueueTypingRequest,
        shouldClose,
      };
    },
    [],
  );

  /**
   * Triggers one pending typing autocomplete request after terminal output echo arrives.
   *
   * @param paneId Pane id whose terminal received output.
   * @returns Nothing.
   */
  const notifyAutocompleteOutputEcho = React.useCallback(
    (paneId: string): void => {
      if (!pendingTypingRequestPaneSetRef.current.has(paneId)) {
        return;
      }

      if (paneId !== activePaneIdRef.current) {
        return;
      }

      pendingTypingRequestPaneSetRef.current.delete(paneId);
      scheduleAutocompleteRequest(paneId, 'typing');
    },
    [activePaneIdRef, scheduleAutocompleteRequest],
  );

  /**
   * Handles keyboard shortcuts for autocomplete list navigation and acceptance.
   *
   * @param event Native keyboard event from terminal container.
   * @returns Nothing.
   */
  const handleAutocompleteTerminalKeyDown = React.useCallback(
    (event: KeyboardEvent) => {
      const acceptsByTab = terminalAutoCompleteAcceptKeys === 'tab' || terminalAutoCompleteAcceptKeys === 'tabEnter';
      const acceptsByEnter =
        terminalAutoCompleteAcceptKeys === 'enter' || terminalAutoCompleteAcceptKeys === 'tabEnter';

      if (!shouldHandleTerminalAutocompleteKeyEvent(event, terminalAutoCompleteEnabled)) {
        return;
      }

      const activeTerminal = terminalRef.current;
      if (activeTerminal && isAlternateScreenBufferActive(activeTerminal)) {
        // Keep TUI/editor key handling untouched when shell prompt is not active.
        return;
      }

      if (event.key === 'Tab' && acceptsByTab) {
        event.preventDefault();
        event.stopPropagation();
        if (autocompleteItems.length > 0) {
          acceptAutocompleteAtIndex(autocompleteMenuRef.current?.getActiveIndex() ?? 0);
        } else {
          scheduleAutocompleteRequest(activePaneIdRef.current, 'manual');
        }
        return;
      }

      if (event.key === 'Enter' && acceptsByEnter && autocompleteItems.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        acceptAutocompleteAtIndex(autocompleteMenuRef.current?.getActiveIndex() ?? 0);
        return;
      }

      if (autocompleteItems.length === 0) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        autocompleteMenuRef.current?.moveNext();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        autocompleteMenuRef.current?.movePrevious();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAutocomplete();
      }
    },
    [
      acceptAutocompleteAtIndex,
      activePaneIdRef,
      autocompleteItems,
      closeAutocomplete,
      isAlternateScreenBufferActive,
      scheduleAutocompleteRequest,
      terminalAutoCompleteAcceptKeys,
      terminalAutoCompleteEnabled,
      terminalRef,
    ],
  );

  const closeAutocompleteRef = React.useRef(closeAutocomplete);
  const resolveAutocompleteAnchorRef = React.useRef(resolveAutocompleteAnchor);
  const scheduleAutocompleteRequestRef = React.useRef(scheduleAutocompleteRequest);
  const handleAutocompleteTerminalKeyDownRef = React.useRef(handleAutocompleteTerminalKeyDown);
  const notifyAutocompleteOutputEchoRef = React.useRef(notifyAutocompleteOutputEcho);

  React.useEffect(() => {
    closeAutocompleteRef.current = closeAutocomplete;
    resolveAutocompleteAnchorRef.current = resolveAutocompleteAnchor;
    scheduleAutocompleteRequestRef.current = scheduleAutocompleteRequest;
    handleAutocompleteTerminalKeyDownRef.current = handleAutocompleteTerminalKeyDown;
    notifyAutocompleteOutputEchoRef.current = notifyAutocompleteOutputEcho;
  }, [
    closeAutocomplete,
    resolveAutocompleteAnchor,
    scheduleAutocompleteRequest,
    handleAutocompleteTerminalKeyDown,
    notifyAutocompleteOutputEcho,
  ]);

  /**
   * Applies completion response payload to autocomplete UI state.
   *
   * @param payload Completion response payload from backend.
   * @param paneId Pane id that the payload belongs to.
   * @returns Nothing.
   */
  const handleCompletionResponse = React.useCallback(
    (payload: Extract<ServerInboundMessage, { type: 'completion-response' }>, paneId: string) => {
      if (latestAutocompletePaneIdRef.current !== paneId) {
        return;
      }

      if (activePaneIdRef.current !== paneId) {
        return;
      }

      if (payload.requestId !== latestAutocompleteRequestIdRef.current) {
        return;
      }

      if (payload.items.length === 0) {
        closeAutocomplete();
        return;
      }

      const anchor = resolveAutocompleteAnchor(
        latestAutocompleteCommandStartColumnRef.current,
        latestAutocompleteCursorRowRef.current,
      );
      if (!anchor) {
        closeAutocomplete();
        return;
      }

      setAutocompleteItems(payload.items);
      autocompleteMenuRef.current?.reset();
      setAutocompleteAnchor(anchor);
      autocompleteReplacePrefixLengthRef.current = payload.replacePrefixLength;
    },
    [activePaneIdRef, closeAutocomplete, resolveAutocompleteAnchor],
  );

  return {
    autocompleteItems,
    autocompleteAnchor,
    autocompleteMenuRef,
    acceptAutocompleteAtIndex,
    applyAutocompleteInputData,
    resetAutocompletePaneState,
    notifyAutocompleteOutputEchoRef,
    closeAutocompleteRef,
    resolveAutocompleteAnchorRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    latestAutocompletePaneIdRef,
    latestAutocompleteRequestIdRef,
    latestAutocompleteCommandStartColumnRef,
    latestAutocompleteCursorRowRef,
    autocompleteReplacePrefixLengthRef,
    handleCompletionResponse,
  };
};
