import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compareReports } from '../src/eval/compare.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { recordedRepetitions, rescoreReportCases, testCaseFromRecord } from '../src/eval/rescore.js';
import { attributeCaseRuns, buildReport } from '../src/eval/runner.js';
import { createValidatorProbe } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Rescore with fake fixture databases: no MariaDB, no LLM. The recorded
// report (test/fixtures/eval-recorded-report.json) holds four cases:
// - rec_active_customers: rep 1 a correct answer, rep 2 a wrong one;
// - rec_customers_old_rule: attempt 1 (the gold itself) was rejected by an
//   older validator rule, attempt 2 was wrong; today's validator accepts
//   attempt 1, so the replay stops there and the case passes;
// - rec_commented_pass: passed once, but its SQL carries a comment, which the
//   safety layer now rejects; the product loop would have retried, which a
//   replay cannot do (replay_truncated);
// - rec_skipped: skipped by the budget, kept as is.

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

function fakeFixtures(answers = ANSWERS, { down = new Set() } = {}) {
  const sent = [];
  const connections = Object.entries(answers).map(([name, table]) => ({
    name,
    database: name === 'seed' ? 'demo_retail' : `demo_retail_${name}`,
    connection: {
      async query(statement) {
        const sql = String(statement).replace(/^SET STATEMENT .*? FOR /, '');
        sent.push(`${name}: ${sql}`);
        if (down.has(name)) {
          throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
        }
        if (!(sql in table)) {
          throw Object.assign(new Error(`Unexpected SQL: ${sql}`), { code: 'ER_PARSE_ERROR' });
        }
        return [table[sql]];
      },
    },
  }));
  return { connections, sent };
}

async function rescoreToReport(source, { currentCases = new Map(), answers = ANSWERS, down } = {}) {
  const { connections, sent } = fakeFixtures(answers, { down });
  const goldCache = createGoldCache();
  const validate = createValidatorProbe({ schema, connection: connections[0].connection });
  const rescored = await rescoreReportCases(source, { currentCases, connections, goldCache, schema, validate, statementTimeoutMs: 8000 });
  const caseRecords = await attributeCaseRuns(
    rescored.map((entry) => ({ entry: entry.entry, repetitions: entry.repetitions, extra: { case_source: entry.caseSource } })),
    { connections, goldCache, schema, statementTimeoutMs: 8000, goldTimeoutMs: 30000 }
  );
  const report = buildReport({
    mode: 'rescore',
    generatedAt: new Date().toISOString(),
    runTimestamp: 'now',
    model: source.model,
    schemaPath: 'generated/schema.json',
    suite: source.suite,
    oracle: { fixtures: [], maxRetries: 1, statementTimeoutMs: 8000, goldTimeoutMs: 30000 },
    runner: { ...source.runner, rescore: true },
    provenance: null,
    caseRecords,
    comparison: compareReports(source, { results: caseRecords, model: source.model }, { resamples: 500 }),
    rescoredFrom: { path: 'test/fixtures/eval-recorded-report.json' },
    statsOptions: { resamples: 500 },
  });
  return { report, sent };
}

const loadSource = async () => JSON.parse(await fs.readFile(FIXTURE_REPORT, 'utf8'));
const byId = (report) => Object.fromEntries(report.results.map((record) => [record.id, record]));

test('rescore replays recorded attempts through today\'s validator and oracle', async () => {
  const { report, sent } = await rescoreToReport(await loadSource());
  const records = byId(report);

  const active = records.rec_active_customers;
  assert.deepEqual(active.repetitions.map((rep) => [rep.status, rep.outcome]), [
    ['pass', 'pass'],
    ['result_mismatch', 'wrong_result'],
  ]);
  assert.deepEqual([active.summary.passes, active.summary.counted], [1, 2]);
  assert.deepEqual(active.repetitions[1].oracle.killed_on, ['seed', 'v2']);

  const oldRule = records.rec_customers_old_rule.repetitions[0];
  assert.equal(oldRule.status, 'pass');
  assert.equal(oldRule.attempt_count, 1, 'the replay stops at the first accepted attempt');
  assert.equal(oldRule.attempts[0].validation.ok, true);
  assert.equal(oldRule.attempts[0].validation.durationMs, null, 'durations are not re-measured');
  assert.deepEqual(oldRule.rescore, { replayed: true, originalStatus: 'result_mismatch', originalAttemptCount: 2, replayTruncated: false });
  // Recorded cost and usage are kept: nothing was re-generated.
  assert.equal(oldRule.llm_cost.totalCost, 0.000574);

  const commented = records.rec_commented_pass.repetitions[0];
  assert.deepEqual([commented.status, commented.outcome, commented.bucket], ['validation_error', 'safety_rejection', 'model']);
  assert.equal(commented.attempts[0].validation.code, 'SQL_COMMENT');
  assert.equal(commented.rescore.replayTruncated, true);
  assert.deepEqual(commented.outcome_tags, ['replay_truncated']);

  const skipped = records.rec_skipped.repetitions[0];
  assert.deepEqual([skipped.status, skipped.outcome, skipped.counted], ['skipped_budget', 'skipped_budget', false]);
  assert.equal(skipped.rescore.replayed, false);

  // Safety-rejected SQL never reached a database.
  assert.ok(!sent.some((line) => line.includes('-- active only')));
  assert.equal(report.stats.cases.counted, 3);
  assert.equal(report.stats.strictAccuracy.value, Number(((0.5 + 1 + 0) / 3).toFixed(4)));
  // Against the recorded report: one improvement (old rule), one regression (comment).
  assert.deepEqual(report.comparison.flips.improvements.map((entry) => entry.id), ['rec_customers_old_rule']);
  assert.deepEqual(report.comparison.flips.regressions.map((entry) => entry.id), ['rec_commented_pass']);
});

