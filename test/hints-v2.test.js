import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';

import { BUSINESS_RULES, BUSINESS_RULES_V2, businessRulesFor, DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { buildOptimizedPrompt, buildQuestionContext, buildSemanticPlan, extractTemporalReferences, validateReadOnlySql } from '../src/pipeline.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import {
  applySemanticLayerOverlay,
  DEFAULT_SEMANTIC_LAYER_PATH,
  HINTS_V2_SEMANTIC_LAYER_OVERLAY_PATH,
  loadSemanticLayerForHintsVersion,
  loadSemanticLayerSync,
} from '../src/semantic-layer.js';

// Hints version 2 (docs/experiments/02-hints-v2.md), one test group per
// change. The case ids in the comments are the dev failures (error analysis of
// the Experiment 1 baseline) that motivated the change; every change is a
// general rule, not a fix for one wording.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

const texts = (question, hintsVersion) => extractTemporalReferences(question, { hintsVersion }).map((reference) => reference.originalText);

function questionContextOf(question, hintsVersion) {
  const user = buildOptimizedPrompt(schema, question, { hintsVersion }).user;
  return user.slice(user.indexOf('Question-specific context:'));
}

// --- temporal: no resolved range for a partly understood date phrase --------
// tpl_document_count_mar01_10_2026_785050 ("between 1 and 10 March 2026" ->
// all of March) and hard_asof_month_to_date_documents ("Today is 15 February
// 2026 ... this month so far" -> all of February) failed because the model
// obeyed the whole-month range and rule 4's "do not reinterpret";
// 1d11c5 / c55b7e ("January–March 2026" -> March only) carried the same
// wrong range.

test('v2 temporal: a day range, an as-of day, a month range or a shared year resolves nothing', () => {
  for (const question of [
    'How many sales documents were dated between 1 and 10 March 2026, inclusive?',
    'Today is 15 February 2026. How many sales documents have we recorded this month so far?',
    'As of 31 March 2026, what is our year-to-date gross amount?',
    'What was our turnover from 15 February 2026 through 15 March 2026, both days included?',
    'Top 3 customers by quantity purchased, January–March 2026.',
    'Number of sales documents for North District Market between January and March 2026.',
    'Turnover per month from November 2025 through February 2026.',
    'How did monthly takings develop between November 2025 and February 2026?',
    'Compare January and February 2026 net sales by customer in separate columns.',
    'Net sales since March 2026.',
    'Net sales as of March 2026.',
    'Net sales for March 2026 to date.',
    'Documents dated before Feb, 26.',
  ]) {
    assert.deepEqual(texts(question, 2), [], question);
    assert.ok(texts(question, 1).length > 0, `version 1 resolved a whole month: ${question}`);
  }
});

test('v2 temporal: a month phrase that is fully understood still resolves exactly as in version 1', () => {
  for (const question of [
    'Show the top customers by total net sales amount in March 2026.',
    'Show March 2025 and March 2026 turnover side by side.',
    'top 10 Products with good sales in Feb, 26 but zero sale in Mar, 26',
    'Monthly net sales from Online Order documents for December 2025.',
    'Show sales on March 12 and returns due Feb 29',
  ]) {
    assert.deepEqual(extractTemporalReferences(question, { hintsVersion: 2 }), extractTemporalReferences(question, { hintsVersion: 1 }), question);
  }
  assert.deepEqual(texts('Show March 2025 and March 2026 turnover side by side.', 2), ['March 2025', 'March 2026']);
  // The question context of a dropped phrase keeps the original wording.
  const context = buildQuestionContext('Count the documents between 1 and 10 Mar 2026.', { hintsVersion: 2 });
  assert.equal(context.normalizedQuestion, 'Count the documents between 1 and 10 Mar 2026.');
  assert.deepEqual(context.temporalReferences, []);
  assert.equal(buildQuestionContext('Count the documents between 1 and 10 Mar 2026.', { hintsVersion: 1 }).normalizedQuestion, 'Count the documents between 1 and 10 March 2026.');
});

