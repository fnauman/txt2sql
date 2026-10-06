import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalTemporalValue,
  classifyBenchmarkStatus,
  collectBenchmarkWarnings,
  compareResults,
  compareResultsDetailed,
  findSharedAssignment,
  isColumnNamedLike,
  matchResultSets,
} from '../src/benchmark.js';

// A correct answer the model phrased with a different alias and extra columns.
const goldRanked = [
  { CustomerName: 'Acme', total_net_amount: 100.0 },
  { CustomerName: 'Beta', total_net_amount: 60.0 },
  { CustomerName: 'Gamma', total_net_amount: 40.0 },
];

test('no comparison spec falls back to legacy exact-row behavior', () => {
  // Same data, different alias -> legacy compareRows treats it as a mismatch.
  const actual = [{ CustomerName: 'Acme', net: 100.0 }];
  const gold = [{ CustomerName: 'Acme', total_net_amount: 100.0 }];
  assert.equal(compareResults(gold, actual, null), false);
  assert.equal(compareResults(gold, gold, null), true);
});

test('rowset tolerates aliased metric column', () => {
  const actual = [
    { CustomerName: 'Acme', net_sales: 100.0 },
    { CustomerName: 'Beta', net_sales: 60.0 },
    { CustomerName: 'Gamma', net_sales: 40.0 },
  ];
  assert.equal(compareResults(goldRanked, actual, { mode: 'rowset' }), true);
});

test('rowset tolerates extra projected columns and column reordering', () => {
  const actual = [
    { CustomerId: 1, total: 40.0, CustomerCode: 'C3', CustomerName: 'Gamma' },
    { CustomerId: 2, total: 100.0, CustomerCode: 'C1', CustomerName: 'Acme' },
    { CustomerId: 3, total: 60.0, CustomerCode: 'C2', CustomerName: 'Beta' },
  ];
  assert.equal(compareResults(goldRanked, actual, { mode: 'rowset' }), true);
});

test('rowset detects a wrong value', () => {
  const actual = [
    { CustomerName: 'Acme', net: 100.0 },
    { CustomerName: 'Beta', net: 61.0 }, // wrong
    { CustomerName: 'Gamma', net: 40.0 },
  ];
  assert.equal(compareResults(goldRanked, actual, { mode: 'rowset' }), false);
});

test('rowset detects wrong row count (e.g. missing DISTINCT / wrong LIMIT)', () => {
  const actual = [...goldRanked, { CustomerName: 'Delta', total_net_amount: 10.0 }];
  assert.equal(compareResults(goldRanked, actual, { mode: 'rowset' }), false);
});

test('rowset does not mismatch labels to the wrong values', () => {
  // Same value-multisets per column, but labels paired with the wrong numbers.
  const actual = [
    { CustomerName: 'Acme', net: 60.0 },
    { CustomerName: 'Beta', net: 100.0 },
    { CustomerName: 'Gamma', net: 40.0 },
  ];
  assert.equal(compareResults(goldRanked, actual, { mode: 'rowset' }), false);
});

test('scalar is alias-insensitive', () => {
  const gold = [{ active_customer_count: 27 }];
  assert.equal(compareResults(gold, [{ n: 27 }], { mode: 'scalar' }), true);
  assert.equal(compareResults(gold, [{ n: 26 }], { mode: 'scalar' }), false);
  assert.equal(compareResults(gold, [{ n: 27 }, { n: 1 }], { mode: 'scalar' }), false);
});

test('ranked passes correct order and fails reversed order', () => {
  const correct = [
    { name: 'Acme', v: 100.0 },
    { name: 'Beta', v: 60.0 },
    { name: 'Gamma', v: 40.0 },
  ];
  const reversed = [
    { name: 'Gamma', v: 40.0 },
    { name: 'Beta', v: 60.0 },
    { name: 'Acme', v: 100.0 },
  ];
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['total_net_amount'] };
  assert.equal(compareResults(goldRanked, correct, spec), true);
  assert.equal(compareResults(goldRanked, reversed, spec), false);
});

test('ranked tolerates tie reordering within equal values', () => {
  const goldTies = [
    { name: 'A', v: 100.0 },
    { name: 'B', v: 50.0 },
    { name: 'C', v: 50.0 },
  ];
  const tieSwapped = [
    { label: 'A', metric: 100.0 },
    { label: 'C', metric: 50.0 },
    { label: 'B', metric: 50.0 },
  ];
  assert.equal(
    compareResults(goldTies, tieSwapped, { mode: 'ranked', order: 'desc', value_columns: ['v'] }),
    true
  );
});

test('numeric DECIMAL-as-string values compare equal to numbers', () => {
  const gold = [{ code: '4001', total_debit: 1234.56 }];
  const actual = [{ AccountCode: 4001, debit: '1234.560000' }];
  assert.equal(compareResults(gold, actual, { mode: 'rowset' }), true);
});

test('numeric tolerance is honored', () => {
  const gold = [{ x: 'a', total: 100.0 }];
  assert.equal(compareResults(gold, [{ x: 'a', total: 100.4 }], { mode: 'rowset', tolerance: 1 }), true);
  assert.equal(compareResults(gold, [{ x: 'a', total: 102.0 }], { mode: 'rowset', tolerance: 1 }), false);
});

