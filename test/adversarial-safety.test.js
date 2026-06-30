import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReadOnlySql } from '../src/pipeline.js';

// Adversarial SQL the model might emit under a leading/jailbreak-style question
// ("ignore that and drop the table", "show me the mysql users", "make it slow").
// These complement test/sql-safety.test.js with shapes it does not already
// cover: CTE-hidden stacked DML, more server metadata schemas, error-based XML
// exfiltration, additional lock/replication functions, versioned executable
// comments, and metadata schema access hidden inside a scalar subquery.
const ALLOWED = ['Customer', 'SalesDocument'];

const REJECTED = [
  // A valid-looking read prefix (CTE) followed by a stacked destructive write.
  ['WITH x AS (SELECT 1) SELECT * FROM x; DROP TABLE Customer', /read-only SQL/],
  ['SELECT 1 UNION SELECT 2; UPDATE Customer SET CustomerName = NULL', /read-only SQL/],
  // Server metadata schemas beyond INFORMATION_SCHEMA.
  ['SELECT * FROM performance_schema.events_statements_summary_by_digest', /metadata schemas/],
  ['SELECT User FROM mysql.user', /metadata schemas/],
  ['SELECT * FROM sys.session', /metadata schemas/],
  // Metadata schema hidden inside a scalar subquery still gets scanned.
  ['SELECT (SELECT COUNT(*) FROM information_schema.tables) AS n', /metadata schemas/],
  // Direct-access storage engine handler is not a read-only SELECT.
  ['HANDLER Customer OPEN', /read-only SQL/],
  // Error-based / XML exfiltration functions.
  ['SELECT EXTRACTVALUE(1, CONCAT(0x7e, (SELECT CustomerName FROM Customer LIMIT 1)))', /restricted SQL functions/],
  ['SELECT UPDATEXML(1, CONCAT(0x7e, (SELECT CustomerName FROM Customer LIMIT 1)), 1)', /restricted SQL functions/],
  // Additional lock / replication primitives.
  ["SELECT RELEASE_LOCK('x')", /restricted SQL functions/],
  ["SELECT IS_FREE_LOCK('x')", /restricted SQL functions/],
  ["SELECT MASTER_POS_WAIT('binlog.000001', 100)", /restricted SQL functions/],
  // Case / whitespace obfuscated time-based attack.
  ['SeLeCt\n  SlEeP(3)', /restricted SQL functions/],
  // Versioned executable comment (payload runs server-side, hidden from scanners).
  ['SELECT 1 /*!40001 SQL_NO_CACHE */', /Executable SQL comments/],
];

for (const [sql, pattern] of REJECTED) {
  test(`adversarial reject: ${sql.slice(0, 52).replace(/\s+/g, ' ')}`, () => {
    assert.throws(() => validateReadOnlySql(sql, ALLOWED), pattern);
  });
}

// Legitimate reads that LOOK risky but are safe must still be accepted, so the
// guardrail does not become unusable by over-blocking.
const ACCEPTED = [
  // Leading block comment before the real SELECT.
  '/* monthly report */ SELECT CustomerName FROM Customer LIMIT 5',
  // A line comment that merely mentions a dangerous word.
  'SELECT CustomerName FROM Customer -- TODO: drop this column later\n LIMIT 5',
  // Dangerous tokens confined to a string literal.
  "SELECT CustomerName FROM Customer WHERE CustomerName = 'DROP TABLE x; -- or 1=1'",
  // UNION across allowed tables is a normal read.
  'SELECT CustomerName FROM Customer UNION SELECT CustomerName FROM Customer',
];

for (const sql of ACCEPTED) {
  test(`legitimate accept: ${sql.slice(0, 52).replace(/\s+/g, ' ')}`, () => {
    const result = validateReadOnlySql(sql, ALLOWED);
    assert.equal(result.firstKeyword, 'SELECT');
    assert.equal(result.statementCount, 1);
  });
}
