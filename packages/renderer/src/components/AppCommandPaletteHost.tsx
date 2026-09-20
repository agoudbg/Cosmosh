import type { components } from '@cosmosh/api-contract';
import { Bug, CornerUpRight, RefreshCcw, Settings2, X } from 'lucide-react';
import React from 'react';

import { listPortForwardRules, listSshServers } from '../lib/backend';
import {
  collectCommandPaletteCommands,
  type CommandPaletteCommand,
  type CommandPaletteProvider,
  createCommandPaletteProvider,
  executeCommandPaletteCommand,
  filterCommandPaletteCommands,
} from '../lib/command-palette';
import { getEntityColorClassName, renderEntityIcon } from '../lib/entity-visuals';
import { getLocale, onLocaleChange, t, tForLocale } from '../lib/i18n';
import {
  formatPortForwardBindEndpoint,
  formatPortForwardCopyEndpoint,
  formatPortForwardTargetEndpoint,
} from '../lib/port-forward-display';
import { resolveServerAddressForDisplay } from '../lib/server-address';
import { useSettingsValue } from '../lib/settings-store';
import { createSshConnectionIntent } from '../lib/ssh-connection-intent';
import { renderTabIconByKey } from '../lib/tab-icon';
import { useToast } from '../lib/toast-context';
import { resolvePageDefaults } from '../lib/useTabs';
import { resolveCategoryId, SETTINGS_REGISTRY } from '../pages/settings-registry';
import type { TabItem } from '../types/tabs';
import { CommandPalette, type CommandPaletteItem } from './ui/command-palette';

type SshServerListItem = components['schemas']['SshServerListItem'];
type PortForwardRuleListItem = components['schemas']['PortForwardRuleListItem'];

type AppCommandPaletteResourceSnapshot = {
  servers: ReadonlyArray<SshServerListItem>;
  portForwardRules: ReadonlyArray<PortForwardRuleListItem>;
};

type AppCommandPaletteContext = {
  locale: string;
  activeTabId: string;
  tabs: ReadonlyArray<TabItem>;
  resources: AppCommandPaletteResourceSnapshot;
  showFullServerAddress: boolean;
  addTab: (page: string, overrides?: Partial<TabItem>) => string;
  closeTab: (tabId: string) => void;
  closeRightTabs: (tabId: string) => void;
  setActiveTabId: (tabId: string) => void;
  showSystemMonitorOverlay: boolean;
  onShowSystemMonitorOverlayChange: (nextVisible: boolean) => void;
  enableMainHeapSnapshotExport: boolean;
  onEnableMainHeapSnapshotExportChange: (nextEnabled: boolean) => void;
  isDevBuild: boolean;
  devToolsEnabled: boolean;
  userMenuDebugEntryEnabled: boolean;
  notifySuccess: (message: string) => void;
  notifyWarning: (message: string) => void;
};

type AppCommandPaletteHostProps = Omit<
  AppCommandPaletteContext,
  | 'locale'
  | 'tabs'
  | 'resources'
  | 'showFullServerAddress'
  | 'isDevBuild'
  | 'devToolsEnabled'
  | 'userMenuDebugEntryEnabled'
  | 'notifySuccess'
  | 'notifyWarning'
> & {
  tabs: ReadonlyArray<TabItem>;
  recentTabs: ReadonlyArray<TabItem>;
};

export type AppCommandPaletteHostHandle = {
  open: () => void;
  openTabSwitcher: () => void;
};

type AppQuickPickMode = 'commands' | 'tabs';

type BilingualCommandLabel = {
  primary: string;
  english: string;
  secondary?: string;
};

type CommandPaletteScopeId = 'tabs' | 'settings' | 'developer' | 'ssh' | 'sftp' | 'forward';

const commandModePrefix = '>';
const controlModifierKeyName = 'Control';

/**
 * Resolves the quick-pick mode from the visible input text.
 *
 * @param query Visible quick-pick input value.
 * @returns Active quick-pick mode.
 */
const resolveQuickPickMode = (query: string): AppQuickPickMode => {
  return query.startsWith(commandModePrefix) ? 'commands' : 'tabs';
};

/**
 * Removes the command-mode prefix before command metadata filtering.
 *
 * @param query Visible quick-pick input value.
 * @returns Command search query without the leading mode prefix.
 */
const resolveCommandSearchQuery = (query: string): string => {
  return query.startsWith(commandModePrefix) ? query.slice(commandModePrefix.length) : query;
};

/**
 * Normalizes text for command-palette style substring filtering.
 *
 * @param value Raw filter token.
 * @returns Trimmed lowercase token.
 */
const normalizeQuickPickFilterToken = (value: string): string => {
  return value.trim().toLowerCase();
};

/**
 * Filters tabs by title, page label, id, and page key.
 *
 * @param tabs Runtime tab list.
 * @param query Visible quick-pick input value.
 * @returns Matching tabs in the current switcher order.
 */
const filterQuickPickTabs = (tabs: ReadonlyArray<TabItem>, query: string): ReadonlyArray<TabItem> => {
  const normalizedQuery = normalizeQuickPickFilterToken(query);
  if (!normalizedQuery) {
    return tabs;
  }

  return tabs.filter((tab) => {
    const pageDefaults = resolvePageDefaults(tab.page);
    const haystack = [tab.id, tab.page, tab.title, pageDefaults.title].join(' ').toLowerCase();

    return haystack.includes(normalizedQuery);
  });
};

