import classNames from 'classnames';
import React from 'react';

import Header from './components/header/Header';
import { useTabs } from './lib/useTabs';
import ComponentsField from './pages/ComponentsField';
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
    closeRightTabs,
    closeOtherTabs,
    reorderTabs,
    setActiveTabId,
  } = useTabs({
    onLastTabClose: handleLastTabClose,
  });

  return (
    <div className="text-text flex h-screen w-screen flex-col bg-bg">
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
          onOpenSettingsTab={() => addTab('settings')}
        />
      </div>
      {/* Content */}
      <div className="flex min-h-0 w-full flex-1 p-2">
        {tabs.map((tab) => (
          <section
            key={tab.id}
            className={classNames('h-full min-h-0 w-full overflow-auto', tab.id === activeTabId ? 'block' : 'hidden')}
          >
            {tab.page === 'home' && (
              <Home
                activeTabTitle={tab.title}
                activeTabIcon={tab.iconKey}
                onOpenSSH={() => openPageInTab(tab.id, 'ssh')}
                onOpenSettings={() => addTab('settings')}
                onOpenComponentsField={() => addTab('components-field')}
                onRenameTab={(title) => updateTab(tab.id, { title })}
                onChangeIcon={(iconKey) => updateTab(tab.id, { iconKey })}
              />
            )}
            {tab.page === 'ssh' && <SSH />}
            {tab.page === 'settings' && <Settings />}
            {tab.page === 'components-field' && <ComponentsField />}
          </section>
        ))}
      </div>
    </div>
  );
};

export default App;