test('empty result sets compare equal; gold-empty vs non-empty fails', () => {
  assert.equal(compareResults([], [], { mode: 'rowset' }), true);
  assert.equal(compareResults([], [{ x: 1 }], { mode: 'rowset' }), false);
});

test('compare_columns restricts comparison to declared gold columns', () => {
  // Gold carries a helper column we do not want to compare on.
  const gold = [{ ProductName: 'Sugar', total_qty: 5, helper: 'ignore-me' }];
  const actual = [{ ProductName: 'Sugar', total_qty: 5 }];
  assert.equal(compareResults(gold, actual, { mode: 'rowset', compare_columns: ['ProductName', 'total_qty'] }), true);
});

test('tolerance is a true absolute difference, not a rounding bucket', () => {
  const gold = [{ x: 'a', total: 100.5 }];
  // Within tolerance but on opposite sides of an integer bucket boundary.
  assert.equal(compareResults(gold, [{ x: 'a', total: 99.6 }], { mode: 'rowset', tolerance: 1 }), true);
  assert.equal(compareResults(gold, [{ x: 'a', total: 101.4 }], { mode: 'rowset', tolerance: 1 }), true);
  assert.equal(compareResults(gold, [{ x: 'a', total: 102.0 }], { mode: 'rowset', tolerance: 1 }), false);
});

test('default rounding is 2dp, so model extra precision over gold ROUND(...,2) matches', () => {
  const gold = [{ x: 'a', total: 1234.56 }];
  assert.equal(compareResults(gold, [{ x: 'a', total: 1234.564 }], { mode: 'rowset' }), true);
  assert.equal(compareResults(gold, [{ x: 'a', total: 1234.56499 }], { mode: 'rowset' }), true);
  assert.equal(compareResults(gold, [{ x: 'a', total: 1234.57 }], { mode: 'rowset' }), false);
});

test('ranked: a NULL metric must not reset monotonicity mid-sequence', () => {
  const gold = [
    { name: 'a', v: 5000 },
    { name: 'b', v: 1000 },
    { name: 'c', v: 800 },
    { name: 'd', v: null },
  ];
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['v'] };
  // Correctly sorted with the NULL trailing -> passes.
  assert.equal(compareResults(gold, gold, spec), true);
  // Same value multiset, but a NULL sits between values that then jump back up.
  const interrupted = [
    { name: 'b', v: 1000 },
    { name: 'd', v: null },
    { name: 'a', v: 5000 },
    { name: 'c', v: 800 },
  ];
  assert.equal(compareResults(gold, interrupted, spec), false);
});

test('ranked: a null_as_zero metric is ranked as 0, as it is matched', () => {
  const gold = [
    { name: 'A', v: 10 },
    { name: 'C', v: 5 },
    { name: 'B', v: 0 },
  ];
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['v'], null_as_zero: ['v'] };
  // B's NULL matches the gold's 0, so it ranks as 0 too: 10, 0, 5 is not descending.
  const misordered = [
    { name: 'A', v: 10 },
    { name: 'B', v: null },
    { name: 'C', v: 5 },
  ];
  assert.deepEqual(
    [compareResultsDetailed(gold, misordered, spec).match, compareResultsDetailed(gold, misordered, spec).reason],
    [false, 'ranking']
  );
  // The same NULL in the 0's place is a correct ranking.
  assert.equal(compareResults(gold, [misordered[0], misordered[2], misordered[1]], spec), true);
  // Ascending: the NULL (MariaDB sorts NULL first) ranks as 0, ahead of 5 and 10.
  const ascending = { ...spec, order: 'asc' };
  assert.equal(compareResults([...gold].reverse(), [misordered[1], misordered[2], misordered[0]], ascending), true);
  // Without null_as_zero a NULL is not a ranking value: it is not 0 either, so
  // the values do not match in the first place.
  const strict = { mode: 'ranked', order: 'desc', value_columns: ['v'] };
  assert.equal(compareResultsDetailed(gold, misordered, strict).reason, 'values');
});

