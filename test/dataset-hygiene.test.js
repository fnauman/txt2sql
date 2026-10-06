import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildEvalDataset,
  caseIdFor,
  CONTROLS_PATH,
  DATASET_PATH,
  FORMER_HOLDOUT_PERCENT,
  FORMERLY_HOLDOUT_TAG,
  INTENT_CATALOGUE,
  serialize,
  wasHoldoutIntent,
} from '../scripts/build-eval-dataset.mjs';
import {
  buildHoldoutDataset,
  CONTROLS_PATH as HOLDOUT_CONTROLS_PATH,
  DATASET_NAME as HOLDOUT_DATASET,
  DATASET_PATH as HOLDOUT_DATASET_PATH,
  FROZEN_HINTS_V2_VOCABULARY,
  HOLDOUT_INTENTS,
  holdoutCaseIdFor,
  semanticLayerPhrases,
  semanticLayerPhrasesIn,
  vocabularyLayers,
} from '../scripts/build-holdout-dataset.mjs';
import { CASE_SPLITS, isDatasetFileName, normalizeBenchmarkCase, topLevelLimitRowCount } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES, FEW_SHOT_EXAMPLES } from '../src/constants.js';
import { goldFingerprint, loadControlsIndex, normalizeSqlText, resolveCaseControls } from '../src/eval/controls.js';
import { MASTER_DATA } from '../src/eval/fixture-data.js';
import { FIXTURES } from '../src/eval/fixtures.js';
import { dedupeSuiteCases, scoringFingerprint } from '../src/eval/suite.js';
import { createValidatorProbe } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { isKeywordToken, tokenizeSql } from '../src/sql-tokenizer.js';

// Dataset hygiene (audit plan 2.6): splits, the holdout's vocabulary, id
// stability, leakage into the prompt, pins, and the generator's determinism.
// Every check reads the committed files; none needs a database.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');
const LEGACY_DATASETS = ['core-public', 'paraphrase-public', 'edge-cases-public'];
// The datasets written before the holdout was retired: every case in them is
// dev. The holdout lives elsewhere (authored blind, frozen by the manifest).
const DEV_ONLY_DATASETS = [...LEGACY_DATASETS, 'templated-public', 'hard-cases-public'];
// The fresh holdout (v2, scripts/build-holdout-dataset.mjs): authored blind and
// held out as a whole, so its split is 'holdout' by construction, not by an
// intent hash, and its ids embed a hash of the question like the templated ones.
const FRESH_HOLDOUT = HOLDOUT_DATASET;

const datasets = Object.fromEntries(
  fs
    .readdirSync(DATASETS_DIR)
    .filter(isDatasetFileName)
    .sort()
    .map((name) => [path.basename(name, '.json'), JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, name), 'utf8'))])
);
const allCases = Object.entries(datasets).flatMap(([dataset, cases]) => cases.map((testCase) => ({ dataset, testCase })));
const normalized = Object.entries(datasets).map(([name, cases]) => ({ name, cases: cases.map(normalizeBenchmarkCase) }));
const layer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'metadata/semantic-layer.json'), 'utf8'));
const isBehavior = (testCase) => Boolean(testCase.expected_behavior) && testCase.expected_behavior !== 'answer';

// Independent of the generator's own matcher: every multi-word phrase the
// semantic layer could match on (entity, metric and filter-hint synonyms,
// value aliases and their canonical values, clarification triggers),
// compared as whole lower-case words, a plural ending included.
function layerPhrases() {
  const collect = [];
  for (const entity of layer.entities || []) collect.push(...(entity.synonyms || []));
  for (const metric of layer.metrics || []) collect.push(...(metric.synonyms || []), ...(metric.advisory_synonyms || []), ...(metric.count_advisory_synonyms || []));
  for (const hint of layer.filter_hints || []) collect.push(...(hint.synonyms || []));
  for (const alias of layer.value_aliases || []) collect.push(alias.canonical_value, ...(alias.aliases || []));
  for (const rule of layer.clarification_rules || []) collect.push(rule.trigger);
  return [...new Set(collect.map((phrase) => String(phrase).toLowerCase().trim()).filter((phrase) => phrase.split(/\s+/).length > 1))];
}
const words = (text) => ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

