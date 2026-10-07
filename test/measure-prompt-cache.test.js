import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { selectSuite } from '../src/eval/suite.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { loadCases, measureScope, measurementScopes, validateMeasureArgv } from '../scripts/measure-prompt-cache.js';

// Prompt size per schema scope over the whole eval suite, offline (the numbers
// in docs/experiments/01-schema-scope.md come from npm run
// measure-prompt-cache -- --suite --schema-scope all).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const cases = (await selectSuite({ datasetsDir: path.join(REPO_ROOT, 'datasets') })).entries.map((entry) => entry.testCase);

test('over the suite the full scope has one cacheable prefix and a small question part; the retrieved scope splinters', () => {
  const retrieved = measureScope(schema, cases, 'retrieved').summary;
  const full = measureScope(schema, cases, 'full').summary;

  assert.equal(full.case_count, cases.length);
  assert.equal(full.unique_cacheable_prefix_count, 1, 'every question shares the full schema prefix');
  assert.equal(full.average_prompt_table_count, 13);
  assert.ok(retrieved.unique_cacheable_prefix_count > 20, `${retrieved.unique_cacheable_prefix_count} retrieved prefixes`);
  assert.ok(retrieved.average_prompt_table_count < 6);

  // Without the question-ranked duplicate block the question part shrinks by
  // more than half, and the whole prompt costs about the same.
  assert.ok(full.average_dynamic_estimated_tokens * 2 < retrieved.average_dynamic_estimated_tokens);
  const ratio = full.average_total_estimated_tokens / retrieved.average_total_estimated_tokens;
  assert.ok(ratio > 0.9 && ratio < 1.2, `full / retrieved prompt size ${ratio.toFixed(3)}`);
});

test('--suite honours --case-id and --tag and records them in the report', async () => {
  const datasetsDir = path.join(REPO_ROOT, 'datasets');
  const all = await loadCases(['--suite', '--datasets-dir', datasetsDir]);
  assert.equal(all.cases.length, cases.length);
  assert.equal(all.dataset.filters, null);

  const byId = await loadCases(['--suite', '--datasets-dir', datasetsDir, '--case-id', 'core_public_001,core_public_002']);
  assert.deepEqual(byId.cases.map((testCase) => testCase.id), ['core_public_001', 'core_public_002']);
  assert.equal(byId.dataset.selected_case_count, 2);
  assert.deepEqual(byId.dataset.filters, { split: 'all', caseIds: ['core_public_001', 'core_public_002'], tags: [], intents: [] });

  const byTag = await loadCases(['--suite', '--datasets-dir', datasetsDir, '--tag', 'swedish']);
  assert.ok(byTag.cases.length > 0 && byTag.cases.length < cases.length);
  assert.ok(byTag.cases.every((testCase) => testCase.tags.includes('swedish')));
  assert.deepEqual(byTag.dataset.filters, { split: 'all', caseIds: [], tags: ['swedish'], intents: [] });

  await assert.rejects(loadCases(['--suite', '--datasets-dir', datasetsDir, '--tag', 'no_such_tag']), /No cases matched/);
});

test('--schema-scope retrieved does not inherit widen-on-demand from the default auto configuration', () => {
  // Unset SCHEMA_WIDEN_ON_DEMAND: each scope gets its own default.
  assert.deepEqual(measurementScopes('retrieved', {}).map((config) => ({ ...config })), [
    { schemaScope: 'retrieved', fullSchemaMaxTokens: 8000, widenOnDemand: false },
  ]);
  assert.deepEqual(
    measurementScopes('all', {}).map((config) => [config.schemaScope, config.widenOnDemand]),
    [['retrieved', false], ['full', true], ['auto', true]]
  );
  assert.equal(measurementScopes(undefined, {}).length, 1);
  assert.equal(measurementScopes(undefined, {})[0].schemaScope, 'auto');
  assert.equal(measurementScopes(undefined, { SCHEMA_SCOPE: 'retrieved' })[0].widenOnDemand, false);
  // The command line overrides SCHEMA_SCOPE; an explicit widen setting and the budget still apply.
  assert.equal(measurementScopes('retrieved', { SCHEMA_SCOPE: 'auto' })[0].widenOnDemand, false);
  assert.equal(measurementScopes('retrieved', { SCHEMA_WIDEN_ON_DEMAND: '1' })[0].widenOnDemand, true);
  assert.equal(measurementScopes('auto', { SCHEMA_WIDEN_ON_DEMAND: '0' })[0].widenOnDemand, false);
  assert.equal(measurementScopes('full', { SCHEMA_FULL_MAX_TOKENS: '1200' })[0].fullSchemaMaxTokens, 1200);
  assert.equal(measureScope(schema, cases.slice(0, 1), measurementScopes('retrieved', {})[0]).schema_scope.widenOnDemand, false);
  assert.throws(() => measurementScopes('everything', {}), /--schema-scope must be one of retrieved, full, auto or all/);
});

