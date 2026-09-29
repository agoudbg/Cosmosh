import type {
  SettingsValues,
  ShellCompletionCandidate,
  ShellEditorSnapshot,
  ShellHistoryView,
  ShellInputBoundary,
  TerminalCompletionAcceptResult,
  TerminalCompletionClientMessage,
  TerminalCompletionSources,
  TerminalCompletionSourceStatus,
  TerminalCompletionUpdate,
} from '@cosmosh/api-contract';

import type { ShellEditorController } from '../editor-controller.js';
import type { ShellContextState } from '../shell-context.js';
import { buildNativeCompletionDrafts, canQueryNativeCompletion } from './native-completion.js';
import type { RemotePathQueryController } from './remote-path-query.js';
import {
  buildShellCompletionReplacement,
  parseShellCompletionContext,
  type ShellCompletionDraft,
} from './snapshot-edits.js';
import { resolveSnapshotPaths, type SnapshotPathResult } from './snapshot-paths.js';
import { rankSnapshotSuggestions, resolveSnapshotSuggestions } from './snapshot-suggestions.js';

/** Session-owned boundaries; input and candidate edits never cross the public message boundary. */
export type SnapshotCompletionOptions = {
  editor: ShellEditorController;
  paths: RemotePathQueryController;
  context: () => ShellContextState;
  readSettings: () => Promise<SettingsValues>;
  history: () => ShellHistoryView | null;
  publish: (message: TerminalCompletionUpdate | TerminalCompletionAcceptResult) => void;
  onIdle?: () => void;
};

/** Private lifetime of one query, retained at most as long as its editor snapshot. */
type CompletionQuery = {
  requestId: string;
  trigger: 'typing' | 'manual';
  origin: Pick<ShellContextState, 'shellInstanceId' | 'inputGeneration'>;
  boundary: ShellInputBoundary | null;
  lifetime: AbortController;
  sourcesLifetime: AbortController;
  settings: SettingsValues | null;
  context: ShellContextState | null;
  snapshot: ShellEditorSnapshot | null;
  snapshotId: string | null;
  historySourceId: string | null;
  drafts: ShellCompletionDraft[];
  candidates: Map<string, ShellCompletionCandidate>;
  sources: TerminalCompletionSources;
  accepting: boolean;
  acceptRequestId: string | null;
  expiry: NodeJS.Timeout | null;
};

/** @param status Initial source state. @returns A fresh complete source dictionary. */
const allSources = (status: TerminalCompletionSourceStatus): TerminalCompletionSources => ({
  history: status,
  metadata: status,
  paths: status,
  native: status,
});

/** @param requestId Normalized query ID. @param contextRevision Current public revision, or zero for a local terminal.
 * @returns A complete optional-feature failure without changing ordinary terminal behavior. */
export const unavailableCompletionUpdate = (requestId: string, contextRevision: number): TerminalCompletionUpdate => ({
  type: 'completion-update',
  requestId,
  snapshotId: null,
  contextRevision,
  status: 'unavailable',
  complete: true,
  sources: allSources('unavailable'),
  items: [],
});

/**
 * Keeps preference invalidation limited to behavior that can change candidate eligibility or meaning.
 * @param settings Current persisted defaults. @returns Stable, text-free comparison key.
 */
const settingsKey = (settings: SettingsValues): string =>
  JSON.stringify([
    settings.remoteEnhancementsEnabled,
    settings.remoteEnhancementsCwdEnabled,
    settings.remoteEnhancementsInputEnabled,
    settings.remoteEnhancementsHistoryEnabled,
    settings.terminalAutoCompleteEnabled,
    settings.terminalAutoCompleteMinChars,
    settings.terminalAutoCompleteMaxItems,
    settings.terminalAutoCompleteFuzzyMatch,
    settings.terminalAutoCompleteHistoryEnabled,
    settings.terminalAutoCompleteBuiltInCommandsEnabled,
    settings.terminalAutoCompletePathEnabled,
    settings.terminalNativeCompletionMode,
  ]);

/** @param status Structured directory outcome. @returns Public source state without exposing remote errors or paths. */
const pathStatus = (status: SnapshotPathResult['status']): TerminalCompletionSourceStatus => {
  if (status === 'ok' || status === 'partial' || status === 'timeout' || status === 'unsupported') return status;
  if (status === 'missing' || status === 'not-directory') return 'ok';
  return 'unavailable';
};

