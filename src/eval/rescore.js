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
// stands for the product loop's execution. Attempts after it are not part of
// the replay (the product loop would have stopped), but their SQL is still
// re-validated and, when accepted, re-scored, and recorded in
// `rescore.laterAttempts`, so a validator or oracle change is visible on every
// recorded SQL. Every recorded attempt stays in `attempts`: the replayed ones
// are marked `replay: 'reached'` (with today's validation and execution), the
// others `replay: 'not_reached'` with their SQL and LLM details as recorded,
// no validation or execution of today, and the recorded verdicts kept apart
// in `recorded: { validation, execution }`. So a rescore of a rescore can
// still replay a retry the first replay did not reach, and `attempt_count`
// and the LLM-call statistics stay those of the original run (the cost and
// tokens are). If no recorded attempt is accepted now although the original
// run ended in an executed answer, the product loop would have asked the model
// again; that retry cannot be replayed, so the repetition is flagged
// `rescore.replayTruncated`.
//
// Validation follows today's product configuration (SCHEMA_SCOPE, through
// the validator probe): under the full scope a recorded TABLE_SCOPE rejection
// of an in-scope table is accepted and the SQL runs; under the retrieved
// scope with widen-on-demand, the attempt after such a rejection is judged
// against the widened prompt, as the product loop would have widened it for
// the retry (`widened_tables`, `rescore.widenedTables`). The recorded retry
// was still generated from the narrower prompt: only decisions are replayed.
//
// Recorded verdicts are never carried over: a replayed attempt loses its
// recorded `guardrailCheck`, and attribution re-checks every attempt that a
// guardrail rejects TODAY (attribution.js). Otherwise a rejection that today's
// validator no longer makes would still count as a false rejection.
//
// Kept as recorded: LLM usage, cost and timings (nothing is re-generated),
// and repetitions that never reached the model or were cut off by a stopped
// run (skipped_budget, cancelled, harness errors). Runs that were cut short (aborted, infra_error) keep their status
// unless a recorded attempt now completes; such recorded outcomes (and
// recorded provider outages) are flagged `rescore.inherited`, so they do not
// make a rescore exit as a harness failure today. Abstain / clarify cases are
// not replayed (there is no gold; their outcome depends only on whether the
// recorded run produced SQL) and are flagged inherited. Rescoring the same report twice
// gives identical results: validation and execution durations are not
// re-measured (null), and all statistics are seeded.

import { classifyBenchmarkStatus, collectBenchmarkWarnings, isBehaviorCase, listGoldVariants, normalizeBenchmarkCase } from '../benchmark.js';
import { tablesToWidenFor, validateSqlSafety } from '../pipeline.js';
import { isEvalInfraError } from './infra-errors.js';
import { executeGoldSql, GOLD_STATEMENT_TIMEOUT_MS, GoldSqlError, scoreAgainstGold } from './oracle.js';
import { withoutCaseFields } from './runner.js';

const STAGE_STATUS = { llm: 'llm_error', validation: 'validation_error', execution: 'execution_error', infra: 'infra_error' };
const EXECUTED_STATUSES = new Set(['pass', 'result_mismatch', 'retrieval_miss']);
const KEPT_STATUSES = new Set(['skipped_budget', 'cancelled', 'evaluation_error']);
const CUT_SHORT_STATUSES = new Set(['aborted', 'infra_error']);

