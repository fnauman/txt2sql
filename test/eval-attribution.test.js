import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateQuestion } from '../scripts/evaluate.js';
import {
  attributeRepetition,
  checkGuardrailRejections,
  classifyRepetition,
  guardrailConfusion,
  summarizeAttribution,
  summarizeCaseRepetitions,
} from '../src/eval/attribution.js';

const testCase = { id: 'case_1', expected_tables: ['SalesDocument', 'Customer'] };
const RETRIEVED = ['SalesDocument', 'Customer', 'StoreLocation'];

const llmOk = { ok: true, durationMs: 10, usage: null, cost: null };
const accepted = (sql, execution = { ok: true, durationMs: 1, rowCount: 1, truncated: false }) => ({
  attempt: 1,
  retry: false,
  generatedSql: sql,
  llm: llmOk,
  validation: { ok: true, durationMs: 1, tablesUsed: [] },
  execution,
});
const rejected = (sql, layer, code, extra = {}) => ({
  attempt: 1,
  retry: false,
  generatedSql: sql,
  llm: llmOk,
  validation: { ok: false, durationMs: 1, code, layer, message: `${code} rejected` },
  execution: null,
  ...extra,
});
const numbered = (attempts) => attempts.map((attempt, index) => ({ ...attempt, attempt: index + 1, retry: index > 0 }));
const repetition = (status, attempts = [], extra = {}) => ({ status, retrieved_tables: RETRIEVED, attempts: numbered(attempts), ...extra });

test('every outcome class gets its bucket and counted flag', () => {
  const cases = [
    [repetition('pass', [accepted('SELECT 1')]), 'pass', 'pass', true],
    [repetition('result_mismatch', [accepted('SELECT 1')]), 'wrong_result', 'model', true],
    [
      repetition('validation_error', [rejected('SELECT 1', 'guardrail', 'JOIN_PATH', { guardrailCheck: { verdict: 'true_rejection' } })]),
      'guardrail_true_rejection',
      'model',
      true,
    ],
    [
      repetition('validation_error', [rejected('SELECT 1', 'guardrail', 'FAN_OUT', { guardrailCheck: { verdict: 'false_rejection' } })]),
      'guardrail_false_rejection',
      'system',
      true,
    ],
    [repetition('validation_error', [rejected('DELETE FROM x', 'safety', 'WRITE_OPERATION')]), 'safety_rejection', 'model', true],
    [repetition('execution_error', [accepted('SELECT nope', { ok: false, stage: 'execution', code: 'ER_BAD_FIELD_ERROR' })]), 'execution_error', 'model', true],
    [repetition('llm_error', [], { error_code: 'LLM_TRUNCATED' }), 'llm_error', 'model', true],
    [repetition('llm_error', [], { error_code: 'HTTP_429' }), 'llm_outage', 'infra', false],
    [repetition('llm_error', [], { error_code: 'LLM_TIMEOUT' }), 'llm_outage', 'infra', false],
    [repetition('infra_error', [], { error_code: 'ECONNREFUSED' }), 'infra_error', 'infra', false],
    [repetition('aborted', [], { error_code: 'CASE_TIMEOUT' }), 'timeout', 'infra', true],
    [repetition('aborted', [], { timed_out: true }), 'timeout', 'infra', true],
    [repetition('aborted', [], { error_code: 'ABORTED' }), 'aborted', 'infra', true],
    [repetition('skipped_budget'), 'skipped_budget', 'skipped', false],
    [repetition('expected_sql_error', [], { error_code: 'ER_NO_SUCH_TABLE' }), 'expected_sql_error', 'harness', false],
    [repetition('expected_sql_error', [], { error_code: 'ECONNREFUSED' }), 'infra_error', 'infra', false],
    [repetition('evaluation_error'), 'harness_error', 'harness', false],
  ];
  for (const [input, outcome, bucket, counted] of cases) {
    const result = classifyRepetition(input, testCase);
    assert.deepEqual([result.outcome, result.bucket, result.counted], [outcome, bucket, counted], `${input.status} ${input.error_code || ''}`);
  }
});

