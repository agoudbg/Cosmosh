import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AutocompleteInteractionContext,
  type AutocompleteKeyEvent,
  resolveAutocompleteKeyAction,
} from './terminal-autocomplete-interaction';

const passive: AutocompleteInteractionContext = {
  available: true,
  hasItems: true,
  mode: 'passive',
  acceptKeys: 'tab',
  focusShortcut: 'ctrlShiftSpace',
};
const focused: AutocompleteInteractionContext = { ...passive, mode: 'focused' };

/**
 * Builds native-event values without a DOM dependency.
 *
 * @param key Pressed key.
 * @param modifiers Additional browser event fields.
 * @returns Complete event shape accepted by the production ownership policy.
 */
const keyEvent = (key: string, modifiers: Partial<AutocompleteKeyEvent> = {}): AutocompleteKeyEvent => ({
  key,
  code: '',
  keyCode: 0,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...modifiers,
});

test('passive suggestions preserve native completion, history, submit, escape, and the first typed character', () => {
  for (const key of ['Tab', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'g', '中', 'Backspace', 'Home']) {
    assert.equal(resolveAutocompleteKeyAction(keyEvent(key), passive), 'dismiss-pass', key);
  }
});

test('disabled, disconnected, inactive, and unsupported terminal states cannot capture any key', () => {
  for (const mode of ['passive', 'requested', 'focused'] as const) {
    for (const event of [
      keyEvent('Tab'),
      keyEvent('Enter'),
      keyEvent('ArrowDown'),
      keyEvent(' ', { ctrlKey: true, shiftKey: true }),
    ]) {
      assert.equal(resolveAutocompleteKeyAction(event, { ...focused, mode, available: false }), 'dismiss-pass');
    }
  }
});

test('the focus shortcut enters existing suggestions or requests them without taking ordinary input', () => {
  const shortcut = keyEvent(' ', { code: 'Space', ctrlKey: true, shiftKey: true });
  assert.equal(resolveAutocompleteKeyAction(shortcut, passive), 'focus');
  assert.equal(resolveAutocompleteKeyAction(shortcut, { ...passive, hasItems: false }), 'request');
  const pending: AutocompleteInteractionContext = { ...passive, hasItems: false, mode: 'requested' };
  assert.equal(resolveAutocompleteKeyAction(shortcut, pending), 'consume');
  for (const key of ['Tab', 'Enter', 'g', 'ArrowUp']) {
    assert.equal(resolveAutocompleteKeyAction(keyEvent(key), pending), 'dismiss-pass');
  }
});

test('only the configured shortcut can enter suggestions', () => {
  assert.equal(
    resolveAutocompleteKeyAction(keyEvent(' ', { ctrlKey: true, altKey: true }), {
      ...passive,
      focusShortcut: 'ctrlAltSpace',
    }),
    'focus',
  );
  assert.equal(
    resolveAutocompleteKeyAction(keyEvent('/', { altKey: true }), { ...passive, focusShortcut: 'altSlash' }),
    'focus',
  );
  for (const modifiers of [
    { ctrlKey: true },
    { shiftKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true, metaKey: true },
    { ctrlKey: true, shiftKey: true, altKey: true },
  ]) {
    assert.equal(resolveAutocompleteKeyAction(keyEvent(' ', modifiers), passive), 'dismiss-pass');
  }
});

test('focused suggestions navigate and apply only with configured unmodified keys', () => {
  assert.equal(resolveAutocompleteKeyAction(keyEvent('ArrowDown'), focused), 'next');
  assert.equal(resolveAutocompleteKeyAction(keyEvent('ArrowUp'), focused), 'previous');
  assert.equal(resolveAutocompleteKeyAction(keyEvent('Escape'), focused), 'close');
  for (const acceptKeys of ['tab', 'enter', 'tabEnter'] as const) {
    assert.equal(
      resolveAutocompleteKeyAction(keyEvent('Tab'), { ...focused, acceptKeys }),
      acceptKeys === 'enter' ? 'dismiss-pass' : 'accept',
    );
    assert.equal(
      resolveAutocompleteKeyAction(keyEvent('Enter'), { ...focused, acceptKeys }),
      acceptKeys === 'tab' ? 'dismiss-pass' : 'accept',
    );
  }
  for (const key of ['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'Escape', 'c']) {
    for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      assert.equal(resolveAutocompleteKeyAction(keyEvent(key, modifiers), focused), 'dismiss-pass');
    }
  }
});

test('IME composition and pre-handled events release ownership before any acceptance', () => {
  for (const event of [
    keyEvent('Enter', { isComposing: true }),
    keyEvent('Tab', { keyCode: 229 }),
    keyEvent('Process'),
    keyEvent('Enter', { defaultPrevented: true }),
    keyEvent('中'),
  ]) {
    assert.equal(resolveAutocompleteKeyAction(event, { ...focused, acceptKeys: 'tabEnter' }), 'dismiss-pass');
  }
});

test('modifier key presses do not dismiss a focused menu before its configured shortcut', () => {
  for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
    assert.equal(resolveAutocompleteKeyAction(keyEvent(key), focused), 'pass');
  }
});
