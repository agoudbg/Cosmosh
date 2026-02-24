import React from 'react';

import { getLocale, onLocaleChange, t } from '../../lib/i18n';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from './context-menu';
import {
  getRegisteredInputContextMenuItems,
  InputContextMenuItem,
  InputMenuTarget,
} from './input-context-menu-registry';

const isSupportedInput = (element: Element): element is InputMenuTarget => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  const textLikeTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

  return textLikeTypes.has(element.type);
};

const INPUT_CONTEXT_MENU_IGNORE_SELECTOR = '[data-input-context-menu-ignore="true"]';

const isInsideIgnoredInputContextMenuRegion = (node: Element): boolean => {
  return node.closest(INPUT_CONTEXT_MENU_IGNORE_SELECTOR) !== null;
};

const getEditableTarget = (node: EventTarget | null): InputMenuTarget | null => {
  if (!(node instanceof Element)) {
    return null;
  }

  if (isInsideIgnoredInputContextMenuRegion(node)) {
    return null;
  }

  const editable = node.closest('input, textarea');
  if (!editable || !isSupportedInput(editable)) {
    return null;
  }

  if (isInsideIgnoredInputContextMenuRegion(editable)) {
    return null;
  }

  if (editable.disabled) {
    return null;
  }

  return editable;
};

const isMac = navigator.platform.toLowerCase().includes('mac');

const shortcut = {
  undo: isMac ? '⌘Z' : 'Ctrl+Z',
  redo: isMac ? '⇧⌘Z' : 'Ctrl+Y',
  cut: isMac ? '⌘X' : 'Ctrl+X',
  copy: isMac ? '⌘C' : 'Ctrl+C',
  paste: isMac ? '⌘V' : 'Ctrl+V',
  selectAll: isMac ? '⌘A' : 'Ctrl+A',
};

const executeCommand = (target: InputMenuTarget, command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste'): boolean => {
  target.focus({ preventScroll: true });

  return document.execCommand(command);
};

const insertAtCursor = (target: InputMenuTarget, text: string): void => {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.setRangeText(text, start, end, 'end');
};

const handlePaste = async (target: InputMenuTarget): Promise<void> => {
  try {
    const pasted = executeCommand(target, 'paste');

    if (!pasted && !target.readOnly) {
      const text = await navigator.clipboard.readText();
      insertAtCursor(target, text);
    }
  } catch {
    if (!target.readOnly) {
      const text = await navigator.clipboard.readText();
      insertAtCursor(target, text);
    }
  }
};

const hasSelection = (target: InputMenuTarget): boolean => (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0);

const buildDefaultItems = (target: InputMenuTarget): InputContextMenuItem[] => [
  {
    key: 'undo',
    label: t('inputContextMenu.undo'),
    shortcut: shortcut.undo,
    disabled: target.readOnly,
    onSelect: (currentTarget) => executeCommand(currentTarget, 'undo'),
  },
  {
    key: 'redo',
    label: t('inputContextMenu.redo'),
    shortcut: shortcut.redo,
    disabled: target.readOnly,
    onSelect: (currentTarget) => executeCommand(currentTarget, 'redo'),
  },
  {
    key: 'cut',
    label: t('inputContextMenu.cut'),
    shortcut: shortcut.cut,
    disabled: (currentTarget) => currentTarget.readOnly || !hasSelection(currentTarget),
    onSelect: (currentTarget) => executeCommand(currentTarget, 'cut'),
  },
  {
    key: 'copy',
    label: t('inputContextMenu.copy'),
    shortcut: shortcut.copy,
    disabled: (currentTarget) => !hasSelection(currentTarget),
    onSelect: (currentTarget) => executeCommand(currentTarget, 'copy'),
  },
  {
    key: 'paste',
    label: t('inputContextMenu.paste'),
    shortcut: shortcut.paste,
    disabled: target.readOnly,
    onSelect: (currentTarget) => {
      void handlePaste(currentTarget);
    },
  },
  {
    key: 'select-all',
    label: t('inputContextMenu.selectAll'),
    shortcut: shortcut.selectAll,
    disabled: (currentTarget) => currentTarget.value.length === 0,
    onSelect: (currentTarget) => {
      currentTarget.focus({ preventScroll: true });
      currentTarget.select();
    },
  },
];

