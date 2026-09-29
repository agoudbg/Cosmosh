import type { ShellHistoryView } from '@cosmosh/api-contract';
import classNames from 'classnames';
import {
  ArrowUpDown,
  Copy,
  Cpu,
  MemoryStick,
  Play,
  Plus,
  Search,
  Send,
  Sparkles,
  SplitSquareHorizontal,
  Terminal,
  X,
} from 'lucide-react';
import React from 'react';

import {
  AlertDialog,
  AlertDialogActionButton,
  AlertDialogCancelButton,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { Input } from '../../components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { t } from '../../lib/i18n';
import type { SshPaneState } from './ssh-pane-state';
import { MAX_TERMINAL_PANES, type SshTelemetryState } from './ssh-types';
import { canInsertHistoryCommand, formatCpuPercent, formatMemoryUsage, formatTrafficRate } from './ssh-utils';

type SSHSidebarProps = {
  telemetryState: SshTelemetryState;
  historyView: ShellHistoryView | null;
  historyRemoval: SshPaneState['historyRemoval'];
  terminalPaneIds: string[];
  activePaneId: string;
  canSplitTerminal: boolean;
  onInsertRecentCommand: (command: string) => void;
  onInsertRecentCommandToPane: (command: string, paneId: string) => void;
  onSplitTerminalAndInsertRecentCommand: (command: string) => void;
  onRunRecentCommand: (command: string) => void;
  onRunRecentCommandToPane: (command: string, paneId: string) => void;
  onSplitTerminalAndRunRecentCommand: (command: string) => void;
  onDeleteRecentCommand: (command: string, sourceId: string | null) => void;
  onCopyRecentCommand: (command: string) => void;
};

/**
 * Renders SSH page telemetry and command quick-access sidebar.
 *
 * The component is intentionally presentational to keep page-level connection
 * orchestration inside `SSH.tsx` and reduce coupling between transport state
 * and sidebar UI composition.
 *
 * @param props Sidebar telemetry and command handlers.
 * @param props.telemetryState Current SSH telemetry snapshot.
 * @param props.historyView Native history view; null only for the local terminal's legacy list.
 * @param props.historyRemoval Latest action bound to the current pane and source.
 * @param props.onCopyRecentCommand Copies the complete unchanged record, including newlines.
 * @param props.terminalPaneIds Ordered terminal pane ids.
 * @param props.activePaneId Current active terminal pane id.
 * @param props.canSplitTerminal Whether a new split terminal can be created.
 * @param props.onInsertRecentCommand Callback used to insert a history command.
 * @param props.onInsertRecentCommandToPane Callback used to insert command into a specific pane.
 * @param props.onSplitTerminalAndInsertRecentCommand Callback used to split and insert command into the new pane.
 * @param props.onRunRecentCommand Callback used to run command in current pane.
 * @param props.onRunRecentCommandToPane Callback used to run command in a specific pane.
 * @param props.onSplitTerminalAndRunRecentCommand Callback used to split and run command in the new pane.
 * @param props.onDeleteRecentCommand Callback used to remove a history command.
 * @returns Sidebar JSX subtree.
 */
export const SSHSidebar: React.FC<SSHSidebarProps> = ({
  telemetryState,
  historyView,
  historyRemoval,
  terminalPaneIds,
  activePaneId,
  canSplitTerminal,
  onInsertRecentCommand,
  onInsertRecentCommandToPane,
  onSplitTerminalAndInsertRecentCommand,
  onRunRecentCommand,
  onRunRecentCommandToPane,
  onSplitTerminalAndRunRecentCommand,
  onDeleteRecentCommand,
  onCopyRecentCommand,
}) => {
  const [removalSelection, setRemovalSelection] = React.useState<{
    command: string;
    sourceId: string;
    paneId: string;
  } | null>(null);
  const sourceId = historyView?.source?.id ?? null;
  const commands = historyView ? historyView.entries : [...telemetryState.recentCommands].reverse();
  const removalPending = historyRemoval?.status === 'pending';
  React.useLayoutEffect(() => {
    setRemovalSelection(null);
  }, [sourceId, activePaneId]);
  /**
   * Explains native removal's shared-history scope before sending an exact source-bound request.
   * @param command Complete selected record. @returns Nothing.
   */
  const requestRemoval = (command: string): void => {
    if (removalPending) return;
    if (sourceId) setRemovalSelection({ command, sourceId, paneId: activePaneId });
    else if (!historyView) onDeleteRecentCommand(command, null);
  };
  const emptyMessage =
    historyView && !historyView.source ? t(`ssh.historyState.${historyView.status}`) : t('ssh.historyCommandsEmpty');
  const sidebarCardStyle = 'bg-ssh-card-bg w-full flex-1 rounded-[18px] p-1';
  const cardHiddenArea =
    'overflow-hidden hof:my-[-38px] hof:py-[42px] hof:z-20 hof:shadow-lg transition-all duration-300 ease-in-out';
  const hiddenHeaderStyle = 'h-[34px] mt-[-38px]';
  const commandButtonStyle =
    '!justify-start overflow-hidden text-ellipsis text-start w-full whitespace-nowrap flex-shrink-0';
  const commandPreviewMaxLength = 200;
  const shouldShowTargetTerminalSubmenu = terminalPaneIds.length > 1;
  const shouldShowSplitAndAdd = canSplitTerminal && terminalPaneIds.length < MAX_TERMINAL_PANES;

  return (
    <div className="flex w-[300px] min-w-[300px] shrink-0 flex-col items-center justify-between gap-2.5 overflow-auto">
      <div
        className={classNames(
          sidebarCardStyle,
          'flex flex-shrink-0 flex-grow-0 items-center justify-between gap-2 px-3 py-2',
        )}
      >
        <div className="flex flex-grow items-center gap-1">
          <Cpu size={14} />
          <span className="text-sm">{formatCpuPercent(telemetryState.cpuUsagePercent)}</span>
        </div>

        <div className="flex flex-grow items-center gap-1">
          <MemoryStick size={14} />
          <span className="text-sm">
            {formatMemoryUsage(telemetryState.memoryUsedBytes, telemetryState.memoryTotalBytes)}
          </span>
        </div>

        <div className="flex flex-grow items-center gap-1">
          <ArrowUpDown size={14} />
          <span className="text-sm">
            {formatTrafficRate(telemetryState.networkTxBytesPerSec)}/
            {formatTrafficRate(telemetryState.networkRxBytesPerSec)}
          </span>
        </div>
      </div>

      <div className={classNames(sidebarCardStyle, cardHiddenArea)}>
        <div className={classNames(hiddenHeaderStyle, 'flex flex-shrink-0 items-center justify-between')}>
          <Button>{t('ssh.historyCommandsTitle')}</Button>
          <div className="flex">
            <Button
              aria-label="Search"
              variant="icon"
            >
              <Search size={16} />
            </Button>
          </div>
        </div>

        {historyView?.source ? (
          <div className="text-muted-text break-words px-2 py-1 text-xs">
            {t('ssh.historySource', { name: historyView.source.namespace })}
          </div>
        ) : null}
        {historyView?.status === 'partial' ? (
          <p className="text-muted-text px-2 py-1 text-xs">{t('ssh.historyPartial')}</p>
        ) : null}
        <div
          data-terminal-history
          className="flex h-[178px] flex-col overflow-auto"
        >
          {commands.length === 0 ? (
            <div
              className="text-muted-text flex h-full items-center justify-center px-2 text-xs"
              role="status"
            >
              {emptyMessage}
            </div>
          ) : (
            <TooltipProvider delayDuration={180}>
              {commands.map((command, index) => {
                const canInsert = canInsertHistoryCommand(command);
                const commandPreview =
                  command.length > commandPreviewMaxLength
                    ? `${command.slice(0, commandPreviewMaxLength)}...`
                    : command;

                return (
                  <ContextMenu key={`${sourceId}-${command}-${index}`}>
                    <ContextMenuTrigger asChild>
                      <div className="group relative">
                        <Tooltip disableHoverableContent>
                          <TooltipTrigger asChild>
                            <Button
                              className={classNames(
                                commandButtonStyle,
                                'aria-disabled:text-muted-text min-w-0 flex-1 aria-disabled:cursor-default',
                              )}
                              aria-disabled={!canInsert}
                              onClick={() => {
                                if (canInsert) onInsertRecentCommand(command);
                              }}
                            >
                              <span className="block w-full truncate pr-8">{commandPreview}</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent
                            interactive={false}
                            className="max-w-[420px] whitespace-pre-wrap break-all"
                          >
                            {canInsert ? commandPreview : t('ssh.historyMultilineHint')}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              aria-label={t('ssh.historyDeleteLabel')}
                              disabled={removalPending}
                              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                requestRemoval(command);
                              }}
                            >
                              <X size={14} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{t('ssh.historyDeleteLabel')}</TooltipContent>
                        </Tooltip>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        icon={Plus}
                        disabled={!canInsert}
                        onSelect={() => onInsertRecentCommand(command)}
                      >
                        {t('ssh.historyAddToCurrentTerminal')}
                      </ContextMenuItem>

                      {shouldShowTargetTerminalSubmenu ? (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger
                            icon={Terminal}
                            disabled={!canInsert}
                          >
                            {t('ssh.historyAddToTerminalMenu')}
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {terminalPaneIds.map((paneId, paneIndex) => (
                              <ContextMenuItem
                                key={paneId}
                                icon={Terminal}
                                disabled={paneId === activePaneId}
                                onSelect={() => onInsertRecentCommandToPane(command, paneId)}
                              >
                                {t('ssh.historyTerminalLabel', { index: paneIndex + 1 })}
                              </ContextMenuItem>
                            ))}
                            {shouldShowSplitAndAdd ? <ContextMenuSeparator /> : null}
                            {shouldShowSplitAndAdd ? (
                              <ContextMenuItem
                                icon={SplitSquareHorizontal}
                                onSelect={() => onSplitTerminalAndInsertRecentCommand(command)}
                              >
                                {t('ssh.historySplitTerminalAndAdd')}
                              </ContextMenuItem>
                            ) : null}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      ) : shouldShowSplitAndAdd ? (
                        <ContextMenuItem
                          icon={SplitSquareHorizontal}
                          disabled={!canInsert}
                          onSelect={() => onSplitTerminalAndInsertRecentCommand(command)}
                        >
                          {t('ssh.historySplitTerminalAndAdd')}
                        </ContextMenuItem>
                      ) : null}

                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={Play}
                        disabled={!canInsert}
                        onSelect={() => onRunRecentCommand(command)}
                      >
                        {t('ssh.historyRunInCurrentTerminal')}
                      </ContextMenuItem>

                      {shouldShowTargetTerminalSubmenu ? (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger
                            icon={Play}
                            disabled={!canInsert}
                          >
                            {t('ssh.historyRunInTerminalMenu')}
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {terminalPaneIds.map((paneId, paneIndex) => (
                              <ContextMenuItem
                                key={paneId}
                                icon={Terminal}
                                disabled={paneId === activePaneId}
                                onSelect={() => onRunRecentCommandToPane(command, paneId)}
                              >
                                {t('ssh.historyTerminalLabel', { index: paneIndex + 1 })}
                              </ContextMenuItem>
                            ))}
                            {shouldShowSplitAndAdd ? <ContextMenuSeparator /> : null}
                            {shouldShowSplitAndAdd ? (
                              <ContextMenuItem
                                icon={SplitSquareHorizontal}
                                onSelect={() => onSplitTerminalAndRunRecentCommand(command)}
                              >
                                {t('ssh.historySplitTerminalAndRun')}
                              </ContextMenuItem>
                            ) : null}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      ) : shouldShowSplitAndAdd ? (
                        <ContextMenuItem
                          icon={SplitSquareHorizontal}
                          disabled={!canInsert}
                          onSelect={() => onSplitTerminalAndRunRecentCommand(command)}
                        >
                          {t('ssh.historySplitTerminalAndRun')}
                        </ContextMenuItem>
                      ) : null}

                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={Copy}
                        onSelect={() => onCopyRecentCommand(command)}
                      >
                        {t('ssh.historyCopyLabel')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={X}
                        disabled={removalPending}
                        onSelect={() => requestRemoval(command)}
                      >
                        {t('ssh.historyDeleteLabel')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </TooltipProvider>
          )}
        </div>
        {historyRemoval ? (
          <p
            role="status"
            className="text-muted-text px-2 py-1 text-xs"
          >
            {t(`ssh.historyRemoval.${historyRemoval.status}`)}
          </p>
        ) : null}
      </div>

      <AlertDialog
        open={
          removalSelection !== null &&
          removalSelection.sourceId === sourceId &&
          removalSelection.paneId === activePaneId
        }
        onOpenChange={(open) => {
          if (!open) setRemovalSelection(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ssh.historyRemovalTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ssh.historyRemovalDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancelButton>{t('ssh.historyRemovalCancel')}</AlertDialogCancelButton>
            <AlertDialogActionButton
              onClick={() => {
                if (
                  removalSelection?.sourceId === sourceId &&
                  removalSelection?.paneId === activePaneId &&
                  !removalPending
                )
                  onDeleteRecentCommand(removalSelection.command, removalSelection.sourceId);
              }}
            >
              {t('ssh.historyRemovalConfirm')}
            </AlertDialogActionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className={sidebarCardStyle}>
        <span>1</span>
      </div>

      <div className={classNames(sidebarCardStyle, 'flex-grow-0')}>
        <div className="flex h-full w-full items-center justify-center">
          <Button
            variant="icon"
            aria-label="Ask AI"
          >
            <Sparkles size={16} />
          </Button>
          <Input placeholder="Ask AI Anything..." />
          <Button
            variant="icon"
            aria-label="Send"
          >
            <Send size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
};