/**
 * Clamps the active item index to the available item range.
 *
 * @param itemCount Number of available quick-pick rows.
 * @param index Requested active row index.
 * @returns Safe active row index.
 */
const resolveClampedActiveIndex = (itemCount: number, index: number): number => {
  if (itemCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, itemCount - 1));
};

/**
 * Resolves the tab index that should be active when entering tab mode.
 *
 * @param tabs Candidate tabs shown in the quick-pick list.
 * @param activeTabId Current app tab id.
 * @returns Index of the active tab or the first row.
 */
const resolvePreferredTabActiveIndex = (tabs: ReadonlyArray<TabItem>, activeTabId: string): number => {
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

  return activeIndex >= 0 ? activeIndex : 0;
};

/**
 * Resolves cyclic tab movement from a known base tab id.
 *
 * @param tabs Candidate tabs in visible quick-pick order.
 * @param baseTabId Starting tab id.
 * @param direction Movement direction.
 * @returns Index after applying cyclic movement.
 */
const resolveMovedTabIndex = (tabs: ReadonlyArray<TabItem>, baseTabId: string, direction: -1 | 1): number => {
  if (tabs.length === 0) {
    return 0;
  }

  const baseIndex = tabs.findIndex((tab) => tab.id === baseTabId);
  const normalizedBaseIndex = baseIndex < 0 ? (direction > 0 ? 0 : tabs.length - 1) : baseIndex;

  return (normalizedBaseIndex + direction + tabs.length) % tabs.length;
};

/**
 * Resolves localized and English labels for command rendering.
 *
 * @param i18nKey Translation key.
 * @param locale Active renderer locale.
 * @returns Primary label, English fallback label, and optional secondary line.
 */
const resolveBilingualCommandLabel = (i18nKey: string, locale: string): BilingualCommandLabel => {
  const primary = t(i18nKey);
  const english = tForLocale('en', i18nKey);
  const secondary = locale === 'en' || english === primary ? undefined : english;

  return {
    primary,
    english,
    secondary,
  };
};

/**
 * Builds deduplicated command search terms while preserving insertion order.
 *
 * @param groups Search-term groups.
 * @returns Flattened and deduplicated search terms.
 */
const buildSearchTerms = (...groups: ReadonlyArray<string>[]): string[] => {
  const deduped = new Map<string, string>();

  for (const group of groups) {
    for (const candidate of group) {
      const normalized = candidate.trim();
      if (!normalized) {
        continue;
      }

      const lookupKey = normalized.toLowerCase();
      if (deduped.has(lookupKey)) {
        continue;
      }

      deduped.set(lookupKey, normalized);
    }
  }

  return Array.from(deduped.values());
};

/**
 * Resolves localized scope labels for command palette titles.
 *
 * @param domainId Command domain identifier.
 * @param locale Active renderer locale.
 * @returns Localized scope label metadata or undefined when not available.
 */
const resolveCommandPaletteScopeLabel = (domainId: string, locale: string): BilingualCommandLabel | undefined => {
  const scopedDomainId = domainId as CommandPaletteScopeId;

  if (scopedDomainId === 'tabs') {
    return resolveBilingualCommandLabel('commandPalette.scopes.tabs', locale);
  }

  if (scopedDomainId === 'settings') {
    return resolveBilingualCommandLabel('commandPalette.scopes.settings', locale);
  }

  if (scopedDomainId === 'developer') {
    return resolveBilingualCommandLabel('commandPalette.scopes.developer', locale);
  }

  if (scopedDomainId === 'ssh') {
    return resolveBilingualCommandLabel('commandPalette.scopes.ssh', locale);
  }

  if (scopedDomainId === 'sftp') {
    return resolveBilingualCommandLabel('commandPalette.scopes.sftp', locale);
  }

  if (scopedDomainId === 'forward') {
    return resolveBilingualCommandLabel('commandPalette.scopes.forward', locale);
  }

  return undefined;
};

/**
 * Builds searchable tokens for a command scope label.
 *
 * This ensures typing a scope name (with or without a trailing separator) can
 * match commands belonging to that domain.
 *
 * @param scopeLabel Scope label metadata.
 * @returns Searchable tokens for the scope label.
 */
const buildScopeSearchTerms = (scopeLabel: BilingualCommandLabel): string[] => {
  return buildSearchTerms(
    [scopeLabel.primary, scopeLabel.english],
    [`${scopeLabel.primary}:`],
    [`${scopeLabel.english}:`],
  );
};

/**
 * Formats a command title with a localized scope prefix.
 *
 * @param scopeLabel Localized label shown as prefix.
 * @param title Command title.
 * @returns Scoped title string.
 */
const formatScopedCommandTitle = (scopeLabel: string, title: string): string => {
  const hasNonAscii = Array.from(scopeLabel).some((character) => character.charCodeAt(0) > 0x7f);
  const prefix = hasNonAscii ? `${scopeLabel}：` : `${scopeLabel}: `;

  if (title.startsWith(prefix)) {
    return title;
  }

  return `${prefix}${title}`;
};

/**
 * Creates the tab-domain provider for command palette actions.
 *
 * @returns Provider with new/switch/close tab commands.
 */
