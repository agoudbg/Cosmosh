import React from 'react';

type NodeWithProps = {
  icon?: unknown;
  withIconSlot?: boolean;
  children?: React.ReactNode;
};

const LEADING_VISUAL_ITEM_NAME_PATTERN = /(CheckboxItem|RadioItem)$/;

export const MenuIconSlotContext = React.createContext(false);

export const resolveMenuHasLeadingVisual = (node: React.ReactNode): boolean =>
  React.Children.toArray(node).some((child) => {
    if (!React.isValidElement<NodeWithProps>(child)) {
      return false;
    }

    const props = child.props;
    const displayName =
      typeof child.type === 'string'
        ? child.type
        : 'displayName' in child.type
          ? (child.type.displayName as string | undefined)
          : undefined;

    if (props.withIconSlot === true || Boolean(props.icon)) {
      return true;
    }

    if (displayName && LEADING_VISUAL_ITEM_NAME_PATTERN.test(displayName)) {
      return true;
    }

    return resolveMenuHasLeadingVisual(props.children);
  });

export const useMenuIconSlot = (withIconSlot: boolean | undefined, icon: unknown): boolean => {
  const contextValue = React.useContext(MenuIconSlotContext);

  if (typeof withIconSlot === 'boolean') {
    return withIconSlot;
  }

  return contextValue || Boolean(icon);
};

export const useMenuSeparatorInset = (inset: boolean | undefined): boolean => {
  const contextValue = React.useContext(MenuIconSlotContext);

  if (typeof inset === 'boolean') {
    return inset;
  }

  return contextValue;
};
