import React from 'react';

type DirectionalNavigationOptions = {
  itemCount: number;
  columns?: number;
  initialIndex?: number;
};

type DirectionalNavigationItemProps = {
  ref: (node: HTMLDivElement | null) => void;
  tabIndex: number;
  onFocus: React.FocusEventHandler<HTMLDivElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
};

const clampIndex = (value: number, itemCount: number): number => {
  if (itemCount <= 0) {
    return 0;
  }

  return Math.min(Math.max(value, 0), itemCount - 1);
};

export const useDirectionalNavigation = ({
  itemCount,
  columns = 1,
  initialIndex = 0,
}: DirectionalNavigationOptions) => {
  const [activeIndex, setActiveIndex] = React.useState<number>(() => clampIndex(initialIndex, itemCount));
  const itemRefs = React.useRef<Array<HTMLDivElement | null>>([]);

  React.useEffect(() => {
    setActiveIndex((previous) => clampIndex(previous, itemCount));
  }, [itemCount]);

  const focusItem = React.useCallback(
    (index: number) => {
      const nextIndex = clampIndex(index, itemCount);
      const target = itemRefs.current[nextIndex];
      if (!target) {
        return;
      }

      target.focus();
      setActiveIndex(nextIndex);
    },
    [itemCount],
  );

  const resolveNextIndex = React.useCallback(
    (currentIndex: number, key: string): number => {
      if (itemCount <= 0) {
        return 0;
      }

      const normalizedColumns = Math.max(columns, 1);

      if (key === 'ArrowRight') {
        const isRowEnd = (currentIndex + 1) % normalizedColumns === 0;
        if (isRowEnd || currentIndex + 1 >= itemCount) {
          return currentIndex;
        }

        return currentIndex + 1;
      }

      if (key === 'ArrowLeft') {
        const isRowStart = currentIndex % normalizedColumns === 0;
        if (isRowStart) {
          return currentIndex;
        }

        return currentIndex - 1;
      }

      if (key === 'ArrowDown') {
        const nextIndex = currentIndex + normalizedColumns;
        return nextIndex >= itemCount ? currentIndex : nextIndex;
      }

      if (key === 'ArrowUp') {
        const nextIndex = currentIndex - normalizedColumns;
        return nextIndex < 0 ? currentIndex : nextIndex;
      }

      return currentIndex;
    },
    [columns, itemCount],
  );

  const getItemProps = React.useCallback(
    (index: number): DirectionalNavigationItemProps => {
      return {
        ref: (node) => {
          itemRefs.current[index] = node;
        },
        tabIndex: index === activeIndex ? 0 : -1,
        onFocus: () => {
          setActiveIndex(index);
        },
        onKeyDown: (event) => {
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
          const nextIndex = resolveNextIndex(index, event.key);
          focusItem(nextIndex);
        },
      };
    },
    [activeIndex, focusItem, resolveNextIndex],
  );

  return {
    activeIndex,
    setActiveIndex,
    getItemProps,
  };
};
