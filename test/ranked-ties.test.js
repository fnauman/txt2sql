// Ties at a ranked gold's cut-off. The gold's LIMIT cuts its ranking through a
// group of items with equal ranking values and its tiebreak (`ORDER BY qty
// DESC, ProductName ASC`) picks some of them; a correct prediction without that
// tiebreak may pick others, and MariaDB picks nondeterministically between
// executions. Rows tied at the gold's last (boundary) ranking value are
// therefore interchangeable by value when the gold was cut by its own LIMIT;
// every row above the boundary still matches by its full tuple.
//
// The helper is read through the namespace so that this file still loads (and
// each test fails on its own) against a build without it.
import assert from 'node:assert/strict';
import test from 'node:test';

import * as benchmark from '../src/benchmark.js';
import { compareResults, compareResultsDetailed, findSharedAssignment, normalizeBenchmarkCase } from '../src/benchmark.js';
import { scoreAgainstGold } from '../src/eval/oracle.js';

const CUT = { goldCutOff: true };
const QTY = { mode: 'ranked', order: 'desc', decimals: 3, value_columns: ['total_qty'] };

// tpl_product_qty_top5_feb_2026_8a9dc1 on fixture v3: 'Herbal Tea Variety
// Pack' and 'Spring Water 24 Pack' both moved 34 units, at position 5. The gold
// keeps Herbal Tea (ProductName ASC); the live baseline's SQL had no tiebreak.
const v3Gold = [
  { ProductName: 'Protein Bar Box', total_qty: '79.000' },
  { ProductName: 'Cold Brew Coffee 6 Pack', total_qty: '53.000' },
  { ProductName: 'Long Grain Rice 5kg', total_qty: '42.000' },
  { ProductName: 'Kitchen Towels 4 Roll', total_qty: '40.000' },
  { ProductName: 'Herbal Tea Variety Pack', total_qty: '34.000' },
];
const withRow = (rows, index, row) => rows.map((existing, position) => (position === index ? row : existing));
const springWater = withRow(v3Gold, 4, { ProductName: 'Spring Water 24 Pack', total_qty: '34.000' });

test('the v3 tie: the other product tied at the cut-off passes', () => {
  assert.deepEqual(compareResultsDetailed(v3Gold, springWater, QTY, CUT), {
    match: true,
    assignment: { ProductName: 'ProductName', total_qty: 'total_qty' },
    reason: 'match',
  });
  // Under another alias, with an extra id column and numbers instead of DECIMAL strings.
  const aliased = springWater.map((row, index) => ({ ProductId: 100 + index, name: row.ProductName, qty: Number(row.total_qty) }));
  assert.deepEqual(compareResultsDetailed(v3Gold, aliased, QTY, CUT).assignment, { ProductName: 'name', total_qty: 'qty' });
  assert.equal(compareResults(v3Gold, v3Gold, QTY, CUT), true);
});

test('a complete gold (not cut by its LIMIT) stays strict: another label at its last value is another item', () => {
  assert.equal(compareResultsDetailed(v3Gold, springWater, QTY).reason, 'values');
  assert.equal(compareResults(v3Gold, springWater, QTY, { goldCutOff: false }), false);
});

test('a prediction that replaces a row above the boundary fails', () => {
  // Same value as the replaced row, another product.
  const replacedTop = withRow(v3Gold, 0, { ProductName: 'Spring Water 24 Pack', total_qty: '79.000' });
  assert.equal(compareResultsDetailed(v3Gold, replacedTop, QTY, CUT).reason, 'values');
  const replacedFourth = withRow(springWater, 3, { ProductName: 'Herbal Tea Variety Pack', total_qty: '40.000' });
  assert.equal(compareResults(v3Gold, replacedFourth, QTY, CUT), false);
  // Kitchen Towels dropped for the second boundary product: one boundary row in the gold, two here.
  const bothTied = [...v3Gold.slice(0, 3), v3Gold[4], springWater[4]];
  assert.equal(compareResults(v3Gold, bothTied, QTY, CUT), false);
});

