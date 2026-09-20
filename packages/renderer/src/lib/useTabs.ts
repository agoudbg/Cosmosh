import React from 'react';

import type { TabIconKey, TabItem, TabPage } from '../types/tabs';
import { t } from './i18n';

type UseTabsOptions = {
  initialPage?: TabPage;
  onLastTabClose?: () => void;
};

/**
 * Controls where a newly-created tab is inserted in the tab strip.
 */
export type AddTabOptions = {
  /**
   * When provided, the new tab is inserted immediately after this tab id.
   * Missing anchors gracefully fall back to appending at the end.
   */
  insertAfterTabId?: string;
};

/**
 * Inserts a new tab according to the requested tab-strip placement.
 *
 * @param current Existing tab order.
 * @param nextTab New tab object to insert.
 * @param addOptions Optional placement controls.
 * @returns New tab order with the inserted tab.
 */
export const insertTabAtRequestedPosition = <Tab extends { id: string }>(
  current: ReadonlyArray<Tab>,
  nextTab: Tab,
  addOptions?: AddTabOptions,
): Tab[] => {
  const anchorTabId = addOptions?.insertAfterTabId;
  if (!anchorTabId) {
    return [...current, nextTab];
  }

  const anchorIndex = current.findIndex((tab) => tab.id === anchorTabId);
  if (anchorIndex === -1 || anchorIndex >= current.length - 1) {
    return [...current, nextTab];
  }

  return [...current.slice(0, anchorIndex + 1), nextTab, ...current.slice(anchorIndex + 1)];
};

/**
 * Orders tabs by their most recently used ids while retaining any tabs that
 * are missing from the history in their existing tab-strip order.
 *
 * @param tabs Current tabs in display order.
 * @param recentTabIds Tab ids ordered from most recently used to least recently used.
 * @returns Tabs ordered for a recent-use switcher.
 */
export const orderTabsByRecentUse = <Tab extends { id: string }>(
  tabs: ReadonlyArray<Tab>,
  recentTabIds: ReadonlyArray<string>,
): Tab[] => {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab] as const));
  const orderedTabs: Tab[] = [];
  const includedTabIds = new Set<string>();

  for (const tabId of recentTabIds) {
    const tab = tabsById.get(tabId);
    if (!tab || includedTabIds.has(tabId)) {
      continue;
    }

    orderedTabs.push(tab);
    includedTabIds.add(tabId);
  }

  for (const tab of tabs) {
    if (includedTabIds.has(tab.id)) {
      continue;
    }

    orderedTabs.push(tab);
    includedTabIds.add(tab.id);
  }

  return orderedTabs;
};

type TabCloseResolution<Tab> = {
  closingIndex: number;
  remainingTabs: Tab[];
};

/**
 * Resolves a tab close request against the current tab collection.
 *
 * Returning `null` for an unknown id keeps stale UI actions from triggering
 * last-tab behavior or changing the current tab collection.
 *
 * @param tabs Current tabs in display order.
 * @param tabId Requested tab id.
 * @returns The matched tab index and remaining tabs, or `null` when no tab matches.
 */
export const resolveTabClose = <Tab extends { id: string }>(
  tabs: ReadonlyArray<Tab>,
  tabId: string,
): TabCloseResolution<Tab> | null => {
  const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex === -1) {
    return null;
  }

  return {
    closingIndex,
    remainingTabs: tabs.filter((tab) => tab.id !== tabId),
  };
};

/**
 * Returns the localized title and icon for a logical tab page identifier.
 *
 * @param page The logical page identifier used to resolve translation keys.
 * @returns The translated title and associated icon key for that page.
 */
