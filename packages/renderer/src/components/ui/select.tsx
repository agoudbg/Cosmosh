import { ChevronDownIcon, ChevronUpIcon } from '@radix-ui/react-icons';
import * as SelectPrimitive from '@radix-ui/react-select';
import classNames from 'classnames';
import { Check } from 'lucide-react';
import React from 'react';

import {
  MenuIconSlotContext,
  resolveMenuHasLeadingVisual,
  useMenuIconSlot,
  useMenuSeparatorInset,
} from './menu-icon-slot';
import { normalizeCollisionPadding, resolveViewportMenuBounds } from './menu-position';
import { menuStyles } from './menu-styles';

type MenuIconComponent = React.ComponentType<{ className?: string }>;

type SelectProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>;

const SELECT_CLOSE_ANIMATION_MS = 150;

const SelectAnimationContext = React.createContext<{ isClosing: boolean }>({ isClosing: false });

const Select: React.FC<SelectProps> = ({ open, defaultOpen, onOpenChange, ...props }) => {
  const isControlled = open !== undefined;
  const closeTimerRef = React.useRef<number | null>(null);
  const isClosingRef = React.useRef<boolean>(false);
  const [internalOpen, setInternalOpen] = React.useState<boolean>(defaultOpen ?? false);
  const [isClosing, setIsClosing] = React.useState<boolean>(false);

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  if (isControlled) {
    return (
      <SelectAnimationContext.Provider value={{ isClosing: false }}>
        <SelectPrimitive.Root
          open={open}
          defaultOpen={defaultOpen}
          onOpenChange={onOpenChange}
          {...props}
        />
      </SelectAnimationContext.Provider>
    );
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      isClosingRef.current = false;
      setIsClosing(false);
      setInternalOpen(true);
      onOpenChange?.(true);
      return;
    }

    if (isClosingRef.current) {
      return;
    }

    isClosingRef.current = true;
    setIsClosing(true);

    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
    }

    closeTimerRef.current = window.setTimeout(() => {
      isClosingRef.current = false;
      setIsClosing(false);
      setInternalOpen(false);
      onOpenChange?.(false);
      closeTimerRef.current = null;
    }, SELECT_CLOSE_ANIMATION_MS);
  };

  return (
    <SelectAnimationContext.Provider value={{ isClosing }}>
      <SelectPrimitive.Root
        open={internalOpen || isClosing}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </SelectAnimationContext.Provider>
  );
};
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={classNames(menuStyles.control, 'min-w-[180px] justify-between', className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDownIcon className={menuStyles.iconSlot} />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', sideOffset = 6, collisionPadding = 8, style, ...props }, ref) => {
  const { isClosing } = React.useContext(SelectAnimationContext);
  const viewportBoundsStyle = resolveViewportMenuBounds();
  const hasLeadingVisual = resolveMenuHasLeadingVisual(children);

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        avoidCollisions
        className={classNames(menuStyles.content, isClosing && 'pointer-events-none', className)}
        position={position}
        sideOffset={sideOffset}
        sticky="always"
        collisionPadding={normalizeCollisionPadding(collisionPadding)}
        style={{
          ...viewportBoundsStyle,
          opacity: isClosing ? 0 : 1,
          transform: isClosing ? 'scale(0.95)' : undefined,
          transformOrigin: 'center center',
          transition: 'opacity 150ms ease-in, transform 150ms ease-in',
          ...style,
        }}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-header-text-muted">
          <ChevronUpIcon className={menuStyles.iconSlot} />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>
          <MenuIconSlotContext.Provider value={hasLeadingVisual}>{children}</MenuIconSlotContext.Provider>
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-header-text-muted">
          <ChevronDownIcon className={menuStyles.iconSlot} />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={classNames(menuStyles.label, className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { icon?: MenuIconComponent; withIconSlot?: boolean }
>(({ className, children, icon: Icon, withIconSlot, ...props }, ref) => {
  const shouldShowIconSlot = useMenuIconSlot(withIconSlot, Icon);

  return (
    <SelectPrimitive.Item
      ref={ref}
      className={classNames(menuStyles.item, className)}
      {...props}
    >
      <span className={classNames(menuStyles.leadingIconSlot, 'shrink-0')}>
        <SelectPrimitive.ItemIndicator className="inline-flex h-4 w-4 items-center justify-center">
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {shouldShowIconSlot ? (
        <span className={classNames(menuStyles.leadingIconSlot, !Icon && 'opacity-0')}>
          {Icon ? <Icon className="h-4 w-4" /> : null}
        </span>
      ) : null}
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => {
  const shouldInset = useMenuSeparatorInset(inset);

  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={classNames(shouldInset ? menuStyles.separatorInset : menuStyles.separator, className)}
      {...props}
    />
  );
});
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator };
