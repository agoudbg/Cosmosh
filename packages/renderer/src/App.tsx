import type { AppCloseConfirmationRequest } from '@cosmosh/api-contract';
import classNames from 'classnames';
import React from 'react';

import AppCommandPaletteHost, { type AppCommandPaletteHostHandle } from './components/AppCommandPaletteHost';
import CloseWindowConfirmationDialog from './components/CloseWindowConfirmationDialog';
import SystemPerformanceOverlay from './components/debug/SystemPerformanceOverlay';
import Header from './components/header/Header';
import { listLocalTerminalProfiles } from './lib/backend';
import {
  readEnableHeapSnapshotPreference,
  readShowSystemMonitorOverlayPreference,
  writeEnableHeapSnapshotPreference,
  writeShowSystemMonitorOverlayPreference,
} from './lib/debug-tools';
import { requestOpenLocalTerminalList } from './lib/home-target';
import { t } from './lib/i18n';
import { useSettingsValue } from './lib/settings-store';
import { createSshConnectionIntent, toLocalTerminalTargetId } from './lib/ssh-connection-intent';
import { projectTabPresentation } from './lib/tab-presentation';
import { AppToastProvider } from './lib/toast';
import { useTabs } from './lib/useTabs';
import Home from './pages/Home';
import { areTerminalTabPresentationsEqual } from './pages/ssh/terminal-presentation-tab-state';
import type { TabIconKey, TerminalTabPresentation } from './types/tabs';

const AuditLogs = React.lazy(() => import('./pages/AuditLogs'));
const Debug = React.lazy(() => import('./pages/Debug'));
const Settings = React.lazy(() => import('./pages/Settings'));
const SettingsEditor = React.lazy(() => import('./pages/SettingsEditor'));
const SSH = React.lazy(() => import('./pages/SSH'));
const SFTP = React.lazy(() => import('./pages/SFTP'));

let hasCheckedInitialPendingLaunchWorkingDirectory = false;

/**
 * Quotes one POSIX shell argument for the SFTP-to-SSH startup command.
 *
 * @param value Raw remote path.
 * @returns Single-quoted shell argument.
 */
const quotePosixShellArg = (value: string): string => {
  return `'${value.replace(/'/g, "'\\''")}'`;
};

const pageLoadingFallback = (
  <div
    className="h-full w-full"
    aria-hidden="true"
  />
);

