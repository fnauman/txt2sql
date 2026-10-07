// Ties at a ranked gold's cut-off. The gold's LIMIT cuts its ranking through a
// group of items with equal ranking values and its tiebreak (`ORDER BY qty
// DESC, ProductName ASC`) picks some of them; a correct prediction without that
// tiebreak may pick others, and MariaDB picks nondeterministically between
// executions. The caller passes `goldTies`, the rows the gold's LIMIT left
// out; those tied with the gold's last (boundary) ranking value may stand in
// for its boundary rows, each at most once and by its full tuple. Every row
// above the boundary still matches by its full tuple, and without a tie the
// comparison is strict.
//
// The helper is read through the namespace so that this file still loads (and
// each test fails on its own) against a build without it.
import assert from 'node:assert/strict';
import test from 'node:test';

import * as benchmark from '../src/benchmark.js';
import { compareResults, compareResultsDetailed, findSharedAssignment, normalizeBenchmarkCase } from '../src/benchmark.js';
import { scoreAgainstGold } from '../src/eval/oracle.js';

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
// What the gold's LIMIT 5 left out on v3: Spring Water ties at 34, the rest is below.
const v3PastLimit = [
  { ProductName: 'Spring Water 24 Pack', total_qty: '34.000' },
  { ProductName: 'Northstar Trail Crisps', total_qty: '29.000' },
  { ProductName: 'Lime Seltzer 8 Pack', total_qty: '17.000' },
];
const CUT = { goldTies: v3PastLimit };
const ties = (...rows) => ({ goldTies: rows });

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
  assert.equal(compareResults(v3Gold, springWater, QTY, { goldTies: [] }), false);
  assert.equal(compareResults(v3Gold, springWater, QTY, { goldTies: null }), false);
});

test('a gold cut by its LIMIT without a tie stays strict: the left-out rows rank below its last one', () => {
  // W1 in the review: MAX() over grouped rows without a GROUP BY labels v2's
  // top total with an arbitrary outlet. Nothing else has that total.
  const spec = { mode: 'ranked', order: 'desc', decimals: 2 };
  const gold = [{ LocationName: 'Online Fulfillment', total_net_amount: 3195.01 }];
  const pastLimit = [
    { LocationName: 'North Warehouse', total_net_amount: 1210.4 },
    { LocationName: 'Harbor Street', total_net_amount: 980 },
  ];
  assert.equal(compareResultsDetailed(gold, [{ LocationName: 'North Warehouse', total_net_amount: 3195.01 }], spec, ties(...pastLimit)).reason, 'values');
  const v3NoTie = v3PastLimit.slice(1);
  assert.equal(compareResults(v3Gold, springWater, QTY, ties(...v3NoTie)), false);
  assert.equal(compareResults(v3Gold, v3Gold, QTY, ties(...v3NoTie)), true);
});

test('a tie-swapped boundary row must be one of the tied items, listed once', () => {
  const spec = { mode: 'ranked', value_columns: ['total_qty'] };
  const gold = [
    { name: 'A', total_qty: 50 },
    { name: 'B', total_qty: 40 },
    { name: 'C', total_qty: 34 },
  ];
  const tied = ties({ name: 'D', total_qty: 34 }, { name: 'E', total_qty: 20 });
  assert.equal(compareResults(gold, withRow(gold, 2, { name: 'D', total_qty: 34 }), spec, tied), true);
  // An item above the boundary listed again at the boundary value.
  assert.equal(compareResults(gold, withRow(gold, 2, { name: 'A', total_qty: 34 }), spec, tied), false);
  // No label, or a number for a label.
  assert.equal(compareResults(gold, withRow(gold, 2, { name: null, total_qty: 34 }), spec, tied), false);
  assert.equal(compareResults(gold, withRow(gold, 2, { name: 34, total_qty: 34 }), spec, tied), false);
  // An item that is not tied at all (it is past the LIMIT with another value).
  assert.equal(compareResults(gold, withRow(gold, 2, { name: 'E', total_qty: 34 }), spec, tied), false);
  // Two boundary rows: the same tied item twice.
  const twoTied = [gold[0], { name: 'B', total_qty: 34 }, { name: 'C', total_qty: 34 }];
  assert.equal(compareResults(twoTied, [gold[0], { name: 'B', total_qty: 34 }, { name: 'B', total_qty: 34 }], spec, tied), false);
  assert.equal(compareResults(twoTied, [gold[0], { name: 'D', total_qty: 34 }, { name: 'B', total_qty: 34 }], spec, tied), true);
  assert.equal(compareResults(twoTied, [gold[0], { name: 'D', total_qty: 34 }, { name: 'D', total_qty: 34 }], spec, tied), false);
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
  const tied = ties({ ProductName: 'Sparkling Water 24 Pack', total_qty: 29 }, { ProductName: 'Herbal Tea Variety Pack', total_qty: 30 });
  assert.equal(compareResults(gold, withRow(gold, 4, { ProductName: 'Sparkling Water 24 Pack', total_qty: 29 }), spec, tied), true);
  // A tie above the boundary is not at the cut-off: both items belong in the answer.
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'Herbal Tea Variety Pack', total_qty: 12 }), spec, tied), false);
  assert.equal(compareResults(gold, withRow(gold, 4, { ProductName: 'Herbal Tea Variety Pack', total_qty: 30 }), spec, tied), false);
  assert.equal(compareResults(gold, withRow(gold, 4, { ProductName: 'Herbal Tea Variety Pack', total_qty: 29 }), spec, tied), false);
  assert.equal(compareResultsDetailed(gold, [...gold].reverse(), spec, tied).reason, 'ranking');
});

