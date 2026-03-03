import classNames from 'classnames';
import { Bug, FileText, Home as HomeIcon, Server, Settings as SettingsIcon, Terminal, X } from 'lucide-react';
import React from 'react';

import Header from './components/header/Header';
import { CommandPalette, type CommandPaletteItem } from './components/ui/command-palette';
import { InputContextMenuProvider } from './components/ui/input-context-menu';
import { listLocalTerminalProfiles } from './lib/backend';
import { requestOpenLocalTerminalList } from './lib/home-target';
import { t } from './lib/i18n';
import { useSettingsValue } from './lib/settings-store';
import { requestSshEditorCreateMode, setActiveSshServerId, toLocalTerminalTargetId } from './lib/ssh-target';
import { AppToastProvider } from './lib/toast';
import { useTabs } from './lib/useTabs';
import ComponentsField from './pages/ComponentsField';
import Debug from './pages/Debug';
import Home from './pages/Home';
import Settings from './pages/Settings';
import SettingsEditor from './pages/SettingsEditor';
import SSH from './pages/SSH';
import SSHEditor from './pages/SSHEditor';
import type { TabIconKey, TabItem } from './types/tabs';

const tabIconMap: Record<TabIconKey, React.ReactNode> = {
  home: <HomeIcon className="h-4 w-4" />,
  ssh: <Server className="h-4 w-4" />,
  settings: <SettingsIcon className="h-4 w-4" />,
  file: <FileText className="h-4 w-4" />,
  terminal: <Terminal className="h-4 w-4" />,
  debug: <Bug className="h-4 w-4" />,
};

type TabSwitcherOverlayProps = {
  tabs: TabItem[];
  activeTabId: string;
  onCloseTab: (tabId: string) => void;
  onCommitTab: (tabId: string) => void;
};

const TabSwitcherOverlay: React.FC<TabSwitcherOverlayProps> = ({ tabs, activeTabId, onCloseTab, onCommitTab }) => {
  const [isOpen, setIsOpen] = React.useState<boolean>(false);
  const [targetTabId, setTargetTabId] = React.useState<string>('');
  const modifierKeyName = 'Control';

  const closeSwitcher = React.useCallback(() => {
    setIsOpen(false);
    setTargetTabId('');
  }, []);

  const moveTarget = React.useCallback(
    (direction: -1 | 1) => {
      if (tabs.length === 0) {
        return;
      }

      const baseTabId = targetTabId || activeTabId;
      const baseIndex = tabs.findIndex((tab) => tab.id === baseTabId);
      const normalizedBaseIndex = baseIndex < 0 ? (direction > 0 ? 0 : tabs.length - 1) : baseIndex;
      const nextIndex = (normalizedBaseIndex + direction + tabs.length) % tabs.length;
      const nextTabId = tabs[nextIndex]?.id;
      if (nextTabId) {
        setTargetTabId(nextTabId);
      }
    },
    [activeTabId, tabs, targetTabId],
  );

  const commitTarget = React.useCallback(() => {
    if (targetTabId) {
      onCommitTab(targetTabId);
    }
  }, [onCommitTab, targetTabId]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!tabs.some((tab) => tab.id === targetTabId)) {
      setTargetTabId(activeTabId);
    }
  }, [activeTabId, isOpen, tabs, targetTabId]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const hasModifier = event.ctrlKey;
      if (!hasModifier || event.key !== 'Tab') {
        return;
      }

      if (tabs.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!isOpen) {
        setIsOpen(true);
      }

      moveTarget(event.shiftKey ? -1 : 1);
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (!isOpen || event.key !== modifierKeyName) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      commitTarget();
      closeSwitcher();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [closeSwitcher, commitTarget, isOpen, modifierKeyName, moveTarget, tabs.length]);

  const items = React.useMemo<CommandPaletteItem[]>(() => {
    return tabs.map((tab) => ({
      key: tab.id,
      title: tab.title,
      subtitle: (() => {
        const pageLabel = t(`tabs.page.${tab.page}`);
        return pageLabel === tab.title ? undefined : pageLabel;
      })(),
      icon: tabIconMap[tab.iconKey] ?? <FileText className="h-4 w-4" />,
      actions: tab.closable
        ? [
            {
              key: `${tab.id}-close`,
              icon: <X className="h-3.5 w-3.5" />,
              tooltip: t('tabs.closeCurrent'),
              onSelect: () => {
                onCloseTab(tab.id);
              },
            },
          ]
        : undefined,
      onSelect: () => {
        onCommitTab(tab.id);
        closeSwitcher();
      },
    }));
  }, [closeSwitcher, onCloseTab, onCommitTab, tabs]);

  const activeIndex = React.useMemo(() => {
    if (items.length === 0) {
      return 0;
    }

    const targetIndex = items.findIndex((item) => item.key === targetTabId);
    if (targetIndex >= 0) {
      return targetIndex;
    }

    const currentActiveIndex = items.findIndex((item) => item.key === activeTabId);
    return currentActiveIndex >= 0 ? currentActiveIndex : 0;
  }, [activeTabId, items, targetTabId]);

  return (
    <CommandPalette
      closeOnEsc
      showInput={false}
      open={isOpen}
      query=""
      placeholder={t('tabs.switcherPlaceholder')}
      emptyText={t('tabs.switcherEmpty')}
      items={items}
      metadataLayout="inline"
      activeIndex={activeIndex}
      onActiveIndexChange={(index) => {
        const targetItem = items[index];
        if (targetItem) {
          setTargetTabId(targetItem.key);
        }
      }}
      onOpenChange={(open) => {
        if (!open) {
          closeSwitcher();
        }
      }}
      onQueryChange={() => {}}
    />
  );
};

