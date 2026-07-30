import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, type Panel, runScopeHandlers, type ViewUpdate } from '@codemirror/view';
import { CaseSensitive, Regex, WholeWord } from 'lucide-react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import {
  type SearchReplaceFilterOption,
  type SearchReplaceLocalizedText,
  SearchReplacePanel,
  type SearchReplaceReplaceMode,
} from '../components/ui/search-replace-panel';
import { t } from './i18n';

const SEARCH_MATCH_LIMIT = 1000;

const CODEMIRROR_SEARCH_FILTER_IDS = ['caseSensitive', 'regexp', 'wholeWord'] as const;

/**
 * Built-in CodeMirror search filters supported by the adapter.
 */
export type CodeMirrorSearchReplaceFilterId = (typeof CODEMIRROR_SEARCH_FILTER_IDS)[number];

/**
 * Panel placement for the CodeMirror search/replace adapter.
 *
 * `floating` overlays the panel near the editor's top-right corner and is the default.
 * `docked-bottom` pins the panel to the editor's bottom edge as a full-width bar that
 * participates in the layout flow, which keeps narrow panes (such as the SFTP preview
 * sidebar) from clipping the controls or hiding content behind an overlay.
 */
export type CodeMirrorSearchReplacePlacement = 'floating' | 'docked-bottom';

/**
 * Options for the reusable CodeMirror search/replace extension.
 */
export type CodeMirrorSearchReplaceOptions = {
  compact?: boolean;
  filters?: readonly CodeMirrorSearchReplaceFilterId[];
  placement?: CodeMirrorSearchReplacePlacement;
  replaceMode?: SearchReplaceReplaceMode;
  showMatchCount?: boolean;
};

type SearchMatchSummary = {
  capped: boolean;
  current: number | null;
  total: number;
};

/**
 * Creates the shared Cosmosh search/replace integration for a CodeMirror editor.
 *
 * @param options Replacement visibility, filter visibility, and density options.
 * @returns CodeMirror extension that installs search state and the custom panel.
 */
export const createCodeMirrorSearchReplaceExtension = (options: CodeMirrorSearchReplaceOptions = {}): Extension => [
  search({
    createPanel: (view) => new CosmoshCodeMirrorSearchPanel(view, options),
    // The custom panel owns its own `top` getter; this only keeps the shared
    // search config facet consistent for any other extension that reads it.
    top: options.placement !== 'docked-bottom',
  }),
  createCodeMirrorSearchReplaceTheme(),
];

/**
 * Opens the shared search/replace panel for a CodeMirror editor.
 *
 * @param view CodeMirror editor view.
 * @returns Whether the command was handled.
 */
export const openCodeMirrorSearchReplace = (view: EditorView): boolean => {
  return openSearchPanel(view);
};

/**
 * Builds the floating CodeMirror panel and match highlight theme.
 *
 * @returns CodeMirror theme extension.
 */
const createCodeMirrorSearchReplaceTheme = (): Extension =>
  EditorView.theme(
    {
      '&': {
        position: 'relative',
      },
      '.cm-panels': {
        backgroundColor: 'transparent',
        border: '0',
        color: 'var(--color-header-text)',
        // CodeMirror's base theme pins sticky panels at z-index 300, which paints docked
        // panels above the app's portaled tooltips (z-50). In-flow panels never overlap
        // editor content, so drop the stacking lift and let tooltips render on top.
        zIndex: 'auto',
      },
      '.cm-panels-top': {
        borderBottom: '0',
        left: 'auto',
        maxWidth: 'calc(100% - 16px)',
        position: 'absolute',
        right: '8px',
        top: '8px',
        zIndex: '30',
      },
      '.cosmosh-codemirror-search-panel': {
        backgroundColor: 'transparent',
        border: '0',
        boxSizing: 'border-box',
        color: 'var(--color-header-text)',
        maxWidth: '100%',
        padding: '0',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--color-menu-selection-bar-border)',
        outline: '1px solid var(--color-home-divider)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--color-command-item-active)',
      },
    },
    { dark: true },
  );

/**
 * Copies the current query with a small patch while preserving hidden CodeMirror options.
 *
 * @param query Current CodeMirror search query.
 * @param patch Updated query fields.
 * @returns Next CodeMirror search query.
 */
const copySearchQuery = (
  query: SearchQuery,
  patch: Partial<{
    caseSensitive: boolean;
    regexp: boolean;
    replace: string;
    search: string;
    wholeWord: boolean;
  }>,
): SearchQuery =>
  new SearchQuery({
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    regexp: query.regexp,
    replace: query.replace,
    search: query.search,
    test: query.test,
    wholeWord: query.wholeWord,
    ...patch,
  });

