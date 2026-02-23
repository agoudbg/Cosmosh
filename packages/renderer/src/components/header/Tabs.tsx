import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  defaultAnimateLayoutChanges,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as RadixTabs from '@radix-ui/react-tabs';
import classNames from 'classnames';
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  FileText,
  Home,
  PlusIcon,
  Server,
  Settings,
  Terminal,
  XIcon,
} from 'lucide-react';
import React from 'react';

import { t } from '../../lib/i18n';
import type { TabIconKey, TabItem } from '../../types/tabs';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';

const iconMap: Record<TabIconKey, React.ReactNode> = {
  home: <Home className="h-4 w-4" />,
  ssh: <Server className="h-4 w-4" />,
  settings: <Settings className="h-4 w-4" />,
  file: <FileText className="h-4 w-4" />,
  terminal: <Terminal className="h-4 w-4" />,
  debug: <Bug className="h-4 w-4" />,
};

const DragOverlayTab: React.FC<{ tab: TabItem; width: number }> = ({ tab, width }) => {
  return (
    <div
      className="box-border inline-flex h-[34px] items-center justify-between gap-1.5 overflow-hidden rounded-md bg-header-tab-active px-2"
      style={{ width, minWidth: width, maxWidth: width }}
    >
      <span aria-hidden>{iconMap[tab.iconKey]}</span>
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm">{tab.title}</span>
      {tab.closable && <XIcon className="h-4 w-4" />}
    </div>
  );
};

type CloseTabHandler = (id: string) => void;

const SortableTab = React.forwardRef<
  HTMLDivElement,
  {
    tab: TabItem;
    isActive: boolean;
    width: number;
    onClose: CloseTabHandler;
    onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  }
>(({ tab, isActive, width, onClose, onContextMenu }, forwardedRef) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    animateLayoutChanges: (args) => defaultAnimateLayoutChanges(args),
    transition: {
      duration: 140,
      easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    },
  });

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (typeof forwardedRef === 'function') {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef, setNodeRef],
  );

  const style: React.CSSProperties = {
    transition,
    width,
    minWidth: width,
    maxWidth: width,
    transform: CSS.Transform.toString(transform),
  };

  return (
    <div
      ref={setRefs}
      style={style}
      data-role="sortable-tab"
      data-tab-id={tab.id}
      className={classNames('flex h-full', isDragging ? 'relative z-20' : '')}
      {...attributes}
      {...listeners}
      tabIndex={-1}
      onContextMenu={onContextMenu}
    >
      <RadixTabs.Trigger
        asChild
        value={tab.id}
      >
        <div
          data-role="tab-trigger"
          // @ts-expect-error React.CSSProperties
          style={{ WebkitAppRegion: 'no-drag', width, minWidth: width, maxWidth: width }}
          className={classNames(
            'box-border inline-flex h-full w-full flex-none items-center justify-between gap-1.5 overflow-hidden rounded-md px-2',
            isActive ? 'bg-header-tab-active' : 'hover:bg-header-tab-hover',
            isDragging ? 'opacity-0' : '',
          )}
        >
          <span aria-hidden>{iconMap[tab.iconKey]}</span>
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm">{tab.title}</span>
          {tab.closable && (
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              tabIndex={isActive ? 0 : -1}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </RadixTabs.Trigger>
    </div>
  );
});
SortableTab.displayName = 'SortableTab';