const App: React.FC = () => {
  const terminalContextLaunchBehavior = useSettingsValue('terminalContextLaunchBehavior');
  const defaultLocalTerminalProfile = useSettingsValue('defaultLocalTerminalProfile');

  const handleLastTabClose = React.useCallback(() => {
    window.electron?.closeWindow();
  }, []);

  const {
    tabs,
    activeTabId,
    addTab,
    updateTab,
    openPageInTab,
    closeTab,
    closeRightTabs,
    closeOtherTabs,
    reorderTabs,
    setActiveTabId,
  } = useTabs({
    onLastTabClose: handleLastTabClose,
  });
  const tabsById = React.useMemo(() => {
    return new Map(tabs.map((tab) => [tab.id, tab] as const));
  }, [tabs]);
  const [contentTabOrder, setContentTabOrder] = React.useState<string[]>(() => tabs.map((tab) => tab.id));

  React.useEffect(() => {
    setContentTabOrder((previousOrder) => {
      const liveTabIds = new Set(tabs.map((tab) => tab.id));
      const nextOrder = previousOrder.filter((tabId) => liveTabIds.has(tabId));
      const nextOrderSet = new Set(nextOrder);

      for (const tab of tabs) {
        if (nextOrderSet.has(tab.id)) {
          continue;
        }

        nextOrder.push(tab.id);
        nextOrderSet.add(tab.id);
      }

      const isSameOrder =
        nextOrder.length === previousOrder.length && nextOrder.every((tabId, index) => tabId === previousOrder[index]);
      return isSameOrder ? previousOrder : nextOrder;
    });
  }, [tabs]);

  const handleOpenLocalTerminalList = React.useCallback(() => {
    requestOpenLocalTerminalList();
    addTab('home');
  }, [addTab]);

  const handleOpenDefaultLocalTerminal = React.useCallback(async () => {
    try {
      const response = await listLocalTerminalProfiles();
      const availableProfiles = response.data.items;
      const normalizedPreferredProfileId = defaultLocalTerminalProfile.trim();
      const targetProfile =
        normalizedPreferredProfileId.length === 0 || normalizedPreferredProfileId === 'auto'
          ? availableProfiles[0]
          : (availableProfiles.find((profile) => profile.id === normalizedPreferredProfileId) ?? availableProfiles[0]);

      if (!targetProfile) {
        handleOpenLocalTerminalList();
        return;
      }

      const targetId = toLocalTerminalTargetId(targetProfile.id);
      const tabId = addTab('ssh');
      setActiveSshServerId(targetId);
      updateTab(tabId, { title: targetProfile.name });
    } catch {
      handleOpenLocalTerminalList();
    }
  }, [addTab, defaultLocalTerminalProfile, handleOpenLocalTerminalList, updateTab]);

  const handleLaunchWorkingDirectory = React.useCallback(async () => {
    if (terminalContextLaunchBehavior === 'off') {
      return;
    }

    if (terminalContextLaunchBehavior === 'openLocalTerminalList') {
      handleOpenLocalTerminalList();
      return;
    }

    await handleOpenDefaultLocalTerminal();
  }, [handleOpenDefaultLocalTerminal, handleOpenLocalTerminalList, terminalContextLaunchBehavior]);

  React.useEffect(() => {
    const electronBridge = window.electron;
    if (!electronBridge) {
      return;
    }

    const unsubscribe = electronBridge.onLaunchWorkingDirectory(() => {
      void handleLaunchWorkingDirectory();
    });

    void electronBridge.getPendingLaunchWorkingDirectory().then((cwd) => {
      if (!cwd) {
        return;
      }

      void handleLaunchWorkingDirectory();
    });

    return () => {
      unsubscribe();
    };
  }, [handleLaunchWorkingDirectory]);

  const tabContent = React.useMemo(() => {
    return (
      <div className="flex min-h-0 w-full flex-1 p-2 pt-0">
        {contentTabOrder.map((tabId) => {
          const tab = tabsById.get(tabId);
          if (!tab) {
            return null;
          }

          return (
            <section
              key={tab.id}
              className={classNames('h-full min-h-0 w-full overflow-auto', tab.id === activeTabId ? 'block' : 'hidden')}
            >
              {tab.page === 'home' && (
                <Home
                  isActive={tab.id === activeTabId}
                  onOpenSSH={(serverId, tabTitle, options) => {
                    setActiveSshServerId(serverId);
                    if (options?.openInNewTab) {
                      const newTabId = addTab('ssh');
                      if (tabTitle) {
                        updateTab(newTabId, { title: tabTitle });
                      }
                      return;
                    }

                    openPageInTab(tab.id, 'ssh');
                    if (tabTitle) {
                      updateTab(tab.id, { title: tabTitle });
                    }
                  }}
                  onOpenSshEditor={(serverId) => {
                    const trimmedServerId = serverId.trim();
                    if (trimmedServerId.length === 0) {
                      requestSshEditorCreateMode();
                    }
                    setActiveSshServerId(trimmedServerId);
                    openPageInTab(tab.id, 'ssh-editor');
                  }}
                />
              )}
              {tab.page === 'ssh' && (
                <SSH
                  onTabTitleChange={(title) => {
                    updateTab(tab.id, { title });
                  }}
                />
              )}
              {tab.page === 'ssh-editor' && <SSHEditor />}
              {tab.page === 'settings' && (
                <Settings
                  initialCategoryId={tab.state?.settingsCategory}
                  onOpenSettingInEditor={(settingKey) =>
                    addTab('settings-editor', {
                      state: {
                        settingsEditorSettingKey: settingKey,
                      },
                    })
                  }
                />
              )}
              {tab.page === 'settings-editor' && (
                <SettingsEditor initialSettingKey={tab.state?.settingsEditorSettingKey} />
              )}
              {tab.page === 'components-field' && <ComponentsField />}
              {tab.page === 'debug' && (
                <Debug
                  activeTabTitle={tab.title}
                  activeTabIcon={tab.iconKey}
                  onOpenSSH={(openInNewTab) => (openInNewTab ? addTab('ssh') : openPageInTab(tab.id, 'ssh'))}
                  onOpenSettings={(openInNewTab) =>
                    openInNewTab ? addTab('settings') : openPageInTab(tab.id, 'settings')
                  }
                  onOpenSettingsEditor={(openInNewTab) =>
                    openInNewTab ? addTab('settings-editor') : openPageInTab(tab.id, 'settings-editor')
                  }
                  onOpenComponentsField={(openInNewTab) =>
                    openInNewTab ? addTab('components-field') : openPageInTab(tab.id, 'components-field')
                  }
                  onOpenSshEditor={(openInNewTab) =>
                    openInNewTab ? addTab('ssh-editor') : openPageInTab(tab.id, 'ssh-editor')
                  }
                  onRenameTab={(title) => updateTab(tab.id, { title })}
                  onChangeIcon={(iconKey) => updateTab(tab.id, { iconKey })}
                />
              )}
            </section>
          );
        })}
      </div>
    );
  }, [activeTabId, addTab, contentTabOrder, openPageInTab, tabsById, updateTab]);

  return (
    <AppToastProvider>
      <InputContextMenuProvider>
        <div className="text-text flex h-screen w-screen flex-col overflow-hidden bg-bg">
          {/* Header */}
          <div
            className="flex-shrink-0"
            // @ts-expect-error React.CSSProperties
            style={{ WebkitAppRegion: 'drag' }}
          >
            <Header
              className="flex-shrink-0"
              tabs={tabs}
              activeTab={activeTabId}
              onActiveTabChange={setActiveTabId}
              onAddTab={() => addTab('home')}
              onCloseTab={closeTab}
              onCloseRightTabs={closeRightTabs}
              onCloseOtherTabs={closeOtherTabs}
              onReorderTabs={reorderTabs}
              onOpenSettingsTab={(options) =>
                addTab('settings', {
                  state: {
                    settingsCategory: options?.categoryId,
                  },
                })
              }
              onOpenSettingsEditorTab={() => addTab('settings-editor')}
              onOpenDebugTab={() => addTab('debug')}
            />
          </div>
          {/* Content */}
          {tabContent}

          <TabSwitcherOverlay
            tabs={tabs}
            activeTabId={activeTabId}
            onCloseTab={closeTab}
            onCommitTab={setActiveTabId}
          />
        </div>
      </InputContextMenuProvider>
    </AppToastProvider>
  );
};

export default App;
