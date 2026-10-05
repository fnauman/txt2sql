import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOptimizedPrompt, buildSemanticPlan, validateReadOnlySql } from '../src/pipeline.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Fan-out detector: SUM/AVG over a parent-grain column while the same SELECT
// block joins a one-to-many child (a table with a foreign key to the parent)
// repeats each parent value once per child row. This was the dominant real
// model error in the audit's live run (9 of 9 slipped through).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Compiled in memory from the models, so tests never write generated/schema.json.
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

const BRAND_QUESTION = 'Show the top brands by net sales in March 2026.';
const POSTINGS_QUESTION = 'How many non-canceled sales documents do not have any accounting postings?';
// Metric-free question whose prompt context has the document, line and product
// tables, for shapes that are about the join structure rather than a measure.
const LINES_QUESTION = 'List sales documents with their product lines.';
const HEADER_LINES = 'FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId';

function validateFor(question, sql) {
  const prompt = buildOptimizedPrompt(schema, question, { semanticPlan: buildSemanticPlan(question) });
  return validateReadOnlySql(
    sql,
    prompt.tables.map((table) => table.tableName),
    { promptContext: prompt.context }
  );
}

function assertFanOut(question, sql, { table = 'SalesDocument', column = 'NetAmount', child = 'SalesDocumentLine' } = {}) {
  assert.throws(
    () => validateFor(question, sql),
    (error) => {
      assert.equal(error.code, 'FAN_OUT', error.message);
      assert.equal(error.layer, 'guardrail');
      assert.equal(error.details.table, table);
      assert.equal(error.details.column, column);
      assert.equal(error.details.childTable, child);
      return true;
    }
  );
}

test('rejects SUM/AVG over a header amount while joining its lines, with an actionable message', () => {
  assert.throws(
    () =>
      validateFor(
        BRAND_QUESTION,
        `SELECT b.BrandName, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount ${HEADER_LINES} JOIN Product p ON l.ProductId = p.ProductId JOIN Brand b ON p.BrandId = b.BrandId GROUP BY b.BrandName`
      ),
    (error) =>
      error.code === 'FAN_OUT' &&
      error.message ===
        'Fan-out: SUM over SalesDocument.NetAmount while joining SalesDocumentLine (one row per SalesDocumentLine row via SalesDocumentLine.SalesDocumentId -> SalesDocument.SalesDocumentId) double-counts SalesDocument values. Use SalesDocumentLine.NetAmount for SalesDocumentLine-level (e.g. product, brand or category) breakdowns, or aggregate the SalesDocumentLine rows in a subquery first.'
  );
  assertFanOut(BRAND_QUESTION, `SELECT AVG(d.NetAmount) AS avg_net ${HEADER_LINES}`);
  assertFanOut(BRAND_QUESTION, `SELECT IFNULL(SUM(DISTINCT d.NetAmount), 0) AS total_net_amount ${HEADER_LINES}`);
  // Full table names as qualifiers.
  assertFanOut(
    BRAND_QUESTION,
    'SELECT SUM(SalesDocument.NetAmount) AS net FROM SalesDocument JOIN SalesDocumentLine ON SalesDocumentLine.SalesDocumentId = SalesDocument.SalesDocumentId'
  );
  // Comma join.
  assertFanOut(BRAND_QUESTION, 'SELECT SUM(d.NetAmount) AS net FROM SalesDocument d, SalesDocumentLine l WHERE l.SalesDocumentId = d.SalesDocumentId');
});

test('a CASE WHEN condition does not decide the grain of the summed value', () => {
  assertFanOut(BRAND_QUESTION, `SELECT SUM(CASE WHEN l.ProductId = 1 THEN d.NetAmount ELSE 0 END) AS net ${HEADER_LINES}`);
});

test('unqualified columns resolve to the only joined table that has them', () => {
  // GrossAmount only exists on SalesDocument.
  assertFanOut(
    BRAND_QUESTION,
    'SELECT SUM(GrossAmount) AS gross FROM SalesDocument JOIN SalesDocumentLine USING (SalesDocumentId)',
    { column: 'GrossAmount' }
  );
  // Backtick-quoted and differently cased spellings name the same column; both
  // returned 7130 instead of 6010 on the seeded demo DB.
  assertFanOut(BRAND_QUESTION, `SELECT SUM(\`GrossAmount\`) AS gross ${HEADER_LINES}`, { column: 'GrossAmount' });
  assertFanOut(BRAND_QUESTION, `SELECT SUM(grossamount) AS gross ${HEADER_LINES}`, { column: 'GrossAmount' });
  assertFanOut(BRAND_QUESTION, `SELECT AVG(\`GrossAmount\` - 0) AS gross ${HEADER_LINES}`, { column: 'GrossAmount' });
  // A qualified column in another case is the same column too (6500 instead of 5500).
  assertFanOut(BRAND_QUESTION, `SELECT SUM(d.netamount) AS net ${HEADER_LINES}`);
  // Unqualified columns of a derived table or CTE resolve through its lineage
  // too (6500 instead of 5500, 7130 instead of 6010).
  const LINES_OF_H = 'FROM h JOIN SalesDocumentLine l ON l.SalesDocumentId = h.SalesDocumentId';
  assertFanOut(BRAND_QUESTION, `WITH h AS (SELECT SalesDocumentId, NetAmount AS doc_net FROM SalesDocument) SELECT SUM(doc_net) AS g ${LINES_OF_H}`);
  assertFanOut(BRAND_QUESTION, `WITH h AS (SELECT SalesDocumentId, GrossAmount FROM SalesDocument) SELECT SUM(GrossAmount) AS g ${LINES_OF_H}`, {
    column: 'GrossAmount',
  });
  assertFanOut(
    BRAND_QUESTION,
    'SELECT SUM(`GrossAmount`) AS g FROM (SELECT SalesDocumentId, GrossAmount FROM SalesDocument) h JOIN SalesDocumentLine l ON l.SalesDocumentId = h.SalesDocumentId',
    { column: 'GrossAmount' }
  );
  assertFanOut(
    BRAND_QUESTION,
    `WITH h AS (SELECT SalesDocumentId, NetAmount AS doc_net FROM SalesDocument) SELECT l.ProductId, SUM(doc_net) AS g ${LINES_OF_H} GROUP BY l.ProductId`
  );
  assert.doesNotThrow(() =>
    validateFor(LINES_QUESTION, `WITH h AS (SELECT SalesDocumentId, NetAmount AS doc_net FROM SalesDocument) SELECT SUM(Quantity) AS q ${LINES_OF_H}`)
  );
});

test('fan-out inside a CTE body or a derived table is rejected', () => {
  assertFanOut(BRAND_QUESTION, `WITH x AS (SELECT l.ProductId, SUM(d.NetAmount) AS net ${HEADER_LINES} GROUP BY l.ProductId) SELECT SUM(x.net) AS net FROM x`);
  assertFanOut(BRAND_QUESTION, `SELECT t.net FROM (SELECT SUM(d.NetAmount) AS net ${HEADER_LINES}) t`);
});

test('IS NULL on an inner-joined child is not an anti-join', () => {
  assertFanOut(BRAND_QUESTION, `SELECT SUM(d.NetAmount) AS net ${HEADER_LINES} WHERE l.ProductId IS NULL`);
});

test('a LEFT JOIN is an anti-join only for a top-level WHERE ... IS NULL on a never-null-when-matched column', () => {
  const LEFT_LINES = 'FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId';
  // Each of these returned 6500 instead of 5500 (or kept one row per matching
  // line) on the seeded demo DB, yet the old exemption accepted them because an
  // `alias.col IS NULL` appeared somewhere in the block.
  for (const sql of [
    // IS NULL inside the ON clause keeps every null-product line.
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId AND l.ProductId IS NULL',
    // ProductId is nullable: a document with several such lines is multiplied.
    `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE l.ProductId IS NULL`,
    // Under OR the IS NULL test does not hold for every row.
    `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE l.SalesDocumentLineId IS NULL OR l.Quantity > 0`,
    `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE l.ProductId IS NULL OR 1 = 1`,
    `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE l.SalesDocumentLineId IS NULL || 1 = 1`,
    // The AND belongs to BETWEEN: this is d.SalesDocumentId BETWEEN 1 AND (l.SalesDocumentLineId IS NULL).
    `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE d.SalesDocumentId BETWEEN 1 AND l.SalesDocumentLineId IS NULL`,
    // IS NULL in the SELECT list / a CASE is not a filter at all.
    `SELECT SUM(d.NetAmount) AS n, MAX(CASE WHEN l.ProductId IS NULL THEN 1 ELSE 0 END) AS f ${LEFT_LINES}`,
    `SELECT SUM(d.NetAmount) AS net, SUM(CASE WHEN l.SalesDocumentLineId IS NULL THEN 1 ELSE 0 END) AS empty_docs ${LEFT_LINES}`,
  ]) {
    assertFanOut(BRAND_QUESTION, sql);
  }

  // A nullable non-key posting column, and a join key compared under OR in ON.
  for (const sql of [
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN AccountingPosting p ON p.SalesDocumentId = d.SalesDocumentId WHERE p.LedgerAccountId IS NULL',
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN AccountingPosting p ON p.SalesDocumentId = d.SalesDocumentId OR p.LedgerAccountId = 1 WHERE p.SalesDocumentId IS NULL',
  ]) {
    assertFanOut(POSTINGS_QUESTION, sql, { child: 'AccountingPosting' });
  }

  // Genuine anti-joins: primary key, NOT NULL foreign key, a nullable key that
  // the join condition equates (ON ... = ... or USING), parenthesized.
  for (const [question, sql] of [
    [BRAND_QUESTION, `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE l.SalesDocumentLineId IS NULL`],
    [BRAND_QUESTION, `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE d.IsCanceled = 0 AND l.SalesDocumentId IS NULL`],
    [BRAND_QUESTION, `SELECT SUM(d.NetAmount) AS n ${LEFT_LINES} WHERE (l.SalesDocumentLineId IS NULL) AND d.DocumentDate BETWEEN '2026-03-01' AND '2026-03-31'`],
    [
      POSTINGS_QUESTION,
      'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN AccountingPosting p ON p.SalesDocumentId = d.SalesDocumentId WHERE p.SalesDocumentId IS NULL',
    ],
    [
      POSTINGS_QUESTION,
      'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN AccountingPosting p USING (SalesDocumentId) WHERE p.SalesDocumentId IS NULL',
    ],
  ]) {
    assert.doesNotThrow(() => validateFor(question, sql), sql);
  }
});

