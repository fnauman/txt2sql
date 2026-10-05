// Rescore: re-judge a recorded report with today's validator, fixtures and
// oracle, with ZERO LLM calls (audit plan 2.2). Comparator, fixture, gold and
// guardrail changes become measurable on recorded generations for $0.
//
// Per case: the gold runs first on every fixture (a failing gold makes every
// repetition expected_sql_error, as in a live run). The case definition is
// today's dataset case with the same id when there is one (so a fixed gold is
// rescored with the fix; the change shows in the gold fingerprint), else the
// fields recorded in the report.
//
// Per repetition the recorded attempts are REPLAYED through the product loop's
// decisions: each attempt's SQL is re-validated in the real prompt context
// (master-data candidates re-resolved from the primary fixture, the response's
// recorded tables_used), and the first accepted attempt is re-executed and
// re-scored on every fixture (scoreAgainstGold); its primary-fixture run
// stands for the product loop's execution. Attempts after it are dropped (the
// product loop would have stopped). If no recorded attempt is accepted now
// although the original run ended in an executed answer, the product loop
// would have asked the model again; that retry cannot be replayed, so the
// repetition is flagged `rescore.replayTruncated`.
//
// Kept as recorded: LLM usage, cost and timings (nothing is re-generated),
// and repetitions that never reached the model (skipped_budget, harness
// errors). Runs that were cut short (aborted, infra_error) keep their status
// unless a recorded attempt now completes. Rescoring the same report twice
// gives identical results: validation and execution durations are not
// re-measured (null), and all statistics are seeded.

import { classifyBenchmarkStatus, collectBenchmarkWarnings, listGoldVariants, normalizeBenchmarkCase } from '../benchmark.js';
import { validateSqlSafety } from '../pipeline.js';
import { executeGoldSql, GOLD_STATEMENT_TIMEOUT_MS, GoldSqlError, scoreAgainstGold } from './oracle.js';

const STAGE_STATUS = { llm: 'llm_error', validation: 'validation_error', execution: 'execution_error', infra: 'infra_error' };
const EXECUTED_STATUSES = new Set(['pass', 'result_mismatch', 'retrieval_miss']);
const KEPT_STATUSES = new Set(['skipped_budget', 'evaluation_error']);
const CUT_SHORT_STATUSES = new Set(['aborted', 'infra_error']);

const CASE_FIELDS = [
  'id',
  'intentId',
  'question',
  'canonicalQuestion',
  'difficulty',
  'tags',
  'split',
  'expected_sql',
  'alternative_expected_sql',
  'expected_tables',
  'expected_columns',
  'disallowed_columns',
  'signal_checks',
  'comparison',
  'expected_row_counts',
  'failure_class',
];

/** A normalized test case rebuilt from a report's result record. */
export function testCaseFromRecord(record) {
  const raw = {};
  for (const field of CASE_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      raw[field] = record[field];
    }
  }
  return normalizeBenchmarkCase(raw);
}

/** The repetitions recorded for a result (a pre-runner report has one, the result itself). */
export function recordedRepetitions(record) {
  if (Array.isArray(record.repetitions) && record.repetitions.length > 0) {
    return record.repetitions;
  }
  return [{ ...record, repetition: 1 }];
}

function stripAttribution(repetition) {
  const { outcome, bucket, counted, outcome_tags: outcomeTags, ...rest } = repetition;
  void outcome;
  void bucket;
  void counted;
  void outcomeTags;
  return rest;
}

function goldErrorRepetition(repetition, error) {
  return {
    ...stripAttribution(repetition),
    status: 'expected_sql_error',
    warnings: [],
    error: error.message,
    error_stage: 'gold',
    error_code: error.cause?.code || error.code || null,
    oracle: null,
    rescore: { replayed: false, reason: 'gold failed', originalStatus: repetition.status },
  };
}

