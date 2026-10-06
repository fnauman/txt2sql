import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { computeExitCode, validateBaselineReport } from '../scripts/eval.js';
import {
  compactAttempt,
  compactReport,
  compactReportProblem,
  COMPACT_REPORT_VERSION,
  isCompactReport,
  serializeCompactReport,
  writeCompactReport,
} from '../src/eval/compact-report.js';
import { compareReports } from '../src/eval/compare.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { rescoreReportCases, testCaseFromRecord } from '../src/eval/rescore.js';
import { attributeCaseRuns, buildReport, caseMetadata } from '../src/eval/runner.js';
import { createValidatorProbe } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// The compact baseline (--write-baseline): what --offline/--rescore,
// --compare/--gate and the summaries read, nothing else. A rescore of the
// compact form must give the same outcomes and statistics as a rescore of the
// full report, a comparison against it the same verdict, and its size must
// stay small enough to commit.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_REPORT = path.join(REPO_ROOT, 'test/fixtures/eval-recorded-report.json');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

const ANSWERS = {
  seed: {
    'SELECT COUNT(*) AS active_customer_count FROM Customer WHERE IsActive = 1': [{ active_customer_count: 5 }],
    'SELECT COUNT(*) AS active_customers FROM Customer WHERE IsActive = 1': [{ active_customers: 5 }],
    'SELECT COUNT(*) AS active_customers FROM Customer': [{ active_customers: 6 }],
    'SELECT COUNT(*) AS customer_count FROM Customer': [{ customer_count: 6 }],
    'SELECT COUNT(*) AS customer_count FROM Customer WHERE IsActive = 1': [{ customer_count: 5 }],
  },
  v2: {
    'SELECT COUNT(*) AS active_customer_count FROM Customer WHERE IsActive = 1': [{ active_customer_count: 4 }],
    'SELECT COUNT(*) AS active_customers FROM Customer WHERE IsActive = 1': [{ active_customers: 4 }],
    'SELECT COUNT(*) AS active_customers FROM Customer': [{ active_customers: 6 }],
    'SELECT COUNT(*) AS customer_count FROM Customer': [{ customer_count: 6 }],
    'SELECT COUNT(*) AS customer_count FROM Customer WHERE IsActive = 1': [{ customer_count: 4 }],
  },
};

function fakeFixtures() {
  return Object.entries(ANSWERS).map(([name, table]) => ({
    name,
    database: name === 'seed' ? 'demo_retail' : `demo_retail_${name}`,
    connection: {
      async query(statement) {
        const sql = String(statement).replace(/^SET STATEMENT .*? FOR /, '');
        if (!(sql in table)) {
          throw Object.assign(new Error(`Unexpected SQL: ${sql}`), { code: 'ER_PARSE_ERROR' });
        }
        return [table[sql]];
      },
    },
  }));
}

// The recorded fixture report plus an abstain case (kept as recorded by a
// rescore) whose two repetitions answered and declined.
async function loadSource() {
  const source = JSON.parse(await fs.readFile(FIXTURE_REPORT, 'utf8'));
  const abstain = normalizeBenchmarkCase({
    id: 'rec_abstain_headcount',
    intentId: 'employee_headcount',
    split: 'holdout',
    expected_behavior: 'abstain',
    question: 'What is our employee headcount by store?',
  });
  const answered = {
    repetition: 1,
    status: 'answered',
    warnings: [],
    generated_sql: 'SELECT COUNT(*) AS customer_count FROM Customer',
    explanation: 'Counts customers as a stand-in for staff.',
    assumptions: ['staff are customers'],
    retrieved_tables: ['Customer'],
    master_data_candidates: [{ table: 'Store', value: 'North' }],
    attempts: [
      {
        attempt: 1,
        retry: false,
        generatedSql: 'SELECT COUNT(*) AS customer_count FROM Customer',
        llm: { ok: true, durationMs: 900, usage: { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2050 }, cost: { currency: 'USD', inputCost: 0.0003, outputCost: 0.00003, totalCost: 0.00033 }, model: 'gpt-4o-mini', finishReason: 'stop', tablesUsed: ['Customer'] },
        validation: { ok: true, durationMs: 0.5, tablesUsed: ['Customer'] },
        execution: { ok: true, durationMs: 1, rowCount: 1, truncated: false },
      },
    ],
    attempt_count: 1,
    llm_usage: { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2050 },
    llm_cost: { currency: 'USD', inputCost: 0.0003, outputCost: 0.00003, totalCost: 0.00033, promptTokens: 2000, completionTokens: 50 },
    timings: { totalMs: 1000, questionMs: 950, llmMs: 900, validationMs: 0.5, executionMs: 1 },
  };
  const declined = {
    ...answered,
    repetition: 2,
    status: 'validation_error',
    generated_sql: '',
    error: 'Model did not return SQL.',
    error_stage: 'validation',
    error_code: 'EMPTY_SQL',
    attempts: [{ ...answered.attempts[0], generatedSql: '', validation: { ok: false, durationMs: 0.1, code: 'EMPTY_SQL', layer: 'safety', message: 'Model did not return SQL.' }, execution: null }],
  };
  const [record] = await attributeCaseRuns([{ entry: { testCase: abstain, datasets: ['hard'] }, repetitions: [answered, declined] }], { checkGuardrails: false });
  source.results.push({ ...caseMetadata(abstain, ['hard']), ...record });
  return source;
}

