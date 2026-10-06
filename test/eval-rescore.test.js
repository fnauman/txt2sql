import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compareReports } from '../src/eval/compare.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { recordedRepetitions, rescoreReportCases, rescoreRepetition, testCaseFromRecord } from '../src/eval/rescore.js';
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
  assert.equal(oldRule.attempts[0].validation.ok, true);
  assert.equal(oldRule.attempts[0].validation.durationMs, null, 'durations are not re-measured');
  const { laterAttempts, ...rescoreInfo } = oldRule.rescore;
  assert.deepEqual(rescoreInfo, { replayed: true, originalStatus: 'result_mismatch', originalAttemptCount: 2, replayedAttemptCount: 1, replayTruncated: false, inherited: false });
  // The attempt the replay did not reach is still judged today (not replayed).
  assert.deepEqual(
    laterAttempts.map((entry) => [entry.attempt, entry.validation.ok, entry.oracle.match, entry.oracle.reason]),
    [[2, true, false, 'values']]
  );
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

test('a rescore keeps every recorded attempt: the ones its replay did not reach keep their SQL and LLM details', async () => {
  const source = await loadSource();
  const recordedAttempts = source.results.find((record) => record.id === 'rec_customers_old_rule').repetitions[0].attempts;
  const { report } = await rescoreToReport(source);
  const oldRule = byId(report).rec_customers_old_rule.repetitions[0];
  // The replay stops at attempt 1 (accepted today); attempt 2 is kept, marked.
  assert.deepEqual(oldRule.attempts.map((attempt) => [attempt.attempt, attempt.replay]), [
    [1, 'reached'],
    [2, 'not_reached'],
  ]);
  const later = oldRule.attempts[1];
  assert.equal(later.generatedSql, recordedAttempts[1].generatedSql);
  assert.deepEqual(later.llm, recordedAttempts[1].llm);
  assert.equal(later.retry, true);
  // Not reached: no verdict of today's replay, the recorded one kept apart.
  assert.deepEqual([later.validation, later.execution], [null, null]);
  assert.deepEqual(later.recorded, { validation: recordedAttempts[1].validation, execution: recordedAttempts[1].execution });
  // Original-run statistics: both LLM calls and the retry are still there.
  assert.equal(oldRule.attempt_count, 2);
  assert.equal(oldRule.rescore.replayedAttemptCount, 1);
  assert.equal(report.stats.retries.retryCalls, 1);
  // The final reached attempt is still the final one for the confusion matrix.
  assert.equal(report.attribution.guardrailConfusion.unknownBy.notFinal, 0);

  // A later validator change rejects attempt 1 again: the rescore of the
  // rescore can still replay the recorded retry instead of truncating.
  const { connections } = fakeFixtures();
  const probe = createValidatorProbe({ schema, connection: connections[0].connection });
  const stricter = Object.assign(
    async (question, sql, options) => (sql === recordedAttempts[0].generatedSql ? { code: 'NEW_RULE', layer: 'guardrail', message: 'NEW_RULE: rejected' } : probe(question, sql, options)),
    { promptFor: probe.promptFor }
  );
  const again = await rescoreRepetition(oldRule, {
    testCase: testCaseFromRecord(byId(report).rec_customers_old_rule),
    connections,
    goldCache: createGoldCache(),
    schema,
    validate: stricter,
    statementTimeoutMs: 8000,
  });
  assert.deepEqual([again.status, again.rescore.replayTruncated], ['result_mismatch', false]);
  assert.deepEqual(again.attempts.map((attempt) => [attempt.attempt, attempt.replay, attempt.validation?.ok]), [
    [1, 'reached', false],
    [2, 'reached', true],
  ]);
  assert.equal(again.generated_sql, recordedAttempts[1].generatedSql);
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
      // A live run's late answer, recorded as a timeout (the pool's late_status).
      { ...source.results[0], id: 'late', repetitions: [{ ...base, status: 'aborted', timed_out: true, late_status: 'pass', error_stage: 'aborted', error_code: 'CASE_TIMEOUT' }] },
      {
        ...source.results[0],
        id: 'outage',
        repetitions: [
          {
            ...base,
            status: 'llm_error',
            error: 'rate limited',
            error_code: 'HTTP_429',
            attempts: [{ attempt: 1, retry: false, generatedSql: null, llm: { ok: false, durationMs: 5, code: 'HTTP_429', error: { message: 'rate limited' } }, validation: null, execution: null }],
          },
        ],
      },
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
  assert.equal(records.timed_out.repetitions[0].rescore.inherited, true);
  assert.equal(records.legacy_pass.repetitions[0].rescore.inherited, false);
  const outage = records.outage.repetitions[0];
  assert.deepEqual([outage.status, outage.outcome, outage.error_code, outage.counted, outage.rescore.inherited], ['llm_error', 'llm_outage', 'HTTP_429', false, true]);
  assert.deepEqual([records.db_was_down.repetitions[0].status, records.db_was_down.repetitions[0].outcome], ['pass', 'pass']);
  // A late answer's recorded attempts completed, so it is re-judged like any
  // run cut short after its answer; none of the live timeout's fields remain.
  const late = records.late.repetitions[0];
  assert.deepEqual([late.status, late.rescore.originalStatus, 'timed_out' in late, 'late_status' in late, late.error_code], ['pass', 'aborted', false, false, undefined]);

  // An infrastructure failure during the replay stops it as infra_error.
  const { report: down } = await rescoreToReport(legacy, { down: new Set(['v2']) });
  const lost = byId(down).legacy_pass.repetitions[0];
  // The gold check runs first and fails on the dead fixture: an infrastructure failure, not a broken gold.
  assert.deepEqual([lost.status, lost.error_code, lost.outcome, lost.counted], ['expected_sql_error', 'PROTOCOL_CONNECTION_LOST', 'infra_error', false]);
});

