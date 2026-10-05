import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SqlTokenizeError,
  analyzeSqlStructure,
  stripSqlTokens,
  tokenizeSql,
} from '../src/sql-tokenizer.js';

// Compact view of the significant tokens: "type:value".
function lex(sql, options) {
  return tokenizeSql(sql, options)
    .filter((token) => token.type !== 'whitespace')
    .map((token) => `${token.type}:${token.value}`);
}

test('tokens cover the input exactly, with start/end offsets', () => {
  const sql = "SELECT c.CustomerName, 'x' FROM `Customer` c -- note\nWHERE 1 = 1";
  const tokens = tokenizeSql(sql);
  assert.equal(tokens.map((token) => token.value).join(''), sql);
  for (const token of tokens) {
    assert.equal(sql.slice(token.start, token.end), token.value);
  }
});

test("'--' is a comment only when followed by whitespace, a control char or EOF", () => {
  // MariaDB lexes 1--0 as 1 - -0, so the rest of the line is live SQL.
  assert.deepEqual(lex('SELECT 1--0, SLEEP(5)'), [
    'word:SELECT',
    'number:1',
    'operator:-',
    'operator:-',
    'number:0',
    'punct:,',
    'word:SLEEP',
    'punct:(',
    'number:5',
    'punct:)',
  ]);
  assert.deepEqual(lex('SELECT 1 -- note\n, 2'), ['word:SELECT', 'number:1', 'comment:-- note', 'punct:,', 'number:2']);
  assert.deepEqual(lex('SELECT 1 --\tnote'), ['word:SELECT', 'number:1', 'comment:--\tnote']);
  assert.deepEqual(lex('SELECT 1 --\u0001x'), ['word:SELECT', 'number:1', 'comment:--\u0001x']);
  assert.deepEqual(lex('SELECT 1--'), ['word:SELECT', 'number:1', 'comment:--']);
  assert.deepEqual(lex('SELECT 1 --x'), ['word:SELECT', 'number:1', 'operator:-', 'operator:-', 'word:x']);
});

test("'#' comments run to the end of the line (\\n only)", () => {
  assert.deepEqual(lex("SELECT 1 # don't\n, 2"), ['word:SELECT', 'number:1', "comment:# don't", 'punct:,', 'number:2']);
  // A bare \r does not end a MariaDB line comment.
  assert.deepEqual(lex('SELECT 1 # x\r, SLEEP(5)'), ['word:SELECT', 'number:1', 'comment:# x\r, SLEEP(5)']);
  assert.deepEqual(lex('SELECT a#b'), ['word:SELECT', 'word:a', 'comment:#b']);
});

test('block comments are not nested and end at the first */', () => {
  assert.deepEqual(lex('SELECT /* a /* b */ 1'), ['word:SELECT', 'comment:/* a /* b */', 'number:1']);
  assert.deepEqual(lex('SELECT 1 /* -- */, 2'), ['word:SELECT', 'number:1', 'comment:/* -- */', 'punct:,', 'number:2']);
  assert.deepEqual(lex("SELECT 1 /* it's */, 2"), ['word:SELECT', 'number:1', "comment:/* it's */", 'punct:,', 'number:2']);
  assert.deepEqual(lex('SELECT/**/1'), ['word:SELECT', 'comment:/**/', 'number:1']);
});

test('executable comments: /*!, /*!version, /*M! and /*M!version', () => {
  const tokens = tokenizeSql('SELECT 1 /*! +1 */ /*!100000 +2 */ /*M! +3 */ /*M!100000 +4 */ /*m! +5 */');
  const comments = tokens.filter((token) => token.type.endsWith('comment'));
  assert.deepEqual(
    comments.map((token) => [token.type, token.variant || token.style]),
    [
      ['executable_comment', 'mysql'],
      ['executable_comment', 'mysql'],
      ['executable_comment', 'mariadb'],
      ['executable_comment', 'mariadb'],
      // MariaDB only executes the uppercase M form; lowercase is a plain comment.
      ['comment', '/*'],
    ]
  );
});

