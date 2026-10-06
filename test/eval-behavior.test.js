import assert from 'node:assert/strict';
import test from 'node:test';

import { compareResultsDetailed, findInvalidSplits, isBehaviorCase, listGoldVariants, normalizeBenchmarkCase } from '../src/benchmark.js';
import { evaluateQuestion } from '../scripts/evaluate.js';
import { computeExitCode, describeSuiteCoverage, formatProgress, minAccuracyRefusal } from '../scripts/eval.js';
import { classifyRepetition, summarizeBehavior, summarizeCaseRepetitions } from '../src/eval/attribution.js';
import { caseOutcomesFromReport, compareReports } from '../src/eval/compare.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { sha256Hex, stableStringify } from '../src/eval/provenance.js';
import { normalizeSqlText } from '../src/eval/controls.js';
import { renderHeadline, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { rescoreRepetition, testCaseFromRecord } from '../src/eval/rescore.js';
import { attributeCaseRuns, buildReport, caseMetadata } from '../src/eval/runner.js';
import { scoringFingerprint } from '../src/eval/suite.js';
import { verifyCase, verifySuite } from '../src/eval/verify.js';

// Splits, behavior cases (expected_behavior 'abstain' / 'clarify': no gold
// SQL, never in strict accuracy) and known validator rejections, through
// every place a case field has to reach: normalizeBenchmarkCase, the scoring
// fingerprint, the result record and rescore's CASE_FIELDS, evaluateQuestion,
// attribution, the report, the comparison and verify-dataset.

const abstainCase = normalizeBenchmarkCase({
  id: 'hard_abstain_headcount',
  intentId: 'employee_headcount',
  split: 'holdout',
  expected_behavior: 'abstain',
  question: 'What is our employee headcount by store?',
  tags: ['unanswerable'],
});
const clarifyCase = normalizeBenchmarkCase({
  id: 'hard_clarify_best_customer',
  intentId: 'best_customer_ambiguous',
  expected_behavior: 'clarify',
  question: 'Who is our best customer?',
});
const answerCase = normalizeBenchmarkCase({
  id: 'a1',
  intentId: 'count_customers',
  question: 'How many customers?',
  expected_sql: 'SELECT COUNT(*) AS n FROM Customer',
  comparison: { mode: 'scalar' },
});

test('normalizeBenchmarkCase: split defaults to dev, unknown splits and behaviors are errors', () => {
  assert.equal(answerCase.split, 'dev');
  assert.equal(answerCase.expected_behavior, 'answer');
  assert.equal(answerCase.known_validator_rejection, null);
  assert.equal(normalizeBenchmarkCase({ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', split: ' Holdout ' }).split, 'holdout');
  assert.throws(() => normalizeBenchmarkCase({ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', split: 'test' }), /Benchmark case x has split "test"; use one of dev, holdout/);
  assert.throws(
    () => normalizeBenchmarkCase({ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', expected_behavior: 'refuse' }),
    /Benchmark case x has expected_behavior "refuse"; use one of answer, abstain, clarify/
  );
  assert.equal(
    normalizeBenchmarkCase({ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', known_validator_rejection: 'TABLE_SCOPE' }).known_validator_rejection,
    'TABLE_SCOPE'
  );
});

test('normalizeBenchmarkCase: an abstain / clarify case needs no gold and may not carry one', () => {
  assert.equal(abstainCase.expected_behavior, 'abstain');
  assert.equal(abstainCase.split, 'holdout');
  assert.equal(abstainCase.expected_sql, '');
  assert.deepEqual(abstainCase.alternative_expected_sql, []);
  assert.equal(abstainCase.comparison, null);
  assert.deepEqual(abstainCase.expected_tables, []);
  assert.ok(isBehaviorCase(abstainCase) && isBehaviorCase(clarifyCase) && !isBehaviorCase(answerCase));
  assert.deepEqual(listGoldVariants(abstainCase), []);
  // An answer case still needs its gold.
  assert.throws(() => normalizeBenchmarkCase({ id: 'x', question: 'Q?' }), /missing expected_sql/);
  for (const [field, value] of [
    ['expected_sql', 'SELECT 1'],
    ['alternative_expected_sql', ['SELECT 2']],
    ['comparison', { mode: 'scalar' }],
    ['expected_row_counts', { seed: 1 }],
    ['known_validator_rejection', 'TABLE_SCOPE'],
  ]) {
    assert.throws(
      () => normalizeBenchmarkCase({ id: 'x', question: 'Q?', expected_behavior: 'abstain', [field]: value }),
      new RegExp(`expects behavior "abstain" and must not carry ${field}`)
    );
  }
});

test('the scoring fingerprint covers the expected behavior, and answer cases keep their old fingerprint', () => {
  const before = sha256Hex(
    stableStringify({ gold: normalizeSqlText(answerCase.expected_sql), alternatives: [], comparison: answerCase.comparison })
  ).slice(0, 16);
  assert.equal(scoringFingerprint(answerCase), before);
  const asClarify = normalizeBenchmarkCase({ ...abstainCase, expected_behavior: 'clarify' });
  assert.notEqual(scoringFingerprint(abstainCase), scoringFingerprint(asClarify));
});

test('the result record carries split, expected_behavior and known_validator_rejection, and a rescore rebuilds them', () => {
  const flagged = normalizeBenchmarkCase({ ...answerCase, split: 'holdout', known_validator_rejection: 'TABLE_SCOPE' });
  for (const testCase of [abstainCase, flagged]) {
    const record = caseMetadata(testCase, ['d']);
    assert.equal(record.split, testCase.split);
    assert.equal(record.expected_behavior, testCase.expected_behavior);
    assert.equal(record.known_validator_rejection, testCase.known_validator_rejection);
    const rebuilt = testCaseFromRecord(record);
    for (const field of ['split', 'expected_behavior', 'known_validator_rejection', 'expected_sql', 'question', 'intentId']) {
      assert.deepEqual(rebuilt[field], testCase[field], field);
    }
    assert.equal(scoringFingerprint(rebuilt), scoringFingerprint(testCase));
  }
});

const sqlAttempt = (sql, validation = { ok: true, durationMs: 1, tablesUsed: [] }) => ({
  attempt: 1,
  retry: false,
  generatedSql: sql,
  llm: { ok: true, durationMs: 1, usage: null, cost: null },
  validation,
  execution: validation.ok ? { ok: true, durationMs: 1, rowCount: 1, truncated: false } : null,
});

test('attribution of a behavior case: SQL is answered_instead_of_*, no SQL is declined, never counted in accuracy', () => {
  const outcomes = [
    [{ status: 'answered', generated_sql: 'SELECT 1', attempts: [sqlAttempt('SELECT 1')] }, abstainCase, ['answered_instead_of_abstain', 'model', true, []]],
    [{ status: 'answered', generated_sql: 'SELECT 1', attempts: [sqlAttempt('SELECT 1')] }, clarifyCase, ['answered_instead_of_clarify', 'model', true, []]],
    [
      { status: 'validation_error', error_code: 'FAN_OUT', attempts: [sqlAttempt('SELECT 1', { ok: false, code: 'FAN_OUT', layer: 'guardrail', message: 'x' })] },
      abstainCase,
      ['answered_instead_of_abstain', 'model', true, ['not_executed']],
    ],
    [
      { status: 'validation_error', error_code: 'EMPTY_SQL', attempts: [sqlAttempt('', { ok: false, code: 'EMPTY_SQL', layer: 'safety', message: 'Model did not return SQL.' })] },
      abstainCase,
      ['declined', 'pass', true, []],
    ],
    [{ status: 'llm_error', error_code: 'LLM_REFUSED', attempts: [] }, clarifyCase, ['declined', 'pass', true, []]],
    [{ status: 'llm_error', error_code: 'LLM_TRUNCATED', attempts: [] }, clarifyCase, ['llm_error', 'model', true, []]],
    [{ status: 'llm_error', error_code: 'LLM_TIMEOUT', attempts: [] }, abstainCase, ['llm_outage', 'infra', false, []]],
    [{ status: 'aborted', timed_out: true, error_code: 'CASE_TIMEOUT', attempts: [] }, abstainCase, ['timeout', 'infra', false, []]],
    [{ status: 'skipped_budget', attempts: [] }, abstainCase, ['skipped_budget', 'skipped', false, []]],
  ];
  for (const [repetition, testCase, [outcome, bucket, behaviorCounted, tags]] of outcomes) {
    const result = classifyRepetition(repetition, testCase);
    assert.deepEqual(
      [result.outcome, result.bucket, result.counted, result.behavior_counted, result.outcome_tags],
      [outcome, bucket, false, behaviorCounted, tags],
      `${repetition.status} ${repetition.error_code || ''}`
    );
  }
});

const behaviorRep = (status, extra = {}) => ({
  status,
  warnings: [],
  attempts: status === 'answered' ? [sqlAttempt('SELECT 1')] : [sqlAttempt('', { ok: false, code: 'EMPTY_SQL', layer: 'safety', message: 'x' })],
  generated_sql: status === 'answered' ? 'SELECT 1' : '',
  error_code: status === 'answered' ? undefined : 'EMPTY_SQL',
  llm_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  llm_cost: { totalCost: 0.0001 },
  timings: { totalMs: 1000, questionMs: 900 },
  ...extra,
});
const answerRep = (status) => ({
  status,
  warnings: [],
  retrieved_tables: ['Customer'],
  attempts: [sqlAttempt('SELECT 1')],
  llm_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  llm_cost: { totalCost: 0.0001 },
  timings: { totalMs: 1000, questionMs: 900 },
});

async function sampleRecords() {
  const holdout = normalizeBenchmarkCase({ id: 'h1', intentId: 'i_h1', split: 'holdout', question: 'Holdout?', expected_sql: "SELECT 'h1'", expected_tables: ['Customer'] });
  return attributeCaseRuns(
    [
      { entry: { testCase: answerCase, datasets: ['d'] }, repetitions: [answerRep('pass'), answerRep('pass')] },
      { entry: { testCase: holdout, datasets: ['d'] }, repetitions: [answerRep('result_mismatch'), answerRep('pass')] },
      { entry: { testCase: abstainCase, datasets: ['hard'] }, repetitions: [behaviorRep('answered'), behaviorRep('answered')] },
      { entry: { testCase: clarifyCase, datasets: ['hard'] }, repetitions: [behaviorRep('validation_error'), behaviorRep('answered')] },
    ],
    // Behavior cases are never re-checked against a gold (there is none): a
    // check here would throw on the missing connections.
    { checkGuardrails: true, connections: [], goldCache: createGoldCache() }
  );
}

function reportOf(caseRecords, extra = {}) {
  return buildReport({
    mode: 'run',
    generatedAt: '2026-10-06T00:00:00.000Z',
    runTimestamp: 'now',
    model: 'gpt-4o-mini',
    schemaPath: 'generated/schema.json',
    suite: { name: 'all', datasets: [{ name: 'd', path: 'datasets/d.json' }, { name: 'hard', path: 'datasets/hard.json' }], totalCaseCount: caseRecords.length, uniqueCaseCount: caseRecords.length, selectedCaseCount: caseRecords.length, duplicates: [], filters: { split: 'all', caseIds: [], tags: [], intents: [] } },
    oracle: { fixtures: [], maxRetries: 1, statementTimeoutMs: 8000, goldTimeoutMs: 30000 },
    runner: { repeat: 2 },
    provenance: null,
    caseRecords,
    statsOptions: { resamples: 200 },
    ...extra,
  });
}

test('the report keeps behavior cases out of accuracy and attribution, and reports them on their own', async () => {
  const records = await sampleRecords();
  const byId = Object.fromEntries(records.map((record) => [record.id, record]));
  assert.deepEqual(byId.hard_abstain_headcount.summary.behavior, { counted: 2, handled: 0, rate: 0, majorityHandled: false });
  assert.deepEqual(byId.hard_clarify_best_customer.summary.behavior, { counted: 2, handled: 1, rate: 0.5, majorityHandled: false });
  assert.equal(byId.hard_abstain_headcount.summary.counted, 0);
  assert.equal(byId.hard_abstain_headcount.summary.outcome, 'answered_instead_of_abstain');
  assert.equal(byId.hard_abstain_headcount.expected_behavior, 'abstain');

  const report = reportOf(records);
  // Strict accuracy: (1 + 0.5) / 2 over the two answer cases only.
  assert.equal(report.stats.strictAccuracy.value, 0.75);
  assert.deepEqual(report.stats.cases, { selected: 4, counted: 2, excluded: 0, behavior: 2, intents: 2 });
  assert.deepEqual(report.stats.bySplit.map((entry) => [entry.key, entry.cases, entry.accuracy]), [['dev', 1, 1], ['holdout', 1, 0.5]]);
  // Cost covers every question, behavior cases included.
  assert.equal(report.stats.cost.questions, 8);
  assert.equal(report.attribution.cases.total, 2);
  assert.deepEqual(report.attribution.excluded, {});
  assert.equal(report.total, 2, 'legacy first-repetition totals leave behavior cases out');
  assert.deepEqual(report.behavior.byBehavior, {
    abstain: { cases: 1, handled: 0, counted: 1, outcomes: { answered_instead_of_abstain: 1 } },
    clarify: { cases: 1, handled: 0, counted: 1, outcomes: { answered_instead_of_clarify: 1 } },
  });
  assert.equal(report.behavior.cases, 2);
  assert.equal(report.behavior.handled, 0);
  assert.deepEqual(summarizeBehavior(records), report.behavior);

  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /## Behaviour cases \(abstain \/ clarify\)\n\nBehaviour cases: abstain\/clarify — 2 cases, 0 handled correctly\./);
  assert.match(markdown, /By split: dev 100\.0% \(1 case\) · holdout 50\.0% \(1 case\)\./);
  assert.match(markdown, /\| hard_clarify_best_customer \| Who is our best customer\? \| 1\/2 declined \| answered_instead_of_clarify \| expects clarify, model \|/);
  assert.match(markdown, /\| split \| holdout \| 1 \| 50\.0% \| 0\/1 \|/);
  // The attribution tables leave the behaviour cases out, and say so.
  assert.match(markdown, /Excluded from accuracy: 2 abstain\/clarify cases \(4 repetitions; see Behaviour cases\)\./);
  const [skipped] = await attributeCaseRuns(
    [{ entry: { testCase: normalizeBenchmarkCase({ id: 's1', question: 'Skipped?', expected_sql: "SELECT 's1'" }), datasets: ['d'] }, repetitions: [{ status: 'skipped_budget', attempts: [] }] }],
    { checkGuardrails: false }
  );
  const withSkipped = renderReportMarkdown(reportOf([...records, skipped]));
  assert.match(withSkipped, /Excluded from accuracy: skipped_budget 1; 2 abstain\/clarify cases \(4 repetitions; see Behaviour cases\)\./);
  // The headline's denominator is the answer cases (3), not every selected
  // case (5): accuracy is over 3 - 1 = 2 cases.
  assert.match(withSkipped, /1 of 3 answer case\(s\) had no counted repetition and are left out of accuracy \(see Attribution\); the 2 abstain\/clarify case\(s\) are scored apart\./);
  assert.doesNotMatch(withSkipped, /of 5 selected case/);
  assert.doesNotMatch(markdown, /had no counted repetition/);
  assert.match(renderReportMarkdown(reportOf(records.filter((record) => record.expected_behavior === 'answer'))), /Excluded from accuracy: none\./);
  const headline = renderHeadline(report);
  assert.match(headline, /Behaviour cases: abstain\/clarify — 2 cases, 0 handled correctly\. \(not in accuracy\)/);
  assert.match(headline, /By split: dev 100\.0% \(1\) · holdout 50\.0% \(1\)/);
});

test('a comparison never pairs behavior cases; a selection of only behavior cases is not a harness failure', async () => {
  const records = await sampleRecords();
  const comparison = compareReports({ results: records }, { results: records }, { resamples: 100 });
  assert.equal(comparison.paired, 2);
  assert.deepEqual([...comparison.newCases, ...comparison.removedCases], []);
  // Behaviour cases are skipped outright, not paired and not listed as
  // excluded (not counted / gold changed) either.
  const behaviorIds = records.filter((record) => record.expected_behavior !== 'answer').map((record) => record.id);
  assert.ok(behaviorIds.length > 0);
  const listed = [...comparison.excluded.notCounted, ...comparison.excluded.goldChanged].map((entry) => entry.id ?? entry);
  assert.deepEqual(listed.filter((id) => behaviorIds.includes(id)), []);
  assert.equal(comparison.excluded.notCounted.length, 0);
  const outcomes = caseOutcomesFromReport({ results: records });
  assert.deepEqual(behaviorIds.filter((id) => outcomes.has(id)), []);

  const behaviorOnly = reportOf(records.filter((record) => record.expected_behavior !== 'answer'));
  assert.equal(behaviorOnly.stats.strictAccuracy.value, null);
  assert.deepEqual(computeExitCode(behaviorOnly), { code: 0, reasons: [] });
  const nothingCounted = reportOf(
    records.filter((record) => record.id === 'a1').map((record) => ({ ...record, repetitions: record.repetitions.map((rep) => ({ ...rep, counted: false })), summary: { ...record.summary, counted: 0 } }))
  );
  assert.equal(computeExitCode(nothingCounted).code, 2);
});

test('benchmark profile: an abstain / clarify case the model answered is a failed case (exit 1)', async () => {
  const single = (testCase, rep) => ({ entry: { testCase, datasets: ['hard'] }, repetitions: [rep] });
  const recordsOf = (runs) => attributeCaseRuns(runs, { checkGuardrails: false });
  const answeredEverything = reportOf(await recordsOf([single(abstainCase, behaviorRep('answered')), single(clarifyCase, behaviorRep('answered'))]));
  assert.equal(answeredEverything.stats.repeat, 1);
  assert.deepEqual(computeExitCode(answeredEverything, { failOnAnyFailure: true }), {
    code: 1,
    reasons: ['2 case(s) failed (benchmark profile, single run; 2 abstain/clarify case(s) not declined: 2 answered)'],
  });
  // A non-outage LLM error with no SQL and no decline code is not a decline
  // either, but the model did not answer: the reason says so.
  const errored = reportOf(
    await recordsOf([
      single(abstainCase, behaviorRep('llm_error', { error_code: 'LLM_BAD_JSON', attempts: [] })),
      single(clarifyCase, behaviorRep('answered')),
    ])
  );
  assert.equal(errored.results.find((record) => record.id === abstainCase.id).repetitions[0].outcome, 'llm_error');
  assert.deepEqual(computeExitCode(errored, { failOnAnyFailure: true }), {
    code: 1,
    reasons: ['2 case(s) failed (benchmark profile, single run; 2 abstain/clarify case(s) not declined: 1 answered, 1 errored)'],
  });
  // The eval profile still only measures behaviour cases.
  assert.deepEqual(computeExitCode(answeredEverything), { code: 0, reasons: [] });
  // Declining is the correct behaviour.
  const declined = reportOf(await recordsOf([single(abstainCase, behaviorRep('validation_error')), single(clarifyCase, behaviorRep('validation_error'))]));
  assert.deepEqual(computeExitCode(declined, { failOnAnyFailure: true }), { code: 0, reasons: [] });
  // Mixed with answer cases: each failure counts once.
  const mixed = reportOf(
    await recordsOf([
      { entry: { testCase: answerCase, datasets: ['d'] }, repetitions: [answerRep('result_mismatch')] },
      single(abstainCase, behaviorRep('answered')),
      single(clarifyCase, behaviorRep('validation_error')),
    ])
  );
  assert.deepEqual(computeExitCode(mixed, { failOnAnyFailure: true }).reasons, [
    '2 case(s) failed (benchmark profile, single run; 1 abstain/clarify case(s) not declined: 1 answered)',
  ]);
  // With --repeat the benchmark profile does not fail on single cases (as before).
  const repeated = reportOf(await recordsOf([{ entry: { testCase: abstainCase, datasets: ['hard'] }, repetitions: [behaviorRep('answered'), behaviorRep('answered')] }]));
  assert.deepEqual(computeExitCode(repeated, { failOnAnyFailure: true }), { code: 0, reasons: [] });
});

test('--min-accuracy with only abstain / clarify cases selected is refused (exit 2), never compared with a missing accuracy', async () => {
  const records = await sampleRecords();
  const behaviorOnly = reportOf(records.filter((record) => record.expected_behavior !== 'answer'));
  assert.equal(behaviorOnly.stats.strictAccuracy.value, null);
  const refused = computeExitCode(behaviorOnly, { gate: true, minAccuracy: 0.8 });
  assert.equal(refused.code, 2);
  assert.match(refused.reasons[0], /--min-accuracy 0\.8 cannot be checked: no answer case was selected/);
  // Without a threshold the behaviour-only gate is not a failure.
  assert.deepEqual(computeExitCode(behaviorOnly, { gate: true }), { code: 0, reasons: [] });
  // The same refusal before the run (no LLM call is made for it).
  const message = minAccuracyRefusal({ gate: true, minAccuracy: 0.8 }, [abstainCase, clarifyCase]);
  assert.match(message, /--min-accuracy 0\.8 cannot be checked: no answer case was selected \(only 2 abstain \/ clarify case\(s\), which are scored apart from strict accuracy\)/);
  assert.equal(minAccuracyRefusal({ gate: true, minAccuracy: 0.8 }, [abstainCase, answerCase]), null);
  assert.equal(minAccuracyRefusal({ gate: true, minAccuracy: null }, [abstainCase]), null);
  assert.equal(minAccuracyRefusal({ gate: true, minAccuracy: 0 }, [abstainCase]) !== null, true, 'a threshold of 0 is a threshold too');
});

test('evaluateQuestion runs no gold and no oracle for a behavior case; executed SQL is status answered', async () => {
  const goldCache = createGoldCache();
  let scored = 0;
  const trace = { events: [], emit: async (event, payload) => trace.events.push({ event, payload }) };
  const connection = { query: async () => assert.fail('no SQL may run outside the product loop for a behavior case') };
  const result = await evaluateQuestion({
    client: {},
    connections: [{ name: 'seed', database: 'demo_retail', connection }],
    schema: { tables: [] },
    model: 'test',
    testCase: abstainCase,
    caseIndex: 1,
    trace,
    goldCache,
    dependencies: {
      runQuestion: async () => ({ success: true, sql: 'SELECT COUNT(*) FROM StoreLocation', attemptCount: 1, promptTables: ['StoreLocation'] }),
      scorePrediction: async () => {
        scored += 1;
        return {};
      },
    },
  });
  assert.equal(result.status, 'answered');
  assert.equal(result.generated_sql, 'SELECT COUNT(*) FROM StoreLocation');
  assert.equal(result.oracle, null);
  assert.equal(scored, 0);
  assert.equal(goldCache.size, 0);
  assert.ok(!trace.events.some((entry) => entry.event === 'expected_sql.executed'));
  assert.deepEqual(trace.events.find((entry) => entry.event === 'behavior.checked').payload.answered, true);

  const declined = await evaluateQuestion({
    client: {},
    connections: [{ name: 'seed', database: 'demo_retail', connection }],
    schema: { tables: [] },
    model: 'test',
    testCase: abstainCase,
    caseIndex: 1,
    trace,
    goldCache,
    dependencies: {
      runQuestion: async () => ({ success: false, sql: '', errorStage: 'validation', errorCode: 'EMPTY_SQL', error: new Error('Model did not return SQL.'), attemptCount: 2 }),
    },
  });
  assert.equal(declined.status, 'validation_error');
  assert.equal(classifyRepetition(declined, abstainCase).outcome, 'declined');
});

test('rescore keeps a behavior case as recorded (inherited): there is no gold to replay against', async () => {
  const recorded = { ...behaviorRep('answered'), outcome: 'answered_instead_of_abstain', bucket: 'model', counted: false };
  const rescored = await rescoreRepetition(recorded, {
    testCase: abstainCase,
    connections: [],
    goldCache: createGoldCache(),
    schema: { tables: [] },
    validate: async () => assert.fail('a behavior case is not re-validated'),
  });
  assert.equal(rescored.status, 'answered');
  assert.equal(rescored.outcome, undefined);
  assert.equal(rescored.rescore.inherited, true);
  assert.match(rescored.rescore.reason, /abstain case/);
  assert.equal(summarizeCaseRepetitions([{ ...rescored, ...classifyRepetition(rescored, abstainCase) }]).outcome, 'answered_instead_of_abstain');
});

test('verifyCase: a behavior case runs nothing; a known validator rejection is a note until the validator accepts the gold', async () => {
  const connection = { query: async () => assert.fail('nothing runs for a behavior case') };
  const connections = [{ name: 'seed', database: 'demo_retail', connection }];
  const behavior = await verifyCase(abstainCase, { connections, validate: async () => assert.fail('no gold to validate') });
  assert.deepEqual(behavior.problems, []);
  assert.deepEqual(behavior.goldRowCounts, {});
  assert.equal(behavior.controls, null);
  assert.match(behavior.notes[0], /abstain case: no gold SQL/);
  const withControls = await verifyCase(abstainCase, {
    connections,
    controlsIndex: { byCaseId: new Map([[abstainCase.id, {}]]), byIntentId: new Map(), files: [] },
  });
  assert.match(withControls.problems[0], /controls are defined for hard_abstain_headcount/);

  const rows = [{ n: 3 }];
  const goldConnections = [{ name: 'seed', database: 'demo_retail', connection: { query: async () => [rows] } }];
  const flagged = normalizeBenchmarkCase({ ...answerCase, known_validator_rejection: 'TABLE_SCOPE' });
  const rejecting = async () => ({ code: 'TABLE_SCOPE', layer: 'safety', message: 'outside the allowed table set' });
  const known = await verifyCase(flagged, { connections: goldConnections, validate: rejecting, checkControls: false });
  assert.deepEqual(known.problems, []);
  assert.deepEqual(known.notes, ['expected_sql: known validator rejection (TABLE_SCOPE)']);
  const otherCode = await verifyCase(flagged, { connections: goldConnections, validate: async () => ({ code: 'FAN_OUT', layer: 'guardrail', message: 'x' }), checkControls: false });
  assert.match(otherCode.problems[0], /rejected by the production validator: FAN_OUT/);
  const stale = await verifyCase(flagged, { connections: goldConnections, validate: async () => null, checkControls: false });
  assert.match(stale.problems[0], /known_validator_rejection is TABLE_SCOPE, but the production validator accepts the gold now/);
  // npm run eval verifies with staleKnownRejection 'warning': a product that
  // closed the gap can still be measured; verify-dataset keeps the problem.
  const staleWarning = await verifyCase(flagged, { connections: goldConnections, validate: async () => null, checkControls: false, staleKnownRejection: 'warning' });
  assert.deepEqual(staleWarning.problems, []);
  assert.match(staleWarning.warnings[0], /known_validator_rejection is TABLE_SCOPE, but the production validator accepts the gold now/);
  const suite = await verifySuite({
    datasets: [{ name: 'd', cases: [flagged] }],
    connections: goldConnections,
    validate: async () => null,
    checkControls: false,
    staleKnownRejection: 'warning',
  });
  assert.deepEqual([suite.problems, suite.gateFailures], [[], []]);
  assert.match(suite.warnings[0], new RegExp(`^${flagged.id}: known_validator_rejection is TABLE_SCOPE`));
  const badSplit = await verifyCase({ ...answerCase, split: 'test' }, { connections: goldConnections, checkControls: false });
  assert.match(badSplit.problems[0], /split "test" is not one of dev, holdout/);
  assert.deepEqual(findInvalidSplits([{ id: 'a', split: 'dev' }, { id: 'b' }, { id: 'c', split: 'train' }, { id: 'd', split: ' Holdout ' }, { id: 'e', split: 'test' }]), [
    { id: 'c', split: 'train' },
    { id: 'e', split: 'test' },
  ]);

  // A scalar comparison over a multi-row gold is a problem (the gold has the
  // wrong shape for the one value the question asks for).
  const twoRows = [{ code: '2100', total_debit: 0 }, { code: '5000', total_debit: 140 }];
  const scalarCase = normalizeBenchmarkCase({ ...answerCase, comparison: { mode: 'scalar', null_as_zero: ['total_debit'] } });
  const wrongShape = await verifyCase(scalarCase, { connections: [{ name: 'v2', database: 'demo_retail_v2', connection: { query: async () => [twoRows] } }], checkControls: false });
  assert.ok(wrongShape.problems.some((problem) => /expected_sql returns 2 rows on v2, but the comparison mode is scalar/.test(problem)), wrongShape.problems.join('; '));
});

// Zero-row and NULL answers (documented in docs/evaluation-dataset.md): two
// empty results match whatever their columns; a scalar NULL (SUM over no
// rows) does not equal 0 unless the column is listed in null_as_zero.
test('comparator: empty vs empty matches; scalar NULL vs 0 only with null_as_zero', () => {
  assert.deepEqual(compareResultsDetailed([], [], { mode: 'rowset' }), { match: true, assignment: {}, reason: 'match' });
  assert.equal(compareResultsDetailed([], [{ CustomerName: 'A', total: 0 }], { mode: 'rowset' }).reason, 'row_count');
  const gold = [{ total_net_amount: null }];
  assert.equal(compareResultsDetailed(gold, [{ total: 0 }], { mode: 'scalar' }).match, false);
  assert.equal(compareResultsDetailed(gold, [{ total: 0 }], { mode: 'scalar', null_as_zero: ['total_net_amount'] }).match, true);
  assert.equal(compareResultsDetailed(gold, [{ total: null }], { mode: 'scalar' }).match, true);
  assert.equal(compareResultsDetailed(gold, [], { mode: 'scalar', null_as_zero: ['total_net_amount'] }).reason, 'row_count');
});

test('a behavior case\'s outcome agrees with its majority, as an answer case\'s agrees with majorityPass', () => {
  const judged = (repetition) => ({ ...repetition, ...classifyRepetition(repetition, abstainCase) });
  const declined = judged(behaviorRep('validation_error'));
  const answered = judged(behaviorRep('answered'));
  const truncated = judged({ status: 'llm_error', error_code: 'LLM_TRUNCATED', attempts: [] });
  // 2 of 4 declined is no majority: 'declined' is the most frequent single
  // outcome, but the case was not handled, so its outcome is a failure.
  const half = summarizeCaseRepetitions([declined, declined, answered, truncated]);
  assert.equal(half.behavior.majorityHandled, false);
  assert.notEqual(half.outcome, 'declined');
  assert.equal(half.bucket, 'model');
  // 2 of 3 declined is handled.
  const most = summarizeCaseRepetitions([declined, answered, declined]);
  assert.equal(most.behavior.majorityHandled, true);
  assert.equal(most.outcome, 'declined');
  assert.equal(most.bucket, 'pass');
  // Nothing judged (a timeout): the usual outcome.
  const timedOut = summarizeCaseRepetitions([judged({ status: 'aborted', timed_out: true, error_code: 'CASE_TIMEOUT', attempts: [] })]);
  assert.equal(timedOut.behavior.majorityHandled, null);
  assert.equal(timedOut.outcome, 'timeout');
});

test('a rescore\'s --gate coverage counts only answer cases of today\'s suite (behavior cases are never compared)', () => {
  const record = (id) => ({ id, question: `${id}?`, gold_fingerprint: `g_${id}`, summary: { counted: 1, passes: 1, passRate: 1, majorityPass: true, outcome: 'pass' } });
  const recorded = { results: ['a0', 'a1'].map(record) };
  const comparison = compareReports(recorded, recorded, { resamples: 50 });
  const coverage = describeSuiteCoverage([{ testCase: { id: 'a0' } }, { testCase: { id: 'a1' } }, { testCase: abstainCase }, { testCase: clarifyCase }], comparison);
  assert.equal(coverage.suiteCases, 2);
  assert.equal(coverage.paired, 2);
  assert.deepEqual(coverage.notInReport, []);
});

test('the progress line judges a behavior case on whether it declined, and keeps a timeout a timeout', () => {
  // abstainCase is a holdout case: revealed here, hidden by default (below).
  const line = (result) => formatProgress({ testCase: abstainCase, repetition: 1, result, completed: 1, total: 1, repeat: 1, revealHoldout: true });
  assert.match(line(behaviorRep('validation_error')), /^\[1\/1\] ok {3}hard_abstain_headcount: declined \(expects abstain\)/);
  assert.match(line(behaviorRep('answered')), /FAIL hard_abstain_headcount: answered_instead_of_abstain \(expects abstain\)/);
  assert.match(line({ status: 'aborted', timed_out: true, late_status: 'answered', attempts: [] }), /FAIL hard_abstain_headcount: timeout \(finished late: answered\)/);
  assert.match(line({ status: 'skipped_budget', attempts: [] }), /skip hard_abstain_headcount: skipped_budget/);
  // By default a holdout case's progress line names neither the case nor its verdict.
  const hidden = formatProgress({ testCase: abstainCase, repetition: 2, result: behaviorRep('answered'), completed: 3, total: 12, repeat: 3 });
  assert.equal(hidden, '[ 3/12] done a holdout case rep 2/3 (result hidden: aggregate only)');
});
