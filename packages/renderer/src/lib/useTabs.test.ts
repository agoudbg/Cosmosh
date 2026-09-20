import assert from 'node:assert/strict';
import test from 'node:test';

import { insertTabAtRequestedPosition, orderTabsByRecentUse } from './useTabs';

type TestTab = {
  id: string;
};

const baseTabs: TestTab[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

/**
 * Resolves tab ids from a test tab list.
 *
 * @param tabs Test tabs in display order.
 * @returns Tab ids in display order.
 */
const ids = (tabs: ReadonlyArray<TestTab>): string[] => tabs.map((tab) => tab.id);

test('tab insertion appends by default', () => {
  const nextTabs = insertTabAtRequestedPosition(baseTabs, { id: 'next' });

  assert.deepEqual(ids(nextTabs), ['a', 'b', 'c', 'next']);
});

test('tab insertion places anchored tabs immediately to the right', () => {
  const nextTabs = insertTabAtRequestedPosition(baseTabs, { id: 'next' }, { insertAfterTabId: 'b' });

  assert.deepEqual(ids(nextTabs), ['a', 'b', 'next', 'c']);
});

test('tab insertion appends when anchor is missing', () => {
  const nextTabs = insertTabAtRequestedPosition(baseTabs, { id: 'next' }, { insertAfterTabId: 'missing' });

  assert.deepEqual(ids(nextTabs), ['a', 'b', 'c', 'next']);
});

test('tab insertion appends when anchor is already last', () => {
  const nextTabs = insertTabAtRequestedPosition(baseTabs, { id: 'next' }, { insertAfterTabId: 'c' });

  assert.deepEqual(ids(nextTabs), ['a', 'b', 'c', 'next']);
});

test('recent tab ordering places the most recently used tab first', () => {
  const orderedTabs = orderTabsByRecentUse(baseTabs, ['b', 'a', 'c']);

  assert.deepEqual(ids(orderedTabs), ['b', 'a', 'c']);
});

test('recent tab ordering ignores closed history and preserves unseen tab order', () => {
  const orderedTabs = orderTabsByRecentUse(baseTabs, ['missing', 'c']);

  assert.deepEqual(ids(orderedTabs), ['c', 'a', 'b']);
});