test('a false rejection in ANY attempt makes a failed repetition the system\'s fault', () => {
  const input = repetition('result_mismatch', [
    rejected('SELECT correct', 'guardrail', 'METRIC', { guardrailCheck: { verdict: 'false_rejection' } }),
    accepted('SELECT wrong'),
  ]);
  const result = classifyRepetition(input, testCase);
  assert.equal(result.outcome, 'guardrail_false_rejection');
  assert.equal(result.bucket, 'system');
  // A pass stays a pass even after an earlier false rejection.
  const recovered = classifyRepetition({ ...input, status: 'pass' }, testCase);
  assert.equal(recovered.outcome, 'pass');
});

test('retrieval misses re-attribute model-looking failures to the system', () => {
  const missing = { retrieved_tables: ['SalesDocument', 'StoreLocation'] };
  const wrong = classifyRepetition({ ...repetition('retrieval_miss', [accepted('SELECT 1')]), ...missing }, testCase);
  assert.deepEqual([wrong.outcome, wrong.bucket, wrong.outcome_tags], ['wrong_result', 'system', ['retrieval_miss']]);
  const scope = classifyRepetition({ ...repetition('validation_error', [rejected('SELECT 1 FROM Customer', 'safety', 'TABLE_SCOPE')]), ...missing }, testCase);
  assert.deepEqual([scope.outcome, scope.bucket, scope.outcome_tags], ['safety_rejection', 'system', ['retrieval_miss']]);
  // An LLM failure is not explained by retrieval.
  const llm = classifyRepetition({ ...repetition('llm_error', [], { error_code: 'LLM_REFUSAL' }), ...missing }, testCase);
  assert.deepEqual([llm.outcome, llm.bucket, llm.outcome_tags], ['llm_error', 'model', []]);
  // Unverified guardrail rejections are tagged (and never charged to the model).
  const unverified = classifyRepetition(repetition('validation_error', [rejected('SELECT 1', 'guardrail', 'X', { guardrailCheck: { verdict: 'error', message: 'down' } })]), testCase);
  assert.deepEqual([unverified.outcome, unverified.outcome_tags], ['infra_error', ['guardrail_unverified']]);
});

test('case summary: pass rate over counted repetitions, strict majority, failure wins ties', () => {
  const reps = ['pass', 'pass', 'wrong_result'].map((outcome) => attributeRepetition(repetition(outcome === 'pass' ? 'pass' : 'result_mismatch', [accepted('x')]), testCase));
  const summary = summarizeCaseRepetitions(reps);
  assert.deepEqual([summary.counted, summary.passes, summary.passRate, summary.majorityPass, summary.outcome, summary.bucket], [3, 2, 0.6667, true, 'pass', 'pass']);

  const tie = summarizeCaseRepetitions([reps[0], reps[2]]);
  assert.deepEqual([tie.passRate, tie.majorityPass, tie.outcome, tie.bucket], [0.5, false, 'wrong_result', 'model']);

  const withSkips = summarizeCaseRepetitions([attributeRepetition(repetition('skipped_budget'), testCase), reps[0]]);
  assert.deepEqual([withSkips.counted, withSkips.passRate, withSkips.repetitions], [1, 1, 2]);

  const excluded = summarizeCaseRepetitions([attributeRepetition(repetition('infra_error'), testCase)]);
  assert.deepEqual([excluded.counted, excluded.passRate, excluded.majorityPass, excluded.outcome, excluded.bucket], [0, null, null, 'infra_error', 'infra']);
});

