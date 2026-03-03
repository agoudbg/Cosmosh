import '@xterm/xterm/css/xterm.css';

import { type ITerminalOptions, Terminal } from '@xterm/xterm';
import classNames from 'classnames';
import { RefreshCw } from 'lucide-react';
import React from 'react';

import { TerminalAutocompleteMenu } from '../components/terminal/terminal-autocomplete-menu';
import { TerminalSelectionBar } from '../components/terminal/terminal-selection-bar';
import { TerminalTextDropZone } from '../components/terminal/terminal-text-drop-zone';
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
import { Menubar } from '../components/ui/menubar';
import { t } from '../lib/i18n';
import { useSettingsValues } from '../lib/settings-store';
import { useToast } from '../lib/toast-context';
import { useTerminalTextDropZone } from '../lib/use-terminal-text-drop-zone';
import { resolveTerminalTarget } from './ssh/ssh-target';
import {
  DEFAULT_TELEMETRY_STATE,
  type HostFingerprintPrompt,
  INTERNAL_TERMINAL_TEXT_DRAG_MIME,
  MAX_TERMINAL_PANES,
  type MirrorPaneRuntime,
  type ResolvedTerminalTarget,
  type SshTelemetryState,
  type TerminalSelectionSettings,
} from './ssh/ssh-types';
import {
  applyTerminalRuntimeOptions,
  parseOptionalNumberSetting,
  resolveSearchUrl,
  resolveTerminalFontWeightSetting,
  sendClientMessage,
} from './ssh/ssh-utils';
import { SSHSidebar } from './ssh/SSHSidebar';
import { SSHTerminalPaneLayout } from './ssh/SSHTerminalPaneLayout';
import { useSshAutocomplete } from './ssh/use-ssh-autocomplete';
import { useSshMirrorPanes } from './ssh/use-ssh-mirror-panes';
import { useSshPrimarySession } from './ssh/use-ssh-primary-session';
import { useSshSelectionBar } from './ssh/use-ssh-selection-bar';

/**
 * SSH page props.
 */
type SSHProps = {
  onTabTitleChange?: (title: string) => void;
};

/**
 * SSH page that orchestrates terminal lifecycle, websocket sessions,
 * split-pane mirroring, and interaction overlays.
 */
