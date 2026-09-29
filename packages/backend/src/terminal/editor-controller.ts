import { randomUUID } from 'node:crypto';

import type {
  ShellCompletionCandidate,
  ShellEditorBuffer,
  ShellEditorRequest,
  ShellEditorSnapshot,
} from '@cosmosh/api-contract';

import type { ShellEditorExecOptions, ShellEditorResult } from '../ssh/editor-exec.js';
import { buildShellCompletionReplacement, type ShellCompletionDraft } from './completion/snapshot-edits.js';
import {
  isFishInputBoundaryPending,
  normalizeEditorBuffer,
  normalizeNativeHistoryObservation,
} from './editor-protocol.js';
import type { ShellContextState } from './shell-context.js';

/** Explicit transport boundary, allowing state-machine tests without replacing the real editor implementation. */
export type EditorExecutor = (
  request: ShellEditorRequest,
  options: ShellEditorExecOptions,
) => Promise<ShellEditorResult>;
/** Renderer-visible snapshot result; its opaque ID binds the later apply to exact session state. */
export type EditorSnapshotResult = ShellEditorResult & { snapshotId?: string };

/**
 * Owns one session's private editor operation and one expiring snapshot.
 * Text never enters ShellContext, logging, audit storage or remote-shell-event history.
 */
export class ShellEditorController {
  private inFlight: {
    controller: AbortController;
    triggered: boolean;
    epoch: string;
    injected: boolean;
    finished: Promise<void>;
  } | null = null;
  private contextRefresh: Promise<boolean> | null = null;
  private contextRefreshRequested = false;
  private lockedEpoch: string | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private cached: {
    id: string;
    snapshot: ShellEditorSnapshot;
    state: ShellContextState;
    expiresAt: number;
    candidates: Map<string, ShellEditorBuffer>;
  } | null = null;

  /**
   * @param state Current authoritative state reader.
   * @param execute Bounded, authenticated SSH transport boundary.
   * @param write Trigger writer to the original PTY.
   * @param confirm Applies only a verified observation to the exact expected context.
   */
  constructor(
    private readonly state: () => ShellContextState,
    private readonly execute: EditorExecutor,
    private readonly write: (data: string) => void,
    private readonly confirm: (expected: ShellContextState, snapshot: ShellEditorSnapshot | null) => void,
  ) {}

  /**
   * Invalidates data before user input, changed permissions, helper state or teardown.
   * A dispatched but unfinished trigger cannot be safely repeated within the same binding epoch.
   * @returns Nothing.
   */
  invalidate(): void {
    this.clearSnapshot();
    if (this.inFlight) {
      if (this.inFlight.triggered && this.inFlight.injected) this.lockedEpoch = this.inFlight.epoch;
      this.inFlight.controller.abort();
    }
  }

  /** @returns A fresh complete input snapshot, or an explicit unsupported/unavailable result. */
  async snapshot(): Promise<EditorSnapshotResult> {
    const state = this.state();
    const result = await this.run('snapshot', state);
    if (result.status !== 'ok' || this.state() !== state) return result;
    const snapshotId = randomUUID();
    this.clearSnapshot();
    this.cached = {
      id: snapshotId,
      snapshot: result.snapshot,
      state,
      expiresAt: Date.now() + 10_000,
      candidates: new Map(),
    };
    this.expiryTimer = setTimeout(() => this.clearSnapshot(), 10_000);
    this.expiryTimer.unref();
    return { ...result, snapshotId };
  }

  /**
   * Reads only original-Shell native history; input and directory permissions are not borrowed.
   * @param signal Current history permission lifetime. @returns A private history observation or a fixed failure.
   */
  async history(signal: AbortSignal): Promise<ShellEditorResult> {
    while (this.inFlight && !signal.aborted) {
      const finished = this.inFlight.finished;
      await new Promise<void>((resolve) => {
        /** @returns Nothing; releases this waiter and its abort listener exactly once. */
        const complete = (): void => {
          signal.removeEventListener('abort', complete);
          resolve();
        };
        signal.addEventListener('abort', complete, { once: true });
        void finished.then(complete);
      });
    }
    if (signal.aborted) return { status: 'unavailable' };
    return await this.run('history', this.state(), undefined, undefined, signal);
  }

