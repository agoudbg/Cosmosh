/** Minimal keyboard fields required by the header Alt access shortcut. */
export type UserMenuAltShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** Result of applying one keyboard event to the user-menu Alt shortcut. */
export interface UserMenuAltShortcutTransition {
  /** Whether a standalone Alt press is still eligible to focus the user menu. */
  armed: boolean;
  /** Whether the user-menu trigger should receive focus for this event. */
  shouldFocusUserMenu: boolean;
}

/**
 * Advances the non-macOS user-menu Alt shortcut without taking ownership of
 * keyboard input that started inside xterm.
 *
 * @param armed Whether a preceding standalone Alt keydown armed the shortcut.
 * @param phase Native keyboard event phase.
 * @param event Keyboard fields used to recognize a standalone Alt press.
 * @param terminalTarget Whether the event originated from an xterm surface.
 * @returns The next armed state and whether the user-menu trigger should be focused.
 */
export const resolveUserMenuAltShortcut = (
  armed: boolean,
  phase: 'keydown' | 'keyup',
  event: UserMenuAltShortcutEvent,
  terminalTarget: boolean,
): UserMenuAltShortcutTransition => {
  if (phase === 'keydown') {
    return {
      armed: event.key === 'Alt' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !terminalTarget,
      shouldFocusUserMenu: false,
    };
  }

  if (event.key !== 'Alt') {
    return { armed, shouldFocusUserMenu: false };
  }

  return { armed: false, shouldFocusUserMenu: armed };
};
