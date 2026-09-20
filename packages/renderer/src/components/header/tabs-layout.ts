const MIN_TAB_WIDTH = 120;
const TAB_DIVIDER_WIDTH = 2;

/** Default width used before the tab-list container reports its size. */
export const DEFAULT_TAB_WIDTH = 180;

/**
 * Calculates the uniform tab width for the available tab-list space.
 *
 * The tab list reserves one divider between each adjacent pair of tabs. Those
 * fixed-width dividers must be removed before distributing the remaining space
 * across the tabs; otherwise a narrow set of widths can create overflow even
 * when all tabs should fit without scrolling.
 *
 * @param availableWidth Width of the tab-list scroll container in pixels.
 * @param tabCount Number of tabs in the list.
 * @returns Clamped uniform tab width in pixels.
 */
export const resolveTabWidth = (availableWidth: number, tabCount: number): number => {
  const safeTabCount = Math.max(tabCount, 1);
  const dividerWidth = Math.max(safeTabCount - 1, 0) * TAB_DIVIDER_WIDTH;
  const tabSpace = Math.max(availableWidth - dividerWidth, 0);
  const targetWidth = Math.floor(tabSpace / safeTabCount);

  return Math.max(MIN_TAB_WIDTH, Math.min(DEFAULT_TAB_WIDTH, targetWidth));
};
