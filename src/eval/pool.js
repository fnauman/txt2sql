// Concurrency pool, per-case deadline and LLM budget for evaluation runs.
//
// Tasks are scheduled case-major (every repetition of case 1, then case 2,
// ...) on `concurrency` workers. Each task gets an AbortSignal that fires
// after `caseTimeoutMs`; evaluateQuestion passes it to the gold runs, to
// runOptimizedQuestion (which stops the in-flight LLM call) and to the
// oracle's scoring (a query already running on a plain connection ends at its
// statement timeout). The deadline covers the whole task: a result that
// arrives after it, whatever its status (a late pass included), or a task that
// throws after it, is recorded as a timeout (status 'aborted', timed_out,
// error_code CASE_TIMEOUT, the late status in `late_status`), keeping the
// attempts and cost it recorded, so a slow case can never count as a pass.
// A task that ignores the signal is abandoned `graceMs` later and recorded as
// a timeout too; the grace only lets a task stop and report what it did.
//
// Budget: once the cumulative LLM cost of finished tasks reaches `budgetUsd`,
// no NEW case is started; every repetition of a case that has not started is
// recorded as `skipped_budget`. Cases already started finish all their
// repetitions, so the overshoot is at most the cost of the cases in flight.
//
// Stop: when `stopSignal` aborts (Ctrl-C, or a provider that rejects the API
// key), no task starts any more, in-flight tasks are aborted through their
// signal (and abandoned after the grace period), and every task that did not
// finish is recorded as `cancelled` (excluded from accuracy), so a partial
// report can still be written.

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_CASE_TIMEOUT_MS = 120_000;
export const DEFAULT_GRACE_MS = 5_000;

