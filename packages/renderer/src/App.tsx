import classNames from 'classnames';
import React from 'react';

import Header from './components/header/Header';
import { InputContextMenuProvider } from './components/ui/input-context-menu';
import { listLocalTerminalProfiles } from './lib/backend';
import { requestOpenLocalTerminalList } from './lib/home-target';
import { useSettingsValue } from './lib/settings-store';
import { requestSshEditorCreateMode, setActiveSshServerId } from './lib/ssh-target';
import { toLocalTerminalTargetId } from './lib/ssh-target';
import { AppToastProvider } from './lib/toast';
import { useTabs } from './lib/useTabs';
import ComponentsField from './pages/ComponentsField';
import Debug from './pages/Debug';
import Home from './pages/Home';
import Settings from './pages/Settings';
import SettingsEditor from './pages/SettingsEditor';
import SSH from './pages/SSH';
import SSHEditor from './pages/SSHEditor';

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
          <div className="flex min-h-0 w-full flex-1 p-2 pt-0">
            {tabs.map((tab) => (
              <section
                key={tab.id}
                className={classNames(
                  'h-full min-h-0 w-full overflow-auto',
                  tab.id === activeTabId ? 'block' : 'hidden',
                )}
              >
                {tab.page === 'home' && (
                  <Home
                    isActive={tab.id === activeTabId}
                    onOpenSSH={(serverId, tabTitle) => {
                      setActiveSshServerId(serverId);
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
            ))}
          </div>
        </div>
      </InputContextMenuProvider>
    </AppToastProvider>
  );
};

export default App;
