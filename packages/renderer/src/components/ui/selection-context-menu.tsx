import { Copy } from 'lucide-react';
import React from 'react';

import { getLocale, onLocaleChange, t } from '../../lib/i18n';
import {
  CONTEXT_MENU_TRIGGER_SELECTOR,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from './context-menu';
import { textEditingShortcut } from './text-editing-context-menu-utils';

type SelectionContextMenuState = {
  position: {
    x: number;
    y: number;
  };
  text: string;
};

const INPUT_CONTEXT_MENU_IGNORE_SELECTOR = '[data-input-context-menu-ignore="true"]';
const INTERACTIVE_CONTEXT_MENU_IGNORE_SELECTOR = [
  'a[href]',
  'button',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[data-role="sortable-tab"]',
].join(', ');
const SELECTION_CONTEXT_MENU_IGNORE_SELECTOR = [
  INPUT_CONTEXT_MENU_IGNORE_SELECTOR,
  INTERACTIVE_CONTEXT_MENU_IGNORE_SELECTOR,
  CONTEXT_MENU_TRIGGER_SELECTOR,
  '.cm-editor',
].join(', ');
const SELECTION_COPY_SHORTCUT_IGNORE_SELECTOR = [
  INPUT_CONTEXT_MENU_IGNORE_SELECTOR,
  CONTEXT_MENU_TRIGGER_SELECTOR,
  '.cm-editor',
].join(', ');

/**
 * Resolves an event target to the closest element that can be queried with DOM selectors.
 *
 * @param target Event target from the native context-menu event.
 * @returns The target element or a parent element for text nodes.
 */
const resolveTargetElement = (target: EventTarget | null): Element | null => {
  if (target instanceof Element) {
    return target;
  }

  if (target instanceof Node) {
    return target.parentElement;
  }

  return null;
};

/**
 * Determines whether a node is inside an editable or specialized interaction surface.
 *
 * @param node Event target to inspect.
 * @returns True when the selection fallback menu should not handle the event.
 */
const isInsideIgnoredSelectionRegion = (node: EventTarget | null): boolean => {
  const element = resolveTargetElement(node);
  if (!element) {
    return true;
  }

  if (element.closest(SELECTION_CONTEXT_MENU_IGNORE_SELECTOR)) {
    return true;
  }

  if (element.closest('input, textarea')) {
    return true;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }

  return false;
};

/**
 * Determines whether the keyboard selection copy shortcut must stay disabled.
 *
 * Unlike the context-menu ignore list this intentionally keeps generic
 * interactive elements eligible: browsers still copy page selections while
 * buttons, links, or Radix menu items hold focus, and menu items must keep
 * the shortcut alive while the fallback menu displays its Ctrl+C hint.
 *
 * @param node Focused element or selection anchor node to inspect.
 * @returns True when the surface owns its own copy behavior or is not resolvable.
 */
const isInsideSelectionCopyShortcutIgnoredRegion = (node: EventTarget | null): boolean => {
  const element = resolveTargetElement(node);
  if (!element) {
    return true;
  }

  if (element.closest(SELECTION_COPY_SHORTCUT_IGNORE_SELECTOR)) {
    return true;
  }

  return element instanceof HTMLElement && element.isContentEditable;
};

/**
 * Checks whether a client coordinate is inside a DOMRect with a small edge tolerance.
 *
 * @param rect Selection rectangle from the browser selection range.
 * @param x Client-space x coordinate.
 * @param y Client-space y coordinate.
 * @returns True when the coordinate is inside the rectangle.
 */
const isPointInsideRect = (rect: DOMRect, x: number, y: number): boolean => {
  const tolerance = 1;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left - tolerance &&
    x <= rect.right + tolerance &&
    y >= rect.top - tolerance &&
    y <= rect.bottom + tolerance
  );
};

/**
 * Checks whether the context-menu point lands inside any current selection range.
 *
 * @param selection Browser selection to inspect.
 * @param x Client-space x coordinate.
 * @param y Client-space y coordinate.
 * @returns True when the coordinate is inside one of the selected text rectangles.
 */
