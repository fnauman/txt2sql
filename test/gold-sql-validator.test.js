import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOptimizedPrompt, buildSemanticPlan, loadNarrowSchema, validateReadOnlySql } from '../src/pipeline.js';

// Invariant: the production validator must admit every dataset's own gold SQL
// in the exact prompt context the pipeline builds for that question. Before the
// tokenizer/CTE/metric-arbitration work, 7 of the 26 unique (question, gold SQL)
// pairs were rejected (core_003/004/006, paraphrase_004/006, edge_003/004).
//
// No gold query filters on product IDs (the sparkling-water case uses LIKE), so
// no master-data candidates are needed; with candidates the ID check would only
// constrain explicit ProductId literals.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');
const schema = await loadNarrowSchema({
  modelsDir: path.join(REPO_ROOT, 'models'),
  schemaPath: path.join(REPO_ROOT, 'generated', 'schema.json'),
});
const ALL_TABLES = schema.tables.map((table) => table.tableName);

function loadGoldPairs() {
  const pairs = new Map();
  for (const fileName of fs.readdirSync(DATASETS_DIR).filter((name) => name.endsWith('.json')).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, fileName), 'utf8'));
    const cases = Array.isArray(raw) ? raw : raw.cases || [];
    for (const testCase of cases) {
      const key = `${testCase.question}\u0000${testCase.expected_sql}`;
      if (!pairs.has(key)) {
        pairs.set(key, { ...testCase, dataset: fileName });
      }
    }
  }
  return [...pairs.values()];
}

const GOLD = loadGoldPairs();

test('the gold corpus has the expected size (26 unique question/SQL pairs)', () => {
  assert.equal(GOLD.length, 26);
});

for (const testCase of GOLD) {
  test(`gold SQL passes the production validator: ${testCase.id} (${testCase.dataset})`, () => {
    const semanticPlan = buildSemanticPlan(testCase.question);
    const prompt = buildOptimizedPrompt(schema, testCase.question, { masterDataCandidates: [], semanticPlan });
    const allowedTables = prompt.tables.map((table) => table.tableName);

    for (const tableName of testCase.expected_tables) {
      assert.ok(allowedTables.includes(tableName), `retrieval should include ${tableName}`);
    }

    const validated = validateReadOnlySql(testCase.expected_sql, allowedTables, {
      promptContext: prompt.context,
      response: { sql: testCase.expected_sql, tables_used: testCase.expected_tables },
    });
    assert.deepEqual([...validated.tablesUsed].sort(), [...testCase.expected_tables].sort());

    // The basic path (no prompt context, every table allowed) admits it too.
    assert.doesNotThrow(() => validateReadOnlySql(testCase.expected_sql, ALL_TABLES));
  });
}
