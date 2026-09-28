import assert from 'node:assert/strict';
import test from 'node:test';

import {
  doSftpTaskClaimsConflict,
  normalizeSftpTaskClaimPath,
  normalizeSftpTaskClaims,
  SFTP_TASK_DEADLINE_EXCEEDED_CODE,
  type SftpTaskResources,
  type SftpTaskRunOutcome,
  SftpTaskScheduler,
  type SftpTaskSchedulerClock,
} from './task-scheduler.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type FakeTimer = {
  id: number;
  dueAt: number;
  callback: () => void;
  cleared: boolean;
};

const READ_LIGHT: SftpTaskResources = {
  impact: 'read',
  workload: 'light',
  exclusive: false,
};

const READ_HEAVY: SftpTaskResources = {
  impact: 'read',
  workload: 'heavy',
  exclusive: false,
};

const MUTATION_LIGHT: SftpTaskResources = {
  impact: 'mutation',
  workload: 'light',
  exclusive: false,
};

const EXCLUSIVE_LIFECYCLE: SftpTaskResources = {
  impact: 'lifecycle',
  workload: 'light',
  exclusive: true,
};

/**
 * Creates a promise whose settlement is controlled by the test.
 *
 * @template T Deferred value type.
 * @returns Deferred promise controls.
 */
const createDeferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
};

/**
 * Flushes scheduler runner and settlement work without using wall-clock delays.
 *
 * @returns Promise resolved after the current event-loop turn settles.
 */
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

/**
 * Deterministic wall clock used to exercise queue and runner deadlines.
 */
class FakeClock implements SftpTaskSchedulerClock {
  private currentTime = 0;

  private nextTimerId = 1;

  private readonly timers = new Map<number, FakeTimer>();

  /**
   * Returns the current fake wall-clock time.
   *
   * @returns Current fake milliseconds.
   */
  public now = (): number => this.currentTime;

  /**
   * Registers a deterministic timer.
   *
   * @param callback Callback invoked once its due time is reached.
   * @param delayMs Relative delay in milliseconds.
   * @returns Opaque fake timer handle.
   */
  public setTimeout = (callback: () => void, delayMs: number): unknown => {
    const timer: FakeTimer = {
      id: this.nextTimerId,
      dueAt: this.currentTime + Math.max(0, delayMs),
      callback,
      cleared: false,
    };
    this.nextTimerId += 1;
    this.timers.set(timer.id, timer);
    return timer;
  };

  /**
   * Marks a deterministic timer as cleared.
   *
   * @param handle Opaque fake timer handle.
   * @returns void.
   */
  public clearTimeout = (handle: unknown): void => {
    if (isFakeTimer(handle)) {
      handle.cleared = true;
      this.timers.delete(handle.id);
    }
  };

  /**
   * Advances fake time and runs every timer due at or before the target.
   *
   * @param elapsedMs Non-negative elapsed milliseconds.
   * @returns void.
   */
  public advanceBy(elapsedMs: number): void {
    if (elapsedMs < 0) {
      throw new RangeError('Fake clock cannot move backwards.');
    }

    const targetTime = this.currentTime + elapsedMs;
    while (true) {
      const dueTimer = [...this.timers.values()]
        .filter((timer) => !timer.cleared && timer.dueAt <= targetTime)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!dueTimer) {
        break;
      }

      this.currentTime = dueTimer.dueAt;
      this.timers.delete(dueTimer.id);
      if (!dueTimer.cleared) {
        dueTimer.callback();
      }
    }
    this.currentTime = targetTime;
  }
}

/**
 * Narrows an opaque clock handle to the deterministic timer shape.
 *
 * @param value Opaque timer handle.
 * @returns Whether the value is a fake timer.
 */
const isFakeTimer = (value: unknown): value is FakeTimer => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'cleared' in value &&
    typeof value.cleared === 'boolean'
  );
};

/**
 * Creates a predictable scheduler whose generated ids are sequential.
 *
 * @param clock Deterministic test clock.
 * @param limits Optional capacity overrides.
 * @returns Scheduler under test.
 */
const createScheduler = (
  clock: FakeClock = new FakeClock(),
  limits?: { total?: number; heavy?: number; mutation?: number },
): SftpTaskScheduler => {
  let nextTaskId = 1;
  return new SftpTaskScheduler({
    sessionId: 'session-1',
    clock,
    limits,
    idFactory: () => `task-${nextTaskId++}`,
  });
};

/**
 * Creates a successful runner outcome.
 *
 * @param value Structured result.
 * @returns Successful runner outcome.
 */
const succeed = <T>(value: T): SftpTaskRunOutcome<T> => ({
  state: 'succeeded',
  result: value,
});

test('task claim normalization is conservative and segment-aware', () => {
  assert.equal(normalizeSftpTaskClaimPath(' /foo//bar/../baz/ '), '/');
  assert.equal(normalizeSftpTaskClaimPath('/foo '), '/foo ');
  assert.equal(normalizeSftpTaskClaimPath('/foo /child'), '/foo /child');
  assert.equal(normalizeSftpTaskClaimPath('foo/bar'), '/');
  assert.equal(normalizeSftpTaskClaimPath('   '), '/');
  assert.deepEqual(normalizeSftpTaskClaims(['/foo/bar', '/foo', '/foo/baz', '/other']), ['/foo', '/other']);

  assert.equal(doSftpTaskClaimsConflict('/foo', '/foo'), true);
  assert.equal(doSftpTaskClaimsConflict('/foo', '/foo/bar'), true);
  assert.equal(doSftpTaskClaimsConflict('/foo/bar', '/foo'), true);
  assert.equal(
    doSftpTaskClaimsConflict(normalizeSftpTaskClaimPath('/foo/'), normalizeSftpTaskClaimPath('/foo/bar')),
    true,
  );
  assert.equal(doSftpTaskClaimsConflict('/', '/anything'), true);
  assert.equal(doSftpTaskClaimsConflict('/foo', '/foobar'), false);
});

test('scheduler enforces total, heavy, and mutation limits independently', async () => {
  const totalScheduler = createScheduler(new FakeClock(), {
    total: 1,
    heavy: 1,
    mutation: 1,
  });
  const totalFirst = createDeferred<SftpTaskRunOutcome<string>>();
  const totalSecond = createDeferred<SftpTaskRunOutcome<string>>();
  totalScheduler.schedule({
    operation: 'total-first',
    resources: READ_LIGHT,
    claims: ['/total-a'],
    absoluteTimeoutMs: 1_000,
    run: async () => await totalFirst.promise,
  });
  const totalQueued = totalScheduler.schedule({
    operation: 'total-second',
    resources: READ_LIGHT,
    claims: ['/total-b'],
    absoluteTimeoutMs: 1_000,
    run: async () => await totalSecond.promise,
  });
  assert.equal(totalQueued.getSnapshot().state, 'queued');
  totalFirst.resolve(succeed('first'));
  await flushMicrotasks();
  assert.equal(totalQueued.getSnapshot().state, 'running');
  totalSecond.resolve(succeed('second'));
  await totalQueued.completion;

  const heavyScheduler = createScheduler(new FakeClock(), {
    total: 2,
    heavy: 1,
    mutation: 2,
  });
  const heavyFirst = createDeferred<SftpTaskRunOutcome<string>>();
  const heavySecond = createDeferred<SftpTaskRunOutcome<string>>();
  heavyScheduler.schedule({
    operation: 'heavy-first',
    resources: READ_HEAVY,
    claims: ['/heavy-a'],
    absoluteTimeoutMs: 1_000,
    run: async () => await heavyFirst.promise,
  });
  const heavyQueued = heavyScheduler.schedule({
    operation: 'heavy-second',
    resources: READ_HEAVY,
    claims: ['/heavy-b'],
    absoluteTimeoutMs: 1_000,
    run: async () => await heavySecond.promise,
  });
  assert.equal(heavyQueued.getSnapshot().state, 'queued');
  heavyFirst.resolve(succeed('first'));
  await flushMicrotasks();
  assert.equal(heavyQueued.getSnapshot().state, 'running');
  heavySecond.resolve(succeed('second'));
  await heavyQueued.completion;

  const mutationScheduler = createScheduler(new FakeClock(), {
    total: 2,
    heavy: 2,
    mutation: 1,
  });
  const mutationFirst = createDeferred<SftpTaskRunOutcome<string>>();
  const mutationSecond = createDeferred<SftpTaskRunOutcome<string>>();
  mutationScheduler.schedule({
    operation: 'mutation-first',
    resources: MUTATION_LIGHT,
    claims: ['/mutation-a'],
    absoluteTimeoutMs: 1_000,
    run: async () => await mutationFirst.promise,
  });
  const mutationQueued = mutationScheduler.schedule({
    operation: 'mutation-second',
    resources: MUTATION_LIGHT,
    claims: ['/mutation-b'],
    absoluteTimeoutMs: 1_000,
    run: async () => await mutationSecond.promise,
  });
  assert.equal(mutationQueued.getSnapshot().state, 'queued');
  mutationFirst.resolve(succeed('first'));
  await flushMicrotasks();
  assert.equal(mutationQueued.getSnapshot().state, 'running');
  mutationSecond.resolve(succeed('second'));
  await mutationQueued.completion;
});

test('scheduler runs unrelated paths concurrently and serializes overlapping path trees', async () => {
  const scheduler = createScheduler();
  const parent = createDeferred<SftpTaskRunOutcome<string>>();
  const descendant = createDeferred<SftpTaskRunOutcome<string>>();
  const exactMatch = createDeferred<SftpTaskRunOutcome<string>>();
  const siblingPrefix = createDeferred<SftpTaskRunOutcome<string>>();

  scheduler.schedule({
    operation: 'parent',
    resources: READ_LIGHT,
    claims: ['/foo'],
    absoluteTimeoutMs: 1_000,
    run: async () => await parent.promise,
  });
  const descendantTask = scheduler.schedule({
    operation: 'descendant',
    resources: READ_LIGHT,
    claims: ['/foo/bar'],
    absoluteTimeoutMs: 1_000,
    run: async () => await descendant.promise,
  });
  const siblingPrefixTask = scheduler.schedule({
    operation: 'sibling-prefix',
    resources: READ_LIGHT,
    claims: ['/foobar'],
    absoluteTimeoutMs: 1_000,
    run: async () => await siblingPrefix.promise,
  });
  const exactMatchTask = scheduler.schedule({
    operation: 'exact-match',
    resources: READ_LIGHT,
    claims: ['/foo'],
    absoluteTimeoutMs: 1_000,
    run: async () => await exactMatch.promise,
  });

  assert.equal(descendantTask.getSnapshot().state, 'queued');
  assert.equal(siblingPrefixTask.getSnapshot().state, 'running');
  assert.equal(exactMatchTask.getSnapshot().state, 'queued');

  parent.resolve(succeed('parent'));
  await flushMicrotasks();
  assert.equal(descendantTask.getSnapshot().state, 'running');
  assert.equal(exactMatchTask.getSnapshot().state, 'queued');

  descendant.resolve(succeed('descendant'));
  await flushMicrotasks();
  assert.equal(exactMatchTask.getSnapshot().state, 'running');

  exactMatch.resolve(succeed('exact'));
  siblingPrefix.resolve(succeed('sibling'));
  await Promise.all([exactMatchTask.completion, siblingPrefixTask.completion]);
});

test('head-of-line bypass preserves older overlapping claim reservations', async () => {
  const scheduler = createScheduler(new FakeClock(), {
    total: 3,
    heavy: 1,
    mutation: 3,
  });
  const activeHeavy = createDeferred<SftpTaskRunOutcome<string>>();
  const olderHeavy = createDeferred<SftpTaskRunOutcome<string>>();
  const unrelatedLight = createDeferred<SftpTaskRunOutcome<string>>();
  const youngerOverlap = createDeferred<SftpTaskRunOutcome<string>>();

  scheduler.schedule({
    operation: 'active-heavy',
    resources: READ_HEAVY,
    claims: ['/active'],
    absoluteTimeoutMs: 1_000,
    run: async () => await activeHeavy.promise,
  });
  const olderHeavyTask = scheduler.schedule({
    operation: 'older-heavy',
    resources: READ_HEAVY,
    claims: ['/reserved'],
    absoluteTimeoutMs: 1_000,
    run: async () => await olderHeavy.promise,
  });
  const unrelatedTask = scheduler.schedule({
    operation: 'unrelated-light',
    resources: READ_LIGHT,
    claims: ['/unrelated'],
    absoluteTimeoutMs: 1_000,
    run: async () => await unrelatedLight.promise,
  });
  const youngerOverlapTask = scheduler.schedule({
    operation: 'younger-overlap',
    resources: READ_LIGHT,
    claims: ['/reserved/child'],
    absoluteTimeoutMs: 1_000,
    run: async () => await youngerOverlap.promise,
  });

  assert.equal(olderHeavyTask.getSnapshot().state, 'queued');
  assert.equal(unrelatedTask.getSnapshot().state, 'running');
  assert.equal(youngerOverlapTask.getSnapshot().state, 'queued');

  unrelatedLight.resolve(succeed('unrelated'));
  await unrelatedTask.completion;
  assert.equal(youngerOverlapTask.getSnapshot().state, 'queued');

  activeHeavy.resolve(succeed('active'));
  await flushMicrotasks();
  assert.equal(olderHeavyTask.getSnapshot().state, 'running');
  assert.equal(youngerOverlapTask.getSnapshot().state, 'queued');

  olderHeavy.resolve(succeed('older'));
  await flushMicrotasks();
  assert.equal(youngerOverlapTask.getSnapshot().state, 'running');
  youngerOverlap.resolve(succeed('younger'));
  await youngerOverlapTask.completion;
});

test('an exclusive task becomes a fairness barrier for younger tasks', async () => {
  const scheduler = createScheduler(new FakeClock(), {
    total: 2,
    heavy: 2,
    mutation: 2,
  });
  const active = createDeferred<SftpTaskRunOutcome<string>>();
  const exclusive = createDeferred<SftpTaskRunOutcome<string>>();
  const younger = createDeferred<SftpTaskRunOutcome<string>>();
  const starts: string[] = [];

  scheduler.schedule({
    operation: 'active',
    resources: READ_LIGHT,
    claims: ['/active'],
    absoluteTimeoutMs: 1_000,
    run: async () => {
      starts.push('active');
      return await active.promise;
    },
  });
  const exclusiveTask = scheduler.schedule({
    operation: 'exclusive',
    resources: EXCLUSIVE_LIFECYCLE,
    claims: ['/'],
    absoluteTimeoutMs: 1_000,
    run: async () => {
      starts.push('exclusive');
      return await exclusive.promise;
    },
  });
  const youngerTask = scheduler.schedule({
    operation: 'younger',
    resources: READ_LIGHT,
    claims: ['/younger'],
    absoluteTimeoutMs: 1_000,
    run: async () => {
      starts.push('younger');
      return await younger.promise;
    },
  });
  await flushMicrotasks();

  assert.deepEqual(starts, ['active']);
  assert.equal(exclusiveTask.getSnapshot().state, 'queued');
  assert.equal(youngerTask.getSnapshot().state, 'queued');

  active.resolve(succeed('active'));
  await flushMicrotasks();
  assert.deepEqual(starts, ['active', 'exclusive']);
  assert.equal(exclusiveTask.getSnapshot().state, 'running');
  assert.equal(youngerTask.getSnapshot().state, 'queued');

  exclusive.resolve(succeed('exclusive'));
  await flushMicrotasks();
  assert.deepEqual(starts, ['active', 'exclusive', 'younger']);
  younger.resolve(succeed('younger'));
  await youngerTask.completion;
});

test('a queued task fails at its absolute deadline without invoking its runner', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock, {
    total: 1,
    heavy: 1,
    mutation: 1,
  });
  const blocker = createDeferred<SftpTaskRunOutcome<string>>();
  let queuedRunnerCalls = 0;

  scheduler.schedule({
    operation: 'blocker',
    resources: READ_LIGHT,
    claims: ['/blocker'],
    absoluteTimeoutMs: 1_000,
    run: async () => await blocker.promise,
  });
  const queuedTask = scheduler.schedule({
    operation: 'queued-deadline',
    resources: READ_LIGHT,
    claims: ['/queued'],
    absoluteTimeoutMs: 25,
    run: async () => {
      queuedRunnerCalls += 1;
      return succeed('unexpected');
    },
  });

  clock.advanceBy(25);
  const snapshot = await queuedTask.completion;
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.startedAt, undefined);
  assert.equal(snapshot.failure?.code, SFTP_TASK_DEADLINE_EXCEEDED_CODE);
  assert.equal(snapshot.failure?.outcomeUnknown, undefined);
  assert.equal(queuedRunnerCalls, 0);

  blocker.resolve(succeed('blocker'));
  await scheduler.waitForIdle();
  assert.equal(queuedRunnerCalls, 0);
});

