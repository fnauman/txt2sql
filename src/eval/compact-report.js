// Compact baseline: a report.json (report version 2) reduced to what its
// consumers read, for eval/baselines/<model>.json, which is committed.
//
// A full report records every repetition twice (the first one is also copied
// to the case's top level), row previews, explanations, assumptions,
// master-data candidates, per-fixture oracle verdicts and recorded guardrail
// re-checks: about 1 MB per repetition of the 255-case suite once indented.
// The consumers of a baseline need much less:
//
// - --compare / --gate (compare.js): per case id, question, intentId,
//   expected_behavior, gold_fingerprint, scoring_fingerprint and summary;
//   top-level model, generatedAt, provenance and mode;
// - --offline / --rescore (rescore.js): the case fields (CASE_FIELDS, to
//   rebuild a case that left the datasets), datasets, and per repetition its
//   status, error code/stage, attempt_count, llm_usage, llm_cost, timings and
//   attempts (each SQL, its LLM call's usage, cost, duration, tables_used and
//   failure, its validation and execution verdicts), which the replay
//   re-judges; top-level suite, runner, oracle, budget, provenance;
// - the statistics of a rescore (stats.js): llm_cost.totalCost, llm_usage
//   (prompt, completion, total, cached and reasoning tokens; a
//   provider-reported cost), timings, attempt_count and
//   each attempt's llm.durationMs and retry flag;
// - the dataset hygiene test: id and question of every recorded case.
//
// Case fields that normalizeBenchmarkCase defaults (null, empty, a canonical
// question equal to the question) are left out.
//
// A compact report keeps those plus the run's summaries (stats, attribution,
// behaviour, verification without per-case notes, the legacy totals) and is
// marked `compact: true` with `compactVersion`; it stays reportVersion 2, so
// every reader of a report reads it. Recorded verdicts that a rescore
// re-judges anyway (guardrailCheck), the oracle's per-fixture details, row
// previews, explanation and assumption text, master-data candidates and
// retrieved tables (both re-resolved by a rescore) and the previous
// comparison are dropped; costs keep their totals and usages the token
// counts the runner sums. The usage and cost of a repetition's only LLM call
// are stored once, at the repetition (`llm_usage_attempt` names the call;
// rescore.js restores the call's copy). The repetition's final SQL (generated_sql) is kept
// only when it is not its last attempt's SQL (rescore.js restores it). A rescore of a compact report gives the
// same outcomes and statistics as a rescore of the full one.

import fs from 'node:fs/promises';
import path from 'node:path';

import { CASE_FIELDS, finalAttemptSql } from './rescore.js';

export const COMPACT_REPORT_VERSION = 1;

// Top-level blocks kept as they are.
const TOP_LEVEL_FIELDS = [
  'reportVersion',
  'generatedAt',
  'runTimestamp',
  'mode',
  'model',
  'gitSha',
  'schemaPath',
  'dataset',
  'suite',
  'runner',
  'provenance',
  'oracle',
  'total',
  'passed',
  'failed',
  'accuracy',
  'accuracyScope',
  'aggregateAccuracy',
  'statusCounts',
  'warningCounts',
  'stats',
  'attribution',
  'behavior',
  'budget',
  'stopped',
  'rescoredFrom',
];

// Per case, besides CASE_FIELDS.
const CASE_EXTRA_FIELDS = ['datasets', 'gold_fingerprint', 'scoring_fingerprint', 'case_source', 'status', 'summary'];

// Per repetition, besides attempts (compacted) and generated_sql (when it is
// not the last attempt's SQL).
const REPETITION_FIELDS = [
  'repetition',
  'status',
  'outcome',
  'bucket',
  'counted',
  'behavior_counted',
  'outcome_tags',
  'warnings',
  'error',
  'error_stage',
  'error_code',
  'error_infra',
  'timed_out',
  'late_status',
  'attempt_count',
  'llm_usage',
  'llm_cost',
  'timings',
  'rescore',
  'llm_usage_attempt',
];

// An error message longer than this is cut (the code says what happened).
const MAX_MESSAGE_LENGTH = 300;

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) {
      out[field] = source[field];
    }
  }
  return out;
}