test('v2 temporal: the prompt shows no whole-month range for a partial phrase, and rule 4 no longer forbids reinterpreting', () => {
  const question = 'How many sales documents were dated between 1 and 10 March 2026, inclusive?';
  assert.match(questionContextOf(question, 1), /"March 2026" => March 2026; .*date_col >= '2026-03-01' AND date_col < '2026-04-01'/);
  assert.match(questionContextOf(question, 2), /Resolved temporal references:\n- No explicit temporal references were resolved\./);

  const v1Rule = BUSINESS_RULES.find((rule) => rule.includes('do not reinterpret'));
  assert.ok(v1Rule);
  assert.ok(!BUSINESS_RULES_V2.includes(v1Rule));
  assert.ok(BUSINESS_RULES_V2.some((rule) => /exact for the phrases they quote/.test(rule) && /was not resolved: work out the window from the question itself/.test(rule)));
  assert.equal(businessRulesFor(1), BUSINESS_RULES);
  assert.equal(businessRulesFor(2), BUSINESS_RULES_V2);
  const system = buildOptimizedPrompt(schema, question, { hintsVersion: 2 }).system;
  assert.doesNotMatch(system, /do not reinterpret/);
});

// --- business rules: the ambiguous ones rewritten, shape rules added --------
// Rules 7, 18 and 26 offered alternatives as equivalent or forced a LIMIT
// (tpl_documents_posted_feb_2026_*, tpl_brand_net_sales_feb_2026_196b6b,
// hard_vocab_outlet_turnover_top1_mar_2026); count and single-total questions
// were answered with lists (core_public_004, paraphrase_public_004,
// tpl_urban_refresh_customers_q1_2026_809e2f, hard_ambiguous_sales_mar_2026).

const v2Rule = (pattern) => {
  const matches = BUSINESS_RULES_V2.filter((rule) => pattern.test(rule));
  assert.equal(matches.length, 1, String(pattern));
  return matches[0];
};

test('v2 rules: version 1 is untouched; version 2 rewrites eleven rules and adds three, in a fixed place', () => {
  assert.equal(BUSINESS_RULES.length, 27);
  assert.equal(BUSINESS_RULES_V2.length, 30);
  const removed = BUSINESS_RULES.filter((rule) => !BUSINESS_RULES_V2.includes(rule));
  const added = BUSINESS_RULES_V2.filter((rule) => !BUSINESS_RULES.includes(rule));
  assert.equal(removed.length, 11);
  assert.equal(added.length, 14);
  // Unchanged rules keep their relative order.
  assert.deepEqual(
    BUSINESS_RULES_V2.filter((rule) => BUSINESS_RULES.includes(rule)),
    BUSINESS_RULES.filter((rule) => !removed.includes(rule))
  );
  // The three new rules follow the anti-join rule and precede the ranking rules.
  const antiJoin = BUSINESS_RULES_V2.findIndex((rule) => rule.startsWith('For "not in" or "did not sell in"'));
  assert.match(BUSINESS_RULES_V2[antiJoin + 1], /^Count questions/);
  assert.match(BUSINESS_RULES_V2[antiJoin + 2], /^A question asking for one total/);
  assert.match(BUSINESS_RULES_V2[antiJoin + 3], /^Time grain:/);
  assert.match(BUSINESS_RULES_V2[antiJoin + 4], /^Ranking limits:/);

  const v1System = buildOptimizedPrompt(schema, 'anything', { hintsVersion: 1 }).system;
  const v2System = buildOptimizedPrompt(schema, 'anything', { hintsVersion: 2 }).system;
  for (const rule of BUSINESS_RULES) {
    assert.ok(v1System.includes(rule));
  }
  for (const rule of BUSINESS_RULES_V2) {
    assert.ok(v2System.includes(rule));
  }
});