/**
 * Serializes one session's snapshot requests while allowing path lookup and native completion to finish independently.
 * Only a Renderer intent and opaque identifiers are accepted. All matching and insertion use the original Shell.
 */
export class SnapshotCompletionController {
  private active: CompletionQuery | null = null;
  private work: Promise<void> = Promise.resolve();

  /** @param options Current session authorities and explicit persistence/transport boundaries. */
  constructor(private readonly options: SnapshotCompletionOptions) {}

  /**
   * Contains optional presentation failures without exposing input, candidate labels or transport errors.
   * @param message Already normalized display state or an opaque edit outcome.
   * @returns Whether the publication boundary accepted the message.
   */
  private notify(message: TerminalCompletionUpdate | TerminalCompletionAcceptResult): boolean {
    try {
      this.options.publish(message);
      return true;
    } catch {
      console.warn('[ssh][completion] Failed to publish optional completion state.', { type: message.type });
      return false;
    }
  }

  /** @returns Whether a private snapshot/query owns the menu, so background refreshes should remain queued. */
  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * Cancels in place before forwarding input; remote cleanup proceeds asynchronously.
   * @param clearPaths Whether permission, identity or transport teardown also erases cached filenames.
   * @param notify Whether the still-attached menu should receive a terminal stale result.
   * @returns Nothing; ordinary terminal input never awaits optional work.
   */
  invalidate(clearPaths = false, notify = true): void {
    const query = this.active;
    if (clearPaths) this.options.paths.clear();
    else this.options.paths.cancel();
    this.options.editor.invalidate();
    if (!query) return;
    this.release(query);
    if (notify && !query.accepting) this.publishFailure(query, 'stale');
  }

  /**
   * Waits for the current sources' actual cleanup without transferring their input or candidate authority.
   * @param signal Waiting consumer's lifetime; cancellation releases only this waiter.
   * @returns Whether the captured source group finished before cancellation.
   */
  async waitForIdle(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const pending = this.work;
    return await new Promise<boolean>((resolve) => {
      /** @param ready Whether the source group completed. @returns Nothing after releasing the listener. */
      const finish = (ready: boolean): void => {
        signal.removeEventListener('abort', abort);
        resolve(ready);
      };
      /** @returns Nothing; remote cleanup continues independently of this consumer. */
      const abort = (): void => finish(false);
      signal.addEventListener('abort', abort, { once: true });
      void pending.then(
        () => finish(!signal.aborted),
        () => finish(false),
      );
    });
  }

  /** @param requestId Query dismissed by its current pane. @returns Nothing; late cancellation cannot dismiss a new query. */
  cancel(requestId: string): void {
    if (this.active?.requestId === requestId || this.active?.acceptRequestId === requestId)
      this.invalidate(false, false);
  }

  /** @param settings Persisted settings notification. @returns Nothing; unrelated appearance changes preserve the menu. */
  settingsChanged(settings: SettingsValues): void {
    if (this.active?.settings && settingsKey(settings) !== settingsKey(this.active.settings)) this.invalidate(true);
  }

  /** @returns Nothing; a pure pre-snapshot refresh is allowed, while changed ownership or an established snapshot is not. */
  contextChanged(): void {
    if (this.active && !this.isCurrent(this.active)) this.invalidate(true);
  }

  /** @returns Nothing; a private or replaced native history source cannot authorize an old history candidate. */
  historyChanged(): void {
    if (this.active?.historySourceId && this.options.history()?.source?.id !== this.active.historySourceId)
      this.invalidate();
  }

