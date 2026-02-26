import * as RadixAvatar from '@radix-ui/react-avatar';
import classNames from 'classnames';
import { Bug, Info, RefreshCcw, Settings } from 'lucide-react';
import React from 'react';

import { t } from '../../lib/i18n';
import { useSettingsValue } from '../../lib/settings-store';
import { useToast } from '../../lib/toast-context';
import type { TabItem } from '../../types/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tabs } from './Tabs';

const Header: React.FC<{
  className?: string;
  tabs: TabItem[];
  activeTab: string;
  onActiveTabChange?: (id: string) => void;
  onAddTab?: () => void;
  onCloseTab?: (id: string) => void;
  onCloseRightTabs?: (id: string) => void;
  onCloseOtherTabs?: (id: string) => void;
  onReorderTabs?: (nextTabs: TabItem[]) => void;
  onOpenSettingsTab?: (options?: { categoryId?: 'about' }) => void;
  onOpenSettingsEditorTab?: () => void;
  onOpenDebugTab?: () => void;
}> = ({
  className,
  tabs,
  activeTab,
  onActiveTabChange,
  onAddTab,
  onCloseTab,
  onCloseRightTabs,
  onCloseOtherTabs,
  onReorderTabs,
  onOpenSettingsTab,
  onOpenSettingsEditorTab,
  onOpenDebugTab,
}) => {
  const { success: notifySuccess, warning: notifyWarning } = useToast();
  const openSettingsEditorByAltClickRef = React.useRef<boolean>(false);
  const devToolsEnabled = useSettingsValue('devToolsEnabled');
  const accountSyncEnabled = useSettingsValue('accountSyncEnabled');
  // Margin for window controls on macOS/Windows/Linux
  const platform = window.electron?.platform;

  let padding = '';
  if (platform === 'darwin') {
    padding = 'ml-[75px] mr-0';
  } else if (platform === 'win32') {
    padding = 'ml-0 mr-[140px]';
  }

  const isDev = import.meta.env.DEV;

  const onOpenDevTools = React.useCallback(() => {
    if (!devToolsEnabled) {
      return;
    }

    void window.electron?.openDevTools();
  }, [devToolsEnabled]);

  React.useEffect(() => {
    const handleDevToolsShortcut = (event: KeyboardEvent): void => {
      const isOpenDevToolsShortcut = event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i';
      if (!isOpenDevToolsShortcut) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (devToolsEnabled) {
        void window.electron?.openDevTools();
      }
    };

    window.addEventListener('keydown', handleDevToolsShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleDevToolsShortcut, true);
    };
  }, [devToolsEnabled]);

  const onSyncSettings = React.useCallback(async () => {
    if (!accountSyncEnabled) {
      notifyWarning(t('header.syncDisabled'));
      return;
    }

    // Placeholder: actual remote sync logic to be implemented.
    notifySuccess(t('header.syncSuccess'));
  }, [accountSyncEnabled, notifySuccess, notifyWarning]);

  return (
    <header
      className={classNames(
        'flex w-[-webkit-fill-available] items-center gap-2 p-2 text-header-text',
        padding,
        className,
      )}
    >
      {/* Tabs */}
      <div className="flex h-full w-1 flex-1 items-center">
        <Tabs
          tabs={tabs}
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
          onCloseRightTabs={onCloseRightTabs}
          onCloseOtherTabs={onCloseOtherTabs}
          onReorderTabs={onReorderTabs}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex-shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-outline"
            // @ts-expect-error React.CSSProperties
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <RadixAvatar.Root
              className="relative inline-flex h-[30px] w-[30px] shrink-0 overflow-hidden rounded-full bg-bg-subtle align-middle"
              data-role="user-avatar"
            >
              <RadixAvatar.Image
                className="h-full w-full object-cover"
                src=""
              >
                <span className="sr-only">{t('header.avatarAlt')}</span>
              </RadixAvatar.Image>
              <RadixAvatar.Fallback
                className="flex h-full w-full items-center justify-center text-xs font-medium"
                delayMs={600}
                style={{ backgroundColor: 'var(--color-menu-control)' }}
              >
                U
              </RadixAvatar.Fallback>
            </RadixAvatar.Root>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-[280px]"
        >
          <DropdownMenuItem
            withIconSlot={false}
            className="rounded-[10px] px-2.5 py-2"
          >
            <div className="flex items-center gap-3">
              <RadixAvatar.Root className="relative inline-flex h-[34px] w-[34px] shrink-0 overflow-hidden rounded-full bg-bg-subtle align-middle">
                <RadixAvatar.Image
                  className="h-full w-full object-cover"
                  src=""
                >
                  <span className="sr-only">{t('header.currentAccountAvatarAlt')}</span>
                </RadixAvatar.Image>
                <RadixAvatar.Fallback
                  className="flex h-full w-full items-center justify-center text-xs font-medium"
                  style={{ backgroundColor: 'var(--color-menu-control)' }}
                >
                  U
                </RadixAvatar.Fallback>
              </RadixAvatar.Root>
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-header-text">{t('header.guestUser')}</span>
                  <span
                    className="rounded-[10px] px-2 py-1 text-xs"
                    style={{ backgroundColor: 'var(--color-menu-control)' }}
                  >
                    {t('header.login')}
                  </span>
                </div>
                <div className="truncate text-xs text-header-text-muted">{t('header.guestEmail')}</div>
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={RefreshCcw}
            onSelect={() => {
              void onSyncSettings();
            }}
          >
            {t('header.syncSettings')}
          </DropdownMenuItem>
          {devToolsEnabled ? (
            <DropdownMenuItem
              icon={Bug}
              onSelect={onOpenDevTools}
            >
              {t('header.openDevTools')}
            </DropdownMenuItem>
          ) : null}
          {isDev ? (
            <DropdownMenuItem
              icon={Bug}
              onSelect={() => onOpenDebugTab?.()}
            >
              {t('header.debug')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            icon={Settings}
            onPointerDown={(event) => {
              openSettingsEditorByAltClickRef.current = event.altKey;
            }}
            onSelect={() => {
              const openEditor = openSettingsEditorByAltClickRef.current;
              openSettingsEditorByAltClickRef.current = false;

              if (openEditor) {
                onOpenSettingsEditorTab?.();
                return;
              }

              onOpenSettingsTab?.();
            }}
          >
            {t('header.settings')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={Info}
            onSelect={() => {
              onOpenSettingsTab?.({ categoryId: 'about' });
            }}
          >
            {t('header.about')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
};

export default Header;