test('v2 rules: posting dates, brands and ranking limits are unambiguous', () => {
  const posting = v2Rule(/posted or posting-date questions about sales documents/);
  assert.match(posting, /filter SalesDocument\.PostingDate on SalesDocument itself and do not join AccountingPosting/);
  assert.match(posting, /AccountingPosting\.PostingDate only for questions about ledger postings, debits or credits/);
  assert.doesNotMatch(posting, /SalesDocument\.PostingDate or AccountingPosting\.PostingDate/);
  assert.match(v2Rule(/^For sales date questions/), /unless the question says posted or posting date, or due date/);

  const brand = v2Rule(/^For brand analysis/);
  assert.match(brand, /through Product\.BrandId/);
  assert.match(brand, /Do not use the ProductBrand bridge for brand results/);
  assert.doesNotMatch(brand, /BrandId or ProductBrand/);

  const limits = v2Rule(/^Ranking limits:/);
  assert.match(limits, /"top N".*gets LIMIT N/);
  assert.match(limits, /singular superlative .* gets LIMIT 1/);
  assert.match(limits, /"Rank", "order", "sort" or "from highest to lowest" with no number returns every row \(no LIMIT\)/);
  assert.ok(!BUSINESS_RULES_V2.some((rule) => /always apply a LIMIT 10/.test(rule)));
});

test('v2 rules: count, single-total and time-grain shapes; money, unit, cancellation, campaign and account defaults', () => {
  assert.match(v2Rule(/^Count questions/), /one row with one number.*no GROUP BY and no name columns, unless the question also says per, by, each or every\. Count entities by their ID, not by name\. "How many units" is a SUM/);
  assert.match(v2Rule(/^A question asking for one total/), /returns one row: aggregate without GROUP BY, also when it filters to one named customer, store, product or campaign/);
  assert.match(v2Rule(/^Time grain:/), /one row per calendar month .*DATE_FORMAT\(date_col, '%Y-%m'\).*never replace the period label with a name column/);
  assert.match(v2Rule(/^For document-level money totals/), /turnover, spend, order value\), use SalesDocument\.NetAmount\. Use SalesDocument\.GrossAmount only when the question says gross or tax included/);
  assert.match(v2Rule(/^For product-level analysis/), /SalesDocumentLine\.NetAmount for sales, revenue or turnover; use SalesDocumentLine\.TotalAmount or SalePrice only when the question asks/);
  assert.match(v2Rule(/^For quantity metrics/), /SalesDocumentLine\.ProductId IS NOT NULL \(lines without a product, such as delivery fees, are not units sold\)/);
  assert.match(v2Rule(/exclude them with IFNULL/), /wherever SalesDocument appears: also when it is joined only for a date .*inside a subquery or NOT EXISTS, and in the ON clause of a LEFT JOIN used as an anti-join/);
  assert.match(v2Rule(/^Campaign sales, units and customers/), /do not use SalesDocument\.CampaignId for campaign results/);
  assert.match(v2Rule(/"account" means LedgerAccount/), /LedgerAccount\.AccountCode, never on LedgerAccountId, and an account name with LIKE on LedgerAccount\.AccountName/);
});

// --- semantic layer: the hints-v2 overlay ------------------------------------
// metadata/semantic-layer.json (and its template) are unchanged; version 2
// reads metadata/semantic-layer.hints-v2.json on top. Motivating dev
// failures: money words with no metric fell back to BillTotalAmount
// (hard_vocab_department_turnover_feb_2026, hard_entity_lakeside_spend_q1_2026,
// the average-order-value cases 30dc49 / 146d60 / afb751 / 820a8d,
// tpl_outstanding_balance_due_apr_2026_571390 "open amount"); the brand entity
// preferred the partial ProductBrand bridge (tpl_brand_net_sales_feb_2026_196b6b);
// "stopped selling" made a count question a quantity one (paraphrase_public_004);
// units counted delivery-fee lines (214320, 12ab97, 2f8130, 1d11c5);
// "account" pulled the customer entity into ledger questions
// (tpl_account_net_movement_feb_2026_c1256b).

const metricOf = (plan, name) => plan.metrics.find((metric) => metric.name === name) || null;
const v1Plan = (question) => buildSemanticPlan(question, { hintsVersion: 1 });
const v2Plan = (question) => buildSemanticPlan(question, { hintsVersion: 2 });

