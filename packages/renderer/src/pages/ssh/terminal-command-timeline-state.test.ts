import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_TIMELINE_IDLE_TIMEOUT_MS,
  resolveCommandTimelineEntryHeight,
  resolveCommandTimelineEntryHitHeight,
  resolveCommandTimelineIdleDelay,
  selectCommandTimelineEntryItems,
  selectCommandTimelineMenuItems,
  shouldAllowCommandTimelineEntryPointerEvents,
  shouldDismissCommandTimelineForPointerLeave,
  shouldShowCommandTimelineEntry,
} from './terminal-command-timeline-state';

test('timeline entry projects only the newest eight commands in submission order', () => {
  const commands = Array.from({ length: 12 }, (_, index) => `command-${index + 1}`);

  assert.deepEqual(selectCommandTimelineEntryItems(commands), commands.slice(4));
  assert.deepEqual(selectCommandTimelineEntryItems(commands.slice(0, 3)), commands.slice(0, 3));
});

test('timeline menu projects only the newest 100 commands in submission order', () => {
  const commands = Array.from({ length: 105 }, (_, index) => `command-${index + 1}`);
  const menuItems = selectCommandTimelineMenuItems(commands);

  assert.equal(menuItems.length, 100);
  assert.deepEqual(menuItems, commands.slice(5));
  assert.deepEqual(selectCommandTimelineMenuItems(commands.slice(0, 3)), commands.slice(0, 3));
});

test('timeline entry height matches its capped line and gap geometry', () => {
  assert.equal(resolveCommandTimelineEntryHeight(0), 0);
  assert.equal(resolveCommandTimelineEntryHeight(1), 2);
  assert.equal(resolveCommandTimelineEntryHeight(3), 26);
  assert.equal(resolveCommandTimelineEntryHeight(8), 86);
  assert.equal(resolveCommandTimelineEntryHeight(12), 86);
  assert.equal(resolveCommandTimelineEntryHeight(-1), 0);
  assert.equal(resolveCommandTimelineEntryHeight(Number.NaN), 0);
});

test('timeline entry pointer target adds padding without filling the rail', () => {
  assert.equal(resolveCommandTimelineEntryHitHeight(0), 0);
  assert.equal(resolveCommandTimelineEntryHitHeight(1), 18);
  assert.equal(resolveCommandTimelineEntryHitHeight(3), 42);
  assert.equal(resolveCommandTimelineEntryHitHeight(8), 102);
  assert.equal(resolveCommandTimelineEntryHitHeight(12), 102);
});

test('timeline idle delay follows the latest activity deadline', () => {
  assert.equal(resolveCommandTimelineIdleDelay(1_000, 1_000), COMMAND_TIMELINE_IDLE_TIMEOUT_MS);
  assert.equal(resolveCommandTimelineIdleDelay(1_000, 3_500), 2_500);
  assert.equal(resolveCommandTimelineIdleDelay(1_000, 6_000), 0);
  assert.equal(resolveCommandTimelineIdleDelay(2_000, 1_000), COMMAND_TIMELINE_IDLE_TIMEOUT_MS);
});

test('timeline entry requires command history and stays visible while either activity or a menu is active', () => {
  assert.equal(shouldShowCommandTimelineEntry(false, true, true), false);
  assert.equal(shouldShowCommandTimelineEntry(true, false, false), false);
  assert.equal(shouldShowCommandTimelineEntry(true, true, false), true);
  assert.equal(shouldShowCommandTimelineEntry(true, false, true), true);
});

test('timeline pointer target stays active while idle and disables only with unavailable history', () => {
  assert.equal(shouldAllowCommandTimelineEntryPointerEvents(true), true);
  assert.equal(shouldAllowCommandTimelineEntryPointerEvents(false), false);
});

test('timeline pointer leave does not dismiss an open row action menu', () => {
  assert.equal(shouldDismissCommandTimelineForPointerLeave(false, false, true, false), false);
  assert.equal(shouldDismissCommandTimelineForPointerLeave(false, false, false, true), false);
  assert.equal(shouldDismissCommandTimelineForPointerLeave(true, false, false, false), false);
  assert.equal(shouldDismissCommandTimelineForPointerLeave(false, true, false, false), false);
  assert.equal(shouldDismissCommandTimelineForPointerLeave(false, false, false, false), true);
});