test('ranked: ranking values compare as the cells match, rounded to decimals (or within the tolerance)', () => {
  const gold = [
    { name: 'A', v: 5 },
    { name: 'B', v: 0 },
    { name: 'C', v: 0 },
  ];
  const spec = { mode: 'ranked', order: 'desc', value_columns: ['v'], null_as_zero: ['v'] };
  // NULL and 0.004 both match the gold's 0 at two decimals: a tie, not a
  // misordering, in either order.
  for (const tail of [[null, 0.004], [0.004, null]]) {
    const actual = [{ name: 'A', v: 5 }, { name: 'B', v: tail[0] }, { name: 'C', v: tail[1] }];
    assert.deepEqual([compareResultsDetailed(gold, actual, spec).match, compareResultsDetailed(gold, actual, spec).reason], [true, 'match'], JSON.stringify(tail));
  }
  // Without null_as_zero: 0.001 then 0.004 is the same tie.
  const strict = { mode: 'ranked', order: 'desc', value_columns: ['v'] };
  assert.equal(compareResults(gold, [{ name: 'A', v: 5 }, { name: 'B', v: 0.001 }, { name: 'C', v: 0.004 }], strict), true);
  // Ascending, the same.
  assert.equal(compareResults([...gold].reverse(), [{ name: 'C', v: 0.004 }, { name: 'B', v: null }, { name: 'A', v: 5 }], { ...spec, order: 'asc' }), true);
  // Values that differ after rounding still have to be ranked.
  const distinct = [
    { name: 'A', v: 5 },
    { name: 'B', v: 0.01 },
    { name: 'C', v: 0 },
  ];
  assert.equal(compareResultsDetailed(distinct, [distinct[0], distinct[2], distinct[1]], strict).reason, 'ranking');
  // With decimals: 3, 0.004 is not 0.
  assert.equal(compareResultsDetailed(gold, [{ name: 'A', v: 5 }, { name: 'B', v: null }, { name: 'C', v: 0.004 }], { ...spec, decimals: 3 }).reason, 'values');
  // With a tolerance, values within it tie (as they match).
  assert.equal(compareResults(gold, [{ name: 'A', v: 5 }, { name: 'B', v: null }, { name: 'C', v: 0.004 }], { ...spec, tolerance: 0.005 }), true);
});

// Behavior change (EVAL-1 / ORACLE-10): signal checks and the disallowed-column
// lint used to turn a value match into 'low_signal_success' /
// 'disallowed_column_used' failures. Only values decide now; both are warnings.
test('classifyBenchmarkStatus: a value match is a pass; signal and lint findings are warnings', () => {
  const base = { rowsMatch: true, signalCheckResult: { passed: true }, expectedTables: ['A'], retrievedTables: ['A'] };
  assert.equal(classifyBenchmarkStatus(base), 'pass');
  assert.equal(classifyBenchmarkStatus({ ...base, disallowedColumnsUsed: ['NetPayableAmount'] }), 'pass');
  assert.equal(classifyBenchmarkStatus({ ...base, signalCheckResult: { passed: false } }), 'pass');
  assert.equal(
    classifyBenchmarkStatus({ rowsMatch: false, expectedTables: ['A', 'B'], retrievedTables: ['A'] }),
    'retrieval_miss'
  );
  assert.equal(classifyBenchmarkStatus({ rowsMatch: false, expectedTables: ['A'], retrievedTables: ['A'] }), 'result_mismatch');

  assert.deepEqual(collectBenchmarkWarnings({ rowsMatch: true, signalWarnings: [{ code: 'min_row_count' }] }), ['low_signal_success']);
  assert.deepEqual(collectBenchmarkWarnings({ rowsMatch: true, disallowedColumnsUsed: ['NetPayableAmount'] }), ['disallowed_column_used']);
  assert.deepEqual(collectBenchmarkWarnings({ rowsMatch: false, signalWarnings: [{ code: 'x' }] }), []);
});

// --- compareResultsDetailed -------------------------------------------------

test('compareResultsDetailed returns the gold -> prediction column assignment and a reason', () => {
  const actual = [
    { customer: 'Acme', revenue: 100.0 },
    { customer: 'Beta', revenue: 60.0 },
    { customer: 'Gamma', revenue: 40.0 },
  ];
  const detailed = compareResultsDetailed(goldRanked, actual, { mode: 'ranked', value_columns: ['total_net_amount'] });
  assert.deepEqual(detailed, {
    match: true,
    assignment: { CustomerName: 'customer', total_net_amount: 'revenue' },
    reason: 'match',
  });

  assert.equal(compareResultsDetailed(goldRanked, actual.slice(0, 2), { mode: 'rowset' }).reason, 'row_count');
  assert.equal(compareResultsDetailed(goldRanked, [{ x: 1 }, { x: 2 }, { x: 3 }], { mode: 'rowset' }).reason, 'missing_columns');
  const wrong = compareResultsDetailed(goldRanked, actual.map((row) => ({ ...row, revenue: row.revenue + 1 })), { mode: 'rowset' });
  assert.deepEqual(wrong, { match: false, assignment: null, reason: 'values' });
  assert.equal(compareResultsDetailed(goldRanked, [...actual].reverse(), { mode: 'ranked', value_columns: ['total_net_amount'] }).reason, 'ranking');
  assert.deepEqual(compareResultsDetailed([], [], { mode: 'rowset' }), { match: true, assignment: {}, reason: 'match' });
});

test('compareResults stays the boolean view of compareResultsDetailed', () => {
  const actual = [{ n: 27 }];
  assert.equal(compareResults([{ active_customer_count: 27 }], actual, { mode: 'scalar' }), true);
  assert.equal(compareResultsDetailed([{ active_customer_count: 27 }], actual, { mode: 'scalar' }).match, true);
});

test('legacy mode (no comparison spec) reports a name-based assignment', () => {
  const gold = [{ CustomerName: 'Acme', total: 1 }];
  assert.deepEqual(compareResultsDetailed(gold, [{ customername: 'Acme', TOTAL: 1 }], null), {
    match: true,
    assignment: { CustomerName: 'customername', total: 'TOTAL' },
    reason: 'match',
  });
  assert.equal(compareResultsDetailed(gold, [{ CustomerName: 'Acme', net: 1 }], null).match, false);
});

