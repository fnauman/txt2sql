import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { goldFingerprint } from '../src/eval/controls.js';
import { GOLD_STATEMENT_TIMEOUT_MS } from '../src/eval/oracle.js';
import { fixtureGateFailures, killRateGateFailures, summarizeControls, verifyCase } from '../src/eval/verify.js';

// verifyCase is verify-dataset's per-case gate. These tests drive every
// failure branch with fake fixture connections and a stub validator, so a
// broken gate cannot leave the suite green.

const GOLD = 'SELECT gold';
const ALT = 'SELECT alt';
const POSITIVE = 'SELECT positive';
const NEGATIVE = 'SELECT negative';
const SURVIVOR = 'SELECT survivor';

// A fake mysql2 connection per fixture, answering by SQL text (the SET
// STATEMENT bounds prefix is stripped and recorded).
function fakeFixture(name, answers) {
  const sent = [];
  const connection = {
    sent,
    async query(statement) {
      sent.push(statement);
      const sql = statement.replace(/^SET STATEMENT .*? FOR /, '');
      const answer = answers[sql];
      if (answer instanceof Error) {
        throw answer;
      }
      if (!answer) {
        throw Object.assign(new Error(`Unknown SQL ${sql}`), { code: 'ER_PARSE_ERROR' });
      }
      return [answer];
    },
  };
  return { name, database: `db_${name}`, connection };
}

const seedGold = [
  { CustomerName: 'A', total: 10 },
  { CustomerName: 'B', total: 5 },
];
const v2Gold = [
  { CustomerName: 'A', total: 12 },
  { CustomerName: 'C', total: 7 },
];
const renamed = (rows) => rows.map((row) => ({ customer: row.CustomerName, revenue: row.total }));

function connectionsWith(seedAnswers = {}, v2Answers = {}) {
  return [
    fakeFixture('seed', { [GOLD]: seedGold, [POSITIVE]: renamed(seedGold), [NEGATIVE]: seedGold, [SURVIVOR]: seedGold, ...seedAnswers }),
    fakeFixture('v2', { [GOLD]: v2Gold, [POSITIVE]: renamed(v2Gold), [NEGATIVE]: [{ CustomerName: 'A', total: 1 }, { CustomerName: 'C', total: 7 }], [SURVIVOR]: v2Gold, ...v2Answers }),
  ];
}

function caseWith(overrides = {}) {
  return normalizeBenchmarkCase({
    id: 'c1',
    intentId: 'intent_c1',
    question: 'Top customers?',
    expected_sql: GOLD,
    comparison: { mode: 'ranked', value_columns: ['total'] },
    signal_checks: { min_row_count: 2, require_nonzero_columns: ['total'] },
    expected_row_counts: { seed: 2, v2: 2 },
    ...overrides,
  });
}

function controlsFor(testCase, { negative = [], positive = [], fingerprint = goldFingerprint(testCase.expected_sql) } = {}) {
  const entry = {
    caseId: testCase.id,
    intentId: testCase.intentId,
    goldFingerprint: fingerprint,
    negative: negative.map((control) => ({ type: 'metric', note: '', heldout: false, ...control })),
    positive: positive.map((control) => ({ note: '', ...control })),
    source: `test.json#${testCase.id}`,
  };
  return { byCaseId: new Map([[testCase.id, entry]]), byIntentId: new Map([[testCase.intentId, [entry]]]), files: ['test.json'] };
}

const accept = async () => null;
const rejectSql = (bad) => async (_question, sql) => (sql === bad ? { code: 'FAN_OUT', layer: 'guardrail', message: 'fan-out' } : null);

