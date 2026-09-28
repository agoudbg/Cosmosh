import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Stable task failure used when the queue wait and runner exceed one shared deadline.
 */
export const SFTP_TASK_DEADLINE_EXCEEDED_CODE = 'SFTP_TASK_DEADLINE_EXCEEDED' as const;

/**
 * Stable fallback failure used when a runner throws an unmapped value.
 */
export const SFTP_TASK_FAILED_CODE = 'SFTP_OPERATION_FAILED' as const;

/**
 * Public lifecycle states retained for one scheduled SFTP task.
 */
export type SftpTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Describes whether a task can change remote state or owns session lifecycle.
 */
export type SftpTaskImpact = 'read' | 'mutation' | 'lifecycle';

/**
 * Separates bounded metadata work from transfer or recursive work.
 */
export type SftpTaskWorkload = 'light' | 'heavy';

/**
 * Resources consumed by one task while its runner still owns remote work.
 */
export type SftpTaskResources = {
  /** Whether timeout can leave a remote side effect with an unknown outcome. */
  impact: SftpTaskImpact;
  /** Whether the task consumes one heavy-operation slot. */
  workload: SftpTaskWorkload;
  /** Whether the task must run without any sibling task. */
  exclusive: boolean;
};

/**
 * Machine-readable failure retained by a failed task.
 */
export type SftpTaskFailure = {
  /** Stable backend or API error code. */
  code: string;
  /** Sanitized user-facing failure summary. */
  message: string;
  /** Whether a running mutation may have reached the remote host. */
  outcomeUnknown?: boolean;
};

/**
 * Explicit result returned by a task runner.
 *
 * A failed outcome may retain a structured result, such as a batch summary
 * containing entries that completed before a later entry failed.
 */
export type SftpTaskRunOutcome<TResult> =
  | {
      state: 'succeeded';
      result: TResult;
    }
  | {
      state: 'failed';
      failure: SftpTaskFailure;
      result?: TResult;
    }
  | {
      state: 'cancelled';
      result?: TResult;
    };

/**
 * Context shared with one task runner after admission.
 */
export type SftpTaskContext<TPartial> = {
  /** Signal fired by lifecycle cancellation or the absolute deadline. */
  signal: AbortSignal;
  /** Fixed wall-clock deadline that includes queue wait. */
  deadlineAt: number;
  /** Returns the remaining task budget without extending it. */
  remainingMs: () => number;
  /** Retains the latest structured partial result for failure or cancellation. */
  reportPartial: (partial: TPartial) => void;
};

/**
 * Inputs required to enqueue one SFTP task.
 */
export type SftpTaskSpec<TResult, TPartial = never> = {
  /** Optional caller-owned identifier, used when one API operation already has an id. */
  taskId?: string;
  /** Stable diagnostic operation name that must not contain user-controlled paths. */
  operation: string;
  /** Capacity and safety profile used by admission and timeout handling. */
  resources: SftpTaskResources;
  /** Remote paths claimed by the task for its complete lifecycle. */
  claims: readonly string[];
  /** Maximum wall-clock duration including queue wait. */
  absoluteTimeoutMs: number;
  /** Optional caller-owned cancellation signal. */
  cancellationSignal?: AbortSignal;
  /** Performs the admitted work and returns an explicit terminal outcome. */
  run: (context: SftpTaskContext<TPartial>) => Promise<SftpTaskRunOutcome<TResult>>;
  /** Maps unexpected runner failures into sanitized task failures. */
  mapFailure?: (error: unknown) => SftpTaskFailure;
  /** Starts task-specific cancellation or teardown after running work is aborted. */
  onAbort?: (reason: 'cancelled' | 'deadline') => void | Promise<void>;
};

/**
 * Immutable top-level snapshot returned to task consumers.
 */
export type SftpTaskSnapshot<TResult = unknown, TPartial = unknown> = {
  taskId: string;
  sessionId: string;
  operation: string;
  state: SftpTaskState;
  resources: SftpTaskResources;
  claims: readonly string[];
  createdAt: number;
  deadlineAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequested: boolean;
  result?: TResult;
  partialResult?: TPartial;
  failure?: SftpTaskFailure;
};

/**
 * Typed handle returned to the submitter of one task.
 */
export type SftpScheduledTask<TResult, TPartial = never> = {
  taskId: string;
  /** Returns the task's latest top-level snapshot. */
  getSnapshot: () => SftpTaskSnapshot<TResult, TPartial>;
  /** Resolves once when the public task state becomes terminal. */
  completion: Promise<SftpTaskSnapshot<TResult, TPartial>>;
  /** Resolves after the runner has released its capacity and path claims. */
  released: Promise<void>;
};

/**
 * Per-session scheduler limits.
 */
export type SftpTaskSchedulerLimits = {
  /** Maximum number of concurrently owned task slots. */
  total: number;
  /** Maximum number of concurrently owned heavy task slots. */
  heavy: number;
  /** Maximum number of concurrently owned mutation task slots. */
  mutation: number;
};

/**
 * Injectable clock used to keep deadline tests deterministic.
 */
export type SftpTaskSchedulerClock = {
  /** Returns current wall-clock milliseconds. */
  now: () => number;
  /** Arms one deadline callback. */
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  /** Clears one previously armed deadline callback. */
  clearTimeout: (timer: unknown) => void;
};

/**
 * Construction options for one session-scoped scheduler.
 */
export type SftpTaskSchedulerOptions = {
  /** Session that owns all tasks admitted by this scheduler. */
  sessionId: string;
  /** Optional limit override used by focused tests and future configuration. */
  limits?: Partial<SftpTaskSchedulerLimits>;
  /** Optional deterministic clock. */
  clock?: SftpTaskSchedulerClock;
  /** Optional deterministic task id factory. */
  idFactory?: () => string;
};

type StoredTaskSpec = {
  operation: string;
  resources: SftpTaskResources;
  absoluteTimeoutMs: number;
  cancellationSignal?: AbortSignal;
  run: (context: SftpTaskContext<unknown>) => Promise<SftpTaskRunOutcome<unknown>>;
  mapFailure?: (error: unknown) => SftpTaskFailure;
  onAbort?: (reason: 'cancelled' | 'deadline') => void | Promise<void>;
};

type StoredTaskRecord = {
  sequence: number;
  spec: StoredTaskSpec;
  snapshot: SftpTaskSnapshot;
  controller: AbortController;
  deadlineTimer?: unknown;
  cancellationListener?: () => void;
  abortHookInvoked: boolean;
  completionResolved: boolean;
  resolveCompletion: (snapshot: SftpTaskSnapshot) => void;
  releaseResolved: boolean;
  resolveReleased: () => void;
};

const POSIX_PATH = path.posix;

const DEFAULT_LIMITS: SftpTaskSchedulerLimits = {
  total: 3,
  heavy: 2,
  mutation: 1,
};

const DEFAULT_CLOCK: SftpTaskSchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/**
 * Error placed on a task's abort signal after its shared deadline expires.
 */
export class SftpTaskDeadlineExceededError extends Error {
  public readonly code = SFTP_TASK_DEADLINE_EXCEEDED_CODE;

  /** Creates the stable internal deadline sentinel. */
  public constructor() {
    super('The SFTP task did not complete before its absolute deadline.');
    this.name = 'SftpTaskDeadlineExceededError';
  }
}

/**
 * Error placed on a task's abort signal during session lifecycle cancellation.
 */
export class SftpTaskCancelledError extends Error {
  /** Creates the stable internal cancellation sentinel. */
  public constructor() {
    super('The SFTP task was cancelled.');
    this.name = 'SftpTaskCancelledError';
  }
}

/**
 * Converts one remote path into a conservative canonical scheduler claim.
 *
 * Relative paths cannot be resolved safely without remote I/O before admission,
 * so they claim the remote root instead of creating an unsafe parallel alias.
 *
 * @param input Raw remote path.
 * @returns Canonical absolute POSIX path or the conservative root claim.
 */
export const normalizeSftpTaskClaimPath = (input: string): string => {
  // Dot-parent paths may cross a symlink into another tree; serialize them until remote resolution.
  if (!input.startsWith('/') || input.split('/').includes('..')) {
    return '/';
  }
  const normalized = POSIX_PATH.normalize(input);

  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

/**
 * Returns whether two canonical claims are equal or have an ancestor relationship.
 *
 * @param left First canonical claim.
 * @param right Second canonical claim.
 * @returns Whether the claims must be serialized.
 */
export const doSftpTaskClaimsConflict = (left: string, right: string): boolean => {
  if (left === right || left === '/' || right === '/') {
    return true;
  }

  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
};

/**
 * Normalizes, deduplicates, and minimizes one task's remote path claims.
 *
 * @param claims Raw remote path claims.
 * @returns Canonical claims with descendants covered by an ancestor removed.
 */
export const normalizeSftpTaskClaims = (claims: readonly string[]): string[] => {
  const normalizedClaims = [...new Set(claims.map(normalizeSftpTaskClaimPath))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const minimalClaims: string[] = [];

  for (const claim of normalizedClaims) {
    if (minimalClaims.some((existing) => doSftpTaskClaimsConflict(existing, claim))) {
      continue;
    }
    minimalClaims.push(claim);
  }

  return minimalClaims;
};

/**
 * Owns capacity, path admission, deadlines, and retained task state for one SFTP session.
 */
export class SftpTaskScheduler {
  private readonly sessionId: string;

  private readonly limits: SftpTaskSchedulerLimits;

  private readonly clock: SftpTaskSchedulerClock;

  private readonly idFactory: () => string;

  private readonly records = new Map<string, StoredTaskRecord>();

  private readonly queue: StoredTaskRecord[] = [];

  private readonly active = new Map<string, StoredTaskRecord>();

  private readonly idleWaiters = new Set<() => void>();

  private sequence = 0;

  private isDispatching = false;

  /**
   * Creates one scheduler with independent per-session limits.
   *
   * @param options Session identity, optional limits, and deterministic test seams.
   */
  public constructor(options: SftpTaskSchedulerOptions) {
    if (!options.sessionId.trim()) {
      throw new RangeError('SFTP task scheduler session id must not be empty.');
    }

    this.sessionId = options.sessionId;
    this.limits = validateLimits({
      ...DEFAULT_LIMITS,
      ...options.limits,
    });
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Enqueues one task and starts every currently eligible task synchronously.
   *
   * @template TResult Structured terminal result type.
   * @template TPartial Structured in-progress result type.
   * @param spec Task operation, resource profile, claims, and runner.
   * @returns Typed handle for snapshots and terminal completion.
   */
  public schedule<TResult, TPartial = never>(
    spec: SftpTaskSpec<TResult, TPartial>,
  ): SftpScheduledTask<TResult, TPartial> {
    validateTaskSpec(spec);
    const taskId = spec.taskId ?? this.idFactory();
    if (this.records.has(taskId)) {
      throw new Error(`SFTP task id is already registered: ${taskId}`);
    }

    const createdAt = this.clock.now();
    let resolveTypedCompletion: (snapshot: SftpTaskSnapshot<TResult, TPartial>) => void = () => undefined;
    const completion = new Promise<SftpTaskSnapshot<TResult, TPartial>>((resolve) => {
      resolveTypedCompletion = resolve;
    });
    let resolveTypedReleased: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      resolveTypedReleased = resolve;
    });
    const record: StoredTaskRecord = {
      sequence: this.sequence,
      spec: {
        operation: spec.operation,
        resources: { ...spec.resources },
        absoluteTimeoutMs: spec.absoluteTimeoutMs,
        cancellationSignal: spec.cancellationSignal,
        run: async (context) => await spec.run(context as SftpTaskContext<TPartial>),
        mapFailure: spec.mapFailure,
        onAbort: spec.onAbort,
      },
      snapshot: {
        taskId,
        sessionId: this.sessionId,
        operation: spec.operation,
        state: 'queued',
        resources: { ...spec.resources },
        claims: normalizeSftpTaskClaims(spec.claims),
        createdAt,
        deadlineAt: createdAt + spec.absoluteTimeoutMs,
        cancelRequested: false,
      },
      controller: new AbortController(),
      abortHookInvoked: false,
      completionResolved: false,
      resolveCompletion: (snapshot) => {
        resolveTypedCompletion(snapshot as SftpTaskSnapshot<TResult, TPartial>);
      },
      releaseResolved: false,
      resolveReleased: resolveTypedReleased,
    };
    this.sequence += 1;
    this.records.set(taskId, record);
    this.queue.push(record);
    this.armDeadline(record);
    this.observeCancellation(record);

    if (spec.cancellationSignal?.aborted) {
      this.cancelRecord(record);
    }
    this.dispatch();

    return {
      taskId,
      getSnapshot: () => copySnapshot(record.snapshot) as SftpTaskSnapshot<TResult, TPartial>,
      completion,
      released,
    };
  }

  /**
   * Returns one retained task snapshot.
   *
   * @param taskId Retained task identifier.
   * @returns Top-level snapshot or null when unknown.
   */
  public getTask(taskId: string): SftpTaskSnapshot | null {
    const record = this.records.get(taskId);
    return record ? copySnapshot(record.snapshot) : null;
  }

  /**
   * Lists retained tasks in creation order.
   *
   * @returns Top-level task snapshots.
   */
  public listTasks(): SftpTaskSnapshot[] {
    return [...this.records.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => copySnapshot(record.snapshot));
  }

  /**
   * Removes one settled task from scheduler-owned history.
   *
   * Public consumers may retain their own immutable snapshot handle. Active runners cannot be
   * forgotten because their claims and capacity remain authoritative until they actually settle.
   *
   * @param taskId Terminal task identifier.
   * @returns Whether the scheduler removed the task.
   */
  public forgetTask(taskId: string): boolean {
    const record = this.records.get(taskId);
    if (!record || !isTerminalState(record.snapshot.state) || this.active.has(taskId)) {
      return false;
    }

    return this.records.delete(taskId);
  }

  /**
   * Cancels every queued task and requests cancellation of every running task.
   *
   * Running slots and claims remain owned until their runners settle, which
   * prevents late remote work from overlapping a later lifecycle operation.
   *
   * @returns void.
   */
  public cancelAll(): void {
    for (const record of [...this.queue]) {
      this.cancelRecord(record);
    }
    for (const record of this.active.values()) {
      this.cancelRecord(record);
    }

    this.dispatch();
    this.resolveIdleWaiters();
  }

  /**
   * Waits until no queued task or unsettled runner remains.
   *
   * Session close should stop new admission, call `cancelAll()`, and then await
   * this boundary before tearing down lifecycle resources.
   *
   * @returns Promise resolved at the next fully idle boundary.
   */
  public waitForIdle(): Promise<void> {
    if (this.queue.length === 0 && this.active.size === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  /**
   * Arms the one timer shared by queue wait and running work.
   *
   * @param record Task whose absolute deadline should be enforced.
   * @returns void.
   */
  private armDeadline(record: StoredTaskRecord): void {
    const delayMs = Math.max(0, record.snapshot.deadlineAt - this.clock.now());
    record.deadlineTimer = this.clock.setTimeout(() => {
      this.handleDeadline(record);
    }, delayMs);
  }

  /**
   * Links a caller-owned cancellation signal without exposing per-task queue mutation.
   *
   * @param record Task that may receive external cancellation.
   * @returns void.
   */
  private observeCancellation(record: StoredTaskRecord): void {
    const signal = record.spec.cancellationSignal;
    if (!signal) {
      return;
    }

    const listener = (): void => {
      this.cancelRecord(record);
      this.dispatch();
      this.resolveIdleWaiters();
    };
    record.cancellationListener = listener;
    signal.addEventListener('abort', listener, { once: true });
  }

  /**
   * Selects and starts eligible tasks until no additional task can run.
   *
   * @returns void.
   */
  private dispatch(): void {
    if (this.isDispatching) {
      return;
    }

    this.isDispatching = true;
    try {
      while (true) {
        const nextIndex = this.findNextRunnableIndex();
        if (nextIndex < 0) {
          break;
        }

        const [record] = this.queue.splice(nextIndex, 1);
        if (!record) {
          break;
        }
        this.startRecord(record);
      }
    } finally {
      this.isDispatching = false;
      this.resolveIdleWaiters();
    }
  }

  /**
   * Finds one runnable task while preserving path and exclusive fairness.
   *
   * The earliest exclusive task is a barrier: younger arrivals never pass it.
   * Before that barrier, unrelated work may bypass an older blocked task, while
   * overlapping claims stay reserved for the older task.
   *
   * @returns Queue index of the next runnable task, or -1.
   */
  private findNextRunnableIndex(): number {
    const exclusiveIndex = this.queue.findIndex((record) => record.spec.resources.exclusive);
    const scanLength = exclusiveIndex < 0 ? this.queue.length : exclusiveIndex + 1;

    for (let index = 0; index < scanLength; index += 1) {
      const record = this.queue[index];
      if (!record) {
        continue;
      }

      if (record.spec.resources.exclusive) {
        return index === 0 && this.active.size === 0 ? index : -1;
      }
      if (!this.hasCapacityFor(record) || this.conflictsWithActive(record)) {
        continue;
      }
      if (this.conflictsWithOlderQueuedClaim(record, index)) {
        continue;
      }
      return index;
    }

    return -1;
  }

  /**
   * Checks total, heavy, and mutation capacity against unsettled runners.
   *
   * @param candidate Queued task being considered.
   * @returns Whether all required capacity is available.
   */
  private hasCapacityFor(candidate: StoredTaskRecord): boolean {
    if ([...this.active.values()].some((record) => record.spec.resources.exclusive)) {
      return false;
    }
    if (this.active.size >= this.limits.total) {
      return false;
    }

    const activeRecords = [...this.active.values()];
    const heavyCount = activeRecords.filter((record) => record.spec.resources.workload === 'heavy').length;
    if (candidate.spec.resources.workload === 'heavy' && heavyCount >= this.limits.heavy) {
      return false;
    }

    const mutationCount = activeRecords.filter((record) => record.spec.resources.impact === 'mutation').length;
    return candidate.spec.resources.impact !== 'mutation' || mutationCount < this.limits.mutation;
  }

  /**
   * Checks a queued task against every claim still owned by a runner.
   *
   * @param candidate Queued task being considered.
   * @returns Whether any active task has an overlapping claim.
   */
  private conflictsWithActive(candidate: StoredTaskRecord): boolean {
    return [...this.active.values()].some((activeRecord) =>
      doClaimSetsConflict(candidate.snapshot.claims, activeRecord.snapshot.claims),
    );
  }

  /**
   * Prevents a younger task from overtaking an older task on the same path tree.
   *
   * @param candidate Queued task being considered.
   * @param candidateIndex Current queue position.
   * @returns Whether an older queued claim reserves the same path tree.
   */
  private conflictsWithOlderQueuedClaim(candidate: StoredTaskRecord, candidateIndex: number): boolean {
    for (let index = 0; index < candidateIndex; index += 1) {
      const older = this.queue[index];
      if (older && doClaimSetsConflict(candidate.snapshot.claims, older.snapshot.claims)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Moves one admitted record to running and invokes its runner in a microtask.
   *
   * @param record Admitted task.
   * @returns void.
   */
  private startRecord(record: StoredTaskRecord): void {
    record.snapshot = {
      ...record.snapshot,
      state: 'running',
      startedAt: this.clock.now(),
    };
    this.active.set(record.snapshot.taskId, record);

    void Promise.resolve()
      .then(async () => {
        if (record.snapshot.state !== 'running') {
          return;
        }

        const outcome = await record.spec.run({
          signal: record.controller.signal,
          deadlineAt: record.snapshot.deadlineAt,
          remainingMs: () => Math.max(0, record.snapshot.deadlineAt - this.clock.now()),
          reportPartial: (partial) => {
            if (record.snapshot.state !== 'running') {
              return;
            }
            record.snapshot = {
              ...record.snapshot,
              partialResult: partial,
            };
          },
        });
        this.applyRunOutcome(record, outcome);
      })
      .catch((error: unknown) => {
        this.applyUnexpectedFailure(record, error);
      })
      .finally(() => {
        this.releaseRecord(record);
      });
  }

  /**
   * Applies an explicit runner outcome unless an earlier deadline or cancellation won.
   *
   * @param record Running task.
   * @param outcome Explicit runner outcome.
   * @returns void.
   */
  private applyRunOutcome(record: StoredTaskRecord, outcome: SftpTaskRunOutcome<unknown>): void {
    if (record.snapshot.state !== 'running') {
      return;
    }

    if (outcome.state === 'succeeded') {
      this.finishRecord(record, {
        state: 'succeeded',
        result: outcome.result,
      });
      return;
    }
    if (outcome.state === 'failed') {
      this.finishRecord(record, {
        state: 'failed',
        failure: copyFailure(outcome.failure),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      });
      return;
    }

    this.finishRecord(record, {
      state: 'cancelled',
      cancelRequested: true,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    });
  }

  /**
   * Maps an unexpected runner rejection into a failed task.
   *
   * @param record Running task.
   * @param error Unknown runner rejection.
   * @returns void.
   */
  private applyUnexpectedFailure(record: StoredTaskRecord, error: unknown): void {
    if (record.snapshot.state !== 'running') {
      return;
    }

    let failure: SftpTaskFailure;
    try {
      failure = record.spec.mapFailure?.(error) ?? {
        code: SFTP_TASK_FAILED_CODE,
        message: 'The SFTP task failed.',
      };
    } catch {
      failure = {
        code: SFTP_TASK_FAILED_CODE,
        message: 'The SFTP task failed.',
      };
    }

    this.finishRecord(record, {
      state: 'failed',
      failure: copyFailure(failure),
    });
  }

  /**
   * Selects the deadline terminal state without releasing a late runner's resources.
   *
   * @param record Task whose shared deadline expired.
   * @returns void.
   */
  private handleDeadline(record: StoredTaskRecord): void {
    if (isTerminalState(record.snapshot.state)) {
      return;
    }

    const wasRunning = record.snapshot.state === 'running';
    if (!wasRunning) {
      this.removeQueuedRecord(record);
    } else {
      record.controller.abort(new SftpTaskDeadlineExceededError());
      this.invokeAbortHook(record, 'deadline');
    }

    this.finishRecord(record, {
      state: 'failed',
      failure: {
        code: SFTP_TASK_DEADLINE_EXCEEDED_CODE,
        message: 'The SFTP task did not complete before its absolute deadline.',
        ...(wasRunning && record.spec.resources.impact === 'mutation' ? { outcomeUnknown: true } : {}),
      },
    });

    if (!wasRunning) {
      this.dispatch();
    }
    this.resolveIdleWaiters();
  }

  /**
   * Selects cancellation for a queued task or an active runner.
   *
   * @param record Task receiving lifecycle cancellation.
   * @returns void.
   */
  private cancelRecord(record: StoredTaskRecord): void {
    if (isTerminalState(record.snapshot.state)) {
      return;
    }

    const wasRunning = record.snapshot.state === 'running';
    if (!wasRunning) {
      this.removeQueuedRecord(record);
    } else {
      record.controller.abort(new SftpTaskCancelledError());
      this.invokeAbortHook(record, 'cancelled');
    }

    if (wasRunning && record.spec.resources.impact === 'mutation') {
      this.finishRecord(record, {
        state: 'failed',
        failure: {
          code: SFTP_TASK_FAILED_CODE,
          message: 'The SFTP task was cancelled after remote work started.',
          outcomeUnknown: true,
        },
      });
      return;
    }

    this.finishRecord(record, {
      state: 'cancelled',
      cancelRequested: true,
    });
  }

  /**
   * Invokes task-specific teardown once without replacing the selected task outcome.
   *
   * @param record Running task being aborted.
   * @param reason Abort boundary selected by the scheduler.
   * @returns void.
   */
  private invokeAbortHook(record: StoredTaskRecord, reason: 'cancelled' | 'deadline'): void {
    if (record.abortHookInvoked || !record.spec.onAbort) {
      return;
    }

    record.abortHookInvoked = true;
    try {
      void Promise.resolve(record.spec.onAbort(reason)).catch((error: unknown) => {
        console.warn('[sftp:task-scheduler] Task abort hook failed.', error);
      });
    } catch (error: unknown) {
      console.warn('[sftp:task-scheduler] Task abort hook failed.', error);
    }
  }

  /**
   * Applies one public terminal state and resolves completion exactly once.
   *
   * @param record Task selecting its terminal result.
   * @param patch Terminal snapshot fields.
   * @returns void.
   */
  private finishRecord(
    record: StoredTaskRecord,
    patch:
      | { state: 'succeeded'; result: unknown }
      | { state: 'failed'; failure: SftpTaskFailure; result?: unknown }
      | { state: 'cancelled'; cancelRequested: true; result?: unknown },
  ): void {
    if (isTerminalState(record.snapshot.state)) {
      return;
    }

    this.cleanupLifecycle(record);
    record.snapshot = {
      ...record.snapshot,
      ...patch,
      finishedAt: this.clock.now(),
    };
    if (!record.completionResolved) {
      record.completionResolved = true;
      record.resolveCompletion(copySnapshot(record.snapshot));
    }
    this.clearExecutionReferences(record);
    if (!this.active.has(record.snapshot.taskId)) {
      this.resolveReleased(record);
    }
  }

  /**
   * Releases capacity only after the runner promise has actually settled.
   *
   * @param record Runner that no longer owns remote work.
   * @returns void.
   */
  private releaseRecord(record: StoredTaskRecord): void {
    if (this.active.get(record.snapshot.taskId) !== record) {
      return;
    }

    this.active.delete(record.snapshot.taskId);
    this.resolveReleased(record);
    this.dispatch();
    this.resolveIdleWaiters();
  }

  /**
   * Resolves the ownership boundary exactly once.
   *
   * @param record Task that no longer consumes capacity or claims.
   * @returns void.
   */
  private resolveReleased(record: StoredTaskRecord): void {
    if (record.releaseResolved) {
      return;
    }

    record.releaseResolved = true;
    record.resolveReleased();
  }

  /**
   * Releases request, runner, and session closures after public settlement.
   *
   * A timed-out runner can still retain its own active stack until settlement, but the retained
   * task record no longer adds another reference to those potentially large objects.
   *
   * @param record Terminal task whose executable callbacks are no longer needed.
   * @returns void.
   */
  private clearExecutionReferences(record: StoredTaskRecord): void {
    record.spec = {
      operation: record.spec.operation,
      resources: record.spec.resources,
      absoluteTimeoutMs: record.spec.absoluteTimeoutMs,
      run: async () => ({
        state: 'cancelled',
      }),
    };
  }

  /**
   * Removes one queued record without affecting unrelated queue order.
   *
   * @param record Queued task reaching a terminal state.
   * @returns void.
   */
  private removeQueuedRecord(record: StoredTaskRecord): void {
    const index = this.queue.indexOf(record);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * Clears the deadline and external cancellation listener after public settlement.
   *
   * @param record Terminal task.
   * @returns void.
   */
  private cleanupLifecycle(record: StoredTaskRecord): void {
    if (record.deadlineTimer !== undefined) {
      this.clock.clearTimeout(record.deadlineTimer);
      record.deadlineTimer = undefined;
    }
    if (record.cancellationListener && record.spec.cancellationSignal) {
      record.spec.cancellationSignal.removeEventListener('abort', record.cancellationListener);
      record.cancellationListener = undefined;
    }
  }

  /**
   * Resolves registered idle waiters after queue and active ownership drain.
   *
   * @returns void.
   */
  private resolveIdleWaiters(): void {
    if (this.queue.length > 0 || this.active.size > 0) {
      return;
    }

    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

/**
 * Returns whether one public state is terminal.
 *
 * @param state Task lifecycle state.
 * @returns Whether no later public transition is allowed.
 */
const isTerminalState = (state: SftpTaskState): boolean => {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
};

/**
 * Returns whether any path in two claim sets overlaps.
 *
 * @param left First canonical claim set.
 * @param right Second canonical claim set.
 * @returns Whether the tasks must be serialized.
 */
const doClaimSetsConflict = (left: readonly string[], right: readonly string[]): boolean => {
  return left.some((leftClaim) => right.some((rightClaim) => doSftpTaskClaimsConflict(leftClaim, rightClaim)));
};

/**
 * Copies one failure so callers cannot replace retained top-level fields.
 *
 * @param failure Stored task failure.
 * @returns Failure copy.
 */
const copyFailure = (failure: SftpTaskFailure): SftpTaskFailure => {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.outcomeUnknown ? { outcomeUnknown: true } : {}),
  };
};

/**
 * Copies top-level snapshot collections and failure metadata.
 *
 * @param snapshot Stored task snapshot.
 * @returns Top-level immutable snapshot copy.
 */
const copySnapshot = <TResult, TPartial>(
  snapshot: SftpTaskSnapshot<TResult, TPartial>,
): SftpTaskSnapshot<TResult, TPartial> => {
  return {
    ...snapshot,
    resources: { ...snapshot.resources },
    claims: [...snapshot.claims],
    ...(snapshot.failure ? { failure: copyFailure(snapshot.failure) } : {}),
  };
};

/**
 * Validates one scheduler's capacity configuration.
 *
 * @param limits Candidate limits.
 * @returns Validated immutable limit values.
 */
const validateLimits = (limits: SftpTaskSchedulerLimits): SftpTaskSchedulerLimits => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`SFTP task scheduler ${name} limit must be a positive integer.`);
    }
  }
  if (limits.heavy > limits.total || limits.mutation > limits.total) {
    throw new RangeError('SFTP task scheduler specialized limits cannot exceed the total limit.');
  }

  return { ...limits };
};

/**
 * Validates task inputs before they can reserve queue position or timers.
 *
 * @param spec Candidate task specification.
 * @returns void.
 */
const validateTaskSpec = <TResult, TPartial>(spec: SftpTaskSpec<TResult, TPartial>): void => {
  if (!spec.operation.trim()) {
    throw new RangeError('SFTP task operation must not be empty.');
  }
  if (!Number.isFinite(spec.absoluteTimeoutMs) || spec.absoluteTimeoutMs <= 0) {
    throw new RangeError('SFTP task absolute timeout must be a positive finite number.');
  }
};
