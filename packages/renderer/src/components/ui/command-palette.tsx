import classNames from 'classnames';
import { Search } from 'lucide-react';
import React from 'react';

import { Input } from './input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

type CommandPaletteAction = {
  key: string;
  icon: React.ReactNode;
  tooltip?: string;
  onSelect: () => void;
};

type CommandPaletteItem = {
  key: string;
  title: string;
  titleTooltip?: string;
  subtitle?: string;
  icon?: React.ReactNode;
  rowClassName?: string;
  actions?: CommandPaletteAction[];
  onSelect: () => void;
};

type CommandPaletteProps = {
  query: string;
  placeholder?: string;
  items: CommandPaletteItem[];
  activeIndex?: number;
  emptyText?: string;
  showInput?: boolean;
  open?: boolean;
  topOffset?: number;
  inputLeadingIcon?: React.ReactNode;
  metadataLayout?: 'stacked' | 'inline';
  hideItemList?: boolean;
  footer?: React.ReactNode;
  closeOnEsc?: boolean;
  onInputArrowUp?: () => void;
  onInputArrowDown?: () => void;
  onActiveIndexChange?: (index: number) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  onQueryChange: (query: string) => void;
};

/**
 * Command palette for high-density quick actions.
 * It is center-aligned on the x-axis and offset from the top edge to match tab-area behavior.
 */
