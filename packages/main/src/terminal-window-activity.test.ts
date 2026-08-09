import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalWindowActivity } from '@cosmosh/api-contract';

import {
  TerminalWindowActivityController,
  type TerminalWindowActivityEffects,
  type TerminalWindowActivityTarget,
} from './terminal-window-activity';

type ProgressCall = {
  progress: number;
  mode?: string;
};

const RENDERER_EPOCH = 'renderer-epoch-1';

/**
 * Creates a controllable BrowserWindow test double.
 *
 * @returns Target, recorded OS calls, and mutable focus state.
 */
const createTarget = (): {
  target: TerminalWindowActivityTarget;
  progressCalls: ProgressCall[];
  flashCalls: boolean[];
  beepCalls: number[];
  effects: TerminalWindowActivityEffects;
  state: { destroyed: boolean; focused: boolean; monotonicNow: number };
} => {
  const progressCalls: ProgressCall[] = [];
  const flashCalls: boolean[] = [];
  const beepCalls: number[] = [];
  const state = { destroyed: false, focused: false, monotonicNow: 0 };
  const target = {
    flashFrame: (flag: boolean): void => {
      flashCalls.push(flag);
    },
    isDestroyed: (): boolean => state.destroyed,
    isFocused: (): boolean => state.focused,
    setProgressBar: (progress: number, options?: { mode?: string }): void => {
      progressCalls.push({ progress, ...(options?.mode ? { mode: options.mode } : {}) });
    },
  } as TerminalWindowActivityTarget;
  const effects: TerminalWindowActivityEffects = {
    beep: (): void => {
      beepCalls.push(beepCalls.length + 1);
    },
    monotonicNow: (): number => state.monotonicNow,
  };

  return { target, progressCalls, flashCalls, beepCalls, effects, state };
};

/**
 * Creates a valid activity snapshot with targeted overrides.
 *
 * @param overrides Scenario-specific fields.
 * @returns Complete window activity snapshot.
 */
const createActivity = (overrides: Partial<TerminalWindowActivity> = {}): TerminalWindowActivity => ({
  progressState: 'none',
  progressValue: null,
  bellAttention: false,
  bellAudibleEnabled: true,
  bellFlashEnabled: true,
  latestBellEvent: null,
  ...overrides,
});

test('taskbar progress maps all states and clears with Electron sentinel', () => {
  const { target, effects, progressCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  controller.apply(createActivity());
  controller.apply(createActivity({ progressState: 'normal', progressValue: 25 }));
  controller.apply(createActivity({ progressState: 'warning', progressValue: 50 }));
  controller.apply(createActivity({ progressState: 'error', progressValue: 75 }));
  controller.apply(createActivity({ progressState: 'indeterminate' }));
  controller.apply(createActivity());

  assert.deepEqual(progressCalls, [
    { progress: -1 },
    { progress: 0.25, mode: 'normal' },
    { progress: 0.5, mode: 'paused' },
    { progress: 0.75, mode: 'error' },
    { progress: 2, mode: 'indeterminate' },
    { progress: -1 },
  ]);
});

test('unchanged progress snapshots do not repeat operating-system calls', () => {
  const { target, effects, progressCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);
  const activity = createActivity({ progressState: 'normal', progressValue: 30 });

  controller.apply(activity);
  controller.apply({ ...activity });

  assert.equal(progressCalls.length, 1);
});

test('Bell flashes once while unfocused and never follows progress clear', () => {
  const { target, effects, flashCalls, beepCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);
  const bellActivity = createActivity({
    progressState: 'normal',
    progressValue: 80,
    bellAttention: true,
    latestBellEvent: {
      rendererEpoch: RENDERER_EPOCH,
      tabId: 'tab-1',
      paneId: 'pane-1',
      sequence: 1,
    },
  });

  controller.apply(bellActivity);
  controller.apply({ ...bellActivity });
  controller.apply(createActivity());

  assert.deepEqual(flashCalls, [true]);
  assert.deepEqual(beepCalls, [1]);
});

test('older Bell exposed after a tab closes cannot replay attention', () => {
  const { target, effects, flashCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  controller.apply(
    createActivity({
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'newer-tab',
        paneId: 'pane-1',
        sequence: 4,
      },
    }),
  );
  controller.apply(
    createActivity({
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'older-tab',
        paneId: 'pane-2',
        sequence: 1,
      },
    }),
  );

  assert.deepEqual(flashCalls, [true]);
});

test('focused Bell is consumed without delayed flash and focus stops an active flash', () => {
  const { target, effects, flashCalls, beepCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);
  state.focused = true;

  controller.apply(
    createActivity({
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence: 1,
      },
    }),
  );
  state.focused = false;
  controller.apply(createActivity());
  controller.acknowledgeWindowFocus();

  assert.deepEqual(flashCalls, [false]);
  assert.deepEqual(beepCalls, [1]);
});

