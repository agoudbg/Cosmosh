import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import classNames from 'classnames';
import { Palette, Search } from 'lucide-react';
import React from 'react';

import {
  EntityColorKey,
  entityColorKeys,
  EntityVisual,
  getEntityColorClassName,
  lucideIconNames,
  renderEntityIcon,
} from '../../lib/entity-visuals';
import { useDirectionalNavigation } from '../../lib/use-directional-navigation';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';

type EntityVisualPickerProps = {
  visual: EntityVisual;
  label: string;
  onChange: (nextVisual: EntityVisual) => void;
  children?: React.ReactNode;
};

const ICON_GRID_COLUMNS = 8;
const ICON_GRID_GAP_PX = 4;
const ICON_GRID_ITEM_SIZE_PX = 32;
const ICON_GRID_OVERSCAN_ROWS = 2;
/**
 * Grace period before unmounting the virtual icon grid after close.
 *
 * Matches the shared `menuStyles.contentCloseMotion` exit animation (duration-150)
 * with a small buffer, so the grid never flashes empty while the menu is still
 * visibly animating out.
 */
const CLOSE_MOTION_UNMOUNT_DELAY_MS = 200;

/**
 * Resolves arrow-key movement inside the fixed eight-column icon grid.
 *
 * @param currentIndex Current active icon index.
 * @param key Arrow key pressed by the user.
 * @param itemCount Total filtered icon count.
 * @returns The next active icon index without wrapping across row edges.
 */
const resolveIconNeighborIndex = (currentIndex: number, key: string, itemCount: number): number => {
  if (itemCount <= 0) {
    return 0;
  }

  const normalizedIndex = Math.min(Math.max(0, currentIndex), itemCount - 1);
  if (key === 'ArrowRight') {
    const isRowEnd = (normalizedIndex + 1) % ICON_GRID_COLUMNS === 0;
    return isRowEnd || normalizedIndex + 1 >= itemCount ? normalizedIndex : normalizedIndex + 1;
  }

  if (key === 'ArrowLeft') {
    return normalizedIndex % ICON_GRID_COLUMNS === 0 ? normalizedIndex : normalizedIndex - 1;
  }

  if (key === 'ArrowDown') {
    const currentRow = Math.floor(normalizedIndex / ICON_GRID_COLUMNS);
    const lastRow = Math.floor((itemCount - 1) / ICON_GRID_COLUMNS);
    return currentRow >= lastRow ? normalizedIndex : Math.min(normalizedIndex + ICON_GRID_COLUMNS, itemCount - 1);
  }

  if (key === 'ArrowUp') {
    return normalizedIndex < ICON_GRID_COLUMNS ? normalizedIndex : normalizedIndex - ICON_GRID_COLUMNS;
  }

  return normalizedIndex;
};