test('an aggregate that can yield a header value is at header grain, even if it also touches a line column', () => {
  // COALESCE/IF/CASE arms and additive terms carry the header value through;
  // both of these returned 6500 instead of 5500 on the seeded demo DB.
  for (const sql of [
    `SELECT SUM(COALESCE(d.NetAmount, l.NetAmount)) AS n ${HEADER_LINES}`,
    `SELECT SUM(d.NetAmount + 0 * l.Quantity) AS n ${HEADER_LINES}`,
    `SELECT SUM(-d.NetAmount - -l.NetAmount) AS n ${HEADER_LINES}`,
    `SELECT SUM(IF(l.ProductId IS NULL, d.NetAmount, l.NetAmount)) AS n ${HEADER_LINES}`,
    `SELECT SUM(CASE WHEN l.Quantity > 0 THEN l.NetAmount ELSE d.NetAmount END) AS n ${HEADER_LINES}`,
  ]) {
    assertFanOut(BRAND_QUESTION, sql);
  }

  // A header value multiplied by a line value is a per-line value; a header
  // column used only in a condition does not set the grain.
  for (const sql of [
    `SELECT SUM(l.NetAmount * d.NetAmount / NULLIF(d.GrossAmount, 0)) AS n ${HEADER_LINES}`,
    `SELECT SUM(IF(d.IsCanceled = 1, 0, l.NetAmount)) AS n ${HEADER_LINES}`,
    `SELECT SUM(l.NetAmount * -d.IsCanceled) AS n ${HEADER_LINES}`,
    `SELECT SUM(CASE WHEN d.IsCanceled = 0 THEN l.NetAmount ELSE 0 END) AS n ${HEADER_LINES}`,
    `SELECT ROUND(SUM(CAST(l.NetAmount AS DECIMAL(18, 2)) * d.IsCanceled), 2) AS n ${HEADER_LINES}`,
  ]) {
    assert.doesNotThrow(() => validateFor(BRAND_QUESTION, sql), sql);
  }
});

test('a child joined on its whole primary key pinned to constants keeps one row per parent', () => {
  // Each returns the un-inflated total on the seeded demo DB (5500, or 800 for
  // the one document that has line 3).
  for (const sql of [
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId AND l.SalesDocumentLineId = 1',
    "SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId AND (l.SalesDocumentLineId = '1')",
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} WHERE l.SalesDocumentLineId = 3`,
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} AND 3 = SalesDocumentLineId`,
    // Conjuncts grouped in parentheses still pin the key.
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN SalesDocumentLine l ON (l.SalesDocumentId = d.SalesDocumentId AND l.SalesDocumentLineId = 1)',
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine) x ON (x.SalesDocumentId = d.SalesDocumentId AND (d.IsCanceled = 0))',
  ]) {
    assert.doesNotThrow(() => validateFor(LINES_QUESTION, sql), sql);
  }

  for (const sql of [
    // Under OR the key is not pinned to one value (6500 instead of 5500).
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId AND (l.SalesDocumentLineId = 1 OR l.SalesDocumentLineId = 2)',
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON (l.SalesDocumentId = d.SalesDocumentId AND (l.SalesDocumentLineId = 1 OR l.SalesDocumentLineId = 2))',
    // A later LEFT JOIN's condition does not restrict the rows on its left (6500).
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} LEFT JOIN Product p ON p.ProductId = l.ProductId AND l.SalesDocumentLineId = 1`,
    // Two copies of the child pinned to each other still repeat the document (6500).
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} JOIN SalesDocumentLine l2 ON l2.SalesDocumentLineId = l.SalesDocumentLineId`,
    // Not the key, or not an equality.
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} AND l.ProductId = 1`,
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} AND l.SalesDocumentLineId > 1`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }
});

test('a composite child key must be pinned completely, to constants or to the parent', () => {
  const column = (name, extra = {}) => ({ name, type: 'INTEGER', primaryKey: false, allowNull: true, ...extra });
  const promptContext = {
    tables: [
      { tableName: 'Invoice', includedColumns: [column('InvoiceId', { primaryKey: true, allowNull: false }), column('Total')], omittedColumnNames: [] },
      {
        tableName: 'InvoiceLine',
        includedColumns: [
          column('InvoiceId', { primaryKey: true, allowNull: false }),
          column('LineNo', { primaryKey: true, allowNull: false }),
          column('Amount'),
        ],
        omittedColumnNames: [],
      },
    ],
    relationships: [{ fromTable: 'InvoiceLine', fromColumn: 'InvoiceId', toTable: 'Invoice', toColumn: 'InvoiceId' }],
  };
  const validate = (sql) => validateReadOnlySql(sql, ['Invoice', 'InvoiceLine'], { promptContext });

  assert.doesNotThrow(() => validate('SELECT SUM(i.Total) AS t FROM Invoice i JOIN InvoiceLine l ON l.InvoiceId = i.InvoiceId AND l.LineNo = 1'));
  assert.doesNotThrow(() => validate('SELECT SUM(i.Total) AS t FROM Invoice i JOIN InvoiceLine l USING (InvoiceId) WHERE l.LineNo = 1'));
  for (const sql of [
    'SELECT SUM(i.Total) AS t FROM Invoice i JOIN InvoiceLine l ON l.InvoiceId = i.InvoiceId',
    // LineNo = 1 alone matches line 1 of every invoice.
    'SELECT SUM(i.Total) AS t FROM Invoice i JOIN InvoiceLine l ON l.LineNo = 1',
  ]) {
    assert.throws(() => validate(sql), (error) => error.code === 'FAN_OUT' && error.details.childTable === 'InvoiceLine', sql);
  }
});

