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
  onClick?: () => void;
};

const EntityCard = React.forwardRef<HTMLDivElement, EntityCardProps>(
  ({ title, subtitle, icon, action, imageUrl, selected = false, tone = 'flat', className, onClick }, ref) => {
    const handleKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!onClick) {
          return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      },
      [onClick],
    );

    const content = (
      <>
        <span
          className={classNames(
            'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] h-9 w-9',
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
          <span className={classNames('block truncate font-semibold leading-tight text-header-text text-sm')}>
            {title}
          </span>
          {subtitle ? (
            <span className={classNames('block truncate text-home-text-subtle text-xs')}>{subtitle}</span>
          ) : null}
        </span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </>
    );

    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        className={classNames(
          'group w-full rounded-[15px] px-2 py-2 text-left transition-colors outline-none [-webkit-app-region:no-drag]',
          onClick ? 'cursor-pointer' : 'cursor-default',
          'inline-flex min-h-[46px] items-center gap-2.5',
          selected
            ? 'bg-home-card-active'
            : tone === 'filled'
              ? 'bg-home-card hover:bg-home-card-hover'
              : 'hover:bg-home-card-hover',
          className,
        )}
        onClick={onClick}
        onKeyDown={handleKeyDown}
      >
        {content}
      </div>
    );
  },
);

EntityCard.displayName = 'EntityCard';

export default EntityCard;