test('--suite honours --split, --intent, --dataset and --dataset-file like npm run eval', async () => {
  const datasetsDir = path.join(REPO_ROOT, 'datasets');
  const holdout = await loadCases(['--suite', '--datasets-dir', datasetsDir, '--split', 'holdout']);
  assert.ok(holdout.cases.length > 0 && holdout.cases.length < cases.length);
  assert.ok(holdout.cases.every((testCase) => testCase.split === 'holdout'));
  assert.deepEqual(holdout.dataset.filters, { split: 'holdout', caseIds: [], tags: [], intents: [] });
  await assert.rejects(loadCases(['--suite', '--datasets-dir', datasetsDir, '--split', 'test']), /--split must be one of dev, holdout, all/);

  const intent = cases.find((testCase) => testCase.intentId)?.intentId;
  const byIntent = await loadCases(['--suite', '--datasets-dir', datasetsDir, '--intent', intent]);
  assert.ok(byIntent.cases.length > 0 && byIntent.cases.every((testCase) => testCase.intentId === intent));
  assert.deepEqual(byIntent.dataset.filters, { split: 'all', caseIds: [], tags: [], intents: [intent] });

  const coreSuite = await selectSuite({ datasetsDir, datasetNames: ['core-public'] });
  const byName = await loadCases(['--suite', '--datasets-dir', datasetsDir, '--dataset', 'core-public']);
  assert.equal(byName.dataset.name, 'core-public');
  assert.equal(byName.cases.length, coreSuite.entries.length);
  assert.ok(byName.cases.length < cases.length);
  const byFile = await loadCases(['--suite', '--datasets-dir', datasetsDir, '--dataset-file', path.join(datasetsDir, 'core-public.json')]);
  assert.equal(byFile.dataset.name, 'core-public');
  assert.equal(byFile.cases.length, coreSuite.entries.length);

  // Without --suite one dataset is measured, and the suite-only filters are refused.
  await assert.rejects(loadCases(['--datasets-dir', datasetsDir, '--split', 'holdout']), /--split and --intent need --suite/);
  await assert.rejects(loadCases(['--datasets-dir', datasetsDir, '--intent', intent]), /--split and --intent need --suite/);
});

test('measure-prompt-cache rejects unknown flags, stray arguments and missing values', () => {
  assert.doesNotThrow(() =>
    validateMeasureArgv([
      '--suite',
      '--split=holdout',
      '--intent',
      'top_customers',
      '--case-id',
      'a,b',
      '--tag',
      'swedish',
      '--schema-scope',
      'all',
      '--results-file',
      'out.json',
      '--refresh-schema',
      '--use-home-env',
    ])
  );
  assert.throws(() => validateMeasureArgv(['--suite', '--caseid', 'core_public_001']), /Unknown option "--caseid"\. Did you mean --case-id\?/);
  assert.throws(() => validateMeasureArgv(['suite']), /Unexpected argument "suite"/);
  assert.throws(() => validateMeasureArgv(['--suite', '--split']), /--split needs a value/);
  assert.throws(() => validateMeasureArgv(['--suite', '--tag', '--split', 'dev']), /--tag needs a value/);
  assert.throws(() => validateMeasureArgv(['--suite=yes']), /--suite takes no value/);
});
