import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteShellCapability, RemoteShellEventMessage } from '@cosmosh/api-contract';
import type { IBufferLine, IDisposable, IMarker } from '@xterm/xterm';

import {
  applyRemoteCommandMarkerEvent,
  clearTerminalCommandMarkers,
  createTerminalCommandTimelineModel,
  recordPendingCommandMarker,
  scrollToTerminalCommandMarker,
} from './ssh-command-markers';
import type { TerminalPaneRuntime } from './ssh-types';

type BufferLineSpec = {
  text: string;
  isWrapped?: boolean;
};

type MarkerHarness = {
  marker: IMarker;
  wasDisposed: () => boolean;
};

/** Mutable xterm runtime facade used by command timeline tests. */
type RuntimeHarness = {
  runtime: TerminalPaneRuntime;
  markers: MarkerHarness[];
  scrollTargets: number[];
  getRefreshCount: () => number;
  setActiveBuffer: (type: 'normal' | 'alternate') => void;
  setBaseY: (line: number) => void;
  setCursorLine: (line: number) => void;
  setLine: (line: number, value: BufferLineSpec) => void;
  setViewportY: (line: number) => void;
};

/** Input geometry used to add one trusted command to a runtime harness. */
type TrustedCommandSpec = {
  id: string;
  inputLine: number;
  outputLine: number;
  command: string;
};

/**
 * Creates the minimal mutable xterm pane runtime required by marker utilities.
 *
 * @param initialLines Initial normal-buffer content.
 * @param terminalRows Visible terminal row count used for active-marker selection.
 * @returns Runtime plus controls for cursor, viewport, buffer, and marker state.
 */
const createRuntimeHarness = (initialLines: BufferLineSpec[] = [], terminalRows = 4): RuntimeHarness => {
  const lines = [...initialLines];
  const markers: MarkerHarness[] = [];
  const scrollTargets: number[] = [];
  let activeBufferType: 'normal' | 'alternate' = 'normal';
  let baseY = 0;
  let cursorLine = 0;
  let viewportY = 0;
  let refreshCount = 0;

  /**
   * Creates a lightweight immutable buffer-line facade.
   *
   * @param spec Rendered text and wrap state.
   * @returns Partial xterm line implementation used by command reconstruction.
   */
  const createBufferLine = (spec: BufferLineSpec): IBufferLine =>
    ({
      isWrapped: spec.isWrapped ?? false,
      length: spec.text.length,
      translateToString: () => spec.text,
    }) as unknown as IBufferLine;

  const normalBuffer = {
    type: 'normal' as const,
    get cursorY(): number {
      return cursorLine;
    },
    cursorX: 0,
    get viewportY(): number {
      return viewportY;
    },
    get baseY(): number {
      return baseY;
    },
    get length(): number {
      return lines.length;
    },
    getLine: (line: number) => {
      const spec = lines[line];
      return spec ? createBufferLine(spec) : undefined;
    },
  };
  const alternateBuffer = {
    ...normalBuffer,
    type: 'alternate' as const,
  };
  const terminal = {
    rows: terminalRows,
    buffer: {
      get active() {
        return activeBufferType === 'normal' ? normalBuffer : alternateBuffer;
      },
      normal: normalBuffer,
      alternate: alternateBuffer,
    },
    registerMarker: (cursorYOffset = 0) => {
      let disposed = false;
      let markerLine = cursorLine + cursorYOffset;
      const disposeListeners = new Set<() => void>();
      const marker: IMarker = {
        id: markers.length + 1,
        get isDisposed(): boolean {
          return disposed;
        },
        get line(): number {
          return markerLine;
        },
        dispose: () => {
          if (disposed) {
            return;
          }

          disposed = true;
          markerLine = -1;
          disposeListeners.forEach((listener) => listener());
        },
        onDispose: (listener: () => void): IDisposable => {
          disposeListeners.add(listener);
          return {
            dispose: () => {
              disposeListeners.delete(listener);
            },
          };
        },
      };
      markers.push({ marker, wasDisposed: () => disposed });
      return marker;
    },
    scrollToLine: (line: number) => {
      scrollTargets.push(line);
      viewportY = line;
    },
  };

  return {
    runtime: {
      owner: 'secondary',
      terminal,
      pendingCommandMarkers: [],
      commandMarkers: [],
      refreshCommandTimeline: () => {
        refreshCount += 1;
      },
    } as unknown as TerminalPaneRuntime,
    markers,
    scrollTargets,
    getRefreshCount: () => refreshCount,
    setActiveBuffer: (type) => {
      activeBufferType = type;
    },
    setBaseY: (line) => {
      baseY = line;
    },
    setCursorLine: (line) => {
      cursorLine = line;
    },
    setLine: (line, value) => {
      lines[line] = value;
    },
    setViewportY: (line) => {
      viewportY = line;
    },
  };
};

