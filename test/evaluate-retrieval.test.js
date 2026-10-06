import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBenchmarkDataset } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { evaluateRetrieval } from '../scripts/evaluate-retrieval.js';
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
