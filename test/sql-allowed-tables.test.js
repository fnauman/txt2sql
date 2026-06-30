import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTablesFromSql, validateReadOnlySql } from '../src/pipeline.js';

const ALLOWED = ['Sales', 'Customer'];

// extractTablesFromSql feeds the allowed-table guardrail (layer 1). A single-table
// regex sees only the table immediately after FROM/JOIN, so a comma-joined or
// STRAIGHT_JOINed table would reach the database unchecked. These pin the
// multi-table extraction that closes that gap.
test('extractTablesFromSql captures comma-joined tables', () => {
  assert.deepEqual(extractTablesFromSql('SELECT * FROM Sales, customers'), ['Sales', 'customers']);
});

test('extractTablesFromSql captures three-way comma joins with aliases', () => {
  assert.deepEqual(
    extractTablesFromSql('SELECT * FROM Sales s, customers c, products p WHERE s.id = c.id'),
    ['Sales', 'customers', 'products']
  );
});

test('extractTablesFromSql captures STRAIGHT_JOIN tables', () => {
  assert.deepEqual(
    extractTablesFromSql('SELECT NetAmount FROM Sales STRAIGHT_JOIN customers ON 1 = 1'),
    ['Sales', 'customers']
  );
});

test('extractTablesFromSql still captures explicit and subquery joins', () => {
  assert.deepEqual(
    extractTablesFromSql('SELECT * FROM Sales s LEFT JOIN Customer c ON s.cid = c.id'),
    ['Sales', 'Customer']
  );
  assert.deepEqual(
    extractTablesFromSql('SELECT * FROM (SELECT * FROM secret) sub JOIN Customer ON 1 = 1'),
    ['secret', 'Customer']
  );
});

test('extractTablesFromSql does not treat SELECT-list or WHERE commas as tables', () => {
  assert.deepEqual(extractTablesFromSql('SELECT a, b, c FROM Sales'), ['Sales']);
  assert.deepEqual(extractTablesFromSql("SELECT * FROM Sales WHERE city IN ('a, b', 'c, d')"), ['Sales']);
});

// The allowed-table guardrail must reject any query that pulls in an unlisted
// table via a comma-join or STRAIGHT_JOIN. The demo's MariaDB instance may also
// host sensitive non-demo databases, so allowed-table scoping is a real control,
// not cosmetic.
test('validateReadOnlySql rejects a comma-joined unlisted table', () => {
  assert.throws(
    () => validateReadOnlySql('SELECT * FROM Sales, secret_audit', ALLOWED),
    /outside the allowed table set/
  );
});

test('validateReadOnlySql rejects a STRAIGHT_JOINed unlisted table', () => {
  assert.throws(
    () => validateReadOnlySql('SELECT s.NetAmount FROM Sales STRAIGHT_JOIN secret_audit ON 1 = 1', ALLOWED),
    /outside the allowed table set/
  );
});

test('validateReadOnlySql still accepts a comma-join when every table is allowed', () => {
  const result = validateReadOnlySql('SELECT 1 FROM Sales, Customer LIMIT 5', ALLOWED);
  assert.deepEqual(result.tablesUsed.slice().sort(), ['Customer', 'Sales']);
});
