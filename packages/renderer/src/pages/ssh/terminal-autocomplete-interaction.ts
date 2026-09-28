import type { SettingsValues } from '@cosmosh/api-contract';

/** Keyboard ownership of the suggestion list; requesting never owns ordinary input. */
export type AutocompleteInteractionMode = 'passive' | 'requested' | 'focused';

/** Actions consumed by the live terminal key handler. */
export type AutocompleteKeyAction =
  'pass' | 'dismiss-pass' | 'focus' | 'request' | 'consume' | 'previous' | 'next' | 'accept' | 'close';

/** Current ownership and settings, read synchronously for each key event. */
export type AutocompleteInteractionContext = {
  available: boolean;
  hasItems: boolean;
  mode: AutocompleteInteractionMode;
  acceptKeys: SettingsValues['terminalAutoCompleteAcceptKeys'];
  focusShortcut: SettingsValues['terminalAutoCompleteFocusShortcut'];
};

/** Native keyboard fields needed to preserve IME and modified terminal shortcuts. */
export type AutocompleteKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'keyCode' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing' | 'defaultPrevented'
>;

/**
 * Resolves key ownership without synthesizing terminal input or changing focus.
 *
 * @param event Original terminal keyboard event.
 * @param context Latest list state and feature gates.
 * @returns Action; pass actions must leave the original event untouched.
 */
export const resolveAutocompleteKeyAction = (
  event: AutocompleteKeyEvent,
  context: AutocompleteInteractionContext,
): AutocompleteKeyAction => {
  if (
    !context.available ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === 'Process'
  ) {
    return 'dismiss-pass';
  }

  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
    return 'pass';
  }

  const isSpace = event.code === 'Space' || event.key === ' ';
  const focusShortcutMatches =
    !event.metaKey &&
    ((context.focusShortcut === 'ctrlShiftSpace' && isSpace && event.ctrlKey && event.shiftKey && !event.altKey) ||
      (context.focusShortcut === 'ctrlAltSpace' && isSpace && event.ctrlKey && event.altKey && !event.shiftKey) ||
      (context.focusShortcut === 'altSlash' && event.key === '/' && event.altKey && !event.ctrlKey && !event.shiftKey));
  if (focusShortcutMatches) {
    return context.hasItems ? 'focus' : context.mode === 'requested' ? 'consume' : 'request';
  }

  if (
    context.mode !== 'focused' ||
    !context.hasItems ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    event.metaKey
  ) {
    return 'dismiss-pass';
  }

  if (event.key === 'Escape') return 'close';
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'previous';
  if (event.key === 'Tab' && context.acceptKeys !== 'enter') return 'accept';
  if (event.key === 'Enter' && context.acceptKeys !== 'tab') return 'accept';
  return 'dismiss-pass';
};
