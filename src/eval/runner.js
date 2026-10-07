// Case records and report assembly shared by a live run and a rescore
// (scripts/eval.js).
//
// report.json (reportVersion 2) keeps every top-level key earlier reports had
// (total/passed/failed/accuracy/statusCounts/warningCounts describe the FIRST
// repetition, `reliability` is the old pooled block, now labelled as such) and
// adds: mode, suite, runner, provenance, verification, stats, attribution,
// behavior (abstain / clarify cases, reported apart from strict accuracy),
// budget, stopped (why a run ended early, or null), comparison, rescoredFrom. Each results[i] is one case: its dataset
// fields, the first repetition's fields at the top level (as before), every
// repetition in `repetitions[]` (each with outcome / bucket / counted /
// outcome_tags from attribution.js) and a per-case `summary`.

import { isBehaviorCase, summarizeBenchmarkResults } from '../benchmark.js';
import { attributeRepetition, checkGuardrailRejections, summarizeAttribution, summarizeBehavior, summarizeCaseRepetitions } from './attribution.js';
import { goldFingerprint } from './controls.js';
import { scoreAgainstGold } from './oracle.js';
import { summarizeReliability, summarizeRunStatistics } from './stats.js';
import { caseSplit, scoringFingerprint } from './suite.js';

export const REPORT_VERSION = 2;

// Repetitions that never produced a verdict (budget, a stopped run).
const NOT_RUN = new Set(['skipped_budget', 'cancelled']);

/** True for a result record of an abstain / clarify case (never in strict accuracy). */
export function isBehaviorRecord(record) {
  return Boolean(record?.expected_behavior) && record.expected_behavior !== 'answer';
}

/**
 * Dataset fields of a case as recorded in results[i]: CASE_RECORD_FIELDS, plus
 * the older single `expected_row_count` pin when the case carries one (an
 * external dataset or a pre-runner report may), right after
 * expected_row_counts.
 */
export function caseMetadata(testCase, datasets = []) {
  const legacyPin = Number.isInteger(testCase.expected_row_count) ? { expected_row_count: testCase.expected_row_count } : {};
  return {
    id: testCase.id,
    intentId: testCase.intentId,
    question: testCase.question,
    canonicalQuestion: testCase.canonicalQuestion,
    expected_sql: testCase.expected_sql,
    alternative_expected_sql: testCase.alternative_expected_sql,
    expected_tables: testCase.expected_tables,
    expected_columns: testCase.expected_columns,
    disallowed_columns: testCase.disallowed_columns,
    signal_checks: testCase.signal_checks,
    comparison: testCase.comparison ?? null,
    expected_row_counts: testCase.expected_row_counts ?? null,
    ...legacyPin,
    difficulty: testCase.difficulty,
    tags: testCase.tags,
    failure_class: testCase.failure_class,
    split: caseSplit(testCase),
    expected_behavior: testCase.expected_behavior || 'answer',
    known_validator_rejection: testCase.known_validator_rejection ?? null,
    datasets,
    gold_fingerprint: goldFingerprint(testCase.expected_sql),
    scoring_fingerprint: scoringFingerprint(testCase),
  };
}

/** The keys caseMetadata() always writes: dataset fields of a case record. */
export const CASE_RECORD_FIELDS = Object.freeze([
  'id',
  'intentId',
  'question',
  'canonicalQuestion',
  'expected_sql',
  'alternative_expected_sql',
  'expected_tables',
  'expected_columns',
  'disallowed_columns',
  'signal_checks',
  'comparison',
  'expected_row_counts',
  'difficulty',
  'tags',
  'failure_class',
  'split',
  'expected_behavior',
  'known_validator_rejection',
  'datasets',
  'gold_fingerprint',
  'scoring_fingerprint',
]);

// Keys of a result record that describe the case, not one repetition: its
// dataset fields (plus an older report's single expected_row_count pin) and
// the per-case summary blocks.
const CASE_LEVEL_KEYS = new Set([...CASE_RECORD_FIELDS, 'expected_row_count', 'summary', 'repetitions', 'case_source']);

/**
 * A repetition's own fields: `fields` without any case-level key. A
 * pre-runner report has no repetitions[], so its whole case record is the
 * recorded repetition; this keeps its old case definition out of it.
 */
export function withoutCaseFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).filter(([key]) => !CASE_LEVEL_KEYS.has(key)));
}

/**
 * One results[i] entry from attributed repetitions: the case's dataset fields
 * (today's definition, which the verdicts used), then the first repetition's
 * result fields, which never override a case field.
 */
export function buildCaseRecord(entry, repetitions, extra = {}) {
  const [first = {}] = repetitions;
  const { repetition: _repetition, ...firstFields } = withoutCaseFields(first);
  void _repetition;
  return {
    ...caseMetadata(entry.testCase, entry.datasets),
    ...firstFields,
    ...extra,
    repetitions,
    summary: summarizeCaseRepetitions(repetitions),
  };
}

/**
 * Re-checks guardrail rejections (attribution.js) and attributes every
 * repetition, then builds the case records. `caseRuns` = [{ entry: {
 * testCase, datasets }, repetitions: [result], extra? }].
 */