test('guardrail rejections are re-run through the oracle only when they pass the safety layer', async () => {
  const scored = [];
  const score = async ({ predictedSql }) => {
    scored.push(predictedSql);
    if (predictedSql.includes('Down')) {
      return { match: false, infraError: true, executionError: { message: 'connection lost' } };
    }
    return predictedSql.includes('IsActive')
      ? { match: true, matchedGold: 'expected_sql', reason: 'match', killedOn: [] }
      : { match: false, matchedGold: null, reason: 'values', killedOn: ['v2'] };
  };
  const cache = new Map();
  const input = repetition('validation_error', [
    rejected('SELECT COUNT(*) FROM Customer WHERE IsActive = 1', 'guardrail', 'METRIC'),
    rejected('SELECT COUNT(*) FROM Customer', 'guardrail', 'METRIC'),
    rejected('SELECT 1 -- hidden', 'guardrail', 'METRIC'),
    rejected('SELECT COUNT(*) FROM Customer AS Down', 'guardrail', 'METRIC'),
    rejected('DELETE FROM Customer', 'safety', 'WRITE_OPERATION'),
  ]);
  const checked = await checkGuardrailRejections(input, { testCase, connections: [], schema: null, cache, score });
  const verdicts = checked.attempts.map((attempt) => attempt.guardrailCheck?.verdict ?? null);
  assert.deepEqual(verdicts, ['false_rejection', 'true_rejection', 'unsafe', 'error', null]);
  assert.equal(checked.attempts[1].guardrailCheck.reason, 'values');
  assert.deepEqual(checked.attempts[1].guardrailCheck.killedOn, ['v2']);
  assert.equal(checked.attempts[2].guardrailCheck.code, 'SQL_COMMENT');
  // The commented SQL and the safety rejection never reach the database.
  assert.equal(scored.length, 3);
  assert.ok(!scored.some((sql) => sql.includes('hidden') || sql.startsWith('DELETE')));

  // Identical SQL in another repetition is not re-run.
  await checkGuardrailRejections(input, { testCase, connections: [], schema: null, cache, score });
  assert.equal(scored.length, 3);

  // Nothing to check: returned as is.
  const plain = repetition('pass', [accepted('SELECT 1')]);
  assert.equal(await checkGuardrailRejections(plain, { testCase, score }), plain);
});

test('confusion matrix covers every attempt, retries included', () => {
  const records = [
    {
      repetitions: [
        // false rejection, then the retry passes: FP + TN
        repetition('pass', [rejected('a', 'guardrail', 'M', { guardrailCheck: { verdict: 'false_rejection' } }), accepted('b')]),
        // true rejection, then a wrong accepted answer: TP + FN
        repetition('result_mismatch', [rejected('c', 'guardrail', 'J', { guardrailCheck: { verdict: 'true_rejection' } }), accepted('d')]),
        // accepted but failed at execution, then a pass: FN + TN
        repetition('pass', [accepted('e', { ok: false, stage: 'execution', code: 'ER_PARSE_ERROR' }), accepted('f')]),
        // safety rejection, then an infra failure: neither is a guardrail decision with known correctness
        repetition('infra_error', [rejected('g', 'safety', 'NOT_SELECT'), accepted('h', { ok: false, stage: 'infra', code: 'ECONNRESET' })]),
        // unverified rejections: the re-check failed, or the SQL fails the safety layer now
        repetition('validation_error', [rejected('i', 'guardrail', 'M', { guardrailCheck: { verdict: 'error', infra: true } })]),
        repetition('validation_error', [rejected('j', 'guardrail', 'M', { guardrailCheck: { verdict: 'unsafe', code: 'SQL_COMMENT' } })]),
        // skipped repetitions carry no attempts that count
        repetition('skipped_budget'),
      ],
    },
  ];
  const matrix = guardrailConfusion(records);
  assert.deepEqual(
    [matrix.tp, matrix.fp, matrix.fn, matrix.tn, matrix.unknown, matrix.safetyRejections, matrix.attempts],
    [1, 1, 2, 2, 3, 1, 10]
  );
  assert.deepEqual(matrix.unknownBy, { unsafe: 1, checkFailed: 1, unchecked: 0, infra: 1, notFinal: 0 });
  assert.equal(matrix.precision, 0.5);
  assert.equal(matrix.recall, Number((1 / 3).toFixed(4)));
  assert.equal(matrix.falseRejectionRate, Number((1 / 3).toFixed(4)));
});