/**
 * Counts matches and resolves the selected match ordinal for the current query.
 *
 * @param state CodeMirror editor state.
 * @param query Current search query.
 * @returns Count summary capped for large documents.
 */
const resolveSearchMatchSummary = (state: EditorState, query: SearchQuery): SearchMatchSummary => {
  if (!query.valid) {
    return {
      capped: false,
      current: null,
      total: 0,
    };
  }

  const selection = state.selection.main;
  const cursor = query.getCursor(state, 0, state.doc.length);
  let capped = false;
  let current: number | null = null;
  let total = 0;

  for (;;) {
    const next = cursor.next();
    if (next.done) {
      break;
    }

    if (total >= SEARCH_MATCH_LIMIT) {
      capped = true;
      break;
    }

    total += 1;

    if (current === null && selection.from === next.value.from && selection.to === next.value.to) {
      current = total;
    }
  }

  return {
    capped,
    current,
    total,
  };
};

/**
 * Resolves the localized match count label for the panel.
 *
 * @param query Current search query.
 * @param summary Match count summary.
 * @returns Localized match count or status text.
 */
const createMatchLabel = (query: SearchQuery, summary: SearchMatchSummary): SearchReplaceLocalizedText | undefined => {
  if (!query.search) {
    return undefined;
  }

  if (!query.valid) {
    return () => t('searchReplace.invalidPattern');
  }

  if (summary.total === 0) {
    return () => t('searchReplace.noMatches');
  }

  if (summary.current !== null) {
    return () =>
      t(summary.capped ? 'searchReplace.currentMatchCapped' : 'searchReplace.currentMatch', {
        current: summary.current ?? 0,
        total: summary.total,
      });
  }

  return () =>
    t(summary.capped ? 'searchReplace.matchCountCapped' : 'searchReplace.matchCount', { total: summary.total });
};

/**
 * Resolves replacement mode with editor readonly state as the hard ceiling.
 *
 * @param configuredMode Caller-requested replacement mode.
 * @param state Current CodeMirror editor state.
 * @returns Effective replacement mode.
 */
const resolveReplaceMode = (
  configuredMode: SearchReplaceReplaceMode | undefined,
  state: EditorState,
): SearchReplaceReplaceMode => {
  if (configuredMode === 'hidden') {
    return 'hidden';
  }

  if (state.readOnly) {
    return 'readonly';
  }

  return configuredMode ?? 'editable';
};

/**
 * Builds the configured CodeMirror filter toggles for the reusable panel.
 *
 * @param filterIds Enabled built-in filter ids.
 * @param query Current CodeMirror search query.
 * @param onQueryPatch Query patch dispatcher.
 * @returns Search/replace panel filter options.
 */
const createCodeMirrorFilterOptions = (
  filterIds: readonly CodeMirrorSearchReplaceFilterId[],
  query: SearchQuery,
  onQueryPatch: (
    patch: Partial<{
      caseSensitive: boolean;
      regexp: boolean;
      wholeWord: boolean;
    }>,
  ) => void,
): SearchReplaceFilterOption[] => {
  return filterIds.map((filterId) => {
    if (filterId === 'caseSensitive') {
      return {
        icon: CaseSensitive,
        id: filterId,
        label: () => t('searchReplace.matchCase'),
        onPressedChange: (pressed) => onQueryPatch({ caseSensitive: pressed }),
        pressed: query.caseSensitive,
      };
    }

    if (filterId === 'regexp') {
      return {
        icon: Regex,
        id: filterId,
        label: () => t('searchReplace.regexp'),
        onPressedChange: (pressed) => onQueryPatch({ regexp: pressed }),
        pressed: query.regexp,
      };
    }

    return {
      icon: WholeWord,
      id: filterId,
      label: () => t('searchReplace.wholeWord'),
      onPressedChange: (pressed) => onQueryPatch({ wholeWord: pressed }),
      pressed: query.wholeWord,
    };
  });
};

/**
 * React-backed CodeMirror search panel that delegates UI to SearchReplacePanel.
 */
class CosmoshCodeMirrorSearchPanel implements Panel {
  public readonly dom = document.createElement('div');

  private readonly options: CodeMirrorSearchReplaceOptions;
  private root: Root | null = null;
  private searchInput: HTMLInputElement | null = null;
  private view: EditorView;

