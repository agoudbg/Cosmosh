import type { TerminalWindowActivity, TerminalWindowProgressState } from '@cosmosh/api-contract';

import type { TabItem, TerminalTabPresentation } from '../types/tabs';

type AggregateTerminalWindowActivityParams = {
  tabs: ReadonlyArray<TabItem>;
  activeTabId: string;
  rendererEpoch: string;
  bellAudibleEnabled: boolean;
  bellFlashEnabled: boolean;
};

type TabProgressCandidate = {
  tabId: string;
  presentation: TerminalTabPresentation;
};

const WINDOW_PROGRESS_SEVERITY: Readonly<Record<TerminalWindowProgressState, number>> = Object.freeze({
  none: 0,
  normal: 1,
  indeterminate: 2,
  warning: 3,
  error: 4,
});

/**
 * Aggregates all tab-scoped terminal presentation into one window snapshot.
 *
 * Error and warning attention outrank ordinary progress in every tab. Within
 * one severity, the active tab wins, followed by stable tab order. Bell
 * attention and Bell edge identity remain independent from progress.
 *
 * @param params Ordered tabs and the active tab identity.
 * @returns Complete memory-only activity snapshot for the owning window.
 */
export const aggregateTerminalWindowActivity = ({
  tabs,
  activeTabId,
  rendererEpoch,
  bellAudibleEnabled,
  bellFlashEnabled,
}: AggregateTerminalWindowActivityParams): TerminalWindowActivity => {
  const progress = selectWindowProgress(tabs, activeTabId);
  const latestBellEvent = selectLatestWindowBellEvent(tabs, rendererEpoch);

  return {
    progressState: progress?.progressState ?? 'none',
    progressValue: progress?.progressValue ?? null,
    bellAttention: tabs.some((tab) => tab.terminalPresentation?.bellAttention),
    bellAudibleEnabled,
    bellFlashEnabled,
    latestBellEvent,
  };
};

/**
 * Selects the highest-severity progress candidate for taskbar presentation.
 *
 * @param tabs Stable window tab order.
 * @param rendererEpoch Current renderer-document epoch.
 * @param activeTabId Current active tab identity.
 * @returns Selected progress fields, or `null` when no terminal progress exists.
 */
const selectWindowProgress = (
  tabs: ReadonlyArray<TabItem>,
  activeTabId: string,
): Pick<TerminalTabPresentation, 'progressState' | 'progressValue'> | null => {
  const candidates = tabs.flatMap<TabProgressCandidate>((tab) => {
    const presentation = tab.terminalPresentation;
    return presentation && presentation.progressState !== 'none' ? [{ tabId: tab.id, presentation }] : [];
  });
  if (candidates.length === 0) {
    return null;
  }

  const highestSeverity = Math.max(
    ...candidates.map(({ presentation }) => WINDOW_PROGRESS_SEVERITY[presentation.progressState]),
  );
  const highestSeverityCandidates = candidates.filter(
    ({ presentation }) => WINDOW_PROGRESS_SEVERITY[presentation.progressState] === highestSeverity,
  );
  const selected = highestSeverityCandidates.find(({ tabId }) => tabId === activeTabId) ?? highestSeverityCandidates[0];

  return {
    progressState: selected.presentation.progressState,
    progressValue: selected.presentation.progressValue,
  };
};

/**
 * Selects the latest Bell edge across all live terminal tabs.
 *
 * @param tabs Stable window tab order.
 * @returns Window-scoped Bell identity, or `null` before the first Bell.
 */
const selectLatestWindowBellEvent = (
  tabs: ReadonlyArray<TabItem>,
  rendererEpoch: string,
): TerminalWindowActivity['latestBellEvent'] => {
  let selected: TerminalWindowActivity['latestBellEvent'] = null;

  for (const tab of tabs) {
    const event = tab.terminalPresentation?.latestBellEvent;
    if (!event || event.rendererEpoch !== rendererEpoch) {
      continue;
    }

    if (!selected || event.sequence > selected.sequence) {
      selected = {
        rendererEpoch,
        tabId: tab.id,
        paneId: event.paneId,
        sequence: event.sequence,
      };
    }
  }

  return selected;
};