test('strings support doubled-quote and backslash escapes', () => {
  assert.deepEqual(lex("SELECT 'it''s', 'a\\'b', 'c\\\\', \"q\"\"x\", \"y\\\"z\""), [
    'word:SELECT',
    "string:'it''s'",
    'punct:,',
    "string:'a\\'b'",
    'punct:,',
    "string:'c\\\\'",
    'punct:,',
    'string:"q""x"',
    'punct:,',
    'string:"y\\"z"',
  ]);
});

test('comment markers inside strings and quoted identifiers are not comments', () => {
  assert.deepEqual(lex("SELECT '--', '#', '/*', `a -- b`, \"/*! x */\""), [
    'word:SELECT',
    "string:'--'",
    'punct:,',
    "string:'#'",
    'punct:,',
    "string:'/*'",
    'punct:,',
    'quoted_identifier:`a -- b`',
    'punct:,',
    'string:"/*! x */"',
  ]);
});

test('backslash-escaped quotes are flagged (they lex differently under NO_BACKSLASH_ESCAPES)', () => {
  const [, escaped] = tokenizeSql("SELECT 'O\\'Brien'").filter((token) => token.type !== 'whitespace');
  assert.equal(escaped.backslashEscapedQuote, true);
  const [, doubled] = tokenizeSql("SELECT 'O''Brien'").filter((token) => token.type !== 'whitespace');
  assert.equal(doubled.backslashEscapedQuote, false);
  // With NO_BACKSLASH_ESCAPES semantics the same text ends the string early.
  assert.deepEqual(lex("SELECT 'a\\', 1", { backslashEscapes: false }), ['word:SELECT', "string:'a\\'", 'punct:,', 'number:1']);
});

test('backtick identifiers support doubled-backtick escapes and expose the unescaped name', () => {
  const token = tokenizeSql('SELECT `a``b`').find((candidate) => candidate.type === 'quoted_identifier');
  assert.equal(token.value, '`a``b`');
  assert.equal(token.name, 'a`b');
  assert.deepEqual(lex("SELECT 1 AS `a'b`, 2 AS `c'd`"), [
    'word:SELECT',
    'number:1',
    'word:AS',
    "quoted_identifier:`a'b`",
    'punct:,',
    'number:2',
    'word:AS',
    "quoted_identifier:`c'd`",
  ]);
});

test('numbers and digit-led identifiers follow MariaDB rules', () => {
  // Verified against MariaDB 10.6: 1e5FROM is 1e5 then FROM; 1FROM and 0x41FROM
  // are identifiers; 1. and .5 are numbers.
  assert.deepEqual(lex('SELECT 1e5FROM DUAL'), ['word:SELECT', 'number:1e5', 'word:FROM', 'word:DUAL']);
  assert.deepEqual(lex('SELECT 1FROM DUAL'), ['word:SELECT', 'word:1FROM', 'word:DUAL']);
  assert.deepEqual(lex('SELECT 1.FROM DUAL'), ['word:SELECT', 'number:1.', 'word:FROM', 'word:DUAL']);
  assert.deepEqual(lex('SELECT .5FROM DUAL'), ['word:SELECT', 'number:.5', 'word:FROM', 'word:DUAL']);
  assert.deepEqual(lex('SELECT 0x41, 0x41FROM, 0b101, 1.5e-3, 2E+10, 1eX'), [
    'word:SELECT',
    'number:0x41',
    'punct:,',
    'word:0x41FROM',
    'punct:,',
    'number:0b101',
    'punct:,',
    'number:1.5e-3',
    'punct:,',
    'number:2E+10',
    'punct:,',
    'word:1eX',
  ]);
});

test('identifiers after "ident." are never keywords', () => {
  const tokens = tokenizeSql('SELECT t.FROM, t.5x, t .y').filter((token) => token.type === 'word');
  assert.deepEqual(
    tokens.map((token) => [token.value, token.afterDot]),
    [
      ['SELECT', false],
      ['t', false],
      ['FROM', true],
      ['t', false],
      ['5x', true],
      ['t', false],
      ['y', false],
    ]
  );
});