test('malformed payloads and destroyed windows are rejected without OS calls', () => {
  const { target, effects, progressCalls, flashCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  const malformedPayloads: unknown[] = [
    {
      progressState: 'normal',
      progressValue: 101,
      bellAttention: false,
      bellAudibleEnabled: true,
      bellFlashEnabled: true,
      latestBellEvent: null,
    },
    {
      progressState: 'indeterminate',
      progressValue: 50,
      bellAttention: false,
      bellAudibleEnabled: true,
      bellFlashEnabled: true,
      latestBellEvent: null,
    },
    {
      progressState: 'none',
      progressValue: null,
      bellAttention: false,
      bellAudibleEnabled: true,
      bellFlashEnabled: true,
    },
    {
      progressState: 'none',
      progressValue: null,
      bellAttention: true,
      bellAudibleEnabled: true,
      bellFlashEnabled: true,
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'tab\u0007',
        paneId: 'pane-1',
        sequence: 1,
      },
    },
    {
      progressState: 'none',
      progressValue: null,
      bellAttention: true,
      bellAudibleEnabled: true,
      bellFlashEnabled: true,
      latestBellEvent: {
        rendererEpoch: 'renderer\u0007epoch',
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence: 1,
      },
    },
  ];
  for (const payload of malformedPayloads) {
    assert.equal(controller.apply(payload), false);
  }

  state.destroyed = true;
  assert.equal(controller.apply(createActivity()), false);
  assert.deepEqual(progressCalls, []);
  assert.deepEqual(flashCalls, []);
});

test('Bell sound and Flash are throttled independently without losing event edges', () => {
  const { target, effects, flashCalls, beepCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  for (const [sequence, monotonicNow] of [
    [1, 0],
    [2, 500],
    [3, 1_000],
  ] as const) {
    state.monotonicNow = monotonicNow;
    controller.apply(
      createActivity({
        latestBellEvent: {
          rendererEpoch: RENDERER_EPOCH,
          tabId: 'tab-1',
          paneId: 'pane-1',
          sequence,
        },
      }),
    );
  }

  assert.deepEqual(beepCalls, [1, 2]);
  assert.deepEqual(flashCalls, [true, true]);
});

test('disabled Bell effects consume edges and cannot replay after policy changes', () => {
  const { target, effects, flashCalls, beepCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);
  const disabledBell = createActivity({
    bellAudibleEnabled: false,
    bellFlashEnabled: false,
    latestBellEvent: {
      rendererEpoch: RENDERER_EPOCH,
      tabId: 'tab-1',
      paneId: 'pane-1',
      sequence: 1,
    },
  });

  controller.apply(disabledBell);
  controller.apply({
    ...disabledBell,
    bellAudibleEnabled: true,
    bellFlashEnabled: true,
  });
  state.monotonicNow = 1_000;
  controller.apply(
    createActivity({
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence: 2,
      },
    }),
  );

  assert.deepEqual(beepCalls, [1]);
  assert.deepEqual(flashCalls, [true]);
});

test('renderer epoch change accepts a new sequence without replaying the previous epoch', () => {
  const { target, effects, flashCalls, beepCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  controller.apply(
    createActivity({
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence: 10,
      },
    }),
  );
  state.monotonicNow = 1_000;
  controller.apply(
    createActivity({
      latestBellEvent: {
        rendererEpoch: 'renderer-epoch-2',
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence: 1,
      },
    }),
  );

  assert.deepEqual(beepCalls, [1, 2]);
  assert.deepEqual(flashCalls, [true, true]);
});

test('renderer wall-clock rollback cannot suppress a newer Bell sequence', () => {
  const { target, effects, flashCalls, beepCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  for (const [sequence, rendererTimestamp, monotonicNow] of [
    [1, 2_000, 0],
    [2, 1_000, 1_000],
  ] as const) {
    state.monotonicNow = monotonicNow;
    controller.apply({
      ...createActivity(),
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence,
        receivedAt: rendererTimestamp,
      },
    });
  }

  assert.deepEqual(beepCalls, [1, 2]);
  assert.deepEqual(flashCalls, [true, true]);
});

test('renderer timestamps cannot bypass Main-process monotonic Bell throttling', () => {
  const { target, effects, flashCalls, beepCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target, effects);

  for (const [sequence, rendererTimestamp] of [
    [1, 1_000],
    [2, 2_000],
    [3, 3_000],
  ] as const) {
    state.monotonicNow = sequence * 100;
    controller.apply({
      ...createActivity(),
      latestBellEvent: {
        rendererEpoch: RENDERER_EPOCH,
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence,
        receivedAt: rendererTimestamp,
      },
    });
  }

  assert.deepEqual(beepCalls, [1]);
  assert.deepEqual(flashCalls, [true]);
});
