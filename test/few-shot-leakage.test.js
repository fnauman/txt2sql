import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isDatasetFileName } from '../src/benchmark.js';
import { BUSINESS_RULES, BUSINESS_RULES_V2, FEW_SHOT_EXAMPLES } from '../src/constants.js';
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
    .filter(isDatasetFileName)
    .sort()
    .flatMap((name) => {
      const raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, name), 'utf8'));
      return (Array.isArray(raw) ? raw : raw.cases || []).map((testCase) => ({ ...testCase, dataset: name }));
    });
}

const CASES = loadDatasetCases();
// Abstain / clarify cases have no gold SQL.
const GOLD_SQL = CASES.flatMap((testCase) =>
  [testCase.expected_sql, ...(testCase.alternative_expected_sql || [])].filter(Boolean).map((sql) => ({ sql, label: `${testCase.dataset}/${testCase.id}` }))
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

// Hints version 2 adds prompt text of its own: rewritten and added business
// rules and the semantic-layer overlay's notes. Review found two rule
// examples that quoted dev questions ("the single biggest document", "from
// highest to lowest") and the account code of a motivating failing case
// ("such as 1100"). Prompt text written from failures must state general
// guidance, never a dataset's wording or literals.
const V2_PROMPT_TEXTS = (() => {
  const overlay = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'metadata/semantic-layer.hints-v2.json'), 'utf8'));
  return [
    ...BUSINESS_RULES_V2.filter((rule) => !BUSINESS_RULES.includes(rule)).map((text) => ({ label: 'business rule', text })),
    ...[...(overlay.entities || []), ...(overlay.metrics || [])].flatMap((entry) =>
      (entry.notes || []).map((text) => ({ label: `overlay ${entry.name} note`, text }))
    ),
  ];
})();
const NGRAM = 4;

function wordNgrams(text, size = NGRAM) {
  const words = normalizeQuestion(text).split(' ').filter(Boolean);
  const grams = new Set();
  for (let index = 0; index + size <= words.length; index += 1) {
    grams.add(words.slice(index, index + size).join(' '));
  }
  return grams;
}

// String literals of the gold SQL and 3+ digit numbers of the questions:
// codes, names and amounts a prompt must not hand the model. Dates and
// format strings ('%Y-%m') are not dataset values.
function datasetLiterals() {
  const literals = new Set();
  for (const { sql } of GOLD_SQL) {
    for (const match of sql.matchAll(/'((?:[^']|'')*)'/g)) {
      const value = match[1].replace(/%/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (value.length >= 3 && !/^\d{4}-\d{2}(-\d{2})?$/.test(value) && /[a-z0-9]{2}/.test(value.replace(/\b[a-z]\b/gi, ''))) {
        literals.add(value);
      }
    }
  }
  for (const testCase of CASES) {
    for (const match of String(testCase.question || '').matchAll(/\b\d{3,}\b/g)) {
      if (!/^(19|20)\d{2}$/.test(match[0])) {
        literals.add(match[0]);
      }
    }
  }
  return [...literals];
}

// The one overlap with the fresh holdout (datasets/holdout-public.json),
// pinned exactly: the units rule's "lines without a product, such as delivery
// fees" was written from dev failures, independently of the holdout (authored
// blind on another branch at the same time), and both are frozen, so neither
// was tuned on the other. For the HINTS_VERSION=2 arm that holdout case shares the wording
// with the prompt (docs/experiments/02-hints-v2.md). Any other overlap fails.
const KNOWN_HOLDOUT_OVERLAPS = {
  'holdout-public.json/ho2_fee_lines_q1_2026_7c63a9': ['product such as delivery', 'such as delivery fees'],
};

test('hints v2 rules and overlay notes share no 4-word phrase with a dataset question', () => {
  assert.ok(V2_PROMPT_TEXTS.length >= 10);
  const questionGrams = CASES.map((testCase) => ({ label: `${testCase.dataset}/${testCase.id}`, grams: wordNgrams(testCase.question) }));
  const holdoutOverlaps = {};
  for (const { label, text } of V2_PROMPT_TEXTS) {
    const grams = wordNgrams(text);
    for (const question of questionGrams) {
      const shared = [...question.grams].filter((gram) => grams.has(gram));
      if (shared.length > 0 && KNOWN_HOLDOUT_OVERLAPS[question.label]) {
        holdoutOverlaps[question.label] = [...new Set([...(holdoutOverlaps[question.label] || []), ...shared])].sort();
        continue;
      }
      assert.deepEqual(shared, [], `${label} shares "${shared.join('", "')}" with ${question.label}: ${text}`);
    }
  }
  assert.deepEqual(holdoutOverlaps, KNOWN_HOLDOUT_OVERLAPS, 'the known holdout overlaps changed: review KNOWN_HOLDOUT_OVERLAPS');
  // The measure catches the wording that used to be there.
  const old = wordNgrams('"Rank", "order", "sort" or "from highest to lowest" with no number returns every row');
  assert.ok(questionGrams.some((question) => [...question.grams].some((gram) => old.has(gram))));
});

test('hints v2 rules and overlay notes add no dataset literal the version-1 prompt did not have', () => {
  const v1Text = ` ${normalizeQuestion([...BUSINESS_RULES, ...FEW_SHOT_EXAMPLES.flatMap((example) => [example.question, example.sql])].join(' '))} `;
  const literals = datasetLiterals().filter((literal) => !v1Text.includes(` ${normalizeQuestion(literal)} `));
  assert.ok(literals.includes('1100'), 'account codes from the questions are dataset literals');
  for (const { label, text } of V2_PROMPT_TEXTS) {
    const words = ` ${normalizeQuestion(text)} `;
    const found = literals.filter((literal) => normalizeQuestion(literal) && words.includes(` ${normalizeQuestion(literal)} `));
    assert.deepEqual(found, [], `${label} contains dataset literal(s) ${found.join(', ')}: ${text}`);
  }
  assert.ok(` ${normalizeQuestion('filter an account number (such as 1100) on LedgerAccount.AccountCode')} `.includes(' 1100 '));
});
