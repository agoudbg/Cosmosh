import type { ShellContext, TerminalCredentialFillOffer, TerminalCredentialFillResult } from '@cosmosh/api-contract';

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
  shellContext: ShellContext | null;
  /** Keeps pre-submit snapshots unusable until Backend acknowledges this submission and returns to a prompt. */
  pendingSubmissionToken: string | null;
  connectionState: 'connecting' | 'connected' | 'failed';
  connectionError: string;
  credentialFillOffer: TerminalCredentialFillOffer | null;
  credentialFillRequestToken: string | null;
  credentialFillResult: { payload: TerminalCredentialFillResult; receivedAt: number } | null;
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
  commandTimeline: SshPaneCommandLifecycle[];
};

/** Pane-indexed declarative SSH runtime state. */
export type SshPaneStateMap = Record<string, SshPaneState>;

/** Actions accepted by the pane-state reducer. */
export type SshPaneStateAction =
  | { type: 'input-submitted'; paneId: string; token: string }
  | { type: 'credential-fill-requested'; paneId: string; token: string }
  | { type: 'ensure-pane'; paneId: string }
  | { type: 'reset-pane'; paneId: string }
  | { type: 'remove-pane'; paneId: string }
  | {
      type: 'transport-state';
      paneId: string;
      connectionState: SshPaneState['connectionState'];
      connectionError?: string;
    }
  | { type: 'server-message'; paneId: string; payload: ServerInboundMessage; receivedAt: number };

/**
 * Creates isolated baseline state for one terminal pane.
 *
 * @returns Fresh pane state with no shared mutable collections.
 */
export const createSshPaneState = (): SshPaneState => ({
  shellContext: null,
  pendingSubmissionToken: null,
  connectionState: 'connecting',
  connectionError: '',
  credentialFillOffer: null,
  credentialFillRequestToken: null,
  credentialFillResult: null,
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
  if (action.type === 'input-submitted') {
    const pane = state[action.paneId];
    if (!pane?.shellContext) return state;
    return {
      ...state,
      [action.paneId]: {
        ...pane,
        trustedCwd: null,
        lineState: null,
        pendingSubmissionToken: action.token,
        shellContext: { ...pane.shellContext, status: 'paused', reason: 'input-submitted', cwd: null },
      },
    };
  }
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
  if (action.type === 'credential-fill-requested') {
    if (
      paneState.connectionState !== 'connected' ||
      paneState.credentialFillOffer?.token !== action.token ||
      paneState.credentialFillRequestToken
    )
      return state;
    return {
      ...state,
      [action.paneId]: { ...paneState, credentialFillRequestToken: action.token, credentialFillResult: null },
    };
  }
  if (action.type === 'transport-state') {
    return {
      ...state,
      [action.paneId]: {
        ...paneState,
        connectionState: action.connectionState,
        ...(action.connectionState === 'connected'
          ? {}
          : {
              shellContext: null,
              pendingSubmissionToken: null,
              trustedCwd: null,
              promptGeneration: null,
              lineState: null,
              credentialFillOffer: null,
              credentialFillRequestToken: null,
              credentialFillResult: null,
            }),
        connectionError:
          action.connectionError ?? (action.connectionState === 'failed' ? paneState.connectionError : ''),
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
  if (payload.type === 'shell-context') {
    const previous = state.shellContext;
    if (previous?.sessionId === payload.context.sessionId && previous.revision >= payload.context.revision)
      return state;
    const pendingToken = previous?.sessionId === payload.context.sessionId ? state.pendingSubmissionToken : null;
    const confirmed = pendingToken !== null && payload.context.submissionToken === pendingToken;
    const context =
      pendingToken && !confirmed && payload.context.status === 'ready'
        ? { ...payload.context, status: 'paused' as const, reason: 'input-submitted' as const, cwd: null }
        : payload.context;
    return {
      ...state,
      shellContext: context,
      pendingSubmissionToken: confirmed && context.status === 'ready' ? null : pendingToken,
      trustedCwd: context.status === 'ready' && context.permissions.cwd ? (context.cwd?.physical ?? null) : null,
      promptGeneration: payload.context.promptGeneration,
      lineState:
        context.status === 'ready' &&
        context.permissions.input &&
        previous?.promptGeneration === payload.context.promptGeneration
          ? state.lineState
          : null,
    };
  }
  if (payload.type === 'credential-fill-offer') {
    return {
      ...state,
      credentialFillOffer: payload.offer,
      ...(payload.offer && payload.offer.token !== state.credentialFillOffer?.token
        ? { credentialFillRequestToken: null, credentialFillResult: null }
        : {}),
    };
  }
  if (payload.type === 'credential-fill-result') {
    if (payload.token !== state.credentialFillRequestToken) return state;
    return {
      ...state,
      credentialFillOffer: null,
      credentialFillRequestToken: null,
      credentialFillResult: { payload, receivedAt },
    };
  }
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
      shellContext: null,
      pendingSubmissionToken: null,
      trustedCwd: null,
      promptGeneration: null,
      lineState: null,
      connectionState: 'failed',
      connectionError: payload.message,
      credentialFillOffer: null,
      credentialFillRequestToken: null,
      credentialFillResult: null,
    };
  }

  if (payload.type === 'exit') {
    return {
      ...state,
      shellContext: null,
      pendingSubmissionToken: null,
      trustedCwd: null,
      promptGeneration: null,
      lineState: null,
      connectionState: 'failed',
      connectionError: payload.reason,
      credentialFillOffer: null,
      credentialFillRequestToken: null,
      credentialFillResult: null,
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
          }),
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
    return nextState;
  }

  if (payload.event === 'prompt-ready') {
    if (state.shellContext) return nextState;
    return {
      ...nextState,
      promptGeneration: payload.promptGeneration ?? nextState.promptGeneration,
      lineState: null,
    };
  }

  if (payload.event === 'line-state') {
    if (
      state.shellContext &&
      (state.shellContext.status !== 'ready' ||
        !state.shellContext.permissions.input ||
        state.shellContext.shellInstanceId !== payload.shellInstanceId)
    )
      return nextState;
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
    };
  }

  if (payload.event === 'command-start') {
    return {
      ...nextState,
      lineState: null,
      commandTimeline: appendCommandStart(nextState.commandTimeline, payload, receivedAt),
    };
  }

  if (payload.event === 'command-end') {
    return {
      ...nextState,
      commandTimeline: applyCommandEnd(nextState.commandTimeline, payload, receivedAt),
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
