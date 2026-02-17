import { ChevronDownIcon, ChevronUpIcon } from '@radix-ui/react-icons';
import * as SelectPrimitive from '@radix-ui/react-select';
import classNames from 'classnames';
import { Check } from 'lucide-react';
import React from 'react';

import { normalizeCollisionPadding, resolveViewportMenuBounds } from './menu-position';
import { menuStyles } from './menu-styles';

type MenuIconComponent = React.ComponentType<{ className?: string }>;

const Select = SelectPrimitive.Root;
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
  const viewportBoundsStyle = resolveViewportMenuBounds();

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        avoidCollisions
        className={classNames(menuStyles.content, className)}
        position={position}
        sideOffset={sideOffset}
        sticky="always"
        collisionPadding={normalizeCollisionPadding(collisionPadding)}
        style={{
          ...viewportBoundsStyle,
          ...style,
        }}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-header-text-muted">
          <ChevronUpIcon className={menuStyles.iconSlot} />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
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
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { icon?: MenuIconComponent }
>(({ className, children, icon: Icon, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={classNames(menuStyles.item, className)}
    {...props}
  >
    <span className={menuStyles.itemIndicator}>
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <span className={classNames(menuStyles.leadingIconSlot, !Icon && 'opacity-0')}>
      {Icon && <Icon className="h-4 w-4" />}
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={classNames(menuStyles.separator, className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator };
