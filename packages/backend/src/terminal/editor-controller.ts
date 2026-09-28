import { randomUUID } from 'node:crypto';

import type { ShellEditorBuffer, ShellEditorRequest, ShellEditorSnapshot } from '@cosmosh/api-contract';

import type { ShellEditorExecOptions, ShellEditorResult } from '../ssh/editor-exec.js';
import { normalizeEditorBuffer } from './editor-protocol.js';
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
  private inFlight: { controller: AbortController; triggered: boolean; epoch: string } | null = null;
  private lockedEpoch: string | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private cached: { id: string; snapshot: ShellEditorSnapshot; state: ShellContextState; expiresAt: number } | null =
    null;

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
      if (this.inFlight.triggered) this.lockedEpoch = this.inFlight.epoch;
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
    this.cached = { id: snapshotId, snapshot: result.snapshot, state, expiresAt: Date.now() + 10_000 };
    this.expiryTimer = setTimeout(() => this.clearSnapshot(), 10_000);
    this.expiryTimer.unref();
    return { ...result, snapshotId };
  }

  /** @returns Whether an already usable editor supplied fresh context without transferring input. */
  async refreshContext(): Promise<boolean> {
    const state = this.state();
    const result = await this.run('context', state);
    if (result.status !== 'ok' || this.state() !== state) return false;
    this.confirm(state, result.snapshot);
    return true;
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
   * @returns One bounded exchange after every permission and identity check.
   */
  private async run(
    operation: ShellEditorRequest['operation'],
    state: ShellContextState,
    expected?: ShellEditorSnapshot,
    replacement?: ShellEditorBuffer,
  ): Promise<ShellEditorResult> {
    const binding = state.editorBinding;
    if (
      this.inFlight ||
      !binding ||
      !state.shellInstanceId ||
      (state.shell !== 'bash' && state.shell !== 'zsh' && state.shell !== 'fish') ||
      state.promptGeneration !== binding.promptGeneration ||
      state.status !== 'ready' ||
      state.requiresEditorConfirmation ||
      (operation !== 'context' && !state.permissions.input) ||
      (operation === 'context' && !state.permissions.input && !state.permissions.cwd) ||
      !state.capabilities.includes(operation === 'apply' ? 'input-apply' : 'input-snapshot') ||
      this.lockedEpoch === binding.triggerNonce
    )
      return { status: 'unavailable' };
    const active = { controller: new AbortController(), triggered: false, epoch: binding.triggerNonce };
    this.inFlight = active;
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      operation,
      promptGeneration: binding.promptGeneration,
      target: { instanceId: state.shellInstanceId, shell: state.shell, pid: binding.pid, startTime: binding.startTime },
      includeDirectory: state.permissions.cwd,
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
          this.write('\x1b[997;' + binding.triggerNonce + '~');
        },
      });
      if (active.triggered && (result.status === 'unavailable' || result.status === 'unknown'))
        this.lockedEpoch = active.epoch;
      return this.state() !== state && result.status === 'ok' ? { status: 'stale' } : result;
    } catch {
      // A transport implementation must not turn an optional editor failure into an unhandled rejection.
      if (active.triggered) this.lockedEpoch = active.epoch;
      return { status: operation === 'apply' && active.triggered ? 'unknown' : 'unavailable' };
    } finally {
      if (this.inFlight === active) this.inFlight = null;
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
