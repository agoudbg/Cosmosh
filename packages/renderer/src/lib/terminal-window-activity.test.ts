import assert from 'node:assert/strict';
import test from 'node:test';

import type { TabItem, TerminalTabPresentation } from '../types/tabs';
import { TERMINAL_BELL_RENDERER_EPOCH } from './terminal-bell-identity';
import { aggregateTerminalWindowActivity } from './terminal-window-activity';

const BELL_EFFECT_POLICY = {
  rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  bellAudibleEnabled: true,
  bellFlashEnabled: true,
} as const;

/**
 * Creates a terminal tab with a complete presentation projection.
 *
 * @param id Stable tab id.
 * @param presentation Targeted presentation overrides.
 * @returns Terminal tab test fixture.
 */
const createTerminalTab = (id: string, presentation: Partial<TerminalTabPresentation>): TabItem => ({
  id,
  title: id,
  page: 'ssh',
  iconKey: 'ssh',
  terminalPresentation: {
    applicationTitle: null,
    progressState: 'none',
    progressValue: null,
    progressSource: null,
    bellAttention: false,
    bellAttentionPaneIds: [],
    latestBellEvent: null,
    ...presentation,
  },
});

test('window aggregation applies error, warning, indeterminate, normal, and none severity', () => {
  const tabs = [
    createTerminalTab('normal', { progressState: 'normal', progressValue: 70 }),
    createTerminalTab('indeterminate', { progressState: 'indeterminate' }),
    createTerminalTab('warning', { progressState: 'warning', progressValue: 45 }),
    createTerminalTab('error', { progressState: 'error', progressValue: 20 }),
  ];

  assert.deepEqual(aggregateTerminalWindowActivity({ tabs, activeTabId: 'normal', ...BELL_EFFECT_POLICY }), {
    progressState: 'error',
    progressValue: 20,
    bellAttention: false,
    bellAudibleEnabled: true,
    bellFlashEnabled: true,
    latestBellEvent: null,
  });
  assert.equal(
    aggregateTerminalWindowActivity({
      tabs: tabs.slice(0, 3),
      activeTabId: 'normal',
      ...BELL_EFFECT_POLICY,
    }).progressState,
    'warning',
  );
  assert.equal(
    aggregateTerminalWindowActivity({
      tabs: tabs.slice(0, 2),
      activeTabId: 'normal',
      ...BELL_EFFECT_POLICY,
    }).progressState,
    'indeterminate',
  );
  assert.equal(
    aggregateTerminalWindowActivity({
      tabs: tabs.slice(0, 1),
      activeTabId: 'normal',
      ...BELL_EFFECT_POLICY,
    }).progressState,
    'normal',
  );
  assert.equal(
    aggregateTerminalWindowActivity({ tabs: [], activeTabId: 'none', ...BELL_EFFECT_POLICY }).progressState,
    'none',
  );
});

test('active tab wins among equal-severity progress candidates', () => {
  const tabs = [
    createTerminalTab('background', { progressState: 'normal', progressValue: 90 }),
    createTerminalTab('active', { progressState: 'normal', progressValue: 25 }),
  ];

  const aggregated = aggregateTerminalWindowActivity({ tabs, activeTabId: 'active', ...BELL_EFFECT_POLICY });

  assert.equal(aggregated.progressState, 'normal');
  assert.equal(aggregated.progressValue, 25);
});

test('Bell attention and latest event aggregate independently from progress', () => {
  const tabs = [
    createTerminalTab('tab-1', {
      progressState: 'normal',
      progressValue: 100,
      latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-1', sequence: 1 },
    }),
    createTerminalTab('tab-2', {
      bellAttention: true,
      bellAttentionPaneIds: ['pane-2'],
      latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-2', sequence: 2 },
    }),
  ];

  assert.deepEqual(aggregateTerminalWindowActivity({ tabs, activeTabId: 'tab-1', ...BELL_EFFECT_POLICY }), {
    progressState: 'normal',
    progressValue: 100,
    bellAttention: true,
    bellAudibleEnabled: true,
    bellFlashEnabled: true,
    latestBellEvent: {
      tabId: 'tab-2',
      rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
      paneId: 'pane-2',
      sequence: 2,
    },
  });
});

test('window aggregation advances Bell edges by renderer sequence', () => {
  const aggregated = aggregateTerminalWindowActivity({
    tabs: [
      createTerminalTab('tab-1', {
        latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-1', sequence: 10 },
      }),
      createTerminalTab('tab-2', {
        latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-2', sequence: 11 },
      }),
    ],
    activeTabId: 'tab-1',
    ...BELL_EFFECT_POLICY,
  });

  assert.deepEqual(aggregated.latestBellEvent, {
    tabId: 'tab-2',
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    paneId: 'pane-2',
    sequence: 11,
  });
});

test('window aggregation ignores Bell events retained by a stale renderer epoch', () => {
  const aggregated = aggregateTerminalWindowActivity({
    tabs: [
      createTerminalTab('stale-tab', {
        latestBellEvent: { rendererEpoch: 'stale-renderer-epoch', paneId: 'pane-1', sequence: 100 },
      }),
      createTerminalTab('current-tab', {
        latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-2', sequence: 1 },
      }),
    ],
    activeTabId: 'stale-tab',
    ...BELL_EFFECT_POLICY,
  });

  assert.deepEqual(aggregated.latestBellEvent, {
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    tabId: 'current-tab',
    paneId: 'pane-2',
    sequence: 1,
  });
});

test('acknowledged Bell retains its latest event identity without attention', () => {
  const aggregated = aggregateTerminalWindowActivity({
    tabs: [
      createTerminalTab('tab-1', {
        bellAttention: false,
        latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-1', sequence: 2 },
      }),
    ],
    activeTabId: 'tab-1',
    ...BELL_EFFECT_POLICY,
  });

  assert.equal(aggregated.bellAttention, false);
  assert.deepEqual(aggregated.latestBellEvent, {
    tabId: 'tab-1',
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    paneId: 'pane-1',
    sequence: 2,
  });
});

test('window aggregation carries Bell effect policy independently from visual attention', () => {
  const aggregated = aggregateTerminalWindowActivity({
    tabs: [
      createTerminalTab('tab-1', {
        bellAttention: false,
        latestBellEvent: { rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH, paneId: 'pane-1', sequence: 3 },
      }),
    ],
    activeTabId: 'tab-1',
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    bellAudibleEnabled: true,
    bellFlashEnabled: false,
  });

  assert.equal(aggregated.bellAttention, false);
  assert.equal(aggregated.bellAudibleEnabled, true);
  assert.equal(aggregated.bellFlashEnabled, false);
  assert.equal(aggregated.latestBellEvent?.sequence, 3);
});