test('a parent value reduced by an inner MIN/MAX per parent-level group is not repeated by an outer window SUM', () => {
  // MAX ignores the repeated document rows, and grouping only by document
  // columns keeps the groups the query has without the line join. On the
  // seeded demo DB these return 5500 (by document) and 3350 (by customer),
  // exactly what they return without the join.
  for (const sql of [
    `SELECT d.SalesDocumentId, MAX(d.NetAmount) AS amount, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY d.SalesDocumentId`,
    `SELECT d.CustomerId, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY d.CustomerId`,
    `SELECT d.SalesDocumentId, AVG(MIN(d.NetAmount)) OVER () AS average ${HEADER_LINES} GROUP BY d.SalesDocumentId, YEAR(d.DocumentDate)`,
    `SELECT SUM(COALESCE(MAX(d.NetAmount), 0)) OVER () AS total ${HEADER_LINES}`,
  ]) {
    assert.doesNotThrow(() => validateFor(LINES_QUESTION, sql), sql);
  }

  for (const sql of [
    // An inner SUM is itself repeated per line (6500 instead of 5500).
    `SELECT d.SalesDocumentId, SUM(SUM(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY d.SalesDocumentId`,
    `SELECT d.SalesDocumentId, SUM(AVG(d.NetAmount) + MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY d.SalesDocumentId`,
    // A line-level GROUP BY key puts one document in several groups (6500 and 5100).
    `SELECT d.SalesDocumentId, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY d.SalesDocumentId, l.ProductId`,
    `SELECT l.ProductId, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY l.ProductId`,
    // Positional keys are not attributed to a table.
    `SELECT l.ProductId, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY 1`,
    // Neither are output aliases, keyword-like ones included, nor subqueries
    // (5100 and 6500 on the seeded demo DB).
    `SELECT l.ProductId AS year, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY year`,
    `SELECT l.ProductId date, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY date`,
    `SELECT l.ProductId AS month, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY month`,
    `SELECT l.ProductId AS pid, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY pid`,
    `SELECT d.SalesDocumentId, SUM(MAX(d.NetAmount)) OVER () AS total ${HEADER_LINES} GROUP BY d.SalesDocumentId, (SELECT l.SalesDocumentLineId)`,
    // A windowed MAX is not a per-group reduction.
    `SELECT SUM(d.NetAmount) OVER () AS total, MAX(d.NetAmount) OVER () AS m ${HEADER_LINES}`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }
});

test('a derived table or CTE that only projects a child table counts as that child', () => {
  for (const sql of [
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT l.SalesDocumentId, l.ProductId FROM SalesDocumentLine l) x ON x.SalesDocumentId = d.SalesDocumentId',
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT * FROM SalesDocumentLine) x ON x.SalesDocumentId = d.SalesDocumentId',
    'WITH line_rows AS (SELECT l.SalesDocumentId FROM SalesDocumentLine l) SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN line_rows x ON x.SalesDocumentId = d.SalesDocumentId',
    'WITH line_rows AS (SELECT * FROM SalesDocumentLine) SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN line_rows ON line_rows.SalesDocumentId = d.SalesDocumentId',
    'WITH a AS (SELECT * FROM SalesDocumentLine), b AS (SELECT * FROM a WHERE a.Quantity > 0) SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN b ON b.SalesDocumentId = d.SalesDocumentId',
  ]) {
    assertFanOut(BRAND_QUESTION, sql);
  }
  // A renamed header column is still the header amount it copies, through CTE chains too.
  assertFanOut(
    BRAND_QUESTION,
    'WITH h AS (SELECT d.SalesDocumentId AS id, d.NetAmount AS amt FROM SalesDocument d) SELECT SUM(h.amt) AS n FROM h JOIN SalesDocumentLine l ON l.SalesDocumentId = h.id'
  );
  assertFanOut(
    BRAND_QUESTION,
    'WITH a AS (SELECT d.SalesDocumentId, d.NetAmount AS amt FROM SalesDocument d), b AS (SELECT a.* FROM a) SELECT SUM(b.amt) AS n FROM b JOIN SalesDocumentLine l ON l.SalesDocumentId = b.SalesDocumentId'
  );
  // ...and a projection of the header joined to its lines is the header.
  assertFanOut(
    BRAND_QUESTION,
    'SELECT SUM(x.NetAmount) AS n FROM (SELECT * FROM SalesDocument) x JOIN SalesDocumentLine l ON l.SalesDocumentId = x.SalesDocumentId'
  );

  // DISTINCT / GROUP BY on the join key collapse the child rows to one per document.
  for (const sql of [
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT DISTINCT l.SalesDocumentId FROM SalesDocumentLine l) x ON x.SalesDocumentId = d.SalesDocumentId',
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT l.SalesDocumentId, COUNT(*) AS c FROM SalesDocumentLine l GROUP BY l.SalesDocumentId) x ON x.SalesDocumentId = d.SalesDocumentId',
  ]) {
    assert.doesNotThrow(() => validateFor(BRAND_QUESTION, sql), sql);
  }
});