  /**
   * Starts from the exact input identity present when the request arrived, even if cleanup must finish first.
   * @param message Normalized opaque query. @returns Completion after every source has finished or been canceled.
   */
  query(message: Extract<TerminalCompletionClientMessage, { type: 'completion-query' }>): Promise<void> {
    const predecessor = this.work;
    if (this.active) this.invalidate(false, false);
    const context = this.options.context();
    const query: CompletionQuery = {
      requestId: message.requestId,
      trigger: message.trigger,
      origin: { shellInstanceId: context.shellInstanceId, inputGeneration: context.inputGeneration },
      boundary: this.options.editor.inputBoundary,
      lifetime: new AbortController(),
      sourcesLifetime: new AbortController(),
      settings: null,
      context: null,
      snapshot: null,
      snapshotId: null,
      historySourceId: null,
      drafts: [],
      candidates: new Map(),
      sources: allSources('unavailable'),
      accepting: false,
      acceptRequestId: null,
      expiry: null,
    };
    this.active = query;
    const work = predecessor
      .then(async () => {
        if (!this.isCurrent(query)) return;
        await this.prepare(query);
      })
      .catch(() => {
        // Provider failures are optional feature outcomes. No exception text or input is sent to diagnostics.
        if (this.isCurrent(query) && !query.accepting) this.fail(query, 'unavailable');
      })
      .finally(() => {
        if (this.active === query && !this.isCurrent(query)) this.fail(query, 'stale');
      });
    this.work = work;
    return work;
  }

  /**
   * Stops slow sources and awaits their cleanup while retaining the exact selected private edit.
   * @param message Opaque selection; its request ID identifies this acknowledgement, not a new query.
   * @returns Completion after a confirmed edit or a fixed failure. No terminal text is written by this controller.
   */
  async accept(message: Extract<TerminalCompletionClientMessage, { type: 'completion-accept' }>): Promise<void> {
    const query = this.active;
    const candidate = query && [...query.candidates.values()].find((item) => item.id === message.candidateId);
    if (!query || query.accepting || !candidate || query.snapshotId !== message.snapshotId || !this.isCurrent(query)) {
      this.notify({ type: 'completion-accept-result', requestId: message.requestId, status: 'stale' });
      return;
    }
    query.accepting = true;
    query.acceptRequestId = message.requestId;
    query.sourcesLifetime.abort();
    this.options.paths.cancel();
    let status: TerminalCompletionAcceptResult['status'] = 'stale';
    let applyStarted = false;
    try {
      // A canceled native exchange may still be closing its SSH channel. Do not erase the candidate to cancel it.
      await this.work;
      if (!this.isCurrent(query)) return;
      const settings = await this.options.readSettings();
      if (!this.isCurrent(query) || !query.settings || settingsKey(settings) !== settingsKey(query.settings)) return;
      if (candidate.source === 'history' && this.options.history()?.source?.id !== query.historySourceId) return;
      if (!(await this.options.editor.waitForIdle(query.lifetime.signal)) || !this.isCurrent(query)) return;
      applyStarted = true;
      const result = await this.options.editor.applyCandidate(message.snapshotId, message.candidateId);
      status =
        result.status === 'applied' ||
        result.status === 'stale' ||
        result.status === 'unsupported' ||
        result.status === 'unavailable' ||
        result.status === 'unknown'
          ? result.status
          : 'unknown';
    } catch {
      status = applyStarted ? 'unknown' : 'unavailable';
    } finally {
      // An applied acknowledgement may itself advance the public context revision/input generation.
      if (this.active === query) this.release(query);
      this.notify({ type: 'completion-accept-result', requestId: message.requestId, status });
    }
  }

  /** @param query Original query lifetime. @returns Whether typing, ownership or an established snapshot has changed. */
  private isCurrent(query: CompletionQuery): boolean {
    const context = this.options.context();
    const boundary = this.options.editor.inputBoundary;
    return (
      this.active === query &&
      !query.lifetime.signal.aborted &&
      context.shellInstanceId === query.origin.shellInstanceId &&
      context.inputGeneration === query.origin.inputGeneration &&
      boundary?.epoch === query.boundary?.epoch &&
      boundary?.sequence === query.boundary?.sequence &&
      (!query.context || context === query.context)
    );
  }

