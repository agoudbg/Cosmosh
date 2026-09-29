import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS_VALUES, normalizeSettingsValuesStrict } from '@cosmosh/api-contract';

import { SETTINGS_REGISTRY, VISIBLE_SETTINGS_REGISTRY } from './settings-registry';

test('hidden terminal compatibility settings survive complete form serialization', () => {
  const saved = { ...DEFAULT_SETTINGS_VALUES, terminalAutoCompletePromptRegex: '^custom-prompt>\\s*' };
  const submitted = Object.fromEntries(SETTINGS_REGISTRY.map((setting) => [setting.key, saved[setting.key]]));
  const result = normalizeSettingsValuesStrict(submitted);
  assert.ok(result.value, JSON.stringify(result.error));
  assert.equal(result.value.terminalAutoCompletePromptRegex, saved.terminalAutoCompletePromptRegex);
  assert.equal(
    VISIBLE_SETTINGS_REGISTRY.some((setting) => setting.key === 'terminalAutoCompletePromptRegex'),
    false,
  );
});

test('visible terminal settings are the public discovery surface', () => {
  const hiddenKeys = SETTINGS_REGISTRY.filter((setting) => !VISIBLE_SETTINGS_REGISTRY.includes(setting)).map(
    (setting) => setting.key,
  );
  assert.deepEqual(hiddenKeys, ['terminalAutoCompletePromptRegex']);
});
