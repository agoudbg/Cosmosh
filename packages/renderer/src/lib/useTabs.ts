import React from 'react';

import type { TabIconKey, TabItem, TabPage } from '../types/tabs';
import { t } from './i18n';

type UseTabsOptions = {
  initialPage?: TabPage;
  onLastTabClose?: () => void;
};

const resolvePageDefaults = (page: TabPage): { title: string; iconKey: TabIconKey } => {
  if (page === 'home') {
    return { title: t('tabs.page.home'), iconKey: 'home' };
  }

  if (page === 'ssh') {
    return { title: t('tabs.page.ssh'), iconKey: 'ssh' };
  }

  if (page === 'ssh-editor') {
    return { title: t('tabs.page.sshEditor'), iconKey: 'ssh' };
  }

  if (page === 'settings') {
    return { title: t('tabs.page.settings'), iconKey: 'settings' };
  }

  if (page === 'components-field') {
    return { title: t('tabs.page.componentsField'), iconKey: 'file' };
  }

  if (page === 'debug') {
    return { title: t('tabs.page.debug'), iconKey: 'debug' };
  }

  return { title: page, iconKey: 'file' };
};

export const useTabs = (options?: UseTabsOptions) => {
  const { initialPage = 'home', onLastTabClose } = options ?? {};
  const tabCounterRef = React.useRef<number>(1);

  const buildTab = React.useCallback((page: TabPage, overrides?: Partial<TabItem>): TabItem => {
    const defaults = resolvePageDefaults(page);
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
    const defaults = resolvePageDefaults(page);
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

  const closeRightTabs = React.useCallback(
    (id: string) => {
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === id);
        if (index === -1) {
          return current;
        }

        const nextTabs = current.slice(0, index + 1);
        if (!nextTabs.length) {
          onLastTabClose?.();
          return current;
        }

        const activeStillExists = nextTabs.some((tab) => tab.id === activeTabId);
        if (!activeStillExists) {
          setActiveTabId(nextTabs[nextTabs.length - 1].id);
        }

        return nextTabs;
      });
    },
    [activeTabId, onLastTabClose],
  );

  const closeOtherTabs = React.useCallback((id: string) => {
    setTabs((current) => {
      const target = current.find((tab) => tab.id === id);
      if (!target) {
        return current;
      }

      setActiveTabId(target.id);
      return [target];
    });
  }, []);

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
    closeRightTabs,
    closeOtherTabs,
    reorderTabs,
    setActiveTabId,
  };
};