// (a) DATE values: mysql2 returns DATE/DATETIME columns as local-time Dates.
test('Date objects and date strings normalize to one canonical value', () => {
  assert.equal(canonicalTemporalValue(new Date(2026, 2, 1)), '2026-03-01');
  assert.equal(canonicalTemporalValue(new Date(2026, 2, 1, 13, 5, 9)), '2026-03-01 13:05:09');
  assert.equal(canonicalTemporalValue(new Date(2026, 2, 1, 0, 0, 0, 250)), '2026-03-01 00:00:00.25');
  assert.equal(canonicalTemporalValue('2026-03-01'), '2026-03-01');
  assert.equal(canonicalTemporalValue('2026-03-01 00:00:00'), '2026-03-01');
  assert.equal(canonicalTemporalValue('2026-03-01T13:05:09.000'), '2026-03-01 13:05:09');
  assert.equal(canonicalTemporalValue(new Date(2026, 2, 1, 13).toISOString()), '2026-03-01 13:00:00');
  assert.equal(canonicalTemporalValue('2026-03'), null, 'a year-month label is text');
  assert.equal(canonicalTemporalValue('2026-13-01'), null);
  assert.equal(canonicalTemporalValue(20260301), null);

  const gold = [{ DocumentDate: new Date(2026, 2, 31), document_count: 2 }];
  assert.equal(compareResults(gold, [{ day: '2026-03-31', n: 2 }], { mode: 'rowset' }), true);
  assert.equal(compareResults(gold, [{ day: '2026-03-31 00:00:00', n: 2 }], { mode: 'rowset' }), true);
  assert.equal(compareResults(gold, [{ day: new Date(2026, 2, 31), n: 2 }], { mode: 'rowset' }), true);
  assert.equal(compareResults(gold, [{ day: '2026-04-01', n: 2 }], { mode: 'rowset' }), false);
  // A datetime with a real time of day is not the date.
  assert.equal(compareResults(gold, [{ day: '2026-03-31 08:00:00', n: 2 }], { mode: 'rowset' }), false);
  // Dates are not numbers any more: an epoch number never equals a DATE.
  assert.equal(compareResults(gold, [{ day: new Date(2026, 2, 31).getTime(), n: 2 }], { mode: 'rowset' }), false);
});

// (b) Ranked default value_columns: only truly numeric gold columns.
test('ranked mode ignores numeric-looking code strings when picking the ranking column', () => {
  // Correct prediction ranked by total; AccountCode happens to ascend.
  const gold = [
    { AccountCode: '1100', AccountName: 'Accounts Receivable', total_debit: 2450 },
    { AccountCode: '4000', AccountName: 'Sales Revenue', total_debit: 10 },
  ];
  const actual = [
    { code: '1100', name: 'Accounts Receivable', debit: 2450 },
    { code: '4000', name: 'Sales Revenue', debit: 10 },
  ];
  assert.equal(compareResults(gold, actual, { mode: 'ranked', order: 'desc' }), true);
  // ...and a prediction sorted the wrong way by the metric still fails.
  assert.equal(compareResults(gold, [...actual].reverse(), { mode: 'ranked', order: 'desc' }), false);
});

// (c) column_order: values cannot tell jan from feb; names or position can.
test('column_order rejects swapped month columns (edge_public_008 m2)', () => {
  const gold = [
    { CustomerName: 'North District Market', jan_net_amount: 0, feb_net_amount: 700 },
    { CustomerName: 'Summit Grocers', jan_net_amount: 450, feb_net_amount: 0 },
    { CustomerName: 'Valley Corner Shop', jan_net_amount: 0, feb_net_amount: 300 },
  ];
  const swapped = gold.map((row) => ({
    CustomerName: row.CustomerName,
    jan_net_amount: row.feb_net_amount,
    feb_net_amount: row.jan_net_amount,
  }));
  const renamed = gold.map((row) => ({ customer: row.CustomerName, january: row.jan_net_amount, february: row.feb_net_amount }));
  const spec = { mode: 'rowset', compare_columns: ['CustomerName', 'jan_net_amount', 'feb_net_amount'] };
  const ordered = { ...spec, column_order: ['jan_net_amount', 'feb_net_amount'] };

  // Gold-named columns holding the other month's values fail on their names
  // alone (name pinning), with or without column_order.
  assert.deepEqual(compareResultsDetailed(gold, swapped, spec), { match: false, assignment: null, reason: 'values' });
  assert.deepEqual(compareResultsDetailed(gold, swapped, ordered), { match: false, assignment: null, reason: 'values' });

  // Unrelated names: position decides.
  const renamedSwapped = gold.map((row) => ({ customer: row.CustomerName, february: row.feb_net_amount, january: row.jan_net_amount }));
  assert.equal(compareResults(gold, renamedSwapped, spec), true, 'without column_order the positional swap is invisible');
  assert.deepEqual(compareResultsDetailed(gold, renamedSwapped, ordered), { match: false, assignment: null, reason: 'column_order' });
  assert.equal(compareResults(gold, renamed, ordered), true, 'aliases are still free');
  assert.equal(
    compareResults(gold, renamed.map(({ customer, january, february }) => ({ january, customer, february })), ordered),
    true,
    'unlisted columns may move'
  );

  // A carrier named like its gold column identifies itself, so a correctly
  // labeled February-first pivot passes...
  const februaryFirst = gold.map((row) => ({ CustomerName: row.CustomerName, feb_net_amount: row.feb_net_amount, jan_net_amount: row.jan_net_amount }));
  assert.equal(compareResults(gold, februaryFirst, ordered), true);
  // ...and a carrier named like the OTHER listed column is rejected.
  const mislabeled = gold.map((row) => ({ customer: row.CustomerName, total_feb_net_amount: row.jan_net_amount, total_jan_net_amount: row.feb_net_amount }));
  assert.equal(compareResultsDetailed(gold, mislabeled, ordered).reason, 'column_order');
  // Known limit: names unlike any listed column in the gold's positions are
  // judged by position only, so a label-only swap of them still passes.
  const labelOnlySwap = gold.map((row) => ({ customer: row.CustomerName, february: row.jan_net_amount, january: row.feb_net_amount }));
  assert.equal(compareResults(gold, labelOnlySwap, ordered), true);

  // When the two months carry identical values the order is unobservable, so
  // some order-preserving assignment always exists.
  const tied = [{ CustomerName: 'A', jan_net_amount: 5, feb_net_amount: 5 }];
  assert.equal(compareResults(tied, [{ c: 'A', feb: 5, jan: 5 }], ordered), true);
});

