import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUSINESS_RULES, BUSINESS_RULES_V2, businessRulesFor, DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { buildOptimizedPrompt, buildQuestionContext, extractTemporalReferences } from '../src/pipeline.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

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