export const CASE_FIELDS = [
  'id',
  'intentId',
  'question',
  'canonicalQuestion',
  'difficulty',
  'tags',
  'split',
  'expected_behavior',
  'known_validator_rejection',
  'expected_sql',
  'alternative_expected_sql',
  'expected_tables',
  'expected_columns',
  'disallowed_columns',
  'signal_checks',
  'comparison',
  'expected_row_counts',
  // The older single pin (seed only), kept when a record carries it.
  'expected_row_count',
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

/**
 * The repetitions recorded for a result (a pre-runner report has one, the
 * result itself, without its case fields: the rescore judges and records
 * today's case definition, never the recorded one).
 */
export function recordedRepetitions(record) {
  if (Array.isArray(record.repetitions) && record.repetitions.length > 0) {
    return record.repetitions;
  }
  return [{ ...withoutCaseFields(record), repetition: 1 }];
}

/**
 * The SQL a repetition ended with as its attempts recorded it: the last
 * non-empty generatedSql, or ''. A compact report (compact-report.js) leaves
 * out a repetition's generated_sql when it equals this.
 */
export function finalAttemptSql(repetition) {
  const last = [...(repetition?.attempts || [])].reverse().find((attempt) => String(attempt?.generatedSql || '').trim() !== '');
  return last ? last.generatedSql : '';
}

/**
 * A compact report (compact-report.js) stores the usage and cost of a
 * repetition's only LLM call once, at the repetition, and names the call in
 * `llm_usage_attempt`. Returns the repetition with the call's copy put back
 * and the mark removed (the repetition itself when it has no mark).
 */
export function restoreSharedCallUsage(repetition) {
  if (repetition?.llm_usage_attempt === undefined) {
    return repetition;
  }
  const { llm_usage_attempt: attemptNumber, ...rest } = repetition;
  rest.attempts = (rest.attempts || []).map((attempt) => {
    if (attempt?.attempt !== attemptNumber || !attempt.llm) {
      return attempt;
    }
    const cost = rest.llm_cost ? { totalCost: rest.llm_cost.totalCost } : null;
    return { ...attempt, llm: { ...attempt.llm, usage: rest.llm_usage ?? null, cost } };
  });
  return rest;
}

// The recorded repetition without its attribution, and with generated_sql
// and a shared call usage restored when a compact report left them out.
function stripAttribution(repetition) {
  const { outcome, bucket, counted, outcome_tags: outcomeTags, ...rest } = restoreSharedCallUsage(repetition);
  void outcome;
  void bucket;
  void counted;
  void outcomeTags;
  if (rest.generated_sql === undefined) {
    rest.generated_sql = finalAttemptSql(rest);
  }
  return rest;
}

// A recorded attempt without the verdicts attribution added to it.
function withoutRecordedVerdicts(attempt) {
  const { guardrailCheck: _stale, ...rest } = attempt;
  void _stale;
  return rest;
}

// An attempt as the report being rescored recorded it: a previous rescore's
// replay mark is dropped, and an attempt that replay did not reach gets its
// recorded validation and execution back.
function asRecordedAttempt(attempt) {
  const { replay, recorded, ...rest } = attempt;
  if (replay === 'not_reached' && recorded) {
    return { ...rest, validation: recorded.validation ?? null, execution: recorded.execution ?? null };
  }
  return rest;
}

// A recorded attempt the replay did not reach: kept whole, without a verdict
// of today; what was recorded about it is under `recorded`.
function notReachedAttempt(attempt) {
  const { validation = null, execution = null, ...rest } = withoutRecordedVerdicts(attempt);
  return { ...rest, replay: 'not_reached', validation: null, execution: null, recorded: { validation, execution } };
}

function goldErrorRepetition(repetition, error) {
  return {
    ...stripAttribution(repetition),
    status: 'expected_sql_error',
    warnings: [],
    error: error.message,
    error_stage: 'gold',
    error_code: error.cause?.code || error.code || null,
    error_infra: isEvalInfraError(error.cause || error),
    oracle: null,
    rescore: { replayed: false, reason: 'gold failed', originalStatus: repetition.status },
  };
}

/**
 * Today's verdict on a recorded attempt that the replay did not reach:
 * { attempt, validation: { ok, code?, layer? }, oracle: { match, matchedGold,
 * reason } | null, error? }. Never part of the repetition's outcome.
 */
async function judgeLaterAttempt(attempt, { testCase, prompt, extraTables, validate, score, connections, goldCache, schema, statementTimeoutMs, goldTimeoutMs }) {
  const sql = attempt.generatedSql;
  if (!sql) {
    return { attempt: attempt.attempt, validation: null, oracle: null };
  }
  const rejection = await validate(testCase.question, sql, { tablesUsed: attempt.llm?.tablesUsed ?? null, extraTables });
  if (rejection) {
    return { attempt: attempt.attempt, validation: { ok: false, code: rejection.code, layer: rejection.layer }, oracle: null };
  }
  try {
    const safety = validateSqlSafety(sql, prompt.allowedTables);
    const result = await score({ testCase, predictedSql: safety.sql, connections, goldCache, timeoutMs: statementTimeoutMs, goldTimeoutMs, schema });
    return {
      attempt: attempt.attempt,
      validation: { ok: true },
      oracle: { match: result.match, matchedGold: result.matchedGold, reason: result.reason },
    };
  } catch (error) {
    return { attempt: attempt.attempt, validation: { ok: true }, oracle: null, error: error.message };
  }
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
  if (isBehaviorCase(testCase)) {
    // No gold to re-score against: whether the recorded run produced SQL is
    // all an abstain / clarify case is judged on, and that does not change.
    return {
      ...recorded,
      rescore: {
        replayed: false,
        reason: `${testCase.expected_behavior} case: judged on whether the recorded run produced SQL, which a rescore cannot change`,
        originalStatus,
        inherited: true,
      },
    };
  }
  const attempts = (recorded.attempts || []).map(asRecordedAttempt).sort((left, right) => left.attempt - right.attempt);
  if (KEPT_STATUSES.has(originalStatus) || attempts.length === 0) {
    // A recorded gold failure whose gold passes today (this function only runs
    // after the gold check) was never sent to the model: nothing to replay,
    // but say that the recorded reason is gone.
    const staleGoldError = originalStatus === 'expected_sql_error';
    return {
      ...recorded,
      rescore: {
        replayed: false,
        reason: staleGoldError ? 'the gold failed in the recording but passes today; no generation to replay' : 'no recorded generation to replay',
        originalStatus,
        inherited: true,
        ...(staleGoldError ? { staleGoldError: true } : {}),
      },
    };
  }

  let prompt;
  try {
    prompt = await validate.promptFor(testCase.question);
  } catch (error) {
    if (!isEvalInfraError(error)) {
      throw error;
    }
    // The master-data lookup failed on the database: the prompt context (and
    // so every guardrail decision) is unknown, as in the product loop's
    // 'infra' stage.
    return {
      ...recorded,
      status: 'infra_error',
      warnings: [],
      error: `Master-data lookup failed: ${error.message}`,
      error_stage: 'infra',
      error_code: error.code || null,
      oracle: null,
      rescore: { replayed: false, reason: 'master-data lookup failed on the database', originalStatus, inherited: false },
    };
  }
  const replayed = [];
  let final = null;
  let lastFailure = null;
  let stoppedOnInfra = false;
  // Widen-on-demand (retrieved scope): after a TABLE_SCOPE rejection of an
  // in-scope table the product loop retries with that table in the prompt and
  // the allow-list, so the next recorded attempt is judged against the
  // widened prompt. (The recorded retry was generated from the narrower
  // prompt; only the product's decisions are replayed.)
  let extraTables = [];
  const widenedTables = [];

  let finalIndex = -1;
  for (const [index, recordedAttempt] of attempts.entries()) {
    const attempt = withoutRecordedVerdicts(recordedAttempt);
    const sql = attempt.generatedSql;
    if (!sql) {
      replayed.push(attempt);
      lastFailure = { stage: 'llm', code: attempt.llm?.code ?? null, message: attempt.llm?.error?.message || 'LLM call failed' };
      continue;
    }
    const rejection = await validate(testCase.question, sql, { tablesUsed: attempt.llm?.tablesUsed ?? null, extraTables });
    if (rejection) {
      replayed.push({
        ...attempt,
        validation: { ok: false, durationMs: null, code: rejection.code, layer: rejection.layer, message: rejection.message },
        execution: null,
      });
      lastFailure = { stage: 'validation', code: rejection.code, message: rejection.message };
      const scope = prompt.schemaScope;
      if (index < attempts.length - 1 && scope?.effective === 'retrieved' && scope.widenOnDemand) {
        const toAdd = tablesToWidenFor(rejection, sql, { schema, allowedTables: prompt.allowedTables });
        if (toAdd.length > 0) {
          extraTables = [...extraTables, ...toAdd];
          widenedTables.push(...toAdd);
          prompt = await validate.promptFor(testCase.question, { extraTables });
        }
      }
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
    finalIndex = index;
    break;
  }

  // Recorded attempts after the replay's final one: judged, not replayed.
  const laterAttempts = [];
  if (finalIndex >= 0) {
    for (const attempt of attempts.slice(finalIndex + 1)) {
      laterAttempts.push(
        await judgeLaterAttempt(attempt, {
          testCase,
          prompt,
          extraTables,
          validate,
          score,
          connections,
          goldCache,
          schema,
          statementTimeoutMs,
          goldTimeoutMs,
        })
      );
    }
  }

  // Every loop step above replays exactly one attempt, so the rest were not
  // reached (after the final one, or after an infrastructure stop).
  const notReached = attempts.slice(replayed.length).map(notReachedAttempt);
  const base = {
    ...recorded,
    retrieved_tables: prompt.allowedTables,
    ...(prompt.context?.retrieval?.expandedTableNames ? { ranked_tables: prompt.context.retrieval.expandedTableNames } : {}),
    master_data_candidates: prompt.masterDataCandidates || [],
    attempts: [...replayed.map((attempt) => ({ ...attempt, replay: 'reached' })), ...notReached],
    // The original run's attempts (and LLM calls); the replay's are counted in
    // rescore.replayedAttemptCount.
    attempt_count: recorded.attempt_count ?? attempts.length,
  };
  delete base.error;
  delete base.error_stage;
  delete base.error_code;
  delete base.timed_out;
  delete base.late_status;
  delete base.widened_tables;
  if (widenedTables.length > 0) {
    base.widened_tables = prompt.schemaScope?.widenedTables || widenedTables;
  }

  const rescore = {
    replayed: true,
    originalStatus,
    originalAttemptCount: recorded.attempt_count ?? attempts.length,
    replayedAttemptCount: replayed.length,
    replayTruncated: false,
    // True when the outcome is the recording's (a run cut short, a provider
    // outage), not something the replay found today.
    inherited: false,
    ...(laterAttempts.length ? { laterAttempts } : {}),
    ...(widenedTables.length ? { widenedTables: base.widened_tables } : {}),
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
      rescore: { ...rescore, inherited: true },
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
    rescore: { ...rescore, inherited: keepOutage },
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