test('name pinning: a gold-named prediction column must carry that gold column', () => {
  const gold = [
    { CustomerName: 'A', total_net_amount: 100 },
    { CustomerName: 'B', total_net_amount: 60 },
  ];
  const spec = { mode: 'ranked', value_columns: ['total_net_amount'] };
  // H07: the gold-named column holds NetPayable, the real net sits in an extra column.
  const hedge = [
    { CustomerName: 'A', total_net_amount: 112.5, net_amount_excl_fees: 100 },
    { CustomerName: 'B', total_net_amount: 72.5, net_amount_excl_fees: 60 },
  ];
  assert.deepEqual(compareResultsDetailed(gold, hedge, spec), { match: false, assignment: null, reason: 'values' });
  // The same numbers under names that are not the gold's still pass (aliases are free).
  const aliased = hedge.map((row) => ({ customer: row.CustomerName, net_payable: row.total_net_amount, revenue: row.net_amount_excl_fees }));
  assert.deepEqual(compareResultsDetailed(gold, aliased, spec).assignment, { CustomerName: 'customer', total_net_amount: 'revenue' });
  // Case and punctuation do not matter for the pin.
  assert.equal(compareResults(gold, hedge.map((row) => ({ customer: row.CustomerName, TotalNetAmount: row.total_net_amount, x: row.net_amount_excl_fees })), spec), false);
  // A pinned column carries no other gold column: swapped labels fail.
  const twoMetrics = [{ AccountCode: '1100', total_debit: 10, total_credit: 3 }];
  assert.equal(compareResults(twoMetrics, [{ AccountCode: '1100', total_debit: 3, total_credit: 10 }], { mode: 'rowset' }), false);
  assert.equal(compareResults(twoMetrics, [{ AccountCode: '1100', debit: 10, credit: 3 }], { mode: 'rowset' }), true);
  // Two prediction columns with the same normalized name: no pin.
  assert.equal(compareResults([{ total: 5 }], [{ Total: 4, total_: 5 }], { mode: 'rowset' }), true);
});

test('null_as_zero reads NULL as 0 in the listed columns only', () => {
  const gold = [
    { CustomerName: 'A', jan_net_amount: 0, feb_net_amount: 700 },
    { CustomerName: 'B', jan_net_amount: 450, feb_net_amount: 0 },
  ];
  // SUM(CASE WHEN ... THEN NetAmount END) without ELSE 0: NULL for a month with no sales.
  const withNulls = [
    { CustomerName: 'A', jan_net_amount: null, feb_net_amount: 700 },
    { CustomerName: 'B', jan_net_amount: 450, feb_net_amount: null },
  ];
  const spec = { mode: 'rowset', compare_columns: ['CustomerName', 'jan_net_amount', 'feb_net_amount'], column_order: ['jan_net_amount', 'feb_net_amount'] };
  assert.equal(compareResults(gold, withNulls, spec), false, 'NULL is not 0 by default');
  const lenient = { ...spec, null_as_zero: ['jan_net_amount', 'feb_net_amount'] };
  assert.equal(compareResults(gold, withNulls, lenient), true);
  assert.equal(compareResults(withNulls, gold, lenient), true, 'either side may hold the NULL');
  // A wrong value is still wrong, and unlisted columns keep NULL != 0.
  assert.equal(compareResults(gold, withNulls.map((row) => ({ ...row, feb_net_amount: row.feb_net_amount && row.feb_net_amount + 1 })), lenient), false);
  assert.equal(compareResults([{ name: null, v: 1 }], [{ name: 0, v: 1 }], { mode: 'rowset', null_as_zero: ['v'] }), false);
});