export const resolvePageDefaults = (page: TabPage): { title: string; iconKey: TabIconKey } => {
  if (page === 'home') {
    return { title: t('tabs.page.home'), iconKey: 'home' };
  }

  if (page === 'ssh') {
    return { title: t('tabs.page.ssh'), iconKey: 'ssh' };
  }

  if (page === 'sftp') {
    return { title: t('tabs.page.sftp'), iconKey: 'sftp' };
  }

  if (page === 'settings') {
    return { title: t('tabs.page.settings'), iconKey: 'settings' };
  }

  if (page === 'audit-logs') {
    return { title: t('tabs.page.auditLogs'), iconKey: 'audit' };
  }

  if (page === 'settings-editor') {
    return { title: t('tabs.page.settingsEditor'), iconKey: 'settings' };
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
  const [activeTabId, setActiveTabIdState] = React.useState<string>(() => tabs[0]?.id ?? '');
  const [recentTabIds, setRecentTabIds] = React.useState<string[]>(() => tabs.map((tab) => tab.id));

  const setActiveTabId = React.useCallback((nextTabId: string): void => {
    setActiveTabIdState(nextTabId);
    setRecentTabIds((current) => {
      if (current[0] === nextTabId) {
        return current;
      }

      return [nextTabId, ...current.filter((tabId) => tabId !== nextTabId)];
    });
  }, []);

  React.useEffect(() => {
    const liveTabIds = new Set(tabs.map((tab) => tab.id));

    setRecentTabIds((current) => {
      const next = current.filter((tabId) => liveTabIds.has(tabId));
      const nextTabIds = new Set(next);

      for (const tab of tabs) {
        if (nextTabIds.has(tab.id)) {
          continue;
        }

        next.push(tab.id);
        nextTabIds.add(tab.id);
      }

      const hasChanged = next.length !== current.length || next.some((tabId, index) => tabId !== current[index]);
      return hasChanged ? next : current;
    });
  }, [tabs]);

  React.useEffect(() => {
    if (!tabs.length) {
      return;
    }

    const isActiveValid = tabs.some((tab) => tab.id === activeTabId);
    if (!isActiveValid) {
      setActiveTabId(tabs[0].id);
    }
  }, [activeTabId, setActiveTabId, tabs]);

  const addTab = React.useCallback(
    (page: TabPage, overrides?: Partial<TabItem>, addOptions?: AddTabOptions) => {
      const nextTab = buildTab(page, overrides);
      setTabs((current) => {
        return insertTabAtRequestedPosition(current, nextTab, addOptions);
      });
      setActiveTabId(nextTab.id);
      return nextTab.id;
    },
    [buildTab, setActiveTabId],
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
              iconColorKey: undefined,
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
        const closeResolution = resolveTabClose(current, id);
        if (!closeResolution) {
          return current;
        }

        if (closeResolution.remainingTabs.length === 0) {
          onLastTabClose?.();
          return current;
        }

        const { closingIndex, remainingTabs: nextTabs } = closeResolution;

        if (activeTabId === id) {
          const nextActive = nextTabs[closingIndex] ?? nextTabs[closingIndex - 1] ?? nextTabs[0];
          if (nextActive) {
            setActiveTabId(nextActive.id);
          }
        }

        return nextTabs;
      });
    },
    [activeTabId, onLastTabClose, setActiveTabId],
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
    [activeTabId, onLastTabClose, setActiveTabId],
  );

  const closeOtherTabs = React.useCallback(
    (id: string) => {
      setTabs((current) => {
        const target = current.find((tab) => tab.id === id);
        if (!target) {
          return current;
        }

        setActiveTabId(target.id);
        return [target];
      });
    },
    [setActiveTabId],
  );

  /**
   * Reorders tabs by id while preserving the latest tab objects from state.
   *
   * Using incoming tab snapshots directly can overwrite newer tab updates
   * (for example title/state updates that happen during drag).
   *
   * @param nextTabs Incoming tab order from drag-and-drop.
   * @returns Nothing.
   */
  const reorderTabs = React.useCallback((nextTabs: TabItem[]) => {
    setTabs((currentTabs) => {
      if (nextTabs.length !== currentTabs.length) {
        return currentTabs;
      }

      const currentTabsById = new Map(currentTabs.map((tab) => [tab.id, tab] as const));
      const reorderedTabs: TabItem[] = [];

      for (const nextTab of nextTabs) {
        const currentTab = currentTabsById.get(nextTab.id);
        if (!currentTab) {
          return currentTabs;
        }

        reorderedTabs.push(currentTab);
        currentTabsById.delete(nextTab.id);
      }

      if (currentTabsById.size > 0) {
        return currentTabs;
      }

      const hasOrderChanged = reorderedTabs.some((tab, index) => tab.id !== currentTabs[index]?.id);
      return hasOrderChanged ? reorderedTabs : currentTabs;
    });
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const recentTabs = React.useMemo(() => orderTabsByRecentUse(tabs, recentTabIds), [recentTabIds, tabs]);

  return {
    tabs,
    recentTabs,
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