test('several value columns: a tie at the cut-off is a tie on every ranking value', () => {
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['total_qty', 'net_amount'] };
  const gold = [
    { ProductName: 'A', total_qty: 50, net_amount: 500 },
    { ProductName: 'B', total_qty: 34, net_amount: 120.5 },
  ];
  const tied = ties({ ProductName: 'C', total_qty: 34, net_amount: 120.5 }, { ProductName: 'D', total_qty: 34, net_amount: 99 });
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'C', total_qty: 34, net_amount: 120.5 }), spec, tied), true);
  // D ties on total_qty only: not a tie.
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'D', total_qty: 34, net_amount: 99 }), spec, tied), false);
  assert.equal(compareResults(gold, withRow(gold, 1, { ProductName: 'D', total_qty: 34, net_amount: 120.5 }), spec, tied), false);
  assert.equal(compareResults(gold, withRow(gold, 0, { ProductName: 'C', total_qty: 50, net_amount: 500 }), spec, tied), false);
});

test('several rows tied at the cut-off: their count and values must agree, and each may be any tied item', () => {
  const spec = { mode: 'ranked', value_columns: ['v'] };
  const gold = [
    { name: 'A', v: 50 },
    { name: 'B', v: 34 },
    { name: 'C', v: 34 },
  ];
  const tied = ties({ name: 'D', v: 34 }, { name: 'E', v: 34 }, { name: 'F', v: 33 });
  assert.equal(compareResults(gold, [{ name: 'A', v: 50 }, { name: 'E', v: 34 }, { name: 'D', v: 34 }], spec, tied), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 50 }, { name: 'B', v: 34 }, { name: 'F', v: 33 }], spec, tied), false);
  assert.equal(compareResults(gold, [{ name: 'D', v: 50 }, { name: 'B', v: 34 }, { name: 'C', v: 34 }], spec, tied), false);
  // Every row tied: any of the tied items.
  const allTied = ties({ name: 'C', v: 5 }, { name: 'D', v: 5 });
  assert.equal(compareResults([{ name: 'A', v: 5 }, { name: 'B', v: 5 }], [{ name: 'C', v: 5 }, { name: 'D', v: 5 }], spec, allTied), true);
  assert.equal(compareResults([{ name: 'A', v: 5 }, { name: 'B', v: 5 }], [{ name: 'C', v: 5 }, { name: 'X', v: 5 }], spec, allTied), false);
});

test('a single-row cut (top 1) and empty results', () => {
  const spec = { mode: 'ranked', value_columns: ['v'] };
  // B ties with A at 10: either is the top 1.
  assert.equal(compareResults([{ name: 'A', v: 10 }], [{ name: 'B', v: 10 }], spec, ties({ name: 'B', v: 10 })), true);
  assert.equal(compareResults([{ name: 'A', v: 10 }], [{ name: 'B', v: 9 }], spec, ties({ name: 'B', v: 10 })), false);
  // Nothing ties with A: the top 1's label is compared.
  assert.equal(compareResults([{ name: 'A', v: 10 }], [{ name: 'B', v: 10 }], spec, ties({ name: 'B', v: 9 })), false);
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
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: null }], spec, ties({ name: 'C', v: null })), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: 0 }], spec, ties({ name: 'C', v: 0 })), false);
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: 0 }], { ...spec, null_as_zero: ['v'] }, ties({ name: 'C', v: null })), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 10 }, { name: 'C', v: 0 }], { ...spec, null_as_zero: ['v'] }, ties({ name: 'C', v: 0 })), true);
});