// (d) tolerance: rounding placement legitimately differs on sub-cent lines.
test('tolerance absorbs per-row vs per-aggregate rounding but not a wrong measure', () => {
  // ROUND(SUM(x), 2) over 129.935 + 43.005 = 172.94; SUM(ROUND(x, 2)) = 172.95.
  const gold = [{ CategoryName: 'Beverages', total_net_amount: 172.94 }];
  const perLine = [{ CategoryName: 'Beverages', total_net_amount: 172.95 }];
  const spec = { mode: 'ranked', value_columns: ['total_net_amount'] };
  assert.equal(compareResults(gold, perLine, spec), false, 'exact 2-decimal equality rejects it');
  assert.equal(compareResults(gold, perLine, { ...spec, tolerance: 0.01 }), true);
  // Line TotalAmount (Net x 1.05) is far outside the tolerance.
  assert.equal(compareResults(gold, [{ CategoryName: 'Beverages', total_net_amount: 181.59 }], { ...spec, tolerance: 0.01 }), false);
  // ROUND(..., 0) of a fractional amount is outside it too.
  assert.equal(compareResults([{ v: 129.94 }], [{ v: 130 }], { mode: 'scalar', tolerance: 0.01 }), false);
});

test('tolerance keeps working when the prediction has many extra columns', () => {
  const gold = [
    { name: 'a', amount: 10.0, qty: 1 },
    { name: 'b', amount: 20.0, qty: 2 },
  ];
  const actual = [
    { id: 1, code: 'A', name: 'a', amount: 10.004, qty: 1, extra1: 7, extra2: 9, extra3: 'x' },
    { id: 2, code: 'B', name: 'b', amount: 19.996, qty: 2, extra1: 8, extra2: 9, extra3: 'y' },
  ];
  assert.equal(compareResults(gold, actual, { mode: 'rowset', tolerance: 0.01 }), true);
});

// With a tolerance, row matching is a perfect matching in the "within
// tolerance" graph. It used to be backtracking with a 500000-step cap whose
// cut-off read as 'values': near-duplicate rows in an unlucky order made a
// correct prediction fail (and a negative control count as killed).
test('tolerance row matching finds a valid pairing among near-duplicate rows, with no step cap', () => {
  const spec = { mode: 'rowset', tolerance: 0.01, compare_columns: ['m'] };
  const gold = [...Array.from({ length: 9 }, () => ({ m: 1.0 })), { m: 1.016 }];
  const predicted = [{ m: 1.008 }, ...Array.from({ length: 9 }, () => ({ m: 1.0 }))];
  assert.deepEqual(
    (({ match, reason, truncated }) => ({ match, reason, truncated }))(matchResultSets(gold, predicted, spec)),
    { match: true, reason: 'match', truncated: false }
  );
  // Larger: 400 rows, still exact and quick.
  const bigGold = [...Array.from({ length: 399 }, () => ({ m: 1.0 })), { m: 1.016 }];
  const bigPredicted = [{ m: 1.008 }, ...Array.from({ length: 399 }, () => ({ m: 1.0 }))];
  assert.equal(compareResults(bigGold, bigPredicted, spec), true);
  // A row with no partner within the tolerance still fails.
  assert.equal(compareResults(gold, [{ m: 1.03 }, ...Array.from({ length: 9 }, () => ({ m: 1.0 }))], spec), false);
});

test('tolerance row matching agrees with a brute-force search over row pairings', () => {
  // Deterministic PRNG; small tables so every permutation can be checked.
  let state = 12345;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const values = [1.0, 1.005, 1.01, 1.016, 1.02];
  const labels = ['a', 'b'];
  const row = () => ({ v: values[Math.floor(random() * values.length)], k: labels[Math.floor(random() * labels.length)] });
  const within = (g, p) => g.k === p.k && Math.abs(g.v - p.v) <= 0.01 + 1e-9;
  const bruteForce = (gold, predicted, used = new Array(predicted.length).fill(false), index = 0) =>
    index === gold.length ||
    predicted.some((candidate, j) => {
      if (used[j] || !within(gold[index], candidate)) {
        return false;
      }
      used[j] = true;
      const found = bruteForce(gold, predicted, used, index + 1);
      used[j] = false;
      return found;
    });
  const outcomes = { true: 0, false: 0 };
  for (let trial = 0; trial < 400; trial += 1) {
    const size = 1 + Math.floor(random() * 6);
    const gold = Array.from({ length: size }, row);
    const predicted = Array.from({ length: size }, row);
    const expected = bruteForce(gold, predicted);
    outcomes[expected] += 1;
    assert.equal(compareResults(gold, predicted, { mode: 'rowset', tolerance: 0.01 }), expected, JSON.stringify({ gold, predicted }));
  }
  assert.ok(outcomes.true > 20 && outcomes.false > 20, JSON.stringify(outcomes));
});