test('a boundary row with a different value fails', () => {
  assert.equal(compareResults(v3Gold, withRow(v3Gold, 4, { ProductName: 'Spring Water 24 Pack', total_qty: '33.000' }), QTY, CUT), false);
  assert.equal(compareResults(v3Gold, withRow(v3Gold, 4, { ProductName: 'Northstar Trail Crisps', total_qty: '29.000' }), QTY, CUT), false);
  // decimals: 3 tells 34.000 from 34.001.
  assert.equal(compareResults(v3Gold, withRow(v3Gold, 4, { ProductName: 'Spring Water 24 Pack', total_qty: '34.001' }), QTY, CUT), false);
});

test('the ranking still has to hold for a tie-swapped prediction', () => {
  const unsorted = [springWater[4], ...springWater.slice(0, 4)];
  assert.equal(compareResultsDetailed(v3Gold, unsorted, QTY, CUT).reason, 'ranking');
});

test('ascending ranking: the tie at the cut-off is the largest value kept', () => {
  const spec = { mode: 'ranked', order: 'asc', decimals: 3, value_columns: ['total_qty'] };
  // Five products that moved the fewest units; 29 is shared with 'Sparkling Water 24 Pack'.
  const gold = [
    { ProductName: 'Cane Sugar 2kg', total_qty: 12 },
    { ProductName: 'Oat Cookies Tin', total_qty: 12 },
    { ProductName: 'Lime Seltzer 8 Pack', total_qty: 17 },
    { ProductName: 'Sparkling Water 12 Pack', total_qty: 27 },
    { ProductName: 'Northstar Trail Crisps', total_qty: 29 },
  ];
  assert.equal(compareResults(gold, withRow(gold, 4, { ProductName: 'Sparkling Water 24 Pack', total_qty: 29 }), spec, CUT), true);
  // A tie above the boundary is not at the cut-off: both items belong in the answer.
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'Herbal Tea Variety Pack', total_qty: 12 }), spec, CUT), false);
  assert.equal(compareResults(gold, withRow(gold, 4, { ProductName: 'Sparkling Water 24 Pack', total_qty: 30 }), spec, CUT), false);
  assert.equal(compareResultsDetailed(gold, [...gold].reverse(), spec, CUT).reason, 'ranking');
});

test('several value columns: a tie at the cut-off is a tie on every ranking value', () => {
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['total_qty', 'net_amount'] };
  const gold = [
    { ProductName: 'A', total_qty: 50, net_amount: 500 },
    { ProductName: 'B', total_qty: 34, net_amount: 120.5 },
  ];
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'C', total_qty: 34, net_amount: 120.5 }), spec, CUT), true);
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'C', total_qty: 34, net_amount: 99 }), spec, CUT), false);
  assert.equal(compareResults(gold, withRow(gold, 0, { ProductName: 'C', total_qty: 50, net_amount: 500 }), spec, CUT), false);
});

test('several rows tied at the cut-off: their count and values must agree, their labels may differ', () => {
  const spec = { mode: 'ranked', value_columns: ['v'] };
  const gold = [
    { name: 'A', v: 50 },
    { name: 'B', v: 34 },
    { name: 'C', v: 34 },
  ];
  assert.equal(compareResults(gold, [{ name: 'A', v: 50 }, { name: 'E', v: 34 }, { name: 'D', v: 34 }], spec, CUT), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 50 }, { name: 'B', v: 34 }, { name: 'D', v: 33 }], spec, CUT), false);
  assert.equal(compareResults(gold, [{ name: 'D', v: 50 }, { name: 'B', v: 34 }, { name: 'C', v: 34 }], spec, CUT), false);
  // Every row tied: any items of that value.
  assert.equal(compareResults([{ name: 'A', v: 5 }, { name: 'B', v: 5 }], [{ name: 'C', v: 5 }, { name: 'D', v: 5 }], spec, CUT), true);
});

