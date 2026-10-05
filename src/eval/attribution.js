// Failure attribution: WHO caused a failed repetition. The benchmark status
// says where the product loop stopped; attribution says whether that was the
// model's fault, the system's (a guardrail rejecting correct SQL, retrieval
// hiding a table the answer needs), the infrastructure's, or no one's (budget,
// broken gold). Without it a guardrail false rejection, a gold error and a
// model error all count the same (audit finding C3).
//
// Outcomes (per repetition) and their buckets:
//   pass                        pass
//   wrong_result                model   (final SQL ran; the oracle rejects it)
//   guardrail_true_rejection    model   (guardrail rejected SQL that is wrong)
//   safety_rejection            model   (layer-1 safety rejection; never run)
//   execution_error             model   (final SQL failed in MariaDB)
//   llm_error                   model   (truncated/refused/unparseable output)
//   guardrail_false_rejection   system  (a guardrail rejected SQL that matches
//                                        the gold on every fixture, in ANY
//                                        attempt of a repetition that would
//                                        otherwise be a model failure; a
//                                        repetition that ended in another
//                                        non-pass outcome keeps it and is
//                                        tagged guardrail_false_rejection)
//   ... + tag retrieval_miss    system  (a model-bucket failure where an
//                                        expected table was not retrieved:
//                                        the retrieved set is the allow-list)
//   timeout / aborted           infra   (case deadline; counted as a failure)
//   infra_error                 infra   (excluded from accuracy; also a gold
//                                        query that failed because the
//                                        database went away, and a model-bucket
//                                        failure whose guardrail rejection
//                                        could not be re-checked because the
//                                        database failed: it might have been a
//                                        false rejection)
//   llm_outage                  infra   (llm_error from a provider outage:
//                                        timeout, unreachable, 401/403/429/5xx;
//                                        excluded)
//   skipped_budget              skipped (excluded)
//   cancelled                   skipped (the run was stopped, by Ctrl-C or a
//                                        rejected API key, before this
//                                        repetition finished; excluded)
//   expected_sql_error          harness (gold failed; excluded)
//   harness_error               harness (the runner itself threw; excluded)
//
// Guardrail-rejected SQL is checked by re-running it: if it passes the layer-1
// safety check (validateSqlSafety) it runs read-only on every fixture through
// the oracle (scoreAgainstGold); a match makes the rejection false. A
// safety-layer rejection is never executed. A re-check that fails (the
// database went away) is never resolved in the model's disfavour: the
// repetition becomes infra_error (or harness_error for a non-infrastructure
// failure of the check), both excluded and both harness failures for the exit
// code.

import { findMissingExpectedTables } from '../benchmark.js';
import { validateSqlSafety } from '../pipeline.js';
import { isInfraError, isLlmUnavailableCode } from '../query-service.js';
import { scoreAgainstGold } from './oracle.js';

export const OUTCOME_BUCKETS = Object.freeze({
  pass: 'pass',
  wrong_result: 'model',
  guardrail_true_rejection: 'model',
  safety_rejection: 'model',
  execution_error: 'model',
  llm_error: 'model',
  guardrail_false_rejection: 'system',
  timeout: 'infra',
  aborted: 'infra',
  infra_error: 'infra',
  llm_outage: 'infra',
  skipped_budget: 'skipped',
  cancelled: 'skipped',
  expected_sql_error: 'harness',
  harness_error: 'harness',
});

// Outcomes left out of the strict-accuracy denominator (reported separately).
export const EXCLUDED_OUTCOMES = Object.freeze(new Set(['infra_error', 'llm_outage', 'skipped_budget', 'cancelled', 'expected_sql_error', 'harness_error']));

// Display order, also the tie-break when picking a case's majority outcome
// (earlier = preferred on a tie, so a tie never hides a failure behind pass).
export const OUTCOME_ORDER = Object.freeze([
  'guardrail_false_rejection',
  'wrong_result',
  'guardrail_true_rejection',
  'safety_rejection',
  'execution_error',
  'llm_error',
  'timeout',
  'aborted',
  'pass',
  'infra_error',
  'llm_outage',
  'expected_sql_error',
  'harness_error',
  'skipped_budget',
  'cancelled',
]);

