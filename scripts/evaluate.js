// The benchmark's per-case evaluation (evaluateQuestion) and the legacy
// helpers older callers import. The runner itself (case selection,
// concurrency, deadlines, repetitions, budget, attribution, statistics,
// reports) is scripts/eval.js; this file's CLI is that runner with the
// benchmark profile (see main below).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyBenchmarkStatus, collectBenchmarkWarnings, listGoldVariants } from '../src/benchmark.js';
import { createCaseTraceLogger, extractAttempts } from '../src/eval/case-trace.js';
import { checkFixtureContent } from '../src/eval/fixture-seeder.js';
import { PRIMARY_FIXTURE } from '../src/eval/fixtures.js';
import { createGoldCache, executeGoldSql, GOLD_STATEMENT_TIMEOUT_MS, scoreAgainstGold } from '../src/eval/oracle.js';
import { isEvalInfraError } from '../src/eval/infra-errors.js';
import { runOptimizedQuestion } from '../src/query-service.js';
import { createTimer, serializeError } from '../src/trace.js';

// Legacy pooled reliability helpers, now in src/eval/stats.js.
export { summarizeReliability, wilsonLowerBound } from '../src/eval/stats.js';

const __filename = fileURLToPath(import.meta.url);

// The product loop fetches at most this many rows (plus one, to detect
// truncation); the oracle re-runs the final SQL on every fixture anyway.
export const EVAL_ROW_LIMIT = 1000;

// runOptimizedQuestion's errorStage -> benchmark status.
const STAGE_STATUS = {
  llm: 'llm_error',
  validation: 'validation_error',
  execution: 'execution_error',
  infra: 'infra_error',
  aborted: 'aborted',
};

export function applyEvaluationFailureExitCode(failed, processLike = process) {
  if (failed > 0) {
    processLike.exitCode = 1;
  }
}

function sumDurations(attempts, step) {
  return Number(attempts.reduce((total, attempt) => total + (attempt[step]?.durationMs || 0), 0).toFixed(3));
}

/**
 * Benchmarks one case through the PRODUCT loop: runOptimizedQuestion does
 * master-data resolution, prompt building, generation, validation, execution
 * and retries exactly as the web app and the optimized CLI do (same prompt,
 * same retry message, same retry budget, same statement timeout). The
 * benchmark only adds the oracle: the final SQL is scored against the gold on
 * every fixture (src/eval/oracle.js).
 *
 * - `connections`: fixture connections from openFixtureConnections(); the
 *   first one (the primary fixture) is where the product loop runs, so its
 *   master data is what the model sees. A lone `connection` is treated as a
 *   single-fixture run.
 * - Per-attempt data (generated SQL, validation code/layer, execution outcome,
 *   usage/cost, timings) is rebuilt from a buffered trace that also forwards
 *   every event, tagged with the case, to `trace`.
 * - Gold runs first (with its own timeout), so a broken gold costs no LLM call
 *   and is reported as 'expected_sql_error', never as a model failure.
 * - `signal` (optional AbortSignal, e.g. the runner's per-case deadline) is
 *   passed to the product loop, which stops the in-flight LLM call (and kills
 *   a running query on a pool) and reports the case as 'aborted'.
 * - `dependencies.runQuestion` / `dependencies.scorePrediction` replace the
 *   product loop / oracle in tests.
 */
