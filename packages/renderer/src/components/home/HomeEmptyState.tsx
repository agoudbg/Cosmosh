import classNames from 'classnames';
import { PackageOpen } from 'lucide-react';
import React from 'react';

type EmptyStateIcon = React.ComponentType<{ className?: string; strokeWidth?: string | number }>;

type HomeEmptyStateProps = {
  text: string;
  icon?: EmptyStateIcon;
  className?: string;
};

const HomeEmptyState: React.FC<HomeEmptyStateProps> = ({ text, icon: Icon = PackageOpen, className }) => {
  return (
    <div className={classNames('flex w-full justify-center py-8', className)}>
      <div className="flex max-w-[560px] flex-col items-center justify-center gap-2 text-center">
        <span
          aria-hidden
          className="inline-flex h-16 w-16 items-center justify-center text-home-text-empty-icon"
        >
          <Icon
            className="h-14 w-14"
            strokeWidth={1.25}
          />
        </span>
        <p className="text-sm text-home-text-subtle">{text}</p>
      </div>
    </div>
  );
};

export default HomeEmptyState;
