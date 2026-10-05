import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOptimizedPrompt,
  buildSemanticPlan,
  detectCountOrExistenceIntent,
  validateReadOnlySql,
} from '../src/pipeline.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Metric guardrail arbitration (audit SAFE-6 / EVAL-RET-3): longest-span
// arbitration across semantic-layer entries, contiguous (negation-preserving)
// phrase matching, and advisory vs enforced metrics.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Compiled in memory from the models, so tests never write generated/schema.json.
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

function metricNames(plan) {
  return plan.metrics.map((metric) => metric.name);
}

function entityNames(plan) {
  return plan.entities.map((entity) => entity.name);
}

function metric(plan, name) {
  return plan.metrics.find((entry) => entry.name === name);
}

function validateFor(question, sql) {
  const semanticPlan = buildSemanticPlan(question);
  const prompt = buildOptimizedPrompt(schema, question, { semanticPlan });
  return validateReadOnlySql(
    sql,
    prompt.tables.map((table) => table.tableName),
    { promptContext: prompt.context }
  );
}

test('a multi-word entity span consumes shorter synonyms of other entries', () => {
  const plan = buildSemanticPlan('How many sales documents were posted in March 2026?');
  assert.ok(entityNames(plan).includes('sales_document'));
  assert.ok(!metricNames(plan).includes('net_sales'), '"sales documents" must not fire net_sales');
  assert.ok(
    plan.suppressedMatches.some(
      (match) => match.name === 'net_sales' && match.synonym === 'sales' && match.suppressedBy === 'sales_document'
    )
  );

  const creditMemo = buildSemanticPlan('How many Credit Memo documents were issued in March 2026?');
  assert.ok(entityNames(creditMemo).includes('document_type'));
  assert.ok(!metricNames(creditMemo).includes('credit_amount'), '"credit memo" must not fire credit_amount');

  // "ledger accounts" consumes "accounts", so the customer entity stays out.
  const ledger = buildSemanticPlan('Show the top ledger accounts by debit amount in March 2026.');
  assert.ok(entityNames(ledger).includes('ledger_account'));
  assert.ok(!entityNames(ledger).includes('customer'));
});

test('a metric phrase consumes competing metrics but not the entity it names', () => {
  // "product sales" is the line-level metric; the header metric's "sales" is inside it.
  const plan = buildSemanticPlan('Show sparkling water product sales by branch');
  assert.ok(metricNames(plan).includes('line_net_sales'));
  assert.ok(!metricNames(plan).includes('net_sales'));
  assert.ok(entityNames(plan).includes('product'), 'the entity named inside a metric phrase still matches');

  const buyers = buildSemanticPlan('Who are our biggest buyers in March 2026?');
  assert.ok(metricNames(buyers).includes('net_sales'));
});

test('multi-word synonyms match as contiguous phrases, so negations matter', () => {
  // The stopword "without" used to be stripped, so any mention of postings fired
  // the anti-join metric.
  for (const question of [
    'Show accounting postings for March 2026',
    'List postings by ledger account',
    'How many sales documents were posted in March 2026?',
    'Show the poster campaign',
  ]) {
    assert.ok(!metricNames(buildSemanticPlan(question)).includes('missing_accounting_postings'), question);
  }
  assert.ok(metricNames(buildSemanticPlan('Which documents are without postings?')).includes('missing_accounting_postings'));
  assert.ok(
    metricNames(buildSemanticPlan('How many sales documents never made it into accounting postings?')).includes(
      'missing_accounting_postings'
    )
  );
});

test('metrics matched only through generic words are advisory', () => {
  const cases = [
    ['How many sales invoices did Summit Grocers get?', 'net_sales', 'generic_terms_only'],
    ['Outstanding sales balance by customer', 'net_sales', 'generic_terms_only'],
    ['Which sparkling water products did we sell in March 2026?', 'quantity_sold', 'generic_terms_only'],
    ['How many products were sold in February 2026 but not in March 2026?', 'quantity_sold', 'generic_terms_only'],
    ['Which SKUs moved the most in March 2026?', 'quantity_sold', 'generic_terms_only'],
  ];
  for (const [question, name, reason] of cases) {
    const entry = metric(buildSemanticPlan(question), name);
    assert.ok(entry, `${question} should still hint ${name}`);
    assert.equal(entry.enforcement, 'advisory', question);
    assert.equal(entry.enforcementReason, reason, question);
  }
});

test('explicit metric phrases are enforced, also in count questions when multi-word', () => {
  const cases = [
    ['Show the top customers by total net sales amount in March 2026.', 'net_sales'],
    ['Show the top products by quantity sold in March 2026.', 'quantity_sold'],
    ['Which products brought in the most revenue in March 2026?', 'net_sales'],
    ['Show the top ledger accounts by debit amount in March 2026.', 'debit_amount'],
    ['Who are our biggest buyers in March 2026?', 'net_sales'],
    ['How many units sold in March 2026?', 'quantity_sold'],
  ];
  for (const [question, name] of cases) {
    assert.equal(metric(buildSemanticPlan(question), name)?.enforcement, 'enforced', question);
  }

  // A single-word metric synonym in a count question is advisory.
  const debitCount = metric(buildSemanticPlan('How many debit postings were made in March 2026?'), 'debit_amount');
  assert.equal(debitCount.enforcement, 'advisory');
  assert.equal(debitCount.enforcementReason, 'count_or_existence_intent');
});

