import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import {
  GOLD_STATEMENT_TIMEOUT_MS,
  GoldSqlError,
  createGoldCache,
  openFixtureConnections,
  scoreAgainstGold,
} from '../src/eval/oracle.js';

// The statement timeout default (8000 ms) is part of what these tests pin.
const savedTimeout = process.env.QUERY_STATEMENT_TIMEOUT_MS;
before(() => {
  delete process.env.QUERY_STATEMENT_TIMEOUT_MS;
});
after(() => {
  if (savedTimeout !== undefined) {
    process.env.QUERY_STATEMENT_TIMEOUT_MS = savedTimeout;
  }
});

const GOLD = 'SELECT gold';
const ALT = 'SELECT alt';
const PRED = 'SELECT pred';

// A fake mysql2 connection per fixture: answers by SQL text (the SET STATEMENT
// bounds prefix is stripped and recorded), honoring sql_select_limit.
function fakeFixture(name, answers) {
  const sent = [];
  const connection = {
    sent,
    ended: false,
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
      const limit = /sql_select_limit=(\d+)/.exec(statement);
      return [limit ? answer.slice(0, Number(limit[1])) : answer];
    },
    async end() {
      this.ended = true;
    },
  };
  return { name, database: `db_${name}`, connection };
}

function caseWith(overrides = {}) {
  return normalizeBenchmarkCase({
    id: 'c1',
    question: 'q',
    expected_sql: GOLD,
    comparison: { mode: 'rowset' },
    ...overrides,
  });
}

const seedGold = [
  { CustomerName: 'A', total: 10 },
  { CustomerName: 'B', total: 5 },
];
const v2Gold = [
  { CustomerName: 'A', total: 12 },
  { CustomerName: 'C', total: 7 },
];

test('a prediction matching the gold on every fixture passes', async () => {
  const connections = [
    fakeFixture('seed', { [GOLD]: seedGold, [PRED]: seedGold.map((row) => ({ customer: row.CustomerName, net: row.total })) }),
    fakeFixture('v2', { [GOLD]: v2Gold, [PRED]: v2Gold.map((row) => ({ customer: row.CustomerName, net: row.total })) }),
  ];
  const result = await scoreAgainstGold({ testCase: caseWith(), predictedSql: PRED, connections });
  assert.equal(result.match, true);
  assert.equal(result.matchedGold, 'expected_sql');
  assert.deepEqual(result.assignment, { CustomerName: 'customer', total: 'net' });
  assert.deepEqual(result.killedOn, []);
  assert.deepEqual(
    result.perFixture.map(({ fixture, match, goldRowCount, actualRowCount }) => ({ fixture, match, goldRowCount, actualRowCount })),
    [
      { fixture: 'seed', match: true, goldRowCount: 2, actualRowCount: 2 },
      { fixture: 'v2', match: true, goldRowCount: 2, actualRowCount: 2 },
    ]
  );
});

test('SQL that coincides with the gold on the seed is caught by another fixture', async () => {
  const connections = [
    fakeFixture('seed', { [GOLD]: seedGold, [PRED]: seedGold }),
    fakeFixture('v2', { [GOLD]: v2Gold, [PRED]: [...v2Gold, { CustomerName: 'D', total: 1 }] }),
  ];
  const result = await scoreAgainstGold({ testCase: caseWith(), predictedSql: PRED, connections });
  assert.equal(result.match, false);
  assert.equal(result.reason, 'row_count');
  assert.deepEqual(result.killedOn, ['v2']);
  assert.equal(result.perFixture[0].match, true);
  assert.equal(result.perFixture[1].reason, 'row_count');
  assert.equal(result.perFixture[1].truncated, true, 'read stopped at gold rows + 1');
  assert.match(connections[1].connection.sent.at(-1), /sql_select_limit=3 FOR SELECT pred$/);
  assert.match(connections[1].connection.sent.at(-1), /^SET STATEMENT max_statement_time=8\.000,/);
});

test('alternative gold: a prediction must match one reading on every fixture', async () => {
  const altSeed = [{ CustomerName: 'A', total: 10 }];
  const altV2 = [{ CustomerName: 'A', total: 12 }];
  const testCase = caseWith({ alternative_expected_sql: [ALT] });

  const alternative = await scoreAgainstGold({
    testCase,
    predictedSql: PRED,
    connections: [
      fakeFixture('seed', { [GOLD]: seedGold, [ALT]: altSeed, [PRED]: altSeed }),
      fakeFixture('v2', { [GOLD]: v2Gold, [ALT]: altV2, [PRED]: altV2 }),
    ],
  });
  assert.equal(alternative.match, true);
  assert.equal(alternative.matchedGold, 'alternative_expected_sql[0]');

  // Gold reading on the seed, alternative reading on v2: not one answer.
  const mixed = await scoreAgainstGold({
    testCase,
    predictedSql: PRED,
    connections: [
      fakeFixture('seed', { [GOLD]: seedGold, [ALT]: altSeed, [PRED]: seedGold }),
      fakeFixture('v2', { [GOLD]: v2Gold, [ALT]: altV2, [PRED]: altV2 }),
    ],
  });
  assert.equal(mixed.match, false);
  assert.deepEqual(mixed.killedOn, [], 'each fixture alone matches some reading');
  assert.deepEqual(mixed.perFixture.map((entry) => entry.matchAny), [true, true]);
  assert.deepEqual(mixed.variants.map((variant) => variant.match), [false, false]);
});