const resolveDisabled = (item: InputContextMenuItem, target: InputMenuTarget): boolean =>
  typeof item.disabled === 'function' ? item.disabled(target) : item.disabled === true;

const InputContextMenuProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const clearTargetTimerRef = React.useRef<number | null>(null);
  const [, setLocaleState] = React.useState(getLocale());
  const [target, setTarget] = React.useState<InputMenuTarget | null>(null);
  const [position, setPosition] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [openToken, setOpenToken] = React.useState<number>(0);

  React.useEffect(() => {
    return onLocaleChange((nextLocale) => {
      setLocaleState(nextLocale);
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (clearTargetTimerRef.current) {
        window.clearTimeout(clearTargetTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    const onContextMenuCapture = (event: MouseEvent): void => {
      const editableTarget = getEditableTarget(event.target);
      if (!editableTarget) {
        return;
      }

      event.preventDefault();
      editableTarget.focus({ preventScroll: true });

      setTarget(editableTarget);
      setPosition({ x: event.clientX, y: event.clientY });
      setOpenToken((value) => value + 1);
    };

    document.addEventListener('contextmenu', onContextMenuCapture, { capture: true });

    return () => {
      document.removeEventListener('contextmenu', onContextMenuCapture, { capture: true });
    };
  }, []);

  React.useEffect(() => {
    if (!target || !triggerRef.current || openToken === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      triggerRef.current?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: position.x,
          clientY: position.y,
          button: 2,
        }),
      );
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [openToken, position.x, position.y, target]);

  const defaultNodes = target
    ? buildDefaultItems(target).flatMap((item) => {
        const nodes: React.ReactNode[] = [];

        if (item.key === 'cut' || item.key === 'select-all') {
          nodes.push(<ContextMenuSeparator key={`sep-${item.key}`} />);
        }

        nodes.push(
          <ContextMenuItem
            key={item.key}
            disabled={!target || resolveDisabled(item, target)}
            onSelect={() => {
              if (!target) {
                return;
              }

              item.onSelect(target);
            }}
          >
            {item.label}
            {item.shortcut && <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut>}
          </ContextMenuItem>,
        );

        return nodes;
      })
    : [];
  const customNodes = (() => {
    if (!target) {
      return [] as React.ReactNode[];
    }

    const items = getRegisteredInputContextMenuItems(target);
    if (!items || items.length === 0) {
      return [] as React.ReactNode[];
    }

    const nodes: React.ReactNode[] = [<ContextMenuSeparator key="sep-custom" />];

    items.forEach((item) => {
      nodes.push(
        <ContextMenuItem
          key={item.key}
          icon={item.icon}
          disabled={!target || resolveDisabled(item, target)}
          onSelect={() => {
            if (!target) {
              return;
            }

            item.onSelect(target);
          }}
        >
          {item.label}
          {item.shortcut && <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut>}
        </ContextMenuItem>,
      );
    });

    return nodes;
  })();

  const handleOpenChange = React.useCallback((open: boolean) => {
    if (open) {
      if (clearTargetTimerRef.current) {
        window.clearTimeout(clearTargetTimerRef.current);
        clearTargetTimerRef.current = null;
      }
      return;
    }

    clearTargetTimerRef.current = window.setTimeout(() => {
      setTarget(null);
      clearTargetTimerRef.current = null;
    }, 140);
  }, []);

  return (
    <>
      {children}
      <ContextMenu onOpenChange={handleOpenChange}>
        <ContextMenuTrigger asChild>
          <span
            ref={triggerRef}
            aria-hidden
            className="pointer-events-none fixed"
            style={{ left: position.x, top: position.y, width: 1, height: 1 }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          {defaultNodes}
          {customNodes}
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
};

export { InputContextMenuProvider };
