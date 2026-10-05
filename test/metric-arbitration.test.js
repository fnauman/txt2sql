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
  // core_public_006: a genuine "without postings" question in other words keeps
  // the anti-join hint.
  for (const question of [
    'How many non-canceled sales documents do not have any accounting postings?',
    "Which documents don't have any accounting postings?",
    'Documents with no accounting postings',
  ]) {
    assert.ok(metricNames(buildSemanticPlan(question)).includes('missing_accounting_postings'), question);
  }
  const prompt = buildOptimizedPrompt(schema, 'How many non-canceled sales documents do not have any accounting postings?', {
    semanticPlan: buildSemanticPlan('How many non-canceled sales documents do not have any accounting postings?'),
  });
  assert.match(prompt.user, /Metric "missing_accounting_postings" matched not have any accounting postings/);
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

test('explicit metric phrases are enforced, also in count and existence questions', () => {
  const cases = [
    ['Show the top customers by total net sales amount in March 2026.', 'net_sales'],
    ['Show the top products by quantity sold in March 2026.', 'quantity_sold'],
    ['Which products brought in the most revenue in March 2026?', 'net_sales'],
    ['Show the top ledger accounts by debit amount in March 2026.', 'debit_amount'],
    ['Show the biggest debits by ledger account in March 2026.', 'debit_amount'],
    ['Who are our biggest buyers in March 2026?', 'net_sales'],
    ['How many units sold in March 2026?', 'quantity_sold'],
    // "revenue" is an explicit one-word metric phrase; count/existence wording
    // does not demote it.
    ['How many customers had revenue above 1000 in March 2026?', 'net_sales'],
    ['Which customers did we invoice the most revenue in March 2026?', 'net_sales'],
    ['Show revenue by customer for sales documents without accounting postings.', 'net_sales'],
    // "sales revenue" outside a ledger-account name is still net sales.
    ['What was our sales revenue in March 2026?', 'net_sales'],
  ];
  for (const [question, name] of cases) {
    const entry = metric(buildSemanticPlan(question), name);
    assert.equal(entry?.enforcement, 'enforced', question);
    assert.equal(entry.enforcementReason, 'explicit_metric_phrase', question);
  }

  // A count_advisory_synonyms word ("debit") only selects rows in a count question.
  const debitCount = metric(buildSemanticPlan('How many debit postings were made in March 2026?'), 'debit_amount');
  assert.equal(debitCount.enforcement, 'advisory');
  assert.equal(debitCount.enforcementReason, 'count_or_existence_intent');
});

test('an explicit one-word metric in a count question still rejects the wrong amount column', () => {
  for (const [question, sql] of [
    [
      'How many customers had revenue above 1000 in March 2026?',
      "SELECT COUNT(*) AS customer_count FROM (SELECT d.CustomerId FROM SalesDocument d WHERE d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY d.CustomerId HAVING SUM(d.NetPayableAmount) > 1000) t",
    ],
    [
      'Which customers did we invoice the most revenue in March 2026?',
      'SELECT c.CustomerName, SUM(d.NetPayableAmount) AS revenue FROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId GROUP BY c.CustomerName ORDER BY revenue DESC LIMIT 5',
    ],
  ]) {
    assert.throws(
      () => validateFor(question, sql),
      (error) => error.code === 'METRIC_COLUMN' && /semantic metric "net_sales"/.test(error.message),
      question
    );
  }
  assert.doesNotThrow(() =>
    validateFor(
      'How many customers had revenue above 1000 in March 2026?',
      "SELECT COUNT(*) AS customer_count FROM (SELECT d.CustomerId FROM SalesDocument d WHERE d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY d.CustomerId HAVING SUM(d.NetAmount) > 1000) t"
    )
  );
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
        synonyms: ['margin', 'gross margin', 'profit', 'profitable'],
        advisory_synonyms: ['profit'],
        count_advisory_synonyms: ['profitable'],
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
  // count_advisory_synonyms enforce in aggregate questions only.
  assert.equal(metric(buildSemanticPlan('Rank profitable stores', { semanticLayer }), 'margin').enforcement, 'enforced');
  const count = metric(buildSemanticPlan('How many profitable stores are there?', { semanticLayer }), 'margin');
  assert.equal(count.enforcement, 'advisory');
  assert.equal(count.enforcementReason, 'count_or_existence_intent');
  assert.equal(metric(buildSemanticPlan('How many stores have a gross margin above 10?', { semanticLayer }), 'margin').enforcement, 'enforced');
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

test('every enforced metric must use its preferred column (multi-metric questions)', () => {
  const lineJoins =
    'FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId';
  for (const question of [
    'Show net sales and quantity sold by product in March 2026.',
    'Show net sales and units sold by product in March 2026.',
  ]) {
    const plan = buildSemanticPlan(question);
    assert.deepEqual(
      plan.metrics.map((entry) => [entry.name, entry.enforcement]),
      [
        ['net_sales', 'enforced'],
        ['quantity_sold', 'enforced'],
        ['line_net_sales', 'enforced'],
      ],
      question
    );

    // Wrong amount column next to the right quantity column: main rejected this,
    // and so must every later version.
    for (const amount of ['l.TotalAmount', 'l.SalePrice']) {
      assert.throws(
        () => validateFor(question, `SELECT p.ProductName, SUM(${amount}) AS net_sales, SUM(l.Quantity) AS qty ${lineJoins} GROUP BY p.ProductName`),
        (error) => error.code === 'METRIC_COLUMN' && /semantic metric "line_net_sales"/.test(error.message),
        `${question} with ${amount}`
      );
    }
    // Right amount column, but a row count instead of the quantity.
    assert.throws(
      () => validateFor(question, `SELECT p.ProductName, SUM(l.NetAmount) AS net_sales, COUNT(*) AS qty ${lineJoins} GROUP BY p.ProductName`),
      (error) => error.code === 'METRIC_COLUMN' && /semantic metric "quantity_sold"/.test(error.message),
      question
    );

    const validated = validateFor(
      question,
      `SELECT p.ProductName, SUM(l.NetAmount) AS net_sales, SUM(l.Quantity) AS qty ${lineJoins} GROUP BY p.ProductName`
    );
    assert.deepEqual(validated.guardrails.warnings, []);
  }
});

test('a ledger account name consumes the metric words inside it', () => {
  // "Sales Revenue" is a general-ledger account here, not the net_sales metric.
  const question = 'Debit total for the Sales Revenue ledger account';
  const plan = buildSemanticPlan(question);
  assert.deepEqual(metricNames(plan), ['debit_amount']);
  assert.ok(entityNames(plan).includes('ledger_account'));
  assert.ok(
    plan.suppressedMatches.some(
      (match) => match.name === 'net_sales' && match.synonym === 'revenue' && match.suppressedBy === 'ledger_account'
    )
  );

  const validated = validateFor(
    question,
    "SELECT ROUND(SUM(p.DebitAmount), 2) AS total_debit FROM AccountingPosting p JOIN LedgerAccount a ON p.LedgerAccountId = a.LedgerAccountId WHERE a.AccountName LIKE '%Sales Revenue%'"
  );
  assert.deepEqual(validated.guardrails.warnings, []);

  // Other account names consume generic words too ("goods" is not a product,
  // "sold" is not a quantity).
  const cogs = buildSemanticPlan('Show credits posted to Cost of Goods Sold in March 2026.');
  assert.deepEqual(metricNames(cogs), ['credit_amount']);
  assert.ok(!entityNames(cogs).includes('product'));
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
