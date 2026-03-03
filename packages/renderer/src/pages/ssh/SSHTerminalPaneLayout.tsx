import classNames from 'classnames';
import React from 'react';

import { TerminalContextMenu } from '../../components/terminal/terminal-context-menu';
import { t } from '../../lib/i18n';

type PaneActionHandler = (paneId: string) => void;

type SSHTerminalPaneLayoutProps = {
  terminalPaneIds: string[];
  activePaneId: string;
  hasSelection: boolean;
  isConnected: boolean;
  canSplitTerminal: boolean;
  setPaneContainerElement: (paneId: string, element: HTMLDivElement | null) => void;
  setPrimaryPaneContainer: (element: HTMLDivElement | null) => void;
  onPaneActivate: PaneActionHandler;
  onCopy: PaneActionHandler;
  onPaste: PaneActionHandler;
  onSearchOnline: PaneActionHandler;
  onFind: PaneActionHandler;
  onSelectAll: PaneActionHandler;
  onClearTerminal: PaneActionHandler;
  onSplitPane: PaneActionHandler;
  onClosePane: PaneActionHandler;
};

/**
 * Renders split-pane terminal grid and per-pane context menus.
 *
 * This component is stateless and delegates all side-effects to page-level
 * callbacks to keep terminal runtime ownership centralized in `SSH.tsx`.
 *
 * @param props Pane structure and pane action callbacks.
 * @param props.terminalPaneIds Ordered pane ids.
 * @param props.activePaneId Current active pane id.
 * @param props.hasSelection Whether active pane has selected text.
 * @param props.isConnected Whether terminal transport is connected.
 * @param props.canSplitTerminal Whether split action is currently allowed.
 * @param props.setPaneContainerElement Ref callback for pane containers.
 * @param props.setPrimaryPaneContainer Ref callback for primary pane container.
 * @param props.onPaneActivate Callback that activates a pane.
 * @param props.onCopy Callback that copies selection from pane.
 * @param props.onPaste Callback that pastes text into pane.
 * @param props.onSearchOnline Callback that searches selected text.
 * @param props.onFind Callback for find action.
 * @param props.onSelectAll Callback for select-all action.
 * @param props.onClearTerminal Callback for clear-screen action.
 * @param props.onSplitPane Callback for split action.
 * @param props.onClosePane Callback for close-pane action.
 * @returns Pane layout JSX subtree.
 */
export const SSHTerminalPaneLayout: React.FC<SSHTerminalPaneLayoutProps> = ({
  terminalPaneIds,
  activePaneId,
  hasSelection,
  isConnected,
  canSplitTerminal,
  setPaneContainerElement,
  setPrimaryPaneContainer,
  onPaneActivate,
  onCopy,
  onPaste,
  onSearchOnline,
  onFind,
  onSelectAll,
  onClearTerminal,
  onSplitPane,
  onClosePane,
}) => {
  const renderTerminalPane = (paneId: string, isPrimaryPane: boolean): React.ReactNode => {
    return (
      <div className="h-full min-h-0 w-full min-w-0 overflow-hidden">
        <TerminalContextMenu
          hasSelection={activePaneId === paneId && hasSelection}
          isConnected={isConnected}
          copyLabel={t('ssh.contextMenuCopy')}
          pasteLabel={t('ssh.contextMenuPaste')}
          searchOnlineLabel={t('ssh.contextMenuSearchOnline')}
          findLabel={t('ssh.contextMenuFind')}
          selectAllLabel={t('ssh.contextMenuSelectAll')}
          clearTerminalLabel={t('ssh.contextMenuClearTerminal')}
          splitTerminalLabel={t('ssh.contextMenuSplitTerminal')}
          closeTerminalLabel={t('ssh.contextMenuCloseTerminal')}
          canSplitTerminal={canSplitTerminal}
          canCloseTerminal={terminalPaneIds.length > 1}
          onCopy={() => onCopy(paneId)}
          onPaste={() => onPaste(paneId)}
          onSearchOnline={() => onSearchOnline(paneId)}
          onFind={() => onFind(paneId)}
          onSelectAll={() => onSelectAll(paneId)}
          onClearTerminal={() => onClearTerminal(paneId)}
          onSplitTerminal={() => onSplitPane(paneId)}
          onCloseTerminal={() => onClosePane(paneId)}
        >
          <div
            ref={(element) => {
              setPaneContainerElement(paneId, element);
              if (isPrimaryPane) {
                setPrimaryPaneContainer(element);
              }
            }}
            className="h-full w-full p-2"
            onMouseDown={() => onPaneActivate(paneId)}
            onContextMenu={() => onPaneActivate(paneId)}
          />
        </TerminalContextMenu>
      </div>
    );
  };

  const paneCount = terminalPaneIds.length;
  const pane1Id = terminalPaneIds[0] ?? 'pane-1';
  const pane2Id = terminalPaneIds[1] ?? 'pane-2';
  const pane3Id = terminalPaneIds[2] ?? 'pane-3';
  const pane4Id = terminalPaneIds[3] ?? 'pane-4';

  if (paneCount <= 2) {
    return (
      <div className="grid h-full min-h-0 w-full min-w-0 grid-cols-2">
        <div className={classNames('min-h-0', paneCount === 1 ? 'col-span-2' : '')}>
          {renderTerminalPane(pane1Id, true)}
        </div>
        <div
          className={classNames('min-h-0 border-l border-ssh-terminal-split-divider', paneCount < 2 ? 'hidden' : '')}
        >
          {paneCount >= 2 ? renderTerminalPane(pane2Id, false) : null}
        </div>
      </div>
    );
  }

  if (paneCount === 3) {
    return (
      <div className="grid h-full min-h-0 w-full min-w-0 grid-cols-3">
        <div className="min-h-0">{renderTerminalPane(pane1Id, true)}</div>
        <div className="min-h-0 border-l border-ssh-terminal-split-divider">{renderTerminalPane(pane2Id, false)}</div>
        <div className="min-h-0 border-l border-ssh-terminal-split-divider">{renderTerminalPane(pane3Id, false)}</div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 w-full min-w-0 grid-cols-[1fr_1fr_1fr]">
      <div className="min-h-0">{renderTerminalPane(pane1Id, true)}</div>
      <div className="min-h-0 border-l border-ssh-terminal-split-divider">{renderTerminalPane(pane2Id, false)}</div>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col border-l border-ssh-terminal-split-divider">
        <div className="min-h-0 flex-1">{renderTerminalPane(pane3Id, false)}</div>
        <div className="min-h-0 flex-1 border-t border-ssh-terminal-split-divider">
          {renderTerminalPane(pane4Id, false)}
        </div>
      </div>
    </div>
  );
};