async function rescoreToReport(source) {
  const connections = fakeFixtures();
  const goldCache = createGoldCache();
  const validate = createValidatorProbe({ schema, connection: connections[0].connection });
  const rescored = await rescoreReportCases(source, { connections, goldCache, schema, validate, statementTimeoutMs: 8000 });
  const caseRecords = await attributeCaseRuns(
    rescored.map((entry) => ({ entry: entry.entry, repetitions: entry.repetitions, extra: { case_source: entry.caseSource } })),
    { connections, goldCache, schema, statementTimeoutMs: 8000, goldTimeoutMs: 30000 }
  );
  return buildReport({
    mode: 'rescore',
    generatedAt: '2026-10-06T00:00:00.000Z',
    runTimestamp: 'now',
    model: source.model,
    schemaPath: 'generated/schema.json',
    suite: source.suite,
    oracle: { fixtures: [], maxRetries: 1, statementTimeoutMs: 8000, goldTimeoutMs: 30000 },
    runner: { ...source.runner, rescore: true },
    provenance: null,
    caseRecords,
    comparison: compareReports(source, { results: caseRecords, model: source.model }, { resamples: 500 }),
    statsOptions: { resamples: 500 },
  });
}

// What a rescore decides per case and repetition (the carried-over recorded
// text, such as explanations, is what the compact form leaves out).
const verdicts = (report) =>
  report.results.map((record) => ({
    id: record.id,
    summary: record.summary,
    repetitions: record.repetitions.map((rep) => ({
      status: rep.status,
      outcome: rep.outcome,
      bucket: rep.bucket,
      counted: rep.counted,
      behavior_counted: rep.behavior_counted,
      outcome_tags: rep.outcome_tags,
      error_code: rep.error_code ?? null,
      generated_sql: rep.generated_sql,
      attempt_count: rep.attempt_count,
      rescore: rep.rescore,
      attempts: rep.attempts.map((attempt) => [attempt.attempt, attempt.replay, attempt.generatedSql, attempt.validation?.ok ?? null, attempt.validation?.code ?? null, attempt.execution?.ok ?? null, attempt.guardrailCheck?.verdict ?? null]),
    })),
  }));