test('a single-row cut (top 1) and empty results', () => {
  const spec = { mode: 'ranked', value_columns: ['v'] };
  assert.equal(compareResults([{ name: 'A', v: 10 }], [{ name: 'B', v: 10 }], spec, CUT), true);
  assert.equal(compareResults([{ name: 'A', v: 10 }], [{ name: 'B', v: 9 }], spec, CUT), false);
  assert.equal(compareResults([{ name: 'A', v: 10 }], [{ name: 'B', v: 10 }], spec), false);
  assert.equal(compareResultsDetailed([], [], spec, CUT).match, true);
  assert.equal(compareResultsDetailed([], [{ name: 'B', v: 10 }], spec, CUT).reason, 'row_count');
});

test('NULL ranking values tie with each other at the cut-off (and with 0 under null_as_zero)', () => {
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['v'] };
  const gold = [
    { name: 'A', v: 10 },
    { name: 'B', v: null },
  ];
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: null }], spec, CUT), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: 0 }], spec, CUT), false);
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: 0 }], { ...spec, null_as_zero: ['v'] }, CUT), true);
});

test('with a tolerance, boundary rows pair by ranking values within it', () => {
  const spec = { mode: 'ranked', order: 'desc', tolerance: 0.01, value_columns: ['v'] };
  const gold = [
    { name: 'A', v: 100 },
    { name: 'B', v: 50 },
  ];
  assert.equal(compareResults(gold, [{ name: 'A', v: 100.005 }, { name: 'X', v: 50.008 }], spec, CUT), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 100 }, { name: 'X', v: 50.02 }], spec, CUT), false);
  assert.equal(compareResults(gold, [{ name: 'Y', v: 100 }, { name: 'B', v: 50 }], spec, CUT), false);
});

test('scalar and rowset comparisons ignore the cut-off', () => {
  const rows = [
    { name: 'A', v: 10 },
    { name: 'B', v: 5 },
  ];
  const swapped = [rows[0], { name: 'C', v: 5 }];
  assert.equal(compareResults(rows, swapped, { mode: 'rowset' }, CUT), false);
  assert.equal(compareResults([{ v: 5 }], [{ v: 6 }], { mode: 'scalar' }, CUT), false);
  assert.equal(compareResults(rows, swapped, { mode: 'ranked', value_columns: ['v'] }, CUT), true);
});

test('findSharedAssignment applies the cut-off per pair', () => {
  const seedGold = v3Gold.slice(0, 2);
  // seed: the gold returned fewer rows than its LIMIT (complete); v3: cut.
  const seed = { expected: seedGold, actual: seedGold, goldCutOff: false };
  const v3 = { expected: v3Gold, actual: springWater, goldCutOff: true };
  assert.deepEqual(findSharedAssignment([seed, v3], QTY), {
    match: true,
    goldColumns: ['ProductName', 'total_qty'],
    assignment: ['ProductName', 'total_qty'],
    reason: 'match',
  });
  assert.equal(findSharedAssignment([seed, { ...v3, goldCutOff: false }], QTY).match, false);
  const seedSwapped = { ...seed, actual: withRow(seedGold, 1, { ProductName: 'Spring Water 24 Pack', total_qty: '53.000' }) };
  assert.equal(findSharedAssignment([seedSwapped, v3], QTY).match, false);
});

test('topLevelLimitRowCount reads the row count of the outermost LIMIT', () => {
  const { topLevelLimitRowCount } = benchmark;
  assert.equal(typeof topLevelLimitRowCount, 'function');
  assert.equal(topLevelLimitRowCount('SELECT a, SUM(b) AS v FROM t GROUP BY a ORDER BY SUM(b) DESC, a ASC LIMIT 5'), 5);
  assert.equal(topLevelLimitRowCount('select a from t order by a limit 10;'), 10);
  assert.equal(topLevelLimitRowCount('SELECT a FROM t ORDER BY a LIMIT 2, 5'), 5);
  assert.equal(topLevelLimitRowCount('SELECT a FROM t ORDER BY a LIMIT 5 OFFSET 2'), 5);
  assert.equal(topLevelLimitRowCount('SELECT a FROM t UNION ALL SELECT b FROM u ORDER BY 1 LIMIT 3'), 3);
  assert.equal(topLevelLimitRowCount('SELECT * FROM (SELECT a FROM t ORDER BY a LIMIT 3) s'), null);
  assert.equal(topLevelLimitRowCount('WITH x AS (SELECT a FROM t LIMIT 3) SELECT * FROM x'), null);
  assert.equal(topLevelLimitRowCount("SELECT 'LIMIT 5' AS a FROM t"), null);
  assert.equal(topLevelLimitRowCount('SELECT a FROM t -- LIMIT 5\n'), null);
  assert.equal(topLevelLimitRowCount('SELECT a FROM t LIMIT @n'), null);
  assert.equal(topLevelLimitRowCount('SELECT a FROM t'), null);
  assert.equal(topLevelLimitRowCount(null), null);
});

