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
  Bell,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleGauge,
  Command,
  CornerUpRight,
  KeyRound,
  LoaderCircle,
  PlusIcon,
  Server,
  TriangleAlert,
  XIcon,
} from 'lucide-react';
import React from 'react';

import { getEntityColorClassName } from '../../lib/entity-visuals';
import { t } from '../../lib/i18n';
import { renderTabIcon } from '../../lib/tab-icon';
import type { TabItem, TerminalTabPresentation } from '../../types/tabs';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

type TabPresentationStatusIndicatorProps = {
  presentation: TerminalTabPresentation | undefined;
  elevated?: boolean;
  withTooltip?: boolean;
};

/**
 * Renders the fixed terminal status slot without replacing connection identity.
 *
 * @param props Presentation projection and rendering context.
 * @returns Stable-width status slot with optional localized tooltip.
 */
const TabPresentationStatusIndicator: React.FC<TabPresentationStatusIndicatorProps> = ({
  presentation,
  elevated = false,
  withTooltip = true,
}) => {
  const progressState = presentation?.progressState ?? 'none';
  const bellAttention = presentation?.bellAttention ?? false;
  const hasProgress = progressState !== 'none';
  const hasStatus = hasProgress || bellAttention;
  const progressValue = presentation?.progressValue ?? 0;

  let progressIcon: React.ReactNode = null;
  let progressLabel: string | null = null;
  if (progressState === 'normal') {
    progressIcon = <CircleGauge className="h-4 w-4 text-status-good" />;
    progressLabel = t('tabs.presentation.progressNormal', { value: progressValue });
  } else if (progressState === 'error') {
    progressIcon = <CircleAlert className="h-4 w-4 text-status-bad" />;
    progressLabel = t('tabs.presentation.progressError', { value: progressValue });
  } else if (progressState === 'warning') {
    progressIcon = <TriangleAlert className="h-4 w-4 text-status-warn" />;
    progressLabel = t('tabs.presentation.progressWarning', { value: progressValue });
  } else if (progressState === 'indeterminate') {
    progressIcon = <LoaderCircle className="h-4 w-4 animate-spin text-header-text-muted" />;
    progressLabel = t('tabs.presentation.progressIndeterminate');
  }

  const bellLabel = bellAttention ? t('tabs.presentation.bellAttention') : null;
  const statusLabel =
    progressLabel && bellLabel
      ? t('tabs.presentation.combined', { progress: progressLabel, attention: bellLabel })
      : (progressLabel ?? bellLabel);
  const slot = (
    <span
      data-role="terminal-tab-presentation-status"
      aria-hidden={!hasStatus}
      aria-label={statusLabel ?? undefined}
      className={classNames(
        'relative inline-flex h-4 w-4 flex-none items-center justify-center',
        elevated ? 'z-[1]' : '',
      )}
      role={hasStatus ? 'img' : undefined}
    >
      {progressIcon}
      {bellAttention && !hasProgress ? <Bell className="h-4 w-4 text-status-warn" /> : null}
      {bellAttention && hasProgress ? (
        <Bell className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 text-status-warn" />
      ) : null}
    </span>
  );

  if (!withTooltip || !statusLabel) {
    return slot;
  }

  return (
    <TooltipProvider delayDuration={180}>
      <Tooltip>
        <TooltipTrigger asChild>{slot}</TooltipTrigger>
        <TooltipContent>{statusLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const DragOverlayTab: React.FC<{ tab: TabItem; width: number; applySshServerVisuals: boolean }> = ({
  tab,
  width,
  applySshServerVisuals,
}) => {
  const shouldApplySshTabVisual = hasServerVisualTabStyle(tab, applySshServerVisuals);

  return (
    <div
      className={classNames(
        'box-border inline-flex h-[34px] items-center justify-between gap-1.5 overflow-hidden rounded-lg px-2',
        shouldApplySshTabVisual ? getEntityColorClassName(tab.iconColorKey!) : 'bg-header-tab-active',
      )}
      style={{ width, minWidth: width, maxWidth: width }}
    >
      <span aria-hidden>
        {renderTabIcon(tab, !shouldApplySshTabVisual && isServerBackedTab(tab) && applySshServerVisuals)}
      </span>
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm">{tab.title}</span>
      {tab.page === 'ssh' ? (
        <TabPresentationStatusIndicator
          presentation={tab.terminalPresentation}
          withTooltip={false}
        />
      ) : null}
      {tab.closable && <XIcon className="h-4 w-4" />}
    </div>
  );
};

type CloseTabHandler = (id: string) => void;
type AddTabToRightHandler = (id: string) => string | void;

const SortableTab = React.forwardRef<
  HTMLDivElement,
  {
    tab: TabItem;
    isActive: boolean;
    width: number;
    applySshServerVisuals: boolean;
    onClose: CloseTabHandler;
    onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  }
>(({ tab, isActive, width, applySshServerVisuals, onClose, onContextMenu }, forwardedRef) => {
  const shouldApplySshTabVisual = hasServerVisualTabStyle(tab, applySshServerVisuals);

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
      onAuxClick={(e) => {
        if (e.button === 1 && tab.closable) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
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
            'box-border inline-flex h-full w-full flex-none items-center justify-between gap-1.5 overflow-hidden rounded-lg px-2',
            shouldApplySshTabVisual ? getEntityColorClassName(tab.iconColorKey!) : '',
            shouldApplySshTabVisual && !isDragging
              ? isActive
                ? "relative before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-header-tab-server-active-overlay before:content-['']"
                : "relative before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-header-tab-server-inactive-overlay before:content-[''] hover:before:bg-header-tab-server-inactive-overlay-hover"
              : '',
            !shouldApplySshTabVisual ? (isActive ? 'bg-header-tab-active' : 'hover:bg-header-tab-hover') : '',
            isDragging ? 'opacity-0' : '',
          )}
        >
          <span
            aria-hidden
            className={classNames(shouldApplySshTabVisual && !isDragging ? 'relative z-[1]' : '')}
          >
            {renderTabIcon(tab, !shouldApplySshTabVisual && isServerBackedTab(tab) && applySshServerVisuals)}
          </span>
          <span
            className={classNames(
              'flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm',
              shouldApplySshTabVisual && !isDragging ? 'relative z-[1]' : '',
            )}
          >
            {tab.title}
          </span>
          {tab.page === 'ssh' ? (
            <TabPresentationStatusIndicator
              elevated={shouldApplySshTabVisual && !isDragging}
              presentation={tab.terminalPresentation}
            />
          ) : null}
          {tab.closable && (
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className={classNames(shouldApplySshTabVisual && !isDragging ? 'relative z-[1]' : '')}
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
  applySshServerVisuals?: boolean;
  onActiveTabChange?: (id: string) => void;
  onAddTab?: () => void;
  onAddTabToRight?: AddTabToRightHandler;
  onOpenCommandPalette?: () => void;
  onAddServerTab?: () => void;
  onAddKeychainTab?: () => void;
  onAddPortForwardTab?: () => void;
  onCloseTab?: (id: string) => void;
  onCloseRightTabs?: (id: string) => void;
  onCloseOtherTabs?: (id: string) => void;
  onReorderTabs?: (nextTabs: TabItem[]) => void;
};

const isServerBackedTab = (tab: TabItem | undefined): boolean => {
  return tab?.page === 'ssh' || tab?.page === 'sftp';
};

const hasServerVisualTabStyle = (tab: TabItem | undefined, applySshServerVisuals: boolean): boolean => {
  return applySshServerVisuals && isServerBackedTab(tab) && Boolean(tab?.iconColorKey);
};

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTab,
  applySshServerVisuals = false,
  onActiveTabChange,
  onAddTab,
  onAddTabToRight,
  onOpenCommandPalette,
  onAddServerTab,
  onAddKeychainTab,
  onAddPortForwardTab,
  onCloseTab,
  onCloseRightTabs,
  onCloseOtherTabs,
  onReorderTabs,
}) => {
  const minTabWidth = 120;
  const maxTabWidth = 180;
  const topHitAreaHeight = 8;
  const addMenuOpenDelayMs = 500;
  const addMenuCloseDelayMs = 120;
  const [tabWidth, setTabWidth] = React.useState<number>(maxTabWidth);
  const [canScrollLeft, setCanScrollLeft] = React.useState<boolean>(false);
  const [canScrollRight, setCanScrollRight] = React.useState<boolean>(false);
  const [contextTabId, setContextTabId] = React.useState<string | null>(null);
  const [activeDragTabId, setActiveDragTabId] = React.useState<string | null>(null);
  const [dragPreviewTabs, setDragPreviewTabs] = React.useState<TabItem[] | null>(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = React.useState<boolean>(false);
  const dragPreviewTabsRef = React.useRef<TabItem[] | null>(null);
  const shouldPreventContextMenuCloseAutoFocusRef = React.useRef<boolean>(false);
  const pendingContextMenuFocusTabIdRef = React.useRef<string | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const addMenuTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const addMenuContentRef = React.useRef<HTMLDivElement | null>(null);
  const addMenuOpenTimerRef = React.useRef<number | null>(null);
  const addMenuCloseTimerRef = React.useRef<number | null>(null);
  const isPointerInsideAddMenuTriggerRef = React.useRef<boolean>(false);
  const isPointerInsideAddMenuContentRef = React.useRef<boolean>(false);
  const addMenuContentId = React.useId();
  const isMacPlatform = React.useMemo(() => window.electron?.platform === 'darwin', []);
  const closeCurrentTabShortcutLabel = React.useMemo(() => (isMacPlatform ? '⌘W' : 'Ctrl+W'), [isMacPlatform]);
  const commandPaletteShortcutLabel = React.useMemo(() => (isMacPlatform ? '⌘⇧P' : 'Ctrl+Shift+P'), [isMacPlatform]);
  const newServerTabShortcutLabel = React.useMemo(() => (isMacPlatform ? '⌘T' : 'Ctrl+T'), [isMacPlatform]);

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

  /**
   * Cancels any pending delayed add-menu open request.
   *
   * @returns Nothing.
   */
  const clearAddMenuOpenTimer = React.useCallback((): void => {
    if (addMenuOpenTimerRef.current === null) {
      return;
    }

    window.clearTimeout(addMenuOpenTimerRef.current);
    addMenuOpenTimerRef.current = null;
  }, []);

  /**
   * Cancels any pending delayed add-menu close request.
   *
   * @returns Nothing.
   */
  const clearAddMenuCloseTimer = React.useCallback((): void => {
    if (addMenuCloseTimerRef.current === null) {
      return;
    }

    window.clearTimeout(addMenuCloseTimerRef.current);
    addMenuCloseTimerRef.current = null;
  }, []);

  /**
   * Opens the add-tab menu and clears competing timers.
   *
   * @returns Nothing.
   */
  const openAddMenu = React.useCallback((): void => {
    clearAddMenuOpenTimer();
    clearAddMenuCloseTimer();
    setIsAddMenuOpen(true);
  }, [clearAddMenuCloseTimer, clearAddMenuOpenTimer]);

  /**
   * Closes the add-tab menu and cancels any delayed open/close request.
   *
   * @returns Nothing.
   */
  const closeAddMenu = React.useCallback((): void => {
    clearAddMenuOpenTimer();
    clearAddMenuCloseTimer();
    setIsAddMenuOpen(false);
  }, [clearAddMenuCloseTimer, clearAddMenuOpenTimer]);

  /**
   * Opens the add-tab menu after the required hover/focus dwell period.
   *
   * @returns Nothing.
   */
  const scheduleAddMenuOpen = React.useCallback((): void => {
    clearAddMenuCloseTimer();
    if (isAddMenuOpen || addMenuOpenTimerRef.current !== null) {
      return;
    }

    addMenuOpenTimerRef.current = window.setTimeout(() => {
      addMenuOpenTimerRef.current = null;
      setIsAddMenuOpen(true);
    }, addMenuOpenDelayMs);
  }, [clearAddMenuCloseTimer, isAddMenuOpen]);

  /**
   * Closes the add-tab menu only after the pointer has left both interactive regions.
   *
   * @returns Nothing.
   */
  const scheduleAddMenuCloseWhenPointerLeaves = React.useCallback((): void => {
    clearAddMenuOpenTimer();
    clearAddMenuCloseTimer();
    addMenuCloseTimerRef.current = window.setTimeout(() => {
      addMenuCloseTimerRef.current = null;
      if (isPointerInsideAddMenuTriggerRef.current || isPointerInsideAddMenuContentRef.current) {
        return;
      }

      setIsAddMenuOpen(false);
    }, addMenuCloseDelayMs);
  }, [clearAddMenuCloseTimer, clearAddMenuOpenTimer]);

  React.useEffect(() => {
    return () => {
      clearAddMenuOpenTimer();
      clearAddMenuCloseTimer();
    };
  }, [clearAddMenuCloseTimer, clearAddMenuOpenTimer]);

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

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }

      const isCloseShortcut = isMacPlatform
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

      if (!isCloseShortcut || event.key.toLowerCase() !== 'w') {
        return;
      }

      const currentActiveTab = tabs.find((tab) => tab.id === activeTab);
      if (!currentActiveTab?.closable) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onCloseTab?.(currentActiveTab.id);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [activeTab, isMacPlatform, onCloseTab, tabs]);

  const scrollByOffset = (direction: 'left' | 'right') => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    const offset = direction === 'left' ? -tabWidth : tabWidth;
    el.scrollBy({ left: offset, behavior: 'smooth' });
  };

  /**
   * Converts discrete vertical wheel input into horizontal tab-list scrolling.
   *
   * @param event Native wheel event from the tab-list scroll container.
   * @returns Nothing.
   */
  const handleTabListWheel = React.useCallback(
    (event: WheelEvent): void => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }

      if (scrollContainer.scrollWidth <= scrollContainer.clientWidth + 1 || event.deltaY === 0) {
        return;
      }

      const hasHorizontalDelta = Math.abs(event.deltaX) > 0;
      const isPixelMode = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
      const isLikelyTouchpadGesture = hasHorizontalDelta || (isPixelMode && Math.abs(event.deltaY) < 15);
      if (isLikelyTouchpadGesture) {
        return;
      }

      const normalizedDelta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * scrollContainer.clientWidth
            : event.deltaY;

      const sensitivity = 2.8;

      event.preventDefault();
      scrollContainer.scrollLeft += normalizedDelta * sensitivity;
      updateScrollState();
    },
    [updateScrollState],
  );

  React.useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    // React delegates wheel events passively, but this interaction must cancel vertical page scrolling.
    scrollContainer.addEventListener('wheel', handleTabListWheel, { passive: false });

    return () => {
      scrollContainer.removeEventListener('wheel', handleTabListWheel);
    };
  }, [handleTabListWheel]);

  const orderedTabs = dragPreviewTabs ?? tabs;

  /**
   * Returns whether a focus target belongs to the add-tab trigger or menu content.
   *
   * @param target Potential next focused element.
   * @returns True when focus is still inside the add-tab menu interaction area.
   */
  const isAddMenuFocusTarget = React.useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) {
      return false;
    }

    return Boolean(addMenuTriggerRef.current?.contains(target) || addMenuContentRef.current?.contains(target));
  }, []);

  /**
   * Closes the add-tab menu after a menu item action runs.
   *
   * @param action Optional action triggered by the selected item.
   * @returns Nothing.
   */
  const selectAddMenuAction = React.useCallback(
    (action?: () => void): void => {
      action?.();
      closeAddMenu();
    },
    [closeAddMenu],
  );

  /**
   * Moves keyboard focus to a tab trigger after menu-driven tab creation.
   *
   * @param tabId Tab id whose trigger should receive focus.
   * @returns Nothing.
   */
  const focusTabTriggerById = React.useCallback((tabId: string): void => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const tabElement = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-role="sortable-tab"]')).find(
      (element) => element.dataset.tabId === tabId,
    );
    const triggerElement = tabElement?.querySelector<HTMLElement>('[data-role="tab-trigger"]');
    triggerElement?.focus({ preventScroll: true });
  }, []);

  const handleAddTabToRightSelect = React.useCallback(
    (tabId: string): void => {
      shouldPreventContextMenuCloseAutoFocusRef.current = true;
      pendingContextMenuFocusTabIdRef.current = onAddTabToRight?.(tabId) ?? null;
    },
    [onAddTabToRight],
  );

  const handleTabContextMenuCloseAutoFocus = React.useCallback(
    (event: Event): void => {
      if (!shouldPreventContextMenuCloseAutoFocusRef.current) {
        return;
      }

      event.preventDefault();
      shouldPreventContextMenuCloseAutoFocusRef.current = false;

      const focusTabId = pendingContextMenuFocusTabIdRef.current;
      pendingContextMenuFocusTabIdRef.current = null;
      if (!focusTabId) {
        return;
      }

      window.requestAnimationFrame(() => {
        focusTabTriggerById(focusTabId);
      });
    },
    [focusTabTriggerById],
  );

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
  const hasColoredSshTabVisual = React.useCallback(
    (tab: TabItem | undefined): boolean => {
      return hasServerVisualTabStyle(tab, applySshServerVisuals);
    },
    [applySshServerVisuals],
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
          <div className="relative h-full overflow-hidden rounded-lg">
            <button
              type="button"
              aria-label={t('tabs.scrollLeft')}
              aria-hidden={!canScrollLeft}
              className={classNames(
                'absolute left-0 z-10 h-full rounded-l-lg bg-bg px-1 transition-opacity duration-100 ease-in-out hover:bg-header-tab-hover',
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
              aria-label={t('tabs.scrollRight')}
              aria-hidden={!canScrollRight}
              className={classNames(
                'absolute right-0 z-10 h-full rounded-r-lg bg-bg px-1 transition-opacity duration-100 ease-in-out hover:bg-header-tab-hover',
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
              // @ts-expect-error React.CSSProperties
              style={{ WebkitAppRegion: 'no-drag' }}
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
                              applySshServerVisuals={applySshServerVisuals}
                              onClose={onCloseTab ?? (() => {})}
                              onContextMenu={() => setContextTabId(tab.id)}
                            />
                          </ContextMenuTrigger>
                          <ContextMenuContent onCloseAutoFocus={handleTabContextMenuCloseAutoFocus}>
                            <ContextMenuItem
                              icon={PlusIcon}
                              disabled={!contextTab || !onAddTabToRight}
                              onSelect={() => contextTab && handleAddTabToRightSelect(contextTab.id)}
                            >
                              {t('tabs.newToRight')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              icon={XIcon}
                              disabled={!contextTab?.closable}
                              onSelect={() => contextTab && onCloseTab?.(contextTab.id)}
                            >
                              {t('tabs.closeCurrent')}
                              <ContextMenuShortcut>{closeCurrentTabShortcutLabel}</ContextMenuShortcut>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              icon={XIcon}
                              disabled={!contextTab || orderedTabs.length <= 1}
                              onSelect={() => contextTab && onCloseOtherTabs?.(contextTab.id)}
                            >
                              {t('tabs.closeOthers')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              icon={ChevronRight}
                              disabled={contextTabIndex < 0 || contextTabIndex >= orderedTabs.length - 1}
                              onSelect={() => contextTab && onCloseRightTabs?.(contextTab.id)}
                            >
                              {t('tabs.closeRight')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                        {index < orderedTabs.length - 1 && (
                          <span
                            aria-hidden
                            className={classNames(
                              'h-[16px] w-[2px] shrink-0 bg-header-divider',
                              activeTab === tab.id ||
                                activeTab === orderedTabs[index + 1]?.id ||
                                hasColoredSshTabVisual(tab) ||
                                hasColoredSshTabVisual(orderedTabs[index + 1])
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
                      applySshServerVisuals={applySshServerVisuals}
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
        <DropdownMenu
          modal={false}
          open={isAddMenuOpen}
          onOpenChange={(open) => {
            if (open) {
              openAddMenu();
              return;
            }

            closeAddMenu();
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              ref={addMenuTriggerRef}
              type="button"
              className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-lg hover:bg-header-tab-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-outline"
              aria-label={t('commandPalette.commands.tabs.newTab')}
              aria-haspopup="menu"
              aria-expanded={isAddMenuOpen}
              aria-controls={isAddMenuOpen ? addMenuContentId : undefined}
              // @ts-expect-error React.CSSProperties
              style={{ WebkitAppRegion: 'no-drag' }}
              onPointerDown={(event) => {
                if (event.button === 0) {
                  event.preventDefault();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onAddTab?.();
                }
              }}
              onClick={onAddTab}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openAddMenu();
              }}
              onFocus={() => {
                scheduleAddMenuOpen();
              }}
              onBlur={(event) => {
                if (isAddMenuFocusTarget(event.relatedTarget)) {
                  return;
                }

                if (isAddMenuOpen) {
                  closeAddMenu();
                  return;
                }

                clearAddMenuOpenTimer();
              }}
              onPointerEnter={() => {
                isPointerInsideAddMenuTriggerRef.current = true;
                scheduleAddMenuOpen();
              }}
              onPointerLeave={() => {
                isPointerInsideAddMenuTriggerRef.current = false;
                scheduleAddMenuCloseWhenPointerLeaves();
              }}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            ref={addMenuContentRef}
            id={addMenuContentId}
            side="bottom"
            align="center"
            sideOffset={6}
            className="w-[220px]"
            onPointerEnter={() => {
              isPointerInsideAddMenuContentRef.current = true;
              clearAddMenuCloseTimer();
            }}
            onPointerLeave={() => {
              isPointerInsideAddMenuContentRef.current = false;
              scheduleAddMenuCloseWhenPointerLeaves();
            }}
            onCloseAutoFocus={(event) => {
              if (!addMenuTriggerRef.current?.contains(document.activeElement)) {
                event.preventDefault();
              }
            }}
          >
            <DropdownMenuItem
              icon={Command}
              onSelect={() => selectAddMenuAction(onOpenCommandPalette)}
            >
              {t('tabs.addMenu.commandPalette')}
              <DropdownMenuShortcut>{commandPaletteShortcutLabel}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={Server}
              onSelect={() => selectAddMenuAction(onAddServerTab ?? onAddTab)}
            >
              {t('tabs.addMenu.server')}
              <DropdownMenuShortcut>{newServerTabShortcutLabel}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={KeyRound}
              onSelect={() => selectAddMenuAction(onAddKeychainTab)}
            >
              {t('tabs.addMenu.keychain')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={CornerUpRight}
              onSelect={() => selectAddMenuAction(onAddPortForwardTab)}
            >
              {t('tabs.addMenu.portForwarding')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </RadixTabs.Root>
  );
};
