import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProductCandidateQuery,
  expandProductSearchTerms,
  extractProductSearchTerms,
  rankProductCandidates,
  resolveMasterDataCandidates,
} from '../src/master-data-resolver.js';
import { buildOptimizedPrompt, buildSemanticPlan } from '../src/pipeline.js';

function createColumn(name, overrides = {}) {
  return {
    name,
    type: 'STRING(50)',
    allowNull: true,
    primaryKey: false,
    references: null,
    comment: null,
    ...overrides,
  };
}

function createProductSchema() {
  return {
    tables: [
      {
        name: 'Product',
        tableName: 'Product',
        description: 'products',
        file: 'Product.js',
        columns: [
          createColumn('ProductId', { type: 'INTEGER', primaryKey: true }),
          createColumn('ProductCode'),
          createColumn('ProductName'),
          createColumn('ProductTags'),
        ],
        foreignKeys: [],
      },
    ],
  };
}

test('extractProductSearchTerms reads product filter hints from the semantic plan', () => {
  const semanticPlan = buildSemanticPlan('protein bar, sparkling water or cold brew sales monthwise');

  assert.deepEqual(extractProductSearchTerms(semanticPlan), ['sparkling water', 'protein bar', 'cold brew']);
});

test('extractProductSearchTerms discovers canonical and alias product values', () => {
  assert.ok(extractProductSearchTerms(buildSemanticPlan('seltzer sales by month')).includes('seltzer'));
  assert.ok(extractProductSearchTerms(buildSemanticPlan('energy bar sales')).includes('energy bar'));
  assert.ok(extractProductSearchTerms(buildSemanticPlan('ready to drink coffee sales')).includes('ready to drink coffee'));
});

test('expandProductSearchTerms adds editable aliases without losing raw terms', () => {
  const expanded = expandProductSearchTerms(['sparkling water', 'protein bar', 'cold brew']);

  assert.deepEqual(expanded[0].expandedTerms, [
    'sparkling water',
    'seltzer',
    'carbonated water',
    'fizzy water',
  ]);
  assert.deepEqual(expanded[1].expandedTerms, ['protein bar', 'energy bar', 'meal bar']);
  assert.deepEqual(expanded[2].expandedTerms, ['cold brew', 'iced coffee', 'ready to drink coffee']);
});

test('buildProductCandidateQuery uses parameterized SQL and whitelisted Product columns only', () => {
  const query = buildProductCandidateQuery(expandProductSearchTerms(['sparkling water']), { queryLimit: 25 });

  assert.match(query.sql, /^SELECT ProductId, ProductCode, ProductName, ProductTags FROM Product WHERE /);
  assert.match(query.sql, /LOWER\(COALESCE\(ProductName, ''\)\) LIKE \? ESCAPE/);
  assert.ok(query.sql.includes("ESCAPE '\\\\'"));
  assert.doesNotMatch(query.sql, /sparkling water/i);
  assert.equal(query.params.at(-1), 25);
  assert.ok(query.params.includes('%sparkling water%'));
  assert.ok(query.params.includes('%seltzer%'));
});

test('rankProductCandidates resolves public product terms to canonical fixture rows', () => {
  const rows = [
    { ProductId: 101, ProductCode: 'SW12', ProductName: 'Sparkling Water 12 Pack', ProductTags: 'seltzer carbonated water beverage' },
    { ProductId: 102, ProductCode: 'PB06', ProductName: 'Protein Bar Variety Box', ProductTags: 'energy bar snack' },
    { ProductId: 103, ProductCode: 'RICE', ProductName: 'Long Grain Rice', ProductTags: 'pantry staple' },
  ];
  const ranked = rankProductCandidates(rows, expandProductSearchTerms(['sparkling water', 'protein bar']), { limitPerTerm: 3 });

  assert.equal(ranked.find((entry) => entry.term === 'sparkling water').candidates[0].ProductName, 'Sparkling Water 12 Pack');
  assert.equal(ranked.find((entry) => entry.term === 'protein bar').candidates[0].ProductName, 'Protein Bar Variety Box');
});

test('resolveMasterDataCandidates queries each product term so later terms are not starved', async () => {
  const semanticPlan = buildSemanticPlan('sparkling water aur protein bar ki sales');
  const calls = [];
  const connection = {
    async query(sql, params) {
      calls.push({ sql, params });
      const queryText = params.join(' ');
      if (queryText.includes('protein bar') || queryText.includes('energy bar')) {
        return [
          [
            { ProductId: 102, ProductCode: 'PB06', ProductName: 'Protein Bar Variety Box', ProductTags: 'energy bar snack' },
          ],
        ];
      }

      return [
        [
          { ProductId: 101, ProductCode: 'SW12', ProductName: 'Sparkling Water 12 Pack', ProductTags: 'seltzer carbonated water beverage' },
          { ProductId: 104, ProductCode: 'SW24', ProductName: 'Sparkling Water 24 Pack', ProductTags: 'carbonated water beverage' },
        ],
      ];
    },
  };

  const resolved = await resolveMasterDataCandidates({
    connection,
    semanticPlan,
    queryLimit: 50,
    limitPerTerm: 2,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.params.at(-1) === 50));
  assert.equal(resolved[0].entity, 'product');
  assert.equal(resolved[0].totalCandidateCount, 3);
  assert.equal(resolved[0].terms.find((entry) => entry.term === 'sparkling water').candidates[0].ProductId, 101);
  assert.equal(resolved[0].terms.find((entry) => entry.term === 'protein bar').candidates[0].ProductId, 102);
});

test('optimized prompt includes only resolved master-data candidates, not the product master', () => {
  const prompt = buildOptimizedPrompt(createProductSchema(), 'sparkling water sales', {
    masterDataCandidates: [
      {
        entity: 'product',
        searchColumns: ['ProductName', 'ProductCode'],
        terms: [
          {
            term: 'sparkling water',
            expandedTerms: ['sparkling water', 'seltzer'],
            candidates: [
              { ProductId: 101, ProductCode: 'SW12', ProductName: 'Sparkling Water 12 Pack', score: 85, matchedValue: 'sparkling water', matchType: 'field_prefix' },
            ],
          },
        ],
        totalCandidateCount: 1,
      },
    ],
  });

  assert.match(prompt.user, /Resolved master-data candidates:/);
  assert.match(prompt.user, /ProductId 101/);
  assert.match(prompt.user, /Sparkling Water 12 Pack/);
  assert.doesNotMatch(prompt.user, /Long Grain Rice/);
  assert.equal(prompt.context.masterDataCandidates[0].totalCandidateCount, 1);
});
