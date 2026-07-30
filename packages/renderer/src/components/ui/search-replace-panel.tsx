import classNames from 'classnames';
import type { LucideIcon } from 'lucide-react';
import { ArrowDown, ArrowUp, Replace, ReplaceAll, Search, TextSelect, X } from 'lucide-react';
import React from 'react';

import { getLocale, onLocaleChange, t } from '../../lib/i18n';
import { Button } from './button';
import { Input } from './input';
import { Toggle } from './toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

/**
 * Text that can be resolved lazily so open panels react to locale changes.
 */
export type SearchReplaceLocalizedText = string | (() => string);

/**
 * Replacement capability exposed by a search/replace surface.
 */
export type SearchReplaceReplaceMode = 'hidden' | 'readonly' | 'editable';

/**
 * Per-action render state for the reusable search/replace panel.
 */
export type SearchReplaceActionState = {
  disabled?: boolean;
  hidden?: boolean;
  label?: SearchReplaceLocalizedText;
};

/**
 * Filter toggle displayed by the reusable search/replace panel.
 */
export type SearchReplaceFilterOption = {
  ariaLabel?: SearchReplaceLocalizedText;
  disabled?: boolean;
  icon?: LucideIcon;
  id: string;
  label: SearchReplaceLocalizedText;
  onPressedChange: (pressed: boolean) => void;
  pressed: boolean;
};

/**
 * Controlled props for the reusable search/replace panel.
 */
export type SearchReplacePanelProps = {
  actionState?: {
    findNext?: SearchReplaceActionState;
    findPrevious?: SearchReplaceActionState;
    replaceAll?: SearchReplaceActionState;
    replaceNext?: SearchReplaceActionState;
    selectAllMatches?: SearchReplaceActionState;
  };
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  docked?: boolean;
  filters: SearchReplaceFilterOption[];
  invalid?: boolean;
  matchLabel?: SearchReplaceLocalizedText;
  onClose: () => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onPanelKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onReplaceAll?: () => void;
  onReplaceChange: (value: string) => void;
  onReplaceNext?: () => void;
  onSearchChange: (value: string) => void;
  onSelectAllMatches?: () => void;
  replaceMode: SearchReplaceReplaceMode;
  replaceValue: string;
  searchPlaceholder?: SearchReplaceLocalizedText;
  searchInputRef?: React.Ref<HTMLInputElement>;
  searchValue: string;
  showMatchCount?: boolean;
};

type IconButtonProps = {
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
};

/**
 * Assigns a node to any React ref shape.
 *
 * @param ref React ref to update.
 * @param value Node value to assign.
 * @returns Nothing.
 */
function assignRef<TNode>(ref: React.Ref<TNode> | undefined, value: TNode | null): void {
  if (!ref) {
    return;
  }

  if (typeof ref === 'function') {
    ref(value);
    return;
  }

  ref.current = value;
}

/**
 * Resolves immediate or lazy localized text.
 *
 * @param value Localized string or resolver.
 * @returns Current localized string.
 */
const resolveLocalizedText = (value: SearchReplaceLocalizedText): string => {
  return typeof value === 'function' ? value() : value;
};

/**
 * Small icon-only button with an accessible tooltip.
 *
 * @param props Icon, label, disabled state, and click handler.
 * @returns Tokenized icon button.
 */
