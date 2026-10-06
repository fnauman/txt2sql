import assert from 'node:assert/strict';
import test from 'node:test';

import { comparisonRelaxations, compareResultsDetailed, findSharedAssignment, normalizeBenchmarkCase } from '../src/benchmark.js';
import { ALL_ZERO_ROWS_ALLOWANCE, scoreAgainstGold } from '../src/eval/oracle.js';
import { scoringFingerprint } from '../src/eval/suite.js';

// The two opt-in scoring relaxations of the comparison spec (measurement
// hygiene after the Experiment 1 error analysis), each a documented policy
// choice in docs/evaluation-dataset.md:
// - ignore_all_zero_rows (rowset + null_as_zero): prediction rows whose
//   null_as_zero metrics are all 0 and that have no counterpart in the gold
//   are ignored (a pivot that also lists customers without activity);
// - empty_as_zero (scalar + null_as_zero): an empty prediction equals a gold
//   of one NULL / 0 row (a SUM over an empty window).

const PIVOT = {
  mode: 'rowset',
  compare_columns: ['CustomerName', 'jan_net_amount', 'feb_net_amount'],
  decimals: 2,
  column_order: ['jan_net_amount', 'feb_net_amount'],
  null_as_zero: ['jan_net_amount', 'feb_net_amount'],
};
const RELAXED = { ...PIVOT, ignore_all_zero_rows: true };

const gold = [
  { CustomerName: 'Acme', jan_net_amount: 100, feb_net_amount: 0 },
  { CustomerName: 'Beta', jan_net_amount: 0, feb_net_amount: 40 },
];
// The model's pivot without the window filter: also every customer that bought
// at another time, with 0 (or NULL) in both months.
const withZeroRows = [
  { CustomerName: 'Acme', january: 100, february: 0, CustomerId: 1 },
  { CustomerName: 'Beta', january: 0, february: 40, CustomerId: 2 },
  { CustomerName: 'Gamma', january: 0, february: 0, CustomerId: 3 },
  { CustomerName: 'Delta', january: null, february: null, CustomerId: 4 },
];

test('ignore_all_zero_rows: extra all-zero rows are ignored, only when the case opts in', () => {
  assert.deepEqual(compareResultsDetailed(gold, withZeroRows, PIVOT), { match: false, assignment: null, reason: 'row_count' });
  const relaxed = compareResultsDetailed(gold, withZeroRows, RELAXED);
  assert.equal(relaxed.match, true);
  // The non-zero CustomerId of an ignored row does not matter: it carries no metric.
  assert.deepEqual(relaxed.assignment, { CustomerName: 'CustomerName', jan_net_amount: 'january', feb_net_amount: 'february' });
  // The same rows without surplus still match strictly.
  assert.equal(compareResultsDetailed(gold, withZeroRows.slice(0, 2), RELAXED).match, true);
});

test('ignore_all_zero_rows: a surplus row with any non-zero metric, or a missing gold row, still fails', () => {
  const nonZero = [...withZeroRows, { CustomerName: 'Echo', january: 0, february: 5, CustomerId: 5 }];
  assert.equal(compareResultsDetailed(gold, nonZero, RELAXED).match, false);
  // Fewer rows than the gold: nothing to ignore.
  assert.equal(compareResultsDetailed(gold, withZeroRows.slice(0, 1), RELAXED).reason, 'row_count');
  // A gold row replaced by a zero row: Beta's 40 is missing.
  const missing = [withZeroRows[0], withZeroRows[2], withZeroRows[3]];
  assert.equal(compareResultsDetailed(gold, [...missing, { CustomerName: 'Zeta', january: 0, february: 0, CustomerId: 9 }], RELAXED).match, false);
  // A wrong value in a gold row is still wrong.
  const wrong = withZeroRows.map((row) => (row.CustomerName === 'Acme' ? { ...row, january: 101 } : row));
  assert.equal(compareResultsDetailed(gold, wrong, RELAXED).match, false);
  // The swapped months are still a column_order failure.
  const swapped = withZeroRows.map(({ CustomerName, january, february, CustomerId }) => ({ CustomerName, february, january, CustomerId }));
  assert.equal(compareResultsDetailed(gold, swapped, RELAXED).match, false);
});

test('ignore_all_zero_rows: a gold zero row must still be listed; zero rows pair like any other row', () => {
  const goldWithZero = [...gold, { CustomerName: 'Gamma', jan_net_amount: 0, feb_net_amount: 0 }];
  // Gamma is in the gold, so the prediction must list it (it does), and
  // Delta's surplus zero row is ignored.
  assert.equal(compareResultsDetailed(goldWithZero, withZeroRows, RELAXED).match, true);
  // Without Gamma the gold row has no counterpart: the relaxation never drops gold rows.
  assert.equal(compareResultsDetailed(goldWithZero, withZeroRows.filter((row) => row.CustomerName !== 'Gamma').concat([{ CustomerName: 'Omega', january: 0, february: 0, CustomerId: 8 }]), RELAXED).match, false);
});