export class CaseTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Case deadline of ${timeoutMs} ms exceeded.`);
    this.name = 'CaseTimeoutError';
    this.code = 'CASE_TIMEOUT';
  }
}

/**
 * An AbortSignal that aborts after `timeoutMs` (never when 0 or null) with a
 * CaseTimeoutError reason. `expired` resolves when the deadline fires.
 */
export function createDeadline(timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let resolveExpired;
  const expired = new Promise((resolve) => {
    resolveExpired = resolve;
  });
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new CaseTimeoutError(timeoutMs));
      resolveExpired();
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    expired,
    get timedOut() {
      return controller.signal.aborted && controller.signal.reason instanceof CaseTimeoutError;
    },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Runs `worker(item, index)` over `items` with at most `concurrency` in flight; results keep item order. */
export async function runPool(items, worker, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const list = [...(items || [])];
  const results = new Array(list.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.trunc(concurrency) || 1, list.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < list.length) {
        const index = next;
        next += 1;
        results[index] = await worker(list[index], index);
      }
    })
  );
  return results;
}

export function costOfResult(result) {
  const total = result?.llm_cost?.totalCost;
  return Number.isFinite(total) ? total : 0;
}

function skippedResult(budgetUsd) {
  return {
    status: 'skipped_budget',
    warnings: [],
    error: `Not run: the LLM budget of $${budgetUsd} was reached before this case started.`,
    error_stage: null,
    error_code: 'BUDGET_EXHAUSTED',
    attempts: [],
    attempt_count: 0,
    llm_usage: null,
    llm_cost: null,
  };
}

export function stopReasonOf(signal) {
  const reason = signal?.reason;
  return reason?.message || (typeof reason === 'string' ? reason : 'the run was stopped');
}

function cancelledResult(reason, extra = {}) {
  return {
    status: 'cancelled',
    warnings: [],
    error: `Not finished: ${reason}.`,
    error_stage: null,
    error_code: 'RUN_CANCELLED',
    attempts: [],
    attempt_count: 0,
    llm_usage: null,
    llm_cost: null,
    ...extra,
  };
}

// Resolves when `signal` aborts; `dispose` removes the listener.
function abortedPromise(signal) {
  if (!signal) {
    return { promise: new Promise(() => {}), dispose() {} };
  }
  let listener = null;
  const promise = new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    listener = () => resolve();
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

// A result (or a throw) that arrived after the deadline: a timeout that keeps
// what the task recorded.
function lateTimeoutResult(result, timeoutMs) {
  if (result.status === 'aborted') {
    return { ...result, timed_out: true };
  }
  return {
    ...result,
    status: 'aborted',
    timed_out: true,
    late_status: result.status,
    error: `Case deadline of ${timeoutMs} ms exceeded; the case finished late (${result.status}), which counts as a timeout.`,
    error_stage: 'aborted',
    error_code: 'CASE_TIMEOUT',
  };
}

function timeoutResult(timeoutMs) {
  return {
    status: 'aborted',
    timed_out: true,
    warnings: [],
    error: `Case deadline of ${timeoutMs} ms exceeded and the case did not stop within the grace period.`,
    error_stage: 'aborted',
    error_code: 'CASE_TIMEOUT',
    attempts: [],
    attempt_count: 0,
    llm_usage: null,
    llm_cost: null,
  };
}

/**
 * Runs every (case, repetition) through `runRepetition({ testCase, caseIndex,
 * repetition, signal })`, which returns an evaluateQuestion-shaped result.
 * Returns { repetitions: result[][] (per case, per repetition), spentUsd,
 * budgetExhausted, skippedCaseIds, stopped: reason | null, cancelledCaseIds }.
 * `onResult(info)` is awaited after each task (progress output, trace). A
 * thrown error becomes 'evaluation_error'.
 */
export async function runCaseRepetitions({
  cases,
  repeat = 1,
  concurrency = DEFAULT_CONCURRENCY,
  caseTimeoutMs = DEFAULT_CASE_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
  budgetUsd = null,
  stopSignal = null,
  runRepetition,
  onResult = null,
  costOf = costOfResult,
}) {
  const list = cases || [];
  const repetitions = Math.max(1, Math.trunc(repeat) || 1);
  const tasks = list.flatMap((testCase, caseIndex) =>
    Array.from({ length: repetitions }, (_, index) => ({ testCase, caseIndex, repetition: index + 1 }))
  );
  const results = list.map(() => new Array(repetitions).fill(null));
  const started = new Set();
  const skipped = new Set();
  const cancelled = new Set();
  let spentUsd = 0;
  let completed = 0;

  const runTask = async (task) => {
    const deadline = createDeadline(caseTimeoutMs);
    const ABANDONED = Symbol('abandoned');
    // The task's signal fires at its deadline or when the run is stopped.
    const controller = new AbortController();
    const forward = (source) => () => {
      if (!controller.signal.aborted) {
        controller.abort(source.reason);
      }
    };
    const onDeadline = forward(deadline.signal);
    const onStop = stopSignal ? forward(stopSignal) : null;
    deadline.signal.addEventListener('abort', onDeadline, { once: true });
    if (stopSignal) {
      if (stopSignal.aborted) {
        onStop();
      } else {
        stopSignal.addEventListener('abort', onStop, { once: true });
      }
    }
    const stopped = abortedPromise(stopSignal);
    let pending = null;
    let settled = false;
    let graceTimer = null;
    // After the deadline fires (or the run is stopped), wait graceMs for the
    // task to notice the signal before abandoning it (the timer is cleared
    // once the task ends).
    const abandoned = Promise.race([deadline.expired, stopped.promise]).then(
      () =>
        new Promise((resolve) => {
          if (!settled) {
            graceTimer = setTimeout(() => resolve(ABANDONED), graceMs);
          }
        })
    );
    const wasStopped = () => Boolean(stopSignal?.aborted) && !deadline.timedOut;
    try {
      pending = Promise.resolve().then(() => runRepetition({ ...task, signal: controller.signal }));
      const raced = await Promise.race([pending, abandoned]);
      if (raced === ABANDONED) {
        pending.catch(() => {});
        return wasStopped() ? cancelledResult(stopReasonOf(stopSignal), { cancelled_in_flight: true }) : timeoutResult(caseTimeoutMs);
      }
      // Checked as the result arrives: the deadline timer cannot fire between
      // the task settling and this line (no macrotask runs in between).
      if (deadline.timedOut) {
        return lateTimeoutResult(raced, caseTimeoutMs);
      }
      if (raced?.status === 'aborted' && wasStopped()) {
        // Keep what the task recorded (attempts, cost) but not as a verdict.
        return { ...raced, status: 'cancelled', error: `Not finished: ${stopReasonOf(stopSignal)}.`, error_code: 'RUN_CANCELLED', cancelled_in_flight: true };
      }
      return raced;
    } catch (error) {
      if (deadline.timedOut) {
        return { ...timeoutResult(caseTimeoutMs), error: `Case deadline of ${caseTimeoutMs} ms exceeded; the case then failed: ${error?.message || String(error)}` };
      }
      if (wasStopped()) {
        return cancelledResult(stopReasonOf(stopSignal), { cancelled_in_flight: true });
      }
      return {
        status: 'evaluation_error',
        warnings: [],
        error: error?.message || String(error),
        error_stage: null,
        error_code: error?.code || null,
        attempts: [],
        attempt_count: 0,
        llm_usage: null,
        llm_cost: null,
      };
    } finally {
      settled = true;
      deadline.clear();
      deadline.signal.removeEventListener('abort', onDeadline);
      if (onStop) {
        stopSignal.removeEventListener('abort', onStop);
      }
      stopped.dispose();
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
  };

  await runPool(
    tasks,
    async (task) => {
      let result;
      if (stopSignal?.aborted) {
        cancelled.add(task.caseIndex);
        result = cancelledResult(stopReasonOf(stopSignal));
      } else if (!started.has(task.caseIndex) && (skipped.has(task.caseIndex) || (budgetUsd != null && spentUsd >= budgetUsd))) {
        skipped.add(task.caseIndex);
        result = skippedResult(budgetUsd);
      } else {
        started.add(task.caseIndex);
        result = await runTask(task);
        spentUsd += costOf(result);
        if (result.status === 'cancelled') {
          cancelled.add(task.caseIndex);
        }
      }
      results[task.caseIndex][task.repetition - 1] = result;
      completed += 1;
      if (onResult) {
        await onResult({ ...task, result, completed, total: tasks.length, spentUsd });
      }
    },
    { concurrency }
  );

  return {
    repetitions: results,
    spentUsd: Number(spentUsd.toFixed(6)),
    budgetExhausted: skipped.size > 0,
    skippedCaseIds: [...skipped].sort((left, right) => left - right).map((index) => list[index].id),
    stopped: stopSignal?.aborted ? stopReasonOf(stopSignal) : null,
    cancelledCaseIds: [...cancelled].sort((left, right) => left - right).map((index) => list[index].id),
  };
}