test('overlay mechanics: an entry replaces the same-named base entry in place, a new one is appended, typos are refused', () => {
  const base = { version: 1, entities: [{ name: 'a', synonyms: ['x'] }, { name: 'b' }], metrics: [{ name: 'm' }], join_paths: [{ name: 'j' }] };
  const merged = applySemanticLayerOverlay(base, { version: '1+o', entities: [{ name: 'b', synonyms: ['y'] }, { name: 'c' }] });
  assert.deepEqual(merged, { version: '1+o', entities: [{ name: 'a', synonyms: ['x'] }, { name: 'b', synonyms: ['y'] }, { name: 'c' }], metrics: [{ name: 'm' }], join_paths: [{ name: 'j' }] });
  assert.deepEqual(base.entities[1], { name: 'b' }, 'the base is not modified');
  assert.throws(() => applySemanticLayerOverlay(base, { metric: [] }), /unknown keys: metric/);
  assert.throws(() => applySemanticLayerOverlay(base, { metrics: [{ synonyms: ['z'] }] }), /entry without a name/);
  assert.throws(() => applySemanticLayerOverlay(base, { metrics: {} }), /"metrics" must be an array/);
});

test('version 1 reads semantic-layer.json alone (identical to its template); version 2 changes only the overlay entries', () => {
  assert.equal(loadSemanticLayerForHintsVersion(1), loadSemanticLayerSync());
  assert.equal(
    fs.readFileSync(DEFAULT_SEMANTIC_LAYER_PATH, 'utf8'),
    fs.readFileSync(path.join(REPO_ROOT, 'metadata/semantic-layer.template.json'), 'utf8')
  );
  const v1 = loadSemanticLayerForHintsVersion(1);
  const v2 = loadSemanticLayerForHintsVersion(2);
  const overlay = JSON.parse(fs.readFileSync(HINTS_V2_SEMANTIC_LAYER_OVERLAY_PATH, 'utf8'));
  assert.equal(v2.version, '1+hints-v2');
  for (const kind of ['filter_hints', 'value_aliases', 'join_paths', 'clarification_rules']) {
    assert.deepEqual(v2[kind], v1[kind], kind);
  }
  for (const kind of ['entities', 'metrics']) {
    const changed = new Set(overlay[kind].map((entry) => entry.name));
    assert.deepEqual(
      v2[kind].filter((entry) => !changed.has(entry.name)),
      v1[kind].filter((entry) => !changed.has(entry.name)),
      `${kind} outside the overlay are unchanged`
    );
  }
  assert.deepEqual(overlay.entities.map((entry) => entry.name), ['customer', 'brand']);
  assert.deepEqual(overlay.metrics.map((entry) => entry.name), [
    'net_sales',
    'line_net_sales',
    'quantity_sold',
    'document_count',
    'debit_amount',
    'credit_amount',
    'average_order_value',
    'outstanding_balance',
  ]);
});

test('v2 layer: brands prefer Brand only, so the ProductBrand join hints are gone', () => {
  const question = 'How much revenue did each brand bring in during February 2026?';
  const joins = (plan) => plan.joinHints.map((hint) => hint.name);
  assert.ok(joins(v1Plan(question)).includes('product_brand_to_brand'));
  assert.ok(!joins(v2Plan(question)).some((name) => name.startsWith('product_brand')));
  assert.ok(joins(v2Plan(question)).includes('product_to_brand'));
  assert.ok(!v2Plan(question).requiredTables.includes('ProductBrand'));
  assert.doesNotMatch(buildOptimizedPrompt(schema, question).user, /prefer tables Brand, ProductBrand/);
});

