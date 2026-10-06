import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isDatasetFileName } from '../src/benchmark.js';
import { buildOptimizedPrompt, buildSemanticPlan, validateReadOnlySql } from '../src/pipeline.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Invariant: the production validator must admit every dataset's own gold SQL
// in the exact prompt context the pipeline builds for that question. Before the
// tokenizer/CTE/metric-arbitration work, 7 of the 26 unique (question, gold SQL)
// pairs were rejected (core_003/004/006, paraphrase_004/006, edge_003/004).
//
// No gold query filters on product IDs (the sparkling-water case uses LIKE), so
// no master-data candidates are needed; with candidates the ID check would only
// constrain explicit ProductId literals.
//
// The exception is documented per case: a case flagged
// `known_validator_rejection: <code>` is a product gap the dataset measures on
// purpose (a guardrail misreads the wording). Its gold must still be rejected
// with that code, so the flag is removed once the product is fixed. Abstain /
// clarify cases have no gold.
//
// The prompt context is the product default (SCHEMA_SCOPE=auto, which is the
// full scope at 13 tables: every in-scope table allowed). Under the retrieved
// scope a gold that needs a table retrieval did not pick is rejected with
// TABLE_SCOPE; the last test pins how many, the failure class the schema-scope
// experiment removes (docs/experiments/01-schema-scope.md).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');
// Compiled in memory from the models, so tests never write generated/schema.json.
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const ALL_TABLES = schema.tables.map((table) => table.tableName);

function loadGoldPairs() {
  const pairs = new Map();
  for (const fileName of fs.readdirSync(DATASETS_DIR).filter(isDatasetFileName).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, fileName), 'utf8'));
    const cases = Array.isArray(raw) ? raw : raw.cases || [];
    for (const testCase of cases) {
      if (testCase.expected_behavior && testCase.expected_behavior !== 'answer') {
        continue;
      }
      const key = `${testCase.question}\u0000${testCase.expected_sql}`;
      if (!pairs.has(key)) {
        pairs.set(key, { ...testCase, dataset: fileName });
      }
    }
  }
  return [...pairs.values()];
}

const GOLD = loadGoldPairs();
// The fresh holdout (datasets/holdout-public.json) is counted on its own, so
// the numbers pinned for the hash-split suite (and the schema-scope experiment
// below) stay what they were measured on.
const FRESH_HOLDOUT_FILE = 'holdout-public.json';
const isFreshHoldout = (testCase) => testCase.dataset === FRESH_HOLDOUT_FILE;

test('the gold corpus has the expected size (245 + 147 unique question/SQL pairs, 1 + 4 known validator rejections)', () => {
  const suite = GOLD.filter((testCase) => !isFreshHoldout(testCase));
  const fresh = GOLD.filter(isFreshHoldout);
  assert.equal(suite.length, 245);
  assert.equal(suite.filter((testCase) => testCase.known_validator_rejection).length, 1);
  assert.equal(fresh.length, 147);
  assert.equal(fresh.filter((testCase) => testCase.known_validator_rejection).length, 4);
});

// The flags describe hints version 1 (HINTS_VERSION=1, the A/B control arm,
// still supported). The suite's flag: the net-sales guardrail misreads
// "(Sales Revenue)"; hints version 2 (the default) demotes sales metrics in a
// ledger question, so it admits every variant (verify-dataset notes the flag
// as kept by version 1 instead of stale). The fresh holdout's flags must be
// real under version 1; under version 2 each is either still current or
// closed (then kept by version 1), which one is not pinned: nothing is tuned
// on the holdout.
for (const testCase of GOLD.filter((entry) => entry.known_validator_rejection)) {
  const closedByV2 = !isFreshHoldout(testCase);
  test(`known validator rejection is still real under hints version 1${closedByV2 ? ', and closed by version 2' : ''}: ${testCase.id} (${testCase.dataset}) ${testCase.known_validator_rejection}`, () => {
    const codesUnder = (hintsVersion) => {
      const semanticPlan = buildSemanticPlan(testCase.question, { hintsVersion });
      const prompt = buildOptimizedPrompt(schema, testCase.question, { masterDataCandidates: [], semanticPlan });
      const allowedTables = prompt.tables.map((table) => table.tableName);
      return [testCase.expected_sql, ...(testCase.alternative_expected_sql || [])].map((sql) => {
        try {
          validateReadOnlySql(sql, allowedTables, { promptContext: prompt.context, response: { sql, tables_used: validateReadOnlySql(sql, ALL_TABLES).tablesUsed } });
          return null;
        } catch (error) {
          return error.code;
        }
      });
    };
    const codes = codesUnder(1);
    assert.ok(codes.includes(testCase.known_validator_rejection), `every variant passes now (${codes.join(', ')}): remove known_validator_rejection`);
    assert.ok(codes.every((code) => code === null || code === testCase.known_validator_rejection), codes.join(', '));
    const codesV2 = codesUnder(2);
    if (closedByV2) {
      assert.deepEqual(codesV2, codes.map(() => null));
    } else {
      assert.ok(codesV2.every((code) => code === null || code === testCase.known_validator_rejection), codesV2.join(', '));
    }
    // The basic path (no prompt context, every table allowed) admits it.
    assert.doesNotThrow(() => validateReadOnlySql(testCase.expected_sql, ALL_TABLES));
  });
}

