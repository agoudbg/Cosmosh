import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalWindowActivity } from '@cosmosh/api-contract';

import { TerminalWindowActivityController, type TerminalWindowActivityTarget } from './terminal-window-activity';

type ProgressCall = {
  progress: number;
  mode?: string;
};

/**
 * Creates a controllable BrowserWindow test double.
 *
 * @returns Target, recorded OS calls, and mutable focus state.
 */
const createTarget = (): {
  target: TerminalWindowActivityTarget;
  progressCalls: ProgressCall[];
  flashCalls: boolean[];
  state: { destroyed: boolean; focused: boolean };
} => {
  const progressCalls: ProgressCall[] = [];
  const flashCalls: boolean[] = [];
  const state = { destroyed: false, focused: false };
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

  return { target, progressCalls, flashCalls, state };
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
  latestBellEvent: null,
  ...overrides,
});

test('taskbar progress maps all states and clears with Electron sentinel', () => {
  const { target, progressCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target);

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
  const { target, progressCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target);
  const activity = createActivity({ progressState: 'normal', progressValue: 30 });

  controller.apply(activity);
  controller.apply({ ...activity });

  assert.equal(progressCalls.length, 1);
});

test('Bell flashes once while unfocused and never follows progress clear', () => {
  const { target, flashCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target);
  const bellActivity = createActivity({
    progressState: 'normal',
    progressValue: 80,
    bellAttention: true,
    latestBellEvent: {
      tabId: 'tab-1',
      paneId: 'pane-1',
      sequence: 1,
      receivedAt: 1_000,
    },
  });

  controller.apply(bellActivity);
  controller.apply({ ...bellActivity });
  controller.apply(createActivity());

  assert.deepEqual(flashCalls, [true]);
});

test('older Bell exposed after a tab closes cannot replay attention', () => {
  const { target, flashCalls } = createTarget();
  const controller = new TerminalWindowActivityController(target);

  controller.apply(
    createActivity({
      latestBellEvent: {
        tabId: 'newer-tab',
        paneId: 'pane-1',
        sequence: 1,
        receivedAt: 2_000,
      },
    }),
  );
  controller.apply(
    createActivity({
      latestBellEvent: {
        tabId: 'older-tab',
        paneId: 'pane-2',
        sequence: 4,
        receivedAt: 1_000,
      },
    }),
  );

  assert.deepEqual(flashCalls, [true]);
});

test('focused Bell is consumed without delayed flash and focus stops an active flash', () => {
  const { target, flashCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target);
  state.focused = true;

  controller.apply(
    createActivity({
      latestBellEvent: {
        tabId: 'tab-1',
        paneId: 'pane-1',
        sequence: 1,
        receivedAt: 1_000,
      },
    }),
  );
  state.focused = false;
  controller.apply(createActivity());
  controller.acknowledgeWindowFocus();

  assert.deepEqual(flashCalls, [false]);
});

test('malformed payloads and destroyed windows are rejected without OS calls', () => {
  const { target, progressCalls, flashCalls, state } = createTarget();
  const controller = new TerminalWindowActivityController(target);

  const malformedPayloads: unknown[] = [
    {
      progressState: 'normal',
      progressValue: 101,
      bellAttention: false,
      latestBellEvent: null,
    },
    {
      progressState: 'indeterminate',
      progressValue: 50,
      bellAttention: false,
      latestBellEvent: null,
    },
    {
      progressState: 'none',
      progressValue: null,
      bellAttention: false,
    },
    {
      progressState: 'none',
      progressValue: null,
      bellAttention: true,
      latestBellEvent: {
        tabId: 'tab\u0007',
        paneId: 'pane-1',
        sequence: 1,
        receivedAt: 1_000,
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