test('the derived line-level metric inherits the strength of the sales match', () => {
  const advisory = buildSemanticPlan('What were the total sales for the Urban Refresh campaign in March 2026?');
  assert.equal(metric(advisory, 'line_net_sales').enforcement, 'advisory');
  const enforced = buildSemanticPlan('Show the top brands by net sales in March 2026.');
  assert.equal(metric(enforced, 'line_net_sales').enforcement, 'enforced');
});

test('detectCountOrExistenceIntent recognizes count, list and existence phrasing', () => {
  for (const question of [
    'How many active customers do we have?',
    'Number of invoices per store',
    'Show sales document count by document type',
    'Which customers do not have any orders?',
    "Which customers don't have any orders?",
    'Documents without postings',
    'Which products have we never sold?',
    'Which sparkling water products did we sell?',
  ]) {
    assert.ok(detectCountOrExistenceIntent(question), question);
  }
  for (const question of ['Show the top customers by net sales', 'Total revenue by month']) {
    assert.ok(!detectCountOrExistenceIntent(question), question);
  }
});

test('advisory metrics are data-driven through advisory_synonyms', () => {
  const semanticLayer = {
    version: 1,
    entities: [],
    metrics: [
      {
        name: 'margin',
        synonyms: ['margin', 'gross margin', 'profit'],
        advisory_synonyms: ['profit'],
        preferred_columns: ['SalesDocument.GrossAmount'],
        preferred_tables: ['SalesDocument'],
      },
    ],
    filter_hints: [],
    value_aliases: [],
    join_paths: [],
    clarification_rules: [],
  };
  assert.equal(metric(buildSemanticPlan('Show profit by store', { semanticLayer }), 'margin').enforcement, 'advisory');
  assert.equal(metric(buildSemanticPlan('Show gross margin by store', { semanticLayer }), 'margin').enforcement, 'enforced');
});

test('advisory metrics stay prompt hints and say they are weak matches', () => {
  const question = 'Which sparkling water products did we sell in March 2026?';
  const prompt = buildOptimizedPrompt(schema, question, { semanticPlan: buildSemanticPlan(question) });
  assert.match(prompt.user, /Metric "quantity_sold" matched sell \(weak match: use this measure only if the question asks for it/);
});

test('an advisory metric mismatch is a guardrail warning, not a rejection', () => {
  const validated = validateFor(
    'Which sparkling water products did we sell in March 2026?',
    "SELECT DISTINCT p.ProductName FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId WHERE p.ProductName LIKE '%sparkling water%'"
  );
  assert.deepEqual(
    validated.guardrails.warnings.map((warning) => [warning.code, warning.metric, warning.enforcement]),
    [['METRIC_COLUMN_NOT_USED', 'quantity_sold', 'advisory']]
  );
});

test('an enforced metric still rejects the wrong amount column', () => {
  assert.throws(
    () =>
      validateFor(
        'Show the top customers by total net sales amount in March 2026.',
        'SELECT c.CustomerName, ROUND(SUM(d.NetPayableAmount), 2) AS total_net_amount FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId GROUP BY c.CustomerName'
      ),
    (error) => error.code === 'METRIC_COLUMN' && error.layer === 'guardrail' && /semantic metric "net_sales"/.test(error.message)
  );
});

test('when several metrics are enforced, using one of them satisfies the check', () => {
  // "Sales Revenue" is a ledger account name, but "revenue" still matches net_sales.
  const validated = validateFor(
    'Debit total for the Sales Revenue ledger account',
    "SELECT ROUND(SUM(p.DebitAmount), 2) AS total_debit FROM AccountingPosting p JOIN LedgerAccount a ON p.LedgerAccountId = a.LedgerAccountId WHERE a.AccountName LIKE '%Sales Revenue%'"
  );
  assert.deepEqual(
    validated.guardrails.warnings.map((warning) => [warning.metric, warning.reason]),
    [['net_sales', 'another_enforced_metric_used']]
  );
});

test('count questions whose wording mentions sales pass with plain COUNT SQL', () => {
  for (const [question, sql] of [
    [
      'Show sales document count by document type in March 2026.',
      'SELECT t.DocumentTypeName, COUNT(*) AS document_count FROM SalesDocument d JOIN DocumentType t ON d.DocumentTypeId = t.DocumentTypeId GROUP BY t.DocumentTypeName',
    ],
    ['How many sales invoices were cancelled in March 2026?', 'SELECT COUNT(*) AS document_count FROM SalesDocument d WHERE d.IsCanceled = 1'],
    [
      'Show average sale price per product',
      'SELECT p.ProductName, AVG(l.SalePrice) AS avg_price FROM SalesDocumentLine l JOIN Product p ON p.ProductId = l.ProductId GROUP BY p.ProductName',
    ],
  ]) {
    assert.doesNotThrow(() => validateFor(question, sql), question);
  }
});