/** Shared trusted helper event fields used by marker tests. */
const REMOTE_EVENT_BASE = {
  type: 'remote-shell-event',
  shell: 'bash',
  helperVersion: 'test-v2',
  protocolVersion: 3,
  shellInstanceId: 'shell-1',
  capabilities: ['command-start', 'command-end', 'prompt-ready'] as RemoteShellCapability[],
  timestamp: 100,
} as const;

/**
 * Creates a trusted command-start event.
 *
 * @param commandId Stable helper command id.
 * @param command Sanitized executable name emitted by the helper.
 * @returns Typed command-start payload.
 */
const createCommandStart = (commandId: string, command: string): RemoteShellEventMessage => ({
  ...REMOTE_EVENT_BASE,
  event: 'command-start',
  command,
  commandId,
});

/**
 * Adds one locally entered command and promotes it with a trusted lifecycle event.
 *
 * @param harness Mutable runtime harness that owns the xterm markers.
 * @param spec Command text and input/output row geometry.
 * @returns Nothing.
 */
const recordTrustedCommand = (harness: RuntimeHarness, spec: TrustedCommandSpec): void => {
  harness.setLine(spec.inputLine, { text: `dev@host:~$ ${spec.command}` });
  harness.setLine(spec.outputLine, { text: '' });
  harness.setCursorLine(spec.inputLine);
  assert.equal(recordPendingCommandMarker(harness.runtime, spec.inputLine), true);
  harness.setCursorLine(spec.outputLine);
  assert.equal(
    applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart(spec.id, spec.command), spec.outputLine),
    true,
  );
};

test('trusted lifecycle promotes pending input and retains the complete compound command', () => {
  const harness = createRuntimeHarness([{ text: '(base) xyz10@DESKTOP:~$ sudo ss -tlnp | grep :22' }, { text: '' }]);
  harness.setCursorLine(0);
  assert.equal(recordPendingCommandMarker(harness.runtime, 1_000), true);

  harness.setCursorLine(1);
  const commandStart = createCommandStart('cmd-1', 'sudo');
  assert.equal(applyRemoteCommandMarkerEvent(harness.runtime, commandStart, 1_500), true);
  assert.equal(applyRemoteCommandMarkerEvent(harness.runtime, commandStart, 1_600), false);
  assert.equal(harness.runtime.pendingCommandMarkers.length, 0);
  assert.equal(harness.runtime.commandMarkers.length, 1);
  assert.equal(harness.runtime.commandMarkers[0]?.command, 'sudo ss -tlnp | grep :22');
  assert.equal(harness.runtime.commandMarkers[0]?.inputMarker.line, 0);
  assert.equal(harness.runtime.commandMarkers[0]?.outputStartMarker.line, 1);

  harness.setCursorLine(5);
  assert.equal(
    applyRemoteCommandMarkerEvent(
      harness.runtime,
      {
        ...REMOTE_EVENT_BASE,
        event: 'command-end',
        command: 'sudo',
        commandId: 'cmd-1',
        durationMs: 250,
        exitCode: 0,
      },
      1_750,
    ),
    true,
  );

  assert.equal(harness.runtime.commandMarkers[0]?.durationMs, 250);
  assert.equal(harness.runtime.commandMarkers[0]?.exitCode, 0);
});

test('wrapped input marker navigates to the first physical command row', () => {
  const harness = createRuntimeHarness([
    { text: "dev@host:~$ printf '%s' " },
    { text: 'very-long-value', isWrapped: true },
    { text: '' },
  ]);
  harness.setCursorLine(1);
  assert.equal(recordPendingCommandMarker(harness.runtime, 2_000), true);
  assert.equal(harness.runtime.pendingCommandMarkers[0]?.marker.line, 0);

  harness.setCursorLine(2);
  assert.equal(applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart('cmd-wrap', 'printf'), 2_100), true);
  assert.equal(harness.runtime.commandMarkers[0]?.command, "printf '%s' very-long-value");
  assert.equal(harness.runtime.commandMarkers[0]?.inputMarker.line, 0);
});

