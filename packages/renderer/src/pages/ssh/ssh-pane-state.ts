import type { ServerInboundMessage, SshTelemetryState } from './ssh-types';
import { DEFAULT_TELEMETRY_STATE } from './ssh-types';

/** Declarative transport and telemetry state owned by one terminal pane. */
export type SshPaneState = {
  connectionState: 'connecting' | 'connected' | 'failed';
  connectionError: string;
  telemetryState: SshTelemetryState;
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
  | { type: 'server-message'; paneId: string; payload: ServerInboundMessage; receivedAt: number };

/**
 * Creates isolated baseline state for one terminal pane.
 *
 * @returns Fresh pane state with no shared mutable collections.
 */
export const createSshPaneState = (): SshPaneState => ({
  connectionState: 'connecting',
  connectionError: '',
  telemetryState: { ...DEFAULT_TELEMETRY_STATE },
});

/**
 * Reduces pane-scoped transport and telemetry events without terminal side effects.
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

  return {
    ...state,
    [action.paneId]: reduceServerMessage(paneState, action.payload),
  };
};

/**
 * Applies one backend transport or telemetry message to a single pane.
 *
 * @param state Current state for the source pane.
 * @param payload Validated Backend-to-Renderer terminal message.
 * @returns Updated pane state.
 */
const reduceServerMessage = (state: SshPaneState, payload: ServerInboundMessage): SshPaneState => {
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
      },
    };
  }

  return state;
};
