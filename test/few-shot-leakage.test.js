import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FEW_SHOT_EXAMPLES } from '../src/constants.js';
import { validateReadOnlySql } from '../src/pipeline.js';
import { tokenizeSql } from '../src/sql-tokenizer.js';

// The few-shot pool is part of every optimized prompt. If it contains a
// dataset's question or (nearly) its gold SQL, the benchmark measures recall
// of the prompt, not text-to-SQL (EVAL-4 / EVAL-RET-8: example #1 was
// core_public_007 verbatim; #2 and #4 were core gold minus the date filter).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');
const JACCARD_LIMIT = 0.8;

function loadDatasetCases() {
  return fs
    .readdirSync(DATASETS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, name), 'utf8'));
      return (Array.isArray(raw) ? raw : raw.cases || []).map((testCase) => ({ ...testCase, dataset: name }));
    });
}

const CASES = loadDatasetCases();
const GOLD_SQL = CASES.flatMap((testCase) =>
  [testCase.expected_sql, ...(testCase.alternative_expected_sql || [])].map((sql) => ({ sql, label: `${testCase.dataset}/${testCase.id}` }))
);

export function normalizeQuestion(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeSql(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Significant SQL tokens; identifiers and keywords case-insensitive, literals as written.
function sqlTokenSet(sql) {
  return new Set(
    tokenizeSql(sql, { tolerant: true })
      .filter((token) => !['whitespace', 'comment', 'executable_comment'].includes(token.type))
      .map((token) => (token.type === 'word' || token.type === 'quoted_identifier' ? (token.name || token.value).toUpperCase() : token.value))
  );
}

function jaccard(left, right) {
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

test('the datasets and the few-shot pool are both non-empty', () => {
  assert.ok(CASES.length >= 35);
  assert.ok(FEW_SHOT_EXAMPLES.length >= 3);
});

test('no dataset question equals a few-shot question', () => {
  const questions = new Map(CASES.map((testCase) => [normalizeQuestion(testCase.question), `${testCase.dataset}/${testCase.id}`]));
  for (const example of FEW_SHOT_EXAMPLES) {
    assert.equal(questions.get(normalizeQuestion(example.question)), undefined, `few-shot "${example.question}" is a dataset question`);
  }
});

test('no few-shot SQL equals a dataset gold SQL', () => {
  const gold = new Map(GOLD_SQL.map((entry) => [normalizeSql(entry.sql), entry.label]));
  for (const example of FEW_SHOT_EXAMPLES) {
    assert.equal(gold.get(normalizeSql(example.sql)), undefined, `few-shot "${example.question}" is gold SQL`);
  }
});

test(`no few-shot SQL is a near-duplicate of a gold SQL (token Jaccard < ${JACCARD_LIMIT})`, () => {
  const goldTokens = GOLD_SQL.map((entry) => ({ ...entry, tokens: sqlTokenSet(entry.sql) }));
  for (const example of FEW_SHOT_EXAMPLES) {
    const tokens = sqlTokenSet(example.sql);
    for (const gold of goldTokens) {
      const similarity = jaccard(tokens, gold.tokens);
      assert.ok(similarity < JACCARD_LIMIT, `few-shot "${example.question}" vs ${gold.label}: Jaccard ${similarity.toFixed(3)}`);
    }
  }
});

test('the token Jaccard measure flags the examples that used to leak', () => {
  const leaked =
    'SELECT p.ProductName, ROUND(SUM(COALESCE(l.Quantity, 0)), 3) AS total_qty FROM SalesDocumentLine l JOIN Product p ON l.ProductId = p.ProductId JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId WHERE IFNULL(d.IsCanceled, 0) = 0 GROUP BY p.ProductId, p.ProductName ORDER BY SUM(COALESCE(l.Quantity, 0)) DESC, p.ProductName ASC LIMIT 10';
  const core002 = GOLD_SQL.find((entry) => entry.label.endsWith('/core_public_002')).sql;
  assert.ok(jaccard(sqlTokenSet(leaked), sqlTokenSet(core002)) >= JACCARD_LIMIT);
});

test('every few-shot example is valid read-only SQL over the tables it lists', () => {
  for (const example of FEW_SHOT_EXAMPLES) {
    const validated = validateReadOnlySql(example.sql, example.tables);
    assert.deepEqual([...validated.tablesUsed].sort(), [...example.tables].sort(), example.question);
  }
});