test('v2 layer: turnover and spend are net sales (advisory: never a rejection), with the money-word convention in the hint', () => {
  for (const [question, word] of [
    ['Show turnover by department for February 2026.', 'turnover'],
    ['How much did Lakeside Wholesale spend with us in Q1 2026?', 'spend'],
    ['Which 3 clients spent the most with us in December 2025?', 'spent'],
  ]) {
    assert.equal(metricOf(v1Plan(question), 'net_sales'), null, question);
    const metric = metricOf(v2Plan(question), 'net_sales');
    assert.deepEqual([metric.matchedSynonyms, metric.enforcement], [[word], 'advisory'], question);
  }
  // A product dimension still derives the line-level metric.
  assert.ok(metricOf(v2Plan('Show turnover by department for February 2026.'), 'line_net_sales'));
  const hint = buildOptimizedPrompt(schema, 'Which outlet had the highest turnover in March 2026?').user;
  assert.match(hint, /Metric "net_sales" matched turnover .*prefer COALESCE\(SalesDocument\.NetAmount, 0\).*apply default filters IFNULL\(SalesDocument\.IsCanceled, 0\) = 0\. Sales, revenue, turnover and spend are net of tax: SalesDocument\.NetAmount\. Use GrossAmount only when the question says gross/);
  // "gross turnover" keeps its gold: advisory never rejects GrossAmount.
  const gross = 'How much gross turnover (incl. tax) did each store record in February 2026?';
  const prompt = buildOptimizedPrompt(schema, gross);
  const sql = "SELECT s.LocationName, ROUND(SUM(COALESCE(d.GrossAmount, 0)), 2) AS total_gross_amount FROM SalesDocument d JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId WHERE IFNULL(d.IsCanceled, 0) = 0 GROUP BY s.StoreLocationId, s.LocationName";
  const validated = validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument', 'StoreLocation'] } });
  assert.deepEqual(validated.guardrails.warnings.map((warning) => [warning.code, warning.metric]), [['METRIC_COLUMN_NOT_USED', 'net_sales']]);
});