test('with a tolerance, tied items and boundary rows pair within it', () => {
  const spec = { mode: 'ranked', order: 'desc', tolerance: 0.01, value_columns: ['v'] };
  const gold = [
    { name: 'A', v: 100 },
    { name: 'B', v: 50 },
  ];
  const tied = ties({ name: 'X', v: 50.004 }, { name: 'Z', v: 49 });
  assert.equal(compareResults(gold, [{ name: 'A', v: 100.005 }, { name: 'X', v: 50.008 }], spec, tied), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 100.005 }, { name: 'B', v: 49.995 }], spec, tied), true);
  assert.equal(compareResults(gold, [{ name: 'A', v: 100 }, { name: 'X', v: 50.02 }], spec, tied), false);
  assert.equal(compareResults(gold, [{ name: 'A', v: 100 }, { name: 'Z', v: 50 }], spec, tied), false);
  assert.equal(compareResults(gold, [{ name: 'Y', v: 100 }, { name: 'B', v: 50 }], spec, tied), false);
  // Two boundary rows and one tie: the tie stands in for one of them, once.
  const twoTied = [gold[0], { name: 'B', v: 50 }, { name: 'C', v: 50 }];
  assert.equal(compareResults(twoTied, [gold[0], { name: 'X', v: 50 }, { name: 'C', v: 50.001 }], spec, tied), true);
  assert.equal(compareResults(twoTied, [gold[0], { name: 'X', v: 50 }, { name: 'X', v: 50.001 }], spec, tied), false);
});

test('with a tolerance, a row above the boundary still ranks above a tied item within twice the tolerance of it', () => {
  const spec = { mode: 'ranked', order: 'desc', tolerance: 0.01, value_columns: ['v'] };
  const gold = [
    { name: 'A', v: 50.015 },
    { name: 'B', v: 50 },
  ];
  const tied = ties({ name: 'X', v: 50.004 });
  assert.equal(compareResultsDetailed(gold, [gold[0], { name: 'X', v: 50.004 }], spec, tied).reason, 'match');
  assert.equal(compareResultsDetailed(gold, [{ name: 'X', v: 50.004 }, gold[0]], spec, tied).reason, 'ranking');
  assert.equal(compareResultsDetailed(gold, [gold[1], gold[0]], spec, tied).reason, 'ranking');
  // The boundary rows and the ties are one group of equal ranking values:
  // they reorder freely among themselves.
  const twoTied = [{ name: 'A', v: 100 }, { name: 'B', v: 50.005 }, { name: 'C', v: 50 }];
  assert.equal(compareResultsDetailed(twoTied, [twoTied[0], { name: 'X', v: 50.004 }, twoTied[1]], spec, tied).reason, 'match');
  assert.equal(compareResultsDetailed(twoTied, [twoTied[0], twoTied[2], twoTied[1]], spec, tied).reason, 'match');
});

test('scalar and rowset comparisons ignore the cut-off', () => {
  const rows = [
    { name: 'A', v: 10 },
    { name: 'B', v: 5 },
  ];
  const swapped = [rows[0], { name: 'C', v: 5 }];
  const tied = ties({ name: 'C', v: 5 });
  assert.equal(compareResults(rows, swapped, { mode: 'rowset' }, tied), false);
  assert.equal(compareResults([{ v: 5 }], [{ v: 6 }], { mode: 'scalar' }, ties({ v: 6 })), false);
  assert.equal(compareResults(rows, swapped, { mode: 'ranked', value_columns: ['v'] }, tied), true);
});