function shortMessage(message) {
  if (typeof message !== 'string' || message.length <= MAX_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

// Token usage as the runner sums it (pricing.js mergeUsage): the provider's
// other per-call breakdowns (audio, prediction tokens) are dropped; reasoning
// tokens are kept when there are any, and so is a provider-reported cost.
function compactUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return usage ?? null;
  }
  const out = pick(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined && cached !== null) {
    out.prompt_tokens_details = { cached_tokens: cached };
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number' && reasoning > 0) {
    out.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
    out.cost = usage.cost;
  }
  return out;
}

// A cost as its readers use it (the total; the token counts repeat the usage).
function compactCost(cost, fields) {
  if (!cost || typeof cost !== 'object') {
    return cost ?? null;
  }
  return pick(cost, fields);
}

function compactLlm(llm) {
  if (!llm) {
    return llm ?? null;
  }
  const out = pick(llm, ['ok', 'durationMs', 'usage', 'cost', 'tablesUsed', 'code']);
  if (out.usage !== undefined) {
    out.usage = compactUsage(out.usage);
  }
  if (out.cost !== undefined) {
    out.cost = compactCost(out.cost, ['totalCost']);
  }
  if (llm.error) {
    out.error = pick(llm.error, ['code', 'message']);
    if (out.error.message !== undefined) {
      out.error.message = shortMessage(out.error.message);
    }
  }
  return out;
}

function compactValidation(validation) {
  if (!validation) {
    return validation ?? null;
  }
  const out = pick(validation, ['ok', 'code', 'layer', 'message']);
  if (out.message !== undefined) {
    out.message = shortMessage(out.message);
  }
  return out;
}

function compactExecution(execution) {
  if (!execution) {
    return execution ?? null;
  }
  return pick(execution, ['ok', 'stage', 'code', 'rowCount', 'truncated']);
}

/** One recorded attempt without the fields no consumer reads (see the file comment). */
export function compactAttempt(attempt) {
  const out = {
    ...pick(attempt, ['attempt', 'retry', 'generatedSql']),
    llm: compactLlm(attempt.llm),
    validation: compactValidation(attempt.validation),
    execution: compactExecution(attempt.execution),
  };
  // A rescored report: the replay mark and the recorded verdicts of an
  // attempt the replay did not reach.
  if (attempt.replay !== undefined) {
    out.replay = attempt.replay;
  }
  if (attempt.recorded) {
    out.recorded = { validation: compactValidation(attempt.recorded.validation), execution: compactExecution(attempt.recorded.execution) };
  }
  return out;
}

// A repetition with one LLM call records the same usage and cost twice (the
// call's, and the repetition's sum of one). The call's copy is left out and
// `llm_usage_attempt` names the attempt it belongs to;
// restoreSharedCallUsage (rescore.js) puts it back. A repetition whose
// already-shared attempt is compacted again (idempotence) has no call with a
// usage left, so nothing changes.
function shareSingleCallUsage(repetition, attempts) {
  if (repetition.llm_usage_attempt !== undefined) {
    return;
  }
  const called = attempts.filter((attempt) => attempt.llm && (attempt.llm.usage !== undefined || attempt.llm.cost !== undefined));
  if (called.length !== 1) {
    return;
  }
  const [attempt] = called;
  const usage = attempt.llm.usage ?? null;
  const cost = attempt.llm.cost ?? null;
  const sameUsage = JSON.stringify(usage) === JSON.stringify(repetition.llm_usage ?? null);
  const sameCost =
    cost === null ? (repetition.llm_cost ?? null) === null : cost.totalCost !== undefined && cost.totalCost === repetition.llm_cost?.totalCost && Object.keys(cost).length === 1;
  if (!sameUsage || !sameCost || !Number.isInteger(attempt.attempt)) {
    return;
  }
  delete attempt.llm.usage;
  delete attempt.llm.cost;
  repetition.llm_usage_attempt = attempt.attempt;
}