test('the gold -> prediction column mapping must be the same on every fixture', async () => {
  const testCase = caseWith({ comparison: { mode: 'rowset' } });
  const connections = [
    fakeFixture('seed', { [GOLD]: [{ x: 1 }, { x: 2 }], [PRED]: [{ a: 1, b: 9 }, { a: 2, b: 8 }] }),
    fakeFixture('v2', { [GOLD]: [{ x: 5 }, { x: 6 }], [PRED]: [{ a: 7, b: 5 }, { a: 3, b: 6 }] }),
  ];
  const result = await scoreAgainstGold({ testCase, predictedSql: PRED, connections });
  assert.equal(result.match, false);
  assert.equal(result.reason, 'inconsistent_assignment');
  assert.deepEqual(result.killedOn, []);
});

test('an empty gold on one fixture does not constrain the mapping', async () => {
  const connections = [
    fakeFixture('seed', { [GOLD]: [{ x: 1 }], [PRED]: [{ a: 1 }] }),
    fakeFixture('v2', { [GOLD]: [], [PRED]: [] }),
  ];
  const result = await scoreAgainstGold({ testCase: caseWith(), predictedSql: PRED, connections });
  assert.equal(result.match, true);
  assert.deepEqual(result.assignment, { x: 'a' });
});

test('gold rows are cached per fixture and run with the long gold timeout', async () => {
  const connections = [fakeFixture('seed', { [GOLD]: seedGold, [PRED]: seedGold })];
  const goldCache = createGoldCache();
  await scoreAgainstGold({ testCase: caseWith(), predictedSql: PRED, connections, goldCache });
  await scoreAgainstGold({ testCase: caseWith({ id: 'c2' }), predictedSql: PRED, connections, goldCache });
  const goldStatements = connections[0].connection.sent.filter((statement) => statement.endsWith(GOLD));
  assert.equal(goldStatements.length, 1);
  assert.equal(goldStatements[0], `SET STATEMENT max_statement_time=${(GOLD_STATEMENT_TIMEOUT_MS / 1000).toFixed(3)} FOR ${GOLD}`);
});

