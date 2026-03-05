import classNames from 'classnames';
import {
  ArrowUpDown,
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
import { MAX_TERMINAL_PANES, type SshTelemetryState } from './ssh-types';
import { formatCpuPercent, formatMemoryUsage, formatTrafficRate } from './ssh-utils';

type SSHSidebarProps = {
  telemetryState: SshTelemetryState;
  terminalPaneIds: string[];
  activePaneId: string;
  canSplitTerminal: boolean;
  onInsertRecentCommand: (command: string) => void;
  onInsertRecentCommandToPane: (command: string, paneId: string) => void;
  onSplitTerminalAndInsertRecentCommand: (command: string) => void;
  onRunRecentCommand: (command: string) => void;
  onRunRecentCommandToPane: (command: string, paneId: string) => void;
  onSplitTerminalAndRunRecentCommand: (command: string) => void;
  onDeleteRecentCommand: (command: string) => void;
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
}) => {
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

        <div className="flex h-[178px] flex-col overflow-auto">
          {telemetryState.recentCommands.length === 0 ? (
            <div className="text-muted-text flex h-full items-center justify-center text-xs">
              {t('ssh.historyCommandsEmpty')}
            </div>
          ) : (
            <TooltipProvider delayDuration={180}>
              {[...telemetryState.recentCommands].reverse().map((command, index) => {
                const commandPreview =
                  command.length > commandPreviewMaxLength
                    ? `${command.slice(0, commandPreviewMaxLength)}...`
                    : command;

                return (
                  <ContextMenu key={`${command}-${index}`}>
                    <ContextMenuTrigger asChild>
                      <div className="group relative">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              className={classNames(commandButtonStyle, 'min-w-0 flex-1')}
                              onClick={() => onInsertRecentCommand(command)}
                            >
                              <span className="block w-full truncate pr-8">{commandPreview}</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[420px] whitespace-pre-wrap break-all">
                            {commandPreview}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              aria-label={t('ssh.historyDeleteLabel')}
                              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onDeleteRecentCommand(command);
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
                        onSelect={() => onInsertRecentCommand(command)}
                      >
                        {t('ssh.historyAddToCurrentTerminal')}
                      </ContextMenuItem>

                      {shouldShowTargetTerminalSubmenu ? (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger icon={Terminal}>
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
                          onSelect={() => onSplitTerminalAndInsertRecentCommand(command)}
                        >
                          {t('ssh.historySplitTerminalAndAdd')}
                        </ContextMenuItem>
                      ) : null}

                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={Play}
                        onSelect={() => onRunRecentCommand(command)}
                      >
                        {t('ssh.historyRunInCurrentTerminal')}
                      </ContextMenuItem>

                      {shouldShowTargetTerminalSubmenu ? (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger icon={Play}>{t('ssh.historyRunInTerminalMenu')}</ContextMenuSubTrigger>
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
                          onSelect={() => onSplitTerminalAndRunRecentCommand(command)}
                        >
                          {t('ssh.historySplitTerminalAndRun')}
                        </ContextMenuItem>
                      ) : null}

                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={X}
                        onSelect={() => onDeleteRecentCommand(command)}
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
      </div>

      <div className={sidebarCardStyle}>
        <span>1</span>
      </div>

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
