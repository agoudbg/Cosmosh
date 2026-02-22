import classNames from 'classnames';
import { Copy, FolderOpen, GripVertical, Search, Sparkles, TextCursorInput, X } from 'lucide-react';
import React from 'react';

import { Button } from '../ui/button';
import { Menubar } from '../ui/menubar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

const ASK_QUESTIONS_ACTION_ID = 'ask_questions';

type TerminalSelectionBarProps = {
  className?: string;
  dragLabel: string;
  copyLabel: string;
  insertLabel: string;
  openDirectoryLabel: string;
  searchLabel: string;
  askAiLabel: string;
  closeLabel: string;
  selectedText: string;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onCopy: () => void;
  onInsert: () => void;
  onOpenDirectory: () => void;
  onSearch: () => void;
  onAskAi: () => void;
  onClose: () => void;
};

type ActionButtonProps = {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void;
  draggable?: boolean;
  dataActionId?: string;
};

const ActionButton: React.FC<ActionButtonProps> = ({
  label,
  onClick,
  children,
  onDragStart,
  draggable,
  dataActionId,
}) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="icon"
          aria-label={label}
          draggable={draggable}
          data-action-id={dataActionId}
          className="h-[34px] w-[34px] rounded-[14px]"
          onClick={onClick}
          onDragStart={onDragStart}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
};

const TerminalSelectionBar = React.forwardRef<HTMLDivElement, TerminalSelectionBarProps>(
  (
    {
      className,
      dragLabel,
      copyLabel,
      insertLabel,
      openDirectoryLabel,
      searchLabel,
      askAiLabel,
      closeLabel,
      selectedText,
      onDragStart,
      onCopy,
      onInsert,
      onOpenDirectory,
      onSearch,
      onAskAi,
      onClose,
    },
    ref,
  ) => {
    return (
      <div
        ref={ref}
        className={classNames('pointer-events-auto select-none', className)}
      >
        <TooltipProvider delayDuration={160}>
          <Menubar className="shadow-selection-bar border border-menu-selection-bar-border">
            <ActionButton
              label={dragLabel}
              draggable={true}
              onClick={() => undefined}
              onDragStart={onDragStart}
            >
              <GripVertical className="h-4 w-4" />
            </ActionButton>
            <ActionButton
              label={copyLabel}
              onClick={onCopy}
            >
              <Copy className="h-4 w-4" />
            </ActionButton>
            <ActionButton
              label={insertLabel}
              onClick={onInsert}
            >
              <TextCursorInput className="h-4 w-4" />
            </ActionButton>
            <ActionButton
              label={openDirectoryLabel}
              onClick={onOpenDirectory}
            >
              <FolderOpen className="h-4 w-4" />
            </ActionButton>
            <ActionButton
              label={searchLabel}
              onClick={onSearch}
            >
              <Search className="h-4 w-4" />
            </ActionButton>
            <ActionButton
              label={askAiLabel}
              dataActionId={ASK_QUESTIONS_ACTION_ID}
              onClick={onAskAi}
            >
              <Sparkles className="h-4 w-4" />
            </ActionButton>
            <ActionButton
              label={closeLabel}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </ActionButton>
          </Menubar>
        </TooltipProvider>
        <span className="sr-only">{selectedText}</span>
      </div>
    );
  },
);
TerminalSelectionBar.displayName = 'TerminalSelectionBar';

export { ASK_QUESTIONS_ACTION_ID, TerminalSelectionBar };