const EntityVisualPicker: React.FC<EntityVisualPickerProps> = ({ visual, label, onChange, children }) => {
  const [query, setQuery] = React.useState<string>('');
  const [isOpen, setIsOpen] = React.useState<boolean>(false);
  const [activeIconIndex, setActiveIconIndex] = React.useState<number>(0);
  const [focusedIconIndex, setFocusedIconIndex] = React.useState<number | null>(null);
  const [iconViewportElement, setIconViewportElement] = React.useState<HTMLDivElement | null>(null);
  const wasOpenRef = React.useRef<boolean>(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const colorButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const iconButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const pendingIconFocusIndexRef = React.useRef<number | null>(null);

  const filteredIcons = React.useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return lucideIconNames;
    }

    return lucideIconNames.filter((iconName) => iconName.toLowerCase().includes(keyword));
  }, [query]);

  const selectedColorIndex = React.useMemo(() => {
    return Math.max(entityColorKeys.indexOf(visual.colorKey), 0);
  }, [visual.colorKey]);

  const selectedIconIndex = React.useMemo(() => {
    const matchedIndex = filteredIcons.indexOf(visual.iconKey);
    return matchedIndex >= 0 ? matchedIndex : 0;
  }, [filteredIcons, visual.iconKey]);

  const iconRowCount = Math.ceil(filteredIcons.length / ICON_GRID_COLUMNS);

  /**
   * Keeps the virtual grid alive until the shared close motion finishes.
   *
   * The dropdown content is force-mounted and animates out over ~150ms, so
   * disabling the virtualizer on `isOpen === false` would blank the grid while
   * the menu is still visibly fading out.
   */
  const [isIconGridActive, setIsIconGridActive] = React.useState<boolean>(isOpen);
  React.useEffect(() => {
    if (isOpen) {
      setIsIconGridActive(true);
      return;
    }

    const unmountTimer = window.setTimeout(() => setIsIconGridActive(false), CLOSE_MOTION_UNMOUNT_DELAY_MS);
    return () => window.clearTimeout(unmountTimer);
  }, [isOpen]);

  /** Keeps the DOM-owned focus row mounted when pointer scrolling moves it outside the visible range. */
  const extractIconRowRange = React.useCallback(
    (range: Range): number[] => {
      const rowIndexes = defaultRangeExtractor(range);
      if (focusedIconIndex === null) {
        return rowIndexes;
      }

      const focusedRowIndex = Math.floor(focusedIconIndex / ICON_GRID_COLUMNS);
      if (focusedRowIndex >= iconRowCount || rowIndexes.includes(focusedRowIndex)) {
        return rowIndexes;
      }

      return [...rowIndexes, focusedRowIndex].sort((left, right) => left - right);
    },
    [focusedIconIndex, iconRowCount],
  );

  const iconRowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: iconRowCount,
    enabled: isIconGridActive,
    estimateSize: () => ICON_GRID_ITEM_SIZE_PX,
    gap: ICON_GRID_GAP_PX,
    getScrollElement: () => iconViewportElement,
    overscan: ICON_GRID_OVERSCAN_ROWS,
    rangeExtractor: extractIconRowRange,
  });
  const virtualIconRows = iconRowVirtualizer.getVirtualItems();

  const onPickColor = React.useCallback(
    (colorKey: EntityColorKey) => {
      onChange({ ...visual, colorKey });
    },
    [onChange, visual],
  );

  const onPickIcon = React.useCallback(
    (iconKey: string) => {
      onChange({ ...visual, iconKey });
    },
    [onChange, visual],
  );

  const colorNavigation = useDirectionalNavigation({
    itemCount: entityColorKeys.length,
    columns: entityColorKeys.length,
    initialIndex: selectedColorIndex,
  });
  const setColorActiveIndex = colorNavigation.setActiveIndex;
  const focusColorItem = colorNavigation.focusItem;

  React.useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (!isOpen) {
      return;
    }

    setColorActiveIndex(selectedColorIndex);

    if (!wasOpen) {
      requestAnimationFrame(() => {
        focusColorItem(selectedColorIndex);
      });
    }
  }, [focusColorItem, isOpen, selectedColorIndex, setColorActiveIndex]);

  /**
   * Scrolls an icon row into the viewport through TanStack Virtual.
   *
   * @param iconIndex Filtered icon index to reveal.
   * @returns void.
   */
  const revealIcon = React.useCallback(
    (iconIndex: number): void => {
      if (filteredIcons.length === 0) {
        return;
      }

      const normalizedIndex = Math.min(Math.max(0, iconIndex), filteredIcons.length - 1);
      iconRowVirtualizer.scrollToIndex(Math.floor(normalizedIndex / ICON_GRID_COLUMNS), { align: 'auto' });
    },
    [filteredIcons.length, iconRowVirtualizer],
  );

  /**
   * Focuses an icon after ensuring TanStack Virtual has mounted its row.
   *
   * @param iconIndex Filtered icon index to focus.
   * @returns void.
   */
  const focusIcon = React.useCallback(
    (iconIndex: number): void => {
      if (filteredIcons.length === 0) {
        return;
      }

      const nextIndex = Math.min(Math.max(0, iconIndex), filteredIcons.length - 1);
      setActiveIconIndex(nextIndex);
      const mountedButton = iconButtonRefs.current[nextIndex];
      if (mountedButton) {
        revealIcon(nextIndex);
        mountedButton.focus();
        return;
      }

      pendingIconFocusIndexRef.current = nextIndex;
      revealIcon(nextIndex);
    },
    [filteredIcons.length, revealIcon],
  );

  React.useLayoutEffect(() => {
    if (!isOpen) {
      pendingIconFocusIndexRef.current = null;
      return;
    }

    const pendingIconFocusIndex = pendingIconFocusIndexRef.current;
    if (pendingIconFocusIndex === null) {
      return;
    }

    const mountedButton = iconButtonRefs.current[pendingIconFocusIndex];
    if (!mountedButton) {
      return;
    }

    pendingIconFocusIndexRef.current = null;
    mountedButton.focus();
  }, [isOpen, virtualIconRows]);

  React.useEffect(() => {
    if (!isOpen) {
      pendingIconFocusIndexRef.current = null;
      setFocusedIconIndex(null);
      return;
    }

    pendingIconFocusIndexRef.current = null;
    setActiveIconIndex(selectedIconIndex);
    revealIcon(selectedIconIndex);
  }, [isOpen, revealIcon, selectedIconIndex]);

  /**
   * Synchronizes menu state while preventing delayed virtual focus from overriding Radix close autofocus.
   *
   * @param nextOpen Next controlled dropdown state.
   * @returns void.
   */
  const handleOpenChange = React.useCallback((nextOpen: boolean): void => {
    if (!nextOpen) {
      pendingIconFocusIndexRef.current = null;
      setFocusedIconIndex(null);
    }

    setIsOpen(nextOpen);
  }, []);

  const getSelectedColorButton = React.useCallback((): HTMLButtonElement | null => {
    return colorButtonRefs.current[selectedColorIndex] ?? null;
  }, [selectedColorIndex]);

  React.useEffect(() => {
    colorButtonRefs.current = colorButtonRefs.current.slice(0, entityColorKeys.length);
  }, []);

  React.useEffect(() => {
    iconButtonRefs.current = iconButtonRefs.current.slice(0, filteredIcons.length);
  }, [filteredIcons.length]);

  const isFocusTargetInRefs = React.useCallback(
    (refs: Array<HTMLElement | null>, target: HTMLElement): boolean => refs.some((node) => node === target),
    [],
  );

  /**
   * Moves focus inside the virtual icon grid while keeping arrow keys scoped to the picker.
   *
   * @param event Icon button keyboard event.
   * @param iconIndex Filtered icon index that currently owns focus.
   * @returns void.
   */
  const handleIconKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, iconIndex: number): void => {
      if (event.currentTarget !== event.target) {
        return;
      }

      if (
        event.key !== 'ArrowUp' &&
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowRight'
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextIndex = resolveIconNeighborIndex(iconIndex, event.key, filteredIcons.length);
      if (nextIndex !== iconIndex) {
        focusIcon(nextIndex);
      }
    },
    [filteredIcons.length, focusIcon],
  );

  const onContentKeyDownCapture = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Tab') {
        return;
      }

      const target = event.target as HTMLElement;
      const isColorTarget = isFocusTargetInRefs(colorButtonRefs.current, target);
      const isIconTarget = isFocusTargetInRefs(iconButtonRefs.current, target);
      const isSearchTarget = searchInputRef.current === target;

      if (isColorTarget && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        searchInputRef.current?.focus();
        return;
      }

      if (isSearchTarget) {
        if (event.shiftKey) {
          const selectedColorButton = getSelectedColorButton();
          if (!selectedColorButton) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          selectedColorButton.focus();
          return;
        }

        if (filteredIcons.length === 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        focusIcon(activeIconIndex);
        return;
      }

      if (isIconTarget && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        searchInputRef.current?.focus();
      }
    },
    [activeIconIndex, filteredIcons.length, focusIcon, getSelectedColorButton, isFocusTargetInRefs],
  );

  return (
    <DropdownMenu
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuTrigger asChild>
        {children ?? (
          <Button
            variant="ghost"
            className="h-8 gap-1.5 px-2"
            aria-label={label}
          >
            <Palette size={14} />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        horizontalAlign="left"
        className="w-[340px] p-2"
        onKeyDownCapture={onContentKeyDownCapture}
      >
        <div className="m-1 mb-2 flex flex-wrap gap-2">
          {entityColorKeys.map((colorKey, colorIndex) => {
            const isActive = colorKey === visual.colorKey;
            const colorNavigationItemProps = colorNavigation.getItemProps(colorIndex);
            return (
              <button
                key={colorKey}
                type="button"
                aria-label={colorKey}
                {...colorNavigationItemProps}
                ref={(node) => {
                  colorNavigationItemProps.ref(node);
                  colorButtonRefs.current[colorIndex] = node;
                }}
                className={classNames(
                  'border-home-divider/60 h-6 w-6 rounded-full',
                  getEntityColorClassName(colorKey),
                  isActive && 'ring-1 ring-offset-1 ring-offset-transparent',
                )}
                onClick={() => onPickColor(colorKey)}
              />
            );
          })}
        </div>

        <div className="relative mb-2">
          <Input
            ref={searchInputRef}
            value={query}
            placeholder={label}
            className="h-8 pr-8"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Search className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
        </div>

        <div
          ref={setIconViewportElement}
          className="max-h-[260px] overflow-auto pr-1"
        >
          <div
            className="relative"
            style={{ height: iconRowVirtualizer.getTotalSize() }}
          >
            {virtualIconRows.map((virtualRow) => {
              const rowStartIndex = virtualRow.index * ICON_GRID_COLUMNS;
              const rowIcons = filteredIcons.slice(rowStartIndex, rowStartIndex + ICON_GRID_COLUMNS);
              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 top-0 grid grid-cols-[repeat(8,32px)] gap-1"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {rowIcons.map((iconKey, columnIndex) => {
                    const iconIndex = rowStartIndex + columnIndex;
                    const isActive = iconKey === visual.iconKey;
                    return (
                      <button
                        key={iconKey}
                        ref={(node) => {
                          iconButtonRefs.current[iconIndex] = node;
                        }}
                        type="button"
                        tabIndex={iconIndex === activeIconIndex ? 0 : -1}
                        className={classNames(
                          'flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-form-control-hover',
                          isActive && 'bg-form-control-hover !text-text',
                        )}
                        aria-label={iconKey}
                        aria-pressed={isActive}
                        onBlur={() => setFocusedIconIndex(null)}
                        onFocus={() => {
                          setActiveIconIndex(iconIndex);
                          setFocusedIconIndex(iconIndex);
                        }}
                        onKeyDown={(event) => handleIconKeyDown(event, iconIndex)}
                        onClick={() => onPickIcon(iconKey)}
                      >
                        {renderEntityIcon(iconKey)}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default EntityVisualPicker;
