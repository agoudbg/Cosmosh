import type { TerminalTabPresentation, TerminalTabProgressState } from '../../types/tabs';
import type { TerminalPresentationState, TerminalPresentationStateMap } from './terminal-presentation-state';

type AggregateTerminalTabPresentationParams = {
  activePaneId: string;
  paneIds: ReadonlyArray<string>;
  paneStates: TerminalPresentationStateMap;
};

type ShouldAcknowledgeFocusedPaneBellParams = {
  isTabActive: boolean;
  activePaneId: string;
  eventPaneId: string;
  paneContainsFocus: boolean;
};

/**
 * Determines whether a Bell receipt already belongs to the user's focused pane.
 *
 * @param params Tab visibility, pane identity, and current DOM focus relation.
 * @returns Whether the Bell edge should be retained only as metadata and immediately acknowledged.
 */
export const shouldAcknowledgeFocusedPaneBell = ({
  isTabActive,
  activePaneId,
  eventPaneId,
  paneContainsFocus,
}: ShouldAcknowledgeFocusedPaneBellParams): boolean => {
  return isTabActive && activePaneId === eventPaneId && paneContainsFocus;
};

/**
 * Aggregates pane-scoped presentation into one tab-scoped projection.
 *
 * Active-pane progress owns the status slot whenever present. When the active
 * pane has no progress, only background error/warning states remain eligible
 * because ordinary background work must not displace active-pane identity.
 * Bell attention is aggregated independently and remains until each source
 * pane is acknowledged.
 *
 * @param params Active pane, pane order, and pane presentation map.
 * @returns Memory-only presentation projection for the owning tab.
 */
export const aggregateTerminalTabPresentation = ({
  activePaneId,
  paneIds,
  paneStates,
}: AggregateTerminalTabPresentationParams): TerminalTabPresentation => {
  const activePaneState = paneStates[activePaneId];
  const selectedProgress =
    selectActivePaneProgress(activePaneState) ?? selectBackgroundAttentionProgress(activePaneId, paneIds, paneStates);
  const bellAttentionPaneIds = paneIds.filter((paneId) => paneStates[paneId]?.bellAttention);
  const latestBellEvent = selectLatestBellEvent(paneIds, paneStates);

  return {
    applicationTitle: activePaneState?.applicationTitle ?? null,
    progressState: selectedProgress?.progressState ?? 'none',
    progressValue: selectedProgress?.progressValue ?? null,
    progressSource: selectedProgress?.progressSource ?? null,
    bellAttention: bellAttentionPaneIds.length > 0,
    bellAttentionPaneIds,
    latestBellEvent,
  };
};

/**
 * Compares fixed terminal-tab presentation fields for React state de-duplication.
 *
 * @param left First presentation projection.
 * @param right Second presentation projection.
 * @returns Whether both projections are semantically equal.
 */
export const areTerminalTabPresentationsEqual = (
  left: TerminalTabPresentation | undefined,
  right: TerminalTabPresentation,
): boolean => {
  if (!left) {
    return false;
  }

  return (
    left.applicationTitle === right.applicationTitle &&
    left.progressState === right.progressState &&
    left.progressValue === right.progressValue &&
    left.progressSource === right.progressSource &&
    left.bellAttention === right.bellAttention &&
    left.latestBellEvent?.paneId === right.latestBellEvent?.paneId &&
    left.latestBellEvent?.sequence === right.latestBellEvent?.sequence &&
    left.latestBellEvent?.receivedAt === right.latestBellEvent?.receivedAt &&
    left.bellAttentionPaneIds.length === right.bellAttentionPaneIds.length &&
    left.bellAttentionPaneIds.every((paneId, index) => paneId === right.bellAttentionPaneIds[index])
  );
};

/**
 * Selects the newest standalone Bell event without depending on acknowledgement state.
 *
 * Renderer-window sequence breaks equal-timestamp ties across every pane and
 * tab. Stable pane order remains only as a defensive fallback for malformed state.
 *
 * @param paneIds Stable pane layout order.
 * @param paneStates Pane-indexed presentation state.
 * @returns Latest Bell event, or `null` when no live pane has received one.
 */
const selectLatestBellEvent = (
  paneIds: ReadonlyArray<string>,
  paneStates: TerminalPresentationStateMap,
): TerminalTabPresentation['latestBellEvent'] => {
  let selected: TerminalTabPresentation['latestBellEvent'] = null;

  for (const paneId of paneIds) {
    const state = paneStates[paneId];
    if (!state || state.lastBellAt === null || state.bellSequence <= 0) {
      continue;
    }

    if (
      !selected ||
      state.lastBellAt > selected.receivedAt ||
      (state.lastBellAt === selected.receivedAt && state.bellSequence > selected.sequence)
    ) {
      selected = {
        paneId,
        sequence: state.bellSequence,
        receivedAt: state.lastBellAt,
      };
    }
  }

  return selected;
};

type SelectedProgress = {
  progressState: Exclude<TerminalTabProgressState, 'none'>;
  progressValue: number | null;
  progressSource: Exclude<TerminalTabPresentation['progressSource'], null>;
};

/**
 * Selects progress from the active pane when it owns a visible state.
 *
 * @param paneState Active pane presentation state.
 * @returns Active progress projection, or null when no progress is present.
 */
const selectActivePaneProgress = (paneState: TerminalPresentationState | undefined): SelectedProgress | null => {
  if (!paneState || paneState.progressState === 'none') {
    return null;
  }

  return {
    progressState: paneState.progressState,
    progressValue: paneState.progressValue,
    progressSource: 'active-pane',
  };
};

/**
 * Selects the highest-severity background progress attention state.
 *
 * @param activePaneId Pane excluded from background consideration.
 * @param paneIds Stable pane layout order.
 * @param paneStates Pane-indexed presentation state.
 * @returns Background error/warning projection, or null when none exists.
 */
const selectBackgroundAttentionProgress = (
  activePaneId: string,
  paneIds: ReadonlyArray<string>,
  paneStates: TerminalPresentationStateMap,
): SelectedProgress | null => {
  const backgroundStates = paneIds
    .filter((paneId) => paneId !== activePaneId)
    .map((paneId) => paneStates[paneId])
    .filter((state): state is TerminalPresentationState => Boolean(state));
  const selectedState =
    backgroundStates.find((state) => state.progressState === 'error') ??
    backgroundStates.find((state) => state.progressState === 'warning');

  if (!selectedState || (selectedState.progressState !== 'error' && selectedState.progressState !== 'warning')) {
    return null;
  }

  return {
    progressState: selectedState.progressState,
    progressValue: selectedState.progressValue,
    progressSource: 'background-attention',
  };
};
