import { DEFAULT_TERMINAL_RIGHT_CLICK_ACTION, type TerminalRightClickAction } from '@cosmosh/api-contract';
import {
  ClipboardPaste,
  Copy,
  Eraser,
  FileCode2,
  FolderOpen,
  Globe,
  ScanSearch,
  SplitSquareHorizontal,
  TextSelect,
  X,
} from 'lucide-react';
import React from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../ui/context-menu';

type TerminalContextMenuProps = {
  /** Whether the terminal has an active text selection. Controls enabled state of selection-dependent actions. */
  hasSelection: boolean;
  /** Whether the terminal session is currently connected. Controls enabled state of input actions. */
  isConnected: boolean;
  /** Label for the "Copy" menu item. */
  copyLabel: string;
  /** Optional shortcut hint shown on the "Copy" menu item. */
  copyShortcutLabel?: string;
  /** Label for the "Copy as HTML" menu item. */
  copyAsHtmlLabel: string;
  /** Label for the "Paste" menu item. */
  pasteLabel: string;
  /** Optional shortcut hint shown on the "Paste" menu item. */
  pasteShortcutLabel?: string;
  /** Label for the selection-driven search/open menu item. */
  searchOnlineLabel: string;
  /** Label for the selection-driven SFTP directory handoff menu item. */
  openDirectoryInSftpLabel: string;
  /** Label for the "Find" menu item. */
  findLabel: string;
  /** Optional shortcut hint shown on the "Find" menu item. */
  findShortcutLabel?: string;
  /** Label for the "Select All" menu item. */
  selectAllLabel: string;
  /** Label for the "Clear Terminal" menu item. */
  clearTerminalLabel: string;
  /** Optional shortcut hint shown on the "Clear Terminal" menu item. */
  clearTerminalShortcutLabel?: string;
  /** Label for the "Split Terminal" menu item. */
  splitTerminalLabel?: string;
  /** Label for the "Close Terminal" menu item. */
  closeTerminalLabel?: string;
  /** Whether split action is available for the current pane. */
  canSplitTerminal?: boolean;
  /** Whether close action is available for the current pane. */
  canCloseTerminal?: boolean;
  /** Whether the selected text can be opened as a remote SFTP directory. */
  canOpenDirectoryInSftp?: boolean;
  /** Action executed by terminal right-click gestures. */
  rightClickAction?: TerminalRightClickAction;
  onCopy: () => void;
  onCopyAsHtml: () => void;
  onPaste: () => void;
  onSearchOnline: () => void;
  onOpenDirectoryInSftp: () => void;
  /**
   * Called when "Find" is selected.
   * Parent may defer opening to next macrotask so menu-close focus restore
   * does not steal focus from the search panel input.
   */
  onFind: () => void;
  onSelectAll: () => void;
  onClearTerminal: () => void;
  onSplitTerminal?: () => void;
  onCloseTerminal?: () => void;
  children: React.ReactNode;
};