test('a recorded guardrail verdict never survives a rescore: today\'s rejections are re-checked, others lose it', async () => {
  const source = await loadSource();
  const record = source.results.find((entry) => entry.id === 'rec_customers_old_rule');
  // As a live run would have recorded it: attempt 1 (the then-correct SQL) was a
  // guardrail FALSE rejection, attempt 2 was wrong.
  const falselyRejected = (sql) => ({
    ...source,
    results: [
      {
        ...record,
        repetitions: [
          {
            ...record.repetitions[0],
            outcome: 'guardrail_false_rejection',
            bucket: 'system',
            attempts: record.repetitions[0].attempts.map((attempt, index) =>
              index === 0 ? { ...attempt, generatedSql: sql, guardrailCheck: { verdict: 'false_rejection', matchedGold: 'expected_sql', reason: 'match' } } : attempt
            ),
          },
        ],
      },
    ],
  });

  // 1. Today the validator accepts attempt 1, but the gold changed so it is wrong:
  //    the model's error, not a guardrail's.
  const recorded = testCaseFromRecord(record);
  const changedGold = normalizeBenchmarkCase({ ...recorded, expected_sql: 'SELECT COUNT(*) AS customer_count FROM Customer WHERE IsActive = 1' });
  const { report: accepted } = await rescoreToReport(falselyRejected(record.repetitions[0].attempts[0].generatedSql), {
    currentCases: new Map([[changedGold.id, changedGold]]),
  });
  const acceptedRep = accepted.results[0].repetitions[0];
  // The replay stops at attempt 1; attempt 2 is kept, not reached.
  assert.deepEqual(acceptedRep.attempts.map((attempt) => [attempt.replay, attempt.validation?.ok ?? null, 'guardrailCheck' in attempt]), [
    ['reached', true, false],
    ['not_reached', null, false],
  ]);
  assert.deepEqual([acceptedRep.status, acceptedRep.outcome, acceptedRep.bucket], ['result_mismatch', 'wrong_result', 'model']);
  assert.equal(accepted.attribution.system.guardrailFalseRejections, 0);
  assert.equal(accepted.attribution.guardrailConfusion.fp, 0);

  // 2. Today the SAFETY layer rejects attempt 1 (never executed); attempt 2 is wrong.
  const { report: unsafe, sent } = await rescoreToReport(falselyRejected('SELECT COUNT(*) AS customer_count FROM Customer -- all'));
  const unsafeRep = unsafe.results[0].repetitions[0];
  assert.deepEqual(unsafeRep.attempts.map((attempt) => [attempt.validation.layer ?? 'accepted', 'guardrailCheck' in attempt]), [
    ['safety', false],
    ['accepted', false],
  ]);
  assert.deepEqual([unsafeRep.outcome, unsafeRep.bucket], ['wrong_result', 'model']);
  assert.ok(!sent.some((line) => line.includes('-- all')), 'a safety rejection is never executed');
});