test('a rescore of the compact report gives the outcomes and statistics of a rescore of the full one', async () => {
  const full = await loadSource();
  const compact = JSON.parse(serializeCompactReport(compactReport(full)));
  assert.equal(isCompactReport(compact), true);

  const fromFull = await rescoreToReport(full);
  const fromCompact = await rescoreToReport(compact);
  assert.deepEqual(verdicts(fromCompact), verdicts(fromFull));
  for (const block of ['stats', 'attribution', 'behavior', 'total', 'passed', 'failed', 'accuracy', 'statusCounts', 'warningCounts']) {
    assert.deepEqual(fromCompact[block], fromFull[block], block);
  }
  // The comparison each makes with its own source: same pairing and verdict.
  const { baseline: _a, candidate: _b, ...againstFull } = fromFull.comparison;
  const { baseline: _c, candidate: _d, ...againstCompact } = fromCompact.comparison;
  assert.deepEqual(againstCompact, againstFull);
  assert.deepEqual(fromFull.comparison.flips.improvements.map((entry) => entry.id), ['rec_customers_old_rule']);
  // The abstain case is kept as recorded: 1 of 2 declined is not handled.
  const abstain = fromCompact.results.find((record) => record.id === 'rec_abstain_headcount');
  assert.deepEqual(abstain.repetitions.map((rep) => rep.outcome), ['answered_instead_of_abstain', 'declined']);
  assert.equal(abstain.summary.behavior.majorityHandled, false);
  // A rescored report (replay marks, recorded verdicts of attempts not
  // reached) compacts too: rescoring it again matches rescoring the full one.
  const again = await rescoreToReport(JSON.parse(serializeCompactReport(compactReport(fromCompact))));
  const againFull = await rescoreToReport(fromFull);
  assert.deepEqual(verdicts(again), verdicts(againFull));
  assert.deepEqual(again.stats, againFull.stats);
});

test('--compare and --gate read a compact baseline exactly like the full report', async () => {
  const full = await loadSource();
  const compact = JSON.parse(serializeCompactReport(compactReport(full)));
  assert.equal(validateBaselineReport(compact, 'compact.json'), compact);
  const candidate = await rescoreToReport(full);
  const withFull = compareReports(full, candidate, { resamples: 500 });
  const withCompact = compareReports(compact, candidate, { resamples: 500 });
  assert.deepEqual(withCompact, withFull);
  assert.equal(withFull.paired, 3);
  for (const gate of [true, false]) {
    assert.deepEqual(computeExitCode({ ...candidate, comparison: withCompact }, { gate }), computeExitCode({ ...candidate, comparison: withFull }, { gate }));
  }
  // Every case is rebuilt the same from the compact record (a case that left
  // the datasets is rescored from it).
  for (const [index, record] of full.results.entries()) {
    assert.deepEqual(testCaseFromRecord(compact.results[index]), testCaseFromRecord(record), record.id);
  }
});