const App: React.FC = () => {
  const terminalContextLaunchBehavior = useSettingsValue('terminalContextLaunchBehavior');
  const defaultLocalTerminalProfile = useSettingsValue('defaultLocalTerminalProfile');
  const [showSystemMonitorOverlay, setShowSystemMonitorOverlay] = React.useState<boolean>(() => {
    return readShowSystemMonitorOverlayPreference();
  });
  const [enableMainHeapSnapshotExport, setEnableMainHeapSnapshotExport] = React.useState<boolean>(() => {
    return readEnableHeapSnapshotPreference();
  });
  const [closeConfirmationRequest, setCloseConfirmationRequest] = React.useState<AppCloseConfirmationRequest | null>(
    null,
  );
  const commandPaletteHostRef = React.useRef<AppCommandPaletteHostHandle | null>(null);
  const closeConfirmationRequestRef = React.useRef<AppCloseConfirmationRequest | null>(null);
  const lastRendererNewTabShortcutAtRef = React.useRef<number>(0);
  const lastAppMenuNewTabAtRef = React.useRef<number>(0);

  const handleShowSystemMonitorOverlayChange = React.useCallback((nextVisible: boolean): void => {
    setShowSystemMonitorOverlay(nextVisible);
    writeShowSystemMonitorOverlayPreference(nextVisible);
  }, []);

  const handleEnableMainHeapSnapshotExportChange = React.useCallback((nextEnabled: boolean): void => {
    setEnableMainHeapSnapshotExport(nextEnabled);
    writeEnableHeapSnapshotPreference(nextEnabled);
  }, []);

  const handleLastTabClose = React.useCallback(() => {
    window.electron?.closeWindow();
  }, []);

  const handleCloseConfirmationResolve = React.useCallback((confirmed: boolean): void => {
    const request = closeConfirmationRequestRef.current;
    if (!request) {
      return;
    }

    closeConfirmationRequestRef.current = null;
    setCloseConfirmationRequest(null);
    window.electron?.respondToCloseConfirmation({
      requestId: request.requestId,
      confirmed,
    });
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
  const [terminalTabPresentations, setTerminalTabPresentations] = React.useState<
    Readonly<Record<string, TerminalTabPresentation>>
  >({});
  const tabsById = React.useMemo(() => {
    return new Map(tabs.map((tab) => [tab.id, tab] as const));
  }, [tabs]);
  const presentedTabs = React.useMemo(() => {
    return tabs.map((tab) => projectTabPresentation(tab, terminalTabPresentations[tab.id]));
  }, [tabs, terminalTabPresentations]);
  const [contentTabOrder, setContentTabOrder] = React.useState<string[]>(() => tabs.map((tab) => tab.id));

  /**
   * Stores one memory-only terminal tab projection without rewriting stable tab identity.
   *
   * @param tabId Owning SSH tab id.
   * @param presentation Pane-aggregated presentation projection.
   * @returns Nothing.
   */
  const handleTerminalTabPresentationChange = React.useCallback(
    (tabId: string, presentation: TerminalTabPresentation): void => {
      setTerminalTabPresentations((current) => {
        if (areTerminalTabPresentationsEqual(current[tabId], presentation)) {
          return current;
        }

        return {
          ...current,
          [tabId]: presentation,
        };
      });
    },
    [],
  );

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

  React.useEffect(() => {
    setTerminalTabPresentations((current) => {
      const liveSshTabIds = new Set(tabs.filter((tab) => tab.page === 'ssh').map((tab) => tab.id));
      const retainedEntries = Object.entries(current).filter(([tabId]) => liveSshTabIds.has(tabId));
      if (retainedEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(retainedEntries);
    });
  }, [tabs]);

  const handleOpenLocalTerminalList = React.useCallback(() => {
    requestOpenLocalTerminalList();
    addTab('home');
  }, [addTab]);

  const handleAddServerTab = React.useCallback((): void => {
    addTab('home', {
      state: {
        home: {
          initialMode: 'ssh',
        },
      },
    });
  }, [addTab]);

  const handleAddKeychainTab = React.useCallback((): void => {
    addTab('home', {
      state: {
        home: {
          initialMode: 'keychains',
        },
      },
    });
  }, [addTab]);

  const handleAddPortForwardTab = React.useCallback((): void => {
    addTab('home', {
      state: {
        home: {
          initialMode: 'portForwarding',
        },
      },
    });
  }, [addTab]);

  const handleOpenCommandPalette = React.useCallback((): void => {
    commandPaletteHostRef.current?.open();
  }, []);

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
      addTab('ssh', {
        title: targetProfile.name,
        iconKey: 'terminal',
        iconColorKey: undefined,
        state: {
          sshConnectionIntent: createSshConnectionIntent(targetId),
        },
      });
    } catch {
      handleOpenLocalTerminalList();
    }
  }, [addTab, defaultLocalTerminalProfile, handleOpenLocalTerminalList]);

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

  const launchWorkingDirectoryHandlerRef = React.useRef<() => Promise<void>>(async () => undefined);

  React.useEffect(() => {
    launchWorkingDirectoryHandlerRef.current = handleLaunchWorkingDirectory;
  }, [handleLaunchWorkingDirectory]);

  const handleHomeTabVisualChange = React.useCallback(
    (tabId: string, visual: { title: string; iconKey: TabIconKey }): void => {
      const targetTab = tabsById.get(tabId);
      if (!targetTab || targetTab.page !== 'home') {
        return;
      }

      if (targetTab.title === visual.title && targetTab.iconKey === visual.iconKey && !targetTab.iconColorKey) {
        return;
      }

      updateTab(tabId, {
        title: visual.title,
        iconKey: visual.iconKey,
        iconColorKey: undefined,
      });
    },
    [tabsById, updateTab],
  );

  React.useEffect(() => {
    const electronBridge = window.electron;
    if (!electronBridge) {
      return;
    }

    const unsubscribe = electronBridge.onLaunchWorkingDirectory(() => {
      void launchWorkingDirectoryHandlerRef.current();
    });

    return () => {
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    const electronBridge = window.electron;
    if (!electronBridge) {
      return;
    }

    return electronBridge.onCloseConfirmationRequested((request) => {
      closeConfirmationRequestRef.current = request;
      setCloseConfirmationRequest(request);
    });
  }, []);

  React.useEffect(() => {
    const electronBridge = window.electron;
    if (!electronBridge || hasCheckedInitialPendingLaunchWorkingDirectory) {
      return;
    }

    hasCheckedInitialPendingLaunchWorkingDirectory = true;

    void electronBridge.getPendingLaunchWorkingDirectory().then((cwd) => {
      if (!cwd) {
        return;
      }

      void launchWorkingDirectoryHandlerRef.current();
    });
  }, []);

  React.useEffect(() => {
    const electronBridge = window.electron;
    if (!electronBridge) {
      return;
    }

    const unsubscribe = electronBridge.onAppMenuAction((action) => {
      switch (action) {
        case 'open-about': {
          addTab('settings', {
            state: {
              settingsCategory: 'about',
            },
          });
          break;
        }
        case 'open-settings': {
          addTab('settings');
          break;
        }
        case 'new-tab': {
          const now = Date.now();
          lastAppMenuNewTabAtRef.current = now;
          if (now - lastRendererNewTabShortcutAtRef.current < 150) {
            break;
          }

          handleAddServerTab();
          break;
        }
        case 'close-current-tab': {
          closeTab(activeTabId);
          break;
        }
        case 'close-right-tabs': {
          closeRightTabs(activeTabId);
          break;
        }
        case 'show-tab-switcher': {
          commandPaletteHostRef.current?.openTabSwitcher();
          break;
        }
        default: {
          break;
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [activeTabId, addTab, closeRightTabs, closeTab, handleAddServerTab]);

  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      return (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      );
    };

    const handleNewTabShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }

      const isNewTabShortcut =
        window.electron?.platform === 'darwin'
          ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
          : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (!isNewTabShortcut || event.key.toLowerCase() !== 't') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      lastRendererNewTabShortcutAtRef.current = now;
      if (now - lastAppMenuNewTabAtRef.current < 150) {
        return;
      }

      handleAddServerTab();
    };

    window.addEventListener('keydown', handleNewTabShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleNewTabShortcut, true);
    };
  }, [handleAddServerTab]);

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
                  tabId={tab.id}
                  isActive={tab.id === activeTabId}
                  initialState={tab.state?.home}
                  onTabVisualChange={handleHomeTabVisualChange}
                  onOpenSSH={(serverId, tabTitle, options) => {
                    if (options?.openInNewTab) {
                      addTab(
                        'ssh',
                        {
                          ...(tabTitle ? { title: tabTitle } : {}),
                          state: {
                            sshConnectionIntent: createSshConnectionIntent(serverId),
                          },
                        },
                        {
                          insertAfterTabId: tab.id,
                        },
                      );
                      return;
                    }

                    openPageInTab(tab.id, 'ssh');
                    updateTab(tab.id, {
                      ...(tabTitle ? { title: tabTitle } : {}),
                      terminalTitleSources: {
                        defaultTitle: t('tabs.page.ssh'),
                        connectionTitle: tabTitle?.trim() || null,
                        manualTitle: null,
                      },
                      state: {
                        ...(tab.state ?? {}),
                        sshConnectionIntent: createSshConnectionIntent(serverId),
                      },
                    });
                  }}
                  onOpenSFTP={(serverId, tabTitle, options) => {
                    const resolvedTitle = tabTitle?.trim() || t('tabs.page.sftp');
                    const nextIntent = {
                      serverId,
                      serverName: resolvedTitle,
                      createdAt: Date.now(),
                    };

                    if (!options?.openInNewTab) {
                      const existingSftpTab = tabs.find((item) => {
                        return item.page === 'sftp' && item.state?.sftpConnectionIntent?.serverId === serverId;
                      });

                      if (existingSftpTab) {
                        setActiveTabId(existingSftpTab.id);
                        return;
                      }
                    }

                    if (options?.openInNewTab) {
                      addTab(
                        'sftp',
                        {
                          title: resolvedTitle,
                          iconKey: 'sftp',
                          iconColorKey: options.iconColorKey,
                          state: {
                            sftpConnectionIntent: nextIntent,
                          },
                        },
                        {
                          insertAfterTabId: tab.id,
                        },
                      );
                      return;
                    }

                    openPageInTab(tab.id, 'sftp');
                    updateTab(tab.id, {
                      title: resolvedTitle,
                      iconKey: 'sftp',
                      iconColorKey: options?.iconColorKey,
                      state: {
                        ...(tab.state ?? {}),
                        sftpConnectionIntent: nextIntent,
                      },
                    });
                  }}
                />
              )}
              {tab.page === 'ssh' && (
                <React.Suspense fallback={pageLoadingFallback}>
                  <SSH
                    tabId={tab.id}
                    isActive={tab.id === activeTabId}
                    connectionIntent={
                      tab.state?.sshConnectionIntent ?? {
                        intentId: `tab:${tab.id}:ssh`,
                        createdAt: 0,
                        target: null,
                        lastResolvedSnapshot: null,
                      }
                    }
                    onConnectionIntentChange={(nextIntent) => {
                      updateTab(tab.id, {
                        state: {
                          ...(tab.state ?? {}),
                          sshConnectionIntent: nextIntent,
                        },
                      });
                    }}
                    onTabTitleChange={(title) => {
                      updateTab(tab.id, {
                        terminalTitleSources: {
                          defaultTitle: tab.terminalTitleSources?.defaultTitle ?? t('tabs.page.ssh'),
                          connectionTitle: title.trim() || null,
                          manualTitle: tab.terminalTitleSources?.manualTitle ?? null,
                        },
                      });
                    }}
                    onTabVisualChange={(visual) => {
                      updateTab(tab.id, {
                        iconKey: visual.iconKey,
                        iconColorKey: visual.iconColorKey,
                      });
                    }}
                    onTerminalPresentationChange={handleTerminalTabPresentationChange}
                    onOpenDirectoryInSFTP={(serverId, serverName, initialPath) => {
                      const nextIntent = {
                        serverId,
                        serverName,
                        initialPath,
                        createdAt: Date.now(),
                      };

                      addTab(
                        'sftp',
                        {
                          title: serverName,
                          iconKey: 'sftp',
                          iconColorKey: tab.iconColorKey,
                          state: {
                            sftpConnectionIntent: nextIntent,
                          },
                        },
                        {
                          insertAfterTabId: tab.id,
                        },
                      );
                    }}
                  />
                </React.Suspense>
              )}
              {tab.page === 'sftp' && (
                <React.Suspense fallback={pageLoadingFallback}>
                  <SFTP
                    connectionIntent={tab.state?.sftpConnectionIntent}
                    onOpenDirectoryInNewTab={(initialPath) => {
                      const intent = tab.state?.sftpConnectionIntent;
                      if (!intent) {
                        return;
                      }

                      addTab(
                        'sftp',
                        {
                          title: intent.serverName,
                          iconKey: 'sftp',
                          iconColorKey: tab.iconColorKey,
                          state: {
                            sftpConnectionIntent: {
                              ...intent,
                              initialPath,
                              createdAt: Date.now(),
                            },
                          },
                        },
                        {
                          insertAfterTabId: tab.id,
                        },
                      );
                    }}
                    onOpenSshAtPath={(initialPath) => {
                      const intent = tab.state?.sftpConnectionIntent;
                      if (!intent) {
                        return;
                      }

                      const sshIntent = createSshConnectionIntent(intent.serverId);
                      addTab(
                        'ssh',
                        {
                          title: intent.serverName,
                          iconKey: 'ssh',
                          iconColorKey: tab.iconColorKey,
                          state: {
                            sshConnectionIntent: {
                              ...sshIntent,
                              startupCommand: `cd ${quotePosixShellArg(initialPath)}`,
                            },
                          },
                        },
                        {
                          insertAfterTabId: tab.id,
                        },
                      );
                    }}
                    onTabTitleChange={(title) => {
                      updateTab(tab.id, { title });
                    }}
                  />
                </React.Suspense>
              )}
              {tab.page === 'settings' && (
                <React.Suspense fallback={pageLoadingFallback}>
                  <Settings
                    initialCategoryId={tab.state?.settingsCategory}
                    initialSearchQuery={tab.state?.settingsInitialSearch}
                    onOpenSettingInEditor={(settingKey) =>
                      addTab(
                        'settings-editor',
                        {
                          state: {
                            settingsEditorSettingKey: settingKey,
                          },
                        },
                        {
                          insertAfterTabId: tab.id,
                        },
                      )
                    }
                  />
                </React.Suspense>
              )}
              {tab.page === 'audit-logs' && (
                <React.Suspense fallback={pageLoadingFallback}>
                  <AuditLogs />
                </React.Suspense>
              )}
              {tab.page === 'settings-editor' && (
                <React.Suspense fallback={pageLoadingFallback}>
                  <SettingsEditor initialSettingKey={tab.state?.settingsEditorSettingKey} />
                </React.Suspense>
              )}
              {tab.page === 'debug' && (
                <React.Suspense fallback={pageLoadingFallback}>
                  <Debug
                    activeTabTitle={tab.title}
                    activeTabIcon={tab.iconKey}
                    showSystemMonitorOverlay={showSystemMonitorOverlay}
                    onShowSystemMonitorOverlayChange={handleShowSystemMonitorOverlayChange}
                    onOpenSSH={(openInNewTab) =>
                      openInNewTab
                        ? addTab('ssh', undefined, { insertAfterTabId: tab.id })
                        : openPageInTab(tab.id, 'ssh')
                    }
                    onOpenSettings={(openInNewTab) =>
                      openInNewTab
                        ? addTab('settings', undefined, { insertAfterTabId: tab.id })
                        : openPageInTab(tab.id, 'settings')
                    }
                    onOpenSettingsEditor={(openInNewTab) =>
                      openInNewTab
                        ? addTab('settings-editor', undefined, { insertAfterTabId: tab.id })
                        : openPageInTab(tab.id, 'settings-editor')
                    }
                    onRenameTab={(title) => updateTab(tab.id, { title })}
                    onChangeIcon={(iconKey) => updateTab(tab.id, { iconKey })}
                  />
                </React.Suspense>
              )}
            </section>
          );
        })}
      </div>
    );
  }, [
    activeTabId,
    addTab,
    contentTabOrder,
    handleHomeTabVisualChange,
    handleTerminalTabPresentationChange,
    handleShowSystemMonitorOverlayChange,
    openPageInTab,
    setActiveTabId,
    showSystemMonitorOverlay,
    tabs,
    tabsById,
    updateTab,
  ]);

  return (
    <AppToastProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-text">
        {/* Header */}
        <div
          className="flex-shrink-0"
          // @ts-expect-error React.CSSProperties
          style={{ WebkitAppRegion: 'drag' }}
        >
          <Header
            className="flex-shrink-0"
            tabs={presentedTabs}
            activeTab={activeTabId}
            onActiveTabChange={setActiveTabId}
            onAddTab={handleAddServerTab}
            onAddTabToRight={(tabId) => addTab('home', undefined, { insertAfterTabId: tabId })}
            onOpenCommandPalette={handleOpenCommandPalette}
            onAddServerTab={handleAddServerTab}
            onAddKeychainTab={handleAddKeychainTab}
            onAddPortForwardTab={handleAddPortForwardTab}
            onCloseTab={closeTab}
            onCloseRightTabs={closeRightTabs}
            onCloseOtherTabs={closeOtherTabs}
            onReorderTabs={reorderTabs}
            onOpenAuditLogsTab={() => addTab('audit-logs')}
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

        <AppCommandPaletteHost
          ref={commandPaletteHostRef}
          activeTabId={activeTabId}
          tabs={presentedTabs}
          addTab={addTab}
          closeTab={closeTab}
          closeRightTabs={closeRightTabs}
          setActiveTabId={setActiveTabId}
          showSystemMonitorOverlay={showSystemMonitorOverlay}
          enableMainHeapSnapshotExport={enableMainHeapSnapshotExport}
          onShowSystemMonitorOverlayChange={handleShowSystemMonitorOverlayChange}
          onEnableMainHeapSnapshotExportChange={handleEnableMainHeapSnapshotExportChange}
        />

        <SystemPerformanceOverlay visible={showSystemMonitorOverlay} />

        <CloseWindowConfirmationDialog
          open={closeConfirmationRequest !== null}
          onResolve={handleCloseConfirmationResolve}
        />
      </div>
    </AppToastProvider>
  );
};

export default App;
