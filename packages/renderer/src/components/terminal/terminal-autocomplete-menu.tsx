import classNames from 'classnames';
import { Clock3, Command, ListTree, ToggleRight } from 'lucide-react';
import React from 'react';

import { ContextMenuShortcut } from '../ui/context-menu';
import { menuStyles } from '../ui/menu-styles';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

type TerminalAutocompleteItem = {
  id: string;
  label: string;
  insertText: string;
  detail: string | null;
  source: 'history' | 'inshellisense';
  kind: 'command' | 'subcommand' | 'option' | 'history';
  score: number;
};

type TerminalAutocompleteMenuProps = {
  open: boolean;
  anchorTop: number;
  anchorLeft: number;
  renderAbove: boolean;
  items: TerminalAutocompleteItem[];
  onItemSelect: (index: number) => void;
};

type TerminalAutocompleteMenuHandle = {
  moveNext: () => void;
  movePrevious: () => void;
  getActiveIndex: () => number;
  reset: () => void;
};

const resolveItemIcon = (item: TerminalAutocompleteItem): React.ReactNode => {
  if (item.kind === 'history' || item.source === 'history') {
    return <Clock3 className="h-4 w-4" />;
  }

  if (item.kind === 'option') {
    return <ToggleRight className="h-4 w-4" />;
  }

  if (item.kind === 'subcommand') {
    return <ListTree className="h-4 w-4" />;
  }

  return <Command className="h-4 w-4" />;
};

const TerminalAutocompleteMenu = React.forwardRef<TerminalAutocompleteMenuHandle, TerminalAutocompleteMenuProps>(
  ({ open, anchorTop, anchorLeft, renderAbove, items, onItemSelect }, ref) => {
    const [activeIndex, setActiveIndex] = React.useState<number>(0);
    const itemElementRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

    React.useEffect(() => {
      setActiveIndex(0);
    }, [items]);

    React.useEffect(() => {
      if (!open || items.length <= 0) {
        return;
      }

      const activeElement = itemElementRefs.current[activeIndex];
      if (!activeElement) {
        return;
      }

      activeElement.scrollIntoView({
        block: 'nearest',
      });
    }, [activeIndex, items.length, open]);

    React.useImperativeHandle(
      ref,
      () => ({
        moveNext: () => {
          setActiveIndex((previous) => (items.length <= 0 ? 0 : (previous + 1) % items.length));
        },
        movePrevious: () => {
          setActiveIndex((previous) => {
            if (items.length <= 0) {
              return 0;
            }

            return previous - 1 < 0 ? items.length - 1 : previous - 1;
          });
        },
        getActiveIndex: () => {
          if (items.length <= 0) {
            return 0;
          }

          return Math.max(0, Math.min(activeIndex, items.length - 1));
        },
        reset: () => {
          setActiveIndex(0);
        },
      }),
      [activeIndex, items],
    );

    if (!open || items.length === 0) {
      return null;
    }

    return (
      <div
        className="pointer-events-auto absolute z-40"
        style={{
          left: `${anchorLeft}px`,
          top: renderAbove ? undefined : `${anchorTop}px`,
          bottom: renderAbove ? `calc(100% - ${anchorTop}px)` : undefined,
        }}
      >
        <div
          className={classNames(
            menuStyles.content,
            'max-h-[280px] min-w-[340px] max-w-[520px] overflow-y-auto overflow-x-hidden p-[4px]',
          )}
        >
          <TooltipProvider delayDuration={160}>
            {items.map((item, index) => {
              const isActive = index === activeIndex;
              const detailText = item.detail?.trim() || (item.source === 'history' ? 'History' : 'Command spec');

              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <button
                      ref={(element) => {
                        itemElementRefs.current[index] = element;
                      }}
                      type="button"
                      className={classNames(
                        menuStyles.item,
                        'w-full justify-start overflow-hidden text-left',
                        isActive && 'bg-menu-control-hover',
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => onItemSelect(index)}
                    >
                      <span className={menuStyles.leadingIconSlot}>{resolveItemIcon(item)}</span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <ContextMenuShortcut className="max-w-[260px] truncate">{detailText}</ContextMenuShortcut>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    align="start"
                    className="max-w-[360px] break-words"
                  >
                    <div className="font-medium text-header-text">{item.label}</div>
                    <div className="text-subtle-text mt-1 text-xs">{detailText}</div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TooltipProvider>
        </div>
      </div>
    );
  },
);

TerminalAutocompleteMenu.displayName = 'TerminalAutocompleteMenu';

export type { TerminalAutocompleteItem };
export type { TerminalAutocompleteMenuHandle };
export { TerminalAutocompleteMenu };