export const BUCKET_ORDER = Object.freeze(['pass', 'model', 'system', 'infra', 'skipped', 'harness']);

// Failures a missing retrieved table can explain.
const RETRIEVAL_SENSITIVE = new Set(['wrong_result', 'guardrail_true_rejection', 'safety_rejection', 'execution_error']);

function finalAttempt(repetition) {
  const attempts = repetition.attempts || [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

// Connection-level failures the product loop does not classify as infra yet,
// but that say nothing about the SQL either.
const EXTRA_INFRA_CODES = new Set(['ER_CONNECTION_KILLED']);

/**
 * True for a database failure that is the infrastructure's, not the SQL's:
 * the product loop's predicate (connection/pool/auth codes, mysql2's fatal
 * flag) plus a few codes it does not cover.
 */
export function isEvalInfraError(error) {
  return Boolean(error) && (isInfraError(error) || EXTRA_INFRA_CODES.has(error.code));
}

// An attempt that a guardrail rejected, as recorded in its CURRENT validation
// (a rescore re-validates attempts; a verdict only counts while the rejection
// it judged still stands).
function isGuardrailRejected(attempt) {
  return attempt?.validation?.ok === false && attempt.validation.layer === 'guardrail';
}

/**
 * Attribution of one repetition (an evaluateQuestion result, possibly with
 * attempts annotated by checkGuardrailRejections). Returns
 * { outcome, bucket, counted, outcome_tags }.
 */
export function classifyRepetition(repetition, testCase = {}) {
  const status = repetition?.status;
  const tags = [];
  let outcome;

  switch (status) {
    case 'pass':
      outcome = 'pass';
      break;
    case 'skipped_budget':
      outcome = 'skipped_budget';
      break;
    case 'cancelled':
      outcome = 'cancelled';
      break;
    case 'expected_sql_error':
      // A gold query that failed because the database went away is an
      // infrastructure failure, not a broken gold. `error_infra` is recorded
      // by evaluateQuestion / rescore (mysql2's fatal errors carry no code).
      outcome = repetition.error_infra === true || isEvalInfraError({ code: repetition.error_code }) ? 'infra_error' : 'expected_sql_error';
      if (repetition.rescore?.staleGoldError) {
        tags.push('gold_passes_now');
      }
      break;
    case 'evaluation_error':
      outcome = 'harness_error';
      break;
    case 'infra_error':
      outcome = 'infra_error';
      break;
    case 'aborted':
      outcome = repetition.timed_out || repetition.error_code === 'CASE_TIMEOUT' ? 'timeout' : 'aborted';
      break;
    case 'llm_error':
      outcome = isLlmUnavailableCode(repetition.error_code) ? 'llm_outage' : 'llm_error';
      break;
    case 'validation_error': {
      const validation = finalAttempt(repetition)?.validation;
      outcome = validation?.layer === 'guardrail' ? 'guardrail_true_rejection' : 'safety_rejection';
      break;
    }
    case 'execution_error':
      outcome = 'execution_error';
      break;
    case 'result_mismatch':
    case 'retrieval_miss':
      outcome = 'wrong_result';
      break;
    default:
      outcome = 'harness_error';
      tags.push(`unknown_status:${status}`);
  }

  // Verdicts of the guardrail rejections that stand today (see
  // checkGuardrailRejections).
  const verdicts = (repetition.attempts || []).filter(isGuardrailRejected).map((attempt) => attempt.guardrailCheck || null);
  const falselyRejected = verdicts.some((check) => check?.verdict === 'false_rejection');
  const checkFailed = verdicts.filter((check) => check?.verdict === 'error');
  if (verdicts.some((check) => check?.verdict === 'unsafe')) {
    tags.push('guardrail_unsafe');
  }
  if (verdicts.some((check) => !check)) {
    tags.push('guardrail_unchecked');
  }

  if (outcome !== 'pass' && falselyRejected) {
    if (OUTCOME_BUCKETS[outcome] === 'model') {
      // A correct answer thrown away by a guardrail is the system's failure
      // even when a later (wrong) retry is what the repetition ended with.
      outcome = 'guardrail_false_rejection';
    } else {
      // E.g. the retry after the false rejection hit a provider outage: the
      // outcome stays (excluded or infra), the false rejection is reported.
      tags.push('guardrail_false_rejection');
    }
  } else if (OUTCOME_BUCKETS[outcome] === 'model' && checkFailed.length > 0) {
    // A rejection that could not be re-checked might have been a false one:
    // never charge it to the model.
    tags.push('guardrail_unverified');
    outcome = checkFailed.some((check) => check.infra !== false) ? 'infra_error' : 'harness_error';
  }

  let bucket = OUTCOME_BUCKETS[outcome];
  if (RETRIEVAL_SENSITIVE.has(outcome)) {
    const missing = findMissingExpectedTables(testCase.expected_tables, repetition.retrieved_tables || []);
    if (missing.length > 0 && (repetition.retrieved_tables || []).length > 0) {
      tags.push('retrieval_miss');
      bucket = 'system';
    }
  }
  if (repetition.rescore?.replayTruncated) {
    tags.push('replay_truncated');
  }

  return { outcome, bucket, counted: !EXCLUDED_OUTCOMES.has(outcome), outcome_tags: tags };
}

/** Adds { outcome, bucket, counted, outcome_tags } to a repetition (new object). */
export function attributeRepetition(repetition, testCase) {
  return { ...repetition, ...classifyRepetition(repetition, testCase) };
}

function pickMajority(outcomes) {
  const counts = new Map();
  for (const outcome of outcomes) {
    counts.set(outcome, (counts.get(outcome) || 0) + 1);
  }
  let best = null;
  for (const outcome of OUTCOME_ORDER) {
    const count = counts.get(outcome) || 0;
    if (count > 0 && (best === null || count > counts.get(best))) {
      best = outcome;
    }
  }
  return best;
}

/**
 * Per-case summary over attributed repetitions: pass rate over the counted
 * repetitions, majority pass (more than half passed), and the case's
 * representative outcome (the most frequent counted outcome; ties go to the
 * failure listed first in OUTCOME_ORDER).
 */
export function summarizeCaseRepetitions(repetitions) {
  const list = repetitions || [];
  const counted = list.filter((repetition) => repetition.counted);
  const passes = counted.filter((repetition) => repetition.outcome === 'pass').length;
  const pool = counted.length > 0 ? counted : list;
  const outcome = pickMajority(pool.map((repetition) => repetition.outcome));
  const representative = pool.find((repetition) => repetition.outcome === outcome) || null;
  const tags = [...new Set(pool.filter((repetition) => repetition.outcome === outcome).flatMap((repetition) => repetition.outcome_tags || []))].sort();
  return {
    repetitions: list.length,
    counted: counted.length,
    passes,
    passRate: counted.length ? Number((passes / counted.length).toFixed(4)) : null,
    majorityPass: counted.length ? passes * 2 > counted.length : null,
    outcome,
    bucket: representative?.bucket || (outcome ? OUTCOME_BUCKETS[outcome] : null),
    tags,
    outcomes: Object.fromEntries(OUTCOME_ORDER.filter((name) => list.some((repetition) => repetition.outcome === name)).map((name) => [name, list.filter((repetition) => repetition.outcome === name).length])),
  };
}

function firstInfraMessage(result) {
  return (result.perFixture || []).find((entry) => entry.error?.infra)?.error.message || 'infrastructure error while re-running the SQL';
}

/**
 * Re-checks every guardrail-layer rejection of a repetition: the SQL must pass
 * the layer-1 safety check, then runs read-only on every fixture through the
 * oracle. Each such attempt gets `guardrailCheck`:
 *   { verdict: 'false_rejection' | 'true_rejection', matchedGold, reason, killedOn }
 *   { verdict: 'unsafe', code }      (fails validateSqlSafety now; never run)
 *   { verdict: 'error', infra, message }  (the re-check failed: infra true for
 *                                    a database failure, false otherwise)
 * Safety-layer rejections are never executed. `cache` (a Map) shares checks
 * of identical SQL across repetitions of the same case.
 */
export async function checkGuardrailRejections(repetition, {
  testCase,
  connections,
  goldCache,
  schema,
  timeoutMs = null,
  goldTimeoutMs,
  cache = null,
  score = scoreAgainstGold,
} = {}) {
  const attempts = repetition?.attempts || [];
  // A verdict belongs to the rejection it judged: drop any carried over on an
  // attempt that no guardrail rejects now.
  const withoutStaleChecks = (attempt) => {
    if (isGuardrailRejected(attempt) || !('guardrailCheck' in attempt)) {
      return attempt;
    }
    const { guardrailCheck: _stale, ...rest } = attempt;
    void _stale;
    return rest;
  };
  if (!attempts.some(isGuardrailRejected)) {
    return attempts.some((attempt) => 'guardrailCheck' in attempt) ? { ...repetition, attempts: attempts.map(withoutStaleChecks) } : repetition;
  }
  const allowedTables = (repetition.retrieved_tables || []).length > 0
    ? repetition.retrieved_tables
    : (schema?.tables || []).map((table) => table.tableName);

  const check = async (sql) => {
    try {
      validateSqlSafety(sql, allowedTables);
    } catch (error) {
      return { verdict: 'unsafe', code: error.code || null };
    }
    try {
      const result = await score({ testCase, predictedSql: sql, connections, goldCache, timeoutMs, goldTimeoutMs, schema });
      if (!result.match && result.infraError) {
        return { verdict: 'error', infra: true, message: result.executionError?.message || firstInfraMessage(result) };
      }
      return {
        verdict: result.match ? 'false_rejection' : 'true_rejection',
        matchedGold: result.matchedGold,
        reason: result.reason,
        killedOn: result.killedOn,
      };
    } catch (error) {
      // A gold query failing here (it passed before the run) is the database
      // going away; anything else is a harness failure.
      return { verdict: 'error', infra: isEvalInfraError(error.cause || error), message: error.message };
    }
  };

  const annotated = [];
  for (const attempt of attempts) {
    if (isGuardrailRejected(attempt) && attempt.generatedSql) {
      const key = `${testCase?.id}\u0000${attempt.generatedSql}`;
      let pending = cache?.get(key);
      if (!pending) {
        pending = check(attempt.generatedSql);
        cache?.set(key, pending);
      }
      annotated.push({ ...attempt, guardrailCheck: await pending });
    } else {
      annotated.push(withoutStaleChecks(attempt));
    }
  }
  return { ...repetition, attempts: annotated };
}

/**
 * Guardrail confusion matrix over EVERY attempt (retries included), with
 * "positive" = the guardrail rejected the SQL:
 *   tp: rejected & incorrect      fp: rejected & correct (false rejection)
 *   fn: accepted & incorrect      tn: accepted & correct
 * An accepted attempt that failed at execution (a retry followed) counts as
 * accepted & incorrect. Attempts whose correctness is unknown (infra failures,
 * unverified rejections) are counted in `unknown`; safety-layer rejections are
 * not guardrail decisions and are counted in `safetyRejections`.
 */
export function guardrailConfusion(caseRecords) {
  const matrix = { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0, safetyRejections: 0, attempts: 0 };
  // Why an attempt's correctness is unknown.
  const unknownBy = { unsafe: 0, checkFailed: 0, unchecked: 0, infra: 0, notFinal: 0 };
  for (const record of caseRecords || []) {
    for (const repetition of record.repetitions || []) {
      if (['skipped_budget', 'cancelled', 'expected_sql_error', 'evaluation_error'].includes(repetition.status)) {
        continue;
      }
      const attempts = repetition.attempts || [];
      attempts.forEach((attempt, index) => {
        const validation = attempt.validation;
        if (!validation) {
          return;
        }
        matrix.attempts += 1;
        const isFinal = index === attempts.length - 1;
        if (validation.ok === false) {
          if (validation.layer !== 'guardrail') {
            matrix.safetyRejections += 1;
            return;
          }
          const verdict = attempt.guardrailCheck?.verdict;
          if (verdict === 'true_rejection') {
            matrix.tp += 1;
          } else if (verdict === 'false_rejection') {
            matrix.fp += 1;
          } else {
            matrix.unknown += 1;
            unknownBy[verdict === 'unsafe' ? 'unsafe' : verdict === 'error' ? 'checkFailed' : 'unchecked'] += 1;
          }
          return;
        }
        if (attempt.execution?.ok === false) {
          if (attempt.execution.stage === 'infra') {
            matrix.unknown += 1;
            unknownBy.infra += 1;
          } else {
            matrix.fn += 1;
          }
          return;
        }
        if (isFinal && repetition.status === 'pass') {
          matrix.tn += 1;
        } else if (isFinal && (repetition.status === 'result_mismatch' || repetition.status === 'retrieval_miss')) {
          matrix.fn += 1;
        } else {
          matrix.unknown += 1;
          unknownBy[attempt.execution?.stage === 'infra' || ['infra_error', 'aborted'].includes(repetition.status) ? 'infra' : 'notFinal'] += 1;
        }
      });
    }
  }
  const ratio = (numerator, denominator) => (denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null);
  return {
    ...matrix,
    unknownBy,
    precision: ratio(matrix.tp, matrix.tp + matrix.fp),
    recall: ratio(matrix.tp, matrix.tp + matrix.fn),
    falseRejectionRate: ratio(matrix.fp, matrix.fp + matrix.tn),
  };
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key != null) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function ordered(counts, order) {
  return Object.fromEntries(order.filter((key) => counts[key]).map((key) => [key, counts[key]]));
}

/**
 * Attribution section of a report: outcome and bucket counts per repetition
 * and per case (majority outcome), the system-error breakdown, what was
 * excluded from accuracy, and the guardrail confusion matrix.
 */
export function summarizeAttribution(caseRecords) {
  const records = caseRecords || [];
  const repetitions = records.flatMap((record) => record.repetitions || []);
  const failed = repetitions.filter((repetition) => repetition.counted && repetition.outcome !== 'pass');
  return {
    repetitions: {
      total: repetitions.length,
      counted: repetitions.filter((repetition) => repetition.counted).length,
      byOutcome: ordered(countBy(repetitions, (repetition) => repetition.outcome), OUTCOME_ORDER),
      byBucket: ordered(countBy(repetitions, (repetition) => repetition.bucket), BUCKET_ORDER),
    },
    cases: {
      total: records.length,
      byOutcome: ordered(countBy(records, (record) => record.summary?.outcome), OUTCOME_ORDER),
      byBucket: ordered(countBy(records, (record) => record.summary?.bucket), BUCKET_ORDER),
    },
    // Outcome x bucket: a model outcome tagged retrieval_miss is a system error.
    byOutcomeBucket: Object.fromEntries(
      OUTCOME_ORDER.filter((outcome) => repetitions.some((repetition) => repetition.outcome === outcome)).map((outcome) => [
        outcome,
        ordered(
          countBy(repetitions.filter((repetition) => repetition.outcome === outcome), (repetition) => repetition.bucket),
          BUCKET_ORDER
        ),
      ])
    ),
    system: {
      guardrailFalseRejections: failed.filter((repetition) => repetition.outcome === 'guardrail_false_rejection').length,
      retrievalMisses: failed.filter((repetition) => (repetition.outcome_tags || []).includes('retrieval_miss')).length,
      // False rejections in repetitions that ended in another non-pass outcome
      // (an outage or timeout on the retry): reported, not in the counts above.
      guardrailFalseRejectionsElsewhere: repetitions.filter((repetition) => (repetition.outcome_tags || []).includes('guardrail_false_rejection')).length,
      // Model-bucket failures turned into infra/harness because a guardrail
      // re-check failed.
      guardrailUnverified: repetitions.filter((repetition) => (repetition.outcome_tags || []).includes('guardrail_unverified')).length,
    },
    excluded: ordered(
      countBy(repetitions.filter((repetition) => !repetition.counted), (repetition) => repetition.outcome),
      OUTCOME_ORDER
    ),
    guardrailConfusion: guardrailConfusion(records),
  };
}