export async function evaluateQuestion({
  client,
  connection = null,
  connections = null,
  schema,
  model,
  testCase,
  caseIndex,
  datasetName = null,
  trace,
  goldCache = createGoldCache(),
  maxRetries = undefined,
  statementTimeoutMs = null,
  goldTimeoutMs = GOLD_STATEMENT_TIMEOUT_MS,
  signal = null,
  dependencies = {},
}) {
  const { runQuestion = runOptimizedQuestion, scorePrediction = scoreAgainstGold } = dependencies;
  const fixtureConnections =
    Array.isArray(connections) && connections.length > 0
      ? connections
      : [{ name: PRIMARY_FIXTURE.name, database: null, connection }];
  const primaryConnection = connection || fixtureConnections[0].connection;
  const caseContext = {
    caseIndex,
    datasetName,
    caseId: testCase.id,
    intentId: testCase.intentId || null,
    question: testCase.question,
  };
  const caseTimer = createTimer();

  await trace.emit('case.started', { ...caseContext, fixtures: fixtureConnections.map((entry) => entry.name) });

  // Gold first: every variant on every fixture (cached for the oracle).
  const goldTimer = createTimer();
  try {
    for (const variant of listGoldVariants(testCase)) {
      for (const fixtureConnection of fixtureConnections) {
        const rows = await executeGoldSql(fixtureConnection, variant.sql, { goldCache, timeoutMs: goldTimeoutMs, label: variant.label });
        await trace.emit('expected_sql.executed', {
          ...caseContext,
          fixture: fixtureConnection.name,
          gold: variant.label,
          sql: variant.sql,
          rowCount: rows.length,
        });
      }
    }
  } catch (error) {
    await trace.emit('expected_sql.failed', {
      ...caseContext,
      ...goldTimer.stop(),
      fixture: error.fixture ?? null,
      gold: error.label ?? null,
      error: serializeError(error.cause || error),
    });
    const result = {
      status: 'expected_sql_error',
      warnings: [],
      error: error.message,
      error_stage: 'gold',
      error_code: error.cause?.code || error.code || null,
      // The database going away is not a broken gold (mysql2's fatal errors
      // carry no code, so the code alone cannot tell).
      error_infra: isEvalInfraError(error.cause || error),
      attempts: [],
      attempt_count: 0,
      llm_usage: null,
      llm_cost: null,
    };
    await trace.emit('case.completed', {
      ...caseContext,
      success: false,
      status: result.status,
      error: serializeError(error.cause || error),
      attempts: 0,
    });
    return result;
  }

  const caseTrace = createCaseTraceLogger({ forwardTo: trace, context: caseContext });
  // The product loop's own wall time: what a user waits for, without the
  // harness's gold runs and multi-fixture scoring.
  const questionTimer = createTimer();
  const run = await runQuestion({
    client,
    connection: primaryConnection,
    schema,
    model,
    question: testCase.question,
    questionIndex: caseIndex,
    trace: caseTrace,
    maxRetries,
    rowLimit: EVAL_ROW_LIMIT,
    includeInsights: false,
    statementTimeoutMs,
    signal,
  });
  const questionMs = questionTimer.stop().durationMs;
  const attempts = extractAttempts(caseTrace.events);
  const promptEvent = caseTrace.events.find((entry) => entry.event === 'prompt.built');
  const retrievedTables = Array.isArray(run.promptTables) ? run.promptTables : [];
  if (promptEvent?.context?.retrieval) {
    await trace.emit('retrieval.completed', { ...caseContext, retrieval: promptEvent.context.retrieval });
  }

  let status;
  let score = null;
  const oracleTimer = createTimer();
  if (run.success) {
    score = await scorePrediction({
      testCase,
      predictedSql: run.sql,
      connections: fixtureConnections,
      goldCache,
      timeoutMs: statementTimeoutMs,
      goldTimeoutMs,
      schema,
    });
    status = score.match
      ? 'pass'
      : score.infraError
        ? 'infra_error'
        : classifyBenchmarkStatus({ rowsMatch: false, expectedTables: testCase.expected_tables, retrievedTables });

    await trace.emit('result.compared', {
      ...caseContext,
      ...oracleTimer.stop(),
      matched: score.match,
      matchedGold: score.matchedGold,
      reason: score.reason,
      perFixture: score.perFixture,
      assignment: score.assignment,
      expectedTables: testCase.expected_tables,
      retrievedTables,
    });
    await trace.emit('result.signal_checked', {
      ...caseContext,
      signalChecks: testCase.signal_checks || null,
      signalWarnings: score.signalWarnings,
      disallowedColumnsUsed: score.disallowedWarnings,
    });
  } else {
    status = STAGE_STATUS[run.errorStage] || 'execution_error';
  }

  const signalWarnings = score?.signalWarnings || [];
  const disallowedWarnings = score?.disallowedWarnings || [];
  const warnings = collectBenchmarkWarnings({ rowsMatch: status === 'pass', signalWarnings, disallowedColumnsUsed: disallowedWarnings });
  const timings = {
    // totalMs includes the gold runs and the oracle; questionMs is the product loop alone.
    totalMs: caseTimer.stop().durationMs,
    questionMs,
    llmMs: sumDurations(attempts, 'llm'),
    validationMs: sumDurations(attempts, 'validation'),
    executionMs: sumDurations(attempts, 'execution'),
  };
  const response = run.response || null;

  const result = {
    status,
    warnings,
    generated_sql: run.sql || '',
    explanation: response?.explanation || '',
    assumptions: response?.assumptions || [],
    tables_used: response?.tables_used || [],
    retrieved_tables: retrievedTables,
    master_data_candidates: run.masterDataCandidates || [],
    attempts,
    attempt_count: run.attemptCount ?? attempts.length,
    ...(run.success
      ? {}
      : {
          error: run.error?.message || 'Unknown error',
          error_stage: run.errorStage || null,
          error_code: run.errorCode || null,
        }),
    oracle: score
      ? {
          matched_gold: score.matchedGold,
          reason: score.reason,
          per_fixture: score.perFixture,
          killed_on: score.killedOn,
          assignment: score.assignment,
        }
      : null,
    signal_warnings: signalWarnings,
    disallowed_column_warnings: disallowedWarnings,
    expected_rows_preview: score?.preview?.gold || [],
    actual_rows_preview: score?.preview?.actual || [],
    llm_usage: run.llmUsage || null,
    llm_cost: run.llmCost || null,
    timings,
  };

  await trace.emit('case.completed', {
    ...caseContext,
    success: status === 'pass',
    status,
    warnings,
    generatedSql: result.generated_sql || null,
    attempts: result.attempt_count,
    perFixture: score?.perFixture || null,
    llmUsage: result.llm_usage,
    llmCost: result.llm_cost,
    ...(run.success ? {} : { errorStage: result.error_stage, error: serializeError(run.error) }),
  });

  return result;
}

