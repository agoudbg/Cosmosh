import assert from 'node:assert/strict';
import test from 'node:test';

import { TERMINAL_BELL_RENDERER_EPOCH } from '../../lib/terminal-bell-identity';
import {
  createTerminalPresentationState,
  type TerminalPresentationState,
  type TerminalPresentationStateMap,
} from './terminal-presentation-state';
import {
  aggregateTerminalTabPresentation,
  areTerminalTabPresentationsEqual,
  shouldAcknowledgeFocusedPaneBell,
} from './terminal-presentation-tab-state';

/**
 * Creates a pane state with targeted test overrides.
 *
 * @param overrides Presentation fields relevant to one scenario.
 * @returns Complete pane presentation state.
 */
const createPaneState = (overrides: Partial<TerminalPresentationState>): TerminalPresentationState => ({
  ...createTerminalPresentationState(),
  ...overrides,
});

test('tab aggregation follows the active pane title and progress', () => {
  const paneStates: TerminalPresentationStateMap = {
    'pane-1': createPaneState({
      applicationTitle: 'Claude Code',
      progressState: 'indeterminate',
    }),
    'pane-2': createPaneState({
      applicationTitle: 'Kimi Code',
      progressState: 'normal',
      progressValue: 42,
    }),
  };

  const first = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2'],
    paneStates,
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });
  const second = aggregateTerminalTabPresentation({
    activePaneId: 'pane-2',
    paneIds: ['pane-1', 'pane-2'],
    paneStates,
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.equal(first.applicationTitle, 'Claude Code');
  assert.equal(first.progressState, 'indeterminate');
  assert.equal(first.progressSource, 'active-pane');
  assert.equal(second.applicationTitle, 'Kimi Code');
  assert.equal(second.progressState, 'normal');
  assert.equal(second.progressValue, 42);
});

test('active pane progress takes priority over background errors', () => {
  const aggregated = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2'],
    paneStates: {
      'pane-1': createPaneState({ progressState: 'normal', progressValue: 25 }),
      'pane-2': createPaneState({ progressState: 'error', progressValue: 80 }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.equal(aggregated.progressState, 'normal');
  assert.equal(aggregated.progressValue, 25);
  assert.equal(aggregated.progressSource, 'active-pane');
});

test('background error and warning states retain attention when active progress is absent', () => {
  const aggregated = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2', 'pane-3'],
    paneStates: {
      'pane-1': createPaneState({}),
      'pane-2': createPaneState({ progressState: 'warning', progressValue: 60 }),
      'pane-3': createPaneState({ progressState: 'error', progressValue: 35 }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.equal(aggregated.progressState, 'error');
  assert.equal(aggregated.progressValue, 35);
  assert.equal(aggregated.progressSource, 'background-attention');
});

test('ordinary background progress does not occupy an idle active pane status slot', () => {
  const aggregated = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2'],
    paneStates: {
      'pane-1': createPaneState({}),
      'pane-2': createPaneState({ progressState: 'indeterminate' }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.equal(aggregated.progressState, 'none');
  assert.equal(aggregated.progressSource, null);
});

test('Bell attention is retained independently across all live panes', () => {
  const aggregated = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2', 'removed-pane', 'pane-3'],
    paneStates: {
      'pane-1': createPaneState({
        bellAttention: true,
        bellRendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
        bellSequence: 1,
      }),
      'pane-2': createPaneState({ bellAttention: false }),
      'pane-3': createPaneState({
        bellAttention: true,
        bellRendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
        bellSequence: 2,
      }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.equal(aggregated.bellAttention, true);
  assert.deepEqual(aggregated.bellAttentionPaneIds, ['pane-1', 'pane-3']);
  assert.deepEqual(aggregated.latestBellEvent, {
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    paneId: 'pane-3',
    sequence: 2,
  });
});

test('latest Bell event survives acknowledgement and follows renderer sequence', () => {
  const aggregated = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2'],
    paneStates: {
      'pane-1': createPaneState({
        bellAttention: false,
        bellRendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
        bellSequence: 2,
      }),
      'pane-2': createPaneState({
        bellAttention: false,
        bellRendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
        bellSequence: 3,
      }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.equal(aggregated.bellAttention, false);
  assert.deepEqual(aggregated.latestBellEvent, {
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    paneId: 'pane-2',
    sequence: 3,
  });
});

test('tab aggregation discards Bell attention retained by a stale renderer epoch', () => {
  const aggregated = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1', 'pane-2'],
    paneStates: {
      'pane-1': createPaneState({
        bellAttention: true,
        bellRendererEpoch: 'stale-renderer-epoch',
        bellSequence: 100,
      }),
      'pane-2': createPaneState({
        bellAttention: true,
        bellRendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
        bellSequence: 1,
      }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });

  assert.deepEqual(aggregated.bellAttentionPaneIds, ['pane-2']);
  assert.deepEqual(aggregated.latestBellEvent, {
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
    paneId: 'pane-2',
    sequence: 1,
  });
});

test('presentation equality compares ordered Bell sources without relying on object identity', () => {
  const first = aggregateTerminalTabPresentation({
    activePaneId: 'pane-1',
    paneIds: ['pane-1'],
    paneStates: {
      'pane-1': createPaneState({ applicationTitle: 'Task', bellAttention: true }),
    },
    rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
  });
  const duplicate = {
    ...first,
    bellAttentionPaneIds: [...first.bellAttentionPaneIds],
  };

  assert.equal(areTerminalTabPresentationsEqual(first, duplicate), true);
  assert.equal(
    areTerminalTabPresentationsEqual(first, {
      ...duplicate,
      bellAttentionPaneIds: ['pane-2'],
    }),
    false,
  );
  assert.equal(
    areTerminalTabPresentationsEqual(first, {
      ...duplicate,
      latestBellEvent: {
        rendererEpoch: TERMINAL_BELL_RENDERER_EPOCH,
        paneId: 'pane-1',
        sequence: 1,
      },
    }),
    false,
  );
});

test('focused Bell acknowledgement requires the active tab, matching pane, and exposed document focus', () => {
  const baseline = {
    isTabActive: true,
    activePaneId: 'pane-1',
    eventPaneId: 'pane-1',
    paneContainsFocus: true,
    isDocumentFocusExposed: true,
  };

  assert.equal(shouldAcknowledgeFocusedPaneBell(baseline), true);
  assert.equal(shouldAcknowledgeFocusedPaneBell({ ...baseline, isTabActive: false }), false);
  assert.equal(shouldAcknowledgeFocusedPaneBell({ ...baseline, eventPaneId: 'pane-2' }), false);
  assert.equal(shouldAcknowledgeFocusedPaneBell({ ...baseline, paneContainsFocus: false }), false);
  assert.equal(shouldAcknowledgeFocusedPaneBell({ ...baseline, isDocumentFocusExposed: false }), false);
});