test('a running mutation deadline aborts once and reports an unknown outcome', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const runner = createDeferred<SftpTaskRunOutcome<string>>();
  let observedSignal: AbortSignal | undefined;
  const abortReasons: string[] = [];

  const task = scheduler.schedule({
    operation: 'running-deadline',
    resources: MUTATION_LIGHT,
    claims: ['/mutation'],
    absoluteTimeoutMs: 25,
    run: async ({ signal }) => {
      observedSignal = signal;
      return await runner.promise;
    },
    onAbort: (reason) => {
      abortReasons.push(reason);
    },
  });
  await flushMicrotasks();
  clock.advanceBy(25);

  const snapshot = await task.completion;
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.failure?.code, SFTP_TASK_DEADLINE_EXCEEDED_CODE);
  assert.equal(snapshot.failure?.outcomeUnknown, true);
  assert.equal(observedSignal?.aborted, true);
  assert.deepEqual(abortReasons, ['deadline']);

  clock.advanceBy(100);
  assert.deepEqual(abortReasons, ['deadline']);
  runner.resolve(succeed('late'));
  await scheduler.waitForIdle();
  assert.equal(task.getSnapshot().state, 'failed');
});

test('failed outcomes retain structured results and the latest partial result', async () => {
  const scheduler = createScheduler();
  const task = scheduler.schedule<{ completed: string[] }, { current: string }>({
    operation: 'partial-failure',
    resources: MUTATION_LIGHT,
    claims: ['/batch'],
    absoluteTimeoutMs: 1_000,
    run: async ({ reportPartial }) => {
      reportPartial({ current: '/batch/a' });
      return {
        state: 'failed',
        failure: {
          code: 'SFTP_BATCH_PARTIAL_FAILURE',
          message: 'One entry failed.',
        },
        result: {
          completed: ['/batch/a'],
        },
      };
    },
  });

  const snapshot = await task.completion;
  assert.equal(snapshot.state, 'failed');
  assert.deepEqual(snapshot.partialResult, { current: '/batch/a' });
  assert.deepEqual(snapshot.result, { completed: ['/batch/a'] });
  assert.equal(snapshot.failure?.code, 'SFTP_BATCH_PARTIAL_FAILURE');
});

test('cancelAll cancels queued tasks and invokes a running abort hook once', async () => {
  const scheduler = createScheduler(new FakeClock(), {
    total: 1,
    heavy: 1,
    mutation: 1,
  });
  const runner = createDeferred<SftpTaskRunOutcome<string>>();
  const abortReasons: string[] = [];
  let queuedRunnerCalls = 0;

  const runningTask = scheduler.schedule({
    operation: 'running',
    resources: READ_LIGHT,
    claims: ['/running'],
    absoluteTimeoutMs: 1_000,
    run: async () => await runner.promise,
    onAbort: (reason) => {
      abortReasons.push(reason);
    },
  });
  const queuedTask = scheduler.schedule({
    operation: 'queued',
    resources: READ_LIGHT,
    claims: ['/queued'],
    absoluteTimeoutMs: 1_000,
    run: async () => {
      queuedRunnerCalls += 1;
      return succeed('unexpected');
    },
    onAbort: (reason) => {
      abortReasons.push(`queued:${reason}`);
    },
  });
  await flushMicrotasks();

  scheduler.cancelAll();
  scheduler.cancelAll();

  const [runningSnapshot, queuedSnapshot] = await Promise.all([runningTask.completion, queuedTask.completion]);
  assert.equal(runningSnapshot.state, 'cancelled');
  assert.equal(runningSnapshot.cancelRequested, true);
  assert.equal(queuedSnapshot.state, 'cancelled');
  assert.equal(queuedSnapshot.startedAt, undefined);
  assert.equal(queuedRunnerCalls, 0);
  assert.deepEqual(abortReasons, ['cancelled']);

  runner.resolve({ state: 'cancelled' });
  await scheduler.waitForIdle();
  assert.deepEqual(abortReasons, ['cancelled']);
});