test('(e) every committed case has an explicit, valid split; the original datasets are dev, formerly holdout cases are tagged', () => {
  // The holdout of the hash rule (wasHoldoutIntent) was inspected during the
  // Experiment 1 error analysis, so every one of its cases is dev now, tagged
  // formerly_holdout; legacy intents (and hard cases rephrasing them) never
  // were holdout.
  const legacyIntents = new Set(LEGACY_DATASETS.flatMap((name) => datasets[name].map((testCase) => testCase.intentId)));
  for (const { dataset, testCase } of allCases) {
    assert.ok(CASE_SPLITS.includes(testCase.split), `${dataset}/${testCase.id} split ${testCase.split}`);
    const formerly = (testCase.tags || []).includes(FORMERLY_HOLDOUT_TAG);
    if (DEV_ONLY_DATASETS.includes(dataset)) {
      assert.equal(testCase.split, 'dev', `${dataset}/${testCase.id}: the holdout of these datasets was retired (formerly_holdout)`);
      const wasHoldout = !LEGACY_DATASETS.includes(dataset) && !legacyIntents.has(testCase.intentId) && wasHoldoutIntent(testCase.intentId);
      assert.equal(formerly, wasHoldout, `${dataset}/${testCase.id}: tagged ${FORMERLY_HOLDOUT_TAG} exactly when the retired rule held it out`);
    } else if (dataset === FRESH_HOLDOUT) {
      assert.equal(testCase.split, 'holdout', `${dataset}/${testCase.id}: the fresh holdout is held out as a whole`);
      assert.equal(formerly, false, `${dataset}/${testCase.id}: the fresh holdout was never inspected`);
    } else {
      assert.equal(formerly && testCase.split === 'holdout', false, `${dataset}/${testCase.id}: a formerly holdout case cannot be holdout again`);
    }
  }
  assert.throws(() => normalizeBenchmarkCase({ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', split: 'train' }), /split "train"/);
});

test('(d) every intent has one split across all its phrasings and datasets', () => {
  const splits = new Map();
  for (const { dataset, testCase } of allCases) {
    const seen = splits.get(testCase.intentId) || new Map();
    seen.set(testCase.split, `${dataset}/${testCase.id}`);
    splits.set(testCase.intentId, seen);
  }
  for (const [intentId, seen] of splits) {
    assert.equal(seen.size, 1, `${intentId} has phrasings in ${[...seen.entries()].map(([split, where]) => `${split} (${where})`).join(' and ')}`);
  }
});

test('(d) one gold SQL belongs to one intent (so a holdout intent is never a dev query in other words)', () => {
  const intentOf = new Map();
  for (const { dataset, testCase } of allCases) {
    if (!testCase.expected_sql) {
      continue;
    }
    const key = normalizeSqlText(testCase.expected_sql).toLowerCase();
    const previous = intentOf.get(key);
    if (previous) {
      assert.equal(testCase.intentId, previous.intentId, `${dataset}/${testCase.id} has the gold of ${previous.where} under another intent`);
    } else {
      intentOf.set(key, { intentId: testCase.intentId, where: `${dataset}/${testCase.id}` });
    }
  }
});

test('(a) holdout questions contain no multi-word phrase of the semantic layer', () => {
  const phrases = layerPhrases();
  assert.ok(phrases.includes('net sales') && phrases.includes('sales documents') && phrases.includes('credit memo'));
  // Every holdout case, whichever dataset holds it (none while the fresh
  // holdout is being authored).
  const holdout = allCases.filter(({ testCase }) => testCase.split === 'holdout');
  for (const { dataset, testCase } of holdout) {
    const text = words(testCase.question);
    const found = phrases.filter((phrase) => [' ', 's ', 'es '].some((ending) => text.includes(`${words(phrase).trimEnd()}${ending}`)));
    assert.deepEqual(found, [], `${dataset}/${testCase.id}: "${testCase.question}"`);
  }
  // The matcher itself: whole words, plurals included.
  assert.ok(words('How many credit memos?').includes(`${words('credit memo').trimEnd()}s `));
  assert.ok(!words('net salesperson').includes(`${words('net sales').trimEnd()} `));
});

// The single-word metric synonyms the semantic layer ENFORCES (a metric
// guardrail rejects SQL without the metric's column): synonyms that are not
// advisory. Today that is "revenue" (net sales); "sales", "sold" and the
// like are advisory, and "debit" / "credit" are the only names of those
// measures (advisory in count questions).
function enforcedSingleWordSynonyms() {
  const enforced = new Set();
  for (const metric of layer.metrics || []) {
    const advisory = new Set([...(metric.advisory_synonyms || []), ...(metric.count_advisory_synonyms || [])].map((word) => word.toLowerCase()));
    for (const synonym of metric.synonyms || []) {
      const word = synonym.toLowerCase().trim();
      if (!word.includes(' ') && !advisory.has(word)) {
        enforced.add(word);
      }
    }
  }
  return [...enforced].sort();
}

test('(a) holdout questions avoid the enforced single-word metric synonyms too (master-data names aside)', () => {
  const enforced = enforcedSingleWordSynonyms();
  assert.deepEqual(enforced, ['revenue'], 'the semantic layer changed: review the holdout wording rule');
  // A master-data name is a value, not a metric word ("Sales Revenue" is a
  // ledger account): strip those before matching.
  const names = [
    ...MASTER_DATA.LedgerAccount.map((row) => row.AccountName),
    ...MASTER_DATA.Product.map((row) => row.ProductName),
    ...MASTER_DATA.Brand.map((row) => row.BrandName),
    ...MASTER_DATA.Customer.map((row) => row.CustomerName),
    ...MASTER_DATA.StoreLocation.map((row) => row.LocationName),
    ...MASTER_DATA.Campaign.map((row) => row.CampaignName),
  ].map((name) => words(name).trim());
  const holdout = allCases.filter(({ testCase }) => testCase.split === 'holdout');
  for (const { dataset, testCase } of holdout) {
    let text = words(testCase.question);
    for (const name of names) {
      text = text.split(` ${name} `).join(' ');
    }
    const found = enforced.filter((word) => text.includes(` ${word} `) || text.includes(` ${word}s `));
    assert.deepEqual(found, [], `${dataset}/${testCase.id}: "${testCase.question}"`);
  }
});

test('(b) no dataset question or gold SQL is a few-shot example (and none is close)', () => {
  const questions = new Set(allCases.map(({ testCase }) => words(testCase.question)));
  const golds = new Set(allCases.flatMap(({ testCase }) => [testCase.expected_sql, ...(testCase.alternative_expected_sql || [])].filter(Boolean).map((sql) => normalizeSqlText(sql).toLowerCase())));
  for (const example of FEW_SHOT_EXAMPLES) {
    assert.ok(!questions.has(words(example.question)), `few-shot question "${example.question}" is a dataset question`);
    assert.ok(!golds.has(normalizeSqlText(example.sql).toLowerCase()), `few-shot "${example.question}" is a gold SQL`);
  }
  // Near-duplicates (token Jaccard) are test/few-shot-leakage.test.js's job;
  // it reads every dataset, these included.
  assert.ok(Object.keys(datasets).includes('templated-public') && Object.keys(datasets).includes('hard-cases-public'));
});

test('(c) ids are unique across datasets unless the cases are identical, and a templated id is bound to its question', () => {
  const byId = new Map();
  for (const { dataset, testCase } of allCases) {
    const key = testCase.id;
    const current = normalizeBenchmarkCase(testCase);
    const previous = byId.get(key);
    if (previous) {
      assert.equal(normalizeSqlText(current.question), normalizeSqlText(previous.testCase.question), `${key} reused for another question (${previous.dataset}, ${dataset})`);
      assert.equal(scoringFingerprint(current), scoringFingerprint(previous.testCase), `${key} scored differently in ${previous.dataset} and ${dataset}`);
      assert.ok(LEGACY_DATASETS.includes(dataset) && LEGACY_DATASETS.includes(previous.dataset), `${key}: only the edge suite repeats (core) cases`);
    } else {
      byId.set(key, { dataset, testCase: current });
    }
  }
  for (const testCase of datasets['templated-public']) {
    assert.equal(testCase.id, caseIdFor(testCase.intentId, testCase.question), `${testCase.id}: the id embeds a hash of its question`);
  }
  for (const testCase of datasets[FRESH_HOLDOUT]) {
    assert.equal(testCase.id, holdoutCaseIdFor(testCase.intentId, testCase.question), `${testCase.id}: the id embeds a hash of its question`);
  }
  // Hand-written ids are bound to their question by a committed registry
  // (id -> first 12 hex of sha256 of the whitespace-normalized question):
  // editing a question in place under the same id fails here; give the new
  // question a new id. A registry entry without a case is a retired id.
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/case-question-registry.json'), 'utf8')).ids;
  const questionHash = (question) => crypto.createHash('sha256').update(normalizeSqlText(question)).digest('hex').slice(0, 12);
  for (const { dataset, testCase } of allCases.filter((entry) => !['templated-public', FRESH_HOLDOUT].includes(entry.dataset))) {
    assert.ok(registry[testCase.id], `${dataset}/${testCase.id} is not in test/fixtures/case-question-registry.json: add it (a new id)`);
    assert.equal(questionHash(testCase.question), registry[testCase.id], `${dataset}/${testCase.id} changed its question: use a new id for the new question`);
  }
  // Ids recorded in committed reports keep their question.
  const recorded = [path.join(REPO_ROOT, 'test/fixtures/eval-recorded-report.json')];
  const baselines = path.join(REPO_ROOT, 'eval/baselines');
  for (const name of fs.readdirSync(baselines).filter((file) => file.endsWith('.json'))) {
    recorded.push(path.join(baselines, name));
  }
  for (const file of recorded) {
    for (const record of JSON.parse(fs.readFileSync(file, 'utf8')).results || []) {
      const current = byId.get(record.id);
      if (current) {
        assert.equal(normalizeSqlText(current.testCase.question), normalizeSqlText(record.question), `${record.id} changed its question since ${path.relative(REPO_ROOT, file)}`);
      }
    }
  }
});

test('(f) every answer case pins its gold row count on seed, v2 and v3; behavior cases pin nothing', () => {
  const fixtureNames = FIXTURES.map((fixture) => fixture.name);
  for (const { dataset, testCase } of allCases) {
    if (isBehavior(testCase)) {
      assert.equal(testCase.expected_row_counts, undefined, `${dataset}/${testCase.id}`);
      assert.equal(testCase.expected_sql, undefined, `${dataset}/${testCase.id}`);
      continue;
    }
    assert.deepEqual(Object.keys(testCase.expected_row_counts || {}), fixtureNames, `${dataset}/${testCase.id} pins`);
    assert.ok(Object.values(testCase.expected_row_counts).every((count) => Number.isInteger(count) && count >= 0), `${dataset}/${testCase.id} pins`);
  }
});

// The keys of a query's outermost ORDER BY (split at depth-0 commas), or [].
function outermostOrderByKeys(sql) {
  const tokens = tokenizeSql(sql).filter((token) => token.type !== 'whitespace' && token.type !== 'comment');
  let depth = 0;
  let keys = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const atTop = depth === 0;
    if (token.type === 'punct' && token.value === '(') depth += 1;
    if (token.type === 'punct' && token.value === ')') depth -= 1;
    if (atTop && isKeywordToken(token, 'ORDER') && isKeywordToken(tokens[index + 1], 'BY')) {
      keys = [''];
      index += 1;
    } else if (atTop && isKeywordToken(token, 'LIMIT')) {
      break;
    } else if (keys && atTop && token.type === 'punct' && token.value === ',') {
      keys.push('');
    } else if (keys) {
      keys[keys.length - 1] = `${keys[keys.length - 1]} ${token.value}`.trim();
    }
  }
  return keys ?? [];
}

test('(h) every gold with a LIMIT orders by a tiebreak after its metric, so the rows it keeps are deterministic', () => {
  // The oracle lets a prediction swap items tied at a gold's cut-off (ties at
  // the cut-off), but the gold itself must not depend on the execution plan.
  const offenders = [];
  for (const { dataset, testCase } of allCases) {
    for (const sql of [testCase.expected_sql, ...(testCase.alternative_expected_sql || [])].filter(Boolean)) {
      const keys = outermostOrderByKeys(sql);
      if (topLevelLimitRowCount(sql) !== null && keys.length < 2) {
        offenders.push(`${dataset}/${testCase.id}: ORDER BY ${keys.join(', ') || '(none)'}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // The live baseline's tie-blind SQL for tpl_product_qty_top5_feb_2026_8a9dc1 would be flagged.
  const tieBlind =
    'SELECT p.ProductName, ROUND(SUM(sdl.Quantity), 3) AS total_qty FROM SalesDocument sd JOIN SalesDocumentLine sdl ON sd.SalesDocumentId = sdl.SalesDocumentId ' +
    'JOIN Product p ON sdl.ProductId = p.ProductId GROUP BY p.ProductId, p.ProductName ORDER BY SUM(sdl.Quantity) DESC LIMIT 5';
  assert.deepEqual(outermostOrderByKeys(tieBlind), ['SUM ( sdl . Quantity ) DESC']);
  assert.deepEqual(outermostOrderByKeys(`${tieBlind.replace(' LIMIT 5', '')}, p.ProductName ASC LIMIT 5`), ['SUM ( sdl . Quantity ) DESC', 'p . ProductName ASC']);
});

test('(g) the templated generator reproduces the committed dataset and controls byte for byte', async () => {
  const committedDataset = fs.readFileSync(DATASET_PATH, 'utf8');
  const committedControls = fs.readFileSync(CONTROLS_PATH, 'utf8');
  const built = buildEvalDataset({ previousCases: JSON.parse(committedDataset) });
  assert.deepEqual(built.problems, []);
  assert.equal(serialize(built.cases), committedDataset, 'datasets/templated-public.json is stale: run npm run build-eval-dataset');
  assert.equal(serialize(built.controls), committedControls, 'datasets/controls/templated-public.json is stale: run npm run build-eval-dataset');
  // Deterministic: a second build is identical.
  const again = buildEvalDataset({ previousCases: JSON.parse(committedDataset) });
  assert.equal(serialize(again.cases), committedDataset);
  assert.equal(serialize(again.controls), committedControls);
  // Without the committed pins, only expected_row_counts differ.
  const unpinned = buildEvalDataset({ previousCases: [] });
  assert.deepEqual(
    unpinned.cases,
    built.cases.map(({ expected_row_counts: _pins, ...rest }) => rest)
  );
});

test('the generator emits dev cases only, tags the retired holdout, and keeps 2-3 phrasings per intent', () => {
  for (const intent of INTENT_CATALOGUE) {
    assert.ok(intent.phrasings.length >= 2 && intent.phrasings.length <= 3, intent.intentId);
  }
  const { cases } = buildEvalDataset();
  assert.deepEqual([...new Set(cases.map((testCase) => testCase.split))], ['dev']);
  for (const testCase of cases) {
    assert.equal(testCase.tags.includes(FORMERLY_HOLDOUT_TAG), wasHoldoutIntent(testCase.intentId), testCase.id);
  }
  // The retired rule, as it was: about 42% of the intent ids.
  assert.equal(FORMER_HOLDOUT_PERCENT, 42);
  assert.equal(new Set(cases.filter((testCase) => testCase.tags.includes(FORMERLY_HOLDOUT_TAG)).map((testCase) => testCase.intentId)).size, 35);
});

test('suite composition: 100-150 intents, the retired holdout tagged, behaviour cases and every hard-case category', () => {
  // The datasets of the retired hash split; the fresh holdout has its own
  // composition test.
  const hashSplit = dedupeSuiteCases(normalized.filter(({ name }) => name !== FRESH_HOLDOUT)).entries.map((entry) => entry.testCase);
  const intents = new Set(hashSplit.map((testCase) => testCase.intentId));
  assert.ok(intents.size >= 100 && intents.size <= 150, `${intents.size} intents`);
  // The 81 cases (45 intents) of the retired holdout are dev, tagged.
  const formerly = hashSplit.filter((testCase) => testCase.tags.includes(FORMERLY_HOLDOUT_TAG));
  assert.deepEqual([formerly.length, new Set(formerly.map((testCase) => testCase.intentId)).size], [81, 45]);
  assert.ok(formerly.every((testCase) => testCase.split === 'dev'));

  const hard = datasets['hard-cases-public'];
  const tagged = (tag) => hard.filter((testCase) => testCase.tags.includes(tag));
  for (const tag of ['new_vocabulary', 'swedish', 'bilingual', 'typo', 'relative_date', 'named_entity', 'zero_row', 'unanswerable', 'ambiguous']) {
    assert.ok(tagged(tag).length >= 1, `hard cases tagged ${tag}`);
  }
  assert.ok(hard.length >= 25 && hard.length <= 40, `${hard.length} hard cases`);
  assert.ok(tagged('unanswerable').every((testCase) => testCase.expected_behavior === 'abstain'));
  assert.ok(tagged('ambiguous').some((testCase) => testCase.expected_behavior === 'clarify'));
  assert.ok(tagged('ambiguous').some((testCase) => (testCase.alternative_expected_sql || []).length > 0), 'an ambiguous case with two accepted readings');
  assert.ok(hard.some((testCase) => /Summit Grocers/.test(testCase.question) && testCase.expected_behavior === 'clarify'), 'the duplicate customer name as a clarify case');
  assert.ok(tagged('relative_date').every((testCase) => /\b(20\d\d-\d\d-\d\d|\d{1,2} \w+ 20\d\d)\b/.test(testCase.question)), 'relative dates carry an explicit as-of date');
  // Zero-row answers: empty on every fixture, or one NULL / 0 row.
  for (const testCase of tagged('zero_row')) {
    const counts = Object.values(testCase.expected_row_counts);
    assert.ok(counts.every((count) => count === 0) || counts.every((count) => count === 1), testCase.id);
  }
  assert.ok(tagged('zero_row').some((testCase) => Object.values(testCase.expected_row_counts).every((count) => count === 0)), 'an empty result on every fixture');
  // Behaviour cases are a small, separate group.
  const behavior = hashSplit.filter(isBehavior);
  assert.ok(behavior.length >= 8, `${behavior.length} behaviour cases`);
  assert.ok(behavior.every((testCase) => testCase.expected_tables.length === 0 && testCase.alternative_expected_sql.length === 0));
});

test('controls: every templated intent and every hard case with controls resolves current, non-stale controls', async () => {
  const index = await loadControlsIndex();
  for (const testCase of datasets['templated-public'].map(normalizeBenchmarkCase)) {
    const resolved = resolveCaseControls(testCase, index);
    assert.equal(resolved.stale, false, testCase.id);
    assert.ok(resolved.negative.length >= 3, `${testCase.id}: ${resolved.negative.length} negative controls`);
  }
  for (const testCase of datasets['hard-cases-public'].map(normalizeBenchmarkCase)) {
    const resolved = resolveCaseControls(testCase, index);
    assert.equal(resolved.stale, false, testCase.id);
    if (isBehavior(testCase)) {
      assert.equal(resolved.source, null, `${testCase.id}: a behavior case has no controls`);
    }
  }
  // The generator records why a family was not emitted for an intent.
  const controls = JSON.parse(fs.readFileSync(CONTROLS_PATH, 'utf8'));
  const skipped = Object.values(controls).flatMap((entry) => entry.not_emitted || []);
  assert.ok(skipped.length > 0 && skipped.every((entry) => entry.type && entry.reason.length > 20));
  for (const entry of Object.values(controls)) {
    assert.equal(entry.gold_fingerprint, goldFingerprint(datasets['templated-public'].find((testCase) => testCase.intentId === entry.intentId).expected_sql));
  }
  // Mutation families per template: a dropped GROUP BY key for every intent
  // with two grouping keys or a month series; both off-by-one sides of every
  // window, each either emitted or recorded under not_emitted with its
  // reason; held-out mutants marked as such.
  const byIntent = new Map(INTENT_CATALOGUE.map((intent) => [intent.intentId, intent]));
  for (const entry of Object.values(controls)) {
    const intent = byIntent.get(entry.intentId);
    const notes = (type) => [...entry.negative.filter((control) => control.type === type).map((control) => control.note), ...(entry.not_emitted || []).filter((skip) => skip.type === type).map((skip) => skip.note || skip.reason)];
    if ((intent.dims || []).length > 1 || intent.series) {
      assert.ok(notes('group_by').some((note) => /dropped from GROUP BY/.test(note)), `${intent.intentId}: a missing GROUP BY key mutant`);
    }
    if (intent.window || intent.windows) {
      const sides = notes('date_boundary');
      assert.ok(sides.some((note) => /first day/.test(note)) && sides.some((note) => /day after/.test(note)), `${intent.intentId}: both off-by-one sides (${sides.join(' | ')})`);
    }
    for (const control of entry.negative) {
      assert.equal(control.heldout === true, control.id.startsWith('h'), `${intent.intentId}/${control.id}: h* ids are exactly the held-out mutants`);
    }
  }
  assert.ok(Object.values(controls).some((entry) => entry.negative.some((control) => control.heldout)), 'a held-out tier exists');
});

// The offline twin of verify-dataset's validator check for the new datasets:
// every gold passes the production validator in its real prompt context, and
// every gold flagged known_validator_rejection is still rejected with that
// code (the gate in verify-dataset fails once it is accepted).
test('known validator rejections are real and current; every other new gold and positive control passes the validator', async () => {
  const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
  const validate = createValidatorProbe({ schema });
  // Every flag was measured with hints version 1's prompts (the A/B control
  // arm). The dev flag (METRIC_COLUMN) is a gap of version 1 that version 2
  // (the default) closes; the fresh holdout's flags are only checked to be
  // real under version 1 and consistent under version 2.
  const validateV1 = validate.forHintsVersion(1);
  const index = await loadControlsIndex();
  const flaggedBy = {};
  for (const name of ['templated-public', 'hard-cases-public', FRESH_HOLDOUT]) {
    flaggedBy[name] = 0;
    for (const testCase of datasets[name].map(normalizeBenchmarkCase).filter((entry) => !isBehavior(entry))) {
      const variants = [testCase.expected_sql, ...testCase.alternative_expected_sql];
      const rejections = await Promise.all(variants.map((sql) => validate(testCase.question, sql)));
      const known = testCase.known_validator_rejection;
      if (known) {
        flaggedBy[name] += 1;
        const v1Rejections = await Promise.all(variants.map((sql) => validateV1(testCase.question, sql)));
        assert.ok(v1Rejections.some((rejection) => rejection?.code === known), `${testCase.id} is flagged ${known} but every gold variant passes under hints version 1`);
        assert.ok(v1Rejections.every((rejection) => !rejection || rejection.code === known), `${testCase.id}: ${v1Rejections.map((rejection) => rejection?.code).join(', ')}`);
        if (name === FRESH_HOLDOUT) {
          // Under version 2 a holdout flag is either still current or closed
          // and kept by version 1 (a verify-dataset note); which one is not
          // pinned: nothing is tuned on the holdout.
          assert.ok(
            rejections.every((rejection) => !rejection || rejection.code === known),
            `${testCase.id} under hints version 2: ${rejections.map((rejection) => rejection?.code).join(', ')}`
          );
        } else {
          rejections.forEach((rejection, position) => assert.equal(rejection, null, `${name}/${testCase.id} variant ${position} under hints version 2: ${rejection?.code} ${rejection?.message}`));
        }
      } else {
        rejections.forEach((rejection, position) => assert.equal(rejection, null, `${name}/${testCase.id} variant ${position}: ${rejection?.code} ${rejection?.message}`));
      }
      for (const control of resolveCaseControls(testCase, index).positive) {
        const rejection = await validate(testCase.question, control.sql);
        if (rejection && !control.validator_known_false_rejection) {
          assert.equal(rejection.code, known, `${testCase.id}/${control.id}: ${rejection.code} ${rejection.message}`);
        }
      }
    }
  }
  // The 33 TABLE_SCOPE flags went with the full schema scope (retrieval misses
  // are no validator gap in the default configuration); the METRIC_COLUMN one
  // is a guardrail gap and stays. The fresh holdout measures the same two
  // METRIC_COLUMN gaps on new wording: "credit notes" (the credit-amount
  // guardrail on a document question) and the "Sales Revenue" account name.
  assert.deepEqual(flaggedBy, { 'templated-public': 1, 'hard-cases-public': 0, [FRESH_HOLDOUT]: 4 });
});

// --- the fresh holdout (v2) -------------------------------------------------------

const freshCases = datasets[FRESH_HOLDOUT];
const freshAnswer = freshCases.filter((testCase) => !isBehavior(testCase));

test('fresh holdout: the builder reproduces the committed dataset and controls byte for byte, independent of the semantic layer', () => {
  const committedDataset = fs.readFileSync(HOLDOUT_DATASET_PATH, 'utf8');
  const committedControls = fs.readFileSync(HOLDOUT_CONTROLS_PATH, 'utf8');
  const built = buildHoldoutDataset({ previousCases: JSON.parse(committedDataset), layer });
  assert.deepEqual(built.problems, []);
  assert.equal(serialize(built.cases), committedDataset, 'datasets/holdout-public.json is stale: run npm run build-holdout-dataset');
  assert.equal(serialize(built.controls), committedControls, 'datasets/controls/holdout-public.json is stale: run npm run build-holdout-dataset');
  const again = buildHoldoutDataset({ previousCases: JSON.parse(committedDataset) });
  assert.equal(serialize(again.cases), committedDataset);
  assert.equal(serialize(again.controls), committedControls);
  // Without the committed pins, only expected_row_counts differ.
  const unpinned = buildHoldoutDataset({ previousCases: [], layer });
  assert.deepEqual(
    unpinned.cases,
    built.cases.map(({ expected_row_counts: _pins, ...rest }) => rest)
  );
});

test('fresh holdout: the builder rejects semantic-layer wording and the enforced word "revenue"', () => {
  const index = HOLDOUT_INTENTS.findIndex((intent) => intent.answer !== false);
  const original = HOLDOUT_INTENTS[index];
  for (const [question, pattern] of [
    ['Show net sales by customer segment for Q1 2026.', /net sales/],
    ['Revenue by customer segment for Q1 2026.', /revenue/],
  ]) {
    HOLDOUT_INTENTS.splice(index, 1, { ...original, phrasings: [...original.phrasings.slice(0, 1), question] });
    try {
      const { problems } = buildHoldoutDataset({ layer });
      assert.ok(problems.some((problem) => problem.includes(original.intentId) && pattern.test(problem)), problems.join('\n'));
    } finally {
      HOLDOUT_INTENTS.splice(index, 1, original);
    }
  }
});

test('fresh holdout: the wording rule covers the hints-v2 overlay vocabulary too (both HINTS_VERSION arms); the frozen exceptions are pinned', () => {
  const overlay = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'metadata/semantic-layer.hints-v2.json'), 'utf8'));
  const layers = vocabularyLayers(layer, overlay);
  assert.equal(layers.length, 2);
  const v1Phrases = semanticLayerPhrases(layer);
  const v2Phrases = semanticLayerPhrases(layers[1]);
  for (const phrase of ['average order value', 'order value', 'open amount', 'open balance', 'unpaid balance']) {
    assert.ok(v2Phrases.includes(phrase), phrase);
    assert.ok(!v1Phrases.includes(phrase), phrase);
  }
  // Version 1's vocabulary is checked too ("stopped selling" left the overlay, not the base layer).
  assert.ok(v1Phrases.includes('stopped selling'));
  assert.ok(!v2Phrases.includes('stopped selling'));

  // The committed holdout: no version 1 vocabulary, and version 2's only in
  // the frozen cases FROZEN_HINTS_V2_VOCABULARY lists, exactly.
  const committed = JSON.parse(fs.readFileSync(HOLDOUT_DATASET_PATH, 'utf8'));
  assert.deepEqual(buildHoldoutDataset({ previousCases: committed, layers }).problems, []);
  const v2Only = v2Phrases.filter((phrase) => !v1Phrases.includes(phrase));
  const found = Object.fromEntries(
    freshCases.map((testCase) => [testCase.id, semanticLayerPhrasesIn(testCase.question, v2Only)]).filter(([, phrases]) => phrases.length > 0)
  );
  assert.deepEqual(found, { ...FROZEN_HINTS_V2_VOCABULARY });
  // Without the exceptions those cases are refused; an exception that no
  // longer matches is refused too.
  const strict = buildHoldoutDataset({ previousCases: committed, layers, frozenExceptions: {} }).problems;
  assert.equal(strict.length, Object.keys(FROZEN_HINTS_V2_VOCABULARY).length, strict.join('\n'));
  assert.ok(strict.every((problem) => /hints-v2 vocabulary/.test(problem)));
  const extra = buildHoldoutDataset({ previousCases: committed, layers, frozenExceptions: { ...FROZEN_HINTS_V2_VOCABULARY, ho2_missing_000000: ['open balance'] } }).problems;
  assert.deepEqual(extra, ['ho2_missing_000000: listed in FROZEN_HINTS_V2_VOCABULARY but not a case: update FROZEN_HINTS_V2_VOCABULARY']);

  // A new holdout phrasing with version 2's vocabulary is refused under both
  // arms' layers (and passes version 1's alone).
  const index = HOLDOUT_INTENTS.findIndex((intent) => intent.answer !== false);
  const original = HOLDOUT_INTENTS[index];
  HOLDOUT_INTENTS.splice(index, 1, { ...original, phrasings: [...original.phrasings.slice(0, 1), 'What was the average order value per store?'] });
  try {
    assert.deepEqual(buildHoldoutDataset({ layer }).problems.filter((problem) => problem.includes(original.intentId)), []);
    const { problems } = buildHoldoutDataset({ layers });
    assert.ok(problems.some((problem) => problem.includes(original.intentId) && /hints-v2 vocabulary: average order value/.test(problem)), problems.join('\n'));
  } finally {
    HOLDOUT_INTENTS.splice(index, 1, original);
  }
});

test('fresh holdout: 60-80 new intents, 110-150 cases, all holdout, 1-3 phrasings, every hard category present', () => {
  const intents = new Set(freshCases.map((testCase) => testCase.intentId));
  assert.ok(intents.size >= 60 && intents.size <= 80, `${intents.size} intents`);
  assert.ok(freshCases.length >= 110 && freshCases.length <= 150, `${freshCases.length} cases`);
  assert.ok(freshCases.every((testCase) => testCase.split === 'holdout' && testCase.tags.includes('holdout_v2')));
  for (const intent of HOLDOUT_INTENTS) {
    assert.ok(intent.phrasings.length >= 1 && intent.phrasings.length <= 3, intent.intentId);
  }
  // New intents only: no intent id, question or gold of another dataset.
  const others = allCases.filter(({ dataset }) => dataset !== FRESH_HOLDOUT).map(({ testCase }) => testCase);
  const otherIntents = new Set(others.map((testCase) => testCase.intentId));
  const otherQuestions = new Set(others.map((testCase) => words(testCase.question)));
  for (const testCase of freshCases) {
    assert.ok(!otherIntents.has(testCase.intentId), `${testCase.id}: intent ${testCase.intentId} exists in another dataset`);
    assert.ok(!otherQuestions.has(words(testCase.question)), `${testCase.id}: question exists in another dataset`);
  }
  const tagged = (tag) => freshCases.filter((testCase) => testCase.tags.includes(tag));
  for (const tag of ['new_vocabulary', 'swedish', 'bilingual', 'typo', 'relative_date', 'named_entity', 'ranking_ties', 'ambiguous']) {
    assert.ok(tagged(tag).length >= 2, `fresh holdout cases tagged ${tag}: ${tagged(tag).length}`);
  }
  // At most three behaviour cases; the rest answer.
  assert.ok(freshCases.length - freshAnswer.length <= 3);
  // A relative date always comes with its as-of date.
  for (const testCase of freshCases.filter((entry) => entry.tags.includes('relative_date') || entry.tags.includes('as_of'))) {
    assert.match(testCase.question, /\b(20\d\d-\d\d-\d\d|\d{1,2} \w+ 20\d\d)\b/, testCase.id);
  }
  // An ambiguous case accepts its second reading, explained in its notes.
  for (const testCase of tagged('ambiguous')) {
    assert.ok((testCase.alternative_expected_sql || []).length > 0 && /readings? .*accepted|accepted/.test(testCase.notes), testCase.id);
  }
});

test('fresh holdout: no gold is empty on every fixture', () => {
  // Pinned row counts stand in for the database here: a gold empty on every
  // fixture cannot tell wrong SQL apart. That no gold is one NULL / 0 row on
  // every fixture either is checked against the databases by the opt-in test
  // in test/eval-fixtures.integration.test.js.
  for (const testCase of freshAnswer) {
    const counts = Object.values(testCase.expected_row_counts);
    assert.ok(counts.some((count) => count > 0), `${testCase.id}: empty on every fixture`);
  }
});

test('fresh holdout: controls resolve, are current, and every design family left out says why', async () => {
  const index = await loadControlsIndex();
  const controls = JSON.parse(fs.readFileSync(HOLDOUT_CONTROLS_PATH, 'utf8'));
  for (const testCase of freshCases.map(normalizeBenchmarkCase)) {
    const resolved = resolveCaseControls(testCase, index);
    assert.equal(resolved.stale, false, testCase.id);
    if (isBehavior(testCase)) {
      assert.equal(resolved.source, null, `${testCase.id}: a behaviour case has no controls`);
      continue;
    }
    assert.ok(resolved.negative.filter((control) => !control.heldout).length >= 2, `${testCase.id}: ${resolved.negative.length} negative controls`);
  }
  for (const entry of Object.values(controls)) {
    assert.equal(entry.gold_fingerprint, goldFingerprint(freshCases.find((testCase) => testCase.intentId === entry.intentId).expected_sql));
    for (const control of entry.negative) {
      assert.equal(control.heldout === true, control.id.startsWith('h'), `${entry.intentId}/${control.id}`);
    }
    for (const skipped of entry.not_emitted || []) {
      assert.ok(skipped.type && skipped.note && /^(fixture limit|equivalent here)/.test(skipped.reason) && skipped.reason.length > 40, `${entry.intentId}: ${JSON.stringify(skipped)}`);
    }
  }
  assert.ok(Object.values(controls).some((entry) => entry.positive.length > 0), 'positive rewrites exist');
});