test('rescoring the same report twice gives identical reports (modulo timestamps)', async () => {
  const source = await loadSource();
  const first = (await rescoreToReport(source)).report;
  const second = (await rescoreToReport(source)).report;
  const strip = (report) => ({ ...report, generatedAt: null });
  assert.deepEqual(strip(first), strip(second));
  // Rescoring the rescored report is a fixed point for the outcomes.
  const third = (await rescoreToReport(first)).report;
  assert.deepEqual(
    third.results.map((record) => record.repetitions.map((rep) => rep.outcome)),
    first.results.map((record) => record.repetitions.map((rep) => rep.outcome))
  );
});

test('today\'s dataset case wins over the recorded one, and a failing gold excludes the case', async () => {
  const source = await loadSource();
  const recorded = testCaseFromRecord(source.results[0]);
  assert.equal(recorded.comparison.mode, 'scalar');
  const changed = normalizeBenchmarkCase({ ...recorded, expected_sql: 'SELECT broken FROM Nowhere' });
  const { report } = await rescoreToReport(source, { currentCases: new Map([[changed.id, changed]]) });
  const record = byId(report).rec_active_customers;
  assert.equal(record.case_source, 'current dataset');
  assert.equal(record.expected_sql, 'SELECT broken FROM Nowhere');
  assert.deepEqual(record.repetitions.map((rep) => [rep.status, rep.outcome, rep.counted]), [
    ['expected_sql_error', 'expected_sql_error', false],
    ['expected_sql_error', 'expected_sql_error', false],
  ]);
  assert.equal(byId(report).rec_customers_old_rule.case_source, 'recorded');
});

test('runs cut short keep their status unless a recorded attempt now completes; pre-runner reports replay too', async () => {
  const source = await loadSource();
  const base = source.results[0].repetitions[0];
  const rejectedAttempt = { ...base.attempts[0], generatedSql: 'SELECT COUNT(*) AS active_customers FROM Customer WHERE IsActive = 1 -- x' };
  const legacy = {
    model: 'gpt-4o-mini',
    oracle: { maxRetries: 1 },
    suite: source.suite,
    runner: {},
    results: [
      // pre-runner shape: no repetitions[], the result is the only repetition
      { ...source.results[0], id: 'legacy_pass', repetitions: undefined, summary: undefined, ...base },
      { ...source.results[0], id: 'timed_out', repetitions: [{ ...base, status: 'aborted', timed_out: true, error_code: 'CASE_TIMEOUT', attempts: [rejectedAttempt] }] },
      { ...source.results[0], id: 'db_was_down', repetitions: [{ ...base, status: 'infra_error', error_code: 'ECONNRESET' }] },
    ],
  };
  assert.equal(recordedRepetitions(legacy.results[0]).length, 1);
  const { report } = await rescoreToReport(legacy);
  const records = byId(report);
  assert.equal(records.legacy_pass.repetitions[0].status, 'pass');
  assert.deepEqual(
    [records.timed_out.repetitions[0].status, records.timed_out.repetitions[0].outcome, records.timed_out.repetitions[0].error_code],
    ['aborted', 'timeout', 'CASE_TIMEOUT']
  );
  assert.deepEqual([records.db_was_down.repetitions[0].status, records.db_was_down.repetitions[0].outcome], ['pass', 'pass']);

  // An infrastructure failure during the replay stops it as infra_error.
  const { report: down } = await rescoreToReport(legacy, { down: new Set(['v2']) });
  const lost = byId(down).legacy_pass.repetitions[0];
  // The gold check runs first and fails on the dead fixture: an infrastructure failure, not a broken gold.
  assert.deepEqual([lost.status, lost.error_code, lost.outcome, lost.counted], ['expected_sql_error', 'PROTOCOL_CONNECTION_LOST', 'infra_error', false]);
});