async function checkGold(testCase, { connections, goldCache, goldTimeoutMs }) {
  for (const variant of listGoldVariants(testCase)) {
    for (const fixtureConnection of connections) {
      await executeGoldSql(fixtureConnection, variant.sql, { goldCache, timeoutMs: goldTimeoutMs, label: variant.label });
    }
  }
}

/**
 * Replays one recorded repetition (see the file comment). `validate` is a
 * createValidatorProbe() (src/eval/verify.js) built on the primary fixture.
 */
export async function rescoreRepetition(repetition, {
  testCase,
  connections,
  goldCache,
  schema,
  validate,
  statementTimeoutMs = null,
  goldTimeoutMs = GOLD_STATEMENT_TIMEOUT_MS,
  maxAttempts = 2,
  score = scoreAgainstGold,
}) {
  const recorded = stripAttribution(repetition);
  const originalStatus = recorded.status;
  const attempts = [...(recorded.attempts || [])].sort((left, right) => left.attempt - right.attempt);
  if (KEPT_STATUSES.has(originalStatus) || attempts.length === 0) {
    return { ...recorded, rescore: { replayed: false, reason: 'no recorded generation to replay', originalStatus } };
  }

  const prompt = await validate.promptFor(testCase.question);
  const replayed = [];
  let final = null;
  let lastFailure = null;
  let stoppedOnInfra = false;

  for (const attempt of attempts) {
    const sql = attempt.generatedSql;
    if (!sql) {
      replayed.push(attempt);
      lastFailure = { stage: 'llm', code: attempt.llm?.code ?? null, message: attempt.llm?.error?.message || 'LLM call failed' };
      continue;
    }
    const rejection = await validate(testCase.question, sql, { tablesUsed: attempt.llm?.tablesUsed ?? null });
    if (rejection) {
      replayed.push({
        ...attempt,
        validation: { ok: false, durationMs: null, code: rejection.code, layer: rejection.layer, message: rejection.message },
        execution: null,
      });
      lastFailure = { stage: 'validation', code: rejection.code, message: rejection.message };
      continue;
    }
    const safety = validateSqlSafety(sql, prompt.allowedTables);
    let result;
    try {
      result = await score({
        testCase,
        predictedSql: safety.sql,
        connections,
        goldCache,
        timeoutMs: statementTimeoutMs,
        goldTimeoutMs,
        schema,
      });
    } catch (error) {
      if (error instanceof GoldSqlError) {
        return goldErrorRepetition(recorded, error);
      }
      throw error;
    }
    const validation = { ok: true, durationMs: null, tablesUsed: safety.tablesUsed };
    const primary = result.perFixture[0];
    if (primary?.error) {
      const stage = primary.error.infra ? 'infra' : 'execution';
      replayed.push({
        ...attempt,
        validation,
        execution: { ok: false, durationMs: null, stage, code: primary.error.code, message: primary.error.message },
      });
      lastFailure = { stage, code: primary.error.code, message: primary.error.message };
      if (stage === 'infra') {
        stoppedOnInfra = true;
        break;
      }
      continue;
    }
    replayed.push({
      ...attempt,
      validation,
      execution: { ok: true, durationMs: null, rowCount: primary.actualRowCount, truncated: primary.truncated },
    });
    final = { sql: safety.sql, score: result };
    break;
  }

  const base = {
    ...recorded,
    retrieved_tables: prompt.allowedTables,
    master_data_candidates: prompt.masterDataCandidates || [],
    attempts: replayed,
    attempt_count: replayed.length,
  };
  delete base.error;
  delete base.error_stage;
  delete base.error_code;
  delete base.timed_out;

  const rescore = {
    replayed: true,
    originalStatus,
    originalAttemptCount: recorded.attempt_count ?? attempts.length,
    replayTruncated: false,
  };

  if (final) {
    const { score: result } = final;
    const status = result.match
      ? 'pass'
      : result.infraError
        ? 'infra_error'
        : classifyBenchmarkStatus({ rowsMatch: false, expectedTables: testCase.expected_tables, retrievedTables: prompt.allowedTables });
    return {
      ...base,
      status,
      warnings: collectBenchmarkWarnings({
        rowsMatch: status === 'pass',
        signalWarnings: result.signalWarnings,
        disallowedColumnsUsed: result.disallowedWarnings,
      }),
      generated_sql: final.sql,
      oracle: {
        matched_gold: result.matchedGold,
        reason: result.reason,
        per_fixture: result.perFixture,
        killed_on: result.killedOn,
        assignment: result.assignment,
      },
      signal_warnings: result.signalWarnings,
      disallowed_column_warnings: result.disallowedWarnings,
      expected_rows_preview: result.preview?.gold || [],
      actual_rows_preview: result.preview?.actual || [],
      rescore,
    };
  }

  const lastSql = [...replayed].reverse().find((attempt) => attempt.generatedSql)?.generatedSql || recorded.generated_sql || '';
  const noAnswer = {
    ...base,
    warnings: [],
    generated_sql: lastSql,
    oracle: null,
    signal_warnings: [],
    disallowed_column_warnings: [],
    expected_rows_preview: [],
    actual_rows_preview: [],
  };

  if (CUT_SHORT_STATUSES.has(originalStatus) && !stoppedOnInfra) {
    // What happened after the cut is unknown: keep the recorded outcome.
    return {
      ...noAnswer,
      status: originalStatus,
      error: recorded.error,
      error_stage: recorded.error_stage,
      error_code: recorded.error_code,
      ...(recorded.timed_out ? { timed_out: true } : {}),
      rescore,
    };
  }

  rescore.replayTruncated = EXECUTED_STATUSES.has(originalStatus) && replayed.length < maxAttempts;
  const stage = lastFailure?.stage || 'execution';
  const keepOutage = stage === 'llm' && originalStatus === 'llm_error';
  return {
    ...noAnswer,
    status: STAGE_STATUS[stage] || 'execution_error',
    error: keepOutage ? recorded.error : lastFailure?.message || 'Unknown failure',
    error_stage: stage,
    error_code: keepOutage ? recorded.error_code : lastFailure?.code ?? null,
    rescore,
  };
}

