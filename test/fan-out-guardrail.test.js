import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOptimizedPrompt, buildSemanticPlan, loadNarrowSchema, validateReadOnlySql } from '../src/pipeline.js';

// Fan-out detector: SUM/AVG over a parent-grain column while the same SELECT
// block joins a one-to-many child (a table with a foreign key to the parent)
// repeats each parent value once per child row. This was the dominant real
// model error in the audit's live run (9 of 9 slipped through).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await loadNarrowSchema({
  modelsDir: path.join(REPO_ROOT, 'models'),
  schemaPath: path.join(REPO_ROOT, 'generated', 'schema.json'),
});

const BRAND_QUESTION = 'Show the top brands by net sales in March 2026.';
const POSTINGS_QUESTION = 'How many non-canceled sales documents do not have any accounting postings?';
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
});

test('fan-out inside a CTE body or a derived table is rejected', () => {
  assertFanOut(BRAND_QUESTION, `WITH x AS (SELECT l.ProductId, SUM(d.NetAmount) AS net ${HEADER_LINES} GROUP BY l.ProductId) SELECT SUM(x.net) AS net FROM x`);
  assertFanOut(BRAND_QUESTION, `SELECT t.net FROM (SELECT SUM(d.NetAmount) AS net ${HEADER_LINES}) t`);
});

test('IS NULL on an inner-joined child is not an anti-join', () => {
  assertFanOut(BRAND_QUESTION, `SELECT SUM(d.NetAmount) AS net ${HEADER_LINES} WHERE l.ProductId IS NULL`);
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
