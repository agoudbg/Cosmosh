import type { ComponentType } from 'react';
import { useEffect } from 'react';

export type InputMenuTarget = HTMLInputElement | HTMLTextAreaElement;
type MenuIconComponent = ComponentType<{ className?: string }>;

export type InputContextMenuItem = {
  key: string;
  label: string;
  onSelect: (target: InputMenuTarget) => void;
  disabled?: boolean | ((target: InputMenuTarget) => boolean);
  icon?: MenuIconComponent;
  shortcut?: string;
};

const customItemsRegistry = new WeakMap<InputMenuTarget, InputContextMenuItem[]>();

export const registerInputContextMenuItems = (target: InputMenuTarget, items?: InputContextMenuItem[]): void => {
  if (!items || items.length === 0) {
    customItemsRegistry.delete(target);
    return;
  }

  customItemsRegistry.set(target, items);
};

const unregisterInputContextMenuItems = (target: InputMenuTarget): void => {
  customItemsRegistry.delete(target);
};

export const getRegisteredInputContextMenuItems = (target: InputMenuTarget): InputContextMenuItem[] | undefined =>
  customItemsRegistry.get(target);

export const useRegisterInputContextMenuItems = (
  target: InputMenuTarget | null,
  items?: InputContextMenuItem[],
): void => {
  useEffect(() => {
    if (!target) {
      return;
    }

    registerInputContextMenuItems(target, items);

    return () => {
      unregisterInputContextMenuItems(target);
    };
  }, [items, target]);
};
