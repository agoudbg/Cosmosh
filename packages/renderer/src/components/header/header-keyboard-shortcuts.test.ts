import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveUserMenuAltShortcut, type UserMenuAltShortcutEvent } from './header-keyboard-shortcuts';

/**
 * Creates one keyboard-event fixture for the header shortcut state tests.
 *
 * @param overrides Keyboard fields that differ from a standalone Alt event.
 * @returns Complete keyboard fields consumed by the shortcut resolver.
 */
const createKeyboardEvent = (overrides: Partial<UserMenuAltShortcutEvent> = {}): UserMenuAltShortcutEvent => ({
  key: 'Alt',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

test('user-menu Alt shortcut ignores events originating inside xterm', () => {
  const keyDown = resolveUserMenuAltShortcut(false, 'keydown', createKeyboardEvent(), true);
  const keyUp = resolveUserMenuAltShortcut(keyDown.armed, 'keyup', createKeyboardEvent(), true);

  assert.deepEqual(keyDown, { armed: false, shouldFocusUserMenu: false });
  assert.deepEqual(keyUp, { armed: false, shouldFocusUserMenu: false });
});

test('user-menu Alt shortcut focuses after standalone Alt outside xterm', () => {
  const keyDown = resolveUserMenuAltShortcut(false, 'keydown', createKeyboardEvent(), false);
  const keyUp = resolveUserMenuAltShortcut(keyDown.armed, 'keyup', createKeyboardEvent(), false);

  assert.deepEqual(keyDown, { armed: true, shouldFocusUserMenu: false });
  assert.deepEqual(keyUp, { armed: false, shouldFocusUserMenu: true });
});

test('user-menu Alt shortcut is cancelled when another key forms a chord', () => {
  const altDown = resolveUserMenuAltShortcut(false, 'keydown', createKeyboardEvent(), false);
  const chordDown = resolveUserMenuAltShortcut(
    altDown.armed,
    'keydown',
    createKeyboardEvent({ key: 'ArrowLeft' }),
    false,
  );
  const altUp = resolveUserMenuAltShortcut(chordDown.armed, 'keyup', createKeyboardEvent(), false);

  assert.equal(altDown.armed, true);
  assert.deepEqual(chordDown, { armed: false, shouldFocusUserMenu: false });
  assert.deepEqual(altUp, { armed: false, shouldFocusUserMenu: false });
});

test('user-menu Alt shortcut ignores Alt presses with another modifier', () => {
  const transition = resolveUserMenuAltShortcut(false, 'keydown', createKeyboardEvent({ ctrlKey: true }), false);

  assert.deepEqual(transition, { armed: false, shouldFocusUserMenu: false });
});