  /** @param query Current query, still bound to its initial input. @returns Completion after immediate and optional remote sources. */
  private async prepare(query: CompletionQuery): Promise<void> {
    const settings = await this.options.readSettings();
    if (!this.isCurrent(query)) return;
    query.settings = settings;
    if (!settings.terminalAutoCompleteEnabled || !settings.remoteEnhancementsEnabled) {
      query.sources = allSources('disabled');
      this.fail(query, 'unavailable');
      return;
    }
    if (!settings.remoteEnhancementsInputEnabled || !this.options.context().permissions.input) {
      query.sources = allSources('private');
      this.fail(query, 'unavailable');
      return;
    }
    const editor = this.options.editor;
    let context = this.options.context();
    if (context.status === 'paused' || context.requiresEditorConfirmation) await editor.refreshContext();
    if (!this.isCurrent(query) || !(await editor.waitForIdle(query.lifetime.signal)) || !this.isCurrent(query)) return;
    context = this.options.context();
    if (context.shell !== 'bash' && context.shell !== 'zsh' && context.shell !== 'fish') {
      this.fail(query, 'unsupported');
      return;
    }
    const captured = await editor.snapshot();
    if (!this.isCurrent(query)) return;
    if (captured.status !== 'ok' || !captured.snapshotId || !captured.snapshot.buffer) {
      this.fail(
        query,
        captured.status === 'stale' || captured.status === 'unsupported' || captured.status === 'unknown'
          ? captured.status
          : 'unavailable',
      );
      return;
    }
    query.context = this.options.context();
    query.snapshot = captured.snapshot;
    query.snapshotId = captured.snapshotId;
    query.expiry = setTimeout(() => {
      if (this.active === query) this.invalidate();
    }, 10_000);
    query.expiry.unref();
    const prefix = Array.from(captured.snapshot.buffer.text)
      .slice(0, captured.snapshot.buffer.cursor)
      .join('')
      .trimStart();
    if (query.trigger === 'typing' && Array.from(prefix).length < settings.terminalAutoCompleteMinChars) {
      query.sources = allSources('disabled');
      this.publish(query);
      return;
    }
    const history = this.options.history();
    const historyEnabled =
      settings.terminalAutoCompleteHistoryEnabled &&
      settings.remoteEnhancementsHistoryEnabled &&
      context.permissions.history;
    query.sources.history = !settings.terminalAutoCompleteHistoryEnabled
      ? 'disabled'
      : !historyEnabled
        ? 'private'
        : (history?.status ?? 'unavailable');
    query.historySourceId = historyEnabled ? (history?.source?.id ?? null) : null;
    query.sources.metadata = !settings.terminalAutoCompleteBuiltInCommandsEnabled
      ? 'disabled'
      : parseShellCompletionContext(context.shell, captured.snapshot.buffer)
        ? 'ok'
        : 'unsupported';
    query.drafts = resolveSnapshotSuggestions(
      context.shell,
      captured.snapshot.buffer,
      historyEnabled ? (history?.entries ?? []) : [],
      {
        history: historyEnabled,
        metadata: settings.terminalAutoCompleteBuiltInCommandsEnabled,
        fuzzyMatch: settings.terminalAutoCompleteFuzzyMatch,
      },
    );
    query.sources.paths = !settings.terminalAutoCompletePathEnabled
      ? 'disabled'
      : !settings.remoteEnhancementsCwdEnabled || !context.permissions.cwd || !context.permissions.paths
        ? 'private'
        : !captured.snapshot.directory?.physical
          ? 'unavailable'
          : 'loading';
    query.sources.native =
      settings.terminalNativeCompletionMode === 'off' ||
      (settings.terminalNativeCompletionMode === 'manual' && query.trigger !== 'manual')
        ? 'disabled'
        : !settings.remoteEnhancementsCwdEnabled || !context.permissions.cwd || !context.permissions.nativeCompletion
          ? 'private'
          : context.shell !== 'fish' ||
              !context.capabilities.includes('native-completion') ||
              !canQueryNativeCompletion(captured.snapshot)
            ? 'unsupported'
            : 'loading';
    this.publish(query);
    // Both transports are bounded independently. A replacement query waits for this entire group to finish cleanup.
    const sources: Promise<void>[] = [];
    if (query.sources.paths === 'loading') sources.push(this.queryPaths(query));
    if (query.sources.native === 'loading') sources.push(this.queryNative(query));
    await Promise.all(sources);
  }

  /** @param query Snapshot owning this directory lookup. @returns Completion after the bounded remote source. */
  private async queryPaths(query: CompletionQuery): Promise<void> {
    if (
      !query.snapshot ||
      !query.settings ||
      !query.context ||
      !this.isCurrent(query) ||
      query.sourcesLifetime.signal.aborted
    )
      return;
    const shell = query.context.shell;
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') return;
    try {
      const result = await resolveSnapshotPaths(shell, query.snapshot, (request) => this.options.paths.query(request), {
        fuzzyMatch: query.settings.terminalAutoCompleteFuzzyMatch,
        limit: 128,
      });
      if (!this.isCurrent(query) || query.sourcesLifetime.signal.aborted) return;
      query.sources.paths = pathStatus(result.status);
      query.drafts.push(...result.drafts);
    } catch {
      if (!this.isCurrent(query) || query.sourcesLifetime.signal.aborted) return;
      query.sources.paths = 'unavailable';
    }
    this.publish(query);
  }

