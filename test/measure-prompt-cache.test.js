import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { selectSuite } from '../src/eval/suite.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { measureScope } from '../scripts/measure-prompt-cache.js';

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