test('prompt-ready clears unmatched input and alternate-screen input is ignored', () => {
  const harness = createRuntimeHarness([{ text: 'dev@host:~$ ' }]);
  assert.equal(recordPendingCommandMarker(harness.runtime, 1), true);
  assert.equal(
    applyRemoteCommandMarkerEvent(
      harness.runtime,
      {
        ...REMOTE_EVENT_BASE,
        event: 'prompt-ready',
        cwd: '/home/dev',
        promptGeneration: 2,
      },
      2,
    ),
    true,
  );
  assert.equal(harness.runtime.pendingCommandMarkers.length, 0);
  assert.equal(harness.markers[0]?.wasDisposed(), true);

  harness.setActiveBuffer('alternate');
  assert.equal(recordPendingCommandMarker(harness.runtime, 3), false);
  assert.equal(harness.markers.length, 1);
});

test('timeline reserves its rail but exposes history only beyond two screens and three trusted commands', () => {
  const harness = createRuntimeHarness([], 4);
  const commands = [
    { id: 'cmd-1', inputLine: 0, outputLine: 1, command: 'one' },
    { id: 'cmd-2', inputLine: 2, outputLine: 3, command: 'two' },
    { id: 'cmd-3', inputLine: 4, outputLine: 5, command: 'three' },
    { id: 'cmd-4', inputLine: 6, outputLine: 7, command: 'four' },
  ];

  const unavailableModel = createTerminalCommandTimelineModel(harness.runtime, false);
  assert.equal(unavailableModel.railReserved, false);
  assert.equal(unavailableModel.historyVisible, false);

  commands.slice(0, 3).forEach((spec) => recordTrustedCommand(harness, spec));
  const threeCommandModel = createTerminalCommandTimelineModel(harness.runtime, true);
  assert.equal(threeCommandModel.railReserved, true);
  assert.equal(threeCommandModel.historyVisible, false);
  assert.equal(threeCommandModel.items.length, 3);
  assert.equal(threeCommandModel.activeCommandId, null);

  const fourthCommand = commands[3];
  assert.ok(fourthCommand);
  recordTrustedCommand(harness, fourthCommand);
  const exactTwoScreenModel = createTerminalCommandTimelineModel(harness.runtime, true);
  assert.equal(exactTwoScreenModel.historyVisible, false);
  assert.equal(exactTwoScreenModel.items.length, 4);

  harness.setLine(8, { text: 'content beyond two visible screens' });
  harness.setBaseY(5);
  harness.setViewportY(5);
  const bottomModel = createTerminalCommandTimelineModel(harness.runtime, true);
  assert.equal(bottomModel.historyVisible, true);
  assert.equal(bottomModel.items.length, 4);
  assert.equal(bottomModel.activeCommandId, 'cmd-4');

  harness.setViewportY(0);
  const scrolledModel = createTerminalCommandTimelineModel(harness.runtime, true);
  assert.equal(scrolledModel.activeCommandId, 'cmd-2');
});

test('timeline direct navigation resolves pane-local command ids', () => {
  const harness = createRuntimeHarness([], 4);
  const commands = [
    { id: 'cmd-1', inputLine: 2, outputLine: 3, command: 'one' },
    { id: 'cmd-2', inputLine: 8, outputLine: 9, command: 'two' },
    { id: 'cmd-3', inputLine: 15, outputLine: 16, command: 'three' },
  ];

  commands.forEach((spec) => recordTrustedCommand(harness, spec));

  assert.equal(scrollToTerminalCommandMarker(harness.runtime, 'missing'), false);
  assert.equal(scrollToTerminalCommandMarker(harness.runtime, 'cmd-1'), true);
  assert.equal(scrollToTerminalCommandMarker(harness.runtime, 'cmd-3'), true);
  assert.deepEqual(harness.scrollTargets, [2, 15]);
});

