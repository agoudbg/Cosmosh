import type { TabItem, TerminalTabPresentation } from '../types/tabs';

/** User-configurable display policy applied after passive parser state aggregation. */
export type TerminalPresentationDisplayPolicy = {
  applicationTitleEnabled: boolean;
  progressEnabled: boolean;
  bellVisualEnabled: boolean;
};

/** Baseline tab presentation used before a terminal runtime emits state. */
export const EMPTY_TERMINAL_TAB_PRESENTATION: TerminalTabPresentation = Object.freeze({
  applicationTitle: null,
  progressState: 'none',
  progressValue: null,
  progressSource: null,
  bellAttention: false,
  bellAttentionPaneIds: Object.freeze([]) as ReadonlyArray<string>,
  latestBellEvent: null,
});

const DEFAULT_TERMINAL_PRESENTATION_DISPLAY_POLICY: TerminalPresentationDisplayPolicy = Object.freeze({
  applicationTitleEnabled: true,
  progressEnabled: true,
  bellVisualEnabled: true,
});

/**
 * Resolves one terminal tab title without merging its independent sources.
 *
 * @param tab Stored tab identity and stable title sources.
 * @param presentation Optional memory-only active-pane presentation.
 * @returns Highest-priority non-empty title.
 */
export const resolveTerminalTabTitle = (
  tab: TabItem,
  presentation: TerminalTabPresentation = EMPTY_TERMINAL_TAB_PRESENTATION,
): string => {
  const sources = tab.terminalTitleSources;
  if (!sources) {
    return tab.title;
  }

  return (
    normalizeTitleSource(sources.manualTitle) ??
    normalizeTitleSource(presentation.applicationTitle) ??
    normalizeTitleSource(sources.connectionTitle) ??
    normalizeTitleSource(sources.defaultTitle) ??
    tab.title
  );
};

/**
 * Creates the ephemeral tab-chrome projection for one terminal tab.
 *
 * @param tab Stored tab model.
 * @param presentation Optional pane-aggregated presentation state.
 * @param policy User-configurable display policy.
 * @returns Tab view model with resolved title and a stable status-slot payload.
 */
export const projectTabPresentation = (
  tab: TabItem,
  presentation: TerminalTabPresentation | undefined,
  policy: TerminalPresentationDisplayPolicy = DEFAULT_TERMINAL_PRESENTATION_DISPLAY_POLICY,
): TabItem => {
  if (tab.page !== 'ssh') {
    return tab;
  }

  const sourcePresentation = presentation ?? EMPTY_TERMINAL_TAB_PRESENTATION;
  const resolvedPresentation =
    policy.applicationTitleEnabled && policy.progressEnabled && policy.bellVisualEnabled
      ? sourcePresentation
      : {
          ...sourcePresentation,
          applicationTitle: policy.applicationTitleEnabled ? sourcePresentation.applicationTitle : null,
          progressState: policy.progressEnabled ? sourcePresentation.progressState : 'none',
          progressValue: policy.progressEnabled ? sourcePresentation.progressValue : null,
          progressSource: policy.progressEnabled ? sourcePresentation.progressSource : null,
          bellAttention: policy.bellVisualEnabled ? sourcePresentation.bellAttention : false,
          bellAttentionPaneIds: policy.bellVisualEnabled ? sourcePresentation.bellAttentionPaneIds : [],
        };
  return {
    ...tab,
    title: resolveTerminalTabTitle(tab, resolvedPresentation),
    terminalPresentation: resolvedPresentation,
  };
};

/**
 * Normalizes stored title sources at the display boundary.
 *
 * @param source Optional source value.
 * @returns Trimmed non-empty source, or null.
 */
const normalizeTitleSource = (source: string | null | undefined): string | null => {
  const normalized = source?.trim();
  return normalized ? normalized : null;
};