export async function attributeCaseRuns(caseRuns, {
  connections,
  goldCache,
  schema,
  statementTimeoutMs = null,
  goldTimeoutMs,
  score = scoreAgainstGold,
  checkGuardrails = true,
} = {}) {
  const cache = new Map();
  const records = [];
  for (const run of caseRuns) {
    const repetitions = [];
    for (const [index, result] of run.repetitions.entries()) {
      // A behavior case has no gold to re-check a guardrail rejection against.
      const checked = checkGuardrails && !isBehaviorCase(run.entry.testCase)
        ? await checkGuardrailRejections(result, {
            testCase: run.entry.testCase,
            connections,
            goldCache,
            schema,
            timeoutMs: statementTimeoutMs,
            goldTimeoutMs,
            cache,
            score,
          })
        : result;
      repetitions.push(attributeRepetition({ repetition: index + 1, ...checked }, run.entry.testCase));
    }
    records.push(buildCaseRecord(run.entry, repetitions, run.extra || {}));
  }
  return records;
}

function warningCountsOf(results) {
  return results.reduce((counts, result) => {
    for (const warning of result.warnings || []) {
      counts[warning] = (counts[warning] || 0) + 1;
    }
    return counts;
  }, {});
}

/**
 * The pre-runner top-level fields: totals over the first repetition (skipped
 * repetitions left out) and the pooled `reliability` block.
 */
export function legacySummary(caseRecords) {
  const repeat = caseRecords.reduce((max, record) => Math.max(max, record.repetitions.length), 0);
  const perRepetition = [];
  for (let index = 0; index < repeat; index += 1) {
    const withIds = caseRecords
      .filter((record) => record.repetitions[index] && !NOT_RUN.has(record.repetitions[index].status))
      .map((record) => ({ id: record.id, intentId: record.intentId, question: record.question, status: record.repetitions[index].status }));
    const summary = summarizeBenchmarkResults(withIds);
    perRepetition.push({
      repetition: index + 1,
      results: withIds,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      statusCounts: summary.statusCounts,
      accuracy: summary.total === 0 ? 0 : Number((summary.passed / summary.total).toFixed(4)),
    });
  }
  const firstResults = caseRecords.map((record) => record.repetitions[0]).filter((repetition) => repetition && !NOT_RUN.has(repetition.status));
  const first = summarizeBenchmarkResults(firstResults);
  const reliability = summarizeReliability(perRepetition, Math.max(1, repeat));
  return {
    total: first.total,
    passed: first.passed,
    failed: first.failed,
    accuracy: first.total === 0 ? 0 : Number((first.passed / first.total).toFixed(4)),
    accuracyScope: repeat > 1 ? 'first-repetition' : 'single-run',
    aggregateAccuracy: repeat > 1 ? reliability.passRate : null,
    statusCounts: first.statusCounts,
    warningCounts: warningCountsOf(firstResults),
    reliability,
  };
}

/** Assembles report.json. */
export function buildReport({
  mode = 'run',
  generatedAt = new Date().toISOString(),
  runTimestamp,
  model,
  schemaPath,
  suite,
  oracle,
  runner,
  provenance,
  verification = null,
  budget = null,
  stopped = null,
  caseRecords,
  comparison = null,
  rescoredFrom = null,
  traceFile = null,
  statsOptions = {},
}) {
  // Behavior cases (abstain / clarify) have no gold: they are reported in
  // `behavior` and left out of the accuracy, legacy and attribution blocks
  // (cost, latency and tokens in `stats` still cover every case).
  const answerRecords = caseRecords.filter((record) => !isBehaviorRecord(record));
  const legacy = legacySummary(answerRecords);
  const singleDataset = suite.datasets.length === 1 ? suite.datasets[0] : null;
  return {
    reportVersion: REPORT_VERSION,
    mode,
    generatedAt,
    runTimestamp,
    model,
    gitSha: provenance?.git?.sha ?? null,
    schemaPath,
    suite,
    dataset: {
      name: suite.name,
      path: singleDataset ? singleDataset.path : null,
      selectedCaseCount: suite.selectedCaseCount,
      totalCaseCount: suite.totalCaseCount,
      filters: {
        caseId: suite.filters.caseIds.length ? suite.filters.caseIds.join(',') : null,
        tag: suite.filters.tags.length ? suite.filters.tags.join(',') : null,
        intent: suite.filters.intents.length ? suite.filters.intents.join(',') : null,
        split: suite.filters.split,
      },
    },
    oracle,
    runner,
    provenance,
    verification,
    stats: summarizeRunStatistics(caseRecords, statsOptions),
    attribution: summarizeAttribution(answerRecords),
    behavior: summarizeBehavior(caseRecords),
    budget,
    stopped,
    comparison,
    rescoredFrom,
    ...legacy,
    traceFile,
    results: caseRecords,
  };
}

/** Suite block of a report from selectSuite() output. */
export function describeSuite(selection, { repoRelative = (value) => value } = {}) {
  return {
    name: selection.name,
    datasets: selection.datasets.map((dataset) => ({ name: dataset.name, path: repoRelative(dataset.path), caseCount: dataset.cases.length })),
    totalCaseCount: selection.totalCaseCount,
    uniqueCaseCount: selection.uniqueCaseCount,
    selectedCaseCount: selection.entries.length,
    duplicates: selection.duplicates,
    filters: selection.filters,
  };
}
