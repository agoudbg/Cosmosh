import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTabWidth } from './tabs-layout';

test('tab width accounts for dividers before distributing available space', () => {
  assert.equal(resolveTabWidth(500, 3), 165);
});

test('tab width preserves the maximum when dividers still fit', () => {
  assert.equal(resolveTabWidth(544, 3), 180);
});

test('tab width keeps the minimum when the tab list must scroll', () => {
  assert.equal(resolveTabWidth(300, 3), 120);
});
