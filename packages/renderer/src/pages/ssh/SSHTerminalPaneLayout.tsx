import type { AgentTerminalAttachmentStatus, TerminalRightClickAction } from '@cosmosh/api-contract';
import classNames from 'classnames';
import { Bot, RefreshCw, Square, Unplug } from 'lucide-react';
import React from 'react';

import { TerminalContextMenu } from '../../components/terminal/terminal-context-menu';
import { Button } from '../../components/ui/button';
import { Menubar } from '../../components/ui/menubar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { t } from '../../lib/i18n';
import type { SshPaneConnectionSnapshot, TerminalCommandTimelineModel } from './ssh-types';
import { TerminalCommandTimeline } from './TerminalCommandTimeline';

type PaneActionHandler = (paneId: string) => void;
type PaneCommandActionHandler = (paneId: string, command: string) => void;
type PaneCommandSelectionHandler = (paneId: string, commandId: string) => void;
type AgentConnectionActionHandler = (connectionId: string) => void;

type SSHTerminalPaneLayoutProps = {
  terminalPaneIds: string[];
  activePaneId: string;
  hasSelection: boolean;
  canSplitTerminal: boolean;
  copyShortcutLabel: string;
  pasteShortcutLabel: string;
  searchOnlineLabel: string;
  openDirectoryInSftpLabel: string;
  findShortcutLabel: string;
  clearTerminalShortcutLabel: string;
  rightClickAction: TerminalRightClickAction;
  remoteEnhancementsDebugLabel?: string;
  canOpenDirectoryInSftp: boolean;
  commandTimelineModels: Record<string, TerminalCommandTimelineModel>;
  paneConnectionStates: Record<string, SshPaneConnectionSnapshot>;
  agentAttachmentStatuses: Record<string, AgentTerminalAttachmentStatus | null>;
  setPaneContainerElement: (paneId: string, element: HTMLDivElement | null) => void;
  setPrimaryPaneContainer: (element: HTMLDivElement | null) => void;
  onPaneActivate: PaneActionHandler;
  onRetryPane: PaneActionHandler;
  onCopy: PaneActionHandler;
  onCopyAsHtml: PaneActionHandler;
  onPaste: PaneActionHandler;
  onSearchOnline: PaneActionHandler;
  onOpenDirectoryInSftp: PaneActionHandler;
  onFind: PaneActionHandler;
  onSelectAll: PaneActionHandler;
  onClearTerminal: PaneActionHandler;
  onCopyCommand: PaneCommandActionHandler;
  onFocusPane: PaneActionHandler;
  onInsertCommand: PaneCommandActionHandler;
  onSelectCommand: PaneCommandSelectionHandler;
  onSplitPane: PaneActionHandler;
  onClosePane: PaneActionHandler;
  onToggleRemoteEnhancementsDebug?: PaneActionHandler;
  onStopAgentCommand: AgentConnectionActionHandler;
  onDetachAgent: AgentConnectionActionHandler;
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
 * @param props.canSplitTerminal Whether split action is currently allowed.
 * @param props.copyShortcutLabel Platform-resolved copy shortcut label.
 * @param props.pasteShortcutLabel Platform-resolved paste shortcut label.
 * @param props.searchOnlineLabel Label for selection-based search/open action.
 * @param props.openDirectoryInSftpLabel Label for selection-based SFTP directory handoff action.
 * @param props.findShortcutLabel Platform-resolved find shortcut label.
 * @param props.clearTerminalShortcutLabel Platform-resolved clear-screen shortcut label.
 * @param props.rightClickAction Configured action for terminal right-click gestures.
 * @param props.remoteEnhancementsDebugLabel Optional label for the Remote Enhancements debug panel action.
 * @param props.canOpenDirectoryInSftp Whether selected text can open an SFTP directory.
 * @param props.commandTimelineModels Pane-indexed trusted command timeline models.
 * @param props.paneConnectionStates Pane-indexed transport snapshots driving pane-scoped overlays.
 * @param props.agentAttachmentStatuses Pane-indexed Agent ownership snapshots.
 * @param props.setPaneContainerElement Ref callback for pane containers.
 * @param props.setPrimaryPaneContainer Ref callback for primary pane container.
 * @param props.onPaneActivate Callback that activates a pane.
 * @param props.onRetryPane Callback that reconnects one failed pane.
 * @param props.onCopy Callback that copies selection from pane.
 * @param props.onCopyAsHtml Callback that copies selection HTML from pane.
 * @param props.onPaste Callback that pastes text into pane.
 * @param props.onSearchOnline Callback that searches selected text.
 * @param props.onOpenDirectoryInSftp Callback that opens selected directory text in SFTP.
 * @param props.onFind Callback for find action.
 * @param props.onSelectAll Callback for select-all action.
 * @param props.onClearTerminal Callback for clear-screen action.
 * @param props.onCopyCommand Callback for copying one retained command.
 * @param props.onFocusPane Callback for restoring focus to one pane's xterm.
 * @param props.onInsertCommand Callback for inserting one retained command without submitting it.
 * @param props.onSelectCommand Callback for direct command-marker selection.
 * @param props.onSplitPane Callback for split action.
 * @param props.onClosePane Callback for close-pane action.
 * @param props.onToggleRemoteEnhancementsDebug Optional callback for the Remote Enhancements debug panel toggle.
 * @param props.onStopAgentCommand Callback that sends Ctrl+C to the Agent command.
 * @param props.onDetachAgent Callback that revokes Agent access without closing the terminal.
 * @returns Pane layout JSX subtree.
 */
export const SSHTerminalPaneLayout: React.FC<SSHTerminalPaneLayoutProps> = ({
  terminalPaneIds,
  activePaneId,
  hasSelection,
  canSplitTerminal,
  copyShortcutLabel,
  pasteShortcutLabel,
  searchOnlineLabel,
  openDirectoryInSftpLabel,
  findShortcutLabel,
  clearTerminalShortcutLabel,
  rightClickAction,
  remoteEnhancementsDebugLabel,
  canOpenDirectoryInSftp,
  commandTimelineModels,
  paneConnectionStates,
  agentAttachmentStatuses,
  setPaneContainerElement,
  setPrimaryPaneContainer,
  onPaneActivate,
  onRetryPane,
  onCopy,
  onCopyAsHtml,
  onPaste,
  onSearchOnline,
  onOpenDirectoryInSftp,
  onFind,
  onSelectAll,
  onClearTerminal,
  onCopyCommand,
  onFocusPane,
  onInsertCommand,
  onSelectCommand,
  onSplitPane,
  onClosePane,
  onToggleRemoteEnhancementsDebug,
  onStopAgentCommand,
  onDetachAgent,
}) => {
  const renderTerminalPane = (paneId: string, isPrimaryPane: boolean): React.ReactNode => {
    const commandTimelineModel = commandTimelineModels[paneId];
    const paneConnection: SshPaneConnectionSnapshot = paneConnectionStates[paneId] ?? {
      connectionState: 'connecting',
      connectionError: '',
    };
    const paneIsConnected = paneConnection.connectionState === 'connected';
    const agentStatus = agentAttachmentStatuses[paneId];
    const agentAttached = agentStatus?.state === 'idle' || agentStatus?.state === 'running';
    return (
      <div className="relative h-full min-h-0 w-full min-w-0 overflow-hidden">
        <TerminalContextMenu
          hasSelection={activePaneId === paneId && hasSelection}
          isConnected={paneIsConnected}
          copyLabel={t('ssh.contextMenuCopy')}
          copyShortcutLabel={copyShortcutLabel}
          copyAsHtmlLabel={t('ssh.contextMenuCopyAsHtml')}
          pasteLabel={t('ssh.contextMenuPaste')}
          pasteShortcutLabel={pasteShortcutLabel}
          searchOnlineLabel={searchOnlineLabel}
          openDirectoryInSftpLabel={openDirectoryInSftpLabel}
          findLabel={t('ssh.contextMenuFind')}
          findShortcutLabel={findShortcutLabel}
          selectAllLabel={t('ssh.contextMenuSelectAll')}
          clearTerminalLabel={t('ssh.contextMenuClearTerminal')}
          clearTerminalShortcutLabel={clearTerminalShortcutLabel}
          splitTerminalLabel={t('ssh.contextMenuSplitTerminal')}
          closeTerminalLabel={t('ssh.contextMenuCloseTerminal')}
          remoteEnhancementsDebugLabel={remoteEnhancementsDebugLabel}
          canSplitTerminal={canSplitTerminal}
          canCloseTerminal={terminalPaneIds.length > 1}
          canOpenDirectoryInSftp={activePaneId === paneId && canOpenDirectoryInSftp}
          rightClickAction={rightClickAction}
          onCopy={() => onCopy(paneId)}
          onCopyAsHtml={() => onCopyAsHtml(paneId)}
          onPaste={() => onPaste(paneId)}
          onSearchOnline={() => onSearchOnline(paneId)}
          onOpenDirectoryInSftp={() => onOpenDirectoryInSftp(paneId)}
          onFind={() => onFind(paneId)}
          onSelectAll={() => onSelectAll(paneId)}
          onClearTerminal={() => onClearTerminal(paneId)}
          onSplitTerminal={() => onSplitPane(paneId)}
          onCloseTerminal={() => onClosePane(paneId)}
          onToggleRemoteEnhancementsDebug={
            onToggleRemoteEnhancementsDebug ? () => onToggleRemoteEnhancementsDebug(paneId) : undefined
          }
        >
          <TerminalCommandTimeline
            model={commandTimelineModel}
            isConnected={paneIsConnected}
            onActivate={() => onPaneActivate(paneId)}
            onCopyCommand={(command) => onCopyCommand(paneId, command)}
            onFocusTerminal={() => onFocusPane(paneId)}
            onInsertCommand={(command) => onInsertCommand(paneId, command)}
            onSelectCommand={(commandId) => onSelectCommand(paneId, commandId)}
          >
            <div
              ref={(element) => {
                setPaneContainerElement(paneId, element);
                if (isPrimaryPane) {
                  setPrimaryPaneContainer(element);
                }
              }}
              className={classNames('h-full min-w-0 flex-1 pb-2 pl-2', agentAttached ? 'pt-10' : 'pt-2')}
            />
          </TerminalCommandTimeline>
        </TerminalContextMenu>
        {agentAttached && agentStatus.connectionId ? (
          <TooltipProvider delayDuration={160}>
            <div className="absolute left-0 right-0 top-0 z-20 flex h-8 min-w-0 items-center gap-2 border-b border-ssh-terminal-split-divider bg-bg-subtle px-2 text-xs text-header-text">
              <Bot
                aria-hidden="true"
                className="h-4 w-4 shrink-0"
              />
              <span className="min-w-0 shrink truncate font-medium">
                {agentStatus.client?.name ?? t('ssh.agentTerminal.unknownAgent')}
              </span>
              <span className="shrink-0 text-header-text-muted">
                {agentStatus.state === 'running' ? t('ssh.agentTerminal.running') : t('ssh.agentTerminal.idle')}
              </span>
              <span className="min-w-0 flex-1 truncate text-header-text-muted">
                {t('ssh.agentTerminal.outputShared')}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-header-text-muted hover:bg-header-tab-hover hover:text-header-text disabled:pointer-events-none disabled:opacity-40"
                    aria-label={t('ssh.agentTerminal.stop')}
                    disabled={agentStatus.state !== 'running'}
                    onClick={() => onStopAgentCommand(agentStatus.connectionId!)}
                  >
                    <Square
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('ssh.agentTerminal.stop')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-header-text-muted hover:bg-header-tab-hover hover:text-header-text"
                    aria-label={t('ssh.agentTerminal.detach')}
                    onClick={() => onDetachAgent(agentStatus.connectionId!)}
                  >
                    <Unplug
                      aria-hidden="true"
                      className="h-4 w-4"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('ssh.agentTerminal.detach')}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        ) : null}
        {!paneIsConnected ? (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-ssh-card-bg-terminal px-4">
            <div className="text-center text-sm text-header-text">
              {paneConnection.connectionState === 'connecting' ? t('ssh.connecting') : paneConnection.connectionError}
            </div>
            {paneConnection.connectionState === 'failed' ? (
              <Menubar>
                <Button onClick={() => onRetryPane(paneId)}>
                  <RefreshCw size={16} />
                  {t('ssh.retry')}
                </Button>
                {terminalPaneIds.length > 1 ? (
                  <Button onClick={() => onClosePane(paneId)}>{t('ssh.contextMenuCloseTerminal')}</Button>
                ) : null}
              </Menubar>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const paneCount = terminalPaneIds.length;
  const gridClassName =
    paneCount === 1
      ? 'grid-cols-1'
      : paneCount === 2
        ? 'grid-cols-2'
        : paneCount === 3
          ? 'grid-cols-3'
          : 'grid-cols-3 grid-rows-2';

  /**
   * Resolves stable grid placement without changing pane DOM ancestry.
   *
   * @param index Pane index in the fixed split progression.
   * @returns Tokenized divider and grid placement classes.
   */
  const resolvePaneClassName = (index: number): string => {
    if (paneCount < 4) {
      return classNames('min-h-0 min-w-0', index > 0 && 'border-l border-ssh-terminal-split-divider');
    }

    if (index === 0) {
      return 'row-span-2 min-h-0 min-w-0';
    }

    if (index === 1) {
      return 'row-span-2 min-h-0 min-w-0 border-l border-ssh-terminal-split-divider';
    }

    if (index === 2) {
      return 'col-start-3 row-start-1 min-h-0 min-w-0 border-l border-ssh-terminal-split-divider';
    }

    return 'col-start-3 row-start-2 min-h-0 min-w-0 border-l border-t border-ssh-terminal-split-divider';
  };

  return (
    <div className={classNames('grid h-full min-h-0 w-full min-w-0', gridClassName)}>
      {terminalPaneIds.map((paneId, index) => (
        <div
          key={paneId}
          className={resolvePaneClassName(index)}
        >
          {renderTerminalPane(paneId, index === 0)}
        </div>
      ))}
    </div>
  );
};
