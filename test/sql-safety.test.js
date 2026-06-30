import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReadOnlySql, stripSqlForSafetyScan } from '../src/pipeline.js';

const ALLOWED = ['Customer', 'SalesDocument'];

// Each of these is a syntactically-SELECT query that nonetheless tries to write,
// lock, exfiltrate, time-attack, or stack a second statement. They must all be
// rejected before execution.
const REJECTED = [
  ['SELECT SLEEP(10)', /restricted SQL functions/],
  ['SELECT BENCHMARK(1000000, MD5(CustomerName)) FROM Customer', /restricted SQL functions/],
  ['SELECT GET_LOCK(\'x\', 10)', /restricted SQL functions/],
  ['SELECT LOAD_FILE(\'/etc/passwd\')', /restricted SQL functions/],
  ['SELECT CustomerName FROM Customer INTO OUTFILE \'/tmp/x\'', /output to files/],
  ['SELECT CustomerName FROM Customer INTO DUMPFILE \'/tmp/x\'', /output to files/],
  ['SELECT @@version', /variables/],
  ['SELECT @userVar', /variables/],
  ['SELECT VERSION()', /information functions/],
  ['SELECT CURRENT_USER()', /information functions/],
  ['SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES', /metadata schemas/],
  ['SELECT CustomerName FROM Customer FOR UPDATE', /read-only SQL|Locking reads/],
  ['SELECT CustomerName FROM Customer LOCK IN SHARE MODE', /Locking reads/],
  ['SELECT 1 /*! UNION SELECT CustomerName FROM Customer */', /Executable SQL comments/],
  ['SELECT 1; SELECT 2', /single SQL statement/],
  ['SELECT CustomerName FROM Customer; DROP TABLE Customer', /read-only SQL/],
  ['DELETE FROM Customer', /read-only SQL/],
  ['UPDATE Customer SET CustomerName = \'x\'', /read-only SQL/],
];

for (const [sql, pattern] of REJECTED) {
  test(`validateReadOnlySql rejects: ${sql.slice(0, 48)}`, () => {
    assert.throws(() => validateReadOnlySql(sql, ALLOWED), pattern);
  });
}

test('validateReadOnlySql does not false-positive on dangerous words inside string literals', () => {
  const result = validateReadOnlySql(
    "SELECT CustomerName FROM Customer WHERE CustomerName = 'please DELETE this later; DROP it'",
    ALLOWED
  );
  assert.equal(result.firstKeyword, 'SELECT');
  assert.equal(result.statementCount, 1);
});

test('validateReadOnlySql still accepts an ordinary read-only query', () => {
  const result = validateReadOnlySql('SELECT CustomerName FROM Customer LIMIT 10', ALLOWED);
  assert.equal(result.firstKeyword, 'SELECT');
  assert.deepEqual(result.tablesUsed, ['Customer']);
});

test('stripSqlForSafetyScan removes literals, comments, and quoted identifiers', () => {
  const stripped = stripSqlForSafetyScan("SELECT `col` FROM t WHERE x = 'DROP' -- DELETE\n AND y = 1 /* SLEEP(9) */");
  assert.ok(!/DROP/.test(stripped));
  assert.ok(!/DELETE/.test(stripped));
  assert.ok(!/SLEEP/.test(stripped));
});