type TabsProps = {
  tabs: TabItem[];
  activeTab: string;
  onActiveTabChange?: (id: string) => void;
  onAddTab?: () => void;
  onCloseTab?: (id: string) => void;
  onCloseRightTabs?: (id: string) => void;
  onCloseOtherTabs?: (id: string) => void;
  onReorderTabs?: (nextTabs: TabItem[]) => void;
};

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTab,
  onActiveTabChange,
  onAddTab,
  onCloseTab,
  onCloseRightTabs,
  onCloseOtherTabs,
  onReorderTabs,
}) => {
  const minTabWidth = 120;
  const maxTabWidth = 180;
  const topHitAreaHeight = 8;
  const [tabWidth, setTabWidth] = React.useState<number>(maxTabWidth);
  const [canScrollLeft, setCanScrollLeft] = React.useState<boolean>(false);
  const [canScrollRight, setCanScrollRight] = React.useState<boolean>(false);
  const [contextTabId, setContextTabId] = React.useState<string | null>(null);
  const [activeDragTabId, setActiveDragTabId] = React.useState<string | null>(null);
  const [dragPreviewTabs, setDragPreviewTabs] = React.useState<TabItem[] | null>(null);
  const dragPreviewTabsRef = React.useRef<TabItem[] | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setActiveAndNotify = React.useCallback(
    (nextId: string) => {
      onActiveTabChange?.(nextId);
    },
    [onActiveTabChange],
  );

  const updateScrollState = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }

    const { scrollLeft, scrollWidth, clientWidth } = el;
    const overflow = scrollWidth > clientWidth + 1;
    setCanScrollLeft(overflow && scrollLeft > 0);
    setCanScrollRight(overflow && scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  React.useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || tabs.length === 0) {
      return;
    }

    const availableWidth = el.clientWidth;
    const targetWidth = Math.floor(availableWidth / tabs.length);
    const clampedWidth = Math.max(minTabWidth, Math.min(maxTabWidth, targetWidth));
    setTabWidth(clampedWidth);
    updateScrollState();
  }, [tabs.length, minTabWidth, maxTabWidth, updateScrollState]);

  React.useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }

    const handleScroll = () => updateScrollState();
    el.addEventListener('scroll', handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const availableWidth = el.clientWidth;
        const targetWidth = Math.floor(availableWidth / Math.max(tabs.length, 1));
        const clampedWidth = Math.max(minTabWidth, Math.min(maxTabWidth, targetWidth));
        setTabWidth(clampedWidth);
        updateScrollState();
      });
      resizeObserver.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
    };
  }, [tabs.length, minTabWidth, maxTabWidth, updateScrollState]);

  const scrollByOffset = (direction: 'left' | 'right') => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    const offset = direction === 'left' ? -tabWidth : tabWidth;
    el.scrollBy({ left: offset, behavior: 'smooth' });
  };

  const orderedTabs = dragPreviewTabs ?? tabs;

  const handleTopHitAreaMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }

      const tabElements = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-role="sortable-tab"]'));
      if (!tabElements.length) {
        return;
      }

      const pointerX = event.clientX;
      let targetTabElement = tabElements.find((el) => {
        const rect = el.getBoundingClientRect();
        return pointerX >= rect.left && pointerX <= rect.right;
      });

      if (!targetTabElement) {
        targetTabElement = tabElements.reduce((closest, current) => {
          const closestRect = closest.getBoundingClientRect();
          const currentRect = current.getBoundingClientRect();
          const closestDistance = Math.abs(pointerX - (closestRect.left + closestRect.width / 2));
          const currentDistance = Math.abs(pointerX - (currentRect.left + currentRect.width / 2));
          return currentDistance < closestDistance ? current : closest;
        });
      }

      const targetTabId = targetTabElement.dataset.tabId;
      if (!targetTabId) {
        return;
      }

      setActiveAndNotify(targetTabId);

      const rect = targetTabElement.getBoundingClientRect();
      const forwardedEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: event.button,
        buttons: event.buttons,
        clientX: Math.max(rect.left + 1, Math.min(pointerX, rect.right - 1)),
        clientY: rect.top + rect.height / 2,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });

      targetTabElement.dispatchEvent(forwardedEvent);
      event.preventDefault();
      event.stopPropagation();
    },
    [setActiveAndNotify],
  );

  const contextTab = React.useMemo(
    () => orderedTabs.find((tab) => tab.id === contextTabId) ?? null,
    [contextTabId, orderedTabs],
  );
  const contextTabIndex = React.useMemo(
    () => (contextTab ? orderedTabs.findIndex((tab) => tab.id === contextTab.id) : -1),
    [contextTab, orderedTabs],
  );
  const isLastTabActive = orderedTabs.length > 0 && activeTab === orderedTabs[orderedTabs.length - 1]?.id;
  const activeDragTab = React.useMemo(
    () => orderedTabs.find((tab) => tab.id === activeDragTabId) ?? null,
    [activeDragTabId, orderedTabs],
  );

  return (
    <RadixTabs.Root
      data-role="tabs-root"
      value={activeTab}
      className="w-full"
      onValueChange={setActiveAndNotify}
    >
      <div className="flex w-full min-w-0 items-center">
        <div className="relative h-[34px] min-w-0 flex-shrink flex-grow-0 overflow-visible">
          <div
            aria-hidden
            className="absolute inset-x-0 z-20"
            style={{
              top: -topHitAreaHeight,
              height: topHitAreaHeight,
              // @ts-expect-error React.CSSProperties
              WebkitAppRegion: 'no-drag',
            }}
            onMouseDown={handleTopHitAreaMouseDown}
          />
          <div className="relative h-full overflow-hidden rounded-md">
            <button
              type="button"
              aria-label="Scroll tabs left"
              aria-hidden={!canScrollLeft}
              className={classNames(
                'absolute left-0 z-10 h-full bg-bg px-1 transition-opacity duration-100 ease-in-out hover:bg-header-tab-hover',
                { 'pointer-events-none opacity-0': !canScrollLeft, 'opacity-100': canScrollLeft },
              )}
              // @ts-expect-error React.CSSProperties
              style={{ WebkitAppRegion: 'no-drag' }}
              disabled={!canScrollLeft}
              onClick={() => scrollByOffset('left')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Scroll tabs right"
              aria-hidden={!canScrollRight}
              className={classNames(
                'absolute right-0 z-10 h-full bg-bg px-1 transition-opacity duration-100 ease-in-out hover:bg-header-tab-hover',
                { 'pointer-events-none opacity-0': !canScrollRight, 'opacity-100': canScrollRight },
              )}
              // @ts-expect-error React.CSSProperties
              style={{ WebkitAppRegion: 'no-drag' }}
              disabled={!canScrollRight}
              onClick={() => scrollByOffset('right')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div
              ref={scrollContainerRef}
              className="no-scrollbar h-full min-w-0 overflow-x-auto"
            >
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
                onDragStart={({ active }) => {
                  setActiveDragTabId(String(active.id));
                  setDragPreviewTabs(tabs);
                  dragPreviewTabsRef.current = tabs;
                }}
                onDragOver={({ active, over }) => {
                  if (!over || active.id === over.id) {
                    return;
                  }

                  setDragPreviewTabs((current) => {
                    const base = current ?? tabs;
                    const oldIndex = base.findIndex((tab) => tab.id === active.id);
                    const newIndex = base.findIndex((tab) => tab.id === over.id);
                    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
                      return current;
                    }

                    const next = arrayMove(base, oldIndex, newIndex);
                    dragPreviewTabsRef.current = next;
                    return next;
                  });
                }}
                onDragCancel={() => {
                  setActiveDragTabId(null);
                  setDragPreviewTabs(null);
                  dragPreviewTabsRef.current = null;
                }}
                onDragEnd={({ active, over }) => {
                  setActiveDragTabId(null);
                  let finalTabs = dragPreviewTabsRef.current ?? dragPreviewTabs ?? tabs;
                  setDragPreviewTabs(null);
                  dragPreviewTabsRef.current = null;

                  if (!onReorderTabs) {
                    return;
                  }

                  const hasPreviewChanged = finalTabs.some((tab, index) => tab.id !== tabs[index]?.id);
                  if (!hasPreviewChanged && over && active.id !== over.id) {
                    const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
                    const newIndex = tabs.findIndex((tab) => tab.id === over.id);
                    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
                      finalTabs = arrayMove(tabs, oldIndex, newIndex);
                    }
                  }

                  const hasOrderChanged = finalTabs.some((tab, index) => tab.id !== tabs[index]?.id);
                  if (!hasOrderChanged) {
                    return;
                  }

                  onReorderTabs(finalTabs);
                }}
              >
                <SortableContext
                  items={orderedTabs.map((tab) => tab.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  <RadixTabs.List
                    data-role="tabs-list"
                    className="flex h-full flex-row flex-nowrap items-center justify-start"
                  >
                    {orderedTabs.map((tab, index) => (
                      <React.Fragment key={tab.id}>
                        <ContextMenu>
                          <ContextMenuTrigger asChild>
                            <SortableTab
                              tab={tab}
                              isActive={activeTab === tab.id}
                              width={tabWidth}
                              onClose={onCloseTab ?? (() => {})}
                              onContextMenu={() => setContextTabId(tab.id)}
                            />
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              icon={XIcon}
                              disabled={!contextTab?.closable}
                              onSelect={() => contextTab && onCloseTab?.(contextTab.id)}
                            >
                              {t('tabs.closeCurrent')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              icon={ChevronRight}
                              disabled={contextTabIndex < 0 || contextTabIndex >= orderedTabs.length - 1}
                              onSelect={() => contextTab && onCloseRightTabs?.(contextTab.id)}
                            >
                              {t('tabs.closeRight')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              icon={XIcon}
                              disabled={!contextTab || orderedTabs.length <= 1}
                              onSelect={() => contextTab && onCloseOtherTabs?.(contextTab.id)}
                            >
                              {t('tabs.closeOthers')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                        {index < orderedTabs.length - 1 && (
                          <span
                            aria-hidden
                            className={classNames(
                              'h-[16px] w-[2px] shrink-0 bg-header-divider',
                              activeTab === tab.id || activeTab === orderedTabs[index + 1]?.id
                                ? 'opacity-0'
                                : 'opacity-100',
                            )}
                          />
                        )}
                      </React.Fragment>
                    ))}
                  </RadixTabs.List>
                </SortableContext>
                <DragOverlay
                  dropAnimation={{
                    duration: 140,
                    easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
                  }}
                >
                  {activeDragTab ? (
                    <DragOverlayTab
                      tab={activeDragTab}
                      width={tabWidth}
                    />
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
          </div>
        </div>
        <span
          aria-hidden
          className={classNames(
            'h-[16px] w-[2px] flex-shrink-0 bg-header-divider',
            isLastTabActive ? 'opacity-0' : 'opacity-100',
          )}
        />
        <button
          type="button"
          className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-md hover:bg-header-tab-hover"
          aria-label="Add tab"
          // @ts-expect-error React.CSSProperties
          style={{ WebkitAppRegion: 'no-drag' }}
          onClick={onAddTab}
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>
    </RadixTabs.Root>
  );
};
