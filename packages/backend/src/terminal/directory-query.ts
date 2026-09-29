import type {
  SettingsValues,
  ShellInputBoundary,
  TerminalDirectoryClientMessage,
  TerminalDirectoryResult,
} from '@cosmosh/api-contract';

import type { SnapshotCompletionController } from './completion/snapshot-completion.js';
import type { ShellEditorController } from './editor-controller.js';
import type { ShellContextState } from './shell-context.js';

/** Bounds an abandoned use-time lookup; ordinary terminal forwarding never waits for this deadline. */
const DIRECTORY_QUERY_LIFETIME_MS = 10_000;

/** Original-session boundaries; the directory request cannot provide input, paths or permission overrides. */
export type DirectoryQueryOptions = {
  editor: ShellEditorController;
  completion: () => SnapshotCompletionController | null;
  context: () => ShellContextState;
  owner: () => object | null;
  readSettings: () => Promise<SettingsValues>;
  publish: (message: TerminalDirectoryResult) => void;
  onIdle?: () => void;
};

/** Text-free request identity, independent from completion and native-history lifetimes. */
type DirectoryQuery = {
  requestId: string;
  owner: object | null;
  origin: Pick<ShellContextState, 'sessionId' | 'shellInstanceId' | 'promptGeneration' | 'inputGeneration'>;
  binding: ShellContextState['editorBinding'];
  boundary: ShellInputBoundary | null;
  lifetime: AbortController;
  cancelledStatus: 'stale' | 'unavailable';
};

type DirectoryObservation = Pick<TerminalDirectoryResult, 'status' | 'contextRevision' | 'directory'>;

/**
 * Performs a fresh directory-only observation at the user's action boundary, never returning cached CWD.
 * Input, socket, original-Shell or permission changes revoke only this request's observation.
 */
export class DirectoryQueryController {
  private active: DirectoryQuery | null = null;

  /** @param options Current original-Shell authorities and explicit persistence/publication boundaries. */
  constructor(private readonly options: DirectoryQueryOptions) {}

  /** @returns Whether a use-time observation currently owns background editor scheduling. */
  get busy(): boolean {
    return this.active !== null;
  }

  /** @param status Fixed reason class. @returns Nothing; cancellation never waits for remote cleanup. */
  invalidate(status: 'stale' | 'unavailable' = 'stale'): void {
    if (!this.active) return;
    this.active.cancelledStatus = status;
    this.active.lifetime.abort();
  }

  /** @param requestId Current opaque request identity. @returns Nothing; late cancellation cannot stop a newer query. */
  cancel(requestId: string): void {
    if (this.active?.requestId === requestId) this.invalidate();
  }

  /** @param settings Current persisted preferences. @returns Nothing after CWD opt-out takes effect. */
  settingsChanged(settings: SettingsValues): void {
    if (!settings.remoteEnhancementsEnabled || !settings.remoteEnhancementsCwdEnabled) this.invalidate('unavailable');
  }

  /** @returns Nothing; context-only confirmation is allowed, but a different input or original owner is not. */
  contextChanged(): void {
    if (!this.active) return;
    if (!this.options.context().permissions.cwd) this.invalidate('unavailable');
    else if (!this.sameOrigin(this.active)) this.invalidate();
  }

