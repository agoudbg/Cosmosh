import React from 'react';

import { useDirectionalNavigation } from '../../lib/use-directional-navigation';
import { Button } from './button';

/**
 * One selectable entry of a {@link SidebarNav} vertical navigation list.
 */
export type SidebarNavItem<TId extends string = string> = {
  /** Stable identifier reported through selection callbacks. */
  id: TId;
  /** Visible item label. */
  label: string;
  /** Optional leading icon node rendered before the label. */
  icon?: React.ReactNode;
};

export type SidebarNavProps<TId extends string = string> = {
  /** Ordered entries rendered as full-width navigation buttons. */
  items: SidebarNavItem<TId>[];
  /** Id of the entry that represents the currently displayed view. */
  activeId: TId;
  /** Accessible name for the navigation landmark. */
  ariaLabel: string;
  /** Optional class name applied to the navigation landmark element. */
  className?: string;
  /**
   * Called when an entry is activated by pointer or keyboard.
   *
   * @param id Id of the activated entry.
   * @returns Nothing.
   */
  onSelect: (id: TId) => void;
};

/**
 * Vertical sidebar navigation list with roving-focus arrow-key navigation.
 *
 * The list is a labelled `nav` landmark of plain buttons: `Tab` enters the
 * list once at the active entry, `ArrowUp`/`ArrowDown` move focus between
 * entries through the shared directional-navigation hook, and `Enter`/`Space`
 * activate the focused entry via native button semantics. The active entry
 * exposes `aria-current="page"` so assistive technology announces which view
 * is currently displayed.
 *
 * @param props See {@link SidebarNavProps}.
 * @returns Navigation landmark element.
 */
export const SidebarNav = <TId extends string = string>({
  items,
  activeId,
  ariaLabel,
  className,
  onSelect,
}: SidebarNavProps<TId>): React.ReactElement => {
  const activeIndex = React.useMemo(() => {
    const index = items.findIndex((item) => item.id === activeId);
    return index >= 0 ? index : 0;
  }, [items, activeId]);

  const navigation = useDirectionalNavigation({
    columns: 1,
    initialIndex: activeIndex,
    itemCount: items.length,
  });

  const { setActiveIndex } = navigation;

  React.useEffect(() => {
    // Keep the roving tab stop on the selected entry so Tab re-enters the list
    // at the active view after selection changes outside arrow-key navigation
    // (e.g. pointer click or external state updates).
    setActiveIndex(activeIndex);
  }, [activeIndex, setActiveIndex]);

  return (
    <nav
      aria-label={ariaLabel}
      className={className}
    >
      <ul>
        {items.map((item, index) => (
          <li key={item.id}>
            <Button
              {...navigation.getItemProps(index)}
              variant={item.id === activeId ? 'default' : 'ghost'}
              aria-current={item.id === activeId ? 'page' : undefined}
              className="w-full !justify-start"
              onClick={() => onSelect(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