test('cancelAll reports a running mutation as an outcome-unknown failure', async () => {
  const scheduler = createScheduler();
  const runner = createDeferred<SftpTaskRunOutcome<string>>();
  const task = scheduler.schedule({
    operation: 'mutation',
    resources: MUTATION_LIGHT,
    claims: ['/target'],
    absoluteTimeoutMs: 1_000,
    run: async () => await runner.promise,
  });

  scheduler.cancelAll();
  const snapshot = await task.completion;
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.failure?.outcomeUnknown, true);

  runner.resolve(succeed('late'));
  await scheduler.waitForIdle();
});

test('timed-out runners retain slots and claims until their promises settle', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock, {
    total: 1,
    heavy: 1,
    mutation: 1,
  });
  const lateRunner = createDeferred<SftpTaskRunOutcome<string>>();
  const nextRunner = createDeferred<SftpTaskRunOutcome<string>>();
  let nextRunnerCalls = 0;

  const timedOutTask = scheduler.schedule({
    operation: 'timed-out',
    resources: MUTATION_LIGHT,
    claims: ['/same'],
    absoluteTimeoutMs: 10,
    run: async () => await lateRunner.promise,
  });
  const nextTask = scheduler.schedule({
    operation: 'next',
    resources: MUTATION_LIGHT,
    claims: ['/same/child'],
    absoluteTimeoutMs: 1_000,
    run: async () => {
      nextRunnerCalls += 1;
      return await nextRunner.promise;
    },
  });
  await flushMicrotasks();

  clock.advanceBy(10);
  assert.equal((await timedOutTask.completion).state, 'failed');
  assert.equal(nextTask.getSnapshot().state, 'queued');
  assert.equal(nextRunnerCalls, 0);

  let idleResolved = false;
  const idle = scheduler.waitForIdle().then(() => {
    idleResolved = true;
  });
  await flushMicrotasks();
  assert.equal(idleResolved, false);

  lateRunner.resolve(succeed('late'));
  await flushMicrotasks();
  assert.equal(nextTask.getSnapshot().state, 'running');
  assert.equal(nextRunnerCalls, 1);
  assert.equal(idleResolved, false);

  nextRunner.resolve(succeed('next'));
  await nextTask.completion;
  await idle;
  assert.equal(idleResolved, true);
  assert.equal(timedOutTask.getSnapshot().state, 'failed');
});

test('external cancellation cancels queued work before admission', async () => {
  const scheduler = createScheduler(new FakeClock(), {
    total: 1,
    heavy: 1,
    mutation: 1,
  });
  const blocker = createDeferred<SftpTaskRunOutcome<string>>();
  const cancellation = new AbortController();
  let cancelledRunnerCalls = 0;

  scheduler.schedule({
    operation: 'blocker',
    resources: READ_LIGHT,
    claims: ['/blocker'],
    absoluteTimeoutMs: 1_000,
    run: async () => await blocker.promise,
  });
  const cancelledTask = scheduler.schedule({
    operation: 'externally-cancelled',
    resources: READ_LIGHT,
    claims: ['/cancelled'],
    absoluteTimeoutMs: 1_000,
    cancellationSignal: cancellation.signal,
    run: async () => {
      cancelledRunnerCalls += 1;
      return succeed('unexpected');
    },
  });

  cancellation.abort();
  const snapshot = await cancelledTask.completion;
  assert.equal(snapshot.state, 'cancelled');
  assert.equal(snapshot.startedAt, undefined);
  assert.equal(cancelledRunnerCalls, 0);

  blocker.resolve(succeed('blocker'));
  await scheduler.waitForIdle();
});

test('forgetTask removes only terminal tasks whose runners released ownership', async () => {
  const scheduler = createScheduler();
  const runner = createDeferred<SftpTaskRunOutcome<string>>();
  const task = scheduler.schedule({
    operation: 'retained',
    resources: READ_LIGHT,
    claims: ['/retained'],
    absoluteTimeoutMs: 1_000,
    run: async () => await runner.promise,
  });

  assert.equal(scheduler.forgetTask(task.taskId), false);
  runner.resolve(succeed('done'));
  await task.completion;
  await task.released;
  assert.equal(scheduler.forgetTask(task.taskId), true);
  assert.equal(scheduler.getTask(task.taskId), null);
});
