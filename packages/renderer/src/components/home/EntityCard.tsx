import classNames from 'classnames';
import React from 'react';

type EntityCardProps = {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  imageUrl?: string;
  selected?: boolean;
  layout?: 'list' | 'grid';
  tone?: 'flat' | 'filled';
  className?: string;
  onClick?: (event?: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => void;
  draggable?: boolean;
  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  onDragEnd?: React.DragEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDragEnter?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
  tabIndex?: number;
  onFocus?: React.FocusEventHandler<HTMLDivElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
};

const EntityCard = React.forwardRef<HTMLDivElement, EntityCardProps>(
  (
    {
      title,
      subtitle,
      icon,
      action,
      imageUrl,
      selected = false,
      tone = 'flat',
      className,
      onClick,
      draggable,
      onDragStart,
      onDragEnd,
      onDragOver,
      onDrop,
      onDragEnter,
      onDragLeave,
      tabIndex,
      onFocus,
      onKeyDown,
    },
    ref,
  ) => {
    const handleKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) {
          return;
        }

        if (!onClick) {
          return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(event);
        }
      },
      [onClick, onKeyDown],
    );

    const content = (
      <>
        <span
          className={classNames(
            'inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[8px]',
          )}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            icon
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className={classNames('block truncate text-sm font-semibold leading-tight text-header-text')}>
            {title}
          </span>
          {subtitle ? (
            <span className={classNames('block truncate text-xs text-home-text-subtle')}>{subtitle}</span>
          ) : null}
        </span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </>
    );

    return (
      <div
        ref={ref}
        role="button"
        tabIndex={tabIndex ?? 0}
        className={classNames(
          'group w-full rounded-[15px] px-2 py-2 text-left outline-none transition-colors [-webkit-app-region:no-drag]',
          onClick ? 'cursor-pointer' : 'cursor-default',
          'inline-flex min-h-[46px] items-center gap-2.5',
          selected
            ? 'bg-home-card-active'
            : tone === 'filled'
              ? 'bg-home-card hover:bg-home-card-hover'
              : 'hover:bg-home-card-hover',
          className,
        )}
        draggable={draggable}
        onClick={(event) => {
          onClick?.(event);
        }}
        onKeyDown={handleKeyDown}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onFocus={onFocus}
      >
        {content}
      </div>
    );
  },
);

EntityCard.displayName = 'EntityCard';

export default EntityCard;