const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  hasSelection,
  isConnected,
  copyLabel,
  copyShortcutLabel,
  copyAsHtmlLabel,
  pasteLabel,
  pasteShortcutLabel,
  searchOnlineLabel,
  openDirectoryInSftpLabel,
  findLabel,
  findShortcutLabel,
  selectAllLabel,
  clearTerminalLabel,
  clearTerminalShortcutLabel,
  splitTerminalLabel,
  closeTerminalLabel,
  canSplitTerminal = false,
  canCloseTerminal = false,
  canOpenDirectoryInSftp = false,
  rightClickAction = DEFAULT_TERMINAL_RIGHT_CLICK_ACTION,
  onCopy,
  onCopyAsHtml,
  onPaste,
  onSearchOnline,
  onOpenDirectoryInSftp,
  onFind,
  onSelectAll,
  onClearTerminal,
  onSplitTerminal,
  onCloseTerminal,
  children,
}) => {
  const triggerHostRef = React.useRef<HTMLDivElement | null>(null);
  const menuContentRef = React.useRef<HTMLDivElement | null>(null);
  /**
   * Tracks whether menu close should skip focus restoration to trigger host.
   * This is set by the Find action so the terminal does not reclaim focus while
   * the command-palette search input is opening.
   */
  const preventCloseAutoFocusRef = React.useRef<boolean>(false);

  // Track whether the system clipboard contains text. Checked lazily on each
  // menu open to avoid polling. Defaults to true so that the item renders
  // enabled on first paint; the async read corrects it within the same render
  // cycle in practice (before the user can reach the item).
  const [clipboardHasContent, setClipboardHasContent] = React.useState(true);

  const shouldOpenContextMenu = rightClickAction === 'contextMenu';

  const handleOpenChange = React.useCallback(
    (open: boolean): void => {
      if (!shouldOpenContextMenu) {
        return;
      }

      if (!open) {
        return;
      }

      preventCloseAutoFocusRef.current = false;

      void navigator.clipboard
        .readText()
        .then((text) => {
          setClipboardHasContent(text.length > 0);
        })
        .catch(() => {
          // Clipboard permission denied or unavailable — assume content exists
          // rather than falsely disabling the item.
          setClipboardHasContent(true);
        });
    },
    [shouldOpenContextMenu],
  );

  /**
   * Executes configured non-menu right-click behavior before Radix opens.
   *
   * @param event Pointer event from terminal context-menu trigger.
   * @returns Nothing.
   */
  const handleTriggerContextMenu = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (shouldOpenContextMenu) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (rightClickAction === 'copyOnSelectionElsePaste' && hasSelection) {
        onCopy();
        return;
      }

      if (isConnected) {
        onPaste();
      }
    },
    [hasSelection, isConnected, onCopy, onPaste, rightClickAction, shouldOpenContextMenu],
  );

  /**
   * Handles Find selection and marks this menu close cycle to skip trigger
   * auto-focus restoration so focus can remain on search input.
   *
   * @returns Nothing.
   */
  const handleFindSelect = React.useCallback((): void => {
    preventCloseAutoFocusRef.current = true;
    onFind();
  }, [onFind]);

  /**
   * Suppresses Radix trigger auto-focus restoration after Find selection.
   *
   * @param event Focus event emitted during menu close.
   * @returns Nothing.
   */
  const handleCloseAutoFocus = React.useCallback((event: Event): void => {
    if (!preventCloseAutoFocusRef.current) {
      return;
    }

    event.preventDefault();
    preventCloseAutoFocusRef.current = false;
  }, []);

  React.useEffect(() => {
    const isWithinElementBounds = (event: MouseEvent, element: HTMLElement | null): boolean => {
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };

    const handleWindowContextMenu = (event: MouseEvent): void => {
      const inTriggerArea = isWithinElementBounds(event, triggerHostRef.current);
      const inMenuContent = isWithinElementBounds(event, menuContentRef.current);
      if (!inTriggerArea && !inMenuContent) {
        return;
      }

      event.preventDefault();
    };

    window.addEventListener('contextmenu', handleWindowContextMenu);
    return () => {
      window.removeEventListener('contextmenu', handleWindowContextMenu);
    };
  }, []);

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          ref={triggerHostRef}
          className="h-full w-full"
          data-input-context-menu-ignore="true"
          onContextMenu={handleTriggerContextMenu}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        ref={menuContentRef}
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        {/* Copy is only useful when there is an active terminal selection. */}
        <ContextMenuItem
          icon={Copy}
          disabled={!hasSelection}
          onSelect={onCopy}
        >
          {copyLabel}
          {copyShortcutLabel ? <ContextMenuShortcut>{copyShortcutLabel}</ContextMenuShortcut> : null}
        </ContextMenuItem>

        {/* Copy as HTML preserves xterm colors/styles for rich-text paste targets. */}
        <ContextMenuItem
          icon={FileCode2}
          disabled={!hasSelection}
          onSelect={onCopyAsHtml}
        >
          {copyAsHtmlLabel}
        </ContextMenuItem>

        {/* Paste reads from the system clipboard and sends to the terminal input stream. */}
        <ContextMenuItem
          icon={ClipboardPaste}
          disabled={!isConnected || !clipboardHasContent}
          onSelect={onPaste}
        >
          {pasteLabel}
          {pasteShortcutLabel ? <ContextMenuShortcut>{pasteShortcutLabel}</ContextMenuShortcut> : null}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Search/open is selection-dependent; disabled when there is nothing to query. */}
        <ContextMenuItem
          icon={Globe}
          disabled={!hasSelection}
          onSelect={onSearchOnline}
        >
          {searchOnlineLabel}
        </ContextMenuItem>

        <ContextMenuItem
          icon={FolderOpen}
          disabled={!canOpenDirectoryInSftp}
          onSelect={onOpenDirectoryInSftp}
        >
          {openDirectoryInSftpLabel}
        </ContextMenuItem>

        <ContextMenuItem
          icon={ScanSearch}
          onSelect={handleFindSelect}
        >
          {findLabel}
          {findShortcutLabel ? <ContextMenuShortcut>{findShortcutLabel}</ContextMenuShortcut> : null}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          icon={TextSelect}
          disabled={!isConnected}
          onSelect={onSelectAll}
        >
          {selectAllLabel}
        </ContextMenuItem>

        <ContextMenuItem
          icon={Eraser}
          disabled={!isConnected}
          onSelect={onClearTerminal}
        >
          {clearTerminalLabel}
          {clearTerminalShortcutLabel ? <ContextMenuShortcut>{clearTerminalShortcutLabel}</ContextMenuShortcut> : null}
        </ContextMenuItem>

        {splitTerminalLabel && onSplitTerminal ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              icon={SplitSquareHorizontal}
              disabled={!isConnected || !canSplitTerminal}
              onSelect={onSplitTerminal}
            >
              {splitTerminalLabel}
            </ContextMenuItem>
          </>
        ) : null}

        {closeTerminalLabel && onCloseTerminal ? (
          <ContextMenuItem
            icon={X}
            disabled={!isConnected || !canCloseTerminal}
            onSelect={onCloseTerminal}
          >
            {closeTerminalLabel}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
};

export { TerminalContextMenu };
