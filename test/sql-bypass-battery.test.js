import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOptimizedPrompt,
  buildSemanticPlan,
  validateReadOnlySql,
  validateSqlSafety,
} from '../src/pipeline.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Every bypass payload found by the 2026-10-05 audit (SAFE-1, SAFE-2, SAFE-4,
// SAFE-10 and the verifier's additions) must be rejected on BOTH paths:
// - basic: no prompt context, every compiled table allowed (scripts/basic.js),
// - optimized: the real prompt context the web/CLI pipeline builds.
// Each rejection must come from layer 1 ('safety'), so the basic path, which has
// no guardrail layer, is protected too.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Compiled in memory from the models, so tests never write generated/schema.json.
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const ALL_TABLES = schema.tables.map((table) => table.tableName);

function buildRealPrompt(question) {
  const prompt = buildOptimizedPrompt(schema, question, { semanticPlan: buildSemanticPlan(question) });
  return { promptContext: prompt.context, allowedTables: prompt.tables.map((table) => table.tableName) };
}

const PATHS = [
  { name: 'basic', allowedTables: ALL_TABLES, promptContext: null },
  { name: 'optimized (neutral question)', ...buildRealPrompt('List all customer names.') },
  { name: 'optimized (net sales question)', ...buildRealPrompt('What were net sales by customer in March 2026?') },
];