/**
 * Rescores every case of a report. `currentCases` maps id -> today's
 * normalized case. Returns [{ entry: { testCase, datasets }, repetitions,
 * caseSource }] in report order, ready for the runner's attribution step.
 */
export async function rescoreReportCases(report, {
  currentCases = new Map(),
  connections,
  goldCache,
  schema,
  validate,
  statementTimeoutMs = null,
  goldTimeoutMs = GOLD_STATEMENT_TIMEOUT_MS,
  maxAttempts = null,
  score = scoreAgainstGold,
  onCase = null,
}) {
  const attemptsBudget = maxAttempts ?? (Number.isInteger(report?.oracle?.maxRetries) ? report.oracle.maxRetries + 1 : 2);
  const rescored = [];
  for (const record of report?.results || []) {
    const current = currentCases.get(record.id);
    const testCase = current || testCaseFromRecord(record);
    const repetitions = recordedRepetitions(record);
    let goldError = null;
    try {
      await checkGold(testCase, { connections, goldCache, goldTimeoutMs });
    } catch (error) {
      if (!(error instanceof GoldSqlError)) {
        throw error;
      }
      goldError = error;
    }
    const results = [];
    for (const repetition of repetitions) {
      results.push(
        goldError
          ? goldErrorRepetition(repetition, goldError)
          : await rescoreRepetition(repetition, {
              testCase,
              connections,
              goldCache,
              schema,
              validate,
              statementTimeoutMs,
              goldTimeoutMs,
              maxAttempts: attemptsBudget,
              score,
            })
      );
    }
    rescored.push({ entry: { testCase, datasets: record.datasets || [] }, repetitions: results, caseSource: current ? 'current dataset' : 'recorded' });
    if (onCase) {
      await onCase({ id: record.id, repetitions: results });
    }
  }
  return rescored;
}
