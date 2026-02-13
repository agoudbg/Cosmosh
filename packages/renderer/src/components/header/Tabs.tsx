import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as RadixTabs from '@radix-ui/react-tabs';
import classNames from 'classnames';
import { ChevronLeft, ChevronRight, FileText, Home, PlusIcon, Server, Settings, Terminal, XIcon } from 'lucide-react';
import React from 'react';

import type { TabIconKey, TabItem } from '../../types/tabs';

const iconMap: Record<TabIconKey, React.ReactNode> = {
  home: <Home className="h-4 w-4" />,
  ssh: <Server className="h-4 w-4" />,
  settings: <Settings className="h-4 w-4" />,
  file: <FileText className="h-4 w-4" />,
  terminal: <Terminal className="h-4 w-4" />,
};

const SortableTab: React.FC<{
  tab: TabItem;
  isActive: boolean;
  width: number;
  onClose: (id: string) => void;
}> = ({ tab, isActive, width, onClose }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const style: React.CSSProperties = {
    transition,
    width,
    minWidth: width,
    maxWidth: width,
    transform: CSS.Translate.toString(transform),
    // @ts-expect-error React.CSSProperties
    WebkitAppRegion: 'no-drag',
  };

  return (
    <RadixTabs.Trigger
      ref={setNodeRef}
      value={tab.id}
      data-role="tab-trigger"
      style={style}
      className={classNames(
        'inline-flex h-full items-center justify-between gap-1.5 px-2 flex-none rounded-md box-border overflow-hidden',
        isActive ? 'bg-header-tab-active' : 'hover:bg-header-tab-hover',
        isDragging ? 'z-10' : '',
      )}
      {...attributes}
      {...listeners}
    >
      <span aria-hidden>{iconMap[tab.iconKey]}</span>
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm">{tab.title}</span>
      {tab.closable && (
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
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
    </RadixTabs.Trigger>
  );
};

type TabsProps = {
  tabs: TabItem[];
  activeTab: string;
  onActiveTabChange?: (id: string) => void;
  onAddTab?: () => void;
  onCloseTab?: (id: string) => void;
  onReorderTabs?: (nextTabs: TabItem[]) => void;
};

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTab,
  onActiveTabChange,
  onAddTab,
  onCloseTab,
  onReorderTabs,
}) => {
  const minTabWidth = 120;
  const maxTabWidth = 180;
  const [tabWidth, setTabWidth] = React.useState<number>(maxTabWidth);
  const [canScrollLeft, setCanScrollLeft] = React.useState<boolean>(false);
  const [canScrollRight, setCanScrollRight] = React.useState<boolean>(false);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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

  return (
    <RadixTabs.Root
      data-role="tabs-root"
      value={activeTab}
      className="w-full"
      onValueChange={setActiveAndNotify}
    >
      <div className="flex w-full min-w-0 items-center">
        <div className="relative h-[34px] min-w-0 flex-shrink flex-grow-0 overflow-hidden rounded-md">
          <button
            type="button"
            aria-label="Scroll tabs left"
            aria-hidden={!canScrollLeft}
            className={classNames(
              'hover:bg-header-tab-hover absolute left-0 z-10 h-full bg-bg transition-opacity duration-100 ease-in-out px-1',
              { 'opacity-0 pointer-events-none': !canScrollLeft, 'opacity-100': canScrollLeft },
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
              'hover:bg-header-tab-hover absolute right-0 z-10 h-full bg-bg transition-opacity duration-100 ease-in-out px-1',
              { 'opacity-0 pointer-events-none': !canScrollRight, 'opacity-100': canScrollRight },
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
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
              onDragEnd={({ active, over }) => {
                if (!over || active.id === over.id) {
                  return;
                }

                if (!onReorderTabs) {
                  return;
                }

                const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
                const newIndex = tabs.findIndex((tab) => tab.id === over.id);
                if (oldIndex === -1 || newIndex === -1) {
                  return;
                }

                onReorderTabs(arrayMove(tabs, oldIndex, newIndex));
              }}
            >
              <SortableContext
                items={tabs.map((tab) => tab.id)}
                strategy={horizontalListSortingStrategy}
              >
                <RadixTabs.List
                  data-role="tabs-list"
                  className="flex h-full flex-row flex-nowrap items-center justify-start"
                >
                  {tabs.map((tab, index) => (
                    <React.Fragment key={tab.id}>
                      <SortableTab
                        tab={tab}
                        isActive={activeTab === tab.id}
                        width={tabWidth}
                        onClose={onCloseTab ?? (() => {})}
                      />
                      <span
                        aria-hidden
                        className={classNames(
                          'bg-divider h-[16px] w-[2px] shrink-0',
                          activeTab === tab.id || activeTab === tabs[index + 1]?.id ? 'opacity-0' : 'opacity-100',
                        )}
                      />
                    </React.Fragment>
                  ))}
                </RadixTabs.List>
              </SortableContext>
            </DndContext>
          </div>
        </div>
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
