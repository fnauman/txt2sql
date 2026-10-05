import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildEvalDataset,
  caseIdFor,
  CONTROLS_PATH,
  DATASET_PATH,
  HOLDOUT_PERCENT,
  INTENT_CATALOGUE,
  serialize,
  splitForIntent,
} from '../scripts/build-eval-dataset.mjs';
import { CASE_SPLITS, normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES, FEW_SHOT_EXAMPLES } from '../src/constants.js';
import { goldFingerprint, loadControlsIndex, normalizeSqlText, resolveCaseControls } from '../src/eval/controls.js';
import { FIXTURES } from '../src/eval/fixtures.js';
import { dedupeSuiteCases, scoringFingerprint } from '../src/eval/suite.js';
import { createValidatorProbe } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Dataset hygiene (audit plan 2.6): splits, the holdout's vocabulary, id
// stability, leakage into the prompt, pins, and the generator's determinism.
// Every check reads the committed files; none needs a database.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');
const LEGACY_DATASETS = ['core-public', 'paraphrase-public', 'edge-cases-public'];

const datasets = Object.fromEntries(
  fs
    .readdirSync(DATASETS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [path.basename(name, '.json'), JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, name), 'utf8'))])
);
const allCases = Object.entries(datasets).flatMap(([dataset, cases]) => cases.map((testCase) => ({ dataset, testCase })));
const normalized = Object.entries(datasets).map(([name, cases]) => ({ name, cases: cases.map(normalizeBenchmarkCase) }));
const unique = dedupeSuiteCases(normalized).entries.map((entry) => entry.testCase);
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

