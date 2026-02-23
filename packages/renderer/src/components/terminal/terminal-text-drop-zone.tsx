import classNames from 'classnames';
import React from 'react';

type TerminalTextDropZoneProps = {
  label: string;
  centerX: number;
  active: boolean;
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
};

const TerminalTextDropZone: React.FC<TerminalTextDropZoneProps> = ({
  label,
  centerX,
  active,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}) => {
  return (
    <div
      className="pointer-events-none absolute bottom-3 z-40 px-3"
      style={{
        left: `${centerX}px`,
        transform: 'translateX(-50%)',
      }}
    >
      <div
        className={classNames(
          'pointer-events-auto min-h-[100px] min-w-[400px] select-none rounded-[18px] border border-menu-selection-bar-border px-7 py-4 text-sm text-header-text shadow-selection-bar backdrop-blur-[4px] transition-colors flex items-center justify-center',
          active ? 'bg-menu-control-hover' : 'bg-menu-control',
        )}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="text-center">{label}</span>
      </div>
    </div>
  );
};

export { TerminalTextDropZone };