const SSH: React.FC<SSHProps> = ({ onTabTitleChange }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const settingsValues = useSettingsValues();
  const onTabTitleChangeRef = React.useRef<SSHProps['onTabTitleChange']>(onTabTitleChange);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const primaryPaneIdRef = React.useRef<string>('pane-1');
  const activePaneIdRef = React.useRef<string>('pane-1');
  const paneContainerMapRef = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const mirrorPaneRuntimeMapRef = React.useRef<Map<string, MirrorPaneRuntime>>(new Map());
  const paneIdSequenceRef = React.useRef<number>(1);
  const selectionPointerClientXRef = React.useRef<number | null>(null);
  const primaryTerminalRef = React.useRef<Terminal | null>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const primarySocketRef = React.useRef<WebSocket | null>(null);
  const resolvedTerminalTargetRef = React.useRef<ResolvedTerminalTarget | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const scheduleFitAndResizeSyncRef = React.useRef<(() => void) | null>(null);
  const selectionBarRef = React.useRef<HTMLDivElement | null>(null);
  const connectSessionRef = React.useRef<(() => void) | null>(null);
  const fingerprintPromptResolverRef = React.useRef<((accepted: boolean) => void) | null>(null);
  const [terminalPaneIds, setTerminalPaneIds] = React.useState<string[]>(['pane-1']);
  const [connectionState, setConnectionState] = React.useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connectionError, setConnectionError] = React.useState<string>('');
  const [telemetryState, setTelemetryState] = React.useState<SshTelemetryState>(DEFAULT_TELEMETRY_STATE);
  const [hostFingerprintPrompt, setHostFingerprintPrompt] = React.useState<HostFingerprintPrompt | null>(null);

  // Derive terminal-relevant settings from the centralized store.
  const sshMaxRows = settingsValues.sshMaxRows;
  const sshConnectionTimeoutSec = settingsValues.sshConnectionTimeoutSec;
  const terminalTextDropMode = settingsValues.terminalTextDropMode;
  const terminalAutoCompleteEnabled = settingsValues.terminalAutoCompleteEnabled;
  const terminalAutoCompleteMinChars = settingsValues.terminalAutoCompleteMinChars;
  const terminalAutoCompleteMaxItems = settingsValues.terminalAutoCompleteMaxItems;
  const terminalAutoCompleteFuzzyMatch = settingsValues.terminalAutoCompleteFuzzyMatch;
  const terminalInitOptions = React.useMemo<ITerminalOptions>(() => {
    const terminalBackground =
      getComputedStyle(document.documentElement).getPropertyValue('--color-ssh-card-bg-terminal').trim() || '#000000';
    const cursorWidth = parseOptionalNumberSetting(settingsValues.terminalCursorWidth, { min: 1, max: 32 });
    const lineHeight = parseOptionalNumberSetting(settingsValues.terminalLineHeight, { min: 0.5, max: 3 });
    const scrollSensitivity = parseOptionalNumberSetting(settingsValues.terminalScrollSensitivity, {
      min: 0.1,
      max: 50,
    });
    const fastScrollSensitivity = parseOptionalNumberSetting(settingsValues.terminalFastScrollSensitivity, {
      min: 0.1,
      max: 200,
    });
    const minimumContrastRatio = parseOptionalNumberSetting(settingsValues.terminalMinimumContrastRatio, {
      min: 1,
      max: 21,
    });

    return {
      convertEol: true,
      altClickMovesCursor: settingsValues.terminalAltClickMovesCursor,
      cursorBlink: settingsValues.terminalCursorBlink,
      cursorInactiveStyle: settingsValues.terminalCursorInactiveStyle,
      cursorStyle: settingsValues.terminalCursorStyle,
      cursorWidth,
      customGlyphs: settingsValues.terminalCustomGlyphs,
      drawBoldTextInBrightColors: settingsValues.terminalDrawBoldTextInBrightColors,
      fastScrollSensitivity,
      fontFamily: settingsValues.terminalFontFamily,
      fontSize: settingsValues.terminalFontSize,
      fontWeight: resolveTerminalFontWeightSetting(settingsValues.terminalFontWeight, 'normal'),
      fontWeightBold: resolveTerminalFontWeightSetting(settingsValues.terminalFontWeightBold, 'bold'),
      letterSpacing: settingsValues.terminalLetterSpacing,
      lineHeight: lineHeight ?? 1,
      minimumContrastRatio,
      screenReaderMode: settingsValues.terminalScreenReaderMode,
      scrollback: sshMaxRows,
      scrollOnUserInput: settingsValues.terminalScrollOnUserInput,
      scrollSensitivity,
      smoothScrollDuration: settingsValues.terminalSmoothScrollDuration,
      tabStopWidth: settingsValues.terminalTabStopWidth,
      theme: {
        background: terminalBackground,
      },
    };
  }, [
    settingsValues.terminalAltClickMovesCursor,
    settingsValues.terminalCursorBlink,
    settingsValues.terminalCursorInactiveStyle,
    settingsValues.terminalCursorStyle,
    settingsValues.terminalCursorWidth,
    settingsValues.terminalCustomGlyphs,
    settingsValues.terminalDrawBoldTextInBrightColors,
    settingsValues.terminalFastScrollSensitivity,
    settingsValues.terminalFontFamily,
    settingsValues.terminalFontSize,
    settingsValues.terminalFontWeight,
    settingsValues.terminalFontWeightBold,
    settingsValues.terminalLetterSpacing,
    settingsValues.terminalLineHeight,
    settingsValues.terminalMinimumContrastRatio,
    settingsValues.terminalScreenReaderMode,
    settingsValues.terminalScrollOnUserInput,
    settingsValues.terminalScrollSensitivity,
    settingsValues.terminalSmoothScrollDuration,
    settingsValues.terminalTabStopWidth,
    sshMaxRows,
  ]);
  const terminalSelectionSettings: TerminalSelectionSettings = React.useMemo(
    () => ({
      enabled: settingsValues.terminalSelectionBarEnabled,
      searchEngine: settingsValues.terminalSelectionSearchEngine,
      searchUrlTemplate: settingsValues.terminalSelectionSearchUrlTemplate,
    }),
    [
      settingsValues.terminalSelectionBarEnabled,
      settingsValues.terminalSelectionSearchEngine,
      settingsValues.terminalSelectionSearchUrlTemplate,
    ],
  );

  const {
    autocompleteItems,
    autocompleteAnchor,
    autocompleteMenuRef,
    acceptAutocompleteAtIndex,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
  } = useSshAutocomplete({
    connectionState,
    terminalAutoCompleteEnabled,
    terminalAutoCompleteMinChars,
    terminalAutoCompleteMaxItems,
    terminalAutoCompleteFuzzyMatch,
    wrapperRef,
    terminalContainerRef,
    terminalRef,
    socketRef,
    primaryPaneIdRef,
    activePaneIdRef,
    primarySocketRef,
    primaryTerminalRef,
    mirrorPaneRuntimeMapRef,
  });

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
    enabled: terminalSelectionSettings.enabled,
  });

  React.useEffect(() => {
    onTabTitleChangeRef.current = onTabTitleChange;
  }, [onTabTitleChange]);

  React.useEffect(() => {
    const nextPrimaryPaneId = terminalPaneIds[0] ?? 'pane-1';
    primaryPaneIdRef.current = nextPrimaryPaneId;

    if (!terminalPaneIds.includes(activePaneIdRef.current)) {
      activePaneIdRef.current = nextPrimaryPaneId;
      terminalRef.current =
        nextPrimaryPaneId === primaryPaneIdRef.current
          ? primaryTerminalRef.current
          : (mirrorPaneRuntimeMapRef.current.get(nextPrimaryPaneId)?.terminal ?? terminalRef.current);
      terminalContainerRef.current = paneContainerMapRef.current.get(nextPrimaryPaneId) ?? terminalContainerRef.current;
    }
  }, [terminalPaneIds]);

  /**
   * Keeps pane id -> container element mapping synchronized with React refs.
   *
   * @param paneId Logical pane identifier.
   * @param element Current pane container element or `null` on unmount.
   * @returns Nothing.
   */
  const setPaneContainerElement = React.useCallback((paneId: string, element: HTMLDivElement | null) => {
    const existingElement = paneContainerMapRef.current.get(paneId) ?? null;

    if (element) {
      if (existingElement === element) {
        return;
      }

      paneContainerMapRef.current.set(paneId, element);
      return;
    }

    if (!existingElement) {
      return;
    }

    paneContainerMapRef.current.delete(paneId);
  }, []);

  /**
   * Adds one mirrored pane while respecting the hard pane limit.
   *
   * @returns Nothing.
   */
  const splitTerminalPane = React.useCallback(() => {
    setTerminalPaneIds((previous) => {
      if (previous.length >= MAX_TERMINAL_PANES) {
        return previous;
      }

      paneIdSequenceRef.current += 1;
      return [...previous, `pane-${paneIdSequenceRef.current}`];
    });
  }, []);

  /**
   * Closes a mirrored pane and safely reassigns active pane focus.
   *
   * @param paneId Pane id to close.
   * @returns Nothing.
   */
  const closeTerminalPane = React.useCallback((paneId: string) => {
    setTerminalPaneIds((previous) => {
      if (previous.length <= 1) {
        return previous;
      }

      const index = previous.indexOf(paneId);
      if (index < 0) {
        return previous;
      }

      const next = previous.filter((item) => item !== paneId);
      if (next.length === 0) {
        return previous;
      }

      if (activePaneIdRef.current === paneId) {
        activePaneIdRef.current = next[Math.max(0, index - 1)] ?? next[0] ?? primaryPaneIdRef.current;
      }

      return next;
    });
  }, []);

  const terminalInitOptionsRef = React.useRef<ITerminalOptions>(terminalInitOptions);
  const sshConnectionTimeoutSecRef = React.useRef<number>(sshConnectionTimeoutSec);

  React.useEffect(() => {
    sshConnectionTimeoutSecRef.current = sshConnectionTimeoutSec;
  }, [sshConnectionTimeoutSec]);

  /**
   * Resolves the pending host-fingerprint confirmation promise.
   *
   * @param accepted Whether user accepted trusting host fingerprint.
   * @returns Nothing.
   */
  const resolveHostFingerprintPrompt = React.useCallback((accepted: boolean) => {
    const resolver = fingerprintPromptResolverRef.current;
    fingerprintPromptResolverRef.current = null;
    setHostFingerprintPrompt(null);
    resolver?.(accepted);
  }, []);

  /**
   * Opens trust dialog and suspends session creation until user decision.
   *
   * @param prompt Fingerprint prompt data shown in dialog.
   * @returns Promise resolved with user decision.
   */
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

  /**
   * Switches active pane context for terminal, container and socket refs.
   *
   * @param paneId Pane id to activate.
   * @returns Nothing.
   */
  const setActivePane = React.useCallback(
    (paneId: string) => {
      const didPaneChange = activePaneIdRef.current !== paneId;
      activePaneIdRef.current = paneId;

      const isPrimaryPane = paneId === primaryPaneIdRef.current;
      const nextTerminal = isPrimaryPane
        ? primaryTerminalRef.current
        : (mirrorPaneRuntimeMapRef.current.get(paneId)?.terminal ?? null);
      const nextContainer = paneContainerMapRef.current.get(paneId) ?? null;
      const nextSocket = isPrimaryPane
        ? primarySocketRef.current
        : (mirrorPaneRuntimeMapRef.current.get(paneId)?.socket ?? null);

      if (nextTerminal) {
        terminalRef.current = nextTerminal;
      }

      if (nextContainer) {
        terminalContainerRef.current = nextContainer;
      }

      socketRef.current = nextSocket;

      if (didPaneChange) {
        closeAutocompleteRef.current();
      }

      refreshSelectionAnchor();
    },
    [closeAutocompleteRef, refreshSelectionAnchor],
  );

  React.useEffect(() => {
    terminalInitOptionsRef.current = terminalInitOptions;

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    applyTerminalRuntimeOptions(terminal, terminalInitOptions);
    scheduleFitAndResizeSyncRef.current?.();
    refreshSelectionAnchor();
  }, [refreshSelectionAnchor, terminalInitOptions]);

  // ---------------------------------------------------------------------------
  // Shared terminal action helpers — used by both the Orbit Bar and the context
  // menu so that behaviour is consistent across interaction surfaces.
  // ---------------------------------------------------------------------------

  const copyTextToClipboard = React.useCallback(
    async (text: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        notifySuccess(t('ssh.selectionBarCopySuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('ssh.selectionBarCopyFailed'));
      }
    },
    [notifyError, notifySuccess],
  );

  const openSearchForText = React.useCallback(
    (text: string): void => {
      try {
        const resolvedSearchUrl = resolveSearchUrl(
          terminalSelectionSettings.searchEngine,
          text,
          terminalSelectionSettings.searchUrlTemplate,
        );
        if (window.electron?.openExternalUrl) {
          void window.electron.openExternalUrl(resolvedSearchUrl).then((opened) => {
            if (!opened) {
              notifyError(t('ssh.selectionBarSearchFailed'));
            }
          });
          return;
        }

        const openedWindow = window.open(resolvedSearchUrl, '_blank', 'noopener,noreferrer');
        if (!openedWindow) {
          notifyError(t('ssh.selectionBarSearchFailed'));
          return;
        }

        openedWindow.opener = null;
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('ssh.selectionBarSearchFailed'));
      }
    },
    [notifyError, terminalSelectionSettings.searchEngine, terminalSelectionSettings.searchUrlTemplate],
  );

  // ---------------------------------------------------------------------------
  // Orbit Bar (TerminalSelectionBar) handlers
  // ---------------------------------------------------------------------------

  const handleSelectionBarCopy = React.useCallback(async () => {
    if (!selectionAnchor?.selectionText) {
      return;
    }

    await copyTextToClipboard(selectionAnchor.selectionText);
  }, [copyTextToClipboard, selectionAnchor]);

  const handleSelectionBarInsert = React.useCallback(() => {
    if (!selectionAnchor?.selectionText) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'input',
      data: selectionAnchor.selectionText,
    });
    terminalRef.current?.focus();
  }, [selectionAnchor]);

  const handleSelectionBarSearch = React.useCallback(() => {
    if (!selectionAnchor?.selectionText.trim()) {
      return;
    }

    openSearchForText(selectionAnchor.selectionText);
  }, [openSearchForText, selectionAnchor]);

  // ---------------------------------------------------------------------------
  // Context menu handlers
  // ---------------------------------------------------------------------------

  const handleContextMenuCopy = React.useCallback(() => {
    const selectionText = terminalRef.current?.getSelection() ?? '';
    if (!selectionText) {
      return;
    }

    void copyTextToClipboard(selectionText);
  }, [copyTextToClipboard]);

  const handleContextMenuPaste = React.useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          sendClientMessage(socket, { type: 'input', data: text });
          terminalRef.current?.focus();
        }
      })
      .catch(() => {
        // Clipboard read permission denied or unavailable; silently ignore.
      });
  }, []);

  const handleContextMenuSearchOnline = React.useCallback(() => {
    const selectionText = terminalRef.current?.getSelection() ?? '';
    if (!selectionText.trim()) {
      return;
    }

    openSearchForText(selectionText);
  }, [openSearchForText]);

  const handleContextMenuFind = React.useCallback(() => {
    notifyWarning(t('ssh.contextMenuFindComingSoon'));
  }, [notifyWarning]);

  const handleContextMenuSelectAll = React.useCallback(() => {
    terminalRef.current?.selectAll();
  }, []);

  const handleContextMenuClearTerminal = React.useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // Send Ctrl+L — the standard ANSI clear-screen sequence.
    sendClientMessage(socket, { type: 'input', data: '\x0c' });
    terminalRef.current?.focus();
  }, []);

  const handleDeleteRecentCommand = React.useCallback((command: string) => {
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
  }, []);

  const handleInsertRecentCommand = React.useCallback((command: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'input',
      data: command,
    });
    terminalRef.current?.focus();
  }, []);

  const handleSelectionBarDragStart = React.useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      if (!selectionAnchor?.selectionText) {
        event.preventDefault();
        return;
      }

      const escapedHtml = selectionAnchor.selectionText
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('\n', '<br/>');

      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(INTERNAL_TERMINAL_TEXT_DRAG_MIME, '1');
      event.dataTransfer.setData('text/plain', selectionAnchor.selectionText);
      event.dataTransfer.setData('text', selectionAnchor.selectionText);
      event.dataTransfer.setData('text/unicode', selectionAnchor.selectionText);
      event.dataTransfer.setData('text/html', `<pre>${escapedHtml}</pre>`);
    },
    [selectionAnchor],
  );

  const handleSelectionBarClose = React.useCallback(() => {
    dismissSelectionBar();
  }, [dismissSelectionBar]);

  const handleSelectionOpenDirectory = React.useCallback(() => {
    notifyWarning(t('ssh.selectionBarOpenDirectoryComingSoon'));
  }, [notifyWarning]);

  const handleSelectionAskAi = React.useCallback(() => {
    notifyWarning(t('ssh.selectionBarAskAiComingSoon'));
  }, [notifyWarning]);

  const handleTerminalTextDrop = React.useCallback((droppedText: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'input',
      data: droppedText,
    });
    terminalRef.current?.focus();
  }, []);

  const {
    isVisible: isTextDropZoneVisible,
    isActive: isTextDropZoneActive,
    centerX: textDropZoneCenterX,
    handleWrapperDragEnter,
    handleWrapperDragOver,
    handleWrapperDragLeave,
    handleWrapperDrop,
    handleZoneDragEnter: handleTextDropZoneDragEnter,
    handleZoneDragOver: handleTextDropZoneDragOver,
    handleZoneDragLeave: handleTextDropZoneDragLeave,
    handleZoneDrop: handleTextDropZoneDrop,
  } = useTerminalTextDropZone({
    mode: terminalTextDropMode,
    isConnected: connectionState === 'connected',
    wrapperRef,
    terminalContainerRef,
    internalDragMimeType: INTERNAL_TERMINAL_TEXT_DRAG_MIME,
    onDropText: handleTerminalTextDrop,
  });

  useSshPrimarySession({
    terminalInitOptionsRef,
    terminalContainerRef,
    terminalRef,
    primaryTerminalRef,
    primaryPaneIdRef,
    activePaneIdRef,
    primarySocketRef,
    socketRef,
    resolvedTerminalTargetRef,
    sshConnectionTimeoutSecRef,
    scheduleFitAndResizeSyncRef,
    connectSessionRef,
    selectionPointerClientXRef,
    onTabTitleChangeRef,
    setConnectionState,
    setConnectionError,
    setTelemetryState,
    requestHostFingerprintTrust,
    setActivePane,
    refreshSelectionAnchor,
    clearSelectionOverlay,
    applyAutocompleteInputData,
    closeAutocompleteRef,
    scheduleAutocompleteRequestRef,
    handleAutocompleteTerminalKeyDownRef,
    handleCompletionResponse,
  });

  useSshMirrorPanes({
    connectionState,
    terminalPaneIds,
    terminalInitOptionsRef,
    paneContainerMapRef,
    mirrorPaneRuntimeMapRef,
    primaryTerminalRef,
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
  });

  // Card style
  const cardStyle = 'bg-ssh-card-bg-terminal h-full w-full flex-1 overflow-hidden rounded-[18px] p-1';

  const canSplitTerminal = terminalPaneIds.length < MAX_TERMINAL_PANES;

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full w-full gap-2.5"
      onDragEnter={handleWrapperDragEnter}
      onDragOver={handleWrapperDragOver}
      onDragLeave={handleWrapperDragLeave}
      onDrop={handleWrapperDrop}
    >
      {/* SSH */}
      <div className={classNames(cardStyle, 'min-w-0')}>
        <SSHTerminalPaneLayout
          terminalPaneIds={terminalPaneIds}
          activePaneId={activePaneIdRef.current}
          hasSelection={!!selectionAnchor?.selectionText}
          isConnected={connectionState === 'connected'}
          canSplitTerminal={canSplitTerminal}
          setPaneContainerElement={setPaneContainerElement}
          setPrimaryPaneContainer={(element) => {
            terminalContainerRef.current = element;
          }}
          onPaneActivate={setActivePane}
          onCopy={(paneId) => {
            setActivePane(paneId);
            handleContextMenuCopy();
          }}
          onPaste={(paneId) => {
            setActivePane(paneId);
            handleContextMenuPaste();
          }}
          onSearchOnline={(paneId) => {
            setActivePane(paneId);
            handleContextMenuSearchOnline();
          }}
          onFind={(paneId) => {
            setActivePane(paneId);
            handleContextMenuFind();
          }}
          onSelectAll={(paneId) => {
            setActivePane(paneId);
            handleContextMenuSelectAll();
          }}
          onClearTerminal={(paneId) => {
            setActivePane(paneId);
            handleContextMenuClearTerminal();
          }}
          onSplitPane={(paneId) => {
            setActivePane(paneId);
            splitTerminalPane();
          }}
          onClosePane={(paneId) => {
            setActivePane(paneId);
            closeTerminalPane(paneId);
          }}
        />
      </div>

      <TerminalAutocompleteMenu
        ref={autocompleteMenuRef}
        open={
          connectionState === 'connected' &&
          terminalAutoCompleteEnabled &&
          autocompleteItems.length > 0 &&
          autocompleteAnchor !== null
        }
        anchorTop={autocompleteAnchor?.top ?? 0}
        anchorLeft={autocompleteAnchor?.left ?? 0}
        renderAbove={autocompleteAnchor?.renderAbove ?? false}
        items={autocompleteItems}
        onItemSelect={acceptAutocompleteAtIndex}
      />

      {connectionState === 'connected' &&
      terminalSelectionSettings.enabled &&
      selectionAnchor &&
      selectionBarPosition &&
      dismissedSelectionText !== selectionAnchor.selectionText ? (
        <div
          className="pointer-events-none absolute z-40"
          style={{
            top: `${selectionBarPosition.top}px`,
            left: `${selectionBarPosition.left}px`,
          }}
        >
          <TerminalSelectionBar
            ref={selectionBarRef}
            selectedText={selectionAnchor.selectionText}
            dragLabel={t('ssh.selectionBarDrag')}
            copyLabel={t('ssh.selectionBarCopy')}
            insertLabel={t('ssh.selectionBarInsert')}
            openDirectoryLabel={t('ssh.selectionBarOpenDirectory')}
            searchLabel={t('ssh.selectionBarSearch')}
            askAiLabel={t('ssh.selectionBarAskAiLabel')}
            closeLabel={t('ssh.selectionBarClose')}
            onDragStart={handleSelectionBarDragStart}
            onCopy={() => {
              void handleSelectionBarCopy();
            }}
            onInsert={handleSelectionBarInsert}
            onOpenDirectory={handleSelectionOpenDirectory}
            onSearch={handleSelectionBarSearch}
            onAskAi={handleSelectionAskAi}
            onClose={handleSelectionBarClose}
          />
        </div>
      ) : null}

      {connectionState === 'connected' && isTextDropZoneVisible ? (
        <TerminalTextDropZone
          centerX={textDropZoneCenterX ?? 0}
          label={t('ssh.dropTextToTerminal')}
          active={isTextDropZoneActive}
          onDragEnter={handleTextDropZoneDragEnter}
          onDragOver={handleTextDropZoneDragOver}
          onDragLeave={handleTextDropZoneDragLeave}
          onDrop={handleTextDropZoneDrop}
        />
      ) : null}

      <SSHSidebar
        telemetryState={telemetryState}
        onInsertRecentCommand={handleInsertRecentCommand}
        onDeleteRecentCommand={handleDeleteRecentCommand}
      />

      {connectionState !== 'connected' ? (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-between bg-bg px-4 py-12">
          <div></div>
          <div className="text-sm text-header-text">
            {connectionState === 'connecting' ? t('ssh.connecting') : connectionError}
          </div>
          <div
            className={classNames(
              'flex items-center justify-center',
              connectionState === 'connecting' ? 'invisible' : '',
            )}
          >
            <Menubar>
              <Button onClick={handleRetry}>
                <RefreshCw size={16} />
                {t('ssh.retry')}
              </Button>
            </Menubar>
          </div>
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