test('ignore_all_zero_rows: an empty gold stays strict, and the tolerance path agrees with the exact one', () => {
  assert.equal(compareResultsDetailed([], withZeroRows.slice(2), RELAXED).reason, 'row_count');
  assert.equal(compareResultsDetailed([], [], RELAXED).match, true);
  const tolerant = { ...RELAXED, tolerance: 0.01 };
  const nearly = withZeroRows.map((row) => (row.CustomerName === 'Acme' ? { ...row, january: 100.004 } : row));
  assert.equal(compareResultsDetailed(gold, nearly, tolerant).match, true);
  assert.equal(compareResultsDetailed(gold, [...nearly, { CustomerName: 'Echo', january: 0, february: 0.5, CustomerId: 5 }], tolerant).match, false);
  assert.equal(compareResultsDetailed(gold, [...nearly, { CustomerName: 'Echo', january: 0.004, february: 0, CustomerId: 5 }], tolerant).match, true, 'zero within the tolerance');
});

test('ignore_all_zero_rows: one column mapping across fixtures, surplus rows allowed on each', () => {
  const v2Gold = [{ CustomerName: 'Acme', jan_net_amount: 7, feb_net_amount: 3 }];
  const v2Prediction = [
    { CustomerName: 'Acme', january: 7, february: 3, CustomerId: 1 },
    { CustomerName: 'Beta', january: 0, february: 0, CustomerId: 2 },
  ];
  const shared = findSharedAssignment(
    [
      { expected: gold, actual: withZeroRows },
      { expected: v2Gold, actual: v2Prediction },
    ],
    RELAXED
  );
  assert.equal(shared.match, true);
  assert.deepEqual(shared.assignment, ['CustomerName', 'january', 'february']);
});

const SCALAR = { mode: 'scalar', decimals: 2, null_as_zero: ['total_net_amount'] };

test('empty_as_zero: an empty prediction equals one NULL or 0 gold row, only when the case opts in', () => {
  const relaxed = { ...SCALAR, empty_as_zero: true };
  assert.equal(compareResultsDetailed([{ total_net_amount: null }], [], SCALAR).reason, 'row_count');
  assert.deepEqual(compareResultsDetailed([{ total_net_amount: null }], [], relaxed), { match: true, assignment: {}, reason: 'match' });
  assert.equal(compareResultsDetailed([{ total_net_amount: 0 }], [], relaxed).match, true);
  assert.equal(compareResultsDetailed([{ total_net_amount: '0.00' }], [], relaxed).match, true);
  // A non-zero gold is not an empty answer.
  assert.equal(compareResultsDetailed([{ total_net_amount: 12.5 }], [], relaxed).reason, 'row_count');
  // A compared column outside null_as_zero must be NULL, not 0.
  const twoColumns = { mode: 'scalar', null_as_zero: ['total'], empty_as_zero: true };
  assert.equal(compareResultsDetailed([{ total: null, docs: 0 }], [], twoColumns).match, false);
  assert.equal(compareResultsDetailed([{ total: null, docs: null }], [], twoColumns).match, true);
  // The reverse (an empty gold) is not relaxed, and a non-empty prediction is scored as before.
  assert.equal(compareResultsDetailed([], [{ total_net_amount: null }], relaxed).reason, 'row_count');
  assert.equal(compareResultsDetailed([{ total_net_amount: null }], [{ total: 0 }], relaxed).match, true);
  assert.equal(compareResultsDetailed([{ total_net_amount: null }], [{ total: 3 }], relaxed).match, false);
});

test('the relaxation flags are validated, kept by normalization, and part of the scoring fingerprint only when set', () => {
  const base = { id: 'c', question: 'q', expected_sql: 'SELECT 1' };
  const pivot = normalizeBenchmarkCase({ ...base, comparison: RELAXED });
  assert.equal(pivot.comparison.ignore_all_zero_rows, true);
  assert.deepEqual(comparisonRelaxations(pivot.comparison), { ignoreAllZeroRows: true, emptyAsZero: false });
  const scalar = normalizeBenchmarkCase({ ...base, comparison: { ...SCALAR, empty_as_zero: true } });
  assert.deepEqual(comparisonRelaxations(scalar.comparison), { ignoreAllZeroRows: false, emptyAsZero: true });
  // Absent or false: not in the normalized spec, so old fingerprints hold.
  const plain = normalizeBenchmarkCase({ ...base, comparison: PIVOT });
  assert.equal('ignore_all_zero_rows' in plain.comparison, false);
  assert.equal(scoringFingerprint(normalizeBenchmarkCase({ ...base, comparison: { ...PIVOT, ignore_all_zero_rows: false } })), scoringFingerprint(plain));
  assert.notEqual(scoringFingerprint(pivot), scoringFingerprint(plain));
  // A flag that could never apply is a dataset error.
  assert.throws(() => normalizeBenchmarkCase({ ...base, comparison: { mode: 'ranked', null_as_zero: ['v'], ignore_all_zero_rows: true } }), /ignore_all_zero_rows applies to rowset mode/);
  assert.throws(() => normalizeBenchmarkCase({ ...base, comparison: { mode: 'rowset', ignore_all_zero_rows: true } }), /null_as_zero empty/);
  assert.throws(() => normalizeBenchmarkCase({ ...base, comparison: { mode: 'rowset', null_as_zero: ['v'], empty_as_zero: true } }), /empty_as_zero applies to scalar mode/);
  assert.throws(() => normalizeBenchmarkCase({ ...base, comparison: { ...SCALAR, empty_as_zero: 'yes' } }), /must be true or absent/);
});