// --- Through the oracle -------------------------------------------------------

const PRED = 'SELECT pred';

// A fake mysql2 connection answering by SQL text (see test/eval-oracle.test.js).
function fakeFixture(name, answers) {
  return {
    name,
    database: `db_${name}`,
    connection: {
      async query(statement) {
        const sql = statement.replace(/^SET STATEMENT .*? FOR /, '');
        if (!answers[sql]) {
          throw Object.assign(new Error(`Unknown SQL ${sql}`), { code: 'ER_PARSE_ERROR' });
        }
        const limit = /sql_select_limit=(\d+)/.exec(statement);
        return [limit ? answers[sql].slice(0, Number(limit[1])) : answers[sql]];
      },
      async end() {},
    },
  };
}

const topCase = (expected_sql) => normalizeBenchmarkCase({ id: 'top5', question: 'Top 5 products by units', expected_sql, comparison: QTY });

test('oracle: a gold cut by its LIMIT accepts the other product tied at the cut-off on every fixture', async () => {
  const gold = 'SELECT p.ProductName, total_qty FROM x ORDER BY total_qty DESC, p.ProductName ASC LIMIT 5';
  const seedGold = v3Gold.slice(0, 2);
  const connections = [
    fakeFixture('seed', { [gold]: seedGold, [PRED]: seedGold }),
    fakeFixture('v3', { [gold]: v3Gold, [PRED]: springWater }),
  ];
  const result = await scoreAgainstGold({ testCase: topCase(gold), predictedSql: PRED, connections });
  assert.equal(result.match, true);
  assert.equal(result.reason, 'match');
  assert.deepEqual(result.killedOn, []);
  assert.deepEqual(result.assignment, { ProductName: 'ProductName', total_qty: 'total_qty' });
});

test('oracle: a gold under its LIMIT, or without one, is complete and stays strict', async () => {
  // LIMIT 10 returned 5 rows: every item of the boundary value is in the gold.
  const underLimit = 'SELECT p.ProductName, total_qty FROM x ORDER BY total_qty DESC, p.ProductName ASC LIMIT 10';
  const noLimit = 'SELECT p.ProductName, total_qty FROM x ORDER BY total_qty DESC, p.ProductName ASC';
  for (const gold of [underLimit, noLimit]) {
    const result = await scoreAgainstGold({
      testCase: topCase(gold),
      predictedSql: PRED,
      connections: [fakeFixture('v3', { [gold]: v3Gold, [PRED]: springWater })],
    });
    assert.equal(result.match, false, gold);
    assert.equal(result.reason, 'values');
    assert.deepEqual(result.killedOn, ['v3']);
  }
});

test('oracle: each gold variant is judged by its own LIMIT', async () => {
  const gold = 'SELECT p.ProductName, total_qty FROM x ORDER BY total_qty DESC LIMIT 6';
  const alternative = 'SELECT p.ProductName, total_qty FROM x ORDER BY total_qty DESC, p.ProductName ASC LIMIT 5';
  const testCase = normalizeBenchmarkCase({ ...topCase(gold), alternative_expected_sql: [alternative] });
  const connections = [fakeFixture('v3', { [gold]: v3Gold, [alternative]: v3Gold, [PRED]: springWater })];
  const result = await scoreAgainstGold({ testCase, predictedSql: PRED, connections });
  assert.equal(result.match, true);
  assert.equal(result.matchedGold, 'alternative_expected_sql[0]');
  assert.deepEqual(result.variants.map((variant) => variant.match), [false, true]);
});