test('the validator probe throws a database failure in the master-data lookup instead of hiding it', async () => {
  let attempts = 0;
  const closed = () => Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true });
  const flaky = {
    async query() {
      attempts += 1;
      throw attempts === 1 ? closed() : Object.assign(new Error('Query execution was interrupted (max_statement_time exceeded)'), { code: 'ER_STATEMENT_TIMEOUT' });
    },
  };
  const probe = createValidatorProbe({ schema, connection: flaky, statementTimeoutMs: 5000 });
  const question = 'seltzer sales by month';
  await assert.rejects(probe.promptFor(question), /closed state/);
  // Not cached: the next call looks up again; a statement timeout degrades to no candidates, as in the product.
  const prompt = await probe.promptFor(question);
  assert.deepEqual(prompt.masterDataCandidates, []);
  assert.equal(attempts, 2);

  // In a rescore, the repetition becomes infra_error (excluded, and a harness failure today).
  const source = await loadSource();
  const record = source.results.find((entry) => entry.id === 'rec_active_customers');
  const failing = async () => Promise.reject(closed());
  const validate = Object.assign(async () => null, { promptFor: failing });
  const { connections } = fakeFixtures();
  const [rescored] = await rescoreReportCases(
    { ...source, results: [record] },
    { connections, goldCache: createGoldCache(), schema, validate, statementTimeoutMs: 8000 }
  );
  assert.deepEqual(
    rescored.repetitions.map((rep) => [rep.status, rep.error_stage, rep.rescore.inherited]),
    [
      ['infra_error', 'infra', false],
      ['infra_error', 'infra', false],
    ]
  );
});

test('a recorded gold failure whose gold passes today is marked stale, and a gold that fails on a dead connection is infra', async () => {
  const source = await loadSource();
  const record = source.results.find((entry) => entry.id === 'rec_active_customers');
  const goldFailed = {
    ...source,
    results: [
      {
        ...record,
        repetitions: [{ repetition: 1, status: 'expected_sql_error', error: 'gold failed', error_stage: 'gold', error_code: 'ER_NO_SUCH_TABLE', attempts: [], attempt_count: 0 }],
      },
    ],
  };
  const { report } = await rescoreToReport(goldFailed);
  const [rep] = report.results[0].repetitions;
  assert.deepEqual([rep.status, rep.outcome, rep.counted, rep.rescore.staleGoldError, rep.rescore.inherited], ['expected_sql_error', 'expected_sql_error', false, true, true]);
  assert.deepEqual(rep.outcome_tags, ['gold_passes_now']);

  // A gold query that fails on a dead fixture connection (no code, fatal) is the database's failure.
  const { connections } = fakeFixtures();
  connections[1].connection.query = async () => {
    throw Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true });
  };
  const validate = createValidatorProbe({ schema, connection: connections[0].connection });
  const [rescored] = await rescoreReportCases({ ...source, results: [record] }, { connections, goldCache: createGoldCache(), schema, validate });
  const records = await attributeCaseRuns([{ entry: rescored.entry, repetitions: rescored.repetitions }], { connections, goldCache: createGoldCache(), schema });
  assert.deepEqual(
    records[0].repetitions.map((entry) => [entry.status, entry.error_infra, entry.outcome]),
    [
      ['expected_sql_error', true, 'infra_error'],
      ['expected_sql_error', true, 'infra_error'],
    ]
  );
});
