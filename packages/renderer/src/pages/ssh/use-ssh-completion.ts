import type {
  SettingsValues,
  ShellContext,
  TerminalCompletionAcceptResult,
  TerminalCompletionSources,
  TerminalCompletionUpdate,
} from '@cosmosh/api-contract';
import type { Terminal } from '@xterm/xterm';
import React from 'react';

import type {
  TerminalAutocompleteItem,
  TerminalAutocompleteMenuHandle,
} from '../../components/terminal/terminal-autocomplete-menu';
import { t } from '../../lib/i18n';
import {
  AUTOCOMPLETE_PANEL_EDGE_PADDING,
  AUTOCOMPLETE_PANEL_ESTIMATED_WIDTH,
  AUTOCOMPLETE_TYPING_DEBOUNCE_MS,
  type TerminalAutocompleteAnchor,
  type TerminalPaneRuntime,
} from './ssh-types';
import { sendClientMessage } from './ssh-utils';
import { type AutocompleteInteractionMode, resolveAutocompleteKeyAction } from './terminal-autocomplete-interaction';
import {
  bindCompletionViewUpdate,
  canRequestTerminalCompletion,
  completionQueryNotice,
  type CompletionViewRequest,
  retainsCompletionView,
  shouldQueryAfterTerminalInput,
} from './terminal-completion-state';

/** UI settings and live pane authorities; current input and directory text never enter this hook. */
type UseSshAutocompleteParams = {
  isActive: boolean;
  connectionState: 'connecting' | 'connected' | 'failed';
  terminalAutoCompleteEnabled: boolean;
  terminalAutoCompleteHistoryEnabled: boolean;
  terminalAutoCompleteBuiltInCommandsEnabled: boolean;
  terminalAutoCompletePathEnabled: boolean;
  terminalAutoCompleteAcceptKeys: SettingsValues['terminalAutoCompleteAcceptKeys'];
  terminalAutoCompleteFocusShortcut: SettingsValues['terminalAutoCompleteFocusShortcut'];
  terminalAutoCompleteMinChars: number;
  terminalAutoCompleteMaxItems: number;
  terminalAutoCompleteFuzzyMatch: boolean;
  terminalNativeCompletionMode: SettingsValues['terminalNativeCompletionMode'];
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  activePaneIdRef: React.RefObject<string>;
  paneRuntimeMapRef: React.RefObject<Map<string, Pick<TerminalPaneRuntime, 'terminal' | 'socket'>>>;
  getPaneContext: (paneId: string) => ShellContext | null;
  notifyWarning: (message: string) => void;
};

/** A selected edit keeps its own acknowledgement identity after the menu closes. */
type PendingAcceptance = {
  requestId: string;
  paneId: string;
  sessionId: string;
  canceled: boolean;
  chain: boolean;
};

/** Text-free source outcomes belong to one unchanged original Shell observation. */
type SourceDiagnosticOwner = { paneId: string } & Pick<ShellContext, 'sessionId' | 'shellInstanceId' | 'revision'>;

/**
 * Displays opaque snapshot candidates and delegates every edit to the original Shell.
 * Stable transport callbacks read current settings through refs, so changing menu state never reconnects a PTY.
 * @param params Settings and live pane resources.
 * @returns Menu state and synchronous invalidation, transport and keyboard handlers.
 */
