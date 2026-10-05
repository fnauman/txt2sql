// Concurrency pool, per-case deadline and LLM budget for evaluation runs.
//
// Tasks are scheduled case-major (every repetition of case 1, then case 2,
// ...) on `concurrency` workers. Each task gets an AbortSignal that fires
// after `caseTimeoutMs`; it is passed down to runOptimizedQuestion, which stops
// the in-flight LLM call (a query already running ends at its statement
// timeout). A task that ignores the signal is abandoned `graceMs` later and
// recorded as a timeout.
//
// Budget: once the cumulative LLM cost of finished tasks reaches `budgetUsd`,
// no NEW case is started; every repetition of a case that has not started is
// recorded as `skipped_budget`. Cases already started finish all their
// repetitions, so the overshoot is at most the cost of the cases in flight.

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
 * budgetExhausted, skippedCaseIds }. `onResult(info)` is awaited after each
 * task (progress output, trace). A thrown error becomes 'evaluation_error'.
 */
export async function runCaseRepetitions({
  cases,
  repeat = 1,
  concurrency = DEFAULT_CONCURRENCY,
  caseTimeoutMs = DEFAULT_CASE_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
  budgetUsd = null,
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
  let spentUsd = 0;
  let completed = 0;

  const runTask = async (task) => {
    const deadline = createDeadline(caseTimeoutMs);
    const TIMEOUT = Symbol('timeout');
    let pending = null;
    let settled = false;
    let graceTimer = null;
    // After the deadline fires, wait graceMs for the task to notice the
    // signal before abandoning it (the timer is cleared once the task ends).
    const abandoned = deadline.expired.then(
      () =>
        new Promise((resolve) => {
          if (!settled) {
            graceTimer = setTimeout(() => resolve(TIMEOUT), graceMs);
          }
        })
    );
    try {
      pending = Promise.resolve().then(() => runRepetition({ ...task, signal: deadline.signal }));
      const raced = await Promise.race([pending, abandoned]);
      if (raced === TIMEOUT) {
        pending.catch(() => {});
        return timeoutResult(caseTimeoutMs);
      }
      if (raced?.status === 'aborted' && deadline.timedOut) {
        return { ...raced, timed_out: true };
      }
      return raced;
    } catch (error) {
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
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
  };

  await runPool(
    tasks,
    async (task) => {
      let result;
      if (!started.has(task.caseIndex) && (skipped.has(task.caseIndex) || (budgetUsd != null && spentUsd >= budgetUsd))) {
        skipped.add(task.caseIndex);
        result = skippedResult(budgetUsd);
      } else {
        started.add(task.caseIndex);
        result = await runTask(task);
        spentUsd += costOf(result);
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
  };
}
