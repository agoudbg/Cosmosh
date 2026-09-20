/** Maximum number of decorative command lines shown in the timeline entry. */
export const COMMAND_TIMELINE_ENTRY_ITEM_LIMIT = 8;

/** Width reserved for the recent-command entry beside xterm's scrollbar. */
export const COMMAND_TIMELINE_RAIL_WIDTH_PX = 34;

/** Width of xterm's compact vertical scrollbar. */
export const COMMAND_TIMELINE_SCROLLBAR_WIDTH_PX = 6;

/** Width of each decorative line in the compact recent-command entry. */
export const COMMAND_TIMELINE_ENTRY_LINE_WIDTH_PX = 12;

/** Height of each decorative line in the compact recent-command entry. */
export const COMMAND_TIMELINE_ENTRY_LINE_HEIGHT_PX = 2;

/** Vertical gap between decorative lines in the compact recent-command entry. */
export const COMMAND_TIMELINE_ENTRY_LINE_GAP_PX = 10;

/** Pointer padding above and below the visible recent-command line group. */
export const COMMAND_TIMELINE_ENTRY_HIT_PADDING_PX = 8;

/** Inactivity window after which the command timeline entry fades away. */
export const COMMAND_TIMELINE_IDLE_TIMEOUT_MS = 5_000;

/** Grace window for crossing between the inline trigger and portaled menu. */
export const COMMAND_TIMELINE_POINTER_LEAVE_GRACE_MS = 80;

/** Maximum command rows mounted in the expanded recent-command menu. */
export const COMMAND_TIMELINE_MENU_ITEM_LIMIT = 100;

/**
 * Selects the newest commands rendered inside the expanded menu.
 *
 * Marker survival inside scrollback is the only other bound (10k+ rows by
 * default), and the menu is hover-opened, so mounting thousands of rows would
 * jank exactly the interaction that must feel instant.
 *
 * @param items Complete command collection in submission order.
 * @returns At most the newest hundred commands, preserving submission order.
 */
export const selectCommandTimelineMenuItems = <T>(items: readonly T[]): T[] =>
  items.slice(-COMMAND_TIMELINE_MENU_ITEM_LIMIT);

/**
 * Selects the newest commands represented by the compact timeline entry.
 *
 * The expanded menu still receives its own larger projection. Keeping these
 * projections separate prevents the visual cap from truncating navigation.
 *
 * @param items Complete command collection in submission order.
 * @returns At most the newest eight commands, preserving submission order.
 */
export const selectCommandTimelineEntryItems = <T>(items: readonly T[]): T[] =>
  items.slice(-COMMAND_TIMELINE_ENTRY_ITEM_LIMIT);

/**
 * Resolves the exact collapsed height used by both the line group and card morph.
 *
 * @param itemCount Number of retained commands represented by the compact entry.
 * @returns Pixel height of at most eight lines and their intervening gaps.
 */
export const resolveCommandTimelineEntryHeight = (itemCount: number): number => {
  const normalizedItemCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  const visibleItemCount = Math.min(COMMAND_TIMELINE_ENTRY_ITEM_LIMIT, normalizedItemCount);
  if (visibleItemCount === 0) {
    return 0;
  }

  return (
    visibleItemCount * COMMAND_TIMELINE_ENTRY_LINE_HEIGHT_PX +
    (visibleItemCount - 1) * COMMAND_TIMELINE_ENTRY_LINE_GAP_PX
  );
};

/**
 * Resolves the compact pointer target without turning the full rail into a hotspot.
 *
 * @param itemCount Number of retained commands represented by the compact entry.
 * @returns Pixel height of the visible line group plus vertical pointer padding.
 */
export const resolveCommandTimelineEntryHitHeight = (itemCount: number): number => {
  const entryHeight = resolveCommandTimelineEntryHeight(itemCount);
  return entryHeight === 0 ? 0 : entryHeight + COMMAND_TIMELINE_ENTRY_HIT_PADDING_PX * 2;
};

/**
 * Calculates how long the activity timer should wait before its next check.
 *
 * @param lastActivityAt Timestamp of the latest terminal input or pointer movement.
 * @param now Current timestamp.
 * @returns Remaining idle delay in milliseconds, clamped to the configured window.
 */
export const resolveCommandTimelineIdleDelay = (lastActivityAt: number, now: number): number => {
  const elapsed = Math.max(0, now - lastActivityAt);
  return Math.max(0, COMMAND_TIMELINE_IDLE_TIMEOUT_MS - elapsed);
};

/**
 * Resolves whether the compact entry should be exposed to sighted and keyboard users.
 *
 * @param historyVisible Whether trusted command markers are available in the normal buffer.
 * @param activityVisible Whether the pane has recent pointer or input activity.
 * @param menuOpen Whether either recent-command menu is open.
 * @returns `true` when the entry should remain visually and accessibly exposed.
 */
export const shouldShowCommandTimelineEntry = (
  historyVisible: boolean,
  activityVisible: boolean,
  menuOpen: boolean,
): boolean => historyVisible && (activityVisible || menuOpen);

/**
 * Resolves whether the compact entry keeps its pointer hit target enabled.
 *
 * Idle visibility must not disable the target because browsers do not emit a
 * fresh `pointerenter` when an enabled element appears beneath a resting cursor.
 * The trusted-history flag already excludes empty and alternate-screen states.
 *
 * @param historyVisible Whether trusted command history is available in the normal buffer.
 * @returns `true` while the compact pointer target should remain interactive.
 */
export const shouldAllowCommandTimelineEntryPointerEvents = (historyVisible: boolean): boolean => historyVisible;

/**
 * Resolves whether pointer-leave handling may dismiss the timeline surface.
 *
 * An open row action menu owns the dismissal lifecycle of both Portals. This
 * prevents a pointer transition that skips the action-menu Portal from
 * closing the command list before Radix can process the explicit action-menu
 * close path.
 *
 * @param pointerInsideTrigger Whether the pointer is inside the compact rail entry.
 * @param pointerInsideContent Whether the pointer is inside the command list.
 * @param actionMenuOpen Whether a row action context menu is open.
 * @param pointerInsideActionMenu Whether the pointer is inside the row action menu.
 * @returns `true` when pointer leave should close the timeline surface.
 */
export const shouldDismissCommandTimelineForPointerLeave = (
  pointerInsideTrigger: boolean,
  pointerInsideContent: boolean,
  actionMenuOpen: boolean,
  pointerInsideActionMenu: boolean,
): boolean => !actionMenuOpen && !pointerInsideTrigger && !pointerInsideContent && !pointerInsideActionMenu;