test('attribution summary separates model, system, infra, skipped and harness', () => {
  const reps = [
    repetition('pass', [accepted('a')]),
    repetition('result_mismatch', [accepted('b')]),
    repetition('validation_error', [rejected('c', 'guardrail', 'M', { guardrailCheck: { verdict: 'false_rejection' } })]),
    { ...repetition('retrieval_miss', [accepted('d')]), retrieved_tables: ['SalesDocument'] },
    repetition('infra_error'),
    repetition('skipped_budget'),
    repetition('expected_sql_error'),
  ].map((rep) => attributeRepetition(rep, testCase));
  const records = reps.map((rep, index) => ({ id: `c${index}`, repetitions: [rep], summary: summarizeCaseRepetitions([rep]) }));
  const summary = summarizeAttribution(records);
  assert.deepEqual(summary.repetitions.byBucket, { pass: 1, model: 1, system: 2, infra: 1, skipped: 1, harness: 1 });
  assert.equal(summary.repetitions.counted, 4);
  assert.deepEqual(summary.system, { guardrailFalseRejections: 1, retrievalMisses: 1, guardrailFalseRejectionsElsewhere: 0, guardrailUnverified: 0 });
  // The outcome x bucket split shows the retrieval miss moved to the system.
  assert.deepEqual(summary.byOutcomeBucket.wrong_result, { model: 1, system: 1 });
  assert.deepEqual(summary.excluded, { infra_error: 1, expected_sql_error: 1, skipped_budget: 1 });
  assert.equal(summary.cases.byOutcome.guardrail_false_rejection, 1);
  assert.equal(summary.guardrailConfusion.fp, 1);
});

test('a false-rejection verdict only counts on an attempt a guardrail rejects now', () => {
  // A stale verdict on an attempt that is now accepted, or now a safety rejection.
  for (const attempt of [
    accepted('SELECT once_rejected', { ok: true, durationMs: 1, rowCount: 1, truncated: false }),
    rejected('SELECT once_rejected', 'safety', 'SQL_COMMENT'),
  ]) {
    const input = repetition('result_mismatch', [{ ...attempt, guardrailCheck: { verdict: 'false_rejection' } }, accepted('SELECT wrong')]);
    assert.deepEqual([classifyRepetition(input, testCase).outcome, classifyRepetition(input, testCase).bucket], ['wrong_result', 'model']);
  }
});

test('checkGuardrailRejections drops a carried-over verdict from attempts no guardrail rejects', async () => {
  const stale = repetition('result_mismatch', [
    { ...accepted('SELECT a'), guardrailCheck: { verdict: 'false_rejection' } },
    accepted('SELECT b'),
  ]);
  const checked = await checkGuardrailRejections(stale, { testCase, connections: [], schema: { tables: [] }, score: async () => assert.fail('nothing to re-run') });
  assert.deepEqual(checked.attempts.map((attempt) => 'guardrailCheck' in attempt), [false, false]);
});

test('a guardrail re-check the database could not finish is infra, never the model\'s', () => {
  const down = { verdict: 'error', infra: true, message: "Can't add new command when connection is in closed state" };
  // The final rejection could not be verified: infra_error, excluded.
  const final = classifyRepetition(repetition('validation_error', [rejected('SELECT 1', 'guardrail', 'FAN_OUT', { guardrailCheck: down })]), testCase);
  assert.deepEqual([final.outcome, final.bucket, final.counted, final.outcome_tags], ['infra_error', 'infra', false, ['guardrail_unverified']]);
  // An earlier rejection could not be verified, the retry was wrong: it might
  // have been a false rejection, so the model is not blamed either.
  const earlier = classifyRepetition(repetition('result_mismatch', [rejected('SELECT 1', 'guardrail', 'FAN_OUT', { guardrailCheck: down }), accepted('SELECT 2')]), testCase);
  assert.deepEqual([earlier.outcome, earlier.counted], ['infra_error', false]);
  // A non-infrastructure failure of the check is the harness's.
  const broken = classifyRepetition(
    repetition('validation_error', [rejected('SELECT 1', 'guardrail', 'FAN_OUT', { guardrailCheck: { verdict: 'error', infra: false, message: 'bug' } })]),
    testCase
  );
  assert.deepEqual([broken.outcome, broken.bucket, broken.counted], ['harness_error', 'harness', false]);
  // A pass stays a pass; a known false rejection still wins over an unverified one.
  assert.equal(classifyRepetition(repetition('pass', [rejected('SELECT 1', 'guardrail', 'M', { guardrailCheck: down }), accepted('SELECT 2')]), testCase).outcome, 'pass');
  const mixed = repetition('result_mismatch', [
    rejected('SELECT 1', 'guardrail', 'M', { guardrailCheck: { verdict: 'false_rejection' } }),
    rejected('SELECT 2', 'guardrail', 'M', { guardrailCheck: down }),
    accepted('SELECT 3'),
  ]);
  assert.equal(classifyRepetition(mixed, testCase).outcome, 'guardrail_false_rejection');
  // Unsafe SQL (fails the safety layer today) is not executed and stays the model's.
  const unsafe = classifyRepetition(repetition('validation_error', [rejected('SELECT 1 -- x', 'guardrail', 'M', { guardrailCheck: { verdict: 'unsafe' } })]), testCase);
  assert.deepEqual([unsafe.outcome, unsafe.bucket, unsafe.outcome_tags], ['guardrail_true_rejection', 'model', ['guardrail_unsafe']]);
});