test('non-ASCII characters are identifier characters, ASCII whitespace only', () => {
  // A no-break space glues words together in MariaDB (SELECT SLEEP is one
  // identifier), and a Cyrillic look-alike is not the SLEEP function.
  assert.deepEqual(lex('SELECT SLEEP(0)'), ['word:SELECT SLEEP', 'punct:(', 'number:0', 'punct:)']);
  assert.deepEqual(lex('SELECT ЅLEEP(5)'), ['word:SELECT', 'word:ЅLEEP', 'punct:(', 'number:5', 'punct:)']);
  assert.deepEqual(lex('SELECT\v1\f'), ['word:SELECT', 'number:1']);
});

test('variables, operators, punctuation and control characters', () => {
  assert.deepEqual(lex("SELECT @a, @@global.max_connections, @'x -- y', a<=>b, c:=d"), [
    'word:SELECT',
    'variable:@a',
    'punct:,',
    'variable:@@global.max_connections',
    'punct:,',
    "variable:@'x -- y'",
    'punct:,',
    'word:a',
    'operator:<=>',
    'word:b',
    'punct:,',
    'word:c',
    'operator::=',
    'word:d',
  ]);
  assert.deepEqual(lex('SELECT 1\u0000'), ['word:SELECT', 'number:1', 'unknown:\u0000']);
});

test('unterminated strings, quoted identifiers and comments throw UNTERMINATED_TOKEN', () => {
  for (const sql of ["SELECT 'abc", 'SELECT "abc', 'SELECT `abc', 'SELECT /* abc', 'SELECT /*! abc', "SELECT 'it''", "SELECT 'a\\'", "SELECT @'x"]) {
    assert.throws(
      () => tokenizeSql(sql),
      (error) => error instanceof SqlTokenizeError && error.code === 'UNTERMINATED_TOKEN',
      sql
    );
  }
});

test('tolerant mode reports unterminated tokens instead of throwing', () => {
  const tokens = tokenizeSql("SELECT 'abc", { tolerant: true });
  assert.equal(tokens.at(-1).type, 'string');
  assert.equal(tokens.at(-1).unterminated, true);
});

test('stripSqlTokens blanks literals and replaces comments with a space', () => {
  const stripped = stripSqlTokens(tokenizeSql("SELECT 'DROP' FROM/**/t -- x\n WHERE a = \"b\""));
  assert.equal(stripped, "SELECT '' FROM t  \n WHERE a = \"\"");
});

test('analyzeSqlStructure finds tables after FROM, JOIN, STRAIGHT_JOIN and FROM-list commas', () => {
  const analysis = analyzeSqlStructure(
    'SELECT * FROM Sales s, `customers` AS c LEFT JOIN Product p ON p.id = s.pid STRAIGHT_JOIN Brand b ON 1 = 1, Campaign'
  );
  assert.deepEqual(
    analysis.tableRefs.map((ref) => [ref.kind, ref.name, ref.alias]),
    [
      ['table', 'Sales', 's'],
      ['table', 'customers', 'c'],
      ['table', 'Product', 'p'],
      ['table', 'Brand', 'b'],
      ['table', 'Campaign', null],
    ]
  );
  assert.deepEqual(analysis.issues, []);
});

test('FROM inside EXTRACT/TRIM/SUBSTRING arguments is not a table keyword', () => {
  const analysis = analyzeSqlStructure(
    "SELECT EXTRACT(MONTH FROM d.DocumentDate), TRIM(LEADING '0' FROM d.DocumentNo), SUBSTRING(d.DocumentNo FROM 1 FOR 3) FROM SalesDocument d"
  );
  assert.deepEqual(analysis.tableRefs.map((ref) => ref.name), ['SalesDocument']);
  assert.deepEqual(analysis.issues, []);
});