// (e) Scalar rule: an incidental extra column cannot carry the gold value.
test('scalar: a multi-column prediction passes only through its only column, only numeric column, or a like-named column', () => {
  const gold = [{ product_count: 1 }];
  const spec = { mode: 'scalar' };
  // ORACLE-7: the headline column is wrong, an extra column equals the gold.
  assert.deepEqual(compareResultsDetailed(gold, [{ product_count: 4, feb_products: 1 }], spec), {
    match: false,
    assignment: null,
    reason: 'values',
  });
  assert.deepEqual(compareResultsDetailed(gold, [{ products: 4, feb_products: 1 }], spec), {
    match: false,
    assignment: null,
    reason: 'scalar_column',
  });
  assert.equal(compareResults([{ active_customer_count: 5 }], [{ active_customer_count: 6, with_sales: 5 }], spec), false);
  assert.equal(compareResults([{ document_count: 3 }], [{ document_count: 4, canceled_docs: 1, without_postings_lines: 3 }], spec), false);

  // The column named exactly like the gold is the only one that may carry it,
  // even when a longer name containing the gold name holds the gold value.
  assert.equal(compareResults([{ active_customer_count: 1 }], [{ active_customer_count: 7, inactive_customer_count: 1 }], spec), false);
  assert.equal(compareResults(gold, [{ product_count: 4, feb_product_count: 1 }], spec), false);
  assert.equal(compareResults([{ document_count: 3 }], [{ document_count: 4, canceled_document_count: 3 }], spec), false);
  assert.equal(compareResults([{ document_count: 3 }], [{ document_count: 4, non_canceled_document_count: 3 }], spec), false);
  // Word boundaries and negations: inactive_* is not active_*, non_canceled_* is not canceled_*.
  assert.equal(compareResults([{ active_customer_count: 2 }], [{ customer_count: 8, inactive_customer_count: 2 }], spec), false);
  assert.equal(compareResults([{ canceled_count: 2 }], [{ total: 9, non_canceled_count: 2 }], spec), false);
  // The like-named column must be the only one (a hedge with two readings fails either way).
  assert.equal(compareResults([{ document_count: 3 }], [{ posted_document_count: 3, dated_document_count: 5 }], spec), false);
  assert.equal(compareResults([{ document_count: 3 }], [{ posted_document_count: 5, dated_document_count: 3 }], spec), false);

  // Only column / only numeric column / named like the gold.
  assert.equal(compareResults(gold, [{ n: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ label: 'Feb but not March', n: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ total_products: 12, product_count: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ products: 12, feb_only_product_count: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ products: 12, ProductCount: 1 }], spec), true);
  assert.equal(compareResults([{ document_count: 3 }], [{ posted_document_count: 3, net_amount: 120.5 }], spec), true);
  assert.equal(compareResults([{ document_count: 3 }], [{ document_count: 3, net_amount: 120.5 }], spec), true);
  // A text label does not make a second number acceptable.
  assert.equal(compareResults(gold, [{ label: 'x', all_products: 12, feb_products: 1 }], spec), false);
  // Known false negative: a correct answer plus an unrelated numeric column.
  assert.equal(compareResults([{ total_net_amount: 1400 }], [{ urban_refresh_net_sales: 1400, line_count: 3 }], spec), false);

  assert.equal(isColumnNamedLike('document_count', 'posted_document_count'), true);
  assert.equal(isColumnNamedLike('document_count', 'DocumentCount'), true);
  assert.equal(isColumnNamedLike('document_count', 'postedDocumentCount'), true);
  assert.equal(isColumnNamedLike('document_count', 'non_canceled_document_count'), true);
  assert.equal(isColumnNamedLike('product_count', 'feb_products'), false);
  assert.equal(isColumnNamedLike('document_count', 'count'), false);
  assert.equal(isColumnNamedLike('active_customer_count', 'inactive_customer_count'), false);
  assert.equal(isColumnNamedLike('canceled_count', 'non_canceled_count'), false);
  assert.equal(isColumnNamedLike('canceled_count', 'not_canceled_count'), false);
  assert.equal(isColumnNamedLike('feb_net_amount', 'total_feb_net_amount'), true);
});

test('scalar rule only applies to a single gold value', () => {
  // A one-row, two-column gold compares like a rowset: extra columns are fine.
  const gold = [{ CampaignName: 'Urban Refresh', total_net_amount: 1400 }];
  assert.equal(
    compareResults(gold, [{ CampaignName: 'Urban Refresh', lines: 3, total_net_amount: 1400 }], { mode: 'scalar' }),
    true
  );
});

test('matchResultSets enumerates every valid assignment for cross-fixture consistency', () => {
  const gold = [{ jan: 5, feb: 5 }];
  const outcome = matchResultSets(gold, [{ a: 5, b: 5 }], { mode: 'rowset' });
  assert.equal(outcome.match, true);
  assert.deepEqual(outcome.assignments, [
    ['a', 'b'],
    ['b', 'a'],
  ]);
  assert.equal(matchResultSets([], [], { mode: 'rowset' }).empty, true);
});

// Columns p1..pN whose values are given per row.
const columnsOf = (rowsOfValues) => rowsOfValues.map((values) => Object.fromEntries(values.map((value, index) => [`p${index + 1}`, value])));
const goldOf = (rowsOfValues) => rowsOfValues.map((values) => Object.fromEntries(values.map((value, index) => [`m${index + 1}`, value])));