function compactRepetition(repetition) {
  const out = pick(repetition, REPETITION_FIELDS);
  if (out.error !== undefined) {
    out.error = shortMessage(out.error);
  }
  if (out.llm_usage !== undefined) {
    out.llm_usage = compactUsage(out.llm_usage);
  }
  if (out.llm_cost !== undefined) {
    out.llm_cost = compactCost(out.llm_cost, ['totalCost']);
  }
  const attempts = (repetition.attempts || []).map(compactAttempt);
  shareSingleCallUsage(out, attempts);
  out.attempts = attempts;
  // Kept only when it is not the last attempt's SQL (a rescore restores it).
  if (repetition.generated_sql !== undefined && repetition.generated_sql !== finalAttemptSql({ attempts })) {
    out.generated_sql = repetition.generated_sql;
  }
  return out;
}

function compactVerification(verification) {
  if (!verification || typeof verification !== 'object') {
    return verification ?? null;
  }
  // Per-case notes (known rejections, behaviour cases) are dropped; problems,
  // warnings, gate failures, control statuses and the kill rates stay.
  const { notes, ...rest } = verification;
  return { ...rest, ...(Array.isArray(notes) ? { notesCount: notes.length } : {}) };
}

function compactReliability(reliability) {
  if (!reliability || typeof reliability !== 'object') {
    return reliability ?? null;
  }
  // The legacy pooled block without its per-case list (every case has a summary).
  const { perCase, ...rest } = reliability;
  void perCase;
  return rest;
}

// The case fields of a record (CASE_FIELDS) without the values
// normalizeBenchmarkCase fills in by itself (null, empty, a canonical question
// equal to the question), so testCaseFromRecord rebuilds the same case.
function compactCaseFields(record) {
  const out = {};
  for (const field of CASE_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    if (field === 'canonicalQuestion' && value === record.question) {
      continue;
    }
    out[field] = value;
  }
  return out;
}

/** True for a report written by compactReport. */
export function isCompactReport(report) {
  return report?.compact === true;
}

/**
 * The compact form of a report (version 2). Idempotent: a compact report
 * compacts to itself.
 */
export function compactReport(report) {
  const out = {
    ...pick(report, TOP_LEVEL_FIELDS),
    compact: true,
    compactVersion: COMPACT_REPORT_VERSION,
  };
  if (report.verification !== undefined) {
    out.verification = compactVerification(report.verification);
  }
  if (report.reliability !== undefined) {
    out.reliability = compactReliability(report.reliability);
  }
  out.results = (report.results || []).map((record) => {
    const compact = { ...compactCaseFields(record), ...pick(record, CASE_EXTRA_FIELDS) };
    if (Array.isArray(record.repetitions)) {
      compact.repetitions = record.repetitions.map(compactRepetition);
    } else {
      // A pre-runner record is its own (only) repetition.
      Object.assign(compact, compactRepetition(record));
    }
    return compact;
  });
  return out;
}

/**
 * JSON text of a compact report: the summaries indented, one line per case,
 * so a refreshed baseline diffs case by case.
 */
export function serializeCompactReport(report) {
  const { results = [], ...rest } = report;
  const head = JSON.stringify(rest, null, 2);
  const body = results.map((record) => `    ${JSON.stringify(record)}`).join(',\n');
  const open = head === '{}' ? '{\n' : `${head.slice(0, -2)},\n`;
  return `${open}  "results": [\n${body}${results.length ? '\n' : ''}  ]\n}\n`;
}

/**
 * Why a report marked compact cannot be read by this runner (null when it
 * can, or when it is not compact): an unknown compactVersion.
 */
export function compactReportProblem(report) {
  if (report?.compact === undefined) {
    return null;
  }
  if (report.compact !== true || !(Number.isInteger(report.compactVersion) && report.compactVersion >= 1 && report.compactVersion <= COMPACT_REPORT_VERSION)) {
    return (
      `is marked compact ${JSON.stringify(report.compact)} with compactVersion ${JSON.stringify(report.compactVersion ?? null)} ` +
      `(this runner reads compact reports up to version ${COMPACT_REPORT_VERSION})`
    );
  }
  return null;
}

/** Writes the compact form of `report` to `filePath`; returns its size in bytes. */
export async function writeCompactReport(filePath, report) {
  const text = serializeCompactReport(compactReport(report));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
  return Buffer.byteLength(text, 'utf8');
}
