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

// CTE names are query-local: they are not checked against the allow-list (and
// not reported as tables), but the tables inside CTE bodies are. Before the
// tokenizer rewrite every query that selected FROM a CTE was rejected here.
test('extractTablesFromSql excludes CTE names but includes tables inside CTE bodies', () => {
  assert.deepEqual(
    extractTablesFromSql(
      'WITH feb AS (SELECT l.ProductId FROM Sales l), mar (ProductId) AS (SELECT ProductId FROM Customer) SELECT COUNT(*) FROM feb LEFT JOIN mar ON mar.ProductId = feb.ProductId'
    ),
    ['Sales', 'Customer']
  );
});

test('validateReadOnlySql accepts queries that select FROM CTEs (qualified and unqualified)', () => {
  const unqualified = validateReadOnlySql('WITH x AS (SELECT id FROM Customer) SELECT COUNT(*) FROM x', ALLOWED);
  assert.deepEqual(unqualified.tablesUsed, ['Customer']);
  assert.equal(unqualified.firstKeyword, 'WITH');

  const qualified = validateReadOnlySql(
    'WITH feb AS (SELECT s.id FROM Sales s), mar AS (SELECT c.id FROM Customer c) SELECT COUNT(*) FROM feb LEFT JOIN mar ON mar.id = feb.id WHERE mar.id IS NULL',
    ALLOWED
  );
  assert.deepEqual(qualified.tablesUsed, ['Sales', 'Customer']);
});

test('validateReadOnlySql still checks the tables inside CTE bodies', () => {
  assert.throws(
    () => validateReadOnlySql('WITH x AS (SELECT * FROM secret_audit) SELECT * FROM x', ALLOWED),
    (error) => error.code === 'TABLE_SCOPE' && /"secret_audit"/.test(error.message)
  );
});

test('FROM inside EXTRACT/TRIM/SUBSTRING is not a table, FROM DUAL is allowed', () => {
  const result = validateReadOnlySql(
    "SELECT EXTRACT(MONTH FROM s.DocumentDate) AS m, TRIM(LEADING '0' FROM s.DocumentNo) AS doc, SUBSTRING(s.DocumentNo FROM 1 FOR 3) AS p FROM Sales s",
    ALLOWED
  );
  assert.deepEqual(result.tablesUsed, ['Sales']);
  assert.deepEqual(validateReadOnlySql('SELECT 1 AS one FROM DUAL', ALLOWED).tablesUsed, []);
});

test('table-like words inside literals do not become tables', () => {
  const result = validateReadOnlySql(
    "SELECT * FROM Customer c WHERE c.name <> 'Fresh from Farm' AND c.name NOT LIKE '%join Club%'",
    ALLOWED
  );
  assert.deepEqual(result.tablesUsed, ['Customer']);
});

test('parenthesized table references and db-qualified tables fail closed', () => {
  assert.throws(() => validateReadOnlySql('SELECT * FROM (Customer)', ALLOWED), (error) => error.code === 'PARENTHESIZED_TABLE');
  assert.throws(() => validateReadOnlySql('SELECT * FROM other.Customer', ALLOWED), (error) => error.code === 'CROSS_DATABASE');
});
