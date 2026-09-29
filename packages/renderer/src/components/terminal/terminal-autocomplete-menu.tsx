import type { ShellCompletionCandidate } from '@cosmosh/api-contract';
import classNames from 'classnames';
import { Clock3, Command, File, Folder, ListTree, ToggleRight } from 'lucide-react';
import React from 'react';

import { t } from '../../lib/i18n';
import { ContextMenuShortcut } from '../ui/context-menu';
import { menuStyles } from '../ui/menu-styles';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

type TerminalAutocompleteItem = ShellCompletionCandidate;

type TerminalAutocompleteMenuProps = {
  open: boolean;
  focused: boolean;
  inputElement: HTMLTextAreaElement | null;
  focusShortcutLabel: string;
  onFocusList: () => void;
  onRequestList: () => void;
  anchorTop: number;
  anchorLeft: number;
  panelWidth: number;
  renderAbove: boolean;
  items: TerminalAutocompleteItem[];
  onItemSelect: (candidateId: string) => void;
};

type TerminalAutocompleteMenuHandle = {
  moveNext: () => void;
  movePrevious: () => void;
  getActiveId: () => string | null;
  reset: () => void;
};

const resolveItemIcon = (item: TerminalAutocompleteItem): React.ReactNode => {
  if (item.kind === 'history' || item.source === 'history') {
    return <Clock3 className="h-4 w-4" />;
  }

  if (item.kind === 'option') {
    return <ToggleRight className="h-4 w-4" />;
  }

  if (item.kind === 'path') {
    return item.label.endsWith('/') ? <Folder className="h-4 w-4" /> : <File className="h-4 w-4" />;
  }

  if (item.kind === 'subcommand') {
    return <ListTree className="h-4 w-4" />;
  }

  return <Command className="h-4 w-4" />;
};

const TerminalAutocompleteMenu = React.forwardRef<TerminalAutocompleteMenuHandle, TerminalAutocompleteMenuProps>(
  (
    {
      open,
      focused,
      inputElement,
      focusShortcutLabel,
      onFocusList,
      onRequestList,
      anchorTop,
      anchorLeft,
      panelWidth,
      renderAbove,
      items,
      onItemSelect,
    },
    ref,
  ) => {
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const activeIndex = Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    );
    const listId = React.useId();
    const itemElementRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

    React.useLayoutEffect(() => {
      setActiveId((previous) => (items.some((item) => item.id === previous) ? previous : (items[0]?.id ?? null)));
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

    React.useEffect(() => {
      if (!open || items.length === 0 || !inputElement) return;
      // Preserve xterm's accessibility attributes outside the lifetime of this popup.
      const attributes = {
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-controls': listId,
        'aria-expanded': 'true',
        'aria-activedescendant': focused ? `${listId}-${Math.min(activeIndex, items.length - 1)}` : '',
      };
      const previous = Object.keys(attributes).map((name) => [name, inputElement.getAttribute(name)] as const);
      for (const [name, value] of Object.entries(attributes)) {
        if (value) inputElement.setAttribute(name, value);
        else inputElement.removeAttribute(name);
      }
      return () => {
        for (const [name, value] of previous) {
          if (value === null) inputElement.removeAttribute(name);
          else inputElement.setAttribute(name, value);
        }
      };
    }, [activeIndex, focused, inputElement, items.length, listId, open]);

    React.useImperativeHandle(
      ref,
      () => ({
        moveNext: () => {
          setActiveId(
            (previous) =>
              items[
                (Math.max(
                  0,
                  items.findIndex((item) => item.id === previous),
                ) +
                  1) %
                  items.length
              ]?.id ?? null,
          );
        },
        movePrevious: () => {
          setActiveId(
            (previous) =>
              items[
                (Math.max(
                  0,
                  items.findIndex((item) => item.id === previous),
                ) +
                  items.length -
                  1) %
                  items.length
              ]?.id ?? null,
          );
        },
        getActiveId: () => items[activeIndex]?.id ?? null,
        reset: () => {
          setActiveId(null);
        },
      }),
      [activeIndex, items],
    );

    if (!open || items.length === 0) {
      return null;
    }

    return (
      <div
        data-terminal-autocomplete={focused ? 'focused' : 'passive'}
        className="pointer-events-auto absolute z-40"
        style={{
          left: `${anchorLeft}px`,
          top: renderAbove ? undefined : `${anchorTop}px`,
          bottom: renderAbove ? `calc(100% - ${anchorTop}px)` : undefined,
        }}
        onPointerDown={(event) => {
          // Keep IME and the first typed character in xterm, including after mouse selection.
          event.preventDefault();
          if (event.target instanceof Element && event.target.closest('[role="option"]')) onFocusList();
        }}
      >
        <div
          className={classNames(menuStyles.content, 'max-h-[280px] overflow-y-auto overflow-x-hidden p-[4px]')}
          style={{ width: `${panelWidth}px` }}
        >
          <button
            type="button"
            tabIndex={-1}
            className={classNames(menuStyles.label, 'w-full text-left')}
            onClick={onRequestList}
          >
            {focused
              ? t('ssh.autocomplete.focusedHint')
              : t('ssh.autocomplete.focusHint', { shortcut: focusShortcutLabel })}
          </button>
          <div
            id={listId}
            role="listbox"
            aria-label={t('ssh.autocomplete.label')}
          >
            <TooltipProvider delayDuration={160}>
              {items.map((item, index) => {
                const isActive = focused && index === activeIndex;
                const detailText =
                  (item.detailI18nKey ? t(item.detailI18nKey) : item.detail?.trim()) ||
                  t(item.source === 'history' ? 'ssh.autocomplete.history' : 'ssh.autocomplete.command');

                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>
                      <button
                        ref={(element) => {
                          itemElementRefs.current[index] = element;
                        }}
                        type="button"
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={isActive}
                        tabIndex={-1}
                        className={classNames(
                          menuStyles.item,
                          'w-full justify-start overflow-hidden text-left',
                          isActive && 'bg-menu-control-hover',
                        )}
                        onMouseEnter={() => setActiveId(item.id)}
                        onClick={() => onItemSelect(item.id)}
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
      </div>
    );
  },
);

TerminalAutocompleteMenu.displayName = 'TerminalAutocompleteMenu';

export type { TerminalAutocompleteItem };
export type { TerminalAutocompleteMenuHandle };
export { TerminalAutocompleteMenu };
