import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import classNames from 'classnames';
import { Check, ChevronRight, Dot } from 'lucide-react';
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

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    icon?: MenuIconComponent;
    withIconSlot?: boolean;
  }
>(({ className, inset, children, icon: Icon, withIconSlot, ...props }, ref) => {
  const shouldShowIconSlot = useMenuIconSlot(withIconSlot, Icon);

  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={classNames(menuStyles.item, menuStyles.subTrigger, inset && menuStyles.inset, className)}
      {...props}
    >
      {shouldShowIconSlot && (
        <span className={classNames(menuStyles.leadingIconSlot, !Icon && 'opacity-0')}>
          {Icon && <Icon className="h-4 w-4" />}
        </span>
      )}
      {children}
      <ChevronRight className="ml-auto h-4 w-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, sideOffset = 6, collisionPadding = 8, style, ...props }, ref) => {
  const viewportBoundsStyle = resolveViewportMenuBounds();
  const hasLeadingVisual = resolveMenuHasLeadingVisual(props.children);

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        avoidCollisions
        sideOffset={sideOffset}
        sticky="always"
        collisionPadding={normalizeCollisionPadding(collisionPadding)}
        style={{
          ...viewportBoundsStyle,
          ...style,
        }}
        className={classNames(menuStyles.content, className)}
        {...props}
      >
        <MenuIconSlotContext.Provider value={hasLeadingVisual}>{props.children}</MenuIconSlotContext.Provider>
      </DropdownMenuPrimitive.SubContent>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, style, ...props }, ref) => {
  const viewportBoundsStyle = resolveViewportMenuBounds();
  const hasLeadingVisual = resolveMenuHasLeadingVisual(props.children);

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        avoidCollisions
        sideOffset={sideOffset}
        sticky="always"
        collisionPadding={normalizeCollisionPadding(collisionPadding)}
        style={{
          ...viewportBoundsStyle,
          ...style,
        }}
        className={classNames(menuStyles.content, className)}
        {...props}
      >
        <MenuIconSlotContext.Provider value={hasLeadingVisual}>{props.children}</MenuIconSlotContext.Provider>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    icon?: MenuIconComponent;
    withIconSlot?: boolean;
  }
>(({ className, inset, icon: Icon, withIconSlot, children, ...props }, ref) => {
  const shouldShowIconSlot = useMenuIconSlot(withIconSlot, Icon);

  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={classNames(menuStyles.item, inset && menuStyles.inset, className)}
      {...props}
    >
      {shouldShowIconSlot && (
        <span className={classNames(menuStyles.leadingIconSlot, !Icon && 'opacity-0')}>
          {Icon && <Icon className="h-4 w-4" />}
        </span>
      )}
      {children}
    </DropdownMenuPrimitive.Item>
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={classNames(menuStyles.item, className)}
    checked={checked}
    {...props}
  >
    <span className={menuStyles.itemIndicator}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    <span className={menuStyles.leadingIconSlot} />
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={classNames(menuStyles.item, className)}
    {...props}
  >
    <span className={menuStyles.itemIndicator}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Dot className="h-4 w-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    <span className={menuStyles.leadingIconSlot} />
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={classNames(menuStyles.label, inset && menuStyles.inset, className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => {
  const shouldInset = useMenuSeparatorInset(inset);

  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={classNames(shouldInset ? menuStyles.separatorInset : menuStyles.separator, className)}
      {...props}
    />
  );
});
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({ className, ...props }) => (
  <span
    className={classNames(menuStyles.shortcut, className)}
    {...props}
  />
);
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