test('a derived or CTE child is exempt only when it is unique on the columns that join it to the parent', () => {
  const HEADER = 'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d';
  // Each of these returned 6500 instead of 5500 on the seeded demo DB:
  // DISTINCT, GROUP BY or LIMIT n keep several rows per document unless the
  // output is unique on the join key alone.
  for (const sql of [
    `${HEADER} JOIN (SELECT DISTINCT SalesDocumentId, SalesDocumentLineId FROM SalesDocumentLine) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT SalesDocumentId, SalesDocumentLineId FROM SalesDocumentLine GROUP BY SalesDocumentId, SalesDocumentLineId) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT SalesDocumentId FROM SalesDocumentLine LIMIT 100) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT SalesDocumentLineId, SalesDocumentId FROM SalesDocumentLine LIMIT 1000) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT DISTINCT l.SalesDocumentId, l.ProductId FROM SalesDocumentLine l) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT l.SalesDocumentId, l.ProductId, SUM(l.Quantity) AS q FROM SalesDocumentLine l GROUP BY l.SalesDocumentId, l.ProductId) x ON x.SalesDocumentId = d.SalesDocumentId`,
    // A GROUP BY key that is not projected cannot make the output unique.
    `${HEADER} JOIN (SELECT l.SalesDocumentId FROM SalesDocumentLine l GROUP BY l.SalesDocumentId, l.ProductId) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `WITH x AS (SELECT DISTINCT SalesDocumentId, SalesDocumentLineId FROM SalesDocumentLine) ${HEADER} JOIN x ON x.SalesDocumentId = d.SalesDocumentId`,
    `WITH a AS (SELECT DISTINCT SalesDocumentId, ProductId FROM SalesDocumentLine), b AS (SELECT * FROM a) ${HEADER} JOIN b ON b.SalesDocumentId = d.SalesDocumentId`,
    // A non-reserved keyword is a valid alias; USING needs no qualifier.
    `${HEADER} JOIN (SELECT DISTINCT SalesDocumentId, ProductId FROM SalesDocumentLine) date USING (SalesDocumentId)`,
    // A body that joins other tables or is a UNION is still at line grain.
    `${HEADER} JOIN (SELECT l.SalesDocumentId FROM SalesDocumentLine l JOIN Product p ON p.ProductId = l.ProductId) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT SalesDocumentId FROM SalesDocumentLine UNION ALL SELECT SalesDocumentId FROM SalesDocumentLine WHERE 1 = 0) x ON x.SalesDocumentId = d.SalesDocumentId`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }

  // A collapsed header is still the header when joined to its lines (6500).
  for (const sql of [
    'SELECT SUM(x.net) AS n FROM (SELECT SalesDocumentId, SUM(NetAmount) AS net FROM SalesDocument GROUP BY SalesDocumentId) x JOIN SalesDocumentLine l ON l.SalesDocumentId = x.SalesDocumentId',
    'SELECT SUM(x.NetAmount) AS n FROM (SELECT DISTINCT SalesDocumentId, NetAmount FROM SalesDocument) x JOIN SalesDocumentLine l ON l.SalesDocumentId = x.SalesDocumentId',
  ]) {
    assert.throws(
      () => validateFor(LINES_QUESTION, sql),
      (error) => error.code === 'FAN_OUT' && error.details.table === 'SalesDocument' && error.details.childTable === 'SalesDocumentLine',
      sql
    );
  }

  // Unique on the join key, wherever the join condition is written, or at
  // most one row: each returns 5500 (1000 for the LIMIT 1 and pinned-key rows).
  for (const sql of [
    `${HEADER} JOIN (SELECT l.SalesDocumentId AS doc, SUM(l.Quantity) AS qty FROM SalesDocumentLine l GROUP BY doc) x ON x.doc = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT l.SalesDocumentId, SUM(l.Quantity) AS qty FROM SalesDocumentLine l GROUP BY 1) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT l.SalesDocumentId, SUM(l.NetAmount) AS net FROM SalesDocumentLine l JOIN Product p ON p.ProductId = l.ProductId WHERE p.ProductId > 0 GROUP BY l.SalesDocumentId) x ON x.SalesDocumentId = d.SalesDocumentId`,
    'SELECT SUM(d.NetAmount) AS n FROM (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine) x JOIN SalesDocument d ON d.SalesDocumentId = x.SalesDocumentId',
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d, (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine) x WHERE x.SalesDocumentId = d.SalesDocumentId',
    `${HEADER} JOIN (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine) x USING (SalesDocumentId)`,
    `WITH x (doc_id) AS (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine) ${HEADER} JOIN x ON x.doc_id = d.SalesDocumentId`,
    'WITH line_totals AS (SELECT SalesDocumentId, SUM(NetAmount) AS line_net FROM SalesDocumentLine GROUP BY SalesDocumentId) SELECT SUM(d.NetAmount) AS header_net, SUM(t.line_net) AS line_net FROM SalesDocument d JOIN line_totals t ON t.SalesDocumentId = d.SalesDocumentId',
    'SELECT SUM(d.NetAmount) AS n, MAX(t.total_qty) AS q FROM SalesDocument d CROSS JOIN (SELECT SUM(Quantity) AS total_qty FROM SalesDocumentLine) t',
    `${HEADER} JOIN (SELECT SalesDocumentId FROM SalesDocumentLine ORDER BY SalesDocumentLineId LIMIT 1) x ON x.SalesDocumentId = d.SalesDocumentId`,
    `${HEADER} JOIN (SELECT * FROM SalesDocumentLine) x ON x.SalesDocumentId = d.SalesDocumentId AND x.SalesDocumentLineId = 1`,
  ]) {
    assert.doesNotThrow(() => validateFor(LINES_QUESTION, sql), sql);
  }
});

test('a relation that filters, renames or re-projects a unique CTE or derived table stays unique on its key', () => {
  const CUSTOMER_QUESTION = 'Show the top customers by total net sales amount in March 2026.';
  const HEADER = 'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d';
  const LINE_TOTALS = 'WITH line_totals AS (SELECT SalesDocumentId, SUM(NetAmount) AS line_net FROM SalesDocumentLine GROUP BY SalesDocumentId)';
  // Pre-aggregation read through another CTE or derived table: no inflation
  // on the seeded demo DB (1700/1700/650 by customer, 5500 in total).
  for (const [question, sql] of [
    [
      CUSTOMER_QUESTION,
      `${LINE_TOTALS}, big AS (SELECT * FROM line_totals WHERE line_net > 500) SELECT d.CustomerId, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN big ON big.SalesDocumentId = d.SalesDocumentId GROUP BY d.CustomerId`,
    ],
    [
      CUSTOMER_QUESTION,
      `${LINE_TOTALS} SELECT d.CustomerId, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN (SELECT lt.SalesDocumentId FROM line_totals lt WHERE lt.line_net > 500) big ON big.SalesDocumentId = d.SalesDocumentId GROUP BY d.CustomerId`,
    ],
    [LINES_QUESTION, `WITH a AS (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine), b AS (SELECT * FROM a) ${HEADER} JOIN b ON b.SalesDocumentId = d.SalesDocumentId`],
    [
      LINES_QUESTION,
      `${HEADER} JOIN (SELECT y.SalesDocumentId FROM (SELECT SalesDocumentId FROM SalesDocumentLine GROUP BY SalesDocumentId) y) x ON x.SalesDocumentId = d.SalesDocumentId`,
    ],
    [
      LINES_QUESTION,
      `WITH a AS (SELECT SalesDocumentId AS sid, SUM(Quantity) AS q FROM SalesDocumentLine GROUP BY SalesDocumentId), b AS (SELECT sid AS doc, q FROM a) ${HEADER} JOIN b ON b.doc = d.SalesDocumentId`,
    ],
  ]) {
    assert.doesNotThrow(() => validateFor(question, sql), sql);
  }

  // A re-projection is only as unique as what it reads (6500 instead of 5500).
  for (const sql of [
    `WITH a AS (SELECT SalesDocumentId, ProductId FROM SalesDocumentLine GROUP BY SalesDocumentId, ProductId), b AS (SELECT * FROM a) ${HEADER} JOIN b ON b.SalesDocumentId = d.SalesDocumentId`,
    `WITH a AS (SELECT DISTINCT SalesDocumentId, ProductId FROM SalesDocumentLine), b AS (SELECT SalesDocumentId FROM a) ${HEADER} JOIN b ON b.SalesDocumentId = d.SalesDocumentId`,
    `WITH a AS (SELECT SalesDocumentId FROM SalesDocumentLine GROUP BY SalesDocumentId), b AS (SELECT a.SalesDocumentId FROM a JOIN SalesDocumentLine l2 ON l2.SalesDocumentId = a.SalesDocumentId) ${HEADER} JOIN b ON b.SalesDocumentId = d.SalesDocumentId`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }
});

test('join keys pin a child through chained equalities, but only to the parent row being summed', () => {
  const CUSTOMER_QUESTION = 'Show the top customers by total net sales amount in March 2026.';
  const AMT = 'amt AS (SELECT SalesDocumentId, SUM(NetAmount) AS a FROM SalesDocumentLine GROUP BY SalesDocumentId)';
  // amt is joined on qty's key, which is equated to the document's: correct
  // per-customer totals on the seeded demo DB (customer 1: 1700).
  for (const [question, sql] of [
    [
      CUSTOMER_QUESTION,
      `WITH qty AS (SELECT SalesDocumentId, SUM(Quantity) AS q FROM SalesDocumentLine GROUP BY SalesDocumentId), ${AMT} SELECT d.CustomerId, SUM(d.NetAmount) AS net, SUM(qty.q) AS q, SUM(amt.a) AS a FROM SalesDocument d JOIN qty ON qty.SalesDocumentId = d.SalesDocumentId JOIN amt ON amt.SalesDocumentId = qty.SalesDocumentId GROUP BY d.CustomerId`,
    ],
    [
      LINES_QUESTION,
      `WITH ${AMT} SELECT SUM(d.NetAmount) AS n FROM SalesDocument d, amt, SalesDocument d2 WHERE amt.SalesDocumentId = d2.SalesDocumentId AND d2.SalesDocumentId = d.SalesDocumentId`,
    ],
  ]) {
    assert.doesNotThrow(() => validateFor(question, sql), sql);
  }

  // Pinned to another SalesDocument row, not the one summed: 10500 and 5600
  // (document 1 counted twice) instead of 5500.
  for (const sql of [
    `WITH ${AMT} SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN SalesDocument d2 ON d2.CustomerId = d.CustomerId JOIN amt ON amt.SalesDocumentId = d2.SalesDocumentId`,
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} JOIN SalesDocument d2 ON SalesDocumentLineId = d2.SalesDocumentId`,
    `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES} JOIN SalesDocument d2 ON l.SalesDocumentLineId = (d2.SalesDocumentId)`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }
});

