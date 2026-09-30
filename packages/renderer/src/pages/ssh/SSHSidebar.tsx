import classNames from 'classnames';
import { ArrowUpDown, Cpu, MemoryStick } from 'lucide-react';
import React from 'react';

import type { SshTelemetryState } from './ssh-types';
import { formatCpuPercent, formatMemoryUsage, formatTrafficRate } from './ssh-utils';

type SSHSidebarProps = {
  telemetryState: SshTelemetryState;
};

/**
 * Renders the compact SSH session telemetry sidebar.
 *
 * @param props.telemetryState Current SSH telemetry snapshot.
 * @returns Sidebar JSX subtree.
 */
export const SSHSidebar: React.FC<SSHSidebarProps> = ({ telemetryState }) => {
  return (
    <aside className="flex w-[300px] min-w-[300px] shrink-0 flex-col gap-2.5 overflow-auto">
      <div
        className={classNames(
          'flex flex-shrink-0 items-center justify-between gap-2 rounded-[18px] bg-ssh-card-bg px-3 py-2',
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
    </aside>
  );
};