const createTabsCommandPaletteProvider = (): CommandPaletteProvider<AppCommandPaletteContext> => {
  return createCommandPaletteProvider('tabs', (context) => {
    const scopeLabel = resolveBilingualCommandLabel('commandPalette.scopes.tabs', context.locale);
    const scopeSearchTerms = buildScopeSearchTerms(scopeLabel);

    const newTabLabel = resolveBilingualCommandLabel('commandPalette.commands.tabs.newTab', context.locale);
    const closeCurrentTabLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.tabs.closeCurrentTab',
      context.locale,
    );
    const closeRightTabsLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.tabs.closeRightTabs',
      context.locale,
    );
    const switchToTabLabel = resolveBilingualCommandLabel('commandPalette.commands.tabs.switchToTab', context.locale);
    const currentTabLabel = resolveBilingualCommandLabel('commandPalette.commands.tabs.currentTab', context.locale);

    const structuralCommands: CommandPaletteCommand[] = [
      {
        kind: 'action',
        id: 'new-tab',
        commandActionId: 'tabs.new',
        title: newTabLabel.primary,
        subtitle: newTabLabel.secondary,
        searchTerms: buildSearchTerms(['tabs.new', 'tab.create', 'tab.home'], scopeSearchTerms, [newTabLabel.english]),
        run: () => {
          context.addTab('home');
        },
      },
      {
        kind: 'action',
        id: 'close-current-tab',
        commandActionId: 'tabs.close.current',
        title: closeCurrentTabLabel.primary,
        subtitle: closeCurrentTabLabel.secondary,
        searchTerms: buildSearchTerms(['close tab', 'close current tab'], scopeSearchTerms, [
          closeCurrentTabLabel.english,
        ]),
        run: () => {
          context.closeTab(context.activeTabId);
        },
      },
      {
        kind: 'action',
        id: 'close-right-tabs',
        commandActionId: 'tabs.close.right',
        title: closeRightTabsLabel.primary,
        subtitle: closeRightTabsLabel.secondary,
        searchTerms: buildSearchTerms(['close right tabs', 'close tabs right'], scopeSearchTerms, [
          closeRightTabsLabel.english,
        ]),
        run: () => {
          context.closeRightTabs(context.activeTabId);
        },
      },
    ];

    const switchCommands: CommandPaletteCommand[] = context.tabs.map((tab) => ({
      kind: 'action',
      id: `switch:${tab.id}`,
      commandActionId: 'tabs.switch',
      title: tab.title,
      subtitle: tab.id === context.activeTabId ? currentTabLabel.secondary : switchToTabLabel.secondary,
      icon: renderTabIconByKey(tab.iconKey, tab.iconColorKey, false),
      searchTerms: buildSearchTerms([tab.id, tab.page, tab.title, 'tabs.switch', 'tab.activate'], scopeSearchTerms, [
        currentTabLabel.english,
        switchToTabLabel.english,
      ]),
      run: () => {
        context.setActiveTabId(tab.id);
      },
    }));

    return [...structuralCommands, ...switchCommands];
  });
};

/**
 * Creates the settings-domain provider for command palette actions.
 *
 * Each setting command opens a settings tab and injects the setting key into
 * the search box so the Settings page can perform exact-key matching.
 *
 * @returns Provider with all settings-search commands.
 */
const createSettingsCommandPaletteProvider = (): CommandPaletteProvider<AppCommandPaletteContext> => {
  return createCommandPaletteProvider('settings', (context) => {
    const scopeLabel = resolveBilingualCommandLabel('commandPalette.scopes.settings', context.locale);
    const scopeSearchTerms = buildScopeSearchTerms(scopeLabel);

    return SETTINGS_REGISTRY.map((item): CommandPaletteCommand => {
      const categoryId = resolveCategoryId(item.category);
      const settingLabel = resolveBilingualCommandLabel(item.nameI18nKey, context.locale);

      return {
        kind: 'action',
        id: item.key,
        commandActionId: item.commandActionId,
        title: settingLabel.primary,
        subtitle: settingLabel.secondary,
        icon: <Settings2 className="h-4 w-4" />,
        searchTerms: buildSearchTerms(
          [item.key, item.path, item.commandActionId, ...item.searchTerms],
          scopeSearchTerms,
          [settingLabel.english],
        ),
        run: () => {
          context.addTab('settings', {
            state: {
              settingsCategory: categoryId,
              settingsInitialSearch: item.key,
            },
          });
        },
      };
    });
  });
};

/**
 * Formats a server-backed command title while preserving the address privacy setting.
 *
 * @param server Server list item used by the command.
 * @param showFullServerAddress Whether the full address should be shown.
 * @returns Command title without the scope prefix.
 */
const formatServerCommandTitle = (server: SshServerListItem, showFullServerAddress: boolean): string => {
  return `${server.name} (${resolveServerAddressForDisplay(server.host, showFullServerAddress)})`;
};

/**
 * Resolves the neutral icon node used by server-backed resource commands.
 *
 * @param server Server list item used by the command.
 * @returns Uncolored entity icon node.
 */
const renderServerCommandIcon = (server: SshServerListItem): React.ReactNode => {
  return renderEntityIcon(server.iconKey);
};

/**
 * Creates an SSH server command provider.
 *
 * @returns Provider with SSH connection commands for every server.
 */