test('a number pins a numeric column, but not a string column it compares with numerically', () => {
  const DISTINCT_NAMES = 'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT DISTINCT SalesDocumentId, ProductNameSnapshot FROM SalesDocumentLine) x ON x.SalesDocumentId = d.SalesDocumentId';
  // Every non-numeric name equals 0: 6500 instead of 5500 on the seeded demo DB.
  assertFanOut(LINES_QUESTION, `${DISTINCT_NAMES} AND x.ProductNameSnapshot = 0`);
  assertFanOut(
    LINES_QUESTION,
    'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d JOIN (SELECT SalesDocumentId, ProductNameSnapshot FROM SalesDocumentLine GROUP BY SalesDocumentId, ProductNameSnapshot) x ON x.SalesDocumentId = d.SalesDocumentId AND x.ProductNameSnapshot = 0'
  );
  // A string literal is one value (650), and so is a number for an integer key.
  assert.doesNotThrow(() => validateFor(LINES_QUESTION, `${DISTINCT_NAMES} AND x.ProductNameSnapshot = 'Cane Sugar 2kg'`));
  assert.doesNotThrow(() =>
    validateFor(LINES_QUESTION, `SELECT SUM(d.NetAmount) AS n ${HEADER_LINES.replace('JOIN', 'LEFT JOIN')} AND l.SalesDocumentLineId = 1`)
  );
});