const CommandPalette: React.FC<CommandPaletteProps> = ({
  query,
  placeholder = 'Type a command',
  items,
  activeIndex: activeIndexProp,
  emptyText = 'No matching commands',
  showInput = true,
  open = true,
  topOffset = 50,
  inputLeadingIcon,
  metadataLayout = 'stacked',
  hideItemList = false,
  footer,
  closeOnEsc = false,
  onInputArrowUp,
  onInputArrowDown,
  onActiveIndexChange,
  onOpenChange,
  className,
  onQueryChange,
}) => {
  const [internalActiveIndex, setInternalActiveIndex] = React.useState<number>(0);
  const [rendered, setRendered] = React.useState<boolean>(open);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const itemRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());
  const lastMouseInteractionAtRef = React.useRef<number>(0);
  const lastKeyboardInteractionAtRef = React.useRef<number>(0);

  const markKeyboardInteraction = React.useCallback((): void => {
    lastKeyboardInteractionAtRef.current = Date.now();
  }, []);

  const recordMouseInteraction = React.useCallback((event: React.PointerEvent): void => {
    if (event.pointerType && event.pointerType !== 'mouse') {
      return;
    }

    lastMouseInteractionAtRef.current = Date.now();
    lastKeyboardInteractionAtRef.current = 0;
  }, []);

  const shouldActivateByHover = React.useCallback((): boolean => {
    const now = Date.now();
    const mouseRecent = now - lastMouseInteractionAtRef.current < 250;
    const keyboardRecent = lastKeyboardInteractionAtRef.current > 0 && now - lastKeyboardInteractionAtRef.current < 250;

    return mouseRecent && !keyboardRecent;
  }, []);

  const activeIndex = React.useMemo(() => {
    const base = typeof activeIndexProp === 'number' ? activeIndexProp : internalActiveIndex;

    if (items.length === 0) {
      return 0;
    }

    return Math.max(0, Math.min(base, items.length - 1));
  }, [activeIndexProp, internalActiveIndex, items.length]);

  const setActiveIndex = React.useCallback(
    (next: number | ((previous: number) => number)) => {
      const nextValue = typeof next === 'function' ? next(activeIndex) : next;
      const resolved = items.length === 0 ? 0 : Math.max(0, Math.min(nextValue, items.length - 1));

      if (typeof activeIndexProp !== 'number') {
        setInternalActiveIndex(resolved);
      }

      onActiveIndexChange?.(resolved);
    },
    [activeIndex, activeIndexProp, items.length, onActiveIndexChange],
  );

  const getActiveActionButtons = React.useCallback((): HTMLButtonElement[] => {
    const panelNode = panelRef.current;
    if (!panelNode) {
      return [];
    }

    return Array.from(
      panelNode.querySelectorAll<HTMLButtonElement>('button[data-command-action="true"][data-command-active="true"]'),
    );
  }, []);

  React.useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }

    const timer = window.setTimeout(() => {
      setRendered(false);
    }, 140);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  React.useEffect(() => {
    if (items.length === 0) {
      setActiveIndex(0);
      return;
    }

    setActiveIndex((previous) => Math.min(previous, items.length - 1));
  }, [items, setActiveIndex]);

  React.useEffect(() => {
    if (!open || !rendered) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (showInput) {
        inputRef.current?.focus({ preventScroll: true });
        return;
      }

      panelRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [getActiveActionButtons, open, rendered, showInput]);

  /**
   * Auto-scroll the active item into view when navigating with keyboard arrows
   */
  React.useEffect(() => {
    const activeItemElement = itemRefs.current.get(activeIndex);
    if (!activeItemElement || !open || !rendered) {
      return;
    }

    activeItemElement.scrollIntoView({
      block: 'nearest',
    });
  }, [activeIndex, open, rendered]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape' && closeOnEsc) {
        event.preventDefault();
        onOpenChange?.(false);
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        markKeyboardInteraction();
        event.preventDefault();
        if (event.key === 'ArrowDown' && onInputArrowDown) {
          onInputArrowDown();
          return;
        }

        if (event.key === 'ArrowUp' && onInputArrowUp) {
          onInputArrowUp();
          return;
        }

        if (items.length === 0) {
          return;
        }

        setActiveIndex((previous) =>
          event.key === 'ArrowDown' ? (previous + 1) % items.length : (previous - 1 + items.length) % items.length,
        );
        return;
      }

      if (event.key === 'Tab') {
        markKeyboardInteraction();
        event.preventDefault();
        const activeButtons = getActiveActionButtons();

        if (activeButtons.length === 0) {
          inputRef.current?.focus({ preventScroll: true });
          return;
        }

        if (event.shiftKey) {
          activeButtons[activeButtons.length - 1]?.focus({ preventScroll: true });
          return;
        }

        activeButtons[0]?.focus({ preventScroll: true });
        return;
      }

      if (event.key === 'Enter') {
        markKeyboardInteraction();
        event.preventDefault();
        items[activeIndex]?.onSelect();
        return;
      }
    },
    [
      activeIndex,
      closeOnEsc,
      getActiveActionButtons,
      items,
      markKeyboardInteraction,
      onInputArrowDown,
      onInputArrowUp,
      onOpenChange,
      setActiveIndex,
    ],
  );

  const handlePanelKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && closeOnEsc) {
        event.preventDefault();
        onOpenChange?.(false);
        return;
      }

      if (items.length === 0) {
        return;
      }

      if (event.key === 'ArrowDown') {
        markKeyboardInteraction();
        event.preventDefault();
        setActiveIndex((previous) => (previous + 1) % items.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        markKeyboardInteraction();
        event.preventDefault();
        setActiveIndex((previous) => (previous - 1 + items.length) % items.length);
        return;
      }

      if (event.key === 'Enter') {
        markKeyboardInteraction();
        event.preventDefault();
        items[activeIndex]?.onSelect();
        return;
      }

      if (event.key === 'Tab') {
        markKeyboardInteraction();
        event.preventDefault();
        const activeButtons = getActiveActionButtons();

        if (activeButtons.length === 0) {
          panelRef.current?.focus({ preventScroll: true });
          return;
        }

        const focusedButtonIndex = activeButtons.findIndex((button) => button === document.activeElement);
        if (event.shiftKey) {
          if (focusedButtonIndex <= 0) {
            panelRef.current?.focus({ preventScroll: true });
            return;
          }

          activeButtons[focusedButtonIndex - 1]?.focus({ preventScroll: true });
          return;
        }

        if (focusedButtonIndex === -1) {
          activeButtons[0]?.focus({ preventScroll: true });
          return;
        }

        if (focusedButtonIndex >= activeButtons.length - 1) {
          panelRef.current?.focus({ preventScroll: true });
          return;
        }

        activeButtons[focusedButtonIndex + 1]?.focus({ preventScroll: true });
        return;
      }
    },
    [activeIndex, closeOnEsc, getActiveActionButtons, items, markKeyboardInteraction, onOpenChange, setActiveIndex],
  );

  const handleActionButtonKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, actionIndex: number) => {
      if (event.key !== 'Tab') {
        return;
      }

      markKeyboardInteraction();

      event.preventDefault();
      const activeButtons = getActiveActionButtons();

      if (activeButtons.length === 0) {
        inputRef.current?.focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey) {
        if (actionIndex <= 0) {
          if (showInput) {
            inputRef.current?.focus({ preventScroll: true });
            return;
          }

          activeButtons[activeButtons.length - 1]?.focus({ preventScroll: true });
          return;
        }

        activeButtons[actionIndex - 1]?.focus({ preventScroll: true });
        return;
      }

      if (actionIndex >= activeButtons.length - 1) {
        if (showInput) {
          inputRef.current?.focus({ preventScroll: true });
          return;
        }

        activeButtons[0]?.focus({ preventScroll: true });
        return;
      }

      activeButtons[actionIndex + 1]?.focus({ preventScroll: true });
    },
    [getActiveActionButtons, markKeyboardInteraction, showInput],
  );

  if (!rendered) {
    return null;
  }

  const resolvedLeadingIcon = inputLeadingIcon ?? <Search className="h-4 w-4 shrink-0 text-command-text-muted" />;

  return (
    <div
      style={{ top: `${topOffset}px` }}
      className={classNames(
        'pointer-events-auto fixed left-1/2 z-40 w-[min(760px,calc(100vw-32px))] -translate-x-1/2',
        className,
      )}
    >
      <div
        ref={panelRef}
        tabIndex={showInput ? undefined : -1}
        data-state={open ? 'open' : 'closed'}
        className="flex flex-col overflow-hidden rounded-xl border border-command-border bg-command-surface shadow-menu-content backdrop-blur-[4px] data-[state=closed]:animate-out data-[state=closed]:fade-out-10 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-top-1"
        onKeyDown={showInput ? undefined : handlePanelKeyDown}
      >
        {showInput ? (
          <div className="border-b border-command-divider p-[6px]">
            <div className="flex items-center gap-2 rounded-lg bg-command-input px-2.5 focus-within:ring-2 focus-within:ring-outline">
              {resolvedLeadingIcon}
              <Input
                ref={inputRef}
                value={query}
                placeholder={placeholder}
                className="placeholder:!text-command-text-muted/80 h-[34px] !rounded-none !bg-transparent !px-0 !text-command-text hover:!bg-transparent focus-visible:!outline-none"
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>
        ) : null}

        {!hideItemList ? (
          <TooltipProvider delayDuration={180}>
            <div
              className={classNames(
                'overflow-y-auto p-1',
                showInput ? 'max-h-[min(420px,calc(100vh-180px))]' : 'max-h-[min(480px,calc(100vh-140px))]',
              )}
              onPointerMoveCapture={recordMouseInteraction}
            >
              {items.length === 0 ? (
                <div className="rounded-lg px-2.5 py-2 text-sm text-command-text-muted">{emptyText}</div>
              ) : (
                items.map((item, index) => {
                  const isActive = index === activeIndex;
                  const shouldUseRowColorVisual = Boolean(item.rowClassName);
                  const rowOverlayClassName =
                    shouldUseRowColorVisual && !isActive
                      ? "relative overflow-hidden before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-black/50 before:content-[''] hover:before:bg-black/35"
                      : '';
                  const contentForegroundClassName = shouldUseRowColorVisual && !isActive ? 'relative z-[1]' : '';
                  const iconColorClassName = shouldUseRowColorVisual ? '' : 'text-command-text-muted';
                  const titleColorClassName = shouldUseRowColorVisual ? '' : 'text-command-text';
                  const subtitleColorClassName = shouldUseRowColorVisual ? 'opacity-80' : 'text-command-text-muted';
                  const actionColorClassName = shouldUseRowColorVisual
                    ? 'text-inherit hover:bg-black/10 hover:text-inherit'
                    : 'text-command-text-muted hover:bg-command-action-hover hover:text-command-text';

                  return (
                    <div
                      key={item.key}
                      ref={(el) => {
                        if (el) {
                          itemRefs.current.set(index, el);
                        } else {
                          itemRefs.current.delete(index);
                        }
                      }}
                      className={classNames(
                        'group flex min-h-[34px] w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none',
                        shouldUseRowColorVisual ? item.rowClassName : '',
                        shouldUseRowColorVisual
                          ? rowOverlayClassName
                          : isActive
                            ? 'bg-command-item-active'
                            : 'hover:bg-command-item-hover',
                      )}
                      onMouseEnter={() => {
                        if (!shouldActivateByHover()) {
                          return;
                        }

                        setActiveIndex(index);
                      }}
                      onClick={item.onSelect}
                    >
                      <span
                        className={classNames(
                          'inline-flex h-5 w-5 shrink-0 items-center justify-center',
                          iconColorClassName,
                          contentForegroundClassName,
                        )}
                      >
                        {item.icon}
                      </span>

                      <span className={classNames('min-w-0 flex-1', contentForegroundClassName)}>
                        <span
                          className={classNames(
                            'flex items-center gap-1.5',
                            metadataLayout === 'inline' && 'justify-between',
                          )}
                        >
                          {item.titleTooltip ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={classNames('truncate text-sm', titleColorClassName)}>
                                  {item.title}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{item.titleTooltip}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className={classNames('truncate text-sm', titleColorClassName)}>{item.title}</span>
                          )}

                          {item.subtitle && metadataLayout === 'inline' ? (
                            <span className={classNames('ml-3 truncate text-xs', subtitleColorClassName)}>
                              {item.subtitle}
                            </span>
                          ) : null}
                        </span>

                        {item.subtitle && metadataLayout === 'stacked' ? (
                          <span className={classNames('block truncate text-xs', subtitleColorClassName)}>
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>

                      {item.actions && item.actions.length > 0 ? (
                        <span
                          className={classNames('-me-1 ml-auto flex items-center gap-1', contentForegroundClassName)}
                        >
                          {item.actions.map((action, actionIndex) => (
                            <Tooltip key={action.key}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  data-command-action="true"
                                  data-command-active={isActive ? 'true' : 'false'}
                                  tabIndex={isActive ? 0 : -1}
                                  className={classNames(
                                    'inline-flex h-6 w-6 items-center justify-center rounded-[8px] outline-none',
                                    actionColorClassName,
                                  )}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    action.onSelect();
                                  }}
                                  onKeyDown={(event) => handleActionButtonKeyDown(event, actionIndex)}
                                >
                                  {action.icon}
                                </button>
                              </TooltipTrigger>
                              {action.tooltip ? <TooltipContent>{action.tooltip}</TooltipContent> : null}
                            </Tooltip>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </TooltipProvider>
        ) : null}

        {footer ? <div className="border-t border-command-divider p-[6px]">{footer}</div> : null}
      </div>
    </div>
  );
};

export type { CommandPaletteAction, CommandPaletteItem, CommandPaletteProps };
export { CommandPalette };