test('(e) every committed case has an explicit, valid split; legacy datasets are dev, new intents follow the hash rule', () => {
  const legacyIntents = new Set(LEGACY_DATASETS.flatMap((name) => datasets[name].map((testCase) => testCase.intentId)));
  for (const { dataset, testCase } of allCases) {
    assert.ok(CASE_SPLITS.includes(testCase.split), `${dataset}/${testCase.id} split ${testCase.split}`);
    if (LEGACY_DATASETS.includes(dataset) || legacyIntents.has(testCase.intentId)) {
      assert.equal(testCase.split, 'dev', `${dataset}/${testCase.id}: the semantic layer and prompt rules were tuned on the legacy intents`);
    } else {
      assert.equal(testCase.split, splitForIntent(testCase.intentId), `${dataset}/${testCase.id} follows splitForIntent(${testCase.intentId})`);
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

test('(a) holdout questions contain no multi-word phrase of the semantic layer', () => {
  const phrases = layerPhrases();
  assert.ok(phrases.includes('net sales') && phrases.includes('sales documents') && phrases.includes('credit memo'));
  const holdout = allCases.filter(({ testCase }) => testCase.split === 'holdout');
  assert.ok(holdout.length >= 70, `${holdout.length} holdout cases`);
  for (const { dataset, testCase } of holdout) {
    const text = words(testCase.question);
    const found = phrases.filter((phrase) => [' ', 's ', 'es '].some((ending) => text.includes(`${words(phrase).trimEnd()}${ending}`)));
    assert.deepEqual(found, [], `${dataset}/${testCase.id}: "${testCase.question}"`);
  }
  // The matcher itself: whole words, plurals included.
  assert.ok(words('How many credit memos?').includes(`${words('credit memo').trimEnd()}s `));
  assert.ok(!words('net salesperson').includes(`${words('net sales').trimEnd()} `));
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

test('(g) the templated generator reproduces the committed dataset and controls byte for byte', async () => {
  const committedDataset = fs.readFileSync(DATASET_PATH, 'utf8');
  const committedControls = fs.readFileSync(CONTROLS_PATH, 'utf8');
  const built = buildEvalDataset({ previousCases: JSON.parse(committedDataset), layer });
  assert.deepEqual(built.problems, []);
  assert.equal(serialize(built.cases), committedDataset, 'datasets/templated-public.json is stale: run npm run build-eval-dataset');
  assert.equal(serialize(built.controls), committedControls, 'datasets/controls/templated-public.json is stale: run npm run build-eval-dataset');
  // Deterministic: a second build is identical, and the output never depends
  // on the semantic layer (it is only used to reject holdout wording).
  const again = buildEvalDataset({ previousCases: JSON.parse(committedDataset) });
  assert.equal(serialize(again.cases), committedDataset);
  assert.equal(serialize(again.controls), committedControls);
  // Without the committed pins, only expected_row_counts differ.
  const unpinned = buildEvalDataset({ previousCases: [], layer });
  assert.deepEqual(
    unpinned.cases,
    built.cases.map(({ expected_row_counts: _pins, ...rest }) => rest)
  );
});

test('the generator rejects holdout wording from the semantic layer and keeps 2-3 phrasings per intent', () => {
  for (const intent of INTENT_CATALOGUE) {
    assert.ok(intent.phrasings.length >= 2 && intent.phrasings.length <= 3, intent.intentId);
  }
  const holdoutIntent = INTENT_CATALOGUE.find((intent) => splitForIntent(intent.intentId) === 'holdout');
  const tampered = { ...holdoutIntent, phrasings: [...holdoutIntent.phrasings.slice(0, 1), 'Show net sales by sales document type.'] };
  const index = INTENT_CATALOGUE.indexOf(holdoutIntent);
  INTENT_CATALOGUE.splice(index, 1, tampered);
  try {
    const { problems } = buildEvalDataset({ layer });
    assert.ok(problems.some((problem) => problem.includes(holdoutIntent.intentId) && /net sales/.test(problem)), problems.join('\n'));
  } finally {
    INTENT_CATALOGUE.splice(index, 1, holdoutIntent);
  }
  assert.equal(HOLDOUT_PERCENT, 42);
});

test('suite composition: 100-150 intents, at least 35 holdout intents, behaviour cases and every hard-case category', () => {
  const intents = new Set(unique.map((testCase) => testCase.intentId));
  const holdoutIntents = new Set(unique.filter((testCase) => testCase.split === 'holdout').map((testCase) => testCase.intentId));
  assert.ok(intents.size >= 100 && intents.size <= 150, `${intents.size} intents`);
  assert.ok(holdoutIntents.size >= 35, `${holdoutIntents.size} holdout intents`);
  const legacyIntents = new Set(LEGACY_DATASETS.flatMap((name) => datasets[name].map((testCase) => testCase.intentId)));
  const newIntents = [...intents].filter((intentId) => !legacyIntents.has(intentId));
  const share = holdoutIntents.size / newIntents.length;
  assert.ok(share >= 0.33 && share <= 0.42, `holdout share of new intents ${share.toFixed(3)}`);

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
  const behavior = unique.filter(isBehavior);
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
});

// The offline twin of verify-dataset's validator check for the new datasets:
// every gold passes the production validator in its real prompt context, and
// every gold flagged known_validator_rejection is still rejected with that
// code (the gate in verify-dataset fails once it is accepted).
test('known validator rejections are real and current; every other new gold and positive control passes the validator', async () => {
  const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
  const validate = createValidatorProbe({ schema });
  const index = await loadControlsIndex();
  let flagged = 0;
  for (const name of ['templated-public', 'hard-cases-public']) {
    for (const testCase of datasets[name].map(normalizeBenchmarkCase).filter((entry) => !isBehavior(entry))) {
      const variants = [testCase.expected_sql, ...testCase.alternative_expected_sql];
      const rejections = await Promise.all(variants.map((sql) => validate(testCase.question, sql)));
      const known = testCase.known_validator_rejection;
      if (known) {
        flagged += 1;
        assert.ok(rejections.some((rejection) => rejection?.code === known), `${testCase.id} is flagged ${known} but every gold variant passes`);
        assert.ok(rejections.every((rejection) => !rejection || rejection.code === known), `${testCase.id}: ${rejections.map((rejection) => rejection?.code).join(', ')}`);
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
  assert.ok(flagged >= 10, `${flagged} known validator rejections`);
});