test('findSharedAssignment: one mapping must hold on every pair, however many each pair allows', () => {
  // 5! = 120 mappings on the first pair (more than any enumeration cap); the
  // second and third each allow exactly one, and they differ.
  const pairs = [
    { expected: goldOf([[1, 1, 1, 1, 1]]), actual: columnsOf([[1, 1, 1, 1, 1]]) },
    { expected: goldOf([[1, 2, 3, 4, 5]]), actual: columnsOf([[1, 2, 3, 4, 5]]) },
    { expected: goldOf([[1, 2, 3, 4, 5]]), actual: columnsOf([[2, 1, 3, 4, 5]]) },
  ];
  assert.equal(matchResultSets(pairs[0].expected, pairs[0].actual, { mode: 'rowset' }).truncated, true);
  assert.deepEqual(findSharedAssignment(pairs, { mode: 'rowset' }), {
    match: false,
    goldColumns: ['m1', 'm2', 'm3', 'm4', 'm5'],
    assignment: null,
    reason: 'inconsistent_assignment',
  });

  // Drop the conflicting pair: the one mapping both remaining pairs allow.
  const shared = findSharedAssignment(pairs.slice(0, 2), { mode: 'rowset' });
  assert.deepEqual([shared.match, shared.assignment, shared.reason], [true, ['p1', 'p2', 'p3', 'p4', 'p5'], 'match']);

  // A pair of two empty results does not constrain the mapping.
  const withEmpty = findSharedAssignment([...pairs.slice(0, 2), { expected: [], actual: [] }], { mode: 'rowset' });
  assert.deepEqual(withEmpty.assignment, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(findSharedAssignment([{ expected: [], actual: [] }], { mode: 'rowset' }).assignment, []);

  // A pair that cannot match at all reports its own reason.
  assert.equal(findSharedAssignment([pairs[1], { expected: goldOf([[1, 2, 3, 4, 5]]), actual: [] }], { mode: 'rowset' }).reason, 'row_count');
});

test('findSharedAssignment checks the whole assignment (column order, ranking) on every pair', () => {
  // Values allow either carrier on both pairs, but column_order rules out the
  // swapped one on the second: the shared mapping is the in-order one.
  const comparison = { mode: 'rowset', column_order: ['m1', 'm2'] };
  const pairs = [
    { expected: goldOf([[5, 5]]), actual: columnsOf([[5, 5]]) },
    { expected: goldOf([[1, 2]]), actual: columnsOf([[1, 2]]) },
  ];
  assert.deepEqual(findSharedAssignment(pairs, comparison).assignment, ['p1', 'p2']);
  const swapped = [pairs[0], { expected: goldOf([[1, 2]]), actual: columnsOf([[2, 1]]) }];
  assert.equal(findSharedAssignment(swapped, comparison).match, false);
  assert.equal(findSharedAssignment(swapped, comparison).reason, 'inconsistent_assignment');
});

test('findSharedAssignment fails closed when its search is cut off', () => {
  const pairs = [
    { expected: goldOf([[1, 1, 1, 1, 1]]), actual: columnsOf([[1, 1, 1, 1, 1]]) },
    { expected: goldOf([[1, 2, 3, 4, 5]]), actual: columnsOf([[5, 4, 3, 2, 1]]) },
  ];
  assert.equal(findSharedAssignment(pairs, { mode: 'rowset' }).match, true);
  const cut = findSharedAssignment(pairs, { mode: 'rowset' }, { maxSteps: 3 });
  assert.deepEqual([cut.match, cut.assignment, cut.reason], [false, null, 'assignment_search_exhausted']);
});

test('findSharedAssignment without a comparison spec compares the legacy name mapping', () => {
  const pairs = [
    { expected: [{ n: 1 }], actual: [{ N: 1 }] },
    { expected: [{ n: 2 }], actual: [{ N: 2 }] },
  ];
  assert.deepEqual(findSharedAssignment(pairs, null), { match: true, goldColumns: ['n'], assignment: ['N'], reason: 'match' });
  assert.equal(findSharedAssignment([pairs[0], { expected: [{ n: 2 }], actual: [{ n: 3 }] }], null).reason, 'values');
});

test('matchResultSets: a search stopped by its step bound before any match says so', () => {
  // Three rows; every prediction column holds {0, 0, 1} like each gold column,
  // in one of three row patterns, four columns each. The five gold columns
  // need five columns with one pattern, which do not exist, and the search
  // stops at its step bound before it has tried every assignment.
  const patterns = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];
  const actual = [0, 1, 2].map((row) => Object.fromEntries(Array.from({ length: 12 }, (_unused, index) => [`p${index + 1}`, patterns[index % 3][row]])));
  const expected = [0, 1, 2].map((row) => Object.fromEntries(Array.from({ length: 5 }, (_unused, index) => [`m${index + 1}`, patterns[0][row]])));
  const outcome = matchResultSets(expected, actual, { mode: 'rowset' });
  assert.deepEqual([outcome.match, outcome.reason, outcome.truncated], [false, 'assignment_search_exhausted', true]);
});
