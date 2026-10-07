import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { BUSINESS_RULES, BUSINESS_RULES_V2, businessRulesFor, DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { createValidatorProbe, verifyCase } from '../src/eval/verify.js';
import {
  buildOptimizedPrompt,
  buildQuestionContext,
  buildSemanticPlan,
  extractTemporalReferences,
  retrieveRelevantTables,
  scoreTableDetailed,
  validateReadOnlySql,
} from '../src/pipeline.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import {
  applySemanticLayerOverlay,
  clearSemanticLayerCache,
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

test('v2 temporal: a shared-year month list with a serial (Oxford) comma resolves nothing', () => {
  // Review finding: "February, and" before "March 2026" matched neither the
  // comma nor the conjunction alone, so March was resolved as a whole month.
  for (const question of [
    'Net sales for January, February, and March 2026.',
    'Net sales for January, February, or March 2026.',
    'Net sales for Jan, Feb, & Mar 2026.',
    'Net sales for January,and February 2026.',
    'Net sales for January , and February 2026.',
  ]) {
    assert.deepEqual(texts(question, 2), [], question);
    assert.ok(texts(question, 1).length > 0, `version 1 resolved a whole month: ${question}`);
  }
  // The forms without the serial comma are unchanged.
  for (const question of ['Net sales for January, February and March 2026.', 'Net sales for January, February, March 2026.']) {
    assert.deepEqual(texts(question, 2), [], question);
  }
  // A month with its own year after a serial comma still resolves, as in version 1.
  const ownYears = 'Compare net sales in March 2025, and March 2026.';
  assert.deepEqual(texts(ownYears, 2), ['March 2025', 'March 2026']);
  assert.deepEqual(extractTemporalReferences(ownYears, { hintsVersion: 2 }), extractTemporalReferences(ownYears, { hintsVersion: 1 }));
});

test('v2 temporal: a shared-year month list joined by any list connector resolves no month alone', () => {
  // Third review: "and/or", "plus", "as well as", "and also" and semicolons
  // matched neither the comma nor the conjunctions, so the last month of the
  // list was resolved as a whole month on its own, as in version 1.
  for (const question of [
    'Net sales for January, February and/or March 2026.',
    'Net sales for January, February, and/or March 2026.',
    'Net sales for January, February, plus March 2026.',
    'Net sales for January, February plus March 2026.',
    'Net sales for January, February, as well as March 2026.',
    'Net sales for January, February, and also March 2026.',
    'Net sales for January, February, and then March 2026.',
    'Net sales for neither January, February, nor March 2026.',
    'Net sales for January; February; and March 2026.',
    'Net sales for January; February; March 2026.',
    'Compare January vs February 2026 net sales.',
    'Compare January vs. February 2026 net sales.',
    'Compare January versus February 2026 net sales.',
    // Fourth review: a slash, plus or bar between the months, and the
    // longer connectors, still resolved the last month alone.
    'Net sales for Jan/Feb 2026.',
    'Net sales for Jan/Feb/Mar 2026.',
    'Net sales for January / February / March 2026.',
    'Net sales for January, February / March 2026.',
    'Net sales for Jan + Feb 2026.',
    'Net sales for January | February | March 2026.',
    'Net sales for January, February or/and March 2026.',
    'Net sales for January, February, along with March 2026.',
    'Net sales for January, February, together with March 2026.',
    'Net sales for January, February, alongside March 2026.',
    'Net sales for January, February, then March 2026.',
    'Net sales for January, February, and finally March 2026.',
    'Net sales for January, February, and lastly March 2026.',
    'Net sales for January, February, but also March 2026.',
    'Net sales for January, February, and in March 2026.',
    'Net sales in January, in February and in March 2026.',
    'Compare January compared with February 2026 net sales.',
    'Net sales for January, February, as against March 2026.',
  ]) {
    assert.deepEqual(texts(question, 2), [], question);
    assert.ok(texts(question, 1).length > 0, `version 1 resolved a whole month: ${question}`);
    assert.match(questionContextOf(question, 2), /- No explicit temporal references were resolved\./, question);
  }
  // Months with their own years, and lists of other things, still resolve.
  for (const [question, expected] of [
    ['Compare net sales in March 2025 plus March 2026.', ['March 2025', 'March 2026']],
    ['Compare net sales in March 2025 vs March 2026.', ['March 2025', 'March 2026']],
    ['Compare net sales in March 2025; and March 2026.', ['March 2025', 'March 2026']],
    ['Compare net sales in March 2025/March 2026.', ['March 2025', 'March 2026']],
    ['Compare net sales in March 2025 + March 2026.', ['March 2025', 'March 2026']],
    ['Compare net sales in March 2025, and in March 2026.', ['March 2025', 'March 2026']],
    ['Revenue / units in March 2026.', ['March 2026']],
    ['Revenue plus units in March 2026.', ['March 2026']],
    ['Revenue, gross, as well as units in March 2026.', ['March 2026']],
  ]) {
    assert.deepEqual(texts(question, 2), expected, question);
    assert.deepEqual(extractTemporalReferences(question, { hintsVersion: 2 }), extractTemporalReferences(question, { hintsVersion: 1 }), question);
  }
});

test('v2 temporal: a part of a month, a period ending in it, an open range or a to-date tail resolves nothing', () => {
  // Review finding: the first version still resolved these to the whole
  // month, and kept only the start month of "from <month> to the end of
  // <month>". Not in the suite; the same class as 785050.
  for (const question of [
    'What were net sales in the first week of March 2026?',
    'Net sales for the first half of March 2026.',
    'Net sales in the last 10 days of March 2026.',
    'Net sales during the second fortnight of March 2026.',
    'Net sales in mid-March 2026.',
    'Net sales in early March 2026.',
    'Net sales in late March 2026.',
    'Net sales from March 2026 to the end of May 2026.',
    'Net sales from March 2026 up to May 2026.',
    'Net sales between March 2026 and the end of May 2026.',
    'Net sales from March 2026 until today.',
    'Net sales from March 2026 to now.',
    'Net sales in the three months to March 2026.',
    'Net sales for the quarter ending March 2026.',
    'Net sales for the 12 months ending March 2026.',
    'Net sales in March 2026 year to date.',
    'Net sales in March 2026 YTD.',
  ]) {
    assert.deepEqual(texts(question, 2), [], question);
    assert.ok(texts(question, 1).length > 0, `version 1 resolved a whole month: ${question}`);
  }
  // A plain whole month next to such words still resolves.
  for (const question of [
    'Net sales in the month of March 2026.',
    'Net sales of March 2026 to customers in Oslo.',
    'Net sales for March 2026 by week.',
    'Net sales in March 2026 excluding the first week.',
    'What were March 2026 net sales?',
  ]) {
    assert.deepEqual(texts(question, 2), ['March 2026'], question);
  }
});

test('v2 temporal: a month phrase that is fully understood still resolves exactly as in version 1', () => {
  for (const question of [
    'Show the top customers by total net sales amount in March 2026.',
    'Show March 2025 and March 2026 turnover side by side.',
    'top 10 Products with good sales in Feb, 26 but zero sale in Mar, 26',
    'Monthly net sales from Online Order documents for December 2025.',
    'Show sales on March 12 and returns due Feb 29',
    'Show the top 10 March 2026 customers by net sales.',
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
  assert.match(limits, /"Rank", "order", "sort" or "list \.\.\. in descending order" with no number returns every row \(no LIMIT\)/);
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

  // Cached per file pair; clearing either file (or everything, as a schema
  // refresh does) re-reads the merged layer.
  const cached = loadSemanticLayerForHintsVersion(2);
  assert.equal(loadSemanticLayerForHintsVersion(2), cached);
  clearSemanticLayerCache(HINTS_V2_SEMANTIC_LAYER_OVERLAY_PATH);
  const reread = loadSemanticLayerForHintsVersion(2);
  assert.notEqual(reread, cached);
  assert.deepEqual(reread, cached);
  clearSemanticLayerCache(DEFAULT_SEMANTIC_LAYER_PATH);
  assert.notEqual(loadSemanticLayerForHintsVersion(2), reread);
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
    'open_balance',
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
  const open = metricOf(v2Plan('Total open amount on documents with a due date in April 2026.'), 'open_balance');
  assert.deepEqual([open.matchedSynonyms, open.enforcement, open.preferredColumns], [['open amount'], 'enforced', ['SalesDocument.BalanceAmount']]);
  assert.equal(metricOf(v2Plan('How much is still unpaid on March 2026 sales?'), 'open_balance').enforcement, 'advisory');

  const prompt = buildOptimizedPrompt(schema, 'What was the average order value in March 2026?');
  const allowed = prompt.tables.map((table) => table.tableName);
  const validate = (sql) => validateReadOnlySql(sql, allowed, { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
  assert.throws(() => validate("SELECT AVG(BillTotalAmount) AS aov FROM SalesDocument WHERE DocumentDate >= '2026-03-01'"), { code: 'METRIC_COLUMN' });
  assert.doesNotThrow(() => validate("SELECT ROUND(AVG(COALESCE(d.NetAmount, 0)), 2) AS avg_order_value FROM SalesDocument d WHERE IFNULL(d.IsCanceled, 0) = 0"));
});

test('v2 layer: a question naming another amount, or an equivalent open-amount formula, is not rejected', () => {
  // Review finding: "order value" and "open amount" enforced NetAmount /
  // BalanceAmount even where rule 10 asks for GrossAmount, and rejected an
  // open amount computed as NetPayableAmount - PaidAmount (equal to
  // BalanceAmount on every fixture row).
  const rejects = (question, sql, hintsVersion = 2) => {
    const prompt = buildOptimizedPrompt(schema, question, { hintsVersion });
    try {
      validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const march = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'";
  for (const question of [
    'What was the average gross order value in March 2026?',
    'Average order value including tax in March 2026.',
    'Average order value, tax included, in March 2026.',
  ]) {
    const metric = metricOf(v2Plan(question), 'average_order_value');
    assert.equal(metric.enforcement, 'advisory', question);
    assert.equal(rejects(question, `SELECT ROUND(AVG(COALESCE(d.GrossAmount,0)),2) AS aov ${march}`), null, question);
  }
  assert.equal(metricOf(v2Plan('Average order value including tax in March 2026.'), 'average_order_value').enforcementReason, 'other_amount_named');
  assert.match(
    buildOptimizedPrompt(schema, 'Average order value including tax in March 2026.').user,
    /Metric "average_order_value" matched [^\n]*\(weak match: the question names another amount/
  );
  // "order value" alone is a hint; "average order value" enforces.
  assert.equal(metricOf(v2Plan('Show the order value of each document in March 2026.'), 'average_order_value').enforcement, 'advisory');
  assert.equal(rejects('What was the average order value in March 2026?', `SELECT ROUND(AVG(COALESCE(d.BillTotalAmount,0)),2) AS aov ${march}`), 'METRIC_COLUMN');
  // "excluding tax" / "net of tax" name no other amount.
  assert.equal(metricOf(v2Plan('Average order value excluding tax in March 2026.'), 'average_order_value').enforcement, 'enforced');
  // The same guard for net sales: "revenue including tax" is gross, "net sales" stays enforced.
  assert.equal(metricOf(v2Plan('What was our revenue including tax in March 2026?'), 'net_sales').enforcement, 'advisory');
  assert.equal(metricOf(v1Plan('What was our revenue including tax in March 2026?'), 'net_sales').enforcement, 'enforced');
  assert.equal(metricOf(v2Plan('Net sales and gross amount in March 2026.'), 'net_sales').enforcement, 'enforced');

  // Open amount: BalanceAmount, or NetPayableAmount - PaidAmount.
  const open = 'Total open amount on documents with a due date in April 2026.';
  const april = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DueDate >= '2026-04-01' AND d.DueDate < '2026-05-01'";
  assert.equal(rejects(open, `SELECT ROUND(SUM(COALESCE(d.NetPayableAmount,0) - COALESCE(d.PaidAmount,0)),2) AS open_amount ${april}`), null);
  assert.equal(rejects(open, `SELECT ROUND(SUM(COALESCE(d.BalanceAmount,0)),2) AS open_amount ${april}`), null);
  assert.equal(rejects(open, `SELECT ROUND(SUM(COALESCE(d.NetPayableAmount,0)),2) AS open_amount ${april}`), 'METRIC_COLUMN');
  assert.equal(rejects(open, `SELECT ROUND(SUM(COALESCE(d.BillTotalAmount,0) - COALESCE(d.PaidAmount,0)),2) AS open_amount ${april}`), 'METRIC_COLUMN');
  // Only the open balance carries an alternative difference; version 1 plans never do.
  assert.deepEqual(metricOf(v2Plan(open), 'open_balance').alternativeDifferences, [['SalesDocument.NetPayableAmount', 'SalesDocument.PaidAmount']]);
  assert.ok(!('alternativeDifferences' in (metricOf(v1Plan('Show net sales in March 2026.'), 'net_sales') || {})));
  assert.ok(!('alternativeDifferences' in metricOf(v2Plan('Show net sales in March 2026.'), 'net_sales')));
});

test('v2 METRIC_COLUMN: the open-balance alternative needs NetPayableAmount - PaidAmount computed, not both columns mentioned', () => {
  // Review finding: the alternative was satisfied when both columns appeared
  // anywhere in the SQL, so a sum of NetPayableAmount next to a PaidAmount
  // filter, or NetPayableAmount + PaidAmount, passed as an open balance.
  const open = 'Total open amount on documents with a due date in April 2026.';
  const prompt = buildOptimizedPrompt(schema, open);
  const allowed = prompt.tables.map((table) => table.tableName);
  const rejects = (sql) => {
    try {
      validateReadOnlySql(sql, allowed, { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const april = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DueDate >= '2026-04-01' AND d.DueDate < '2026-05-01'";
  for (const expression of [
    'SUM(COALESCE(d.NetPayableAmount,0) - COALESCE(d.PaidAmount,0))',
    'SUM(d.NetPayableAmount - d.PaidAmount)',
    'SUM(IFNULL(d.NetPayableAmount, 0.00) - IFNULL(d.PaidAmount, 0))',
    'SUM(d.NetPayableAmount) - SUM(d.PaidAmount)',
    'COALESCE(SUM(d.NetPayableAmount),0) - COALESCE(SUM(d.PaidAmount),0)',
    'SUM(`d`.`NetPayableAmount` - `d`.`PaidAmount`)',
    'SUM((d.NetPayableAmount) - (d.PaidAmount))',
    'SUM(GREATEST(d.NetPayableAmount - d.PaidAmount, 0))',
    'SUM(d.NetPayableAmount - d.PaidAmount + 0)',
    'SUM(d.NetPayableAmount - d.PaidAmount - 0)',
    // Re-review: value-keeping casts, and the same ROUND on both sides.
    'SUM(CAST(d.NetPayableAmount AS DECIMAL(12,2)) - CAST(d.PaidAmount AS DECIMAL(12,2)))',
    'SUM(CONVERT(d.NetPayableAmount, DECIMAL(12,2)) - CONVERT(d.PaidAmount, DECIMAL(12,2)))',
    'SUM(CAST(COALESCE(d.NetPayableAmount, 0) AS DOUBLE) - COALESCE(d.PaidAmount, 0))',
    'ROUND(SUM(d.NetPayableAmount), 2) - ROUND(SUM(d.PaidAmount), 2)',
    'SUM(ROUND(d.NetPayableAmount, 2) - ROUND(d.PaidAmount, 2))',
    'ROUND(SUM(d.NetPayableAmount)) - ROUND(SUM(d.PaidAmount), 0)',
  ]) {
    assert.equal(rejects(`SELECT ROUND(${expression}, 2) AS open_amount ${april}`), null, expression);
  }
  // Unqualified and table-qualified columns.
  const unaliased = "FROM SalesDocument WHERE IFNULL(IsCanceled,0)=0 AND DueDate >= '2026-04-01' AND DueDate < '2026-05-01'";
  assert.equal(rejects(`SELECT SUM(NetPayableAmount - PaidAmount) AS open_amount ${unaliased}`), null);
  assert.equal(rejects(`SELECT SUM(SalesDocument.NetPayableAmount - SalesDocument.PaidAmount) AS open_amount ${unaliased}`), null);
  // A derived table computing the difference counts too.
  assert.equal(rejects(`SELECT SUM(t.bal) AS open_amount FROM (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}) t`), null);

  for (const expression of [
    // Both columns present, not their difference.
    'SUM(d.NetPayableAmount)) AS open_amount, ROUND(SUM(d.PaidAmount)',
    'SUM(d.NetPayableAmount + d.PaidAmount)',
    'SUM(d.NetPayableAmount) / SUM(d.PaidAmount)',
    'SUM(d.PaidAmount) / NULLIF(SUM(d.NetPayableAmount), 0)',
    // The reversed difference, or one bound to another operator.
    'SUM(d.PaidAmount - d.NetPayableAmount)',
    'SUM(d.NetPayableAmount - d.PaidAmount * 2)',
    'SUM(d.NetPayableAmount * 2 - d.PaidAmount)',
    'SUM(0 - d.NetPayableAmount - d.PaidAmount)',
    'SUM(-d.NetPayableAmount - d.PaidAmount)',
    // A summed and a row-level side, or another function around a column.
    'SUM(d.NetPayableAmount) - d.PaidAmount',
    'SUM(ABS(d.NetPayableAmount) - d.PaidAmount)',
    'SUM(d.NetPayableAmount - d.GrossAmount)',
    'SUM(d.BillTotalAmount - d.PaidAmount)',
    // Different rounding on the two sides, or a cast that drops the decimals or the number.
    'ROUND(SUM(d.NetPayableAmount), 2) - ROUND(SUM(d.PaidAmount), 1)',
    'ROUND(SUM(d.NetPayableAmount), 2) - SUM(d.PaidAmount)',
    'SUM(ROUND(d.NetPayableAmount, 2)) - ROUND(SUM(d.PaidAmount), 2)',
    'SUM(CAST(d.NetPayableAmount AS SIGNED) - CAST(d.PaidAmount AS SIGNED))',
    'SUM(CAST(d.NetPayableAmount AS CHAR) - d.PaidAmount)',
  ]) {
    assert.equal(rejects(`SELECT ROUND(${expression}, 2) AS open_amount ${april}`), 'METRIC_COLUMN', expression);
  }
  // A comparison of the two columns, or the difference in a string literal, does not count (the safety layer rejects comments).
  assert.equal(rejects(`SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} AND d.PaidAmount < d.NetPayableAmount`), 'METRIC_COLUMN');
  assert.equal(rejects(`SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount, 'NetPayableAmount - PaidAmount' AS note ${april}`), 'METRIC_COLUMN');
  // Re-review: the difference written as a condition (a filter, a join, a
  // CASE WHEN, HAVING or ORDER BY) computes no open balance: these return
  // SUM(NetPayableAmount) over the open documents.
  for (const sql of [
    `SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} AND d.NetPayableAmount - d.PaidAmount > 0`,
    `SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} AND 0 < d.NetPayableAmount - d.PaidAmount`,
    `SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} AND (d.NetPayableAmount - d.PaidAmount) <> 0`,
    `SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} AND d.NetPayableAmount - d.PaidAmount BETWEEN 0.01 AND 1000000`,
    `SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} AND d.SalesDocumentId IN (SELECT x.SalesDocumentId FROM SalesDocument x WHERE x.NetPayableAmount - x.PaidAmount > 0)`,
    `SELECT ROUND(SUM(CASE WHEN d.NetPayableAmount - d.PaidAmount > 0 THEN d.NetPayableAmount ELSE 0 END), 2) AS open_amount ${april}`,
    `SELECT ROUND(SUM(d.NetPayableAmount), 2) AS open_amount, SUM(d.NetPayableAmount - d.PaidAmount > 0) AS open_documents ${april}`,
    `SELECT d.CustomerId, ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} GROUP BY d.CustomerId HAVING SUM(d.NetPayableAmount) - SUM(d.PaidAmount) > 0`,
    `SELECT d.CustomerId, ROUND(SUM(d.NetPayableAmount), 2) AS open_amount ${april} GROUP BY d.CustomerId ORDER BY SUM(d.NetPayableAmount) - SUM(d.PaidAmount) DESC`,
  ]) {
    assert.equal(rejects(sql), 'METRIC_COLUMN', sql);
  }
  // The same difference as a computed value counts, wherever the query also
  // uses it as a condition.
  for (const sql of [
    `SELECT ROUND(SUM(CASE WHEN d.NetPayableAmount > d.PaidAmount THEN d.NetPayableAmount - d.PaidAmount ELSE 0 END), 2) AS open_amount ${april}`,
    `SELECT ROUND(SUM(IF(d.NetPayableAmount - d.PaidAmount > 0, d.NetPayableAmount - d.PaidAmount, 0)), 2) AS open_amount ${april}`,
    `SELECT d.SalesDocumentId, d.NetPayableAmount - d.PaidAmount open_amount ${april} AND d.NetPayableAmount - d.PaidAmount > 0 ORDER BY open_amount DESC`,
    `SELECT d.CustomerId, ROUND(SUM(d.NetPayableAmount - d.PaidAmount), 2) AS open_amount ${april} GROUP BY d.CustomerId HAVING SUM(d.NetPayableAmount - d.PaidAmount) > 0`,
    `WITH t AS (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}) SELECT ROUND(SUM(bal), 2) AS open_amount FROM t`,
    `SELECT (SELECT ROUND(SUM(d.NetPayableAmount - d.PaidAmount), 2) ${april}) AS open_amount`,
  ]) {
    assert.equal(rejects(sql), null, sql);
  }
  // The rejection names the accepted difference.
  assert.throws(() => validateReadOnlySql(`SELECT SUM(d.NetPayableAmount + d.PaidAmount) AS open_amount ${april}`, allowed, { promptContext: prompt.context, response: { sql: '', tables_used: ['SalesDocument'] } }), {
    code: 'METRIC_COLUMN',
    message: /\(SalesDocument\.BalanceAmount; or SalesDocument\.NetPayableAmount - SalesDocument\.PaidAmount\)/,
  });
});

test('v2 METRIC_COLUMN: an open-balance difference cast without its decimals computes no balance', () => {
  // Third review: a bare DECIMAL or NUMERIC (DECIMAL(10,0) in MariaDB), scale
  // 0, SIGNED, UNSIGNED or INTEGER, on either side or around the difference,
  // passed although it drops the cents.
  const open = 'Total open amount on documents with a due date in April 2026.';
  const prompt = buildOptimizedPrompt(schema, open);
  const allowed = prompt.tables.map((table) => table.tableName);
  const rejects = (sql) => {
    try {
      validateReadOnlySql(sql, allowed, { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const april = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DueDate >= '2026-04-01' AND d.DueDate < '2026-05-01'";
  for (const sql of [
    `SELECT SUM(CAST(d.NetPayableAmount AS DECIMAL) - CAST(d.PaidAmount AS DECIMAL)) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount AS NUMERIC) - CAST(d.PaidAmount AS NUMERIC)) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount AS DECIMAL(12,0)) - CAST(d.PaidAmount AS DECIMAL(12,0))) AS open_amount ${april}`,
    `SELECT SUM(CONVERT(d.NetPayableAmount, DECIMAL) - CONVERT(d.PaidAmount, DECIMAL)) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount AS INTEGER) - CAST(d.PaidAmount AS INTEGER)) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount - d.PaidAmount AS SIGNED)) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount - d.PaidAmount AS UNSIGNED)) AS open_amount ${april}`,
    `SELECT CAST(SUM(d.NetPayableAmount - d.PaidAmount) AS DECIMAL) AS open_amount ${april}`,
    `SELECT CONVERT(SUM(d.NetPayableAmount - d.PaidAmount), SIGNED) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount - d.PaidAmount AS CHAR)) AS open_amount ${april}`,
  ]) {
    assert.equal(rejects(sql), 'METRIC_COLUMN', sql);
  }
  // Casts that keep the decimals, on each side or around the difference.
  for (const sql of [
    `SELECT SUM(CAST(d.NetPayableAmount AS DECIMAL(12,2)) - CAST(d.PaidAmount AS DECIMAL(12,2))) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount AS NUMERIC(14,4)) - CAST(d.PaidAmount AS NUMERIC(14,4))) AS open_amount ${april}`,
    `SELECT SUM(CAST(d.NetPayableAmount - d.PaidAmount AS DECIMAL(14,2))) AS open_amount ${april}`,
    `SELECT CAST(SUM(d.NetPayableAmount - d.PaidAmount) AS DOUBLE) AS open_amount ${april}`,
    `SELECT CONVERT(SUM(d.NetPayableAmount - d.PaidAmount), DECIMAL(14,2)) AS open_amount ${april}`,
  ]) {
    assert.equal(rejects(sql), null, sql);
  }
});

test('v2 METRIC_COLUMN: an open-balance difference used as an IF() condition, or a derived column only filtered on, computes no balance', () => {
  // Third review: each of these returned SUM(NetPayableAmount) over the open
  // documents and passed.
  const open = 'Total open amount on documents with a due date in April 2026.';
  const prompt = buildOptimizedPrompt(schema, open);
  const allowed = prompt.tables.map((table) => table.tableName);
  const rejects = (sql) => {
    try {
      validateReadOnlySql(sql, allowed, { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const april = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DueDate >= '2026-04-01' AND d.DueDate < '2026-05-01'";
  const others = 'FROM SalesDocument x';
  for (const sql of [
    // The first argument of IF() is a condition; NULLIF() compares.
    `SELECT ROUND(SUM(IF(d.NetPayableAmount - d.PaidAmount, d.NetPayableAmount, 0)), 2) AS open_amount ${april}`,
    `SELECT ROUND(SUM(IF(GREATEST(d.NetPayableAmount - d.PaidAmount, 0), d.NetPayableAmount, 0)), 2) AS open_amount ${april}`,
    `SELECT ROUND(SUM(NULLIF(d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount)), 2) AS open_amount ${april}`,
    // A CTE or derived-table difference column used only to filter or join.
    `WITH docs AS (SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount AS open_amount ${april}) SELECT SUM(NetPayableAmount) AS open_amount FROM docs WHERE open_amount > 0`,
    `SELECT SUM(t.NetPayableAmount) AS open_amount FROM (SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount AS bal ${april}) t WHERE t.bal > 0`,
    `SELECT SUM(t.NetPayableAmount) AS open_amount FROM (SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount ${april}) t`,
    `WITH t (np, bal) AS (SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount ${april}) SELECT SUM(np) AS open_amount FROM t WHERE bal > 0`,
    `SELECT SUM(d.NetPayableAmount) AS open_amount FROM SalesDocument d JOIN (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}) t ON t.SalesDocumentId = d.SalesDocumentId AND t.bal > 0 WHERE IFNULL(d.IsCanceled,0)=0`,
    `SELECT SUM(d.NetPayableAmount) AS open_amount ${april} AND d.SalesDocumentId IN (SELECT t.SalesDocumentId FROM (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}) t WHERE t.bal > 0)`,
    `SELECT SUM(d.NetPayableAmount) AS open_amount ${april} AND EXISTS (SELECT 1 FROM (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}) t WHERE t.SalesDocumentId = d.SalesDocumentId AND t.bal > 0)`,
    `SELECT SUM(CAST(t.bal AS SIGNED)) AS open_amount FROM (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}) t`,
    // Not accepted: the sum forms (the rejection names the plain difference).
    `SELECT SUM(d.NetPayableAmount + (-d.PaidAmount)) AS open_amount ${april}`,
    `SELECT SUM(-d.PaidAmount + d.NetPayableAmount) AS open_amount ${april}`,
  ]) {
    assert.equal(rejects(sql), 'METRIC_COLUMN', sql);
  }
  // The difference as a value: an IF() result, a NULLIF() operand, or a
  // derived-table or CTE column the query sums, selects or passes on with `*`.
  for (const sql of [
    `SELECT ROUND(SUM(IF(d.IsCanceled = 1, 0, d.NetPayableAmount - d.PaidAmount)), 2) AS open_amount ${april}`,
    `SELECT ROUND(SUM(NULLIF(d.NetPayableAmount - d.PaidAmount, 0)), 2) AS open_amount ${april}`,
    `SELECT SUM(t.bal) AS open_amount FROM (SELECT d.NetPayableAmount - d.PaidAmount bal ${april}) t WHERE t.bal > 0`,
    `SELECT SUM(t.\`bal\`) AS open_amount FROM (SELECT d.NetPayableAmount - d.PaidAmount AS \`bal\` ${april}) AS t`,
    `WITH t (np, bal) AS (SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount ${april}) SELECT SUM(bal) AS open_amount FROM t WHERE bal > 0`,
    `SELECT d.CustomerId, SUM(t.bal) AS open_amount FROM SalesDocument d JOIN (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}) t ON t.SalesDocumentId = d.SalesDocumentId WHERE IFNULL(d.IsCanceled,0)=0 GROUP BY d.CustomerId`,
    `SELECT * FROM (SELECT d.SalesDocumentId, d.NetPayableAmount - d.PaidAmount AS bal ${april}) t`,
    `SELECT * FROM (SELECT ROUND(SUM(d.NetPayableAmount - d.PaidAmount), 2) ${april}) t`,
    `SELECT SUM(u.bal) AS open_amount FROM (SELECT t.* FROM (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}) t) u`,
    `WITH a AS (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}), b AS (SELECT * FROM a) SELECT SUM(bal) AS open_amount FROM b`,
  ]) {
    assert.equal(rejects(sql), null, sql);
  }
});

// The verdict on `sql` for the open-amount question: null when it passes,
// else the code.
function openAmountVerdict(sql) {
  const prompt = buildOptimizedPrompt(schema, 'Total open amount on documents with a due date in April 2026.');
  try {
    validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
    return null;
  } catch (error) {
    return error.code;
  }
}
const aprilDueDocuments = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DueDate >= '2026-04-01' AND d.DueDate < '2026-05-01'";

test('v2 METRIC_COLUMN: a difference in a later UNION branch is named by the first branch', () => {
  // Fourth review: following derived-table columns named the difference from
  // its own select item, but a later UNION branch's columns take the first
  // branch's names, so a correct balance there was rejected (it passed
  // before). CAST(... AS DOUBLE PRECISION), which MariaDB's CAST does not
  // take, passes as it did before, so the database reports the syntax error
  // instead of a METRIC_COLUMN rejection naming the difference it computes.
  const april = aprilDueDocuments;
  for (const sql of [
    `SELECT SUM(bal) AS open_amount FROM (SELECT 0 AS bal UNION ALL SELECT d.NetPayableAmount - d.PaidAmount ${april}) t`,
    `SELECT SUM(t.bal) AS open_amount FROM (SELECT 0 AS bal UNION ALL SELECT d.NetPayableAmount - d.PaidAmount AS other ${april}) t`,
    `SELECT SUM(t.bal) AS open_amount FROM (SELECT 0 AS np, 0 AS bal UNION ALL SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount ${april}) t`,
    `WITH t AS (SELECT 0 AS bal UNION ALL SELECT d.NetPayableAmount - d.PaidAmount ${april}) SELECT SUM(bal) AS open_amount FROM t`,
    `SELECT SUM(bal) AS open_amount FROM (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april} UNION ALL SELECT 0) t`,
    `SELECT CAST(SUM(d.NetPayableAmount - d.PaidAmount) AS DOUBLE PRECISION) AS open_amount ${april}`,
  ]) {
    assert.equal(openAmountVerdict(sql), null, sql);
  }
  // The first branch's name decides which column is only filtered on.
  for (const sql of [
    `SELECT SUM(t.np) AS open_amount FROM (SELECT 0 AS np, 0 AS bal UNION ALL SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount ${april}) t WHERE t.bal > 0`,
    `SELECT SUM(t.np) AS open_amount FROM (SELECT 0 AS np, 0 AS bal UNION ALL SELECT d.NetPayableAmount, d.NetPayableAmount - d.PaidAmount AS np ${april}) t WHERE t.bal > 0`,
  ]) {
    assert.equal(openAmountVerdict(sql), 'METRIC_COLUMN', sql);
  }
});

test('v2 METRIC_COLUMN: a qualified derived-table or CTE column counts only through the alias or name of that table', () => {
  // Fourth review: the column was matched by name alone, so a same-named
  // column of another source let a difference used only as a filter count:
  // each of these sums NetPayableAmount over the open documents.
  const april = aprilDueDocuments;
  const others = 'FROM SalesDocument x';
  for (const sql of [
    `SELECT SUM(o.bal) AS open_amount FROM (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}) t JOIN (SELECT d.SalesDocumentId, d.NetPayableAmount AS bal ${april}) o ON o.SalesDocumentId = t.SalesDocumentId WHERE t.bal > 0`,
    `WITH t AS (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}), o AS (SELECT d.SalesDocumentId, d.NetPayableAmount AS bal ${april}) SELECT SUM(o.bal) AS open_amount FROM o JOIN t ON t.SalesDocumentId = o.SalesDocumentId WHERE t.bal > 0`,
    `WITH docs AS (SELECT d.SalesDocumentId, d.NetPayableAmount - d.PaidAmount AS NetPayableAmount ${april}) SELECT SUM(s.NetPayableAmount) AS open_amount FROM SalesDocument s JOIN docs ON docs.SalesDocumentId = s.SalesDocumentId WHERE docs.NetPayableAmount > 0`,
    `SELECT SUM(u.np) AS open_amount FROM (SELECT o.* FROM (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal ${others}) t JOIN (SELECT d.SalesDocumentId, d.NetPayableAmount AS np ${april}) o ON o.SalesDocumentId = t.SalesDocumentId WHERE t.bal > 0) u`,
  ]) {
    assert.equal(openAmountVerdict(sql), 'METRIC_COLUMN', sql);
  }
  // Through the table's own alias, the CTE's name or an alias given to it.
  for (const sql of [
    `SELECT SUM(sub.open_amount) AS total FROM (SELECT d.NetPayableAmount - d.PaidAmount AS open_amount ${april}) AS sub`,
    `WITH docs AS (SELECT d.CustomerId, d.NetPayableAmount - d.PaidAmount AS bal ${april}) SELECT SUM(docs.bal) AS open_amount FROM docs`,
    `WITH docs AS (SELECT d.CustomerId, d.NetPayableAmount - d.PaidAmount AS bal ${april}) SELECT x.CustomerId, SUM(x.bal) AS open_amount FROM docs AS x GROUP BY x.CustomerId`,
    `WITH docs (cid, bal) AS (SELECT d.CustomerId, d.NetPayableAmount - d.PaidAmount ${april}) SELECT SUM(y.bal) AS open_amount FROM docs y`,
    `SELECT SUM(u.bal) AS open_amount FROM (SELECT t.* FROM (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}) t) u`,
  ]) {
    assert.equal(openAmountVerdict(sql), null, sql);
  }
});

test('v2 METRIC_COLUMN: a derived-table or CTE column counts only where its own query block reads it, in nested scopes and under shadowed names', () => {
  // Fifth review: an unqualified reference counted wherever the CTE or derived
  // table was visible, and a qualifier counted wherever it was spelled, so a
  // same-named column of another source (another derived table, a nested
  // query's own source, another UNION branch, an alias reused in a separate
  // query) let a difference used only as a filter count. Each of these sums
  // NetPayableAmount, or nothing, over the open documents.
  const april = aprilDueDocuments;
  const diff = 'd.NetPayableAmount - d.PaidAmount';
  for (const sql of [
    // The review's examples.
    'WITH t AS (SELECT NetPayableAmount - PaidAmount AS bal FROM SalesDocument) SELECT SUM(d.NetPayableAmount) FROM SalesDocument d WHERE EXISTS (SELECT SUM(bal) FROM (SELECT NetPayableAmount AS bal FROM SalesDocument) x)',
    `WITH t AS (SELECT NetPayableAmount - PaidAmount AS bal FROM SalesDocument) SELECT SUM(bal) AS open_amount FROM (SELECT d.NetPayableAmount AS bal ${april}) x WHERE EXISTS (SELECT 1 FROM t WHERE t.bal > 0)`,
    `WITH docs AS (SELECT d.SalesDocumentId, ${diff} AS bal ${april}) SELECT SUM(bal) AS open_amount FROM (SELECT d.NetPayableAmount AS bal ${april} AND EXISTS (SELECT 1 FROM docs WHERE docs.bal > 0 AND docs.SalesDocumentId = d.SalesDocumentId)) z`,
    `WITH docs AS (SELECT d.SalesDocumentId, ${diff} AS bal ${april}) SELECT SUM(x.bal) AS open_amount FROM (SELECT d.SalesDocumentId, d.NetPayableAmount AS bal ${april}) x WHERE EXISTS (SELECT 1 FROM docs x WHERE x.bal > 0)`,
    // A nested query's own source shadows the outer derived table.
    `SELECT (SELECT SUM(t.bal) FROM (SELECT d.NetPayableAmount AS bal ${april}) t) AS open_amount FROM (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal FROM SalesDocument x) t WHERE t.bal > 0`,
    `SELECT (SELECT SUM(bal) FROM (SELECT d.NetPayableAmount AS bal ${april}) z) AS open_amount FROM (SELECT x.SalesDocumentId, x.NetPayableAmount - x.PaidAmount AS bal FROM SalesDocument x) t WHERE t.bal > 0`,
    `WITH t AS (SELECT ${diff} AS bal ${april}) SELECT (WITH t AS (SELECT d.NetPayableAmount AS bal ${april}) SELECT SUM(bal) FROM t) AS open_amount FROM t LIMIT 1`,
    // Another UNION branch, or another CTE that the outer query reads.
    `SELECT SUM(t.np) AS open_amount FROM (SELECT d.NetPayableAmount AS np, ${diff} AS bal ${april}) t WHERE t.bal > 0 UNION ALL SELECT SUM(bal) FROM (SELECT 0 AS bal) y`,
    `WITH t AS (SELECT d.SalesDocumentId, ${diff} AS bal ${april}), o AS (SELECT d.SalesDocumentId, d.NetPayableAmount AS bal ${april}) SELECT SUM(bal) AS open_amount FROM o WHERE EXISTS (SELECT 1 FROM t WHERE t.bal > 0 AND t.SalesDocumentId = o.SalesDocumentId)`,
  ]) {
    assert.equal(openAmountVerdict(sql), 'METRIC_COLUMN', sql);
  }
  // Read from its own block, or from a nested query whose own FROM has no
  // such column (a correlated reference), the column still counts.
  for (const sql of [
    `WITH t AS (SELECT ${diff} AS bal ${april}) SELECT ROUND(SUM(bal), 2) AS open_amount FROM t`,
    `SELECT t.SalesDocumentId, (SELECT t.bal) AS open_amount FROM (SELECT d.SalesDocumentId, ${diff} AS bal ${april}) t`,
    `SELECT t.SalesDocumentId, (SELECT bal) AS open_amount FROM (SELECT d.SalesDocumentId, ${diff} AS bal ${april}) t`,
    `SELECT (SELECT SUM(bal) FROM (SELECT ${diff} AS bal ${april}) t) AS open_amount FROM (SELECT 0 AS bal) z`,
    `SELECT 0 AS open_amount UNION ALL SELECT SUM(bal) FROM (SELECT ${diff} AS bal ${april}) t`,
    `WITH t AS (SELECT d.SalesDocumentId, ${diff} AS bal ${april}) SELECT o.SalesDocumentId, (SELECT SUM(bal) FROM t WHERE t.SalesDocumentId = o.SalesDocumentId) AS open_amount FROM SalesDocument o`,
    `WITH t AS (SELECT d.CustomerId, ${diff} AS bal ${april}) SELECT x.CustomerId, SUM(x.bal) AS open_amount FROM t x GROUP BY x.CustomerId`,
    `WITH a AS (SELECT ${diff} AS bal ${april}), b AS (SELECT * FROM a) SELECT SUM(bal) AS open_amount FROM b`,
    `SELECT SUM(u.bal) AS open_amount FROM (SELECT t.* FROM (SELECT ${diff} AS bal ${april}) t) u`,
  ]) {
    assert.equal(openAmountVerdict(sql), null, sql);
  }
});

test('v2 METRIC_COLUMN: a difference read as a condition by SIGN() and the like, or with its decimals dropped, computes no balance', () => {
  // Fourth review: SUM(SIGN(a - b) * a) sums NetPayableAmount over the open
  // documents like the IF() condition does, and FLOOR(), DIV or FORMAT(x, 0)
  // drop the decimals like an integer cast does; all of them passed.
  const april = aprilDueDocuments;
  for (const sql of [
    `SELECT SUM(SIGN(d.NetPayableAmount - d.PaidAmount) * d.NetPayableAmount) AS open_amount ${april}`,
    `SELECT SUM(ELT(d.NetPayableAmount - d.PaidAmount, d.NetPayableAmount)) AS open_amount ${april}`,
    `SELECT SUM(FIELD(d.NetPayableAmount - d.PaidAmount, 0) * d.NetPayableAmount) AS open_amount ${april}`,
    `SELECT FLOOR(SUM(d.NetPayableAmount - d.PaidAmount)) AS open_amount ${april}`,
    `SELECT CEIL(SUM(d.NetPayableAmount - d.PaidAmount)) AS open_amount ${april}`,
    `SELECT SUM(d.NetPayableAmount * MOD(d.NetPayableAmount - d.PaidAmount, 1)) AS open_amount ${april}`,
    `SELECT SUM(d.NetPayableAmount - d.PaidAmount) DIV 1 AS open_amount ${april}`,
    `SELECT SUM(d.NetPayableAmount - d.PaidAmount) MOD 100 AS open_amount ${april}`,
    `SELECT SUM(d.NetPayableAmount - d.PaidAmount) % 100 AS open_amount ${april}`,
    `SELECT FORMAT(SUM(d.NetPayableAmount - d.PaidAmount), 0) AS open_amount ${april}`,
    `SELECT SUM(FLOOR(t.bal)) AS open_amount FROM (SELECT d.NetPayableAmount - d.PaidAmount AS bal ${april}) t`,
  ]) {
    assert.equal(openAmountVerdict(sql), 'METRIC_COLUMN', sql);
  }
  // The value itself, or another column's sign, still counts.
  for (const sql of [
    `SELECT SUM(ABS(d.NetPayableAmount - d.PaidAmount)) AS open_amount ${april}`,
    `SELECT SUM(SIGN(d.NetPayableAmount) * (d.NetPayableAmount - d.PaidAmount)) AS open_amount ${april}`,
    `SELECT FORMAT(SUM(d.NetPayableAmount - d.PaidAmount), 2) AS open_amount ${april}`,
    `SELECT ROUND(SUM(d.NetPayableAmount - d.PaidAmount), 2) AS open_amount ${april}`,
    `SELECT SUM(d.NetPayableAmount - d.PaidAmount) / COUNT(*) AS average_open_amount ${april}`,
  ]) {
    assert.equal(openAmountVerdict(sql), null, sql);
  }
});

test('v2 layer: another amount demotes a metric only when it modifies the metric phrase, not when it is a separate measure', () => {
  // Review finding: "gross" anywhere in the question made an explicit
  // "revenue" / "average order value" advisory, so "Show revenue and gross
  // amount" accepted SUM(BillTotalAmount) for revenue.
  const rejects = (question, sql) => {
    const prompt = buildOptimizedPrompt(schema, question);
    try {
      validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const march = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'";
  // A separate measure alongside the metric: the metric stays enforced, as in version 1.
  for (const [question, name] of [
    ['Show revenue and gross amount in March 2026.', 'net_sales'],
    ['Show gross amount and revenue in March 2026.', 'net_sales'],
    ['Show revenue, gross amount and units in March 2026.', 'net_sales'],
    ['Revenue versus the bill total in March 2026.', 'net_sales'],
    ['Show average order value and gross amount in March 2026.', 'average_order_value'],
    ['Average order value and the bill total in March 2026.', 'average_order_value'],
    ['Average order value, subtotal and units in March 2026.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['enforced', 'explicit_metric_phrase'], question);
    assert.equal(metricOf(v1Plan(question), name)?.enforcement ?? 'enforced', 'enforced', question);
  }
  assert.equal(rejects('Show revenue and gross amount in March 2026.', `SELECT SUM(d.BillTotalAmount) AS revenue, SUM(d.GrossAmount) AS gross ${march}`), 'METRIC_COLUMN');
  assert.equal(rejects('Show revenue and gross amount in March 2026.', `SELECT SUM(d.NetAmount) AS revenue, SUM(d.GrossAmount) AS gross ${march}`), null);
  assert.equal(rejects('Show average order value and gross amount in March 2026.', `SELECT AVG(d.BillTotalAmount) AS aov, SUM(d.GrossAmount) AS gross ${march}`), 'METRIC_COLUMN');
  assert.equal(rejects('Show average order value and gross amount in March 2026.', `SELECT AVG(COALESCE(d.NetAmount,0)) AS aov, SUM(d.GrossAmount) AS gross ${march}`), null);
  // Re-review: the other amount modifying a generic word of the metric
  // ("gross sales", "order value including tax") or a second mention ("gross
  // revenue" next to "revenue") does not demote the unmodified explicit
  // phrase.
  for (const [question, name, sql] of [
    ['Show revenue and gross sales in March 2026.', 'net_sales', 'SUM(d.BillTotalAmount) AS revenue'],
    ['Show gross sales and revenue in March 2026.', 'net_sales', 'SUM(d.BillTotalAmount) AS revenue'],
    ['Compare revenue with gross sales for March 2026.', 'net_sales', 'SUM(d.BillTotalAmount) AS revenue'],
    ['Show revenue and gross revenue in March 2026.', 'net_sales', 'SUM(d.BillTotalAmount) AS revenue'],
    ['Show revenue and sales including tax for March 2026.', 'net_sales', 'SUM(d.BillTotalAmount) AS revenue'],
    ['Show average order value and gross order value in March 2026.', 'average_order_value', 'AVG(d.BillTotalAmount) AS aov'],
    ['Show gross order value and average order value in March 2026.', 'average_order_value', 'AVG(d.BillTotalAmount) AS aov'],
    ['Show average order value and order value including tax in March 2026.', 'average_order_value', 'AVG(d.BillTotalAmount) AS aov'],
    ['Show the average order value and the average gross order value in March 2026.', 'average_order_value', 'AVG(d.BillTotalAmount) AS aov'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['enforced', 'explicit_metric_phrase'], question);
    assert.equal(rejects(question, `SELECT ${sql}, SUM(d.GrossAmount) AS gross ${march}`), 'METRIC_COLUMN', question);
  }
  // Every explicit phrase modified still demotes.
  assert.equal(metricOf(v2Plan('Show gross revenue and gross sales in March 2026.'), 'net_sales').enforcementReason, 'other_amount_named');

  // Wording that modifies the metric phrase: before it, after it in
  // parentheses or with glue words, or a tax phrase after it.
  for (const [question, name] of [
    ['What was our gross revenue in March 2026?', 'net_sales'],
    ['Gross monthly revenue in March 2026.', 'net_sales'],
    ['Revenue (gross) in March 2026.', 'net_sales'],
    ['Revenue on a gross basis in March 2026.', 'net_sales'],
    ['What was our revenue including tax in March 2026?', 'net_sales'],
    ['Revenue, tax included, in March 2026.', 'net_sales'],
    ['Average order value (gross) in March 2026.', 'average_order_value'],
    ['Average order value including tax in March 2026.', 'average_order_value'],
    ['Average order value, tax included, in March 2026.', 'average_order_value'],
    // Re-review: one word set off by commas, or ending the sentence.
    ['What was revenue, gross, in March 2026?', 'net_sales'],
    ['Revenue, gross, by store in March 2026.', 'net_sales'],
    ['What was March 2026 revenue, gross?', 'net_sales'],
    ['What was the average order value, gross, in March 2026?', 'average_order_value'],
    ['March 2026: average order value, gross.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['advisory', 'other_amount_named'], question);
  }
  assert.equal(rejects('What was revenue, gross, in March 2026?', `SELECT SUM(d.GrossAmount) AS revenue ${march}`), null);
  assert.equal(rejects('What was the average order value, gross, in March 2026?', `SELECT AVG(d.GrossAmount) AS aov ${march}`), null);
  // A comma-set word that starts a list is a separate measure.
  for (const [question, name] of [
    ['Show revenue, gross, and units in March 2026.', 'net_sales'],
    ['Show revenue, gross, discount and units in March 2026.', 'net_sales'],
    ['Show average order value, gross, and units in March 2026.', 'average_order_value'],
  ]) {
    assert.equal(metricOf(v2Plan(question), name).enforcement, 'enforced', question);
  }
  assert.equal(rejects('Revenue (gross) in March 2026.', `SELECT SUM(d.GrossAmount) AS revenue ${march}`), null);
  assert.equal(rejects('Average order value (gross) in March 2026.', `SELECT AVG(d.GrossAmount) AS aov ${march}`), null);
  // Each metric reads its own modifier: the tax phrase after "average order
  // value" does not demote "revenue" before it.
  const both = v2Plan('Revenue and average order value including tax in March 2026.');
  assert.equal(metricOf(both, 'net_sales').enforcement, 'enforced');
  assert.equal(metricOf(both, 'average_order_value').enforcement, 'advisory');
});

test('v2 layer: "net" asked for as its own measure, or an amount joined by a symbol or an adding word, leaves the metric enforced', () => {
  // Review finding: "net and gross revenue" read "gross" as modifying
  // "revenue" (the "net" exemption only looked at an explicit "net sales"),
  // and "&", "+" and "/" were plain separators, so "revenue & gross" read
  // like "revenue gross". Both demoted the metric and let SUM(GrossAmount)
  // pass as the revenue, which version 1 rejects.
  const rejects = (question, sql, hintsVersion = 2) => {
    const prompt = buildOptimizedPrompt(schema, question, { hintsVersion });
    try {
      validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const march = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'";
  for (const [question, name] of [
    // "net" coordinated with the amount, or standing as its own measure.
    ['Show net and gross revenue for March 2026.', 'net_sales'],
    ['Show net vs gross revenue for March 2026.', 'net_sales'],
    ['Show net/gross revenue for March 2026.', 'net_sales'],
    ['Show both net and gross revenue by store for March 2026.', 'net_sales'],
    ['Revenue (gross and net) by store for March 2026.', 'net_sales'],
    ['Net as a share of gross revenue in March 2026.', 'net_sales'],
    ['Show the net and gross average order value in March 2026.', 'average_order_value'],
    ['Show average order value (gross and net) in March 2026.', 'average_order_value'],
    // A joining symbol between the metric and the amount.
    ['Show revenue & gross in March 2026.', 'net_sales'],
    ['Show revenue + gross in March 2026.', 'net_sales'],
    ['Show revenue / gross in March 2026.', 'net_sales'],
    ['What was the revenue/gross ratio in March 2026?', 'net_sales'],
    ['Show revenue & tax included in March 2026.', 'net_sales'],
    ['Show average order value & gross in March 2026.', 'average_order_value'],
    // An adding word after the amount in parentheses.
    ['Show revenue (gross too) in March 2026.', 'net_sales'],
    ['Show revenue (gross as well) in March 2026.', 'net_sales'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['enforced', 'explicit_metric_phrase'], question);
    assert.equal(metricOf(v1Plan(question), name)?.enforcement ?? 'enforced', 'enforced', question);
  }
  // SUM(GrossAmount) (or the bill total) as the net measure is rejected, as
  // in version 1; the net column next to the gross one passes.
  for (const [question, sql] of [
    ['Show net and gross revenue for March 2026.', 'SUM(d.GrossAmount) AS net_revenue, SUM(d.GrossAmount) AS gross_revenue'],
    ['Show net and gross revenue for March 2026.', 'SUM(d.BillTotalAmount) AS net_revenue, SUM(d.GrossAmount) AS gross_revenue'],
    ['Revenue (gross and net) by store for March 2026.', 'SUM(d.GrossAmount) AS gross_revenue, SUM(d.BillTotalAmount) AS net_revenue'],
    ['Show revenue & gross in March 2026.', 'SUM(d.GrossAmount) AS revenue'],
    ['What was the revenue/gross ratio in March 2026?', 'SUM(d.BillTotalAmount) / SUM(d.GrossAmount) AS ratio'],
  ]) {
    assert.equal(rejects(question, `SELECT ${sql} ${march}`), 'METRIC_COLUMN', `${question} ${sql}`);
    assert.equal(rejects(question, `SELECT ${sql} ${march}`, 1), 'METRIC_COLUMN', `version 1: ${question} ${sql}`);
  }
  assert.equal(rejects('Show net and gross revenue for March 2026.', `SELECT SUM(d.NetAmount) AS net_revenue, SUM(d.GrossAmount) AS gross_revenue ${march}`), null);
  assert.equal(rejects('What was the revenue/gross ratio in March 2026?', `SELECT SUM(d.NetAmount) / SUM(d.GrossAmount) AS ratio ${march}`), null);
  assert.doesNotMatch(buildOptimizedPrompt(schema, 'Show net and gross revenue for March 2026.').user, /use the amount it names/);

  // Still modified, so still a hint: "net of ..." qualifies the amount, "net
  // payable" is another amount, "gross amount of revenue" is gross revenue.
  for (const [question, name] of [
    ['Gross revenue net of returns in March 2026.', 'net_sales'],
    ['Show gross revenue and the net payable amount in March 2026.', 'net_sales'],
    ['Gross revenue by network in March 2026.', 'net_sales'],
    ['Gross amount of revenue in March 2026.', 'net_sales'],
    ['The gross value of revenue in March 2026.', 'net_sales'],
    ['Revenue (gross) by store in March 2026.', 'net_sales'],
    ['Average order value (gross), March 2026.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['advisory', 'other_amount_named'], question);
  }
  assert.equal(rejects('Gross amount of revenue in March 2026.', `SELECT SUM(d.GrossAmount) AS gross_revenue ${march}`), null);
  // Version 1 enforces "revenue" in every one of them, as before.
  assert.equal(metricOf(v1Plan('Gross amount of revenue in March 2026.'), 'net_sales').enforcement, 'enforced');
  assert.equal(rejects('Gross amount of revenue in March 2026.', `SELECT SUM(d.GrossAmount) AS gross_revenue ${march}`, 1), 'METRIC_COLUMN');
});

// The verdict on `sql` for `question`: null when it passes, else the code.
function metricVerdict(question, sql, hintsVersion = 2) {
  const prompt = buildOptimizedPrompt(schema, question, { hintsVersion });
  try {
    validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), { promptContext: prompt.context, response: { sql, tables_used: ['SalesDocument'] } });
    return null;
  } catch (error) {
    return error.code;
  }
}
const marchDocuments = "FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'";

test('v2 layer: the net amount asked for in tax wording, or "net of tax" before the amount, leaves the metric enforced', () => {
  // Fourth review: these ask for the net amount as a measure of its own next
  // to the tax-included one, like "net and gross revenue", but only the
  // tax-included phrase was read (the net check matched the literal word
  // "net" and skipped "net of ..."), so SUM(GrossAmount) passed as the net
  // measure, which version 1 rejects.
  for (const [question, name] of [
    ['Show revenue including tax and excluding tax for March 2026.', 'net_sales'],
    ['Show revenue with tax and without tax for March 2026.', 'net_sales'],
    ['Show revenue with tax and without for March 2026.', 'net_sales'],
    ['Show revenue (tax included and excluded) for March 2026.', 'net_sales'],
    ['Show revenue (tax included / excluded) for March 2026.', 'net_sales'],
    ['Show revenue, tax included and excluded, for March 2026.', 'net_sales'],
    ['Show revenue including tax vs excluding tax for March 2026.', 'net_sales'],
    ['Show revenue including tax as well as excluding tax for March 2026.', 'net_sales'],
    ['Show revenue with tax & without tax for March 2026.', 'net_sales'],
    ['Show revenue including tax and net of tax for March 2026.', 'net_sales'],
    ['Show revenue incl. tax and excl. tax for March 2026.', 'net_sales'],
    ['Show revenue (with tax and before tax) for March 2026.', 'net_sales'],
    ['Show pre-tax and tax-inclusive revenue for March 2026.', 'net_sales'],
    ['Show ex-tax and incl tax revenue for March 2026.', 'net_sales'],
    ['Show net-of-tax and gross revenue for March 2026.', 'net_sales'],
    ['Show net of tax and gross revenue for March 2026.', 'net_sales'],
    ['Show revenue (gross, and net of tax) for March 2026.', 'net_sales'],
    ['Show the average order value including tax and excluding tax for March 2026.', 'average_order_value'],
    ['Show the average order value with tax and without tax for March 2026.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['enforced', 'explicit_metric_phrase'], question);
    assert.equal(metricOf(v1Plan(question), name)?.enforcement ?? 'enforced', 'enforced', question);
  }
  for (const question of [
    'Show revenue including tax and excluding tax for March 2026.',
    'Show revenue (tax included and excluded) for March 2026.',
    'Show net of tax and gross revenue for March 2026.',
  ]) {
    const wrong = `SELECT SUM(d.GrossAmount) AS net_revenue, SUM(d.GrossAmount) AS gross_revenue ${marchDocuments}`;
    assert.equal(metricVerdict(question, wrong), 'METRIC_COLUMN', question);
    assert.equal(metricVerdict(question, wrong, 1), 'METRIC_COLUMN', `version 1: ${question}`);
    assert.equal(metricVerdict(question, `SELECT SUM(d.NetAmount) AS net_revenue, SUM(d.GrossAmount) AS gross_revenue ${marchDocuments}`), null, question);
  }
  assert.equal(
    metricVerdict('Show the average order value with tax and without tax for March 2026.', `SELECT AVG(d.GrossAmount) AS aov_with_tax, AVG(d.GrossAmount) AS aov_without_tax ${marchDocuments}`),
    'METRIC_COLUMN'
  );
  // One tax-included amount, or "excluding" / "without" something other than
  // tax, is still a hint.
  for (const question of [
    'Show revenue including tax for March 2026.',
    'Show revenue (tax included) for March 2026.',
    'Show revenue (incl. tax) for March 2026.',
    'Show revenue with tax and without discounts for March 2026.',
    'Show revenue including tax, excluding returns, for March 2026.',
  ]) {
    assert.deepEqual([metricOf(v2Plan(question), 'net_sales').enforcement, metricOf(v2Plan(question), 'net_sales').enforcementReason], ['advisory', 'other_amount_named'], question);
    assert.equal(metricVerdict(question, `SELECT ROUND(SUM(COALESCE(d.GrossAmount,0)),2) AS revenue ${marchDocuments}`), null, question);
  }
});

test('v2 layer: a negated or unrelated "net" leaves a modified metric a hint', () => {
  // Fourth review: the previous fix counted the word "net" anywhere, so
  // "gross revenue, not net", "gross revenue instead of net" or "gross
  // revenue and net margin" enforced the metric and rejected the SUM(GrossAmount)
  // that rule 10 asks for (version 2 accepted it before). "net" counts only
  // when it is asked for: joined to the amount or the metric, not negated,
  // and not the start of another noun phrase.
  for (const [question, name] of [
    ['Show gross revenue, not net, in March 2026.', 'net_sales'],
    ['Show gross revenue (not net) by customer for March 2026.', 'net_sales'],
    ['Show revenue (gross, not net) in March 2026.', 'net_sales'],
    ['Show gross revenue instead of net in March 2026.', 'net_sales'],
    ['Show gross revenue rather than net in March 2026.', 'net_sales'],
    ['Show gross revenue excluding net in March 2026.', 'net_sales'],
    ['Show gross revenue excluding the net amount for March 2026.', 'net_sales'],
    ['Show gross revenue without net figures in March 2026.', 'net_sales'],
    ['Show gross revenue, never net, by store for March 2026.', 'net_sales'],
    ['Show revenue gross of tax, not net, for March 2026.', 'net_sales'],
    ['Show revenue on a gross (not net) basis for March 2026.', 'net_sales'],
    ['Show revenue including tax rather than net for March 2026.', 'net_sales'],
    ['Show gross revenue for March 2026, as opposed to net.', 'net_sales'],
    ['Gross revenue for March 2026; I do not need net.', 'net_sales'],
    ['Gross revenue for March 2026 (we already have net).', 'net_sales'],
    ['Show gross revenue and net margin for March 2026.', 'net_sales'],
    ['Show gross revenue and net terms by customer for March 2026.', 'net_sales'],
    ['Show gross revenue by net terms for March 2026.', 'net_sales'],
    ['Show gross revenue at Net Mart for March 2026.', 'net_sales'],
    ['Show gross revenue for the Net Store in March 2026.', 'net_sales'],
    ['Show gross revenue for the net-30 customers in March 2026.', 'net_sales'],
    ['Show gross revenue and the net amount payable in March 2026.', 'net_sales'],
    ['Show average order value including tax, not net, for March 2026.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['advisory', 'other_amount_named'], question);
    const sql = name === 'average_order_value' ? 'AVG(COALESCE(d.GrossAmount,0)) AS average_order_value' : 'ROUND(SUM(COALESCE(d.GrossAmount,0)),2) AS gross_revenue';
    assert.equal(metricVerdict(question, `SELECT ${sql} ${marchDocuments}`), null, question);
  }
  // "net" asked for next to the metric or another amount still enforces.
  for (const question of [
    'Show gross revenue vs net for March 2026.',
    'Show gross revenue and net by store for March 2026.',
    'Show revenue in gross and net terms for March 2026.',
    'Show not only net but also gross revenue for March 2026.',
    'Show gross minus net revenue for March 2026.',
    'Show the net to gross revenue ratio for March 2026.',
    'Show gross vs. net revenue for March 2026.',
  ]) {
    assert.equal(metricOf(v2Plan(question), 'net_sales').enforcement, 'enforced', question);
  }
});

test('v2 layer: only an adding tail after an amount in parentheses makes it a second measure', () => {
  // Fourth review: any adding word or joining symbol after the amount inside
  // the parentheses enforced the metric, whatever followed, so "revenue
  // (gross and units)", "(gross or tax included)" or "(gross/day)" rejected
  // the gross SQL they ask for (version 2 accepted it before).
  for (const [question, name] of [
    ['Show revenue (gross and units) by customer for March 2026.', 'net_sales'],
    ['Show revenue (gross, and units) by customer for March 2026.', 'net_sales'],
    ['Show revenue (gross or tax included) by customer for March 2026.', 'net_sales'],
    ['Show revenue (gross/tax included) for March 2026.', 'net_sales'],
    ['Show revenue (gross plus shipping) by customer for March 2026.', 'net_sales'],
    ['Show revenue (gross/day) for March 2026.', 'net_sales'],
    ['Show revenue (tax included) and units for March 2026.', 'net_sales'],
    ['Show the average order value (gross, and the count) for March 2026.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['advisory', 'other_amount_named'], question);
    const sql = name === 'average_order_value' ? 'AVG(COALESCE(d.GrossAmount,0)) AS average_order_value' : 'ROUND(SUM(COALESCE(d.GrossAmount,0)),2) AS gross_revenue';
    assert.equal(metricVerdict(question, `SELECT ${sql} ${marchDocuments}`), null, question);
  }
  // An adding tail, or the net amount next to the parenthesized one, is a
  // second measure: the metric stays enforced and SUM(GrossAmount) as the
  // revenue is rejected, as in version 1.
  for (const [question, name] of [
    ['Show revenue (gross too) in March 2026.', 'net_sales'],
    ['Show revenue (gross, too) in March 2026.', 'net_sales'],
    ['Show revenue (gross as well) in March 2026.', 'net_sales'],
    ['Show revenue (gross also) in March 2026.', 'net_sales'],
    ['Show revenue (tax included too) for March 2026.', 'net_sales'],
    ['Show revenue (gross and net) for March 2026.', 'net_sales'],
    ['Show revenue (gross & net) for March 2026.', 'net_sales'],
    ['Show revenue (gross vs net) for March 2026.', 'net_sales'],
    ['Show revenue (gross/net) for March 2026.', 'net_sales'],
    ['Show average order value (gross too) in March 2026.', 'average_order_value'],
  ]) {
    const metric = metricOf(v2Plan(question), name);
    assert.deepEqual([metric.enforcement, metric.enforcementReason], ['enforced', 'explicit_metric_phrase'], question);
  }
  assert.equal(metricVerdict('Show revenue (tax included too) for March 2026.', `SELECT SUM(d.GrossAmount) AS revenue ${marchDocuments}`), 'METRIC_COLUMN');
  assert.equal(metricVerdict('Show revenue (tax included too) for March 2026.', `SELECT SUM(d.GrossAmount) AS revenue ${marchDocuments}`, 1), 'METRIC_COLUMN');
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

// --- retrieval stopwords and aliases ----------------------------------------
// Generic words matched column comments and names by accident: "both days
// included" put NetPayableAmount in the relevance hint
// (tpl_total_net_sales_feb15_mar15_2026_40ae9d), "total" BillTotalAmount
// (edge_public_002_campaign_net_sales_march_2026), "units" SalePrice; and
// "account" was a Customer alias (tpl_account_net_movement_feb_2026_c1256b).

const hintOf = (question, hintsVersion) => {
  const user = buildOptimizedPrompt(schema, question, { hintsVersion }).user;
  return user.split('Retrieval relevance hint (a ranking only; every allowed table may be used):\n')[1].split('\n')[0];
};

test('v2 retrieval: generic words no longer pull accidental columns into the relevance hint', () => {
  const included = 'What was our turnover from 15 February 2026 through 15 March 2026, both days included?';
  assert.match(hintOf(included, 1), /NetPayableAmount/);
  assert.doesNotMatch(hintOf(included, 2), /NetPayableAmount/);
  const total = 'What were the total sales for the Urban Refresh campaign in March 2026?';
  assert.match(hintOf(total, 1), /BillTotalAmount/);
  assert.doesNotMatch(hintOf(total, 2), /BillTotalAmount|TotalAmount/);
  const units = 'Which three customers bought the most units in Q1 2026?';
  assert.match(hintOf(units, 1), /SalePrice/);
  assert.doesNotMatch(hintOf(units, 2), /SalePrice/);
  assert.match(hintOf('How many distinct customers did we sell to in 2025?', 1), /NetPayableAmount/);
  assert.doesNotMatch(hintOf('How many distinct customers did we sell to in 2025?', 2), /NetPayableAmount/);

  const v2Tokens = buildQuestionContext(included, { hintsVersion: 2 }).questionTokens;
  const v1Tokens = buildQuestionContext(included, { hintsVersion: 1 }).questionTokens;
  assert.ok(v1Tokens.includes('included') && !v2Tokens.includes('included'));
  // Only those words go: everything else is the same token list.
  assert.deepEqual(v2Tokens, v1Tokens.filter((token) => token !== 'included'));
  // The semantic plan does not read them: "units" still matches quantity_sold.
  assert.ok(metricOf(v2Plan(units), 'quantity_sold'));
});

test('v2 retrieval: "account" is no Customer alias, so ledger questions do not rank Customer', () => {
  const question = 'Total debits posted to account 1100 in March 2026.';
  const customer = schema.tables.find((table) => table.tableName === 'Customer');
  const tokens = buildQuestionContext(question, { hintsVersion: 2 }).questionTokens;
  assert.ok(scoreTableDetailed(customer, tokens, { hintsVersion: 1 }).matches.some((match) => match.reasons.includes('table_alias')));
  assert.ok(!scoreTableDetailed(customer, tokens, { hintsVersion: 2 }).matches.some((match) => match.reasons.includes('table_alias')));
  // Only the table description ("account") still scores, after the ledger tables.
  const score = (hintsVersion) => retrieveRelevantTables(schema, question, { hintsVersion }).tableScores.find((entry) => entry.tableName === 'Customer');
  assert.ok(score(2).lexicalScore < score(1).lexicalScore);
  assert.ok(score(2).semanticScore < score(1).semanticScore, 'and the customer entity no longer matches');
  assert.deepEqual(retrieveRelevantTables(schema, question, { hintsVersion: 2 }).initialTableNames.slice(0, 2), ['LedgerAccount', 'AccountingPosting']);
});

// --- METRIC_COLUMN: an account name is not a sales metric --------------------
// "Monthly credits posted to account 4000 (Sales Revenue) in Q1 2026."
// enforced net_sales on "revenue", so the guardrail rejected the gold, every
// alternative and the positive control (tpl_revenue_credits_monthly_q1_2026_e1b20a,
// known_validator_rejection: METRIC_COLUMN); the retry then added NetAmount
// and hit FAN_OUT.

const LEDGER_QUESTION = 'Monthly credits posted to account 4000 (Sales Revenue) in Q1 2026.';
const LEDGER_GOLD =
  "SELECT DATE_FORMAT(p.PostingDate, '%Y-%m') AS posting_month, ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_credit FROM AccountingPosting p JOIN LedgerAccount a ON p.LedgerAccountId = a.LedgerAccountId WHERE p.PostingDate >= '2026-01-01' AND p.PostingDate < '2026-04-01' AND a.AccountCode = '4000' GROUP BY DATE_FORMAT(p.PostingDate, '%Y-%m') ORDER BY posting_month";

function validateUnder(question, sql, hintsVersion) {
  const prompt = buildOptimizedPrompt(schema, question, { hintsVersion });
  try {
    validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), {
      promptContext: prompt.context,
      response: { sql, tables_used: validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName)).tablesUsed },
    });
    return null;
  } catch (error) {
    return error.code;
  }
}

test('v2 METRIC_COLUMN: "account <code> (<name>)" consumes the metric words in the account name', () => {
  assert.equal(metricOf(v1Plan(LEDGER_QUESTION), 'net_sales').enforcement, 'enforced');
  assert.equal(metricOf(v2Plan(LEDGER_QUESTION), 'net_sales'), null);
  assert.equal(metricOf(v2Plan(LEDGER_QUESTION), 'credit_amount').enforcement, 'enforced');
  assert.ok(v2Plan(LEDGER_QUESTION).entities.some((entity) => entity.name === 'ledger_account'));
  assert.doesNotMatch(buildOptimizedPrompt(schema, LEDGER_QUESTION).user, /Metric "net_sales"/);
  // A quoted account name after the code is one reference too.
  assert.equal(metricOf(v2Plan('Credits posted to account 4000 "Sales Revenue" in March 2026.'), 'net_sales'), null);

  assert.equal(validateUnder(LEDGER_QUESTION, LEDGER_GOLD, 1), 'METRIC_COLUMN');
  assert.equal(validateUnder(LEDGER_QUESTION, LEDGER_GOLD, 2), null);
  // Leaving out the ledger measure is still rejected.
  const noCredit = "SELECT ROUND(SUM(COALESCE(p.DebitAmount, 0)), 2) AS total_debit FROM AccountingPosting p JOIN LedgerAccount a ON p.LedgerAccountId = a.LedgerAccountId WHERE a.AccountCode = '4000'";
  assert.equal(validateUnder(LEDGER_QUESTION, noCredit, 2), 'METRIC_COLUMN');
  // Without an account reference, an explicit sales phrase still enforces.
  assert.equal(metricOf(v2Plan('Which products brought in the most revenue in March 2026?'), 'net_sales').enforcement, 'enforced');
});

test('v2 METRIC_COLUMN: a question asking for a sales measure and a ledger measure enforces both', () => {
  // Review finding: demoting every sales metric once a debit or credit
  // metric matched let a wrong sales column through.
  const credits = 'What were net sales and total credits in March 2026?';
  const creditsWrong =
    "SELECT ROUND(SUM(COALESCE(d.BillTotalAmount,0)),2) AS net_sales, (SELECT ROUND(SUM(COALESCE(p.CreditAmount,0)),2) FROM AccountingPosting p WHERE p.PostingDate >= '2026-03-01' AND p.PostingDate < '2026-04-01') AS credits FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'";
  const creditsRight = creditsWrong.replace('d.BillTotalAmount', 'd.NetAmount');
  const debits = 'Show net sales and debits for March 2026.';
  const debitsWrong =
    "SELECT ROUND(SUM(COALESCE(d.GrossAmount,0)),2) AS net_sales, (SELECT SUM(p.DebitAmount) FROM AccountingPosting p WHERE p.PostingDate >= '2026-03-01' AND p.PostingDate < '2026-04-01') AS debits FROM SalesDocument d WHERE IFNULL(d.IsCanceled,0)=0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'";
  for (const hintsVersion of [1, 2]) {
    assert.equal(validateUnder(credits, creditsWrong, hintsVersion), 'METRIC_COLUMN', `v${hintsVersion} credits`);
    assert.equal(validateUnder(credits, creditsRight, hintsVersion), null, `v${hintsVersion} credits, right column`);
    assert.equal(validateUnder(debits, debitsWrong, hintsVersion), 'METRIC_COLUMN', `v${hintsVersion} debits`);
  }
  assert.equal(metricOf(v2Plan(credits), 'net_sales').enforcement, 'enforced');
  // The derived line-level metric keeps its enforcement as well.
  const products = v2Plan('Top products by net sales in March 2026, and their credits.');
  assert.equal(metricOf(products, 'line_net_sales').enforcement, 'enforced');
  // Sales words outside the account name still match next to an account reference.
  const both = v2Plan('Net sales and credits to account 4000 (Sales Revenue) in March 2026.');
  assert.equal(metricOf(both, 'net_sales').enforcement, 'enforced');
  assert.ok(!metricOf(both, 'net_sales').matchedSynonyms.includes('revenue'));
});

test('verification: a flag the default hints version no longer needs but version 1 does is a note, not a stale flag', async () => {
  const fixture = { name: 'seed', database: 'demo_retail', connection: { async query() { return [[{ posting_month: '2026-01', total_credit: 1 }]]; } } };
  const testCase = normalizeBenchmarkCase({ id: 'ledger_case', question: LEDGER_QUESTION, expected_sql: LEDGER_GOLD, known_validator_rejection: 'METRIC_COLUMN' });
  const verify = (hintsVersion) => verifyCase(testCase, { connections: [fixture], validate: createValidatorProbe({ schema, hintsVersion }), checkControls: false });

  const v1 = await verify(1);
  assert.deepEqual(v1.problems, []);
  assert.ok(v1.notes.includes('expected_sql: known validator rejection (METRIC_COLUMN)'));

  const v2 = await verify(2);
  assert.deepEqual(v2.problems, []);
  assert.deepEqual(v2.warnings, []);
  assert.ok(
    v2.notes.includes('known_validator_rejection METRIC_COLUMN: the validator accepts the gold under hints version 2, but still rejects it under HINTS_VERSION=1, which keeps the flag'),
    v2.notes.join('; ')
  );

  // A flag no supported version needs is stale, as before.
  const stale = normalizeBenchmarkCase({ ...testCase, known_validator_rejection: 'FAN_OUT' });
  const result = await verifyCase(stale, { connections: [fixture], validate: createValidatorProbe({ schema }), checkControls: false });
  assert.match(result.problems.join('\n'), /known_validator_rejection is FAN_OUT, but the production validator accepts the gold now: remove the flag/);
  const probe = createValidatorProbe({ schema });
  assert.equal(probe.forHintsVersion(2), probe);
  assert.equal(probe.forHintsVersion(1).hintsVersion, 1);
  assert.equal(probe.forHintsVersion(1), probe.forHintsVersion('1'));
});
