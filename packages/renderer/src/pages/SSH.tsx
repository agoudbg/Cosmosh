import '@xterm/xterm/css/xterm.css';

import { type ITerminalOptions } from '@xterm/xterm';
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
import { INTERNAL_TERMINAL_TEXT_DRAG_MIME, type TerminalSelectionSettings } from './ssh/ssh-types';
import { parseOptionalNumberSetting, resolveSearchUrl, resolveTerminalFontWeightSetting } from './ssh/ssh-utils';
import { SSHSidebar } from './ssh/SSHSidebar';
import { SSHTerminalPaneLayout } from './ssh/SSHTerminalPaneLayout';
import { useSshCore } from './ssh/use-ssh-core';

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

  const sshCore = useSshCore({
    terminalInitOptions,
    sshConnectionTimeoutSec,
    terminalAutoCompleteEnabled,
    terminalAutoCompleteMinChars,
    terminalAutoCompleteMaxItems,
    terminalAutoCompleteFuzzyMatch,
    terminalSelectionBarEnabled: terminalSelectionSettings.enabled,
    onTabTitleChange,
    notifyWarning,
  });

  const {
    state: {
      terminalPaneIds,
      activePaneId,
      connectionState,
      connectionError,
      telemetryState,
      hostFingerprintPrompt,
      canSplitTerminal,
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
      retryConnection,
      sendInput,
      deleteHistoryCommand,
      selectAll,
      getSelectionText,
      focusActiveTerminal,
      clearTerminalScreen,
      setPaneContainerElement,
      setPrimaryPaneContainer,
      resolveHostFingerprintPrompt,
      dismissSelectionBar,
      acceptAutocompleteAtIndex,
    },
    refs: { wrapperRef, terminalContainerRef, selectionBarRef, autocompleteMenuRef },
  } = sshCore;
  const terminalPaneIdsRef = React.useRef<string[]>(terminalPaneIds);

  React.useEffect(() => {
    terminalPaneIdsRef.current = terminalPaneIds;
  }, [terminalPaneIds]);

  /**
   * Suspends for one short async interval used by pane/socket polling loops.
   *
   * @param milliseconds Delay duration in milliseconds.
   * @returns Promise resolved after the requested delay.
   */
  const delay = React.useCallback((milliseconds: number): Promise<void> => {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }, []);

  /**
   * Waits until split-pane state includes the newly created pane id.
   *
   * @param expectedPaneCount Pane count expected after split.
   * @returns Newest pane id when available, otherwise `null` on timeout.
   */
  const waitForNewestPaneId = React.useCallback(
    async (expectedPaneCount: number): Promise<string | null> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const currentPaneIds = terminalPaneIdsRef.current;
        if (currentPaneIds.length >= expectedPaneCount) {
          return currentPaneIds[currentPaneIds.length - 1] ?? null;
        }

        await delay(50);
      }

      return null;
    },
    [delay],
  );

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

    sendInput(selectionAnchor.selectionText);
    focusActiveTerminal();
  }, [focusActiveTerminal, selectionAnchor, sendInput]);

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
    const selectionText = getSelectionText();
    if (!selectionText) {
      return;
    }

    void copyTextToClipboard(selectionText);
  }, [copyTextToClipboard, getSelectionText]);

  const handleContextMenuPaste = React.useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          sendInput(text);
          focusActiveTerminal();
        }
      })
      .catch(() => {
        // Clipboard read permission denied or unavailable; silently ignore.
      });
  }, [focusActiveTerminal, sendInput]);

  const handleContextMenuSearchOnline = React.useCallback(() => {
    const selectionText = getSelectionText();
    if (!selectionText.trim()) {
      return;
    }

    openSearchForText(selectionText);
  }, [getSelectionText, openSearchForText]);

  const handleContextMenuFind = React.useCallback(() => {
    notifyWarning(t('ssh.contextMenuFindComingSoon'));
  }, [notifyWarning]);

  const handleContextMenuSelectAll = React.useCallback(() => {
    selectAll();
  }, [selectAll]);

  const handleContextMenuClearTerminal = React.useCallback(() => {
    clearTerminalScreen();
    focusActiveTerminal();
  }, [clearTerminalScreen, focusActiveTerminal]);

  const handleDeleteRecentCommand = React.useCallback(
    (command: string) => {
      deleteHistoryCommand(command);
    },
    [deleteHistoryCommand],
  );

  /**
   * Converts sidebar command actions into terminal input payloads.
   *
   * @param command Raw command text selected from history.
   * @param shouldRun Whether command should auto-submit with Enter.
   * @returns Input payload written to terminal websocket.
   */
  const buildRecentCommandPayload = React.useCallback((command: string, shouldRun: boolean): string => {
    return shouldRun ? `${command}\r` : command;
  }, []);

  /**
   * Sends a history command to one pane and focuses that pane terminal.
   *
   * @param command Command text selected in history panel.
   * @param paneId Target pane id.
   * @param shouldRun Whether command should auto-submit with Enter.
   * @returns `true` when command payload is sent to an open socket.
   */
  const dispatchRecentCommandToPane = React.useCallback(
    (command: string, paneId: string, shouldRun: boolean): boolean => {
      activatePane(paneId);
      const didSend = sendInput(buildRecentCommandPayload(command, shouldRun));
      focusActiveTerminal();
      return didSend;
    },
    [activatePane, buildRecentCommandPayload, focusActiveTerminal, sendInput],
  );

  /**
   * Splits one pane and retries command dispatch to the new pane until ready.
   *
   * @param command Command text selected in history panel.
   * @param shouldRun Whether command should auto-submit with Enter.
   * @returns Nothing.
   */
  const splitTerminalAndDispatchRecentCommand = React.useCallback(
    (command: string, shouldRun: boolean): void => {
      if (!canSplitTerminal) {
        return;
      }

      const expectedPaneCount = terminalPaneIdsRef.current.length + 1;
      splitPane();

      void (async () => {
        const newestPaneId = await waitForNewestPaneId(expectedPaneCount);
        if (!newestPaneId) {
          notifyWarning(t(shouldRun ? 'ssh.historySplitTerminalAndRunFailed' : 'ssh.historySplitTerminalAndAddFailed'));
          return;
        }

        for (let attempt = 0; attempt < 30; attempt += 1) {
          const didSend = dispatchRecentCommandToPane(command, newestPaneId, shouldRun);
          if (didSend) {
            return;
          }

          await delay(75);
        }

        notifyWarning(t(shouldRun ? 'ssh.historySplitTerminalAndRunFailed' : 'ssh.historySplitTerminalAndAddFailed'));
      })();
    },
    [canSplitTerminal, delay, dispatchRecentCommandToPane, notifyWarning, splitPane, waitForNewestPaneId],
  );

  const handleInsertRecentCommand = React.useCallback(
    (command: string) => {
      dispatchRecentCommandToPane(command, activePaneId, false);
    },
    [activePaneId, dispatchRecentCommandToPane],
  );

  const handleInsertRecentCommandToPane = React.useCallback(
    (command: string, paneId: string) => {
      dispatchRecentCommandToPane(command, paneId, false);
    },
    [dispatchRecentCommandToPane],
  );

  const handleRunRecentCommand = React.useCallback(
    (command: string) => {
      dispatchRecentCommandToPane(command, activePaneId, true);
    },
    [activePaneId, dispatchRecentCommandToPane],
  );

  const handleRunRecentCommandToPane = React.useCallback(
    (command: string, paneId: string) => {
      dispatchRecentCommandToPane(command, paneId, true);
    },
    [dispatchRecentCommandToPane],
  );

  const handleSplitTerminalAndInsertRecentCommand = React.useCallback(
    (command: string) => {
      splitTerminalAndDispatchRecentCommand(command, false);
    },
    [splitTerminalAndDispatchRecentCommand],
  );

  const handleSplitTerminalAndRunRecentCommand = React.useCallback(
    (command: string) => {
      splitTerminalAndDispatchRecentCommand(command, true);
    },
    [splitTerminalAndDispatchRecentCommand],
  );

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

  const handleTerminalTextDrop = React.useCallback(
    (droppedText: string) => {
      sendInput(droppedText);
      focusActiveTerminal();
    },
    [focusActiveTerminal, sendInput],
  );

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

  // Card style
  const cardStyle = 'bg-ssh-card-bg-terminal h-full w-full flex-1 overflow-hidden rounded-[18px] p-1';

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
          activePaneId={activePaneId}
          hasSelection={!!selectionAnchor?.selectionText}
          isConnected={connectionState === 'connected'}
          canSplitTerminal={canSplitTerminal}
          setPaneContainerElement={setPaneContainerElement}
          setPrimaryPaneContainer={setPrimaryPaneContainer}
          onPaneActivate={activatePane}
          onCopy={(paneId) => {
            activatePane(paneId);
            handleContextMenuCopy();
          }}
          onPaste={(paneId) => {
            activatePane(paneId);
            handleContextMenuPaste();
          }}
          onSearchOnline={(paneId) => {
            activatePane(paneId);
            handleContextMenuSearchOnline();
          }}
          onFind={(paneId) => {
            activatePane(paneId);
            handleContextMenuFind();
          }}
          onSelectAll={(paneId) => {
            activatePane(paneId);
            handleContextMenuSelectAll();
          }}
          onClearTerminal={(paneId) => {
            activatePane(paneId);
            handleContextMenuClearTerminal();
          }}
          onSplitPane={(paneId) => {
            activatePane(paneId);
            splitPane();
          }}
          onClosePane={(paneId) => {
            activatePane(paneId);
            closePane(paneId);
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
        terminalPaneIds={terminalPaneIds}
        activePaneId={activePaneId}
        canSplitTerminal={canSplitTerminal}
        onInsertRecentCommand={handleInsertRecentCommand}
        onInsertRecentCommandToPane={handleInsertRecentCommandToPane}
        onSplitTerminalAndInsertRecentCommand={handleSplitTerminalAndInsertRecentCommand}
        onRunRecentCommand={handleRunRecentCommand}
        onRunRecentCommandToPane={handleRunRecentCommandToPane}
        onSplitTerminalAndRunRecentCommand={handleSplitTerminalAndRunRecentCommand}
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
              <Button onClick={retryConnection}>
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