// Deep fixture check (checkFixtureContent re-hashes every row): status
// 'current' | 'drifted' | 'stale' | 'missing' (or 'unknown' when the check
// itself failed) and whether the master data is the shared MASTER_DATA.
export async function describeFixtureStatus(fixtureConnections, { check = checkFixtureContent } = {}) {
  const statuses = [];
  for (const fixtureConnection of fixtureConnections) {
    try {
      const result = await check(fixtureConnection.connection, fixtureConnection);
      statuses.push({
        name: fixtureConnection.name,
        database: fixtureConnection.database,
        status: result.status,
        contentHash: result.contentHash,
        metaContentHash: result.meta?.contentHash || null,
        expectedContentHash: result.expected.contentHash,
        masterDataMatches: result.masterDataMatches,
      });
    } catch (error) {
      statuses.push({ name: fixtureConnection.name, database: fixtureConnection.database, status: 'unknown', masterDataMatches: null, error: error.message });
    }
  }
  return statuses;
}

/**
 * The benchmark refuses to run when a fixture's master data is not the shared
 * MASTER_DATA: the model's prompt context comes from the primary fixture's
 * master data, so a fixture with other dimension rows would score a different
 * question than the one the model was asked. Drifted facts only warn.
 */
export function assertSharedMasterData(fixtureStatus) {
  const differing = fixtureStatus.filter((entry) => entry.masterDataMatches === false);
  if (differing.length > 0) {
    throw new Error(
      `Fixture master data differs from the shared master data on ${differing.map((entry) => `${entry.name} (${entry.database})`).join(', ')}. ` +
        'Every fixture must carry identical dimension rows; run "npm run seed-fixtures" (admin credentials) to rebuild them.'
    );
  }
}

// `node scripts/evaluate.js` and `npm run benchmark` / `npm run evaluate` are
// the evaluation runner (scripts/eval.js) with the benchmark profile: one
// dataset (default core-public), no Docker start, no fixture seeding (stale
// fixtures only warn), no gold/controls verification, and exit code 1 when any
// case fails in a single-repetition run. Every eval flag also works here
// (--repeat, --concurrency, --case-timeout-ms, --budget-usd, --compare, ...).
export async function main(argv = process.argv.slice(2)) {
  const { main: runEvaluation } = await import('./eval.js');
  return runEvaluation(argv, { profile: 'benchmark' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().then((code) => {
    process.exitCode = code;
  });
}
