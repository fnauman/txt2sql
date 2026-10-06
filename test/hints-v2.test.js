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