  /**
   * Captures the action's original owner before canceling completion or awaiting any operation.
   * @param message Normalized opaque directory intent.
   * @returns Completion after one bounded result; notification errors never escape into terminal handling.
   */
  async query(message: Extract<TerminalDirectoryClientMessage, { type: 'directory-query' }>): Promise<void> {
    this.invalidate();
    const context = this.options.context();
    const query: DirectoryQuery = {
      requestId: message.requestId,
      owner: this.options.owner(),
      origin: {
        sessionId: context.sessionId,
        shellInstanceId: context.shellInstanceId,
        promptGeneration: context.promptGeneration,
        inputGeneration: context.inputGeneration,
      },
      binding: context.editorBinding,
      boundary: this.options.editor.inputBoundary,
      lifetime: new AbortController(),
      cancelledStatus: 'stale',
    };
    this.active = query;
    let onAbort = (): void => {};
    const cancelled = new Promise<DirectoryObservation>((resolve) => {
      onAbort = () => resolve(this.failure(query.cancelledStatus));
      query.lifetime.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = setTimeout(() => {
      query.cancelledStatus = 'unavailable';
      query.lifetime.abort();
    }, DIRECTORY_QUERY_LIFETIME_MS);
    timeout.unref();
    try {
      let result = await Promise.race([this.observe(query).catch(() => this.failure('unavailable')), cancelled]);
      if (result.status === 'ok' && !this.isCurrent(query)) result = this.failure(query.cancelledStatus);
      this.release(query);
      if (query.owner === null || this.options.owner() !== query.owner) return;
      if (
        result.status === 'ok' &&
        (!this.sameOrigin(query) || this.options.context().revision !== result.contextRevision)
      )
        result = this.failure('stale');
      try {
        this.options.publish({ type: 'directory-result', requestId: query.requestId, ...result });
      } catch {
        console.warn('[ssh][directory] Failed to publish optional directory state.');
      }
    } finally {
      clearTimeout(timeout);
      query.lifetime.signal.removeEventListener('abort', onAbort);
      this.release(query);
    }
  }

  /** @param status Fixed failure outcome. @returns Current revision with no retained directory fallback. */
  private failure(status: 'stale' | 'unavailable'): DirectoryObservation {
    return { status, contextRevision: this.options.context().revision, directory: null };
  }

  /** @param query Original action identity. @returns Whether the same socket, Shell and input still own this request. */
  private sameOrigin(query: DirectoryQuery): boolean {
    const current = this.options.context();
    const boundary = this.options.editor.inputBoundary;
    const binding = current.editorBinding;
    return (
      query.owner !== null &&
      this.options.owner() === query.owner &&
      current.sessionId === query.origin.sessionId &&
      current.shellInstanceId === query.origin.shellInstanceId &&
      current.promptGeneration === query.origin.promptGeneration &&
      current.inputGeneration === query.origin.inputGeneration &&
      !!query.boundary &&
      boundary?.epoch === query.boundary.epoch &&
      boundary.sequence === query.boundary.sequence &&
      !!query.binding &&
      binding?.pid === query.binding.pid &&
      binding.startTime === query.binding.startTime &&
      binding.triggerNonce === query.binding.triggerNonce
    );
  }

  /** @param query Original action. @returns Whether it can still dispatch directory-only private work. */
  private isCurrent(query: DirectoryQuery): boolean {
    return this.active === query && !query.lifetime.signal.aborted && this.sameOrigin(query);
  }

  /** @param query Bounded request lifetime. @returns One fresh observation after actual source/editor cleanup. */
  private async observe(query: DirectoryQuery): Promise<DirectoryObservation> {
    if (!this.isCurrent(query) || !this.options.context().permissions.cwd) return this.failure('unavailable');
    const completion = this.options.completion();
    if (completion?.busy) completion.invalidate(false, false);
    const settings = await this.options.readSettings();
    if (!this.isCurrent(query)) return this.failure('stale');
    if (
      !settings.remoteEnhancementsEnabled ||
      !settings.remoteEnhancementsCwdEnabled ||
      !this.options.context().permissions.cwd
    )
      return this.failure('unavailable');
    if (completion && !(await completion.waitForIdle(query.lifetime.signal))) return this.failure('stale');
    if (
      !this.isCurrent(query) ||
      !(await this.options.editor.waitForIdle(query.lifetime.signal)) ||
      !this.isCurrent(query)
    )
      return this.failure('stale');
    const result = await this.options.editor.directory(query.lifetime.signal);
    if (!this.isCurrent(query)) return this.failure('stale');
    const current = this.options.context();
    const directory = result.status === 'ok' ? result.snapshot.directory : null;
    if (
      !directory?.physical ||
      !current.permissions.cwd ||
      current.status !== 'ready' ||
      current.cwd?.logical !== directory.logical ||
      current.cwd.physical !== directory.physical ||
      current.cwd.home !== directory.home
    )
      return this.failure(result.status === 'stale' ? 'stale' : 'unavailable');
    return { status: 'ok', contextRevision: current.revision, directory: { ...directory } };
  }

  /** @param query Ending request. @returns Nothing; later consumers are never canceled by an old request. */
  private release(query: DirectoryQuery): void {
    if (this.active !== query) return;
    this.active = null;
    query.lifetime.abort();
    try {
      this.options.onIdle?.();
    } catch {
      console.warn('[ssh][directory] Failed to resume optional background work.');
    }
  }
}