  /** @param query Snapshot owning the isolated native query. @returns Completion after editor/channel cleanup. */
  private async queryNative(query: CompletionQuery): Promise<void> {
    const signal = query.sourcesLifetime.signal;
    if (
      !(await this.options.editor.waitForIdle(signal)) ||
      !this.isCurrent(query) ||
      !query.snapshotId ||
      !query.snapshot
    )
      return;
    const result = await this.options.editor.nativeCompletion(query.snapshotId, signal);
    if (!this.isCurrent(query) || signal.aborted) return;
    query.sources.native =
      result.status === 'native-completions'
        ? result.completion.status
        : result.status === 'unsupported'
          ? 'unsupported'
          : 'unavailable';
    if (result.status === 'native-completions')
      query.drafts.push(...buildNativeCompletionDrafts(query.snapshot, result.completion));
    this.publish(query);
  }

  /** @param query One unchanged snapshot. @returns Nothing; late sources preserve every previously bound edit identifier. */
  private publish(query: CompletionQuery): void {
    if (!this.isCurrent(query) || query.accepting || !query.snapshot?.buffer || !query.snapshotId || !query.settings)
      return;
    // The persisted setting is bounded to 3..20. Three cumulative publications bind at most 60 edits, below 128.
    const limit = Math.max(3, Math.min(20, Math.trunc(query.settings.terminalAutoCompleteMaxItems)));
    const ranked = rankSnapshotSuggestions(query.snapshot.buffer, query.drafts, limit);
    const items: ShellCompletionCandidate[] = [];
    for (const draft of ranked) {
      const key = JSON.stringify(buildShellCompletionReplacement(query.snapshot.buffer, draft.edit));
      let candidate = query.candidates.get(key);
      if (!candidate) {
        const bound = this.options.editor.bindCandidates(query.snapshotId, [draft]);
        if (!bound) {
          this.fail(query, 'stale');
          return;
        }
        candidate = bound[0];
        if (!candidate) continue;
        query.candidates.set(key, candidate);
      }
      items.push(candidate);
    }
    const delivered = this.notify({
      type: 'completion-update',
      requestId: query.requestId,
      snapshotId: query.snapshotId,
      contextRevision: query.context!.revision,
      status: 'ready',
      complete: !Object.values(query.sources).includes('loading'),
      sources: { ...query.sources },
      items,
    });
    if (!delivered && this.active === query) this.invalidate(false, false);
  }

  /** @param query Ending query. @param status Fixed public failure. @returns Nothing; the payload contains no private input. */
  private publishFailure(query: CompletionQuery, status: Exclude<TerminalCompletionUpdate['status'], 'ready'>): void {
    this.notify({
      type: 'completion-update',
      requestId: query.requestId,
      snapshotId: null,
      contextRevision: this.options.context().revision,
      status,
      complete: true,
      sources: Object.fromEntries(
        Object.entries(query.sources).map(([source, value]) => [source, value === 'loading' ? 'unavailable' : value]),
      ) as TerminalCompletionSources,
      items: [],
    });
  }

  /** @param query Current query. @param status Fixed public outcome. @returns Nothing; private input is released immediately. */
  private fail(query: CompletionQuery, status: Exclude<TerminalCompletionUpdate['status'], 'ready'>): void {
    this.options.editor.invalidate();
    this.release(query);
    this.publishFailure(query, status);
  }

  /** @param query Completed/canceled lifetime. @returns Nothing; clears private copies and resumes queued background work. */
  private release(query: CompletionQuery): void {
    query.lifetime.abort();
    query.sourcesLifetime.abort();
    if (query.expiry) clearTimeout(query.expiry);
    query.expiry = null;
    query.snapshot = null;
    query.drafts = [];
    query.candidates.clear();
    if (this.active === query) {
      this.active = null;
      this.options.paths.cancel();
      try {
        this.options.onIdle?.();
      } catch {
        console.warn('[ssh][completion] Failed to resume optional background work.');
      }
    }
  }
}
