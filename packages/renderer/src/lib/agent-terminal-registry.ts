/**
 * Renderer-only registry of SSH panes eligible for Agent attachment.
 *
 * The registry deliberately stays outside MCP wire data. Internal tab, pane,
 * and SSH session identifiers are consumed only by Cosmosh approval and launch
 * workflows and are never returned to the Agent.
 */

import {
  AGENT_TERMINAL_REQUIRED_CAPABILITIES,
  type AgentTerminalAttachmentStatus,
  type RemoteEnhancementRuntimeStatus,
} from '@cosmosh/api-contract';
import React from 'react';

/** Stable reason shown when a pane cannot currently be selected. */
export type AgentTerminalDisabledReason =
  | 'connecting'
  | 'connection-failed'
  | 'automation-unavailable'
  | 'not-at-prompt'
  | 'pending-input'
  | 'already-attached';

/** Renderer-owned SSH pane snapshot available to approval and launch hosts. */
export type AgentTerminalSurface = {
  surfaceId: string;
  tabId: string;
  tabTitle: string;
  paneId: string;
  paneIndex: number;
  sessionId: string | null;
  serverId: string;
  serverName: string;
  isActiveTab: boolean;
  isActivePane: boolean;
  connectionState: 'connecting' | 'connected' | 'failed';
  runtimeStatus: RemoteEnhancementRuntimeStatus | null;
  atPrompt: boolean;
  lineLength: number;
  attachmentStatus: AgentTerminalAttachmentStatus | null;
  disabledReason: AgentTerminalDisabledReason | null;
};

let surfaces: readonly AgentTerminalSurface[] = [];
const listeners = new Set<() => void>();

/**
 * Notifies every registry subscriber after one tab publishes a new snapshot.
 */
const emitChange = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

/**
 * Returns the immutable current surface list.
 *
 * @returns Current renderer SSH pane snapshots.
 */
const getSnapshot = (): readonly AgentTerminalSurface[] => surfaces;

/**
 * Subscribes to registry changes.
 *
 * @param listener React external-store listener.
 * @returns Unsubscribe callback.
 */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
};

/**
 * Replaces all pane snapshots published by one SSH tab.
 *
 * @param tabId Owning tab id.
 * @param nextSurfaces Complete current pane snapshots for that tab.
 */
export const setAgentTerminalSurfacesForTab = (tabId: string, nextSurfaces: readonly AgentTerminalSurface[]): void => {
  const retained = surfaces.filter((surface) => surface.tabId !== tabId);
  const next = [...retained, ...nextSurfaces].sort(compareSurfaces);
  if (areAgentTerminalSurfaceListsEqual(surfaces, next)) {
    return;
  }

  surfaces = next;
  emitChange();
};

/**
 * Removes every pane snapshot owned by an unmounted SSH tab.
 *
 * @param tabId Unmounted tab id.
 */
export const removeAgentTerminalSurfacesForTab = (tabId: string): void => {
  const next = surfaces.filter((surface) => surface.tabId !== tabId);
  if (next.length === surfaces.length) {
    return;
  }

  surfaces = next;
  emitChange();
};

/**
 * Subscribes a component to the complete terminal surface registry.
 *
 * @returns Current immutable surface list.
 */
export const useAgentTerminalSurfaces = (): readonly AgentTerminalSurface[] => {
  return React.useSyncExternalStore(subscribe, getSnapshot);
};

/**
 * Chooses the pane initially highlighted by the attachment approval dialog.
 *
 * The current pane remains the default even when temporarily disabled so the
 * user sees why it cannot be approved. Otherwise the first eligible pane wins.
 *
 * @param candidates Renderer-owned SSH pane snapshots.
 * @returns Default surface, or null when no SSH panes exist.
 */
export const resolveDefaultAgentTerminalSurface = (
  candidates: readonly AgentTerminalSurface[],
): AgentTerminalSurface | null => {
  return (
    candidates.find((surface) => surface.isActiveTab && surface.isActivePane) ??
    candidates.find((surface) => surface.disabledReason === null) ??
    candidates[0] ??
    null
  );
};

/**
 * Resolves the selection disable reason from trusted pane state.
 *
 * @param input Pane connection, helper, prompt, line, and attachment state.
 * @returns Stable disable reason, or null when eligible.
 */
export const resolveAgentTerminalDisabledReason = (input: {
  connectionState: AgentTerminalSurface['connectionState'];
  runtimeStatus: RemoteEnhancementRuntimeStatus | null;
  atPrompt: boolean;
  lineLength: number;
  attachmentStatus: AgentTerminalAttachmentStatus | null;
}): AgentTerminalDisabledReason | null => {
  if (input.connectionState === 'connecting') {
    return 'connecting';
  }
  if (input.connectionState === 'failed') {
    return 'connection-failed';
  }
  const capabilities = input.runtimeStatus?.capabilities;
  const supportsAutomation =
    input.runtimeStatus?.state === 'active' &&
    capabilities !== undefined &&
    AGENT_TERMINAL_REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability));
  if (!supportsAutomation) {
    return 'automation-unavailable';
  }
  if (input.attachmentStatus?.state === 'idle' || input.attachmentStatus?.state === 'running') {
    return 'already-attached';
  }
  if (!input.atPrompt) {
    return 'not-at-prompt';
  }
  if (input.lineLength > 0) {
    return 'pending-input';
  }
  return null;
};

/**
 * Orders surfaces by tab title and stable pane position.
 *
 * @param left First surface.
 * @param right Second surface.
 * @returns Sort order.
 */
const compareSurfaces = (left: AgentTerminalSurface, right: AgentTerminalSurface): number => {
  if (left.isActiveTab !== right.isActiveTab) {
    return left.isActiveTab ? -1 : 1;
  }
  const titleOrder = left.tabTitle.localeCompare(right.tabTitle);
  return titleOrder !== 0 ? titleOrder : left.paneIndex - right.paneIndex;
};

/**
 * Avoids external-store notifications when all published fields are unchanged.
 *
 * @param left Previous surface list.
 * @param right Candidate surface list.
 * @returns True when every surface field is referentially unchanged.
 */
export const areAgentTerminalSurfaceListsEqual = (
  left: readonly AgentTerminalSurface[],
  right: readonly AgentTerminalSurface[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((surface, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      surface.surfaceId === candidate.surfaceId &&
      surface.tabId === candidate.tabId &&
      surface.tabTitle === candidate.tabTitle &&
      surface.paneId === candidate.paneId &&
      surface.paneIndex === candidate.paneIndex &&
      surface.sessionId === candidate.sessionId &&
      surface.serverId === candidate.serverId &&
      surface.serverName === candidate.serverName &&
      surface.isActiveTab === candidate.isActiveTab &&
      surface.isActivePane === candidate.isActivePane &&
      surface.connectionState === candidate.connectionState &&
      surface.runtimeStatus === candidate.runtimeStatus &&
      surface.atPrompt === candidate.atPrompt &&
      surface.lineLength === candidate.lineLength &&
      surface.attachmentStatus === candidate.attachmentStatus &&
      surface.disabledReason === candidate.disabledReason
    );
  });
};
