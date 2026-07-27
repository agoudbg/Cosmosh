import type { AgentTerminalAttachmentStatus } from '@cosmosh/api-contract';

import type { ServerInboundMessage, SshTelemetryState } from './ssh-types';
import { DEFAULT_TELEMETRY_STATE } from './ssh-types';

const REMOTE_ENHANCEMENTS_DEBUG_EVENT_MAX_COUNT = 200;
const COMMAND_TIMELINE_MAX_COUNT = 200;

/** Trusted shell line metadata that can calibrate renderer-side completion state. */
export type SshPaneLineState = {
  lineLength: number;
  cursorIndex: number;
  promptGeneration: number;
};

/** One structured command lifecycle retained for diagnostics and navigation. */
export type SshPaneCommandLifecycle = {
  commandId: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
};

/** Declarative state owned by one terminal pane. */
export type SshPaneState = {
  connectionState: 'connecting' | 'connected' | 'failed';
  connectionError: string;
  telemetryState: SshTelemetryState;
  remoteBootstrapStatus: Extract<ServerInboundMessage, { type: 'bootstrap-status' }> | null;
  remoteEnhancementRuntimeStatus: Extract<ServerInboundMessage, { type: 'remote-enhancement-runtime-status' }> | null;
  remoteEnhancementsDebugEvents: Array<{
    receivedAt: number;
    payload: Extract<
      ServerInboundMessage,
      { type: 'bootstrap-status' | 'remote-enhancement-runtime-status' | 'remote-shell-event' }
    >;
  }>;
  trustedCwd: string | null;
  promptGeneration: number | null;
  lineState: SshPaneLineState | null;
  atPrompt: boolean;
  agentAttachmentStatus: AgentTerminalAttachmentStatus | null;
  commandTimeline: SshPaneCommandLifecycle[];
};

/** Pane-indexed declarative SSH runtime state. */
export type SshPaneStateMap = Record<string, SshPaneState>;

/** Actions accepted by the pane-state reducer. */
export type SshPaneStateAction =
  | { type: 'ensure-pane'; paneId: string }
  | { type: 'reset-pane'; paneId: string }
  | { type: 'remove-pane'; paneId: string }
  | {
      type: 'transport-state';
      paneId: string;
      connectionState: SshPaneState['connectionState'];
      connectionError?: string;
    }
  | { type: 'client-input'; paneId: string; data: string }
  | { type: 'server-message'; paneId: string; payload: ServerInboundMessage; receivedAt: number };

/**
 * Creates isolated baseline state for one terminal pane.
 *
 * @returns Fresh pane state with no shared mutable collections.
 */
export const createSshPaneState = (): SshPaneState => ({
  connectionState: 'connecting',
  connectionError: '',
  telemetryState: {
    ...DEFAULT_TELEMETRY_STATE,
    recentCommands: [],
  },
  remoteBootstrapStatus: null,
  remoteEnhancementRuntimeStatus: null,
  remoteEnhancementsDebugEvents: [],
  trustedCwd: null,
  promptGeneration: null,
  lineState: null,
  atPrompt: false,
  agentAttachmentStatus: null,
  commandTimeline: [],
});

/**
 * Reduces pane-scoped transport and server events without terminal side effects.
 *
 * @param state Current pane-indexed state.
 * @param action Pane lifecycle or inbound-message action.
 * @returns Next immutable pane-indexed state.
 */
