import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { CaseTimeoutError, createDeadline, runCaseRepetitions, runPool } from '../src/eval/pool.js';
import { attributeCaseRuns } from '../src/eval/runner.js';
import { summarizeRunStatistics } from '../src/eval/stats.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { evaluateQuestion } from '../scripts/evaluate.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = (count) => Array.from({ length: count }, (_, index) => ({ id: `case_${index + 1}` }));
const passResult = (cost = 0.001) => ({ status: 'pass', attempts: [], llm_cost: { totalCost: cost }, timings: { totalMs: 1 } });
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runPool keeps item order and never exceeds the concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await runPool(
    [30, 5, 20, 1, 10, 2],
    async (ms, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(ms);
      inFlight -= 1;
      return index;
    },
    { concurrency: 2 }
  );
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(await runPool([], async () => 1), []);
});

test('every repetition of every case is kept, scheduled case by case', async () => {
  const order = [];
  const run = await runCaseRepetitions({
    cases: cases(3),
    repeat: 3,
    concurrency: 1,
    runRepetition: async ({ testCase, repetition }) => {
      order.push(`${testCase.id}#${repetition}`);
      return { ...passResult(), repetitionSeen: repetition };
    },
  });
  assert.deepEqual(order, ['case_1#1', 'case_1#2', 'case_1#3', 'case_2#1', 'case_2#2', 'case_2#3', 'case_3#1', 'case_3#2', 'case_3#3']);
  assert.deepEqual(run.repetitions.map((list) => list.map((result) => result.repetitionSeen)), [[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
  assert.equal(run.spentUsd, 0.009);
  assert.equal(run.budgetExhausted, false);
});

test('the per-case deadline aborts the signal passed to the case; the case reports a timeout', async () => {
  const progress = [];
  const run = await runCaseRepetitions({
    cases: cases(2),
    concurrency: 2,
    caseTimeoutMs: 30,
    graceMs: 1000,
    runRepetition: ({ testCase, signal }) =>
      new Promise((resolve) => {
        if (testCase.id === 'case_2') {
          resolve(passResult());
          return;
        }
        // Like runOptimizedQuestion: stop when the signal fires and report 'aborted'.
        signal.addEventListener('abort', () => {
          assert.ok(signal.reason instanceof CaseTimeoutError);
          resolve({ status: 'aborted', error_code: signal.reason.code, attempts: [] });
        });
      }),
    onResult: (info) => {
      progress.push([info.testCase.id, info.result.status, info.completed, info.total]);
    },
  });
  assert.equal(run.repetitions[0][0].status, 'aborted');
  assert.equal(run.repetitions[0][0].timed_out, true);
  assert.equal(run.repetitions[0][0].error_code, 'CASE_TIMEOUT');
  assert.equal(run.repetitions[1][0].status, 'pass');
  assert.deepEqual(progress.map((entry) => entry.slice(2)), [[1, 2], [2, 2]]);
});

test('a case that ignores the signal is abandoned after the grace period', async () => {
  const started = Date.now();
  const run = await runCaseRepetitions({
    cases: cases(1),
    caseTimeoutMs: 20,
    graceMs: 20,
    runRepetition: () => new Promise(() => {}),
  });
  assert.deepEqual(
    [run.repetitions[0][0].status, run.repetitions[0][0].timed_out, run.repetitions[0][0].error_code],
    ['aborted', true, 'CASE_TIMEOUT']
  );
  assert.ok(Date.now() - started < 1000);
});

test('the budget stops new cases; started cases finish their repetitions', async () => {
  const ran = [];
  const run = await runCaseRepetitions({
    cases: cases(5),
    repeat: 2,
    concurrency: 1,
    budgetUsd: 0.5,
    runRepetition: async ({ testCase, repetition }) => {
      ran.push(`${testCase.id}#${repetition}`);
      return passResult(0.2);
    },
  });
  // case_1: 0.4 spent; case_2 starts (0.4 < 0.5) and finishes both repetitions (0.8); case_3+ are skipped.
  assert.deepEqual(ran, ['case_1#1', 'case_1#2', 'case_2#1', 'case_2#2']);
  assert.equal(run.spentUsd, 0.8);
  assert.equal(run.budgetExhausted, true);
  assert.deepEqual(run.skippedCaseIds, ['case_3', 'case_4', 'case_5']);
  for (const list of run.repetitions.slice(2)) {
    assert.deepEqual(list.map((result) => [result.status, result.error_code]), [
      ['skipped_budget', 'BUDGET_EXHAUSTED'],
      ['skipped_budget', 'BUDGET_EXHAUSTED'],
    ]);
  }
});

test('a thrown case becomes evaluation_error and the run goes on', async () => {
  const run = await runCaseRepetitions({
    cases: cases(2),
    runRepetition: async ({ testCase }) => {
      if (testCase.id === 'case_1') {
        throw Object.assign(new Error('boom'), { code: 'X' });
      }
      return passResult();
    },
  });
  assert.deepEqual([run.repetitions[0][0].status, run.repetitions[0][0].error, run.repetitions[0][0].error_code], ['evaluation_error', 'boom', 'X']);
  assert.equal(run.repetitions[1][0].status, 'pass');
});

test('createDeadline: no timer when disabled, aborts with CASE_TIMEOUT otherwise', async () => {
  const off = createDeadline(0);
  assert.equal(off.signal.aborted, false);
  off.clear();
  const on = createDeadline(5);
  await on.expired;
  assert.equal(on.signal.aborted, true);
  assert.equal(on.timedOut, true);
  assert.equal(on.signal.reason.code, 'CASE_TIMEOUT');
});

test('evaluateQuestion passes the deadline signal to the product loop', async () => {
  const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
  const testCase = normalizeBenchmarkCase({ id: 'c', question: 'How many customers?', expected_sql: 'SELECT 1 AS n', comparison: { mode: 'scalar' } });
  const controller = new AbortController();
  let seen = null;
  const result = await evaluateQuestion({
    client: {},
    connection: { query: async () => [[{ n: 1 }]] },
    schema,
    model: 'gpt-4o-mini',
    testCase,
    caseIndex: 1,
    trace: { emit: async () => {} },
    signal: controller.signal,
    dependencies: {
      runQuestion: async (options) => {
        seen = options.signal;
        await tick(30);
        return { success: false, errorStage: 'aborted', errorCode: 'CASE_TIMEOUT', error: new Error('deadline'), promptTables: [] };
      },
    },
  });
  assert.equal(seen, controller.signal);
  assert.equal(result.status, 'aborted');
  assert.equal(result.error_code, 'CASE_TIMEOUT');
  // The product loop's own wall time is recorded apart from the case total.
  assert.ok(result.timings.questionMs >= 25 && result.timings.questionMs <= result.timings.totalMs, JSON.stringify(result.timings));
});

test('a stopped run starts nothing more, aborts what is in flight and records it as cancelled', async () => {
  const stop = new AbortController();
  const started = [];
  const run = await runCaseRepetitions({
    cases: cases(5),
    concurrency: 3,
    caseTimeoutMs: 10_000,
    graceMs: 50,
    stopSignal: stop.signal,
    runRepetition: ({ testCase, signal }) => {
      started.push(testCase.id);
      if (testCase.id === 'case_1') {
        return passResult();
      }
      if (testCase.id === 'case_2') {
        // Ignores the signal: abandoned after the grace period.
        return new Promise(() => {});
      }
      // case_3 stops the run, then honours the signal like the product loop.
      stop.abort(new Error('the LLM provider rejected the request (HTTP_401)'));
      const aborted = { status: 'aborted', attempts: [{ attempt: 1 }], llm_cost: null };
      return signal.aborted ? aborted : new Promise((resolve) => signal.addEventListener('abort', () => resolve(aborted), { once: true }));
    },
  });
  assert.deepEqual(started, ['case_1', 'case_2', 'case_3']);
  assert.deepEqual(run.repetitions.map(([result]) => result.status), ['pass', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
  assert.deepEqual(run.repetitions[2][0].attempts, [{ attempt: 1 }], 'what the in-flight case recorded is kept');
  assert.deepEqual([run.repetitions[1][0].cancelled_in_flight, run.repetitions[2][0].cancelled_in_flight, run.repetitions[3][0].cancelled_in_flight], [true, true, undefined]);
  assert.equal(run.repetitions[3][0].error, 'Not finished: the LLM provider rejected the request (HTTP_401).');
  assert.equal(run.stopped, 'the LLM provider rejected the request (HTTP_401)');
  assert.deepEqual(run.cancelledCaseIds, ['case_2', 'case_3', 'case_4', 'case_5']);
  assert.equal(run.budgetExhausted, false);
});

test('a deadline during a stopped run is still a timeout, and a stop signal never leaks listeners', async () => {
  const stop = new AbortController();
  let listeners = 0;
  const signal = stop.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    listeners += 1;
    return add(...args);
  };
  signal.removeEventListener = (...args) => {
    listeners -= 1;
    return remove(...args);
  };
  const run = await runCaseRepetitions({
    cases: cases(6),
    concurrency: 3,
    caseTimeoutMs: 20,
    graceMs: 1000,
    stopSignal: signal,
    runRepetition: ({ testCase, signal: caseSignal }) =>
      testCase.id === 'case_1'
        ? new Promise((resolve) => caseSignal.addEventListener('abort', () => resolve({ status: 'aborted', attempts: [] }), { once: true }))
        : passResult(),
  });
  assert.deepEqual(run.repetitions.map(([result]) => result.status), ['aborted', 'pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(run.repetitions[0][0].timed_out, true);
  assert.equal(run.stopped, null);
  assert.ok(listeners <= 0, `listeners left on the stop signal: ${listeners}`);
});

const within = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms).unref())]);

test('a result that arrives after the case deadline is a timeout, never a pass; its attempts and cost are kept', async () => {
  const late = { status: 'pass', attempts: [{ attempt: 1, generatedSql: 'SELECT 1' }], attempt_count: 1, llm_cost: { totalCost: 0.25 }, llm_usage: { total_tokens: 9 }, timings: { totalMs: 60 } };
  const run = await runCaseRepetitions({
    cases: cases(3),
    concurrency: 3,
    caseTimeoutMs: 30,
    graceMs: 1000,
    runRepetition: async ({ testCase }) => {
      if (testCase.id === 'case_1') {
        return passResult(0.25);
      }
      // Gold execution or oracle scoring that does not notice the signal and
      // finishes inside the grace period.
      await tick(60);
      if (testCase.id === 'case_3') {
        throw Object.assign(new Error('scoring failed after the deadline'), { code: 'X' });
      }
      return late;
    },
  });
  assert.equal(run.repetitions[0][0].status, 'pass');
  const timedOut = run.repetitions[1][0];
  assert.deepEqual([timedOut.status, timedOut.timed_out, timedOut.error_code, timedOut.late_status], ['aborted', true, 'CASE_TIMEOUT', 'pass']);
  assert.match(timedOut.error, /Case deadline of 30 ms exceeded; the case finished late \(pass\), which counts as a timeout/);
  assert.deepEqual(timedOut.attempts, late.attempts, 'what the case recorded is kept');
  assert.deepEqual([timedOut.llm_cost, timedOut.llm_usage, timedOut.attempt_count], [late.llm_cost, late.llm_usage, 1]);
  assert.equal(run.spentUsd, 0.5, 'the late case still spent its cost');
  // A case that throws after its deadline is a timeout too, not an evaluation error.
  assert.deepEqual([run.repetitions[2][0].status, run.repetitions[2][0].timed_out, run.repetitions[2][0].error_code], ['aborted', true, 'CASE_TIMEOUT']);

  // Slow cases cannot inflate accuracy: 1 of 3 passed in time.
  const records = await attributeCaseRuns(
    run.repetitions.map((repetitions, index) => ({ entry: { testCase: normalizeBenchmarkCase({ id: `case_${index + 1}`, question: `Q${index}?`, expected_sql: 'SELECT 1' }), datasets: ['d'] }, repetitions })),
    { checkGuardrails: false }
  );
  assert.deepEqual(records.map((record) => record.summary.outcome), ['pass', 'timeout', 'timeout']);
  assert.equal(summarizeRunStatistics(records, { resamples: 50 }).strictAccuracy.value, 0.3333);
});

test('a result past the deadline is late even when the deadline timer has not run yet (same macrotask)', async () => {
  const busy = (ms) => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      // synchronous work, e.g. row matching after the last database round trip
    }
  };
  const run = await runCaseRepetitions({
    cases: cases(1),
    caseTimeoutMs: 100,
    graceMs: 1000,
    runRepetition: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      busy(200); // finishes ~260 ms in, before the 100 ms timer callback can run
      return { status: 'pass', attempts: [{ attempt: 1 }], attempt_count: 1, llm_cost: { totalUsd: 0.01 } };
    },
  });
  const [[result]] = run.repetitions;
  assert.deepEqual([result.status, result.timed_out, result.late_status, result.error_code], ['aborted', true, 'pass', 'CASE_TIMEOUT']);
  assert.equal(result.attempt_count, 1, 'what it recorded is kept');

  // A throw in the same situation is a timeout too, not an evaluation error.
  const threw = await runCaseRepetitions({
    cases: cases(1),
    caseTimeoutMs: 100,
    graceMs: 1000,
    runRepetition: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      busy(200);
      throw new Error('late failure');
    },
  });
  assert.deepEqual([threw.repetitions[0][0].status, threw.repetitions[0][0].error_code], ['aborted', 'CASE_TIMEOUT']);

  // A deadline that is disabled never makes a result late.
  const deadline = createDeadline(0);
  assert.equal(deadline.passed, false);
});

