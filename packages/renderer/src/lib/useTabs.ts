import React from 'react';

import type { TabIconKey, TabItem, TabPage } from '../types/tabs';

type UseTabsOptions = {
  initialPage?: TabPage;
  onLastTabClose?: () => void;
};

const pageDefaults: Record<TabPage, { title: string; iconKey: TabIconKey }> = {
  home: { title: 'Home', iconKey: 'home' },
  ssh: { title: 'SSH', iconKey: 'ssh' },
  settings: { title: 'Settings', iconKey: 'settings' },
};

export const useTabs = (options?: UseTabsOptions) => {
  const { initialPage = 'home', onLastTabClose } = options ?? {};
  const tabCounterRef = React.useRef<number>(1);

  const buildTab = React.useCallback((page: TabPage, overrides?: Partial<TabItem>): TabItem => {
    const defaults = pageDefaults[page];
    const id = `tab-${Date.now()}-${tabCounterRef.current++}`;
    return {
      id,
      page,
      title: defaults.title,
      iconKey: defaults.iconKey,
      closable: true,
      ...overrides,
    };
  }, []);

  const [tabs, setTabs] = React.useState<TabItem[]>(() => [buildTab(initialPage)]);
  const [activeTabId, setActiveTabId] = React.useState<string>(() => tabs[0]?.id ?? '');

  React.useEffect(() => {
    if (!tabs.length) {
      return;
    }

    const isActiveValid = tabs.some((tab) => tab.id === activeTabId);
    if (!isActiveValid) {
      setActiveTabId(tabs[0].id);
    }
  }, [activeTabId, tabs]);

  const addTab = React.useCallback(
    (page: TabPage, overrides?: Partial<TabItem>) => {
      const nextTab = buildTab(page, overrides);
      setTabs((current) => [...current, nextTab]);
      setActiveTabId(nextTab.id);
      return nextTab.id;
    },
    [buildTab],
  );

  const updateTab = React.useCallback((id: string, updates: Partial<TabItem>) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...updates } : tab)));
  }, []);

  const openPageInTab = React.useCallback((id: string, page: TabPage) => {
    const defaults = pageDefaults[page];
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              page,
              title: defaults.title,
              iconKey: defaults.iconKey,
            }
          : tab,
      ),
    );
  }, []);

  const openPageInActiveTab = React.useCallback(
    (page: TabPage) => openPageInTab(activeTabId, page),
    [activeTabId, openPageInTab],
  );

  const closeTab = React.useCallback(
    (id: string) => {
      setTabs((current) => {
        if (current.length <= 1) {
          onLastTabClose?.();
          return current;
        }

        const closingIndex = current.findIndex((tab) => tab.id === id);
        const nextTabs = current.filter((tab) => tab.id !== id);

        if (activeTabId === id) {
          const nextActive = nextTabs[closingIndex] ?? nextTabs[closingIndex - 1] ?? nextTabs[0];
          if (nextActive) {
            setActiveTabId(nextActive.id);
          }
        }

        return nextTabs;
      });
    },
    [activeTabId, onLastTabClose],
  );

  const reorderTabs = React.useCallback((nextTabs: TabItem[]) => {
    setTabs(nextTabs);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return {
    tabs,
    activeTabId,
    activeTab,
    addTab,
    updateTab,
    openPageInTab,
    openPageInActiveTab,
    closeTab,
    reorderTabs,
    setActiveTabId,
  };
};