const SearchReplaceIconButton: React.FC<IconButtonProps> = ({ disabled, icon: Icon, label, onClick }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        aria-label={label}
        className="h-8 w-8 !rounded-md-2"
        disabled={disabled}
        variant="ghostIcon"
        onClick={onClick}
      >
        <Icon className="h-4 w-4" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

/**
 * Width below which the panel switches from the inline layout to the stacked narrow layout.
 * Roughly the point where the search row plus the full action strip (navigation, filters,
 * match count, close) no longer fits on one line without wrapping into arbitrary positions.
 */
const SEARCH_REPLACE_STACKED_BREAKPOINT = 480;

/**
 * Reusable, controlled search/replace panel for editors and future searchable surfaces.
 *
 * By default the panel renders as a floating card sized against the viewport; set `docked`
 * when the host embeds the panel in its layout flow (for example a bar pinned to an editor
 * edge) so it stretches to the container width and drops the floating card chrome. Below
 * `SEARCH_REPLACE_STACKED_BREAKPOINT` of available width it automatically switches to a
 * stacked three-row layout (search + close, replace + actions, find options) so controls
 * never wrap into arbitrary positions.
 *
 * @param props Search values, filter state, action callbacks, and capability flags.
 * @returns Tokenized search/replace panel.
 */
export const SearchReplacePanel: React.FC<SearchReplacePanelProps> = ({
  actionState,
  className,
  compact = false,
  disabled = false,
  docked = false,
  filters,
  invalid = false,
  matchLabel,
  onClose,
  onFindNext,
  onFindPrevious,
  onPanelKeyDown,
  onReplaceAll,
  onReplaceChange,
  onReplaceNext,
  onSearchChange,
  onSelectAllMatches,
  replaceMode,
  replaceValue,
  searchPlaceholder,
  searchInputRef,
  searchValue,
  showMatchCount = true,
}) => {
  const [, setLocaleVersion] = React.useState(getLocale());
  const [stacked, setStacked] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const replaceDisabled = disabled || replaceMode !== 'editable';
  const findPreviousState = actionState?.findPrevious;
  const findNextState = actionState?.findNext;
  const replaceNextState = actionState?.replaceNext;
  const replaceAllState = actionState?.replaceAll;
  const selectAllState = actionState?.selectAllMatches;
  const findPreviousLabel = resolveLocalizedText(findPreviousState?.label ?? (() => t('searchReplace.findPrevious')));
  const findNextLabel = resolveLocalizedText(findNextState?.label ?? (() => t('searchReplace.findNext')));
  const replaceNextLabel = resolveLocalizedText(replaceNextState?.label ?? (() => t('searchReplace.replaceNext')));
  const replaceAllLabel = resolveLocalizedText(replaceAllState?.label ?? (() => t('searchReplace.replaceAll')));
  const selectAllLabel = resolveLocalizedText(selectAllState?.label ?? (() => t('searchReplace.selectAllMatches')));
  const closeLabel = t('searchReplace.close');
  const resolvedMatchLabel = matchLabel ? resolveLocalizedText(matchLabel) : '';
  const resolvedSearchPlaceholder = resolveLocalizedText(
    searchPlaceholder ?? (() => t('searchReplace.findPlaceholder')),
  );

  React.useEffect(() => {
    return onLocaleChange(setLocaleVersion);
  }, []);

  React.useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return;
    }

    // Narrow hosts (e.g. the SFTP preview sidebar) cannot fit the search row plus the full
    // action strip, so switch to a stacked arrangement instead of letting buttons wrap into
    // arbitrary positions. ResizeObserver fires once on observe, seeding the initial mode.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setStacked(entry.contentRect.width < SEARCH_REPLACE_STACKED_BREAKPOINT);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const setSearchInputRef = React.useCallback(
    (node: HTMLInputElement | null): void => {
      if (node) {
        node.setAttribute('main-field', 'true');
      }

      assignRef(searchInputRef, node);
    },
    [searchInputRef],
  );

  const handleKeyDown = React.useCallback<React.KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      onPanelKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Enter') {
        return;
      }

      if (event.target instanceof HTMLInputElement && event.target.name === 'search') {
        event.preventDefault();
        if (event.shiftKey) {
          onFindPrevious();
          return;
        }

        onFindNext();
        return;
      }

      if (event.target instanceof HTMLInputElement && event.target.name === 'replace' && !replaceDisabled) {
        event.preventDefault();
        onReplaceNext?.();
      }
    },
    [onClose, onFindNext, onFindPrevious, onPanelKeyDown, onReplaceNext, replaceDisabled],
  );

  // Shared pieces, extracted so the inline (wide) and stacked (narrow) layouts below
  // reuse the exact same controls instead of forking their markup.
  const searchField = (
    <div className={classNames('relative flex-1', stacked ? 'min-w-0' : 'min-w-[180px]')}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
      <Input
        ref={setSearchInputRef}
        aria-invalid={invalid}
        aria-label={resolvedSearchPlaceholder}
        className="h-8 min-w-0 !rounded-md-2 pl-9"
        disabled={disabled}
        form=""
        name="search"
        placeholder={resolvedSearchPlaceholder}
        value={searchValue}
        onChange={(event) => onSearchChange(event.target.value)}
      />
    </div>
  );

  const matchCountLabel =
    showMatchCount && resolvedMatchLabel ? (
      <span
        className={classNames(
          'flex-shrink-0 whitespace-nowrap px-1 text-right text-xs leading-[18px]',
          // In the stacked layout the count sits at the far end of the options row.
          stacked ? 'ml-auto' : 'min-w-[72px]',
          invalid ? 'text-form-message-error' : 'text-header-text-muted',
        )}
      >
        {resolvedMatchLabel}
      </span>
    ) : null;

  const navigationButtons = (
    <>
      <SearchReplaceIconButton
        disabled={disabled || findPreviousState?.disabled}
        icon={ArrowUp}
        label={findPreviousLabel}
        onClick={onFindPrevious}
      />
      <SearchReplaceIconButton
        disabled={disabled || findNextState?.disabled}
        icon={ArrowDown}
        label={findNextLabel}
        onClick={onFindNext}
      />
      {onSelectAllMatches && !selectAllState?.hidden ? (
        <SearchReplaceIconButton
          disabled={disabled || selectAllState?.disabled}
          icon={TextSelect}
          label={selectAllLabel}
          onClick={onSelectAllMatches}
        />
      ) : null}
    </>
  );

  const filterToggles = filters.map((filter) => {
    const label = resolveLocalizedText(filter.label);
    const ariaLabel = resolveLocalizedText(filter.ariaLabel ?? filter.label);
    const Icon = filter.icon;

    return (
      <Tooltip key={filter.id}>
        <TooltipTrigger asChild>
          <Toggle
            aria-label={ariaLabel}
            className="h-8 w-8 !rounded-md-2"
            disabled={disabled || filter.disabled}
            pressed={filter.pressed}
            variant="icon"
            onPressedChange={filter.onPressedChange}
          >
            {Icon ? (
              <Icon className="h-4 w-4" />
            ) : (
              <span className="max-w-[24px] truncate text-xs font-medium">{label}</span>
            )}
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  });

  const closeButton = (
    <SearchReplaceIconButton
      icon={X}
      label={closeLabel}
      onClick={onClose}
    />
  );

  const replaceField = (
    <div className={classNames('relative flex-1', stacked ? 'min-w-0' : 'min-w-[180px]')}>
      <Replace className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
      <Input
        aria-label={t('searchReplace.replacePlaceholder')}
        className="h-8 min-w-0 !rounded-md-2 pl-9"
        disabled={replaceDisabled}
        form=""
        name="replace"
        placeholder={t('searchReplace.replacePlaceholder')}
        value={replaceValue}
        onChange={(event) => onReplaceChange(event.target.value)}
      />
    </div>
  );

  const replaceActionButtons = (
    <>
      <Button
        className="h-8 gap-1.5 !rounded-md-2"
        disabled={replaceDisabled || !onReplaceNext || replaceNextState?.disabled}
        padding="mid"
        variant="ghost"
        onClick={onReplaceNext}
      >
        <Replace className="h-4 w-4" />
        <span className="truncate">{replaceNextLabel}</span>
      </Button>
      {!replaceAllState?.hidden ? (
        <Button
          className="h-8 gap-1.5 !rounded-md-2"
          disabled={replaceDisabled || !onReplaceAll || replaceAllState?.disabled}
          padding="mid"
          variant="ghost"
          onClick={onReplaceAll}
        >
          <ReplaceAll className="h-4 w-4" />
          <span className="truncate">{replaceAllLabel}</span>
        </Button>
      ) : null}
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={rootRef}
        className={classNames(
          docked
            ? // Docked bars join the host layout flow, so width follows the container instead of the viewport.
              'w-full border-t border-menu-divider bg-menu-control p-1 text-sm text-header-text'
            : 'w-[min(720px,calc(100vw-24px))] rounded-lg-2 bg-command-surface p-1 text-sm text-header-text shadow-menu-content backdrop-blur-[4px]',
          !docked && (compact ? 'max-w-[min(640px,calc(100vw-24px))]' : 'max-w-[min(720px,calc(100vw-24px))]'),
          className,
        )}
        data-search-replace-panel="true"
        onKeyDown={handleKeyDown}
      >
        {stacked ? (
          <>
            {/* Narrow hosts: search + close, replace + actions, then the find options row. */}
            <div className="flex min-w-0 items-center gap-1">
              {searchField}
              {closeButton}
            </div>
            {replaceMode !== 'hidden' ? (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                {replaceField}
                {replaceActionButtons}
              </div>
            ) : null}
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {navigationButtons}
              {filterToggles}
              {matchCountLabel}
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {searchField}
              {matchCountLabel}
              <div className="flex flex-shrink-0 items-center gap-1">
                {navigationButtons}
                {filterToggles}
                {closeButton}
              </div>
            </div>
            {replaceMode !== 'hidden' ? (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                {replaceField}
                {replaceActionButtons}
              </div>
            ) : null}
          </>
        )}
      </div>
    </TooltipProvider>
  );
};