const createSshResourceCommandPaletteProvider = (): CommandPaletteProvider<AppCommandPaletteContext> => {
  return createCommandPaletteProvider('ssh', (context) => {
    const scopeLabel = resolveBilingualCommandLabel('commandPalette.scopes.ssh', context.locale);
    const scopeSearchTerms = buildScopeSearchTerms(scopeLabel);
    const actionLabel = resolveBilingualCommandLabel('commandPalette.commands.resources.connectSsh', context.locale);

    return context.resources.servers.map((server): CommandPaletteCommand => ({
      kind: 'action',
      id: server.id,
      commandActionId: 'resources.ssh.connect',
      title: formatServerCommandTitle(server, context.showFullServerAddress),
      subtitle: actionLabel.primary,
      icon: renderServerCommandIcon(server),
      searchTerms: buildSearchTerms(
        [
          'ssh',
          'connect ssh',
          'resources.ssh.connect',
          server.id,
          server.name,
          server.host,
          String(server.port),
          server.username,
          server.note ?? '',
          ...(server.tags ?? []).map((tag) => tag.name),
        ],
        scopeSearchTerms,
        [actionLabel.english],
      ),
      run: () => {
        context.addTab('ssh', {
          title: server.name,
          iconKey: 'ssh',
          iconColorKey: server.colorKey,
          state: {
            sshConnectionIntent: createSshConnectionIntent(server.id),
          },
        });
      },
    }));
  });
};

/**
 * Creates an SFTP server command provider.
 *
 * @returns Provider with SFTP connection commands for every server.
 */
const createSftpResourceCommandPaletteProvider = (): CommandPaletteProvider<AppCommandPaletteContext> => {
  return createCommandPaletteProvider('sftp', (context) => {
    const scopeLabel = resolveBilingualCommandLabel('commandPalette.scopes.sftp', context.locale);
    const scopeSearchTerms = buildScopeSearchTerms(scopeLabel);
    const actionLabel = resolveBilingualCommandLabel('commandPalette.commands.resources.connectSftp', context.locale);

    return context.resources.servers.map((server): CommandPaletteCommand => ({
      kind: 'action',
      id: server.id,
      commandActionId: 'resources.sftp.connect',
      title: formatServerCommandTitle(server, context.showFullServerAddress),
      subtitle: actionLabel.primary,
      icon: renderTabIconByKey('sftp', undefined, false),
      searchTerms: buildSearchTerms(
        [
          'sftp',
          'connect sftp',
          'resources.sftp.connect',
          server.id,
          server.name,
          server.host,
          String(server.port),
          server.username,
          server.note ?? '',
          ...(server.tags ?? []).map((tag) => tag.name),
        ],
        scopeSearchTerms,
        [actionLabel.english],
      ),
      run: () => {
        context.addTab('sftp', {
          title: server.name,
          iconKey: 'sftp',
          iconColorKey: server.colorKey,
          state: {
            sftpConnectionIntent: {
              serverId: server.id,
              serverName: server.name,
              createdAt: Date.now(),
            },
          },
        });
      },
    }));
  });
};

/**
 * Creates a port forwarding editor command provider.
 *
 * @returns Provider with port forwarding editor deep-link commands.
 */
const createForwardResourceCommandPaletteProvider = (): CommandPaletteProvider<AppCommandPaletteContext> => {
  return createCommandPaletteProvider('forward', (context) => {
    const scopeLabel = resolveBilingualCommandLabel('commandPalette.scopes.forward', context.locale);
    const scopeSearchTerms = buildScopeSearchTerms(scopeLabel);
    const actionLabel = resolveBilingualCommandLabel('commandPalette.commands.resources.editForward', context.locale);
    const serverById = new Map(context.resources.servers.map((server) => [server.id, server] as const));

    return context.resources.portForwardRules.map((rule): CommandPaletteCommand => {
      const server = serverById.get(rule.serverId);
      const bindEndpoint = formatPortForwardBindEndpoint(rule);
      const targetEndpoint = formatPortForwardTargetEndpoint(rule);
      const copyEndpoint = formatPortForwardCopyEndpoint(rule);

      return {
        kind: 'action',
        id: rule.id,
        commandActionId: 'resources.forward.edit',
        title: rule.name,
        subtitle: actionLabel.primary,
        icon: <CornerUpRight className="h-4 w-4" />,
        searchTerms: buildSearchTerms(
          [
            'forward',
            'port forward',
            'edit forward',
            'resources.forward.edit',
            rule.id,
            rule.name,
            rule.type,
            rule.note ?? '',
            rule.serverName ?? '',
            server?.name ?? '',
            server?.host ?? '',
            server?.username ?? '',
            bindEndpoint,
            targetEndpoint,
            copyEndpoint,
          ],
          scopeSearchTerms,
          [actionLabel.english],
        ),
        run: () => {
          context.addTab('home', {
            state: {
              home: {
                initialMode: 'portForwarding',
                initialPortForwardRuleId: rule.id,
              },
            },
          });
        },
      };
    });
  });
};

/**
 * Creates the developer-domain provider for runtime/debug commands.
 *
 * @returns Provider with command-palette developer actions.
 */
