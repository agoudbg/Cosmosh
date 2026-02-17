import * as MenubarPrimitive from '@radix-ui/react-menubar';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import classNames from 'classnames';
import { Check, ChevronRight, Dot } from 'lucide-react';
import React from 'react';

import { normalizeCollisionPadding, resolveViewportMenuBounds } from './menu-position';
import { menuStyles } from './menu-styles';

type MenuIconComponent = React.ComponentType<{ className?: string }>;

const Menubar = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Root
    ref={ref}
    className={classNames(menuStyles.menubarRoot, className)}
    {...props}
  />
));
Menubar.displayName = MenubarPrimitive.Root.displayName;

const MenubarMenu = MenubarPrimitive.Menu;
const MenubarGroup = MenubarPrimitive.Group;
const MenubarPortal = MenubarPrimitive.Portal;
const MenubarRadioGroup = MenubarPrimitive.RadioGroup;

const MenubarTrigger = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Trigger
    ref={ref}
    className={classNames(menuStyles.menubarTrigger, className)}
    {...props}
  />
));
MenubarTrigger.displayName = MenubarPrimitive.Trigger.displayName;

const MenubarSubTrigger = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.SubTrigger> & { inset?: boolean; icon?: MenuIconComponent }
>(({ className, inset, children, icon: Icon, ...props }, ref) => (
  <MenubarPrimitive.SubTrigger
    ref={ref}
    className={classNames(menuStyles.item, menuStyles.subTrigger, inset && menuStyles.inset, className)}
    {...props}
  >
    <span className={classNames(menuStyles.leadingIconSlot, !Icon && 'opacity-0')}>
      {Icon && <Icon className="h-4 w-4" />}
    </span>
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </MenubarPrimitive.SubTrigger>
));
MenubarSubTrigger.displayName = MenubarPrimitive.SubTrigger.displayName;

const MenubarSub = MenubarPrimitive.Sub;

const MenubarSubContent = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.SubContent>
>(({ className, sideOffset = 6, collisionPadding = 8, style, ...props }, ref) => {
  const viewportBoundsStyle = resolveViewportMenuBounds();

  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        ref={ref}
        sideOffset={sideOffset}
        avoidCollisions={true}
        sticky="always"
        collisionPadding={normalizeCollisionPadding(collisionPadding)}
        style={{
          ...viewportBoundsStyle,
          ...style,
        }}
        className={classNames(menuStyles.content, className)}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
});
MenubarSubContent.displayName = MenubarPrimitive.SubContent.displayName;

const MenubarContent = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Content>
>(({ className, align = 'start', alignOffset = -4, sideOffset = 6, collisionPadding = 8, style, ...props }, ref) => {
  const viewportBoundsStyle = resolveViewportMenuBounds();

  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        ref={ref}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        avoidCollisions={true}
        sticky="always"
        collisionPadding={normalizeCollisionPadding(collisionPadding)}
        style={{
          ...viewportBoundsStyle,
          ...style,
        }}
        className={classNames(menuStyles.content, className)}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
});
MenubarContent.displayName = MenubarPrimitive.Content.displayName;

const MenubarItem = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Item> & {
    inset?: boolean;
    icon?: MenuIconComponent;
    withIconSlot?: boolean;
  }
>(({ className, inset, icon: Icon, withIconSlot = true, children, ...props }, ref) => (
  <MenubarPrimitive.Item
    ref={ref}
    className={classNames(menuStyles.item, inset && menuStyles.inset, className)}
    {...props}
  >
    {withIconSlot && (
      <span className={classNames(menuStyles.leadingIconSlot, !Icon && 'opacity-0')}>
        {Icon && <Icon className="h-4 w-4" />}
      </span>
    )}
    {children}
  </MenubarPrimitive.Item>
));
MenubarItem.displayName = MenubarPrimitive.Item.displayName;

const MenubarCheckboxItem = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <MenubarPrimitive.CheckboxItem
    ref={ref}
    className={classNames(menuStyles.item, className)}
    checked={checked}
    {...props}
  >
    <span className={menuStyles.itemIndicator}>
      <MenubarPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </MenubarPrimitive.ItemIndicator>
    </span>
    <span className={menuStyles.leadingIconSlot} />
    {children}
  </MenubarPrimitive.CheckboxItem>
));
MenubarCheckboxItem.displayName = MenubarPrimitive.CheckboxItem.displayName;

const MenubarRadioItem = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <MenubarPrimitive.RadioItem
    ref={ref}
    className={classNames(menuStyles.item, className)}
    {...props}
  >
    <span className={menuStyles.itemIndicator}>
      <MenubarPrimitive.ItemIndicator>
        <Dot className="h-4 w-4" />
      </MenubarPrimitive.ItemIndicator>
    </span>
    <span className={menuStyles.leadingIconSlot} />
    {children}
  </MenubarPrimitive.RadioItem>
));
MenubarRadioItem.displayName = MenubarPrimitive.RadioItem.displayName;

const MenubarLabel = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <MenubarPrimitive.Label
    ref={ref}
    className={classNames(menuStyles.label, inset && menuStyles.inset, className)}
    {...props}
  />
));
MenubarLabel.displayName = MenubarPrimitive.Label.displayName;

const MenubarSeparator = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Separator> & { vertical?: boolean }
>(({ className, vertical = false, ...props }, ref) => (
  <MenubarPrimitive.Separator
    ref={ref}
    className={classNames(vertical ? menuStyles.menubarSeparator : menuStyles.separator, className)}
    {...props}
  />
));
MenubarSeparator.displayName = MenubarPrimitive.Separator.displayName;

const MenubarShortcut: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({ className, ...props }) => (
  <span
    className={classNames(menuStyles.shortcut, className)}
    {...props}
  />
);
MenubarShortcut.displayName = 'MenubarShortcut';

const MenuToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={classNames(menuStyles.toggleGroupRoot, className)}
    {...props}
  />
));
MenuToggleGroup.displayName = 'MenuToggleGroup';

const MenuToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={classNames(menuStyles.toggleGroupItem, className)}
    {...props}
  />
));
MenuToggleGroupItem.displayName = 'MenuToggleGroupItem';

export {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarLabel,
  MenubarCheckboxItem,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarPortal,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarGroup,
  MenubarShortcut,
  MenuToggleGroup,
  MenuToggleGroupItem,
};