// A fake mysql2 connection per fixture (as in eval-oracle.test.js): answers by
// SQL text, honoring sql_select_limit.
function fakeFixture(name, answers) {
  const sent = [];
  return {
    name,
    database: `db_${name}`,
    connection: {
      sent,
      async query(statement) {
        sent.push(statement);
        const sql = statement.replace(/^SET STATEMENT .*? FOR /, '');
        const limit = /sql_select_limit=(\d+)/.exec(statement);
        return [limit ? answers[sql].slice(0, Number(limit[1])) : answers[sql]];
      },
      async end() {},
    },
  };
}

test('oracle: ignore_all_zero_rows reads past the gold, and fails a prediction longer than it can read', async () => {
  const testCase = normalizeBenchmarkCase({ id: 'p', question: 'q', expected_sql: 'SELECT gold', comparison: RELAXED });
  const zeroRows = (count) => Array.from({ length: count }, (_row, index) => ({ CustomerName: `Z${index}`, january: 0, february: 0, CustomerId: 100 + index }));
  const pass = await scoreAgainstGold({
    testCase,
    predictedSql: 'SELECT pred',
    connections: [fakeFixture('seed', { 'SELECT gold': gold, 'SELECT pred': [...withZeroRows, ...zeroRows(5)] })],
  });
  assert.equal(pass.match, true);
  assert.deepEqual([pass.perFixture[0].goldRowCount, pass.perFixture[0].actualRowCount, pass.perFixture[0].truncated], [2, 9, false]);
  const connections = [fakeFixture('seed', { 'SELECT gold': gold, 'SELECT pred': [...withZeroRows, ...zeroRows(ALL_ZERO_ROWS_ALLOWANCE)] })];
  const tooLong = await scoreAgainstGold({ testCase, predictedSql: 'SELECT pred', connections });
  assert.equal(tooLong.match, false);
  assert.equal(tooLong.reason, 'row_count');
  assert.equal(tooLong.perFixture[0].truncated, true);
  assert.match(connections[0].connection.sent.at(-1), new RegExp(`sql_select_limit=${gold.length + 1 + ALL_ZERO_ROWS_ALLOWANCE} FOR SELECT pred$`));
  // Without the relaxation the cap stays the gold's row count + 1.
  const strict = [fakeFixture('seed', { 'SELECT gold': gold, 'SELECT pred': withZeroRows })];
  const strictResult = await scoreAgainstGold({ testCase: normalizeBenchmarkCase({ ...testCase, comparison: PIVOT }), predictedSql: 'SELECT pred', connections: strict });
  assert.equal(strictResult.reason, 'row_count');
  assert.match(strict[0].connection.sent.at(-1), /sql_select_limit=3 FOR SELECT pred$/);
});

test('oracle: empty_as_zero passes a GROUP BY total that is empty where the gold is one NULL row', async () => {
  const testCase = normalizeBenchmarkCase({ id: 's', question: 'q', expected_sql: 'SELECT gold', comparison: { ...SCALAR, empty_as_zero: true } });
  const prediction = 'SELECT LocationName, total ... GROUP BY LocationName';
  const result = await scoreAgainstGold({
    testCase,
    predictedSql: prediction,
    connections: [
      fakeFixture('seed', { 'SELECT gold': [{ total_net_amount: null }], [prediction]: [] }),
      fakeFixture('v2', { 'SELECT gold': [{ total_net_amount: 150 }], [prediction]: [{ LocationName: 'South Store', total: 150 }] }),
    ],
  });
  assert.equal(result.match, true);
  assert.deepEqual(result.assignment, { total_net_amount: 'total' });
  // Empty where the gold is not zero still fails.
  const wrong = await scoreAgainstGold({
    testCase,
    predictedSql: prediction,
    connections: [fakeFixture('v2', { 'SELECT gold': [{ total_net_amount: 150 }], [prediction]: [] })],
  });
  assert.equal(wrong.match, false);
  assert.equal(wrong.reason, 'row_count');
});