test('a compact report is marked, versioned, idempotent and one line per case; an unknown version is refused', async () => {
  const full = await loadSource();
  const compact = compactReport(full);
  assert.deepEqual([compact.compact, compact.compactVersion, compact.reportVersion], [true, COMPACT_REPORT_VERSION, 2]);
  const text = serializeCompactReport(compact);
  assert.deepEqual(JSON.parse(text), compact);
  assert.equal(serializeCompactReport(compactReport(JSON.parse(text))), text, 'compacting a compact report changes nothing');
  const caseLines = text.split('\n').filter((line) => line.startsWith('    {"id":'));
  assert.equal(caseLines.length, full.results.length);

  // What is left out, and what stays.
  const record = compact.results[0];
  const repetition = record.repetitions[0];
  for (const dropped of ['explanation', 'assumptions', 'tables_used', 'retrieved_tables', 'master_data_candidates', 'oracle', 'expected_rows_preview', 'actual_rows_preview', 'signal_warnings', 'attempts']) {
    assert.equal(dropped in record, false, `case ${dropped}`);
  }
  for (const dropped of ['explanation', 'assumptions', 'retrieved_tables', 'master_data_candidates', 'oracle', 'expected_rows_preview', 'actual_rows_preview', 'generated_sql']) {
    assert.equal(dropped in repetition, false, `repetition ${dropped}`);
  }
  for (const kept of ['id', 'question', 'expected_sql', 'gold_fingerprint', 'scoring_fingerprint', 'summary', 'datasets']) {
    assert.ok(kept in record || full.results[0][kept] === undefined, `case ${kept}`);
  }
  assert.deepEqual(Object.keys(repetition.attempts[0]), ['attempt', 'retry', 'generatedSql', 'llm', 'validation', 'execution']);
  assert.deepEqual(repetition.attempts[0].llm, {
    ok: true,
    durationMs: 1300,
    usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100, prompt_tokens_details: { cached_tokens: 1024 } },
    cost: { totalCost: 0.000287 },
    tablesUsed: ['Customer'],
  });
  assert.deepEqual(repetition.attempts[0].execution, { ok: true, rowCount: 1, truncated: false });
  // A recorded guardrail verdict is re-judged by a rescore, never kept.
  assert.equal('guardrailCheck' in compactAttempt({ attempt: 1, guardrailCheck: { verdict: 'false_rejection' } }), false);

  assert.equal(compactReportProblem(full), null);
  assert.equal(compactReportProblem(compact), null);
  assert.match(compactReportProblem({ ...compact, compactVersion: COMPACT_REPORT_VERSION + 1 }), /compactVersion 2 \(this runner reads compact reports up to version 1\)/);
  assert.throws(() => validateBaselineReport({ ...compact, compactVersion: 99 }, 'b.json'), (error) => error.code === 'REPORT_INVALID' && /b\.json is marked compact/.test(error.message));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-compact-'));
  try {
    const target = path.join(dir, 'nested', 'baseline.json');
    const bytes = await writeCompactReport(target, full);
    assert.equal(await fs.readFile(target, 'utf8'), text);
    assert.equal(bytes, Buffer.byteLength(text));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A deterministic stand-in for a real 255-case report at --repeat 3, with
// the bulky fields a live run records.
function syntheticReport({ cases = 255, repeat = 3 } = {}) {
  let state = 20261006;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const words = (count) => Array.from({ length: count }, (_, index) => ['net', 'sales', 'customer', 'store', 'March', 'brand', 'quantity', 'total'][(index + Math.floor(random() * 8)) % 8]).join(' ');
  const sql = () =>
    `SELECT c.CustomerName AS customer_name, ROUND(COALESCE(SUM(d.NetAmount), 0), 2) AS net_sales FROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId ` +
    `WHERE d.IsCanceled = 0 AND d.DocumentDate >= '2026-0${1 + Math.floor(random() * 5)}-01' AND d.DocumentDate < '2026-0${2 + Math.floor(random() * 5)}-01' ` +
    `GROUP BY c.CustomerName ORDER BY net_sales DESC LIMIT ${1 + Math.floor(random() * 5)}`;
  const usage = () => ({
    prompt_tokens: 4100,
    completion_tokens: 140,
    total_tokens: 4240,
    prompt_tokens_details: { cached_tokens: 3072, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  });
  const cost = () => ({ model: 'gpt-4o-mini', currency: 'USD', promptTokens: 4100, cachedPromptTokens: 3072, uncachedPromptTokens: 1028, completionTokens: 140, totalTokens: 4240, inputCost: 0.000384, outputCost: 0.000084, totalCost: 0.000468 });
  const rows = () => Array.from({ length: 5 }, (_, index) => ({ customer_name: `Customer ${index} ${words(2)}`, net_sales: Number((random() * 10000).toFixed(2)) }));
  const results = [];
  for (let index = 0; index < cases; index += 1) {
    const gold = sql();
    const repetitions = [];
    for (let rep = 1; rep <= repeat; rep += 1) {
      const retried = random() < 0.2;
      const attempts = (retried ? [1, 2] : [1]).map((number) => ({
        attempt: number,
        retry: number > 1,
        generatedSql: sql(),
        llm: { ok: true, durationMs: 1800 + random() * 900, usage: usage(), cost: cost(), model: 'gpt-4o-mini-2024-07-18', finishReason: 'stop', tablesUsed: ['SalesDocument', 'Customer'] },
        validation:
          retried && number === 1
            ? { ok: false, durationMs: 0.4, code: 'METRIC_COLUMN', layer: 'guardrail', message: 'SQL does not use a preferred column for semantic metric "net_sales" (SalesDocument.NetAmount).' }
            : { ok: true, durationMs: 0.5, tablesUsed: ['SalesDocument', 'Customer'] },
        execution: retried && number === 1 ? null : { ok: true, durationMs: 3.2, rowCount: 5, truncated: false },
        ...(retried && number === 1 ? { guardrailCheck: { verdict: 'true_rejection', matchedGold: null, reason: 'values', killedOn: ['seed', 'v2', 'v3'] } } : {}),
      }));
      repetitions.push({
        repetition: rep,
        status: 'pass',
        warnings: [],
        generated_sql: attempts.at(-1).generatedSql,
        explanation: words(60),
        assumptions: [words(15), words(12)],
        tables_used: ['SalesDocument', 'Customer'],
        retrieved_tables: ['SalesDocument', 'SalesDocumentLine', 'Customer', 'Store', 'Product', 'Brand', 'Category', 'Campaign'],
        master_data_candidates: Array.from({ length: 4 }, (_, k) => ({ table: 'Customer', column: 'CustomerName', value: `Customer ${k}`, score: 0.8 })),
        attempts,
        attempt_count: attempts.length,
        oracle: {
          matched_gold: 'expected_sql',
          reason: 'match',
          per_fixture: ['seed', 'v2', 'v3'].map((fixture) => ({ fixture, match: true, matchAny: true, reason: 'match', goldRowCount: 5, actualRowCount: 5, truncated: false, error: null })),
          killed_on: [],
          assignment: { customer_name: 'customer_name', net_sales: 'net_sales' },
        },
        signal_warnings: [],
        disallowed_column_warnings: [],
        expected_rows_preview: rows(),
        actual_rows_preview: rows(),
        llm_usage: { prompt_tokens: 4100 * attempts.length, completion_tokens: 140 * attempts.length, total_tokens: 4240 * attempts.length, prompt_tokens_details: { cached_tokens: 3072 * attempts.length } },
        llm_cost: { ...cost(), totalCost: 0.000468 * attempts.length },
        timings: { totalMs: 2400.123, questionMs: 2100.456, llmMs: 1900.789, validationMs: 0.912, executionMs: 3.204 },
        outcome: 'pass',
        bucket: 'pass',
        counted: true,
        outcome_tags: [],
      });
    }
    const id = `tpl_customer_net_sales_top_${index}_${Math.floor(random() * 1e6).toString(16)}`;
    const testCase = normalizeBenchmarkCase({
      id,
      intentId: `customer_net_sales_top_${index}`,
      split: random() < 0.35 ? 'holdout' : 'dev',
      question: `Which ${words(4)} customers had the highest net sales in March 2026 (case ${index})?`,
      expected_sql: gold,
      alternative_expected_sql: random() < 0.2 ? [sql()] : [],
      expected_tables: ['SalesDocument', 'Customer'],
      comparison: { mode: 'ranked', compare_columns: ['customer_name', 'net_sales'], decimals: 2 },
      expected_row_counts: { seed: 2, v2: 3, v3: 5 },
      difficulty: 'medium',
      tags: ['templated', 'ranked', 'customer', 'net_sales'],
    });
    const { repetition: _first, ...firstFields } = repetitions[0];
    results.push({
      ...caseMetadata(testCase, ['templated-public']),
      ...firstFields,
      repetitions,
      summary: { repetitions: repeat, counted: repeat, passes: repeat, passRate: 1, majorityPass: true, outcome: 'pass', bucket: 'pass', tags: [], outcomes: { pass: repeat } },
    });
  }
  return {
    reportVersion: 2,
    mode: 'run',
    model: 'gpt-4o-mini',
    generatedAt: '2026-10-06T00:00:00.000Z',
    reliability: { repeat, perCase: results.map((record) => ({ id: record.id, attempts: repeat, passes: repeat, passRate: 1 })) },
    verification: { skipped: false, cases: cases, problems: [], notes: results.map((record) => `${record.id}: known validator rejection (TABLE_SCOPE)`), warnings: [], gateFailures: [], datasets: [] },
    traceFile: '/tmp/generated/runs/x/trace.jsonl',
    results,
  };
}

test('size: a 255-case report at --repeat 3 compacts to well under 1.5 MB', () => {
  const full = syntheticReport();
  const fullBytes = Buffer.byteLength(`${JSON.stringify(full, null, 2)}\n`);
  const compactBytes = Buffer.byteLength(serializeCompactReport(compactReport(full)));
  // The full report is written indented (writeJsonFile): about 8.9 MB here,
  // the compact form about 1.3 MB.
  assert.ok(fullBytes > 6 * 1024 * 1024, `full ${fullBytes}`);
  assert.ok(compactBytes < 1.5 * 1024 * 1024, `compact ${compactBytes} bytes`);
  assert.ok(compactBytes < fullBytes / 5, `compact ${compactBytes} vs full ${fullBytes}`);
});