test('parenthesized table references and table functions are reported, derived tables are not', () => {
  assert.equal(analyzeSqlStructure('SELECT * FROM (secret)').issues[0].code, 'PARENTHESIZED_TABLE');
  assert.equal(analyzeSqlStructure('SELECT * FROM ((SELECT 1) UNION (SELECT 2)) t').issues[0].code, 'PARENTHESIZED_TABLE');
  assert.equal(analyzeSqlStructure("SELECT * FROM JSON_TABLE('[1]', '$[*]' COLUMNS (a INT PATH '$')) j").issues[0].code, 'TABLE_FUNCTION');
  const derived = analyzeSqlStructure('SELECT * FROM (SELECT 1 AS a FROM Customer) AS t');
  assert.deepEqual(derived.issues, []);
  assert.deepEqual(
    derived.tableRefs.map((ref) => [ref.kind, ref.name, ref.alias]),
    [
      ['derived', null, 't'],
      ['table', 'Customer', null],
    ]
  );
});

test('db-qualified table references keep their schema', () => {
  const [ref] = analyzeSqlStructure('SELECT * FROM `information_schema` . `TABLES`').tableRefs;
  assert.equal(ref.schema, 'information_schema');
  assert.equal(ref.name, 'TABLES');
});

test('CTE names are query-local: visible after their definition, case-insensitive, with column lists', () => {
  const analysis = analyzeSqlStructure(
    'WITH feb AS (SELECT ProductId FROM SalesDocumentLine), m (p, q) AS (SELECT 1, 2 FROM FEB) SELECT * FROM feb JOIN m ON m.p = feb.ProductId'
  );
  assert.deepEqual(
    analysis.ctes.map((cte) => [cte.name, cte.columns]),
    [
      ['feb', null],
      ['m', ['p', 'q']],
    ]
  );
  assert.deepEqual(
    analysis.tableRefs.map((ref) => [ref.kind, ref.name]),
    [
      ['table', 'SalesDocumentLine'],
      ['cte', 'FEB'],
      ['cte', 'feb'],
      ['cte', 'm'],
    ]
  );
});

test('a CTE name is not visible before its definition or outside its WITH statement', () => {
  // MariaDB resolves a forward reference to a real table.
  const forward = analyzeSqlStructure('WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a');
  assert.deepEqual(
    forward.tableRefs.map((ref) => [ref.kind, ref.name]),
    [
      ['table', 'b'],
      ['cte', 'a'],
    ]
  );
  // A CTE declared inside a derived table does not leak to the outer query.
  const nested = analyzeSqlStructure('SELECT * FROM (WITH s AS (SELECT 1 AS x) SELECT * FROM s) t, s');
  assert.deepEqual(
    nested.tableRefs.map((ref) => [ref.kind, ref.name]),
    [
      ['derived', null],
      ['cte', 's'],
      ['table', 's'],
    ]
  );
});

test('GROUP BY ... WITH ROLLUP is not a CTE clause', () => {
  const analysis = analyzeSqlStructure('SELECT a, COUNT(*) FROM t GROUP BY a WITH ROLLUP');
  assert.deepEqual(analysis.ctes, []);
  assert.deepEqual(analysis.issues, []);
});

test('SELECT blocks split at UNION and nested queries get their own scope', () => {
  const analysis = analyzeSqlStructure(
    'SELECT a FROM t1 JOIN t2 ON 1 = 1 UNION SELECT b FROM t3 WHERE EXISTS (SELECT 1 FROM t4)'
  );
  const blockOf = (name) => analysis.tableRefs.find((ref) => ref.name === name).blockId;
  assert.equal(blockOf('t1'), blockOf('t2'));
  assert.notEqual(blockOf('t1'), blockOf('t3'));
  assert.notEqual(blockOf('t3'), blockOf('t4'));
});

test('unbalanced parentheses are reported', () => {
  assert.equal(analyzeSqlStructure('SELECT (1').issues[0].code, 'UNBALANCED_PARENTHESES');
  assert.equal(analyzeSqlStructure('SELECT 1)').issues[0].code, 'UNBALANCED_PARENTHESES');
});