  /**
   * Creates the custom CodeMirror search panel.
   *
   * @param view CodeMirror editor view.
   * @param options Search/replace adapter options.
   */
  public constructor(view: EditorView, options: CodeMirrorSearchReplaceOptions) {
    this.view = view;
    this.options = options;
    this.dom.className = 'cosmosh-codemirror-search-panel';
    this.root = createRoot(this.dom);
    this.render(true);
  }

  /**
   * Focuses the search input once CodeMirror mounts the panel.
   *
   * @returns Nothing.
   */
  public mount(): void {
    this.searchInput?.select();
  }

  /**
   * Re-renders the React panel after editor or query updates.
   *
   * @param update CodeMirror view update.
   * @returns Nothing.
   */
  public update(update: ViewUpdate): void {
    this.view = update.view;
    this.render();
  }

  /**
   * Unmounts the React root owned by this CodeMirror panel.
   *
   * @returns Nothing.
   */
  public destroy(): void {
    this.root?.unmount();
    this.root = null;
  }

  /**
   * Keeps the panel ordered near the right edge of the editor.
   *
   * @returns Panel ordering position.
   */
  public get pos(): number {
    return 80;
  }

  /**
   * Reports the panel group: floating overlays stay on top, docked bars join the bottom group.
   *
   * @returns Whether the panel is a top panel.
   */
  public get top(): boolean {
    return this.options.placement !== 'docked-bottom';
  }

  /**
   * Dispatches a CodeMirror search query patch.
   *
   * @param patch Query fields to update.
   * @returns Nothing.
   */
  private updateQuery(
    patch: Partial<{
      caseSensitive: boolean;
      regexp: boolean;
      replace: string;
      search: string;
      wholeWord: boolean;
    }>,
  ): void {
    const query = getSearchQuery(this.view.state);
    this.view.dispatch({
      effects: setSearchQuery.of(copySearchQuery(query, patch)),
    });
  }

  /**
   * Renders the controlled search/replace panel into the CodeMirror panel host.
   *
   * @returns Nothing.
   */
  private render(sync = false): void {
    if (!this.root) {
      return;
    }

    const query = getSearchQuery(this.view.state);
    const summary = resolveSearchMatchSummary(this.view.state, query);
    const canActOnMatches = query.valid && query.search.length > 0 && summary.total > 0;
    const filterIds = this.options.filters ?? CODEMIRROR_SEARCH_FILTER_IDS;
    const replaceMode = resolveReplaceMode(this.options.replaceMode, this.view.state);

    const panel = (
      <SearchReplacePanel
        actionState={{
          findNext: { disabled: !canActOnMatches },
          findPrevious: { disabled: !canActOnMatches },
          replaceAll: { disabled: !canActOnMatches || replaceMode !== 'editable' },
          replaceNext: { disabled: !canActOnMatches || replaceMode !== 'editable' },
          selectAllMatches: { disabled: !canActOnMatches },
        }}
        compact={this.options.compact ?? true}
        docked={this.options.placement === 'docked-bottom'}
        filters={createCodeMirrorFilterOptions(filterIds, query, (patch) => this.updateQuery(patch))}
        invalid={query.search.length > 0 && !query.valid}
        matchLabel={createMatchLabel(query, summary)}
        replaceMode={replaceMode}
        replaceValue={query.replace}
        searchInputRef={(node) => {
          this.searchInput = node;
        }}
        searchValue={query.search}
        showMatchCount={this.options.showMatchCount ?? true}
        onClose={() => closeSearchPanel(this.view)}
        onFindNext={() => {
          if (canActOnMatches) {
            findNext(this.view);
          }
        }}
        onFindPrevious={() => {
          if (canActOnMatches) {
            findPrevious(this.view);
          }
        }}
        onPanelKeyDown={(event) => {
          if (runScopeHandlers(this.view, event.nativeEvent, 'search-panel')) {
            event.preventDefault();
          }
        }}
        onReplaceAll={() => {
          if (canActOnMatches && replaceMode === 'editable') {
            replaceAll(this.view);
          }
        }}
        onReplaceChange={(value) => this.updateQuery({ replace: value })}
        onReplaceNext={() => {
          if (canActOnMatches && replaceMode === 'editable') {
            replaceNext(this.view);
          }
        }}
        onSearchChange={(value) => this.updateQuery({ search: value })}
        onSelectAllMatches={() => {
          if (canActOnMatches) {
            selectMatches(this.view);
          }
        }}
      />
    );

    if (sync) {
      flushSync(() => {
        this.root?.render(panel);
      });
      return;
    }

    this.root.render(panel);
  }
}
