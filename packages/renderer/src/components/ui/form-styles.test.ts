import assert from 'node:assert/strict';
import test from 'node:test';

import { formStyles } from './form-styles.ts';

test('shared form labels use the semantic compact font-size token', () => {
  assert.match(formStyles.label, /\btext-form-label\b/);
  assert.doesNotMatch(formStyles.label, /\btext-sm\b/);
});

test('Settings descriptions use the slightly subdued muted-text tier', () => {
  assert.match(formStyles.helperText, /\btext-form-text-muted\b/);
  assert.match(formStyles.helperText, /\bopacity-80\b/);
});