test('checkGuardrailRejections says whether a failed re-check was the database\'s', async () => {
  const closed = Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true });
  const goldDown = Object.assign(new Error('Gold SQL (expected_sql) failed on fixture v3: closed'), { code: 'GOLD_SQL_ERROR', cause: closed });
  const verdictFor = async (score) =>
    (await checkGuardrailRejections(repetition('validation_error', [rejected('SELECT 1', 'guardrail', 'M')]), { testCase, connections: [], score })).attempts[0].guardrailCheck;
  assert.deepEqual(
    await verdictFor(async () => ({ match: false, infraError: true, perFixture: [{ error: { infra: true, message: 'closed state' } }] })),
    { verdict: 'error', infra: true, message: 'closed state' }
  );
  assert.deepEqual(await verdictFor(async () => Promise.reject(goldDown)), { verdict: 'error', infra: true, message: goldDown.message });
  assert.deepEqual(await verdictFor(async () => Promise.reject(new TypeError('bug'))), { verdict: 'error', infra: false, message: 'bug' });
});

test('a false rejection followed by an outage keeps the outage and is reported', () => {
  const reps = [
    repetition('llm_error', [rejected('SELECT ok', 'guardrail', 'FAN_OUT', { guardrailCheck: { verdict: 'false_rejection' } })], { error_code: 'HTTP_503' }),
  ].map((rep) => attributeRepetition(rep, testCase));
  assert.deepEqual([reps[0].outcome, reps[0].counted, reps[0].outcome_tags], ['llm_outage', false, ['guardrail_false_rejection']]);
  const summary = summarizeAttribution([{ id: 'c', repetitions: reps, summary: summarizeCaseRepetitions(reps) }]);
  assert.equal(summary.system.guardrailFalseRejections, 0);
  assert.equal(summary.system.guardrailFalseRejectionsElsewhere, 1);
  assert.equal(summary.guardrailConfusion.fp, 1);
});

test('a gold query that failed because the database went away is infra_error, not a broken gold', async () => {
  // mysql2's closed-connection error has no code, only fatal: true.
  const connection = {
    async query() {
      throw Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true });
    },
  };
  const trace = { enabled: true, emit: async () => {} };
  const result = await evaluateQuestion({
    client: null,
    connection,
    schema: { tables: [] },
    model: 'gpt-4o-mini',
    testCase: { id: 'g1', question: 'How many customers?', expected_sql: 'SELECT COUNT(*) FROM Customer' },
    caseIndex: 1,
    trace,
    dependencies: { runQuestion: async () => assert.fail('no LLM call after a gold failure') },
  });
  assert.deepEqual([result.status, result.error_code, result.error_infra], ['expected_sql_error', 'GOLD_SQL_ERROR', true]);
  assert.deepEqual([classifyRepetition(result, testCase).outcome, classifyRepetition(result, testCase).counted], ['infra_error', false]);
  // A genuinely broken gold stays expected_sql_error.
  const broken = classifyRepetition({ status: 'expected_sql_error', error_code: 'ER_NO_SUCH_TABLE', error_infra: false }, testCase);
  assert.equal(broken.outcome, 'expected_sql_error');
  assert.equal(classifyRepetition({ status: 'expected_sql_error', error_code: 'ER_CONNECTION_KILLED' }, testCase).outcome, 'infra_error');
});