  /**
   * Deletes exact matching text only after the original Fish verifies its namespace and native membership.
   * @param namespace Source captured by a prior native history read. @param command Exact selected record.
   * @param signal Current history permission lifetime.
   * @returns Confirmed absence in the current reader (file persistence unconfirmed), or an explicit failure.
   */
  async deleteHistory(namespace: string, command: string, signal: AbortSignal): Promise<ShellEditorResult> {
    const history = normalizeNativeHistoryObservation({ status: 'ok', namespace, entries: [command] });
    if (!history) return { status: 'unavailable' };
    const state = this.state();
    if (state.promptGeneration === null) return { status: 'unavailable' };
    this.clearSnapshot();
    return await this.run(
      'history-delete',
      state,
      { promptGeneration: state.promptGeneration, editorMode: 'emacs', history },
      undefined,
      signal,
    );
  }

  /**
   * Binds provider edits to this exact snapshot without exposing insertion text or ranges to the renderer.
   * Later sources append within a fixed bound, preserving identifiers already displayed for this snapshot.
   * @param snapshotId Owning private snapshot. @param drafts Backend provider candidates.
   * @returns Display-only copies, or null when the snapshot has expired or changed.
   */
  bindCandidates(snapshotId: string, drafts: readonly ShellCompletionDraft[]): ShellCompletionCandidate[] | null {
    const cached = this.cached;
    if (
      !cached ||
      cached.id !== snapshotId ||
      cached.state !== this.state() ||
      cached.expiresAt <= Date.now() ||
      !cached.snapshot.buffer
    )
      return null;
    const candidates: ShellCompletionCandidate[] = [];
    for (const draft of drafts) {
      if (cached.candidates.size >= 128) break;
      const replacement = buildShellCompletionReplacement(cached.snapshot.buffer, draft.edit);
      if (!replacement) continue;
      const id = randomUUID();
      cached.candidates.set(id, replacement);
      candidates.push({
        id,
        label: draft.label,
        detail: draft.detail,
        source: draft.source,
        kind: draft.kind,
        ...(draft.detailI18nKey ? { detailI18nKey: draft.detailI18nKey } : {}),
      });
    }
    return candidates;
  }

  /**
   * @param snapshotId Original private snapshot. @param candidateId Opaque session-owned candidate.
   * @returns One verified application; identifiers never authorize arbitrary renderer text.
   */
  async applyCandidate(snapshotId: string, candidateId: string): Promise<ShellEditorResult> {
    const replacement = this.cached?.id === snapshotId ? this.cached.candidates.get(candidateId) : undefined;
    if (!replacement) return { status: 'stale' };
    return await this.apply(snapshotId, replacement);
  }

  /** @returns Whether the latest requested context was confirmed after any previous exchange finished cleanup. */
  refreshContext(): Promise<boolean> {
    this.contextRefreshRequested = true;
    if (!this.contextRefresh) {
      const refresh = this.drainContextRefresh();
      this.contextRefresh = refresh;
      void refresh.finally(() => {
        if (this.contextRefresh === refresh) this.contextRefresh = null;
      });
    }
    return this.contextRefresh;
  }

  /** @returns The final coalesced refresh result; waiting never blocks ordinary PTY forwarding. */
  private async drainContextRefresh(): Promise<boolean> {
    let confirmed = false;
    while (this.contextRefreshRequested) {
      // EOF cleanup can take longer than the debounce. Read the newest state only after it completes.
      await this.inFlight?.finished;
      this.contextRefreshRequested = false;
      const state = this.state();
      const result = await this.run('context', state);
      confirmed = result.status === 'ok' && this.state() === state;
      if (result.status === 'ok' && confirmed) this.confirm(state, result.snapshot);
    }
    return confirmed;
  }

  /**
   * @param snapshotId Opaque identifier returned by snapshot().
   * @param replacement Complete data-only buffer with a valid cursor.
   * @returns Confirmed application, rejected stale state, or unknown acknowledgement state.
   */
  async apply(snapshotId: string, replacement: ShellEditorBuffer): Promise<ShellEditorResult> {
    const cached = this.cached;
    this.clearSnapshot();
    if (
      !cached ||
      cached.id !== snapshotId ||
      cached.state !== this.state() ||
      cached.expiresAt <= Date.now() ||
      !normalizeEditorBuffer(replacement)
    )
      return { status: 'stale' };
    const result = await this.run('apply', cached.state, cached.snapshot, replacement);
    if (result.status === 'applied' && this.state() === cached.state) this.confirm(cached.state, null);
    return result;
  }

  /** @returns Nothing; releases private text when consumed, replaced, invalidated or expired. */
  private clearSnapshot(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.cached = null;
  }