for (const testCase of GOLD.filter((entry) => !entry.known_validator_rejection)) {
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

// Alternative gold readings (alternative_expected_sql) are correct answers too,
// so the validator must admit them in the same prompt context.
for (const testCase of GOLD.filter((entry) => Array.isArray(entry.alternative_expected_sql) && !entry.known_validator_rejection)) {
  testCase.alternative_expected_sql.forEach((sql, index) => {
    test(`alternative gold SQL passes the production validator: ${testCase.id} [${index}] (${testCase.dataset})`, () => {
      const semanticPlan = buildSemanticPlan(testCase.question);
      const prompt = buildOptimizedPrompt(schema, testCase.question, { masterDataCandidates: [], semanticPlan });
      const allowedTables = prompt.tables.map((table) => table.tableName);
      const tablesUsed = validateReadOnlySql(sql, ALL_TABLES).tablesUsed;
      assert.doesNotThrow(() =>
        validateReadOnlySql(sql, allowedTables, { promptContext: prompt.context, response: { sql, tables_used: tablesUsed } })
      );
    });
  });
}

// The schema-scope experiment's premise, pinned: under the retrieved scope 33
// golds (every one the dataset used to flag TABLE_SCOPE) are rejected only
// because retrieval did not pick an in-scope table they need; nothing else
// changes. The default scope admits them (the tests above). That was hints
// version 1's retrieval; version 2's semantic layer (turnover, units, order
// value, ...) picks the needed table for 8 of them and misses no other gold.
// The fresh holdout is held to the same rule (only TABLE_SCOPE for an
// in-scope table) without a pinned count: nothing may be tuned on how
// retrieval does on it.
function retrievedScopeRejections(hintsVersion) {
  const rejected = new Set();
  for (const testCase of GOLD) {
    const semanticPlan = buildSemanticPlan(testCase.question, { hintsVersion });
    const prompt = buildOptimizedPrompt(schema, testCase.question, { masterDataCandidates: [], semanticPlan, schemaScope: 'retrieved' });
    const allowedTables = prompt.tables.map((table) => table.tableName);
    for (const sql of [testCase.expected_sql, ...(testCase.alternative_expected_sql || [])]) {
      try {
        validateReadOnlySql(sql, allowedTables, { promptContext: prompt.context, response: { sql, tables_used: validateReadOnlySql(sql, ALL_TABLES).tablesUsed } });
      } catch (error) {
        if (error.code === testCase.known_validator_rejection) {
          continue;
        }
        assert.equal(error.code, 'TABLE_SCOPE', `${testCase.id}: ${error.code} ${error.message}`);
        assert.ok(ALL_TABLES.includes(error.details.table), `${testCase.id}: ${error.details.table} is in scope`);
        assert.ok(!allowedTables.includes(error.details.table));
        if (!isFreshHoldout(testCase)) {
          rejected.add(testCase.id);
        }
      }
    }
  }
  return rejected;
}

test('under the retrieved schema scope exactly 33 golds are rejected (hints version 1), each with TABLE_SCOPE for an in-scope table; 25 under version 2, all among them', () => {
  const v1 = retrievedScopeRejections(1);
  assert.equal(v1.size, 33, [...v1].join(', '));
  const v2 = retrievedScopeRejections(2);
  assert.equal(v2.size, 25, [...v2].join(', '));
  assert.deepEqual([...v2].filter((id) => !v1.has(id)), [], 'version 2 adds no retrieval miss');
});
