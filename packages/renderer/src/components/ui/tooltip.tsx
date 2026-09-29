import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import classNames from 'classnames';
import React from 'react';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/** Tooltip content options, including pointer behavior for explanations above nearby controls. */
type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  /** False lets pointer input pass through the complete portal, including Radix's positioning wrapper. */
  interactive?: boolean;
};

/**
 * Renders the shared tooltip surface without letting passive explanations cover interactive controls.
 * @param props Radix content options and optional portal pointer behavior.
 * @param ref Forwarded content element ref.
 * @returns Portal content with the existing style and positioning rules.
 */
const TooltipContent = React.forwardRef<React.ElementRef<typeof TooltipPrimitive.Content>, TooltipContentProps>(
  ({ className, sideOffset = 8, interactive = true, ...props }, ref) => {
    const content = (
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={classNames(
          'z-50 rounded-[10px] bg-bg-subtle px-2 py-1 text-xs text-header-text shadow-soft backdrop-blur-[4px] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    );
    return (
      <TooltipPrimitive.Portal>
        {interactive ? content : <div className="pointer-events-none contents">{content}</div>}
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