test('a failing gold throws GoldSqlError (not a model failure)', async () => {
  const connections = [fakeFixture('seed', { [GOLD]: Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' }) })];
  await assert.rejects(scoreAgainstGold({ testCase: caseWith(), predictedSql: PRED, connections }), (error) => {
    assert.ok(error instanceof GoldSqlError);
    assert.equal(error.code, 'GOLD_SQL_ERROR');
    assert.equal(error.fixture, 'seed');
    return true;
  });
});

test('prediction errors are per-fixture mismatches; infra errors are flagged', async () => {
  const connections = [
    fakeFixture('seed', { [GOLD]: seedGold, [PRED]: seedGold }),
    fakeFixture('v2', { [GOLD]: v2Gold, [PRED]: Object.assign(new Error('Query execution was interrupted'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }) }),
  ];
  const timedOut = await scoreAgainstGold({ testCase: caseWith(), predictedSql: PRED, connections });
  assert.equal(timedOut.match, false);
  assert.equal(timedOut.reason, 'execution_error');
  assert.equal(timedOut.executionError.code, 'ER_STATEMENT_TIMEOUT');
  assert.equal(timedOut.infraError, false);
  assert.deepEqual(timedOut.killedOn, ['v2']);

  const reset = await scoreAgainstGold({
    testCase: caseWith(),
    predictedSql: PRED,
    connections: [fakeFixture('seed', { [GOLD]: seedGold, [PRED]: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })],
  });
  assert.equal(reset.infraError, true);
});

test('signal checks resolve through the assignment and, like the lint, never change the verdict', async () => {
  const testCase = caseWith({
    disallowed_columns: ['NetPayableAmount'],
    signal_checks: { require_nonzero_columns: ['total'], require_nonnull_columns: ['CustomerName'] },
  });
  const renamed = seedGold.map((row) => ({ customer: row.CustomerName, revenue: row.total }));
  const clean = await scoreAgainstGold({
    testCase,
    predictedSql: 'SELECT c.CustomerName AS customer, SUM(d.NetAmount) AS revenue FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId',
    connections: [fakeFixture('seed', { [GOLD]: seedGold, 'SELECT c.CustomerName AS customer, SUM(d.NetAmount) AS revenue FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId': renamed })],
  });
  assert.equal(clean.match, true);
  assert.deepEqual(clean.signalWarnings, [], 'renamed aliases are not a signal problem any more');
  assert.deepEqual(clean.disallowedWarnings, []);

  const trapSql = 'SELECT c.CustomerName, SUM(d.NetPayableAmount) * 0 + SUM(d.NetAmount) AS total FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId';
  const trap = await scoreAgainstGold({
    testCase,
    predictedSql: trapSql,
    connections: [fakeFixture('seed', { [GOLD]: seedGold, [trapSql]: seedGold })],
  });
  assert.equal(trap.match, true);
  assert.deepEqual(trap.disallowedWarnings, ['NetPayableAmount']);

  const zeros = await scoreAgainstGold({
    testCase,
    predictedSql: PRED,
    connections: [fakeFixture('seed', { [GOLD]: seedGold, [PRED]: [{ CustomerName: 'A', total: 0 }, { CustomerName: 'B', total: 0 }] })],
  });
  assert.equal(zeros.match, false);
  assert.deepEqual(zeros.signalWarnings.map((warning) => [warning.fixture, warning.code]), [['seed', 'require_nonzero_columns']]);

  // A mismatch with unrelated aliases has no mapping: its columns are skipped.
  const unmapped = await scoreAgainstGold({
    testCase,
    predictedSql: PRED,
    connections: [fakeFixture('seed', { [GOLD]: seedGold, [PRED]: [{ customer: 'A', revenue: 0 }, { customer: 'B', revenue: 0 }] })],
  });
  assert.deepEqual(unmapped.signalWarnings, []);
});

test('signal checks run per fixture through the matched column mapping and are keyed by the gold column', async () => {
  // A renamed-alias prediction that matches everywhere; on v2 the gold (and
  // so the prediction) is all zero, which the gold-named check reports there.
  const testCase = caseWith({ signal_checks: { require_nonzero_columns: ['total'] } });
  const v2Zero = [{ CustomerName: 'A', total: 0 }];
  const renamed = (rows) => rows.map((row) => ({ customer: row.CustomerName, revenue: row.total }));
  const result = await scoreAgainstGold({
    testCase,
    predictedSql: PRED,
    connections: [
      fakeFixture('seed', { [GOLD]: seedGold, [PRED]: renamed(seedGold) }),
      fakeFixture('v2', { [GOLD]: v2Zero, [PRED]: renamed(v2Zero) }),
    ],
  });
  assert.equal(result.match, true, 'warnings never change the verdict');
  assert.deepEqual(result.assignment, { CustomerName: 'customer', total: 'revenue' });
  assert.deepEqual(
    result.signalWarnings.map(({ fixture, code, column }) => ({ fixture, code, column })),
    [{ fixture: 'v2', code: 'require_nonzero_columns', column: 'total' }]
  );
});

test('openFixtureConnections opens one query connection per fixture database and cleans up on failure', async () => {
  const calls = [];
  const fixtures = [
    { name: 'seed', database: 'demo_retail' },
    { name: 'v2', database: 'demo_retail_v2' },
  ];
  const connect = async ({ role, env }) => {
    calls.push({ role, database: env.DB_NAME });
    return { end: async () => calls.push({ closed: env.DB_NAME }) };
  };
  const opened = await openFixtureConnections({ fixtures, env: { DB_NAME: 'ignored' }, connect });
  assert.deepEqual(opened.map(({ name, database }) => ({ name, database })), fixtures);
  assert.deepEqual(calls, [
    { role: 'query', database: 'demo_retail' },
    { role: 'query', database: 'demo_retail_v2' },
  ]);

  calls.length = 0;
  const failing = async ({ env }) => {
    if (env.DB_NAME === 'demo_retail_v2') {
      throw Object.assign(new Error('Database "demo_retail_v2" does not exist.'), { code: 'ER_BAD_DB_ERROR' });
    }
    return { end: async () => calls.push({ closed: env.DB_NAME }) };
  };
  await assert.rejects(openFixtureConnections({ fixtures, env: {}, connect: failing }), (error) => {
    assert.equal(error.code, 'ER_BAD_DB_ERROR');
    assert.match(error.message, /npm run seed-fixtures/);
    return true;
  });
  assert.deepEqual(calls, [{ closed: 'demo_retail' }], 'the already-open connection is closed');
});