test('evaluateQuestion: the deadline reaches gold execution; a gold run cut short is a timeout, not a broken gold', async () => {
  const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
  const testCase = normalizeBenchmarkCase({ id: 'c', question: 'How many customers?', expected_sql: 'SELECT 1 AS n', comparison: { mode: 'scalar' } });
  const deadline = createDeadline(20);
  let asked = false;
  const result = await within(
    evaluateQuestion({
      client: {},
      // The gold never answers (a slow gold on a busy database).
      connection: { query: () => new Promise(() => {}) },
      schema,
      model: 'gpt-4o-mini',
      testCase,
      caseIndex: 1,
      trace: { emit: async () => {} },
      signal: deadline.signal,
      dependencies: {
        runQuestion: async () => {
          asked = true;
          return { success: true, sql: 'SELECT 1 AS n', promptTables: [] };
        },
      },
    }),
    2000,
    'evaluateQuestion'
  );
  deadline.clear();
  assert.deepEqual([result.status, result.error_stage, result.error_code], ['aborted', 'aborted', 'CASE_TIMEOUT']);
  assert.equal(asked, false, 'no LLM call after the deadline');
});

test('evaluateQuestion: the deadline reaches oracle scoring; a case whose deadline fired while scoring is aborted', async () => {
  const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
  const testCase = normalizeBenchmarkCase({ id: 'c', question: 'How many customers?', expected_sql: 'SELECT 1 AS n', comparison: { mode: 'scalar' } });
  const controller = new AbortController();
  let seen = null;
  const result = await evaluateQuestion({
    client: {},
    connection: { query: async () => [[{ n: 1 }]] },
    schema,
    model: 'gpt-4o-mini',
    testCase,
    caseIndex: 1,
    trace: { emit: async () => {} },
    signal: controller.signal,
    dependencies: {
      runQuestion: async () => ({ success: true, sql: 'SELECT 1 AS n', promptTables: [], llmCost: { totalCost: 0.01 }, attemptCount: 1 }),
      scorePrediction: async (options) => {
        seen = options.signal;
        // The deadline fires while the fixtures are being scored.
        controller.abort(new CaseTimeoutError(10));
        return { match: true, matchedGold: 'expected_sql', reason: 'match', perFixture: [], signalWarnings: [], disallowedWarnings: [], killedOn: [], assignment: {} };
      },
    },
  });
  assert.equal(seen, controller.signal);
  assert.deepEqual([result.status, result.error_stage, result.error_code], ['aborted', 'aborted', 'CASE_TIMEOUT']);
  assert.deepEqual(result.llm_cost, { totalCost: 0.01 }, 'the cost of the answered question is kept');

  // Scoring that throws because the deadline cut it short is aborted as well.
  const second = new AbortController();
  const thrown = await evaluateQuestion({
    client: {},
    connection: { query: async () => [[{ n: 1 }]] },
    schema,
    model: 'gpt-4o-mini',
    testCase,
    caseIndex: 1,
    trace: { emit: async () => {} },
    signal: second.signal,
    dependencies: {
      runQuestion: async () => ({ success: true, sql: 'SELECT 1 AS n', promptTables: [] }),
      scorePrediction: async () => {
        second.abort(new CaseTimeoutError(10));
        throw new Error('The database query was cancelled because the request was aborted.');
      },
    },
  });
  assert.deepEqual([thrown.status, thrown.error_code], ['aborted', 'CASE_TIMEOUT']);
});