test('v2 layer: average order value and open amounts get a metric, enforced on their explicit phrases', () => {
  const aov = metricOf(v2Plan('What was the average order value in March 2026?'), 'average_order_value');
  assert.equal(aov.enforcement, 'enforced');
  assert.equal(aov.preferredExpression, 'AVG(COALESCE(SalesDocument.NetAmount, 0))');
  assert.equal(metricOf(v1Plan('What was the average order value in March 2026?'), 'average_order_value'), null);
  const open = metricOf(v2Plan('Total open amount on documents with a due date in April 2026.'), 'outstanding_balance');
  assert.deepEqual([open.matchedSynonyms, open.enforcement, open.preferredColumns], [['open amount'], 'enforced', ['SalesDocument.BalanceAmount']]);
  assert.equal(metricOf(v2Plan('How much is still unpaid on March 2026 sales?'), 'outstanding_balance').enforcement, 'advisory');

  const prompt = buildOptimizedPrompt(schema, 'What was the average order value in March 2026?');
  const allowed = prompt.tables.map((table) => table.tableName);
  const validate = (sql) => validateReadOnlySql(sql, allowed, { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
  assert.throws(() => validate("SELECT AVG(BillTotalAmount) AS aov FROM SalesDocument WHERE DocumentDate >= '2026-03-01'"), { code: 'METRIC_COLUMN' });
  assert.doesNotThrow(() => validate("SELECT ROUND(AVG(COALESCE(d.NetAmount, 0)), 2) AS avg_order_value FROM SalesDocument d WHERE IFNULL(d.IsCanceled, 0) = 0"));
});

test('v2 layer: units count product lines only, "stopped selling" is no quantity synonym, "account" is no customer', () => {
  const units = metricOf(v2Plan('Which three customers bought the most units in Q1 2026?'), 'quantity_sold');
  assert.deepEqual([units.matchedSynonyms, units.enforcement], [['units'], 'advisory']);
  assert.deepEqual(units.defaultFilters, ['SalesDocumentLine.ProductId IS NOT NULL', 'IFNULL(SalesDocument.IsCanceled, 0) = 0']);
  assert.equal(metricOf(v1Plan('Which three customers bought the most units in Q1 2026?'), 'quantity_sold'), null);
  const question = 'How many units did we sell in total in December 2025?';
  assert.ok(v2Plan(question).defaultFilters.includes('SalesDocumentLine.ProductId IS NOT NULL'));
  assert.ok(!v1Plan(question).defaultFilters.includes('SalesDocumentLine.ProductId IS NOT NULL'));
  assert.match(
    buildOptimizedPrompt(schema, question).user,
    /Metric "quantity_sold" matched sell, units .*apply default filters SalesDocumentLine\.ProductId IS NOT NULL AND IFNULL\(SalesDocument\.IsCanceled, 0\) = 0\. Units sold count product lines only/
  );
  assert.doesNotMatch(buildOptimizedPrompt(schema, question, { hintsVersion: 1 }).user, /apply default filters SalesDocumentLine\.ProductId/);

  const stopped = 'How many SKUs sold in February 2026 but stopped selling in March 2026?';
  assert.deepEqual(metricOf(v1Plan(stopped), 'quantity_sold').matchedSynonyms, ['sold', 'sell', 'stopped selling']);
  assert.deepEqual(metricOf(v2Plan(stopped), 'quantity_sold').matchedSynonyms, ['sold', 'sell']);

  const ledger = 'For each account, by name, what is debit minus credit on postings of sales dated February 2026?';
  assert.ok(v1Plan(ledger).entities.some((entity) => entity.name === 'customer'));
  assert.ok(!v2Plan(ledger).entities.some((entity) => entity.name === 'customer'));
  assert.ok(v2Plan(ledger).entities.some((entity) => entity.name === 'ledger_account'));
  assert.ok(v2Plan('Top 3 customers by gross amount in April 2026.').entities.some((entity) => entity.name === 'customer'));
});

test('v2 layer: ledger metric hints state when SalesDocument is joined and its cancellation filter', () => {
  const prompt = buildOptimizedPrompt(schema, 'Show the top ledger accounts by debit amount in March 2026.').user;
  assert.match(prompt, /Metric "debit_amount" matched .*Join SalesDocument only to filter on a document column \(such as DocumentDate\), and then also apply IFNULL\(SalesDocument\.IsCanceled, 0\) = 0; a PostingDate filter needs no SalesDocument join/);
  assert.doesNotMatch(buildOptimizedPrompt(schema, 'Show the top ledger accounts by debit amount in March 2026.', { hintsVersion: 1 }).user, /Join SalesDocument only/);
});

// --- entity display columns: not for a word a metric measures ---------------
// "What were sales in March 2026?" matched both the sales_document entity
// (display columns DocumentNo, DocumentDate) and net_sales, and the model
// listed one row per document (hard_ambiguous_sales_mar_2026; also
// tpl_outstanding_balance_mar_2026_c15bb6).

const entityOf = (plan, name) => plan.entities.find((entity) => entity.name === name) || null;

test('v2 display columns: an entity word inside a metric of that grain loses its display columns, nothing else', () => {
  for (const question of ['What were sales in March 2026?', 'How much is still unpaid on March 2026 sales?', 'Average order value by store location in Q1 2026.', 'Show net sales by product category in March 2026.']) {
    assert.deepEqual(entityOf(v1Plan(question), 'sales_document').displayColumns, ['SalesDocument.DocumentNo', 'SalesDocument.DocumentDate'], question);
    const entity = entityOf(v2Plan(question), 'sales_document');
    assert.deepEqual(entity.displayColumns, [], question);
    assert.deepEqual(entity.preferredTables, ['SalesDocument'], 'the tables stay');
    assert.deepEqual(entity.defaultFilters, ['IFNULL(SalesDocument.IsCanceled, 0) = 0'], 'the default filters stay');
    assert.ok(entity.displayColumnsSuppressedBy.length > 0);
    assert.ok(!v2Plan(question).preferredColumns.includes('SalesDocument.DocumentNo'));
  }
  assert.match(
    buildOptimizedPrompt(schema, 'What were sales in March 2026?').user,
    /- Entity "sales_document" matched sale, sales; prefer tables SalesDocument; apply default filters IFNULL\(SalesDocument\.IsCanceled, 0\) = 0\./
  );
  // A document the question asks about keeps them, and so does an entity a
  // metric phrase names as its dimension ("biggest buyers" = net sales per customer).
  assert.deepEqual(entityOf(v2Plan('Which sales document had the highest net amount in March 2026?'), 'sales_document').displayColumns, ['SalesDocument.DocumentNo', 'SalesDocument.DocumentDate']);
  assert.deepEqual(entityOf(v2Plan('Who are our biggest buyers in March 2026?'), 'customer').displayColumns, ['Customer.CustomerName', 'Customer.CustomerCode']);
  assert.deepEqual(entityOf(v2Plan('Show net sales by customer for June 2026.'), 'customer').displayColumns, ['Customer.CustomerName', 'Customer.CustomerCode']);
  assert.equal(entityOf(v1Plan('What were sales in March 2026?'), 'sales_document').displayColumnsSuppressedBy, undefined);
});