const createDeveloperCommandPaletteProvider = (): CommandPaletteProvider<AppCommandPaletteContext> => {
  return createCommandPaletteProvider('developer', (context) => {
    const scopeLabel = resolveBilingualCommandLabel('commandPalette.scopes.developer', context.locale);
    const scopeSearchTerms = buildScopeSearchTerms(scopeLabel);

    const reloadBackendLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.developer.reloadBackend',
      context.locale,
    );
    const reloadWebViewLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.developer.reloadWebView',
      context.locale,
    );
    const toggleDevToolsLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.developer.toggleDevTools',
      context.locale,
    );
    const toggleSystemMonitorOverlayLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.developer.toggleSystemMonitorOverlay',
      context.locale,
    );
    const toggleMainHeapSnapshotExportLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.developer.toggleMainHeapSnapshotExport',
      context.locale,
    );
    const captureMainHeapSnapshotLabel = resolveBilingualCommandLabel(
      'commandPalette.commands.developer.captureMainHeapSnapshot',
      context.locale,
    );

    const commands: CommandPaletteCommand[] = [];

    if (context.isDevBuild) {
      commands.push({
        kind: 'action',
        id: 'reload-backend',
        commandActionId: 'developer.reloadBackend',
        title: reloadBackendLabel.primary,
        subtitle: reloadBackendLabel.secondary,
        icon: <RefreshCcw className="h-4 w-4" />,
        searchTerms: buildSearchTerms(
          ['developer.reload-backend', 'reload backend', 'restart backend runtime'],
          scopeSearchTerms,
          [reloadBackendLabel.english],
        ),
        run: () => {
          void (async () => {
            try {
              const restarted = await window.electron?.restartBackendRuntime?.();
              if (restarted) {
                context.notifySuccess(t('header.restartBackendSuccess'));
                return;
              }
            } catch {
              // Fall through to warning toast so command failures stay visible.
            }

            context.notifyWarning(t('header.restartBackendFailed'));
          })();
        },
      });
    }

    if (context.isDevBuild || context.userMenuDebugEntryEnabled) {
      commands.push({
        kind: 'action',
        id: 'reload-webview',
        commandActionId: 'developer.reloadWebView',
        title: reloadWebViewLabel.primary,
        subtitle: reloadWebViewLabel.secondary,
        icon: <RefreshCcw className="h-4 w-4" />,
        searchTerms: buildSearchTerms(
          ['developer.reload-webview', 'reload webview', 'reload renderer'],
          scopeSearchTerms,
          [reloadWebViewLabel.english],
        ),
        run: () => {
          const electronBridge = window.electron;
          if (!electronBridge?.reloadWebView) {
            window.location.reload();
            return;
          }

          void (async () => {
            try {
              const reloaded = await electronBridge.reloadWebView();
              if (!reloaded) {
                context.notifyWarning(t('commandPalette.feedback.reloadWebViewFailed'));
              }
            } catch {
              context.notifyWarning(t('commandPalette.feedback.reloadWebViewFailed'));
            }
          })();
        },
      });
    }

    if (context.isDevBuild || context.devToolsEnabled) {
      commands.push({
        kind: 'action',
        id: 'toggle-devtools',
        commandActionId: 'developer.toggleDevTools',
        title: toggleDevToolsLabel.primary,
        subtitle: toggleDevToolsLabel.secondary,
        icon: <Bug className="h-4 w-4" />,
        searchTerms: buildSearchTerms(
          ['developer.toggle-devtools', 'toggle devtools', 'open devtools'],
          scopeSearchTerms,
          [toggleDevToolsLabel.english],
        ),
        run: () => {
          const electronBridge = window.electron;
          if (!electronBridge) {
            return;
          }

          if (electronBridge.toggleDevTools) {
            void electronBridge.toggleDevTools();
            return;
          }

          void electronBridge.openDevTools?.();
        },
      });
    }

    if (context.isDevBuild || context.userMenuDebugEntryEnabled) {
      commands.push(
        {
          kind: 'action',
          id: 'toggle-system-monitor-overlay',
          commandActionId: 'developer.toggleSystemMonitorOverlay',
          title: toggleSystemMonitorOverlayLabel.primary,
          subtitle: toggleSystemMonitorOverlayLabel.secondary,
          icon: <Bug className="h-4 w-4" />,
          searchTerms: buildSearchTerms(
            ['developer.toggle-system-monitor-overlay', 'toggle system monitor overlay', 'debug overlay'],
            scopeSearchTerms,
            [toggleSystemMonitorOverlayLabel.english],
          ),
          run: () => {
            const nextVisible = !context.showSystemMonitorOverlay;
            context.onShowSystemMonitorOverlayChange(nextVisible);
            context.notifySuccess(
              t(
                nextVisible
                  ? 'commandPalette.feedback.systemMonitorOverlayEnabled'
                  : 'commandPalette.feedback.systemMonitorOverlayDisabled',
              ),
            );
          },
        },
        {
          kind: 'action',
          id: 'toggle-main-heap-snapshot-export',
          commandActionId: 'developer.toggleMainHeapSnapshotExport',
          title: toggleMainHeapSnapshotExportLabel.primary,
          subtitle: toggleMainHeapSnapshotExportLabel.secondary,
          icon: <Bug className="h-4 w-4" />,
          searchTerms: buildSearchTerms(
            ['developer.toggle-main-heap-snapshot-export', 'toggle heap snapshot', 'main heap snapshot export'],
            scopeSearchTerms,
            [toggleMainHeapSnapshotExportLabel.english],
          ),
          run: () => {
            const nextEnabled = !context.enableMainHeapSnapshotExport;
            context.onEnableMainHeapSnapshotExportChange(nextEnabled);
            context.notifySuccess(
              t(
                nextEnabled
                  ? 'commandPalette.feedback.mainHeapSnapshotExportEnabled'
                  : 'commandPalette.feedback.mainHeapSnapshotExportDisabled',
              ),
            );
          },
        },
        {
          kind: 'action',
          id: 'capture-main-heap-snapshot',
          commandActionId: 'developer.captureMainHeapSnapshot',
          title: captureMainHeapSnapshotLabel.primary,
          subtitle: captureMainHeapSnapshotLabel.secondary,
          icon: <Bug className="h-4 w-4" />,
          searchTerms: buildSearchTerms(
            ['developer.capture-main-heap-snapshot', 'capture main heap snapshot', 'export main heap snapshot'],
            scopeSearchTerms,
            [captureMainHeapSnapshotLabel.english],
          ),
          run: () => {
            if (!context.enableMainHeapSnapshotExport) {
              context.notifyWarning(t('commandPalette.feedback.mainHeapSnapshotDisabled'));
              return;
            }

            const electronBridge = window.electron;
            if (!electronBridge?.exportMainHeapSnapshot) {
              context.notifyWarning(t('commandPalette.feedback.mainHeapSnapshotUnavailable'));
              return;
            }

            void (async () => {
              try {
                const result = await electronBridge.exportMainHeapSnapshot();
                if (result.ok) {
                  if (result.filePath) {
                    context.notifySuccess(
                      t('commandPalette.feedback.mainHeapSnapshotExported', {
                        filePath: result.filePath,
                      }),
                    );
                    return;
                  }

                  context.notifySuccess(t('commandPalette.feedback.mainHeapSnapshotExportCompleted'));
                  return;
                }

                if (result.message) {
                  context.notifyWarning(result.message);
                  return;
                }

                context.notifyWarning(t('commandPalette.feedback.mainHeapSnapshotExportFailed'));
              } catch (error) {
                context.notifyWarning(
                  error instanceof Error ? error.message : t('commandPalette.feedback.mainHeapSnapshotExportFailed'),
                );
              }
            })();
          },
        },
      );
    }

    return commands;
  });
};