export const reduceSshPaneState = (state: SshPaneStateMap, action: SshPaneStateAction): SshPaneStateMap => {
  if (action.type === 'remove-pane') {
    if (!state[action.paneId]) {
      return state;
    }

    const nextState = { ...state };
    delete nextState[action.paneId];
    return nextState;
  }

  if (action.type === 'reset-pane') {
    return {
      ...state,
      [action.paneId]: createSshPaneState(),
    };
  }

  const previousPaneState = state[action.paneId];
  if (action.type === 'ensure-pane') {
    if (previousPaneState) {
      return state;
    }

    return {
      ...state,
      [action.paneId]: createSshPaneState(),
    };
  }

  const paneState = previousPaneState ?? createSshPaneState();
  if (action.type === 'transport-state') {
    return {
      ...state,
      [action.paneId]: {
        ...paneState,
        connectionState: action.connectionState,
        connectionError:
          action.connectionError ?? (action.connectionState === 'failed' ? paneState.connectionError : ''),
      },
    };
  }

  if (action.type === 'client-input') {
    const submitted = action.data.includes('\r') || action.data.includes('\n') || action.data.includes('\u0003');
    const hasInput = action.data.length > 0;
    const promptGeneration = paneState.promptGeneration;
    return {
      ...state,
      [action.paneId]: {
        ...paneState,
        atPrompt: submitted ? false : paneState.atPrompt,
        lineState:
          submitted || !hasInput || promptGeneration === null
            ? submitted
              ? null
              : paneState.lineState
            : {
                lineLength: Math.max(1, paneState.lineState?.lineLength ?? 0),
                cursorIndex: Math.max(1, paneState.lineState?.cursorIndex ?? 0),
                promptGeneration,
              },
      },
    };
  }

  return {
    ...state,
    [action.paneId]: reduceServerMessage(paneState, action.payload, action.receivedAt),
  };
};

/**
 * Applies one backend message to a single pane state.
 *
 * @param state Current state for the source pane.
 * @param payload Validated Backend-to-Renderer terminal message.
 * @param receivedAt Local receipt timestamp used for bounded diagnostics.
 * @returns Updated pane state.
 */
const reduceServerMessage = (state: SshPaneState, payload: ServerInboundMessage, receivedAt: number): SshPaneState => {
  if (payload.type === 'ready') {
    return {
      ...state,
      connectionState: 'connected',
      connectionError: '',
    };
  }

  if (payload.type === 'error') {
    return {
      ...state,
      connectionState: 'failed',
      connectionError: payload.message,
    };
  }

  if (payload.type === 'exit') {
    return {
      ...state,
      connectionState: 'failed',
      connectionError: payload.reason,
    };
  }

  if (payload.type === 'telemetry') {
    return {
      ...state,
      telemetryState: {
        cpuUsagePercent: payload.cpuUsagePercent,
        memoryUsedBytes: payload.memoryUsedBytes,
        memoryTotalBytes: payload.memoryTotalBytes,
        networkRxBytesPerSec: payload.networkRxBytesPerSec,
        networkTxBytesPerSec: payload.networkTxBytesPerSec,
        recentCommands: payload.recentCommands,
      },
    };
  }

  if (payload.type === 'history') {
    return {
      ...state,
      telemetryState: {
        ...state.telemetryState,
        recentCommands: payload.recentCommands,
      },
    };
  }

  if (payload.type === 'bootstrap-status') {
    return {
      ...state,
      remoteBootstrapStatus: payload,
      remoteEnhancementsDebugEvents: appendDebugEvent(state, payload, receivedAt),
    };
  }

  if (payload.type === 'remote-enhancement-runtime-status') {
    return {
      ...state,
      remoteEnhancementRuntimeStatus: payload,
      remoteEnhancementsDebugEvents: appendDebugEvent(state, payload, receivedAt),
      ...(payload.state === 'active'
        ? {}
        : {
            trustedCwd: null,
            promptGeneration: null,
            lineState: null,
            atPrompt: false,
          }),
    };
  }

  if (payload.type === 'agent-attachment-status') {
    return {
      ...state,
      agentAttachmentStatus: payload,
    };
  }

  if (payload.type !== 'remote-shell-event') {
    return state;
  }

  const nextState: SshPaneState = {
    ...state,
    remoteEnhancementsDebugEvents: appendDebugEvent(state, payload, receivedAt),
  };

  if (payload.event === 'cwd') {
    return {
      ...nextState,
      trustedCwd: payload.cwd,
    };
  }

  if (payload.event === 'prompt-ready') {
    return {
      ...nextState,
      promptGeneration: payload.promptGeneration ?? nextState.promptGeneration,
      lineState: null,
      atPrompt: true,
    };
  }

  if (payload.event === 'line-state') {
    if (nextState.promptGeneration !== null && payload.promptGeneration !== nextState.promptGeneration) {
      return nextState;
    }

    return {
      ...nextState,
      promptGeneration: payload.promptGeneration,
      lineState: {
        lineLength: payload.lineLength,
        cursorIndex: payload.cursorIndex,
        promptGeneration: payload.promptGeneration,
      },
      atPrompt: true,
    };
  }

  if (payload.event === 'command-start') {
    return {
      ...nextState,
      lineState: null,
      atPrompt: false,
      commandTimeline: appendCommandStart(nextState.commandTimeline, payload, receivedAt),
    };
  }

  if (payload.event === 'command-end') {
    return {
      ...nextState,
      commandTimeline: applyCommandEnd(nextState.commandTimeline, payload, receivedAt),
    };
  }

  if (payload.event === 'foreground-command') {
    return {
      ...nextState,
      atPrompt: false,
    };
  }

  return nextState;
};