test('findSharedAssignment applies the cut-off per pair', () => {
  const seedGold = v3Gold.slice(0, 2);
  // seed: the gold returned fewer rows than its LIMIT (complete); v3: cut.
  const seed = { expected: seedGold, actual: seedGold, goldTies: null };
  const v3 = { expected: v3Gold, actual: springWater, goldTies: v3PastLimit };
  assert.deepEqual(findSharedAssignment([seed, v3], QTY), {
    match: true,
    goldColumns: ['ProductName', 'total_qty'],
    assignment: ['ProductName', 'total_qty'],
    reason: 'match',
  });
  assert.equal(findSharedAssignment([seed, { ...v3, goldTies: null }], QTY).match, false);
  assert.equal(findSharedAssignment([seed, { ...v3, goldTies: v3PastLimit.slice(1) }], QTY).match, false);
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

test('withTopLevelLimitRowCount rewrites only the outermost LIMIT\'s row count', () => {
  const { withTopLevelLimitRowCount } = benchmark;
  assert.equal(typeof withTopLevelLimitRowCount, 'function');
  assert.equal(withTopLevelLimitRowCount('SELECT a FROM t ORDER BY v DESC, a LIMIT 5', 1005), 'SELECT a FROM t ORDER BY v DESC, a LIMIT 1005');
  assert.equal(withTopLevelLimitRowCount('SELECT a FROM t ORDER BY a LIMIT 2, 5;', 1005), 'SELECT a FROM t ORDER BY a LIMIT 2, 1005;');
  assert.equal(withTopLevelLimitRowCount('SELECT a FROM t ORDER BY a LIMIT 5 OFFSET 2', 1005), 'SELECT a FROM t ORDER BY a LIMIT 1005 OFFSET 2');
  assert.equal(
    withTopLevelLimitRowCount('SELECT * FROM (SELECT a FROM t LIMIT 3) s ORDER BY a LIMIT 3', 9),
    'SELECT * FROM (SELECT a FROM t LIMIT 3) s ORDER BY a LIMIT 9'
  );
  assert.equal(withTopLevelLimitRowCount('SELECT * FROM (SELECT a FROM t LIMIT 3) s', 9), null);
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

const CUT_GOLD = 'SELECT p.ProductName, total_qty FROM x ORDER BY total_qty DESC, p.ProductName ASC LIMIT 5';
// The oracle reads a cut gold GOLD_TIE_LOOKAHEAD_ROWS past its LIMIT.
const pastLimit = (sql) => sql.replace(/LIMIT (\d+)$/, (_match, count) => `LIMIT ${Number(count) + 1000}`);

test('oracle: a gold cut by its LIMIT accepts the other product tied at the cut-off on every fixture', async () => {
  const seedGold = v3Gold.slice(0, 2);
  const connections = [
    fakeFixture('seed', { [CUT_GOLD]: seedGold, [PRED]: seedGold }),
    fakeFixture('v3', { [CUT_GOLD]: v3Gold, [pastLimit(CUT_GOLD)]: [...v3Gold, ...v3PastLimit], [PRED]: springWater }),
  ];
  const result = await scoreAgainstGold({ testCase: topCase(CUT_GOLD), predictedSql: PRED, connections });
  assert.equal(result.match, true);
  assert.equal(result.reason, 'match');
  assert.deepEqual(result.killedOn, []);
  assert.deepEqual(result.assignment, { ProductName: 'ProductName', total_qty: 'total_qty' });
});

test('oracle: a gold cut by its LIMIT with no tie at the cut-off stays strict', async () => {
  const connections = [fakeFixture('v3', { [CUT_GOLD]: v3Gold, [pastLimit(CUT_GOLD)]: [...v3Gold, ...v3PastLimit.slice(1)], [PRED]: springWater })];
  const result = await scoreAgainstGold({ testCase: topCase(CUT_GOLD), predictedSql: PRED, connections });
  assert.equal(result.match, false);
  assert.equal(result.reason, 'values');
  assert.deepEqual(result.killedOn, ['v3']);
});

test('oracle: a tied gold still rejects an item listed twice or one that is not tied', async () => {
  const tiedFixture = (prediction) => [fakeFixture('v3', { [CUT_GOLD]: v3Gold, [pastLimit(CUT_GOLD)]: [...v3Gold, ...v3PastLimit], [PRED]: prediction })];
  for (const name of ['Protein Bar Box', 'Northstar Trail Crisps']) {
    const prediction = withRow(v3Gold, 4, { ProductName: name, total_qty: '34.000' });
    const result = await scoreAgainstGold({ testCase: topCase(CUT_GOLD), predictedSql: PRED, connections: tiedFixture(prediction) });
    assert.equal(result.reason, 'values', name);
  }
});

test('oracle: a run past the LIMIT that does not start with the gold\'s rows relaxes nothing', async () => {
  // The gold's order is not total: Spring Water comes first past the LIMIT.
  const reordered = [...v3Gold.slice(0, 4), ...v3PastLimit.slice(0, 1), v3Gold[4], ...v3PastLimit.slice(1)];
  const connections = [fakeFixture('v3', { [CUT_GOLD]: v3Gold, [pastLimit(CUT_GOLD)]: reordered, [PRED]: springWater })];
  const result = await scoreAgainstGold({ testCase: topCase(CUT_GOLD), predictedSql: PRED, connections });
  assert.equal(result.match, false);
  assert.equal(result.reason, 'values');
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
  const connections = [
    fakeFixture('v3', { [gold]: v3Gold, [alternative]: v3Gold, [pastLimit(alternative)]: [...v3Gold, ...v3PastLimit], [PRED]: springWater }),
  ];
  const result = await scoreAgainstGold({ testCase, predictedSql: PRED, connections });
  assert.equal(result.match, true);
  assert.equal(result.matchedGold, 'alternative_expected_sql[0]');
  assert.deepEqual(result.variants.map((variant) => variant.match), [false, true]);
});