/**
 * Resolves whether the keyboard event carries the supported platform modifier
 * for opening command palette.
 *
 * @param event Native keyboard event.
 * @param isMacPlatform Whether the renderer runs on macOS.
 * @returns True when the event matches the primary command modifier.
 */
const hasSupportedShortcutModifier = (event: KeyboardEvent, isMacPlatform: boolean): boolean => {
  return isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

/**
 * App-scoped command palette host.
 *
 * This component centralizes global shortcut orchestration and provider-based
 * command registration so the root App component remains focused on layout and
 * runtime wiring.
 *
 * @param props Command context from App runtime.
 * @returns Command palette overlay element.
 */
const AppCommandPaletteHost = React.forwardRef<AppCommandPaletteHostHandle, AppCommandPaletteHostProps>(
  (
    {
      activeTabId,
      tabs,
      recentTabs,
      addTab,
      closeTab,
      closeRightTabs,
      setActiveTabId,
      showSystemMonitorOverlay,
      onShowSystemMonitorOverlayChange,
      enableMainHeapSnapshotExport,
      onEnableMainHeapSnapshotExportChange,
    },
    ref,
  ) => {
    const { success: notifySuccess, warning: notifyWarning } = useToast();
    const showFullServerAddress = useSettingsValue('showFullServerAddress');
    const applySshServerVisualStyle = useSettingsValue('sshTabApplyServerVisualStyle');
    const tabSwitcherSortOrder = useSettingsValue('tabSwitcherSortOrder');
    const devToolsEnabled = useSettingsValue('devToolsEnabled');
    const userMenuDebugEntryEnabled = useSettingsValue('userMenuDebugEntryEnabled');
    const isDevBuild = import.meta.env.DEV;
    const isMacPlatform = React.useMemo(() => window.electron?.platform === 'darwin', []);
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    const [query, setQuery] = React.useState<string>('');
    const [activeIndex, setActiveIndex] = React.useState<number>(0);
    const [isHeldTabSwitcher, setIsHeldTabSwitcher] = React.useState<boolean>(false);
    const [locale, setLocale] = React.useState<string>(() => getLocale());
    const [resources, setResources] = React.useState<AppCommandPaletteResourceSnapshot>(() => ({
      servers: [],
      portForwardRules: [],
    }));
    const activeIndexRef = React.useRef<number>(0);
    const quickPickMode = React.useMemo<AppQuickPickMode>(() => resolveQuickPickMode(query), [query]);
    const isCommandMode = quickPickMode === 'commands';
    const tabSwitcherTabs = React.useMemo<ReadonlyArray<TabItem>>(
      () => (tabSwitcherSortOrder === 'mostRecentlyUsed' ? recentTabs : tabs),
      [recentTabs, tabSwitcherSortOrder, tabs],
    );

    React.useEffect(() => {
      return onLocaleChange((nextLocale) => {
        setLocale(nextLocale);
      });
    }, []);

    React.useEffect(() => {
      if (!isOpen || !isCommandMode) {
        return;
      }

      let isCurrent = true;

      void (async () => {
        try {
          const [serversResponse, portForwardRulesResponse] = await Promise.all([
            listSshServers(),
            listPortForwardRules(),
          ]);

          if (!isCurrent) {
            return;
          }

          setResources({
            servers: serversResponse.data.items,
            portForwardRules: portForwardRulesResponse.data.items,
          });
        } catch (error: unknown) {
          if (!isCurrent) {
            return;
          }

          notifyWarning(error instanceof Error ? error.message : t('commandPalette.feedback.resourceLoadFailed'));
        }
      })();

      return () => {
        isCurrent = false;
      };
    }, [isCommandMode, isOpen, notifyWarning]);

    const closeCommandPalette = React.useCallback((): void => {
      setIsOpen(false);
      setQuery('');
      setActiveIndex(0);
      setIsHeldTabSwitcher(false);
    }, []);

    const openCommandPalette = React.useCallback((): void => {
      setQuery(commandModePrefix);
      setActiveIndex(0);
      setIsHeldTabSwitcher(false);
      setIsOpen(true);
    }, []);

    const openTabSwitcher = React.useCallback((): void => {
      setQuery('');
      setActiveIndex(resolvePreferredTabActiveIndex(tabSwitcherTabs, activeTabId));
      setIsHeldTabSwitcher(false);
      setIsOpen(true);
    }, [activeTabId, tabSwitcherTabs]);

    React.useImperativeHandle(
      ref,
      () => ({
        open: openCommandPalette,
        openTabSwitcher,
      }),
      [openCommandPalette, openTabSwitcher],
    );

    const commandPaletteContext = React.useMemo<AppCommandPaletteContext>(
      () => ({
        locale,
        activeTabId,
        tabs: tabSwitcherTabs,
        resources,
        showFullServerAddress,
        addTab,
        closeTab,
        closeRightTabs,
        setActiveTabId,
        showSystemMonitorOverlay,
        onShowSystemMonitorOverlayChange,
        enableMainHeapSnapshotExport,
        onEnableMainHeapSnapshotExportChange,
        isDevBuild,
        devToolsEnabled,
        userMenuDebugEntryEnabled,
        notifySuccess,
        notifyWarning,
      }),
      [
        activeTabId,
        addTab,
        closeRightTabs,
        closeTab,
        devToolsEnabled,
        enableMainHeapSnapshotExport,
        isDevBuild,
        locale,
        notifySuccess,
        resources,
        notifyWarning,
        onEnableMainHeapSnapshotExportChange,
        onShowSystemMonitorOverlayChange,
        setActiveTabId,
        showFullServerAddress,
        showSystemMonitorOverlay,
        tabSwitcherTabs,
        userMenuDebugEntryEnabled,
      ],
    );

    const commandPaletteProviders = React.useMemo<ReadonlyArray<CommandPaletteProvider<AppCommandPaletteContext>>>(
      () => [
        createTabsCommandPaletteProvider(),
        createSettingsCommandPaletteProvider(),
        createSshResourceCommandPaletteProvider(),
        createSftpResourceCommandPaletteProvider(),
        createForwardResourceCommandPaletteProvider(),
        createDeveloperCommandPaletteProvider(),
      ],
      [],
    );

    const commandPaletteCommands = React.useMemo(() => {
      return collectCommandPaletteCommands(commandPaletteProviders, commandPaletteContext);
    }, [commandPaletteContext, commandPaletteProviders]);

    const filteredCommandPaletteCommands = React.useMemo(() => {
      return filterCommandPaletteCommands(commandPaletteCommands, resolveCommandSearchQuery(query));
    }, [commandPaletteCommands, query]);

    const commandPaletteItems = React.useMemo<CommandPaletteItem[]>(() => {
      return filteredCommandPaletteCommands.map((command) => {
        const scopeLabel = resolveCommandPaletteScopeLabel(command.domainId, locale);

        return {
          key: command.key,
          title: scopeLabel ? formatScopedCommandTitle(scopeLabel.primary, command.title) : command.title,
          subtitle:
            scopeLabel && command.subtitle
              ? formatScopedCommandTitle(scopeLabel.english, command.subtitle)
              : command.subtitle,
          icon: command.icon,
          onSelect: () => {
            executeCommandPaletteCommand(command);
            closeCommandPalette();
          },
        };
      });
    }, [closeCommandPalette, filteredCommandPaletteCommands, locale]);

    const filteredTabs = React.useMemo(() => {
      return filterQuickPickTabs(tabSwitcherTabs, query);
    }, [query, tabSwitcherTabs]);

    const tabSwitcherItems = React.useMemo<CommandPaletteItem[]>(() => {
      return filteredTabs.map((tab) => {
        const shouldApplySshTabVisual =
          applySshServerVisualStyle && (tab.page === 'ssh' || tab.page === 'sftp') && Boolean(tab.iconColorKey);
        const pageLabel = resolvePageDefaults(tab.page).title;

        return {
          key: tab.id,
          title: tab.title,
          subtitle: pageLabel === tab.title ? undefined : pageLabel,
          icon: renderTabIconByKey(tab.iconKey, tab.iconColorKey, !shouldApplySshTabVisual),
          rowClassName: shouldApplySshTabVisual ? getEntityColorClassName(tab.iconColorKey!) : undefined,
          actions: tab.closable
            ? [
                {
                  key: `${tab.id}-close`,
                  icon: <X className="h-3.5 w-3.5" />,
                  tooltip: t('tabs.closeCurrent'),
                  onSelect: () => {
                    closeTab(tab.id);
                  },
                },
              ]
            : undefined,
          onSelect: () => {
            setActiveTabId(tab.id);
            closeCommandPalette();
          },
        };
      });
    }, [applySshServerVisualStyle, closeCommandPalette, closeTab, filteredTabs, setActiveTabId]);

    const quickPickItems = React.useMemo<CommandPaletteItem[]>(() => {
      return isCommandMode ? commandPaletteItems : tabSwitcherItems;
    }, [commandPaletteItems, isCommandMode, tabSwitcherItems]);

    React.useEffect(() => {
      setActiveIndex((previous) => resolveClampedActiveIndex(quickPickItems.length, previous));
    }, [quickPickItems.length]);

    React.useEffect(() => {
      activeIndexRef.current = activeIndex;
    }, [activeIndex]);

    const setQuickPickActiveIndex = React.useCallback((nextActiveIndex: number): void => {
      activeIndexRef.current = nextActiveIndex;
      setActiveIndex(nextActiveIndex);
    }, []);

    React.useEffect(() => {
      if (!isOpen || isCommandMode) {
        return;
      }

      const preferredIndex = resolvePreferredTabActiveIndex(filteredTabs, activeTabId);
      setActiveIndex((previous) => {
        if (previous >= 0 && previous < filteredTabs.length) {
          activeIndexRef.current = previous;
          return previous;
        }

        activeIndexRef.current = preferredIndex;
        return preferredIndex;
      });
    }, [activeTabId, filteredTabs, isCommandMode, isOpen]);

    const moveTabSwitcherTarget = React.useCallback(
      (direction: -1 | 1): void => {
        if (tabSwitcherItems.length === 0) {
          return;
        }

        const nextActiveIndex =
          (activeIndexRef.current + direction + tabSwitcherItems.length) % tabSwitcherItems.length;
        setQuickPickActiveIndex(nextActiveIndex);
      },
      [setQuickPickActiveIndex, tabSwitcherItems.length],
    );

    const commitActiveTabSwitcherTarget = React.useCallback((): void => {
      const targetItem = tabSwitcherItems[activeIndexRef.current];
      if (!targetItem) {
        return;
      }

      setActiveTabId(targetItem.key);
    }, [setActiveTabId, tabSwitcherItems]);

    React.useEffect(() => {
      const handleGlobalCommandPaletteShortcut = (event: KeyboardEvent): void => {
        if (event.repeat) {
          return;
        }

        if (event.altKey || !event.shiftKey || event.key.toLowerCase() !== 'p') {
          return;
        }

        if (!hasSupportedShortcutModifier(event, isMacPlatform)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        openCommandPalette();
      };

      window.addEventListener('keydown', handleGlobalCommandPaletteShortcut, true);

      return () => {
        window.removeEventListener('keydown', handleGlobalCommandPaletteShortcut, true);
      };
    }, [isMacPlatform, openCommandPalette]);

    React.useEffect(() => {
      const handleGlobalTabSwitcherKeyDown = (event: KeyboardEvent): void => {
        if (!event.ctrlKey || event.key !== 'Tab') {
          return;
        }

        if (tabSwitcherTabs.length === 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const direction = event.shiftKey ? -1 : 1;
        if (!isOpen || isCommandMode) {
          setQuery('');
          setQuickPickActiveIndex(resolveMovedTabIndex(tabSwitcherTabs, activeTabId, direction));
          setIsHeldTabSwitcher(true);
          setIsOpen(true);
          return;
        }

        setIsHeldTabSwitcher(true);
        moveTabSwitcherTarget(direction);
      };

      const handleGlobalTabSwitcherKeyUp = (event: KeyboardEvent): void => {
        if (!isHeldTabSwitcher || event.key !== controlModifierKeyName) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        commitActiveTabSwitcherTarget();
        closeCommandPalette();
      };

      window.addEventListener('keydown', handleGlobalTabSwitcherKeyDown, true);
      window.addEventListener('keyup', handleGlobalTabSwitcherKeyUp, true);

      return () => {
        window.removeEventListener('keydown', handleGlobalTabSwitcherKeyDown, true);
        window.removeEventListener('keyup', handleGlobalTabSwitcherKeyUp, true);
      };
    }, [
      activeTabId,
      closeCommandPalette,
      commitActiveTabSwitcherTarget,
      isCommandMode,
      isHeldTabSwitcher,
      isOpen,
      moveTabSwitcherTarget,
      setQuickPickActiveIndex,
      tabSwitcherTabs,
    ]);

    const handleInputKeyDownCapture = React.useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (!event.ctrlKey || event.key !== 'Tab' || isCommandMode) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
      },
      [isCommandMode],
    );

    const handleQuickPickQueryChange = React.useCallback(
      (nextQuery: string): void => {
        const previousMode = resolveQuickPickMode(query);
        const nextMode = resolveQuickPickMode(nextQuery);

        setQuery(nextQuery);
        setIsHeldTabSwitcher(false);

        if (previousMode !== nextMode) {
          setQuickPickActiveIndex(
            nextMode === 'tabs' ? resolvePreferredTabActiveIndex(tabSwitcherTabs, activeTabId) : 0,
          );
          return;
        }

        setQuickPickActiveIndex(0);
      },
      [activeTabId, query, setQuickPickActiveIndex, tabSwitcherTabs],
    );

    return (
      <CommandPalette
        closeOnEsc
        open={isOpen}
        query={query}
        placeholder={isCommandMode ? t('commandPalette.placeholder') : t('tabs.switcherPlaceholder')}
        emptyText={isCommandMode ? t('commandPalette.empty') : t('tabs.switcherEmpty')}
        items={quickPickItems}
        metadataLayout={isCommandMode ? 'stacked' : 'inline'}
        activeIndex={activeIndex}
        onActiveIndexChange={setQuickPickActiveIndex}
        onOpenChange={(open) => {
          if (!open) {
            closeCommandPalette();
            return;
          }

          setIsOpen(true);
        }}
        onInputKeyDownCapture={handleInputKeyDownCapture}
        onQueryChange={handleQuickPickQueryChange}
      />
    );
  },
);
AppCommandPaletteHost.displayName = 'AppCommandPaletteHost';

export default AppCommandPaletteHost;