export const useSshAutocomplete = (params: UseSshAutocompleteParams) => {
  const optionsRef = React.useRef(params);
  React.useLayoutEffect(() => {
    optionsRef.current = params;
  });
  const requestRef = React.useRef<CompletionViewRequest | null>(null);
  const acceptanceRef = React.useRef<PendingAcceptance | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const itemsRef = React.useRef<TerminalAutocompleteItem[]>([]);
  const modeRef = React.useRef<AutocompleteInteractionMode>('passive');
  const autocompleteMenuRef = React.useRef<TerminalAutocompleteMenuHandle | null>(null);
  const [autocompleteItems, setAutocompleteItems] = React.useState<TerminalAutocompleteItem[]>([]);
  const [autocompleteSources, setAutocompleteSources] = React.useState<TerminalCompletionSources | null>(null);
  const sourceOwnerRef = React.useRef<SourceDiagnosticOwner | null>(null);
  const [autocompleteFocused, setAutocompleteFocused] = React.useState(false);
  const [autocompleteAnchor, setAutocompleteAnchor] = React.useState<TerminalAutocompleteAnchor | null>(null);

  /** @param mode Keyboard ownership. @returns Nothing; ownership changes before the next key event. */
  const setMode = React.useCallback((mode: AutocompleteInteractionMode): void => {
    modeRef.current = mode;
    setAutocompleteFocused(mode === 'focused');
  }, []);

  /** @returns Nothing after releasing the typing debounce. */
  const clearTimer = React.useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  /** @returns Nothing after hiding presentation; no backend edit is canceled by this function. */
  const hideMenu = React.useCallback((): void => {
    itemsRef.current = [];
    setMode('passive');
    setAutocompleteItems((items) => (items.length ? [] : items));
    setAutocompleteAnchor(null);
    autocompleteMenuRef.current?.reset();
  }, [setMode]);

  /** @param paneId Socket owner. @param requestId Opaque operation to cancel. @returns Nothing. */
  const sendCancel = React.useCallback((paneId: string, requestId: string): void => {
    const socket = optionsRef.current.paneRuntimeMapRef.current.get(paneId)?.socket;
    if (socket?.readyState === WebSocket.OPEN) sendClientMessage(socket, { type: 'completion-cancel', requestId });
  }, []);

  /** @returns Nothing; dismissal revokes edits while preserving text-free diagnostics for the status dialog. */
  const dismissAutocomplete = React.useCallback((): void => {
    clearTimer();
    const query = requestRef.current;
    requestRef.current = null;
    if (query) sendCancel(query.paneId, query.requestId);
    const acceptance = acceptanceRef.current;
    if (acceptance && !acceptance.canceled) {
      acceptance.canceled = true;
      sendCancel(acceptance.paneId, acceptance.requestId);
    }
    hideMenu();
  }, [clearTimer, hideMenu, sendCancel]);

  /** @returns Nothing after invalidating source evidence and every pending operation. */
  const closeAutocomplete = React.useCallback((): void => {
    sourceOwnerRef.current = null;
    setAutocompleteSources(null);
    dismissAutocomplete();
  }, [dismissAutocomplete]);

  /** @param paneId Source owner. @param context Current observation. @param sources Text-free outcomes. @returns Nothing. */
  const updateSourceDiagnostics = React.useCallback(
    (paneId: string, context: ShellContext, sources: TerminalCompletionSources): void => {
      sourceOwnerRef.current = {
        paneId,
        sessionId: context.sessionId,
        shellInstanceId: context.shellInstanceId,
        revision: context.revision,
      };
      setAutocompleteSources({ ...sources });
    },
    [],
  );

  /** @param paneId Requested pane. @returns Whether the current UI and original Shell permit an observation. */
  const available = React.useCallback((paneId: string): boolean => {
    const options = optionsRef.current;
    const runtime = options.paneRuntimeMapRef.current.get(paneId);
    return (
      options.isActive &&
      options.terminalAutoCompleteEnabled &&
      options.connectionState === 'connected' &&
      paneId === options.activePaneIdRef.current &&
      runtime?.socket?.readyState === WebSocket.OPEN &&
      runtime.terminal.buffer.active !== runtime.terminal.buffer.alternate &&
      canRequestTerminalCompletion(options.getPaneContext(paneId))
    );
  }, []);

  /** @returns Popup position using xterm geometry only; rendered text is never used as input. */
  const resolveAnchor = React.useCallback((): TerminalAutocompleteAnchor | null => {
    const options = optionsRef.current;
    const terminal = options.terminalRef.current;
    const wrapper = options.wrapperRef.current;
    const container = options.terminalContainerRef.current;
    if (!terminal || !wrapper || !container || terminal.buffer.active === terminal.buffer.alternate) return null;
    const wrapperRect = wrapper.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const internal = terminal as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
    };
    const cellWidth = internal._core?._renderService?.dimensions?.css?.cell?.width ?? 9;
    const cellHeight = internal._core?._renderService?.dimensions?.css?.cell?.height ?? 18;
    const panelWidth = Math.min(
      AUTOCOMPLETE_PANEL_ESTIMATED_WIDTH,
      Math.max(180, wrapperRect.width - AUTOCOMPLETE_PANEL_EDGE_PADDING * 2),
    );
    const left = containerRect.left - wrapperRect.left + terminal.buffer.active.cursorX * cellWidth;
    const maxLeft = Math.max(
      AUTOCOMPLETE_PANEL_EDGE_PADDING,
      wrapperRect.width - panelWidth - AUTOCOMPLETE_PANEL_EDGE_PADDING,
    );
    const baseline = containerRect.top - wrapperRect.top + terminal.buffer.active.cursorY * cellHeight;
    const renderAbove = baseline - 280 - 8 >= 8;
    return {
      left: Math.max(AUTOCOMPLETE_PANEL_EDGE_PADDING, Math.min(left, maxLeft)),
      top: renderAbove ? baseline - 8 : baseline + cellHeight + 8,
      panelWidth,
      renderAbove,
    };
  }, []);

  /** @param paneId Query owner. @param trigger Typing or explicit entry. @returns Nothing. */
  const requestAutocomplete = React.useCallback(
    (paneId: string, trigger: 'typing' | 'manual'): void => {
      closeAutocomplete();
      if (!available(paneId)) return;
      const options = optionsRef.current;
      const context = options.getPaneContext(paneId)!;
      const socket = options.paneRuntimeMapRef.current.get(paneId)!.socket!;
      const requestId = crypto.randomUUID();
      requestRef.current = {
        paneId,
        requestId,
        trigger,
        sessionId: context.sessionId,
        shellInstanceId: context.shellInstanceId!,
        promptGeneration: context.promptGeneration,
        snapshotId: null,
        contextRevision: null,
      };
      setMode(trigger === 'manual' ? 'requested' : 'passive');
      sendClientMessage(socket, { type: 'completion-query', requestId, trigger });
    },
    [available, closeAutocomplete, setMode],
  );

  /** @param paneId Query owner. @param trigger Intent. @returns Nothing; ordinary input never waits here. */
  const scheduleAutocompleteRequest = React.useCallback(
    (paneId: string, trigger: 'typing' | 'manual'): void => {
      clearTimer();
      if (trigger === 'manual') requestAutocomplete(paneId, trigger);
      else
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          requestAutocomplete(paneId, 'typing');
        }, AUTOCOMPLETE_TYPING_DEBOUNCE_MS);
    },
    [clearTimer, requestAutocomplete],
  );

  /** @param paneId Ending or replaced pane. @returns Nothing after releasing its operation authority. */
  const resetAutocompletePaneState = React.useCallback(
    (paneId: string): void => {
      if (
        requestRef.current?.paneId === paneId ||
        acceptanceRef.current?.paneId === paneId ||
        optionsRef.current.activePaneIdRef.current === paneId
      )
        closeAutocomplete();
      if (acceptanceRef.current?.paneId === paneId) acceptanceRef.current = null;
    },
    [closeAutocomplete],
  );

  /** @param paneId Input owner. @param data Already-forwarded bytes, never retained. @returns Nothing after synchronous invalidation. */
  const applyAutocompleteInputData = React.useCallback(
    (paneId: string, data: string): void => {
      if (paneId !== optionsRef.current.activePaneIdRef.current) return;
      closeAutocomplete();
      const shouldRequest = available(paneId) && shouldQueryAfterTerminalInput(data);
      if (shouldRequest) scheduleAutocompleteRequest(paneId, 'typing');
    },
    [available, closeAutocomplete, scheduleAutocompleteRequest],
  );

  /** @param paneId Context owner. @param context Newly received state. @returns Nothing. */
  const handleAutocompleteContext = React.useCallback(
    (paneId: string, context: ShellContext): void => {
      const owner = sourceOwnerRef.current;
      if (
        owner?.paneId === paneId &&
        (owner.revision !== context.revision ||
          owner.sessionId !== context.sessionId ||
          owner.shellInstanceId !== context.shellInstanceId)
      ) {
        sourceOwnerRef.current = null;
        setAutocompleteSources(null);
      }
      const request = requestRef.current;
      if (request?.paneId === paneId && !retainsCompletionView(request, context)) closeAutocomplete();
      const acceptance = acceptanceRef.current;
      if (acceptance?.paneId === paneId && acceptance.sessionId !== context.sessionId)
        resetAutocompletePaneState(paneId);
    },
    [closeAutocomplete, resetAutocompletePaneState],
  );

  /** @param payload Cumulative opaque candidates. @param paneId Socket owner. @returns Nothing. */
  const handleCompletionResponse = React.useCallback(
    (payload: TerminalCompletionUpdate, paneId: string): void => {
      const request = requestRef.current;
      if (!request || request.paneId !== paneId || request.requestId !== payload.requestId) return;
      const options = optionsRef.current;
      const bound = available(paneId)
        ? bindCompletionViewUpdate(request, paneId, options.getPaneContext(paneId), payload)
        : null;
      if (payload.status !== 'ready') {
        const current = available(paneId) && retainsCompletionView(request, options.getPaneContext(paneId));
        closeAutocomplete();
        if (current && payload.status !== 'stale') {
          updateSourceDiagnostics(paneId, options.getPaneContext(paneId)!, payload.sources);
          const notice = request.trigger === 'manual' ? completionQueryNotice(payload) : null;
          if (notice) options.notifyWarning(t(notice));
        }
        return;
      }
      if (!bound) {
        closeAutocomplete();
        return;
      }
      requestRef.current = bound;
      updateSourceDiagnostics(paneId, options.getPaneContext(paneId)!, payload.sources);
      const items = payload.items.filter(
        (item) => item.source !== 'history' || options.terminalAutoCompleteHistoryEnabled,
      );
      // The backend retains bound edits for this exact snapshot. Preserve the user's selected identity
      // when a slower source changes ranking, while keeping the configured menu size bounded.
      const selectedId = modeRef.current === 'focused' ? autocompleteMenuRef.current?.getActiveId() : null;
      const selected = itemsRef.current.find((item) => item.id === selectedId);
      if (selected && !items.some((item) => item.id === selected.id)) {
        items.splice(Math.max(0, options.terminalAutoCompleteMaxItems - 1));
        items.push(selected);
      }
      // An empty early batch keeps an explicit query pending until its slower sources finish.
      if (items.length === 0) {
        if (payload.complete) {
          closeAutocomplete();
          updateSourceDiagnostics(paneId, options.getPaneContext(paneId)!, payload.sources);
          const notice = request.trigger === 'manual' ? completionQueryNotice({ ...payload, items }) : null;
          if (notice) options.notifyWarning(t(notice));
        }
        return;
      }
      const anchor = resolveAnchor();
      if (!anchor) {
        closeAutocomplete();
        return;
      }
      itemsRef.current = items;
      setAutocompleteItems(items);
      setAutocompleteAnchor(anchor);
      if (modeRef.current === 'requested') setMode('focused');
    },
    [available, closeAutocomplete, resolveAnchor, setMode, updateSourceDiagnostics],
  );

  /** @param candidateId Identity selected from the rendered menu. @returns Nothing; never substitutes another row or presses Enter. */
  const acceptAutocompleteCandidate = React.useCallback(
    (candidateId: string | null): void => {
      const request = requestRef.current;
      const candidate = itemsRef.current.find((item) => item.id === candidateId);
      if (
        !request?.snapshotId ||
        !candidate ||
        !available(request.paneId) ||
        !retainsCompletionView(request, optionsRef.current.getPaneContext(request.paneId))
      ) {
        closeAutocomplete();
        return;
      }
      const runtime = optionsRef.current.paneRuntimeMapRef.current.get(request.paneId)!;
      const requestId = crypto.randomUUID();
      acceptanceRef.current = {
        requestId,
        paneId: request.paneId,
        sessionId: request.sessionId,
        canceled: false,
        chain: candidate.kind === 'path' && candidate.label.endsWith('/'),
      };
      requestRef.current = null;
      clearTimer();
      // Hiding a chosen query must not cancel the same remote operation that will verify its edit.
      sendClientMessage(runtime.socket!, {
        type: 'completion-accept',
        requestId,
        snapshotId: request.snapshotId,
        candidateId: candidate.id,
      });
      hideMenu();
      runtime.terminal.focus();
    },
    [available, clearTimer, closeAutocomplete, hideMenu],
  );

  /** @param payload Exact one-use edit outcome. @param paneId Socket owner. @returns Nothing; unknown results never retry. */
  const handleCompletionAcceptResult = React.useCallback(
    (payload: TerminalCompletionAcceptResult, paneId: string): void => {
      const acceptance = acceptanceRef.current;
      if (!acceptance || acceptance.paneId !== paneId || acceptance.requestId !== payload.requestId) return;
      acceptanceRef.current = null;
      if (payload.status === 'applied') {
        if (!acceptance.canceled && acceptance.chain && available(paneId))
          scheduleAutocompleteRequest(paneId, 'manual');
        return;
      }
      if (!acceptance.canceled || payload.status === 'unknown')
        optionsRef.current.notifyWarning(t(`ssh.autocomplete.apply.${payload.status}`));
    },
    [available, scheduleAutocompleteRequest],
  );

  /** @param event Original keyboard event. @param paneId Event owner. @returns Nothing; passive lists preserve Shell keys. */
  const handleAutocompleteTerminalKeyDown = React.useCallback(
    (event: KeyboardEvent, paneId: string): void => {
      const options = optionsRef.current;
      const action = resolveAutocompleteKeyAction(event, {
        available: available(paneId),
        hasItems: requestRef.current?.paneId === paneId && itemsRef.current.length > 0,
        mode: modeRef.current,
        acceptKeys: options.terminalAutoCompleteAcceptKeys,
        focusShortcut: options.terminalAutoCompleteFocusShortcut,
      });
      if (action === 'pass') return;
      if (action === 'dismiss-pass') {
        dismissAutocomplete();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === 'focus' && modeRef.current !== 'focused') scheduleAutocompleteRequest(paneId, 'manual');
      if (action === 'request') scheduleAutocompleteRequest(paneId, 'manual');
      if (action === 'next') autocompleteMenuRef.current?.moveNext();
      if (action === 'previous') autocompleteMenuRef.current?.movePrevious();
      if (action === 'accept') acceptAutocompleteCandidate(autocompleteMenuRef.current?.getActiveId() ?? null);
      if (action === 'close') dismissAutocomplete();
    },
    [acceptAutocompleteCandidate, available, dismissAutocomplete, scheduleAutocompleteRequest],
  );

  /** @returns Nothing after granting the existing list keyboard ownership without moving focus away from xterm. */
  const focusAutocomplete = React.useCallback((): void => {
    const paneId = optionsRef.current.activePaneIdRef.current;
    if (requestRef.current?.paneId !== paneId || !itemsRef.current.length || !available(paneId)) return;
    setMode('focused');
    optionsRef.current.terminalRef.current?.focus();
  }, [available, setMode]);

  React.useLayoutEffect(() => {
    closeAutocomplete();
  }, [
    closeAutocomplete,
    params.isActive,
    params.connectionState,
    params.terminalAutoCompleteEnabled,
    params.terminalAutoCompleteHistoryEnabled,
    params.terminalAutoCompleteBuiltInCommandsEnabled,
    params.terminalAutoCompletePathEnabled,
    params.terminalAutoCompleteFuzzyMatch,
    params.terminalAutoCompleteMinChars,
    params.terminalAutoCompleteMaxItems,
    params.terminalNativeCompletionMode,
  ]);

  React.useEffect(() => {
    /** @param event New focus owner. @returns Nothing after dismissing a list that no longer owns the interaction. */
    const handleFocus = (event: FocusEvent): void => {
      if (!(event.target instanceof Element)) return;
      const options = optionsRef.current;
      const withinTerminal = options.terminalRef.current?.element?.contains(event.target);
      const withinMenu =
        options.wrapperRef.current?.contains(event.target) && event.target.closest('[data-terminal-autocomplete]');
      if (!withinTerminal && !withinMenu) dismissAutocomplete();
    };
    window.addEventListener('blur', dismissAutocomplete);
    document.addEventListener('focusin', handleFocus);
    return () => {
      window.removeEventListener('blur', dismissAutocomplete);
      document.removeEventListener('focusin', handleFocus);
      closeAutocomplete();
    };
  }, [closeAutocomplete, dismissAutocomplete]);

  React.useEffect(() => {
    const options = optionsRef.current;
    const wrapper = options.wrapperRef.current;
    const container = options.terminalContainerRef.current;
    if (!autocompleteItems.length || !wrapper || !container) return;
    const observer = new ResizeObserver(() => {
      const anchor = resolveAnchor();
      if (anchor) setAutocompleteAnchor(anchor);
      else closeAutocomplete();
    });
    observer.observe(wrapper);
    observer.observe(container);
    return () => observer.disconnect();
  }, [autocompleteItems.length, closeAutocomplete, resolveAnchor]);

  /** @returns Nothing after explicitly requesting all enabled sources for the current input. */
  const requestAutocompleteFocus = React.useCallback((): void => {
    if (modeRef.current !== 'focused')
      scheduleAutocompleteRequest(optionsRef.current.activePaneIdRef.current, 'manual');
    optionsRef.current.terminalRef.current?.focus();
  }, [scheduleAutocompleteRequest]);

  const closeAutocompleteRef = React.useRef(closeAutocomplete);
  const scheduleAutocompleteRequestRef = React.useRef(scheduleAutocompleteRequest);
  const handleAutocompleteTerminalKeyDownRef = React.useRef(handleAutocompleteTerminalKeyDown);
  React.useLayoutEffect(() => {
    closeAutocompleteRef.current = closeAutocomplete;
    scheduleAutocompleteRequestRef.current = scheduleAutocompleteRequest;
    handleAutocompleteTerminalKeyDownRef.current = handleAutocompleteTerminalKeyDown;
  }, [closeAutocomplete, scheduleAutocompleteRequest, handleAutocompleteTerminalKeyDown]);

  return {
    autocompleteItems,
    autocompleteSources,
    autocompleteFocused,
    autocompleteInputElement: params.terminalRef.current?.textarea ?? null,
    autocompleteAnchor,
    autocompleteMenuRef,
    focusAutocomplete,
    requestAutocompleteFocus,
    acceptAutocompleteCandidate,
    applyAutocompleteInputData,
    resetAutocompletePaneState,
    handleAutocompleteContext,
    handleCompletionResponse,
    handleCompletionAcceptResult,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
  };
};