test('timeline reserves alternate-screen state and clears command text with scrollback disposal', () => {
  const harness = createRuntimeHarness([{ text: 'dev@host:~$ secret --token value' }, { text: '' }]);
  harness.setCursorLine(0);
  recordPendingCommandMarker(harness.runtime, 1);
  harness.setCursorLine(1);
  applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart('cmd-secret', 'secret'), 2);

  const retainedEntry = harness.runtime.commandMarkers[0];
  assert.ok(retainedEntry);
  harness.setActiveBuffer('alternate');
  const alternateModel = createTerminalCommandTimelineModel(harness.runtime, true);
  assert.equal(alternateModel.railReserved, true);
  assert.equal(alternateModel.historyVisible, false);
  assert.equal(alternateModel.alternateScreenActive, true);
  assert.equal(alternateModel.items.length, 1);

  retainedEntry.inputMarker.dispose();
  assert.equal(retainedEntry.command, '');
  assert.equal(retainedEntry.outputStartMarker.isDisposed, true);
  assert.equal(harness.runtime.commandMarkers.length, 0);
  assert.ok(harness.getRefreshCount() > 0);
});

test('connection cleanup disposes pending and confirmed markers and blanks retained command objects', () => {
  const harness = createRuntimeHarness([
    { text: 'dev@host:~$ visible-command' },
    { text: '' },
    { text: 'dev@host:~$ pending-command' },
  ]);
  harness.setCursorLine(0);
  recordPendingCommandMarker(harness.runtime, 1);
  harness.setCursorLine(1);
  applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart('cmd-visible', 'visible-command'), 2);
  const retainedEntry = harness.runtime.commandMarkers[0];
  assert.ok(retainedEntry);

  harness.setCursorLine(2);
  recordPendingCommandMarker(harness.runtime, 3);
  assert.equal(clearTerminalCommandMarkers(harness.runtime), true);
  assert.equal(retainedEntry.command, '');
  assert.equal(harness.runtime.pendingCommandMarkers.length, 0);
  assert.equal(harness.runtime.commandMarkers.length, 0);
  assert.equal(
    harness.markers.every((entry) => entry.wasDisposed()),
    true,
  );
  assert.equal(clearTerminalCommandMarkers(harness.runtime), false);
});

test('queued command-start synthesizes an anchor after its Enter marker was cleared', () => {
  const harness = createRuntimeHarness([
    { text: 'dev@host:~$ cmd1' },
    { text: 'out1' },
    { text: 'dev@host:~$ cmd2' },
    { text: '' },
  ]);
  harness.setCursorLine(0);
  assert.equal(recordPendingCommandMarker(harness.runtime, 1_000), true);
  harness.setCursorLine(1);
  assert.equal(applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart('cmd-1', 'cmd1'), 1_500), true);

  // prompt-ready after cmd1 leaves nothing pending for the queued cmd2.
  applyRemoteCommandMarkerEvent(harness.runtime, { ...REMOTE_EVENT_BASE, event: 'prompt-ready' }, 1_600);
  assert.equal(harness.runtime.pendingCommandMarkers.length, 0);

  // cmd2's command-start arrives with its echoed input right above the cursor.
  harness.setCursorLine(3);
  assert.equal(applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart('cmd-2', 'cmd2'), 2_000), true);
  assert.equal(harness.runtime.commandMarkers.length, 2);
  assert.equal(harness.runtime.commandMarkers[1]?.command, 'cmd2');
  assert.equal(harness.runtime.commandMarkers[1]?.inputMarker.line, 2);
  assert.equal(harness.runtime.pendingCommandMarkers.length, 0);
});

test('synthesized anchor walks wrapped echoed input to its first physical row', () => {
  const harness = createRuntimeHarness([
    { text: 'dev@host:~$ echo aaaa' },
    { text: 'aaaa-continued', isWrapped: true },
    { text: '' },
  ]);
  harness.setCursorLine(2);
  assert.equal(applyRemoteCommandMarkerEvent(harness.runtime, createCommandStart('cmd-9', 'echo'), 3_000), true);
  assert.equal(harness.runtime.commandMarkers.length, 1);
  assert.equal(harness.runtime.commandMarkers[0]?.command, 'echo aaaaaaaa-continued');
  assert.equal(harness.runtime.commandMarkers[0]?.inputMarker.line, 0);
});
