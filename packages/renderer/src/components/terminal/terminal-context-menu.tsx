import { ClipboardPaste, Copy, Eraser, Globe, ScanSearch, TextSelect } from 'lucide-react';
import React from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';

type TerminalContextMenuProps = {
  /** Whether the terminal has an active text selection. Controls enabled state of selection-dependent actions. */
  hasSelection: boolean;
  /** Whether the terminal session is currently connected. Controls enabled state of input actions. */
  isConnected: boolean;
  /** Label for the "Copy" menu item. */
  copyLabel: string;
  /** Label for the "Paste" menu item. */
  pasteLabel: string;
  /** Label for the "Search Online" menu item. */
  searchOnlineLabel: string;
  /** Label for the "Find" menu item. */
  findLabel: string;
  /** Label for the "Select All" menu item. */
  selectAllLabel: string;
  /** Label for the "Clear Terminal" menu item. */
  clearTerminalLabel: string;
  onCopy: () => void;
  onPaste: () => void;
  onSearchOnline: () => void;
  /** Called when "Find" is selected. Expected to be a no-op or coming-soon handler until the feature is implemented. */
  onFind: () => void;
  onSelectAll: () => void;
  onClearTerminal: () => void;
  children: React.ReactNode;
};

const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  hasSelection,
  isConnected,
  copyLabel,
  pasteLabel,
  searchOnlineLabel,
  findLabel,
  selectAllLabel,
  clearTerminalLabel,
  onCopy,
  onPaste,
  onSearchOnline,
  onFind,
  onSelectAll,
  onClearTerminal,
  children,
}) => {
  const triggerHostRef = React.useRef<HTMLDivElement | null>(null);
  const menuContentRef = React.useRef<HTMLDivElement | null>(null);

  // Track whether the system clipboard contains text. Checked lazily on each
  // menu open to avoid polling. Defaults to true so that the item renders
  // enabled on first paint; the async read corrects it within the same render
  // cycle in practice (before the user can reach the item).
  const [clipboardHasContent, setClipboardHasContent] = React.useState(true);

  const handleOpenChange = React.useCallback((open: boolean): void => {
    if (!open) {
      return;
    }

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
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent ref={menuContentRef}>
        {/* Copy is only useful when there is an active terminal selection. */}
        <ContextMenuItem
          icon={Copy}
          disabled={!hasSelection}
          onSelect={onCopy}
        >
          {copyLabel}
        </ContextMenuItem>

        {/* Paste reads from the system clipboard and sends to the terminal input stream. */}
        <ContextMenuItem
          icon={ClipboardPaste}
          disabled={!isConnected || !clipboardHasContent}
          onSelect={onPaste}
        >
          {pasteLabel}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Search online is selection-dependent; disabled when there is nothing to query. */}
        <ContextMenuItem
          icon={Globe}
          disabled={!hasSelection}
          onSelect={onSearchOnline}
        >
          {searchOnlineLabel}
        </ContextMenuItem>

        {/* Find is not yet implemented; disabled to signal coming-soon state. */}
        <ContextMenuItem
          icon={ScanSearch}
          disabled={true}
          onSelect={onFind}
        >
          {findLabel}
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
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export { TerminalContextMenu };