const isPointInsideSelection = (selection: Selection, x: number, y: number): boolean => {
  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const range = selection.getRangeAt(rangeIndex);
    const rects = range.getClientRects();

    for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
      if (isPointInsideRect(rects[rectIndex], x, y)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Resolves the plain text selection menu state for a context-menu event.
 *
 * @param event Native context-menu event.
 * @returns Menu state when ordinary selected text should expose copy; otherwise null.
 */
const resolveSelectionContextMenuState = (event: MouseEvent): SelectionContextMenuState | null => {
  if (isInsideIgnoredSelectionRegion(event.target)) {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const text = selection.toString();
  if (text.length === 0) {
    return null;
  }

  if (!isPointInsideSelection(selection, event.clientX, event.clientY)) {
    return null;
  }

  return {
    position: {
      x: event.clientX,
      y: event.clientY,
    },
    text,
  };
};

/**
 * Copies text through the legacy selection command after async Clipboard API failure.
 *
 * @param text Text to copy.
 * @returns True when the legacy command reports success.
 */
const copyTextWithExecCommand = (text: string): boolean => {
  const selection = window.getSelection();
  const previousRanges: Range[] = [];

  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';

  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();

    if (selection && previousRanges.length > 0) {
      selection.removeAllRanges();
      previousRanges.forEach((range) => selection.addRange(range));
    }
  }

  return copied;
};

/**
 * Copies selected plain text with Clipboard API first and legacy copy command second.
 *
 * @param text Text captured when the context menu opened.
 * @returns Nothing.
 */
const copySelectedText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    try {
      copyTextWithExecCommand(text);
    } catch {
      // Keep this system-level fallback quiet when browser clipboard access is unavailable.
    }
  }
};

/**
 * Provides a global fallback context menu and copy shortcut for ordinary
 * non-editable text selections.
 *
 * @param props.children Application content wrapped by the provider.
 * @returns Provider markup and hidden Radix trigger.
 */
const SelectionContextMenuProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const clearTargetTimerRef = React.useRef<number | null>(null);
  const [, setLocaleState] = React.useState(getLocale());
  const [menuState, setMenuState] = React.useState<SelectionContextMenuState | null>(null);
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
      const nextMenuState = resolveSelectionContextMenuState(event);
      if (!nextMenuState) {
        return;
      }

      event.preventDefault();

      setMenuState(nextMenuState);
      setOpenToken((value) => value + 1);
    };

    document.addEventListener('contextmenu', onContextMenuCapture, { capture: true });

    return () => {
      document.removeEventListener('contextmenu', onContextMenuCapture, { capture: true });
    };
  }, []);

  React.useEffect(() => {
    // Windows/Linux remove the application menu, so no Edit-menu Copy role
    // dispatches Ctrl+C into webContents.copy(). Editable targets still copy
    // through Chromium's internal editing, but non-editable page selections
    // need this renderer fallback to honor the shortcut the fallback menu
    // displays. macOS keeps the native Edit menu Copy role instead.
    if (window.electron?.platform === 'darwin') {
      return;
    }

    const handleSelectionCopyShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.altKey || event.shiftKey || !event.ctrlKey) {
        return;
      }

      const normalizedKey = event.key.toLowerCase();
      if (normalizedKey !== 'c' && event.code !== 'KeyC') {
        return;
      }

      if (isInsideSelectionCopyShortcutIgnoredRegion(document.activeElement)) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return;
      }

      const text = selection.toString();
      if (text.length === 0) {
        return;
      }

      // Selections anchored inside dedicated surfaces such as xterm panes keep
      // their own Ctrl+C semantics (sending SIGINT); terminal copy stays on
      // Ctrl+Shift+C through the SSH page shortcut handler.
      if (isInsideSelectionCopyShortcutIgnoredRegion(selection.anchorNode)) {
        return;
      }

      event.preventDefault();
      void copySelectedText(text);
    };

    window.addEventListener('keydown', handleSelectionCopyShortcut);

    return () => {
      window.removeEventListener('keydown', handleSelectionCopyShortcut);
    };
  }, []);

  React.useEffect(() => {
    if (!menuState || !triggerRef.current || openToken === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      triggerRef.current?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: menuState.position.x,
          clientY: menuState.position.y,
          button: 2,
        }),
      );
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [menuState, openToken]);

  const handleOpenChange = React.useCallback((open: boolean) => {
    if (open) {
      if (clearTargetTimerRef.current) {
        window.clearTimeout(clearTargetTimerRef.current);
        clearTargetTimerRef.current = null;
      }
      return;
    }

    clearTargetTimerRef.current = window.setTimeout(() => {
      setMenuState(null);
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
            style={{
              left: menuState?.position.x ?? 0,
              top: menuState?.position.y ?? 0,
              width: 1,
              height: 1,
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            icon={Copy}
            disabled={!menuState}
            onSelect={() => {
              if (!menuState) {
                return;
              }

              void copySelectedText(menuState.text);
            }}
          >
            {t('inputContextMenu.copy')}
            <ContextMenuShortcut>{textEditingShortcut.copy}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
};

export { SelectionContextMenuProvider };
