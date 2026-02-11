import React from 'react';

import Header from './components/header/Header';
import { useTabs } from './lib/useTabs';
import Home from './pages/Home';
import Settings from './pages/Settings';
import SSH from './pages/SSH';

const App: React.FC = () => {
  const handleLastTabClose = React.useCallback(() => {
    window.electron?.send('app:close-window', null);
  }, []);

  const {
    tabs,
    activeTabId,
    addTab,
    updateTab,
    openPageInTab,
    closeTab,
    reorderTabs,
    setActiveTabId,
  } = useTabs({ onLastTabClose: handleLastTabClose });

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-text">
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
          onReorderTabs={reorderTabs}
        />
      </div>
      {/* Content */}
      <div className="p-2">
        {tabs.map((tab) => (
          <section key={tab.id} className={tab.id === activeTabId ? 'block' : 'hidden'}>
            {tab.page === 'home' && (
              <Home
                activeTabTitle={tab.title}
                activeTabIcon={tab.iconKey}
                onOpenSSH={() => openPageInTab(tab.id, 'ssh')}
                onOpenSettings={() => addTab('settings')}
                onRenameTab={(title) => updateTab(tab.id, { title })}
                onChangeIcon={(iconKey) => updateTab(tab.id, { iconKey })}
              />
            )}
            {tab.page === 'ssh' && <SSH />}
            {tab.page === 'settings' && <Settings />}
          </section>
        ))}
      </div>
    </div>
  );
};

export default App;
