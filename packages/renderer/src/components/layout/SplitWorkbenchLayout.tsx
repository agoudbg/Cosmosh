import React from 'react';

type SplitWorkbenchLayoutProps = {
  topSlot?: React.ReactNode;
  sidebar: React.ReactNode;
  main: React.ReactNode;
  children?: React.ReactNode;
  sidebarClassName?: string;
  mainClassName?: string;
};

type SplitWorkbenchMainPanelMode = 'content-scroll' | 'panel-scroll';

type SplitWorkbenchMainPanelProps = {
  header: React.ReactNode;
  body: React.ReactNode;
  mode?: SplitWorkbenchMainPanelMode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  /**
   * Ref attached to the scrollable body wrapper in `content-scroll` mode.
   *
   * Virtualized pages use this to wire TanStack Virtual's `getScrollElement`
   * to the real scroll container instead of relying on DOM traversal.
   * Ignored when `bodyClassName` removes the wrapper entirely.
   */
  bodyRef?: React.Ref<HTMLDivElement>;
};

/**
 * Shared two-pane workbench layout used by editor-like pages.
 *
 * @param props Layout slots and optional class overrides for pane wrappers.
 * @returns A page scaffold with optional top slot, sidebar pane, divider, and main pane.
 */
const SplitWorkbenchLayout: React.FC<SplitWorkbenchLayoutProps> = ({
  topSlot,
  sidebar,
  main,
  children,
  sidebarClassName,
  mainClassName,
}) => {
  const resolvedSidebarClassName = sidebarClassName ?? 'flex h-full w-[250px] shrink-0 flex-col';
  const resolvedMainClassName = mainClassName ?? 'flex min-h-0 min-w-0 flex-1 flex-col pl-2';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 py-2">
      {topSlot ? topSlot : null}

      <div className="flex min-h-0 flex-1 gap-3.5">
        <aside className={resolvedSidebarClassName}>{sidebar}</aside>

        <div className="w-px shrink-0 bg-home-divider" />

        <main className={resolvedMainClassName}>{main}</main>
      </div>

      {children}
    </div>
  );
};

/**
 * Shared right-side main panel with configurable scrolling behavior.
 *
 * @param props Header/body slots, optional wrapper class overrides, and an optional body wrapper ref.
 * @returns A main panel that supports fixed-header or unified-scroll layouts.
 */
export const SplitWorkbenchMainPanel: React.FC<SplitWorkbenchMainPanelProps> = ({
  header,
  body,
  mode = 'content-scroll',
  className,
  headerClassName,
  bodyClassName,
  bodyRef,
}) => {
  const isContentScroll = mode === 'content-scroll';
  const resolvedClassName =
    className ??
    (isContentScroll ? 'flex min-h-0 min-w-0 flex-1 flex-col pl-2' : 'min-h-0 min-w-0 flex-1 overflow-auto pl-2');
  const resolvedHeaderClassName = headerClassName ?? (isContentScroll ? 'shrink-0 bg-bg pb-2' : 'pb-4');
  const resolvedBodyClassName =
    bodyClassName ?? (isContentScroll ? 'scrollbar-gutter-stable -me-2 min-h-0 flex-1 overflow-auto' : '');

  return (
    <div className={resolvedClassName}>
      <div className={resolvedHeaderClassName}>{header}</div>
      {resolvedBodyClassName ? (
        <div
          ref={bodyRef}
          className={resolvedBodyClassName}
        >
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
};

export default SplitWorkbenchLayout;
