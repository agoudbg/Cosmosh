import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS_VALUES,
  normalizeSettingsValuesStrict,
  normalizeSettingsValuesWithDefaults,
} from '@cosmosh/api-contract';

import { parseStoredSettingsValues } from '../settings/validation.js';
import { resolveShellPermissions } from './shell-context.js';

test('native query settings default to manual and preserve saved opt-outs across migration', () => {
  assert.equal(DEFAULT_SETTINGS_VALUES.terminalNativeCompletionMode, 'manual');
  const cases = [
    [{}, 'manual'],
    [{ terminalNativeCompletionEnabled: false }, 'off'],
    [{ terminalNativeCompletionEnabled: true }, 'manual'],
    [{ terminalNativeCompletionEnabled: 'true' }, 'off'],
    [{ terminalNativeCompletionMode: 'off' }, 'off'],
    [{ terminalNativeCompletionMode: 'manual' }, 'manual'],
    [{ terminalNativeCompletionMode: 'automatic', terminalNativeCompletionEnabled: false }, 'automatic'],
    [{ terminalNativeCompletionMode: 'invalid', terminalNativeCompletionEnabled: true }, 'off'],
    [{ terminalNativeCompletionMode: null }, 'off'],
  ] as const;
  for (const [saved, expected] of cases) {
    for (const values of [
      normalizeSettingsValuesWithDefaults(saved),
      parseStoredSettingsValues(JSON.stringify(saved)),
    ]) {
      assert.equal(values.terminalNativeCompletionMode, expected);
      assert.equal('terminalNativeCompletionEnabled' in values, false);
      assert.equal(resolveShellPermissions(values, true).nativeCompletion, expected !== 'off');
      assert.equal(resolveShellPermissions(values, false).nativeCompletion, false);
      assert.equal(
        resolveShellPermissions({ ...values, remoteEnhancementsEnabled: false }, true).nativeCompletion,
        false,
      );
      assert.deepEqual(normalizeSettingsValuesStrict(values).value, values, 'a migrated profile remains saveable');
    }
  }
});

test('native query settings reject invalid current writes and retired switch fields', () => {
  for (const mode of ['off', 'manual', 'automatic']) {
    assert.equal(
      normalizeSettingsValuesStrict({ ...DEFAULT_SETTINGS_VALUES, terminalNativeCompletionMode: mode }).value
        ?.terminalNativeCompletionMode,
      mode,
    );
  }
  for (const mode of [true, false, null, 'enabled', '', 1, ['manual']]) {
    assert.equal(
      normalizeSettingsValuesStrict({ ...DEFAULT_SETTINGS_VALUES, terminalNativeCompletionMode: mode }).value,
      undefined,
    );
  }
  assert.equal(
    normalizeSettingsValuesStrict({ ...DEFAULT_SETTINGS_VALUES, terminalNativeCompletionEnabled: true }).value,
    undefined,
  );
});
