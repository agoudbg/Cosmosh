import * as RadixAvatar from '@radix-ui/react-avatar';
import classNames from 'classnames';
import React from 'react';

import type { TabItem } from '../../types/tabs';
import { Tabs } from './Tabs';

const Header: React.FC<{
  className?: string;
  tabs: TabItem[];
  activeTab: string;
  onActiveTabChange?: (id: string) => void;
  onAddTab?: () => void;
  onCloseTab?: (id: string) => void;
  onReorderTabs?: (nextTabs: TabItem[]) => void;
}> = ({
  className,
  tabs,
  activeTab,
  onActiveTabChange,
  onAddTab,
  onCloseTab,
  onReorderTabs,
}) => {
  // Margin for window controls on macOS/Windows/Linux
  const platform = window.electron?.platform;

  let padding = '';
  if (platform === 'darwin') {
    padding = 'ml-[100px] mr-0';
  } else if (platform === 'win32') {
    padding = 'ml-0 mr-[140px]';
  }

  return (
    <header
      className={classNames('text-header-text flex w-[-webkit-fill-available] items-center p-2 gap-5', padding, className)}
    >
      {/* Tabs */}
      <div
        className="flex h-full w-1 flex-1 items-center"
      >
        <Tabs
          tabs={tabs}
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
          onReorderTabs={onReorderTabs}
        />
      </div>
      {/* User Avatar */}
      <button
        className="flex-shrink-0 rounded-full"
        // @ts-expect-error React.CSSProperties
        style={{ WebkitAppRegion: 'no-drag' }}
        onClick={() => { alert(1); }}
      >
        <RadixAvatar.Root
          className="relative inline-flex h-[30px] w-[30px] shrink-0 overflow-hidden rounded-full bg-gray-100 align-middle"
          data-role="user-avatar">
          <RadixAvatar.Image
            className="h-full w-full object-cover"
            src="">
            <span className="sr-only">User Avatar</span>
          </RadixAvatar.Image>
          <RadixAvatar.Fallback className="flex h-full w-full items-center justify-center bg-gray-300 text-xs font-medium text-gray-600" delayMs={600}>
          U
          </RadixAvatar.Fallback>
        </RadixAvatar.Root>
      </button>
    </header>
  );
};

export default Header;
