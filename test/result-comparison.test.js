import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalTemporalValue,
  classifyBenchmarkStatus,
  collectBenchmarkWarnings,
  compareResults,
  compareResultsDetailed,
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

// (c) column_order: values cannot tell jan from feb; position can.
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

  // Without column_order the swap passes on any data (the old blind spot).
  assert.equal(compareResults(gold, swapped, spec), true);

  const ordered = { ...spec, column_order: ['jan_net_amount', 'feb_net_amount'] };
  assert.deepEqual(compareResultsDetailed(gold, swapped, ordered), { match: false, assignment: null, reason: 'column_order' });
  assert.equal(compareResults(gold, renamed, ordered), true, 'aliases are still free');
  assert.equal(
    compareResults(gold, renamed.map(({ customer, january, february }) => ({ january, customer, february })), ordered),
    true,
    'unlisted columns may move'
  );
  // When the two months carry identical values the order is unobservable, so
  // some order-preserving assignment always exists.
  const tied = [{ CustomerName: 'A', jan_net_amount: 5, feb_net_amount: 5 }];
  assert.equal(compareResults(tied, [{ c: 'A', feb: 5, jan: 5 }], ordered), true);
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

// (e) Scalar rule: an incidental extra column cannot carry the gold value.
test('scalar: a multi-column prediction passes only through its only column, only numeric column, or a like-named column', () => {
  const gold = [{ product_count: 1 }];
  const spec = { mode: 'scalar' };
  // ORACLE-7: the headline column is wrong, an extra column equals the gold.
  assert.deepEqual(compareResultsDetailed(gold, [{ product_count: 4, feb_products: 1 }], spec), {
    match: false,
    assignment: null,
    reason: 'scalar_column',
  });
  assert.equal(compareResults([{ active_customer_count: 5 }], [{ active_customer_count: 6, with_sales: 5 }], spec), false);
  assert.equal(compareResults([{ document_count: 3 }], [{ document_count: 4, canceled_docs: 1, without_postings_lines: 3 }], spec), false);

  // Only column / only numeric column / named like the gold.
  assert.equal(compareResults(gold, [{ n: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ label: 'Feb but not March', n: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ total_products: 12, product_count: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ products: 12, feb_only_product_count: 1 }], spec), true);
  assert.equal(compareResults(gold, [{ products: 12, ProductCount: 1 }], spec), true);
  // A text label does not make a second number acceptable.
  assert.equal(compareResults(gold, [{ label: 'x', all_products: 12, feb_products: 1 }], spec), false);

  assert.equal(isColumnNamedLike('document_count', 'posted_document_count'), true);
  assert.equal(isColumnNamedLike('document_count', 'DocumentCount'), true);
  assert.equal(isColumnNamedLike('product_count', 'feb_products'), false);
  assert.equal(isColumnNamedLike('document_count', 'count'), false);
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