// [payload, expected error.code]
const PAYLOADS = [
  // SAFE-1: '--' without trailing whitespace is arithmetic in MariaDB, not a comment.
  ['SELECT 1--SLEEP(5)', 'DENYLISTED_FUNCTION'],
  ["SELECT 1--0, @@hostname AS h, USER() AS u, LOAD_FILE('/etc/passwd') AS f", 'SERVER_VARIABLE'],
  ["SELECT CustomerName FROM Customer WHERE 1--1 INTO OUTFILE '/tmp/out.csv'", 'FILE_OUTPUT'],
  ['SELECT 1--0, (SELECT GROUP_CONCAT(User) FROM/**/mysql.user) AS h', 'SQL_COMMENT'],
  ['SELECT 1--0, (SELECT COUNT(*) FROM (otherdb.payroll)) AS n', 'PARENTHESIZED_TABLE'],
  ["SELECT CustomerName--0, LOAD_FILE('/etc/hostname') AS f\nFROM Customer", 'DENYLISTED_FUNCTION'],
  ['SELECT 1--0, @@hostname AS host, @@datadir AS dir, @@version AS v', 'SERVER_VARIABLE'],
  ['SELECT 1--0, (SELECT COUNT(*) FROM information_schema.TABLES) AS n', 'METADATA_SCHEMA'],
  ['SELECT 1--1; DROP TABLE Customer', 'NOT_READ_ONLY'],
  ['SELECT 1 --x\n, SLEEP(5)', 'DENYLISTED_FUNCTION'],
  [
    "SELECT c.CustomerName, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId WHERE 1--1 GROUP BY c.CustomerName INTO OUTFILE '/tmp/o.csv'",
    'FILE_OUTPUT',
  ],
  [
    'SELECT c.CustomerName, SUM(d.NetAmount) AS net, 1--0\n, (SELECT GROUP_CONCAT(authentication_string) FROM/**/mysql.user) AS pw\nFROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId GROUP BY c.CustomerName',
    'SQL_COMMENT',
  ],
  // SAFE-1: quotes or comment markers inside comments desynced the old regex strippers.
  ["SELECT 1 /* it's */, (SELECT GROUP_CONCAT(TABLE_SCHEMA) FROM/**/information_schema.SCHEMATA) AS s /* ' */", 'SQL_COMMENT'],
  ["SELECT 1 /* it's */, SLEEP(5) /* ' */", 'SQL_COMMENT'],
  ['SELECT 1 /* -- */, SLEEP(5) AS s', 'SQL_COMMENT'],
  ['SELECT 1 /* # */, USER() AS u', 'SQL_COMMENT'],
  ["SELECT 1 /* ' */, @@version AS v /* ' */", 'SQL_COMMENT'],
  ['SELECT 1 /* " */, SLEEP(5) /* " */', 'SQL_COMMENT'],
  ["SELECT 1 -- customer's name\n, @@version AS v -- '\n", 'SQL_COMMENT'],
  ["SELECT 1 -- \"\n, LOAD_FILE('/etc/hostname') AS f -- \"\n", 'SQL_COMMENT'],
  ["SELECT 1 # don't\n, USER() AS u # '\n", 'SQL_COMMENT'],
  ['SELECT 1 --\tSLEEP(5)', 'SQL_COMMENT'],
  ["SELECT 1 AS `a'b`, SLEEP(5) AS `c'd`", 'DENYLISTED_FUNCTION'],
  ["SELECT '--', SLEEP(5)", 'DENYLISTED_FUNCTION'],
  ["SELECT 'it''s', SLEEP(5)", 'DENYLISTED_FUNCTION'],
  ["SELECT 'a''', SLEEP(5) AS x, ''''", 'DENYLISTED_FUNCTION'],
  ["SELECT 'a\\\\', SLEEP(5), 'b'", 'DENYLISTED_FUNCTION'],
  // Balanced only with backslash escapes; under NO_BACKSLASH_ESCAPES SLEEP(5) is live code.
  ["SELECT 'p\\', SLEEP(5), \\'' AS x", 'AMBIGUOUS_STRING_ESCAPE'],
  // SAFE-2: executable comments, MySQL and MariaDB forms, with and without versions.
  ['SELECT 1 /*! , SLEEP(5) */', 'EXECUTABLE_COMMENT'],
  ['SELECT 1 /*!100000 , SLEEP(5) */', 'EXECUTABLE_COMMENT'],
  ['SELECT 1 /*M! , SLEEP(5) */', 'EXECUTABLE_COMMENT'],
  ['SELECT CustomerName /*M!100000 , LOAD_FILE(0x2f6574632f706173737764) */ FROM Customer', 'EXECUTABLE_COMMENT'],
  ["SELECT CustomerName FROM Customer /*M! INTO OUTFILE '/tmp/x.csv' */", 'EXECUTABLE_COMMENT'],
  ['SELECT 1 /*M! , @@hostname, @@datadir, CURRENT_USER() */', 'EXECUTABLE_COMMENT'],
  ['SELECT CustomerName /*M!, (SELECT COUNT(*) FROM/**/otherdb.payroll) */ FROM Customer', 'EXECUTABLE_COMMENT'],
  [
    'SELECT c.CustomerName, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId GROUP BY c.CustomerName /*M! , SLEEP(5) */',
    'EXECUTABLE_COMMENT',
  ],
  ['SELECT 1 /*m! , SLEEP(5) */', 'SQL_COMMENT'],
  ['SELECT /*+ MAX_EXECUTION_TIME(1) */ 1', 'SQL_COMMENT'],
  // SAFE-4: allowed-table scope bypasses after FROM/JOIN.
  ['SELECT * FROM/**/secret_audit', 'SQL_COMMENT'],
  ['SELECT * FROM (secret_audit)', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM(secret_audit)', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM ((secret_audit))', 'PARENTHESIZED_TABLE'],
  ['SELECT c.CustomerName FROM Customer c JOIN (secret_audit) ON 1 = 1', 'PARENTHESIZED_TABLE'],
  ['SELECT c.CustomerName FROM Customer c LEFT JOIN (secret_audit s) ON 1=1', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM Customer c, (secret_audit)', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM (Customer)', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM # pick table\nsecret_audit', 'SQL_COMMENT'],
  ['SELECT * FROM Customer,/**/secret_audit', 'SQL_COMMENT'],
  ['SELECT * FROM Customer c JOIN/**/secret_audit s ON 1=1', 'SQL_COMMENT'],
  ['SELECT * FROM (otherdb.payroll)', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM/**/otherdb.payroll', 'SQL_COMMENT'],
  ['SELECT (SELECT COUNT(*) FROM(otherdb.payroll)) AS n', 'PARENTHESIZED_TABLE'],
  ['SELECT * FROM `secret_audit`', 'TABLE_SCOPE'],
  ['SELECT * FROM\tsecret_audit', 'TABLE_SCOPE'],
  ['SELECT CustomerName FROM Customer UNION SELECT name FROM secret', 'TABLE_SCOPE'],
  ['WITH x AS (SELECT * FROM secret_audit) SELECT * FROM x', 'TABLE_SCOPE'],
  ['SELECT * FROM (WITH s AS (SELECT 1 AS a) SELECT * FROM s) t, s', 'TABLE_SCOPE'],
  ['SELECT * FROM otherdb.payroll', 'CROSS_DATABASE'],
  ['SELECT * FROM demo_retail.Customer', 'CROSS_DATABASE'],
  ['WITH otherdb AS (SELECT 1 AS a) SELECT * FROM otherdb.payroll', 'CROSS_DATABASE'],
  ['SELECT otherdb.some_function(1)', 'CROSS_DATABASE'],
  ["SELECT jt.v FROM JSON_TABLE('[1,2]', '$[*]' COLUMNS (v INT PATH '$')) AS jt", 'TABLE_FUNCTION'],
  // Index hints and FOR SYSTEM_TIME can be followed by `, another_table` inside
  // a FROM list; the old FOR terminator ended the comma-list scan there, so the
  // next table was never checked (each ran on MariaDB 10.6 and returned the
  // planted row). They are rejected outright.
  ['SELECT c.CustomerName FROM Customer c FORCE INDEX FOR ORDER BY (PRIMARY), secret_audit s', 'INDEX_HINT'],
  ['SELECT * FROM Customer USE INDEX FOR ORDER BY (PRIMARY), secret_audit', 'INDEX_HINT'],
  ['SELECT c.CustomerName FROM Customer c IGNORE KEY FOR GROUP BY (PRIMARY), secret_audit', 'INDEX_HINT'],
  ['SELECT c.CustomerName, p.salary FROM Customer c USE INDEX FOR GROUP BY (PRIMARY), otherdb.payroll p LIMIT 2', 'INDEX_HINT'],
  ['SELECT * FROM Customer c FORCE INDEX FOR ORDER BY (PRIMARY), otherdb.payroll p', 'INDEX_HINT'],
  ['SELECT * FROM Customer c USE INDEX FOR JOIN (PRIMARY) JOIN secret_audit s ON 1 = 1', 'INDEX_HINT'],
  ['SELECT * FROM Customer c USE INDEX (PRIMARY), secret_audit', 'INDEX_HINT'],
  ['SELECT * FROM Customer FOR SYSTEM_TIME ALL c, secret_audit s', 'SYSTEM_TIME'],
  // MINUS (a set operator only under sql_mode=ORACLE) and WINDOW are legal
  // aliases / column / CTE names in MariaDB 10.6, so they must not end the
  // FROM-list scan either (all verified to return the planted row).
  ['SELECT * FROM Customer minus, secret_audit LIMIT 1', 'TABLE_SCOPE'],
  ['SELECT * FROM Customer AS minus, otherdb.payroll LIMIT 1', 'CROSS_DATABASE'],
  ['WITH minus AS (SELECT 1 AS a) SELECT * FROM minus, secret_audit', 'TABLE_SCOPE'],
  ['SELECT * FROM (SELECT 1 AS a) minus, secret_audit', 'TABLE_SCOPE'],
  ['SELECT * FROM Customer c JOIN (SELECT 1 AS minus) w ON minus = 1, secret_audit LIMIT 1', 'TABLE_SCOPE'],
  ['SELECT * FROM Customer c JOIN (SELECT 1 AS window) w ON window = 1, secret_audit LIMIT 1', 'TABLE_SCOPE'],
  ['WITH window AS (SELECT 1 AS a) SELECT * FROM window, secret_audit', 'TABLE_SCOPE'],
  // CTE visibility: a CTE is visible only after its own definition, and inside
  // its own (non-recursive) body the name still means the real table. MariaDB
  // resolves both of these to the real secret_audit table.
  ['WITH a AS (SELECT * FROM secret_audit), secret_audit AS (SELECT 1 AS id) SELECT * FROM a', 'TABLE_SCOPE'],
  ['WITH secret_audit AS (SELECT * FROM secret_audit) SELECT * FROM secret_audit', 'TABLE_SCOPE'],
  ['(SELECT * FROM secret_audit)', 'TABLE_SCOPE'],
  // Metadata schemas, bare and backtick-quoted (the old denylist blanked backticks).
  ['SELECT * FROM (`information_schema`.`TABLES`)', 'METADATA_SCHEMA'],
  ['SELECT * FROM(`mysql`.`user`)', 'METADATA_SCHEMA'],
  ['SELECT User, authentication_string FROM (`mysql`.user)', 'METADATA_SCHEMA'],
  ['SELECT CustomerName FROM Customer UNION SELECT authentication_string FROM(`mysql`.`user`)', 'METADATA_SCHEMA'],
  ['SELECT (SELECT COUNT(*) FROM `information_schema`.`TABLES`) AS n', 'METADATA_SCHEMA'],
  ['SELECT * FROM `information_schema`.`TABLES`', 'METADATA_SCHEMA'],
  ['SELECT * FROM `mysql`.`user`', 'METADATA_SCHEMA'],
  ['SELECT * FROM information_schema . TABLES', 'METADATA_SCHEMA'],
  ['SELECT CustomerName FROM Customer UNION SELECT TABLE_NAME FROM information_schema.TABLES', 'METADATA_SCHEMA'],
  ['SELECT * FROM performance_schema.threads', 'METADATA_SCHEMA'],
  ['SELECT * FROM sys.session', 'METADATA_SCHEMA'],
  // SAFE-10: denylist gaps.
  ["SELECT MASTER_GTID_WAIT('0-1-999999', 30)", 'DENYLISTED_FUNCTION'],
  ['SELECT CURRENT_USER AS u', 'SESSION_INFO_FUNCTION'],
  ['SELECT CURRENT_ROLE AS u', 'SESSION_INFO_FUNCTION'],
  ['SELECT SYSTEM_USER()', 'SESSION_INFO_FUNCTION'],
  ['SELECT DATABASE()', 'SESSION_INFO_FUNCTION'],
  ['SELECT SETVAL(Customer, 1000)', 'DENYLISTED_FUNCTION'],
  ['SELECT NEXTVAL(Customer)', 'DENYLISTED_FUNCTION'],
  ['SELECT LASTVAL(Customer)', 'DENYLISTED_FUNCTION'],
  ['SELECT NEXT VALUE FOR Customer', 'DENYLISTED_FUNCTION'],
  ['SELECT PREVIOUS VALUE FOR Customer', 'DENYLISTED_FUNCTION'],
  ['SELECT LAST_INSERT_ID(42)', 'DENYLISTED_FUNCTION'],
  ['SELECT CustomerName FROM Customer PROCEDURE ANALYSE()', 'PROCEDURE_CLAUSE'],
  ['WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r', 'RECURSIVE_CTE'],
  ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT COUNT(*) FROM r', 'RECURSIVE_CTE'],
  ['SELECT 1 INTO v', 'SELECT_INTO'],
  ['SELECT 1 INTO @v', 'SELECT_INTO'],
  ['SELECT CustomerName INTO @v FROM Customer LIMIT 1', 'SELECT_INTO'],
  ["SELECT 1 INTO DUMPFILE '/tmp/x'", 'FILE_OUTPUT'],
  ["SELECT CustomerName FROM Customer INTO/**/OUTFILE '/tmp/x'", 'SQL_COMMENT'],
  ['SELECT * FROM Customer FOR UPDATE SKIP LOCKED', 'LOCKING_READ'],
  ['SELECT * FROM Customer FOR SHARE', 'LOCKING_READ'],
  ['SELECT CustomerName FROM Customer FOR/**/UPDATE', 'SQL_COMMENT'],
  ['SELECT CustomerName FROM Customer LOCK\nIN\tSHARE MODE', 'LOCKING_READ'],
  ['SELECT sLeEp(5)', 'DENYLISTED_FUNCTION'],
  ['SELECT SLEEP\t(5)', 'DENYLISTED_FUNCTION'],
  ['SELECT SLEEP/**/(5)', 'SQL_COMMENT'],
  ["SELECT GET_LOCK('a', 10)", 'DENYLISTED_FUNCTION'],
  ['SELECT BENCHMARK(100000000, MD5(1))', 'DENYLISTED_FUNCTION'],
  ['SELECT LOAD_FILE(0x2f6574632f706173737764)', 'DENYLISTED_FUNCTION'],
  // Found while verifying this battery on MariaDB 10.6: backtick-quoted built-in
  // names still resolve to the built-in (`SLEEP`(0) sleeps). The old validator
  // blanked quoted identifiers before its denylist and accepted these.
  ['SELECT `SLEEP`(5)', 'DENYLISTED_FUNCTION'],
  ['SELECT `sleep` (5)', 'DENYLISTED_FUNCTION'],
  ["SELECT `LOAD_FILE`('/etc/passwd') AS f", 'DENYLISTED_FUNCTION'],
  ["SELECT `MASTER_GTID_WAIT`('0-1-999999', 30)", 'DENYLISTED_FUNCTION'],
  ['SELECT `VERSION`() AS v', 'SESSION_INFO_FUNCTION'],
  ['SELECT `otherdb`.`some_function`(1)', 'CROSS_DATABASE'],
  // Statements that are not a single SELECT/WITH query.
  ['SET STATEMENT max_statement_time=0 FOR SELECT 1', 'NOT_READ_ONLY'],
  ["EXECUTE IMMEDIATE 'SELECT 1'", 'NOT_READ_ONLY'],
  ['DO SLEEP(5)', 'NOT_READ_ONLY'],
  ['HANDLER Customer OPEN', 'NOT_READ_ONLY'],
  ['WITH x AS (SELECT 1) DELETE FROM Customer', 'NOT_READ_ONLY'],
  ['TABLE Customer', 'NOT_SELECT'],
  ['VALUES (1),(2)', 'NOT_SELECT'],
  ['(VALUES (1))', 'NOT_SELECT'],
  ['(TABLE Customer)', 'NOT_SELECT'],
  ['SELECT 1; SELECT 2', 'MULTI_STATEMENT'],
  ['SELECT 1;;', 'MULTI_STATEMENT'],
  // Malformed input fails closed.
  ["SELECT 'unterminated", 'UNTERMINATED_TOKEN'],
  ['SELECT `unterminated', 'UNTERMINATED_TOKEN'],
  ['SELECT 1 /* unterminated', 'UNTERMINATED_TOKEN'],
  ['SELECT 1\u0000, SLEEP(5)', 'INVALID_CHARACTER'],
  ['SELECT 1\u0001, 2', 'INVALID_CHARACTER'],
  ['SELECT (1', 'UNBALANCED_PARENTHESES'],
  [';', 'EMPTY_SQL'],
];

for (const { name, allowedTables, promptContext } of PATHS) {
  for (const [sql, expectedCode] of PAYLOADS) {
    test(`[${name}] rejects ${JSON.stringify(sql).slice(0, 70)}`, () => {
      assert.throws(
        () => validateReadOnlySql(sql, allowedTables, { promptContext }),
        (error) => {
          assert.equal(error.code, expectedCode, error.message);
          assert.equal(error.layer, 'safety');
          return true;
        }
      );
    });
  }
}

test('validateSqlSafety is layer 1 on its own and returns the executable SQL and tables', () => {
  const result = validateSqlSafety(
    'WITH feb AS (SELECT l.ProductId FROM SalesDocumentLine l) SELECT COUNT(*) AS n FROM feb JOIN Product p ON p.ProductId = feb.ProductId;',
    ['SalesDocumentLine', 'Product']
  );
  assert.equal(result.sql.endsWith('feb.ProductId'), true);
  assert.equal(result.firstKeyword, 'WITH');
  assert.equal(result.statementCount, 1);
  assert.deepEqual(result.tablesUsed, ['SalesDocumentLine', 'Product']);
  assert.deepEqual(result.cteNames, ['feb']);
});

test('the battery covers every audit payload class', () => {
  const codes = new Set(PAYLOADS.map(([, code]) => code));
  for (const code of [
    'SQL_COMMENT',
    'EXECUTABLE_COMMENT',
    'UNTERMINATED_TOKEN',
    'NOT_READ_ONLY',
    'DENYLISTED_FUNCTION',
    'SERVER_VARIABLE',
    'METADATA_SCHEMA',
    'MULTI_STATEMENT',
    'NOT_SELECT',
    'TABLE_SCOPE',
    'CROSS_DATABASE',
    'PARENTHESIZED_TABLE',
    'RECURSIVE_CTE',
    'INDEX_HINT',
    'SYSTEM_TIME',
  ]) {
    assert.ok(codes.has(code), `no payload exercises ${code}`);
  }
});

test('a query expression may open with parentheses', () => {
  for (const sql of [
    '(SELECT CustomerName FROM Customer) UNION (SELECT CustomerName FROM Customer)',
    '((SELECT CustomerName FROM Customer LIMIT 1))',
    '(WITH x AS (SELECT CustomerId FROM Customer) SELECT COUNT(*) AS n FROM x)',
  ]) {
    // Basic and neutral-question paths (the net-sales path would also demand
    // the metric column, which is unrelated to the statement head).
    for (const { name, allowedTables, promptContext } of PATHS.slice(0, 2)) {
      const result = validateReadOnlySql(sql, allowedTables, { promptContext });
      assert.deepEqual(result.tablesUsed, ['Customer'], `[${name}] ${sql}`);
    }
  }
  assert.equal(validateSqlSafety('(SELECT 1) UNION (SELECT 2)').firstKeyword, 'SELECT');
});

// Known gaps: SAFE-10 payloads that layer 1 knowingly accepts. Keep this list
// visible instead of silently dropping them from the battery.
// - Resource exhaustion, deferred to SAFE-11 (bounds enforced at the
//   connection: max_statement_time, sql_select_limit). It is not a
//   read-only/table-scope concern. Verified on MariaDB 10.6: a REPEAT() result
//   larger than max_allowed_packet (16 MiB) comes back as NULL with warning
//   1301, so the "memory bomb" is capped by the server; a cartesian self-join
//   only costs time, which only a statement timeout can bound.
// - Harmless under the denylist design (the audit's verifier: "adding the
//   specific names to the denylist is enough for now"; a full function
//   allowlist is a separate change): UUID_SHORT() only returns a number, and
//   a Cyrillic look-alike SLEEP is an unknown function (ERROR 1305) because
//   non-ASCII characters are identifier characters.
// When a later change rejects one of these, move it into PAYLOADS.
const KNOWN_ACCEPTED_SAFE10_PAYLOADS = [
  "SELECT LENGTH(REPEAT('x', 1073741824)) AS n",
  'SELECT COUNT(*) AS n FROM SalesDocumentLine a, SalesDocumentLine b, SalesDocumentLine c, SalesDocumentLine d, SalesDocumentLine e',
  'SELECT UUID_SHORT() AS u',
  'SELECT \u0405LEEP(5) AS s',
];

test('known gaps (SAFE-10/SAFE-11): resource and harmless function payloads still pass layer 1', () => {
  for (const sql of KNOWN_ACCEPTED_SAFE10_PAYLOADS) {
    assert.doesNotThrow(() => validateSqlSafety(sql, ALL_TABLES), sql);
  }
});