test('a healthy case: no problems, gold run with the gold timeout, controls scored', async () => {
  const testCase = caseWith();
  const connections = connectionsWith();
  const result = await verifyCase(testCase, {
    connections,
    validate: accept,
    controlsIndex: controlsFor(testCase, { negative: [{ id: 'm1', sql: NEGATIVE }], positive: [{ id: 'a1', sql: POSITIVE }] }),
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.goldRowCounts, { seed: 2, v2: 2 });
  assert.deepEqual(result.controls.positive.map((control) => [control.id, control.match, control.rejection]), [['a1', true, null]]);
  assert.deepEqual(result.controls.negative.map((control) => [control.id, control.killed, control.killedOn]), [['m1', true, ['v2']]]);
  for (const { connection } of connections) {
    assert.ok(connection.sent.includes(`SET STATEMENT max_statement_time=${(GOLD_STATEMENT_TIMEOUT_MS / 1000).toFixed(3)} FOR ${GOLD}`));
  }
});

test('a per-fixture pin mismatch is a problem', async () => {
  const result = await verifyCase(caseWith({ expected_row_counts: { seed: 2, v2: 3 } }), { connections: connectionsWith(), validate: accept });
  assert.deepEqual(result.problems, ['v2: expected 3 row(s) but gold returned 2']);
  // The legacy single pin applies to the primary fixture only.
  const legacy = await verifyCase(caseWith({ expected_row_counts: undefined, expected_row_count: 4 }), { connections: connectionsWith(), validate: accept });
  assert.deepEqual(legacy.problems, ['seed: expected 4 row(s) but gold returned 2']);
});

test('a gold that fails its own signal checks is a problem', async () => {
  const result = await verifyCase(caseWith(), {
    connections: connectionsWith({}, { [GOLD]: [{ CustomerName: 'A', total: 0 }, { CustomerName: 'C', total: 0 }] }),
    validate: accept,
  });
  assert.deepEqual(result.problems, ['expected_sql fails its signal_checks on v2: require_nonzero_columns']);
});

test('a gold or alternative rejected by the production validator is a problem', async () => {
  const testCase = caseWith({ alternative_expected_sql: [ALT] });
  const result = await verifyCase(testCase, {
    connections: connectionsWith({ [ALT]: seedGold }, { [ALT]: v2Gold }),
    validate: rejectSql(ALT),
  });
  assert.deepEqual(result.problems, ['alternative_expected_sql[0] is rejected by the production validator: FAN_OUT (guardrail) fan-out']);
  const gold = await verifyCase(caseWith(), { connections: connectionsWith(), validate: rejectSql(GOLD) });
  assert.equal(gold.problems.length, 1);
  assert.match(gold.problems[0], /^expected_sql is rejected by the production validator: FAN_OUT/);
});

test('a gold that is not self-consistent, or names comparison columns it does not return, is a problem', async () => {
  // Ranked desc, but the gold itself is sorted ascending.
  const unsorted = await verifyCase(caseWith(), {
    connections: connectionsWith({ [GOLD]: [...seedGold].reverse() }),
    validate: accept,
  });
  assert.deepEqual(unsorted.problems, ['expected_sql is not self-consistent under its comparison spec on seed']);

  const misnamed = await verifyCase(caseWith({ comparison: { mode: 'rowset', null_as_zero: ['totl'] } }), { connections: connectionsWith(), validate: accept });
  assert.deepEqual(misnamed.problems, [
    'comparison.null_as_zero names "totl", which expected_sql does not return on seed',
    'comparison.null_as_zero names "totl", which expected_sql does not return on v2',
  ]);
});

test('a failing gold is a problem and its controls are not run', async () => {
  const testCase = caseWith();
  const result = await verifyCase(testCase, {
    connections: connectionsWith({}, { [GOLD]: Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' }) }),
    validate: accept,
    controlsIndex: controlsFor(testCase, { negative: [{ id: 'm1', sql: NEGATIVE }] }),
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^Gold SQL \(expected_sql\) failed on fixture v2: Unknown column/);
  assert.equal(result.controls, null);
});

test('a positive control that mismatches on one fixture is a problem', async () => {
  const testCase = caseWith();
  const result = await verifyCase(testCase, {
    connections: connectionsWith({}, { [POSITIVE]: renamed(v2Gold).map((row) => ({ ...row, revenue: row.revenue + 1 })) }),
    validate: accept,
    controlsIndex: controlsFor(testCase, { positive: [{ id: 'a1', sql: POSITIVE }] }),
  });
  assert.deepEqual(result.problems, ['positive control a1 does not match the gold on every fixture (v2: values)']);
  assert.equal(result.controls.positive[0].match, false);
});

test('a positive control rejected by the validator is a problem unless flagged as a known false rejection', async () => {
  const testCase = caseWith();
  const run = (flag) =>
    verifyCase(testCase, {
      connections: connectionsWith(),
      validate: rejectSql(POSITIVE),
      controlsIndex: controlsFor(testCase, { positive: [{ id: 'a1', sql: POSITIVE, ...(flag ? { validator_known_false_rejection: true } : {}) }] }),
    });
  const rejected = await run(false);
  assert.deepEqual(rejected.problems, ['positive control a1 is rejected by the production validator: FAN_OUT (guardrail) fan-out']);
  assert.deepEqual(rejected.controls.positive[0].rejection, { code: 'FAN_OUT', layer: 'guardrail', message: 'fan-out' });

  const known = await run(true);
  assert.deepEqual(known.problems, []);
  assert.deepEqual(known.notes, ['positive control a1: known validator false rejection (FAN_OUT)']);
});

test('a surviving negative control is reported, not a problem; summarizeControls lists it', async () => {
  const testCase = caseWith();
  const result = await verifyCase(testCase, {
    connections: connectionsWith(),
    validate: accept,
    controlsIndex: controlsFor(testCase, { negative: [{ id: 'm1', sql: NEGATIVE }, { id: 'm2', sql: SURVIVOR, note: 'equivalent here' }] }),
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.controls.negative.map((control) => [control.id, control.killed]), [
    ['m1', true],
    ['m2', false],
  ]);
  const summary = summarizeControls([result], { fixtureNames: ['seed', 'v2'] });
  assert.equal(summary.design.rate, 0.5);
  assert.deepEqual(summary.design.survivors, ['c1/m2 (metric: equivalent here)']);
  assert.deepEqual(killRateGateFailures(summary, { datasetName: 'd', minKillRate: 0.95 }), ['d: design kill rate 50.0% < 95.0%']);
});

test('controls written for a different gold are reported as stale and not run', async () => {
  const testCase = caseWith();
  const result = await verifyCase(testCase, {
    connections: connectionsWith(),
    validate: accept,
    controlsIndex: controlsFor(testCase, { negative: [{ id: 'm1', sql: NEGATIVE }], fingerprint: 'deadbeefdeadbeef' }),
  });
  assert.deepEqual(result.problems, ['controls test.json#c1 were written for a different gold SQL (gold_fingerprint mismatch); review them']);
  assert.deepEqual(result.controls.negative, []);
});

test('kill-rate gate: the floor is inclusive, held-out has its own floor, empty groups are not gated', () => {
  const summary = (design, heldout = { total: 0, rate: null }) => ({ design, heldout });
  const gate = (value, options = {}) => killRateGateFailures(value, { datasetName: 'd', minKillRate: 0.95, ...options });
  assert.deepEqual(gate(summary({ total: 20, rate: 0.95 })), [], 'exactly at the floor passes');
  assert.deepEqual(gate(summary({ total: 20, rate: 0.9499 })), ['d: design kill rate 95.0% < 95.0%']);
  assert.deepEqual(gate(summary({ total: 0, rate: null })), []);
  assert.deepEqual(gate(summary({ total: 20, rate: 1 }, { total: 10, rate: 0.5 })), [], 'no held-out floor by default');
  assert.deepEqual(gate(summary({ total: 20, rate: 1 }, { total: 10, rate: 0.5 }), { minHeldoutKillRate: 0.6 }), ['d: held-out kill rate 50.0% < 60.0%']);
  assert.deepEqual(gate(null), []);
});

test('fixture gate: every fixture must be current and carry the shared master data', () => {
  assert.deepEqual(fixtureGateFailures([{ name: 'seed', status: 'current', masterDataMatches: true }]), []);
  const failures = fixtureGateFailures([
    { name: 'seed', status: 'drifted', masterDataMatches: false },
    { name: 'v2', status: 'stale', masterDataMatches: true },
    { name: 'v3', status: 'missing', masterDataMatches: false },
  ]);
  assert.equal(failures.length, 5);
  assert.match(failures[0], /^fixture seed: master data differs from the shared MASTER_DATA/);
  assert.match(failures[1], /^fixture seed: content is drifted/);
  assert.match(failures[2], /^fixture v2: content is stale/);
});
