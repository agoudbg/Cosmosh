import classNames from 'classnames';
import {
  Bug,
  CornerUpRight,
  FileText,
  Folder,
  Home,
  icons,
  KeyRound,
  ScrollText,
  Server,
  Settings,
  Terminal,
} from 'lucide-react';
import React from 'react';

import type { TabIconColorKey, TabIconKey, TabItem } from '../types/tabs';
import { getEntityColorClassName } from './entity-visuals';

const lucideIconMap = icons as Record<string, React.ComponentType<{ className?: string }>>;

const builtinTabIconMap: Record<TabIconKey, React.ReactNode> = {
  home: <Home className="h-4 w-4 shrink-0" />,
  ssh: <Server className="h-4 w-4 shrink-0" />,
  sftp: <Folder className="h-4 w-4 shrink-0" />,
  settings: <Settings className="h-4 w-4 shrink-0" />,
  file: <FileText className="h-4 w-4 shrink-0" />,
  terminal: <Terminal className="h-4 w-4 shrink-0" />,
  debug: <Bug className="h-4 w-4 shrink-0" />,
  keychain: <KeyRound className="h-4 w-4 shrink-0" />,
  portForwarding: <CornerUpRight className="h-4 w-4 shrink-0" />,
  audit: <ScrollText className="h-4 w-4 shrink-0" />,
};

const resolveLucideIconNode = (iconKey: string): React.ReactNode => {
  const Icon = lucideIconMap[iconKey] ?? Server;
  return <Icon className="h-4 w-4 shrink-0" />;
};

const resolveTabIconNode = (iconKey: string): React.ReactNode => {
  return builtinTabIconMap[iconKey] ?? resolveLucideIconNode(iconKey);
};

/**
 * Renders one tab icon from either built-in page icons or user-configured server visuals.
 *
 * @param tab Tab model containing icon metadata.
 * @param applyColorBackground Whether to apply server icon color/background style.
 * @returns React node rendered inside tab chrome.
 */
export const renderTabIcon = (
  tab: Pick<TabItem, 'iconKey' | 'iconColorKey'>,
  applyColorBackground: boolean,
): React.ReactNode => {
  const baseIcon = resolveTabIconNode(tab.iconKey);

  if (!applyColorBackground || !tab.iconColorKey) {
    return baseIcon;
  }

  return (
    <span
      aria-hidden
      className={classNames(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
        getEntityColorClassName(tab.iconColorKey),
      )}
    >
      {baseIcon}
    </span>
  );
};

/**
 * Returns a command-palette-friendly icon where colorized server visual is optional.
 *
 * @param iconKey Tab icon key.
 * @param iconColorKey Optional server color key.
 * @param applyColorBackground Whether to apply server icon color/background style.
 * @returns React node for command palette items.
 */
export const renderTabIconByKey = (
  iconKey: TabIconKey,
  iconColorKey: TabIconColorKey | undefined,
  applyColorBackground: boolean,
): React.ReactNode => {
  return renderTabIcon({ iconKey, iconColorKey }, applyColorBackground);
};
