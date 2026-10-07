import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBenchmarkDataset } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { defaultResultsPath, evaluateRetrieval, main as evaluateRetrievalCli } from '../scripts/evaluate-retrieval.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

test('evaluate-retrieval scores answer cases only; abstain / clarify cases are listed apart, never as full recall', async () => {
  const { cases: all } = await loadBenchmarkDataset({ datasetName: 'hard-cases-public' });
  const behavior = all.filter((testCase) => testCase.expected_behavior !== 'answer');
  assert.ok(behavior.length >= 10, 'the hard cases include abstain and clarify cases');

  const { summary, cases, behaviorCases } = evaluateRetrieval(schema, all);
  assert.equal(summary.case_count, all.length - behavior.length);
  assert.equal(summary.behavior_case_count, behavior.length);
  assert.deepEqual(
    cases.map((entry) => entry.id),
    all.filter((testCase) => testCase.expected_behavior === 'answer').map((testCase) => testCase.id)
  );
  // Recall is averaged over answer cases (each has expected tables).
  assert.ok(cases.every((entry) => entry.expected_tables.length > 0));
  assert.equal(summary.average_expanded_recall, cases.reduce((sum, entry) => sum + entry.expanded_recall, 0) / cases.length);
  // Behaviour cases: what retrieval would offer, no recall.
  assert.deepEqual(
    behaviorCases.map((entry) => [entry.id, entry.expected_behavior]),
    behavior.map((testCase) => [testCase.id, testCase.expected_behavior])
  );
  for (const entry of behaviorCases) {
    assert.ok(Array.isArray(entry.expanded_tables) && entry.expanded_tables.length > 0, entry.id);
    assert.equal('expanded_recall' in entry, false, entry.id);
  }

  // A selection of only behaviour cases scores nothing (no 0-of-0 full recall).
  const only = evaluateRetrieval(schema, behavior);
  assert.deepEqual([only.summary.case_count, only.summary.expanded_full_recall_count, only.summary.behavior_case_count], [0, 0, behavior.length]);
});

test('evaluate-retrieval records the hints version and product configuration it ran; each version has its own default file', async () => {
  // The two arms of an A/B never overwrite each other's default report.
  assert.match(defaultResultsPath(1), /[/\\]generated[/\\]retrieval-evaluation-hints-v1\.json$/);
  assert.match(defaultResultsPath(2), /[/\\]generated[/\\]retrieval-evaluation-hints-v2\.json$/);
  assert.equal(defaultResultsPath(undefined), defaultResultsPath(2));
  assert.throws(() => defaultResultsPath(3), /hintsVersion must be one of 1, 2/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evaluate-retrieval-'));
  try {
    const reports = {};
    for (const [label, env] of [['default', {}], ['v1', { HINTS_VERSION: '1', SCHEMA_SCOPE: 'retrieved' }]]) {
      const lines = [];
      const resultsFile = path.join(dir, `${label}.json`);
      const { resultsPath, report } = await evaluateRetrievalCli(['--dataset', 'core-public', '--results-file', resultsFile], { env, output: { log: (line) => lines.push(line) } });
      assert.equal(resultsPath, resultsFile);
      assert.deepEqual(JSON.parse(await fs.readFile(resultsFile, 'utf8')), JSON.parse(JSON.stringify(report)));
      reports[label] = { report, lines };
    }
    const { default: base, v1 } = reports;
    assert.equal(base.report.hints_version, 2);
    assert.deepEqual([base.report.product.hintsVersion, base.report.product.schemaScope.requested, base.report.product.schemaScope.effective], [2, 'auto', 'full']);
    assert.match(base.lines.join('\n'), /\nHints version: 2 \(default\)\n/);
    assert.equal(v1.report.hints_version, 1);
    assert.deepEqual([v1.report.product.hintsVersion, v1.report.product.schemaScope.requested], [1, 'retrieved']);
    assert.match(v1.lines.join('\n'), /\nHints version: 1\n/);
    // An invalid version stops it, as everywhere else.
    await assert.rejects(evaluateRetrievalCli(['--results-file', path.join(dir, 'x.json')], { env: { HINTS_VERSION: '3' }, output: { log() {} } }), /HINTS_VERSION must be one of 1, 2/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