test('a UNION (DISTINCT) child is unique on its output columns; UNION ALL is not', () => {
  const HEADER = 'SELECT SUM(d.NetAmount) AS n FROM SalesDocument d';
  const ON = 'x ON x.SalesDocumentId = d.SalesDocumentId';
  // 5500 on the seeded demo DB.
  for (const sql of [
    `${HEADER} JOIN (SELECT SalesDocumentId FROM SalesDocumentLine UNION SELECT SalesDocumentId FROM SalesDocumentLine) ${ON}`,
    `${HEADER} JOIN (SELECT SalesDocumentId FROM SalesDocumentLine UNION DISTINCT SELECT SalesDocumentId FROM SalesDocumentLine WHERE Quantity > 1) ${ON}`,
  ]) {
    assert.doesNotThrow(() => validateFor(LINES_QUESTION, sql), sql);
  }
  // 6500 (two output columns) and 12000 (a trailing UNION ALL).
  for (const sql of [
    `${HEADER} JOIN (SELECT SalesDocumentId, ProductId FROM SalesDocumentLine UNION SELECT SalesDocumentId, ProductId FROM SalesDocumentLine) ${ON}`,
    `${HEADER} JOIN (SELECT SalesDocumentId FROM SalesDocumentLine UNION DISTINCT SELECT SalesDocumentId FROM SalesDocumentLine UNION ALL SELECT SalesDocumentId FROM SalesDocumentLine) ${ON}`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }
});

test('a CTE or derived parent is a fan-out when its own body or its grouping grain repeats the summed value', () => {
  const CUSTOMER_QUESTION = 'Show the top customers by total net sales amount in March 2026.';
  const T = `WITH t AS (SELECT d.SalesDocumentId, d.NetAmount, l.ProductId ${HEADER_LINES})`;
  // The header joined to its lines inside the CTE: 6500 instead of 5500 on
  // the seeded demo DB, also through a CTE chain, a line-level GROUP BY in
  // the body, or a window SUM over an inner MAX grouped by a line column (5100).
  for (const sql of [
    `${T} SELECT SUM(t.NetAmount) AS n FROM t`,
    `${T} SELECT t.ProductId, SUM(t.NetAmount) AS n FROM t GROUP BY t.ProductId`,
    `${T}, u AS (SELECT * FROM t) SELECT SUM(u.NetAmount) AS n FROM u`,
    `${T} SELECT SUM(NetAmount) AS n FROM t`,
    `WITH t AS (SELECT d.SalesDocumentId, d.NetAmount ${HEADER_LINES} GROUP BY d.SalesDocumentId, l.ProductId) SELECT SUM(t.NetAmount) AS n FROM t`,
    `${T} SELECT t.ProductId, SUM(MAX(t.NetAmount)) OVER () AS total FROM t GROUP BY t.ProductId`,
  ]) {
    assertFanOut(LINES_QUESTION, sql);
  }
  // Collapsed back to one row per document inside the body: 5500.
  for (const sql of [
    `WITH t AS (SELECT DISTINCT d.SalesDocumentId, d.NetAmount ${HEADER_LINES}) SELECT SUM(t.NetAmount) AS n FROM t`,
    `WITH t AS (SELECT d.SalesDocumentId, MAX(d.NetAmount) AS NetAmount, SUM(l.Quantity) AS q ${HEADER_LINES} GROUP BY d.SalesDocumentId) SELECT SUM(t.NetAmount) AS n FROM t`,
    `WITH t AS (SELECT d.SalesDocumentId, l.NetAmount, l.ProductId ${HEADER_LINES}) SELECT SUM(t.NetAmount) AS n FROM t`,
    'SELECT SUM(t.NetAmount) AS n FROM (SELECT d.SalesDocumentId, d.NetAmount FROM SalesDocument d WHERE EXISTS (SELECT 1 FROM SalesDocumentLine l WHERE l.SalesDocumentId = d.SalesDocumentId)) t',
  ]) {
    assert.doesNotThrow(() => validateFor(LINES_QUESTION, sql), sql);
  }

  // A body grouped by a foreign key has one row per referenced row: per-customer
  // totals joined back to the documents repeat per document (10500, not 5500),
  // and per-document line totals joined back to the lines repeat per line (6500).
  const CUSTOMER_TOTALS = 'WITH ct AS (SELECT CustomerId, SUM(NetAmount) AS total FROM SalesDocument GROUP BY CustomerId)';
  assertFanOut(CUSTOMER_QUESTION, `${CUSTOMER_TOTALS} SELECT SUM(ct.total) AS n FROM ct JOIN SalesDocument d ON d.CustomerId = ct.CustomerId`, {
    table: 'Customer',
    column: 'total',
    child: 'SalesDocument',
  });
  assertFanOut(
    LINES_QUESTION,
    'SELECT SUM(x.lt) AS n FROM SalesDocumentLine l JOIN (SELECT SalesDocumentId, SUM(NetAmount) AS lt FROM SalesDocumentLine GROUP BY SalesDocumentId) x ON x.SalesDocumentId = l.SalesDocumentId',
    { column: 'lt' }
  );
  for (const [question, sql] of [
    [CUSTOMER_QUESTION, `${CUSTOMER_TOTALS} SELECT c.CustomerName, SUM(ct.total) AS n FROM Customer c JOIN ct ON ct.CustomerId = c.CustomerId GROUP BY c.CustomerName`],
    [
      LINES_QUESTION,
      'SELECT SUM(l.NetAmount / x.lt) AS share, MAX(x.lt) AS biggest FROM SalesDocumentLine l JOIN (SELECT SalesDocumentId, SUM(NetAmount) AS lt FROM SalesDocumentLine GROUP BY SalesDocumentId) x ON x.SalesDocumentId = l.SalesDocumentId',
    ],
  ]) {
    assert.doesNotThrow(() => validateFor(question, sql), sql);
  }
});

test('one-to-one keys are skipped only when the FK is the sole primary-key column', () => {
  const column = (name, extra = {}) => ({ name, type: 'INTEGER', primaryKey: false, allowNull: true, ...extra });
  const promptContext = {
    tables: [
      { tableName: 'Invoice', includedColumns: [column('InvoiceId', { primaryKey: true, allowNull: false }), column('Total')], omittedColumnNames: [] },
      // Composite key (InvoiceId, LineNo): one invoice has many lines.
      {
        tableName: 'InvoiceLine',
        includedColumns: [
          column('InvoiceId', { primaryKey: true, allowNull: false }),
          column('LineNo', { primaryKey: true, allowNull: false }),
          column('Amount'),
        ],
        omittedColumnNames: [],
      },
      // Sole primary key that is also the FK: one extension row per invoice.
      { tableName: 'InvoiceExtra', includedColumns: [column('InvoiceId', { primaryKey: true, allowNull: false }), column('Note')], omittedColumnNames: [] },
    ],
    relationships: [
      { fromTable: 'InvoiceLine', fromColumn: 'InvoiceId', toTable: 'Invoice', toColumn: 'InvoiceId' },
      { fromTable: 'InvoiceExtra', fromColumn: 'InvoiceId', toTable: 'Invoice', toColumn: 'InvoiceId' },
    ],
  };
  const allowedTables = ['Invoice', 'InvoiceLine', 'InvoiceExtra'];

  assert.throws(
    () =>
      validateReadOnlySql(
        'SELECT SUM(i.Total) AS total FROM Invoice i JOIN InvoiceLine l ON l.InvoiceId = i.InvoiceId',
        allowedTables,
        { promptContext }
      ),
    (error) => error.code === 'FAN_OUT' && error.details.childTable === 'InvoiceLine'
  );
  assert.doesNotThrow(() =>
    validateReadOnlySql('SELECT SUM(i.Total) AS total FROM Invoice i JOIN InvoiceExtra x ON x.InvoiceId = i.InvoiceId', allowedTables, {
      promptContext,
    })
  );
});

test('accounting postings are a one-to-many child of the document too', () => {
  assertFanOut(
    POSTINGS_QUESTION,
    'SELECT SUM(d.NetAmount) AS net FROM SalesDocument d JOIN AccountingPosting p ON p.SalesDocumentId = d.SalesDocumentId',
    { child: 'AccountingPosting' }
  );
});

test('line-level, pre-aggregated, semi-joined and anti-joined shapes are accepted', () => {
  for (const [question, sql] of [
    [BRAND_QUESTION, `SELECT ROUND(SUM(COALESCE(l.NetAmount, 0)), 2) AS total_net_amount ${HEADER_LINES}`],
    [BRAND_QUESTION, `SELECT SUM(l.Quantity * l.SalePrice) AS revenue, SUM(l.NetAmount) AS net ${HEADER_LINES}`],
    [BRAND_QUESTION, `SELECT COUNT(DISTINCT d.SalesDocumentId) AS docs, MAX(d.NetAmount) AS biggest, MIN(d.NetAmount) AS smallest ${HEADER_LINES}`],
    [
      BRAND_QUESTION,
      'SELECT SUM(d.NetAmount) AS net FROM SalesDocument d WHERE EXISTS (SELECT 1 FROM SalesDocumentLine l WHERE l.SalesDocumentId = d.SalesDocumentId)',
    ],
    [
      BRAND_QUESTION,
      'SELECT SUM(d.NetAmount) AS net FROM SalesDocument d WHERE d.SalesDocumentId IN (SELECT l.SalesDocumentId FROM SalesDocumentLine l)',
    ],
    [
      BRAND_QUESTION,
      'SELECT SUM(d.NetAmount) AS net, SUM(x.qty) AS qty FROM SalesDocument d JOIN (SELECT l.SalesDocumentId, SUM(l.Quantity) AS qty FROM SalesDocumentLine l GROUP BY l.SalesDocumentId) x ON x.SalesDocumentId = d.SalesDocumentId',
    ],
    // Each UNION branch is its own SELECT block.
    [
      BRAND_QUESTION,
      `SELECT SUM(d.NetAmount) AS net FROM SalesDocument d UNION ALL SELECT SUM(l.NetAmount) AS net ${HEADER_LINES}`,
    ],
    [
      POSTINGS_QUESTION,
      'SELECT COUNT(*) AS document_count, SUM(d.NetAmount) AS net FROM SalesDocument d LEFT JOIN AccountingPosting p ON p.SalesDocumentId = d.SalesDocumentId WHERE p.AccountingPostingId IS NULL',
    ],
  ]) {
    const validated = validateFor(question, sql);
    assert.ok(Array.isArray(validated.guardrails.fanOutChecks), sql);
  }
});

test('the parent side of a join is never a fan-out (Customer is a parent of SalesDocument)', () => {
  const validated = validateFor(
    'Show the top customers by total net sales amount in March 2026.',
    'SELECT c.CustomerName, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId GROUP BY c.CustomerName'
  );
  assert.deepEqual(validated.guardrails.fanOutChecks, [{ aggregate: 'SUM', tables: ['SalesDocument'], fanOut: false }]);
});