  /**
   * @param operation Requested private scope. @param state Immutable context at dispatch.
   * @param expected Original complete observation. @param replacement Optional data-only edit.
   * @param signal Optional source permission lifetime, independent of input permission.
   * @returns One bounded exchange after every permission and identity check.
   */
  private async run(
    operation: ShellEditorRequest['operation'],
    state: ShellContextState,
    expected?: ShellEditorSnapshot,
    replacement?: ShellEditorBuffer,
    signal?: AbortSignal,
  ): Promise<ShellEditorResult> {
    const binding = state.editorBinding;
    const includeHistory = operation === 'history' || operation === 'history-delete';
    const canObservePaused =
      (operation === 'context' || includeHistory) && binding?.notification !== undefined && state.status === 'paused';
    if (
      signal?.aborted ||
      this.inFlight ||
      (state.shell === 'fish' && isFishInputBoundaryPending(state.fishInputBoundary)) ||
      !binding ||
      !state.shellInstanceId ||
      (state.shell !== 'bash' && state.shell !== 'zsh' && state.shell !== 'fish') ||
      state.promptGeneration !== binding.promptGeneration ||
      (state.status !== 'ready' && !canObservePaused) ||
      (state.requiresEditorConfirmation && !canObservePaused) ||
      (includeHistory && (state.shell !== 'fish' || !state.permissions.history)) ||
      ((operation === 'snapshot' || operation === 'apply') && !state.permissions.input) ||
      (operation === 'context' && !state.permissions.input && !state.permissions.cwd) ||
      !state.capabilities.includes(
        includeHistory ? 'history-read' : operation === 'apply' ? 'input-apply' : 'input-snapshot',
      ) ||
      (!binding.notification && this.lockedEpoch === binding.triggerNonce)
    )
      return { status: 'unavailable' };
    let finishOperation = (): void => {};
    const finished = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const active = {
      controller: new AbortController(),
      finished,
      triggered: false,
      epoch: binding.triggerNonce,
      injected: !binding.notification,
    };
    this.inFlight = active;
    /** @returns Nothing; opt-out cancels this read without authorizing any new source. */
    const abort = (): void => active.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      operation,
      promptGeneration: binding.promptGeneration,
      target: { instanceId: state.shellInstanceId, shell: state.shell, pid: binding.pid, startTime: binding.startTime },
      includeDirectory: !includeHistory && state.permissions.cwd,
      ...(binding.notification ? { notification: binding.notification } : {}),
      ...(expected ? { expected } : {}),
      ...(replacement ? { replacement } : {}),
    };
    try {
      const result = await this.execute(request, {
        signal: active.controller.signal,
        isCurrent: () => this.state() === state && !active.controller.signal.aborted,
        trigger: () => {
          if (this.state() !== state || active.controller.signal.aborted) return;
          active.triggered = true;
          if (active.injected) this.write('\x1b[997;' + binding.triggerNonce + '~');
        },
      });
      if (active.injected && active.triggered && (result.status === 'unavailable' || result.status === 'unknown'))
        this.lockedEpoch = active.epoch;
      return (this.state() !== state || active.controller.signal.aborted) && result.status === 'ok'
        ? { status: 'stale' }
        : result;
    } catch {
      // A transport implementation must not turn an optional editor failure into an unhandled rejection.
      if (active.injected && active.triggered) this.lockedEpoch = active.epoch;
      return {
        status:
          (operation === 'apply' || operation === 'history-delete') && active.triggered ? 'unknown' : 'unavailable',
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.inFlight === active) this.inFlight = null;
      finishOperation();
    }
  }
}

/**
 * Promotes context only after an actual editor exchange with the same original Shell and generation.
 * @param state Exact confirmed state. @param snapshot A private observation, or null after a verified edit.
 * @returns Updated text-free context.
 */
export const confirmShellEditorContext = (
  state: ShellContextState,
  snapshot: ShellEditorSnapshot | null,
): ShellContextState => {
  if (snapshot === null) return { ...state, revision: state.revision + 1, inputGeneration: state.inputGeneration + 1 };
  const directory = state.permissions.cwd ? (snapshot.directory ?? null) : null;
  const previous = state.lastKnownCwd;
  const changed =
    directory !== null &&
    (directory.logical !== previous?.logical ||
      directory.physical !== previous.physical ||
      directory.home !== previous.home);
  return {
    ...state,
    revision: state.revision + 1,
    status: 'ready',
    reason: null,
    requiresEditorConfirmation: false,
    pendingDirectory: null,
    cwd: directory,
    lastKnownCwd: directory ?? previous,
    cwdGeneration: state.cwdGeneration + Number(changed),
  };
};