/**
 * Appends a bounded diagnostic event to one pane.
 *
 * @param state Current pane state.
 * @param payload Debuggable remote enhancement payload.
 * @param receivedAt Local receipt timestamp.
 * @returns Bounded debug event collection.
 */
const appendDebugEvent = (
  state: SshPaneState,
  payload: SshPaneState['remoteEnhancementsDebugEvents'][number]['payload'],
  receivedAt: number,
): SshPaneState['remoteEnhancementsDebugEvents'] => [
  ...state.remoteEnhancementsDebugEvents.slice(-(REMOTE_ENHANCEMENTS_DEBUG_EVENT_MAX_COUNT - 1)),
  { receivedAt, payload },
];

/**
 * Adds a command start once while bounding the retained timeline.
 *
 * @param timeline Existing command lifecycle collection.
 * @param payload Structured command-start event.
 * @param receivedAt Local receipt timestamp.
 * @returns Updated bounded command timeline.
 */
const appendCommandStart = (
  timeline: SshPaneCommandLifecycle[],
  payload: Extract<ServerInboundMessage, { type: 'remote-shell-event'; event: 'command-start' }>,
  receivedAt: number,
): SshPaneCommandLifecycle[] => {
  const existingIndex = timeline.findIndex((entry) => entry.commandId === payload.commandId);
  if (existingIndex >= 0) {
    return timeline;
  }

  return [
    ...timeline.slice(-(COMMAND_TIMELINE_MAX_COUNT - 1)),
    {
      commandId: payload.commandId,
      command: payload.command,
      startedAt: receivedAt,
      endedAt: null,
      durationMs: null,
      exitCode: null,
    },
  ];
};

/**
 * Completes the matching command lifecycle, retaining an orphan end event when start was missed.
 *
 * @param timeline Existing command lifecycle collection.
 * @param payload Structured command-end event.
 * @param receivedAt Local receipt timestamp.
 * @returns Updated bounded command timeline.
 */
const applyCommandEnd = (
  timeline: SshPaneCommandLifecycle[],
  payload: Extract<ServerInboundMessage, { type: 'remote-shell-event'; event: 'command-end' }>,
  receivedAt: number,
): SshPaneCommandLifecycle[] => {
  const existingIndex = timeline.findIndex((entry) => entry.commandId === payload.commandId);
  if (existingIndex < 0) {
    return [
      ...timeline.slice(-(COMMAND_TIMELINE_MAX_COUNT - 1)),
      {
        commandId: payload.commandId,
        command: payload.command,
        startedAt: Math.max(0, receivedAt - payload.durationMs),
        endedAt: receivedAt,
        durationMs: payload.durationMs,
        exitCode: payload.exitCode,
      },
    ];
  }

  return timeline.map((entry, index) =>
    index === existingIndex
      ? {
          ...entry,
          command: payload.command,
          endedAt: receivedAt,
          durationMs: payload.durationMs,
          exitCode: payload.exitCode,
        }
      : entry,
  );
};
