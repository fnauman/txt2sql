import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyBenchmarkStatus, compareResults } from '../src/benchmark.js';

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

test('classifyBenchmarkStatus flags disallowed columns even when values match', () => {
  const base = { rowsMatch: true, signalCheckResult: { passed: true }, expectedTables: ['A'], retrievedTables: ['A'] };
  assert.equal(classifyBenchmarkStatus(base), 'pass');
  assert.equal(classifyBenchmarkStatus({ ...base, disallowedColumnsUsed: ['NetPayableAmount'] }), 'disallowed_column_used');
  assert.equal(classifyBenchmarkStatus({ ...base, signalCheckResult: { passed: false } }), 'low_signal_success');
  assert.equal(
    classifyBenchmarkStatus({ rowsMatch: false, expectedTables: ['A', 'B'], retrievedTables: ['A'] }),
    'retrieval_miss'
  );
});
