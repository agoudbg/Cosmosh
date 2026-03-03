import classNames from 'classnames';
import { ArrowUpDown, Cpu, MemoryStick, Search, Send, Sparkles, X } from 'lucide-react';
import React from 'react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { t } from '../../lib/i18n';
import type { SshTelemetryState } from './ssh-types';
import { formatCpuPercent, formatMemoryUsage, formatTrafficRate } from './ssh-utils';

type SSHSidebarProps = {
  telemetryState: SshTelemetryState;
  onInsertRecentCommand: (command: string) => void;
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
 * @param props.onInsertRecentCommand Callback used to insert a history command.
 * @param props.onDeleteRecentCommand Callback used to remove a history command.
 * @returns Sidebar JSX subtree.
 */
export const SSHSidebar: React.FC<SSHSidebarProps> = ({
  telemetryState,
  onInsertRecentCommand,
  onDeleteRecentCommand,
}) => {
  const sidebarCardStyle = 'bg-ssh-card-bg w-full flex-1 rounded-[18px] p-1';
  const cardHiddenArea =
    'overflow-hidden hof:my-[-38px] hof:py-[42px] hof:z-20 hof:shadow-lg transition-all duration-300 ease-in-out';
  const hiddenHeaderStyle = 'h-[34px] mt-[-38px]';
  const commandButtonStyle =
    '!justify-start overflow-hidden text-ellipsis text-start w-full whitespace-nowrap flex-shrink-0';

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
            [...telemetryState.recentCommands].reverse().map((command, index) => (
              <div
                key={`${command}-${index}`}
                className="group relative"
              >
                <Button
                  className={classNames(commandButtonStyle, 'min-w-0 flex-1')}
                  title={command}
                  onClick={() => onInsertRecentCommand(command)}
                >
                  <span className="block w-full truncate pr-8">{command}</span>
                </Button>
                <button
                  aria-label={t('ssh.historyDeleteLabel')}
                  title={t('ssh.historyDeleteLabel')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onDeleteRecentCommand(command);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))
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
