import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBasicPrompt,
  buildOptimizedPrompt,
  buildQuestionContext,
  buildSemanticPlan,
  extractTemporalReferences,
  normalizeTokens,
  retrieveRelevantTables,
} from '../src/pipeline.js';

function createColumn(name, overrides = {}) {
  return {
    name,
    type: 'INTEGER',
    allowNull: true,
    primaryKey: false,
    references: null,
    comment: null,
    ...overrides,
  };
}

function createSemanticRetrievalSchema() {
  return {
    tables: [
      {
        name: 'Customer',
        tableName: 'Customer',
        description: 'customers',
        file: 'Customer.js',
        columns: [
          createColumn('CustomerId', { primaryKey: true }),
          createColumn('CustomerName', { type: 'STRING(50)' }),
          createColumn('CustomerCode', { type: 'STRING(20)' }),
        ],
        foreignKeys: [],
      },
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        description: 'document header',
        file: 'SalesDocument.js',
        columns: [
          createColumn('SalesDocumentId', { primaryKey: true }),
          createColumn('CustomerId', { references: { model: 'Customer', key: 'CustomerId' } }),
          createColumn('DocumentTypeId', { references: { model: 'DocumentType', key: 'DocumentTypeId' } }),
          createColumn('StoreLocationId', { references: { model: 'StoreLocation', key: 'StoreLocationId' } }),
          createColumn('DocumentDate', { type: 'DATE' }),
          createColumn('NetAmount', { type: 'DECIMAL(10,2)' }),
          createColumn('IsCanceled'),
        ],
        foreignKeys: [
          { column: 'CustomerId', references: { model: 'Customer', key: 'CustomerId' } },
          { column: 'DocumentTypeId', references: { model: 'DocumentType', key: 'DocumentTypeId' } },
          { column: 'StoreLocationId', references: { model: 'StoreLocation', key: 'StoreLocationId' } },
        ],
      },
      {
        name: 'SalesDocumentLine',
        tableName: 'SalesDocumentLine',
        description: 'document detail lines',
        file: 'SalesDocumentLine.js',
        columns: [
          createColumn('SalesDocumentLineId', { primaryKey: true }),
          createColumn('SalesDocumentId', { references: { model: 'SalesDocument', key: 'SalesDocumentId' } }),
          createColumn('ProductId', { references: { model: 'Product', key: 'ProductId' } }),
          createColumn('Quantity', { type: 'DECIMAL(10,2)' }),
          createColumn('NetAmount', { type: 'DECIMAL(10,2)' }),
          createColumn('ProductNameSnapshot', { type: 'STRING(100)' }),
        ],
        foreignKeys: [
          { column: 'SalesDocumentId', references: { model: 'SalesDocument', key: 'SalesDocumentId' } },
          { column: 'ProductId', references: { model: 'Product', key: 'ProductId' } },
        ],
      },
      {
        name: 'Product',
        tableName: 'Product',
        description: 'products',
        file: 'Product.js',
        columns: [
          createColumn('ProductId', { primaryKey: true }),
          createColumn('ProductName', { type: 'STRING(100)' }),
          createColumn('ProductCode', { type: 'STRING(30)' }),
        ],
        foreignKeys: [],
      },
      {
        name: 'DocumentType',
        tableName: 'DocumentType',
        description: 'document types',
        file: 'DocumentType.js',
        columns: [
          createColumn('DocumentTypeId', { primaryKey: true }),
          createColumn('DocumentTypeName', { type: 'STRING(50)' }),
          createColumn('DocumentTypeClass', { type: 'STRING(50)' }),
        ],
        foreignKeys: [],
      },
      {
        name: 'StoreLocation',
        tableName: 'StoreLocation',
        description: 'branch locations',
        file: 'StoreLocation.js',
        columns: [
          createColumn('StoreLocationId', { primaryKey: true }),
          createColumn('LocationName', { type: 'STRING(100)' }),
          createColumn('LocationCode', { type: 'STRING(20)' }),
        ],
        foreignKeys: [],
      },
      {
        name: 'AccountingPosting',
        tableName: 'AccountingPosting',
        description: 'accounting postings',
        file: 'AccountingPosting.js',
        columns: [
          createColumn('AccountingPostingId', { primaryKey: true }),
          createColumn('SalesDocumentId', { references: { model: 'SalesDocument', key: 'SalesDocumentId' } }),
          createColumn('LedgerAccountId', { references: { model: 'LedgerAccount', key: 'LedgerAccountId' } }),
          createColumn('DebitAmount', { type: 'DECIMAL(10,2)' }),
        ],
        foreignKeys: [
          { column: 'SalesDocumentId', references: { model: 'SalesDocument', key: 'SalesDocumentId' } },
          { column: 'LedgerAccountId', references: { model: 'LedgerAccount', key: 'LedgerAccountId' } },
        ],
      },
      {
        name: 'LedgerAccount',
        tableName: 'LedgerAccount',
        description: 'ledger accounts',
        file: 'LedgerAccount.js',
        columns: [
          createColumn('LedgerAccountId', { primaryKey: true }),
          createColumn('AccountCode', { type: 'STRING(20)' }),
          createColumn('AccountName', { type: 'STRING(100)' }),
        ],
        foreignKeys: [],
      },
    ],
  };
}

function createMasterDataRetrievalSchema() {
  const schema = createSemanticRetrievalSchema();
  const product = schema.tables.find((table) => table.name === 'Product');

  product.columns.push(
    createColumn('CampaignId', { references: { model: 'Campaign', key: 'CampaignId' } }),
    createColumn('ProductCategoryId', { references: { model: 'ProductCategory', key: 'ProductCategoryId' } }),
    createColumn('BrandId', { references: { model: 'Brand', key: 'BrandId' } })
  );
  product.foreignKeys.push(
    { column: 'CampaignId', references: { model: 'Campaign', key: 'CampaignId' } },
    { column: 'ProductCategoryId', references: { model: 'ProductCategory', key: 'ProductCategoryId' } },
    { column: 'BrandId', references: { model: 'Brand', key: 'BrandId' } }
  );

  schema.tables.push(
    {
      name: 'Campaign',
      tableName: 'Campaign',
      description: 'campaign master',
      file: 'Campaign.js',
      columns: [
        createColumn('CampaignId', { primaryKey: true }),
        createColumn('CampaignName', { type: 'STRING(255)' }),
        createColumn('CampaignCode', { type: 'STRING(50)' }),
      ],
      foreignKeys: [],
    },
    {
      name: 'ProductCategory',
      tableName: 'ProductCategory',
      description: 'product category master',
      file: 'ProductCategory.js',
      columns: [
        createColumn('ProductCategoryId', { primaryKey: true }),
        createColumn('CategoryName', { type: 'STRING(255)' }),
        createColumn('CategoryCode', { type: 'STRING(50)' }),
      ],
      foreignKeys: [],
    },
    {
      name: 'Brand',
      tableName: 'Brand',
      description: 'brand master',
      file: 'Brand.js',
      columns: [
        createColumn('BrandId', { primaryKey: true }),
        createColumn('BrandName', { type: 'STRING(100)' }),
        createColumn('BrandCode', { type: 'STRING(50)' }),
        createColumn('ProductCategoryId', { references: { model: 'ProductCategory', key: 'ProductCategoryId' } }),
      ],
      foreignKeys: [{ column: 'ProductCategoryId', references: { model: 'ProductCategory', key: 'ProductCategoryId' } }],
    },
    {
      name: 'ProductBrand',
      tableName: 'ProductBrand',
      description: 'bridge between products and brands',
      file: 'ProductBrand.js',
      columns: [
        createColumn('ProductBrandId', { primaryKey: true }),
        createColumn('ProductId', { references: { model: 'Product', key: 'ProductId' } }),
        createColumn('BrandId', { references: { model: 'Brand', key: 'BrandId' } }),
      ],
      foreignKeys: [
        { column: 'ProductId', references: { model: 'Product', key: 'ProductId' } },
        { column: 'BrandId', references: { model: 'Brand', key: 'BrandId' } },
      ],
    }
  );

  return schema;
}

test('normalizeTokens preserves useful plural and acronym forms while adding safe singular variants', () => {
  const tokens = normalizeTokens('SKUs, document classes, branches, sales, and goods');

  assert.ok(tokens.includes('skus'));
  assert.ok(tokens.includes('sku'));
  assert.ok(tokens.includes('classes'));
  assert.ok(tokens.includes('class'));
  assert.ok(tokens.includes('branches'));
  assert.ok(tokens.includes('branch'));
  assert.ok(tokens.includes('sales'));
  assert.ok(tokens.includes('sale'));
  assert.ok(tokens.includes('goods'));
  assert.ok(!tokens.includes('sk'));
  assert.ok(!tokens.includes('classe'));
  assert.ok(!tokens.includes('branche'));
});

test('extractTemporalReferences resolves abbreviated month-year phrases with two-digit years', () => {
  const references = extractTemporalReferences('top 10 Products with good sales in Feb, 26 but zero sale in Mar, 26');

  assert.equal(references.length, 2);
  assert.deepEqual(references.map((reference) => reference.normalizedText), ['February 2026', 'March 2026']);
  assert.deepEqual(references.map((reference) => reference.startDate), ['2026-02-01', '2026-03-01']);
  assert.deepEqual(references.map((reference) => reference.endExclusive), ['2026-03-01', '2026-04-01']);
});

test('extractTemporalReferences does not treat day-of-month phrases as years', () => {
  const references = extractTemporalReferences('Show sales on March 12 and returns due Feb 29');

  assert.equal(references.length, 0);
});

test('extractTemporalReferences still resolves four-digit years without a comma', () => {
  const references = extractTemporalReferences('Show monthly sales in March 2026');

  assert.equal(references.length, 1);
  assert.equal(references[0].normalizedText, 'March 2026');
  assert.equal(references[0].startDate, '2026-03-01');
  assert.equal(references[0].endExclusive, '2026-04-01');
});

test('buildQuestionContext uses normalized temporal text for retrieval tokens', () => {
  const context = buildQuestionContext('Show monthly sales in Feb, 26');

  assert.equal(context.normalizedQuestion, 'Show monthly sales in February 2026');
  assert.ok(context.questionTokens.includes('2026'));
  assert.ok(context.questionTokens.includes('february'));
});

test('buildQuestionContext normalizes repeated temporal phrases consistently', () => {
  const context = buildQuestionContext('Compare Feb, 26 against Feb, 26 totals');

  assert.equal(context.normalizedQuestion, 'Compare February 2026 against February 2026 totals');
});

test('retrieveRelevantTables adds only shortest-path connector tables instead of all one-hop neighbors', () => {
  const schema = {
    tables: [
      {
        name: 'Product',
        tableName: 'Product',
        description: 'products',
        file: 'Product.js',
        columns: [createColumn('ProductId', { primaryKey: true }), createColumn('ProductName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        description: 'document header',
        file: 'SalesDocument.js',
        columns: [createColumn('SalesDocumentId', { primaryKey: true }), createColumn('DocumentDate', { type: 'DATE' })],
        foreignKeys: [],
      },
      {
        name: 'SalesLineBridge',
        tableName: 'SalesLineBridge',
        description: 'bridge table between documents and products',
        file: 'SalesLineBridge.js',
        columns: [
          createColumn('SalesLineBridgeId', { primaryKey: true }),
          createColumn('BridgeProductId', { references: { model: 'Product', key: 'ProductId' } }),
          createColumn('BridgeDocumentId', { references: { model: 'SalesDocument', key: 'SalesDocumentId' } }),
        ],
        foreignKeys: [
          { column: 'BridgeProductId', references: { model: 'Product', key: 'ProductId' } },
          { column: 'BridgeDocumentId', references: { model: 'SalesDocument', key: 'SalesDocumentId' } },
        ],
      },
      {
        name: 'Customer',
        tableName: 'Customer',
        description: 'customers',
        file: 'Customer.js',
        columns: [createColumn('CustomerId', { primaryKey: true }), createColumn('CustomerName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'CustomerStoreLocation',
        tableName: 'CustomerStoreLocation',
        description: 'customer addresses',
        file: 'CustomerStoreLocation.js',
        columns: [
          createColumn('CustomerStoreLocationId', { primaryKey: true }),
          createColumn('CustomerStoreLocationCustomerId', { references: { model: 'Customer', key: 'CustomerId' } }),
        ],
        foreignKeys: [{ column: 'CustomerStoreLocationCustomerId', references: { model: 'Customer', key: 'CustomerId' } }],
      },
    ],
  };

  const retrieval = retrieveRelevantTables(schema, 'Show product document totals', { maxTables: 2 });

  assert.deepEqual(retrieval.initialTableNames, ['Product', 'SalesDocument']);
  assert.deepEqual(retrieval.expandedTableNames, ['Product', 'SalesDocument', 'SalesLineBridge']);
  assert.deepEqual(retrieval.connectorTableNames, ['SalesLineBridge']);
});

test('retrieveRelevantTables connects non-anchor seed tables through pairwise join paths', () => {
  const schema = {
    tables: [
      {
        name: 'Alpha',
        tableName: 'Alpha',
        description: 'alpha entities',
        file: 'Alpha.js',
        columns: [createColumn('AlphaId', { primaryKey: true }), createColumn('AlphaName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'LinkOne',
        tableName: 'LinkOne',
        description: 'bridge records',
        file: 'LinkOne.js',
        columns: [
          createColumn('LinkOneId', { primaryKey: true }),
          createColumn('ParentId', { references: { model: 'Alpha', key: 'AlphaId' } }),
          createColumn('ChildId', { references: { model: 'Beta', key: 'BetaId' } }),
        ],
        foreignKeys: [
          { column: 'ParentId', references: { model: 'Alpha', key: 'AlphaId' } },
          { column: 'ChildId', references: { model: 'Beta', key: 'BetaId' } },
        ],
      },
      {
        name: 'Beta',
        tableName: 'Beta',
        description: 'beta entities',
        file: 'Beta.js',
        columns: [createColumn('BetaId', { primaryKey: true }), createColumn('BetaName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'LinkTwo',
        tableName: 'LinkTwo',
        description: 'bridge records',
        file: 'LinkTwo.js',
        columns: [
          createColumn('LinkTwoId', { primaryKey: true }),
          createColumn('ParentId', { references: { model: 'Beta', key: 'BetaId' } }),
          createColumn('ChildId', { references: { model: 'Gamma', key: 'GammaId' } }),
        ],
        foreignKeys: [
          { column: 'ParentId', references: { model: 'Beta', key: 'BetaId' } },
          { column: 'ChildId', references: { model: 'Gamma', key: 'GammaId' } },
        ],
      },
      {
        name: 'Gamma',
        tableName: 'Gamma',
        description: 'gamma entities',
        file: 'Gamma.js',
        columns: [createColumn('GammaId', { primaryKey: true }), createColumn('GammaName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
    ],
  };

  const retrieval = retrieveRelevantTables(schema, 'Show alpha beta gamma totals', { maxTables: 3 });

  assert.deepEqual(retrieval.initialTableNames, ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(retrieval.expandedTableNames, ['Alpha', 'LinkOne', 'Beta', 'LinkTwo', 'Gamma']);
  assert.deepEqual(retrieval.connectorTableNames, ['LinkOne', 'LinkTwo']);
});

test('prompts include resolved temporal references in prompt text and metadata', () => {
  const schema = {
    tables: [
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        description: 'document header',
        file: 'SalesDocument.js',
        columns: [createColumn('SalesDocumentId', { primaryKey: true }), createColumn('DocumentDate', { type: 'DATE' })],
        foreignKeys: [],
      },
    ],
  };

  const basicPrompt = buildBasicPrompt(schema, 'Show document totals in Feb, 26');
  const optimizedPrompt = buildOptimizedPrompt(schema, 'Show document totals in Feb, 26');

  assert.match(basicPrompt.system, /Resolved temporal references:/);
  assert.match(basicPrompt.system, /"Feb, 26" => February 2026/);
  assert.equal(basicPrompt.context.normalizedQuestion, 'Show document totals in February 2026');
  assert.equal(basicPrompt.context.temporalReferences[0].startDate, '2026-02-01');

  assert.match(optimizedPrompt.user, /Resolved temporal references:/);
  assert.match(optimizedPrompt.user, /appropriate in-scope date column/);
  assert.doesNotMatch(optimizedPrompt.user, /DocumentDate >= '2026-02-01'/);
  assert.equal(optimizedPrompt.context.normalizedQuestion, 'Show document totals in February 2026');
  assert.equal(optimizedPrompt.context.retrieval.connectorTableNames.length, 0);
});

test('semantic retrieval resolves business paraphrases that lexical retrieval misses', () => {
  const schema = createSemanticRetrievalSchema();
  const cases = [
    {
      question: 'Who are our biggest buyers in March 2026?',
      expectedTables: ['Customer', 'SalesDocument'],
      expectedMetrics: ['net_sales'],
    },
    {
      question: 'Which SKUs moved the most in March 2026?',
      expectedTables: ['Product', 'SalesDocumentLine', 'SalesDocument'],
      expectedMetrics: ['quantity_sold'],
    },
    {
      question: 'Which document classes were used the most in March 2026?',
      expectedTables: ['DocumentType', 'SalesDocument'],
      expectedMetrics: ['document_count'],
    },
    {
      question: 'How many SKUs sold in February 2026 but stopped selling in March 2026?',
      expectedTables: ['SalesDocumentLine', 'SalesDocument'],
      expectedMetrics: ['quantity_sold'],
    },
    {
      question: 'Show sparkling water, protein bar or cold brew product sales by branch monthwise',
      expectedTables: ['StoreLocation', 'Product', 'SalesDocumentLine', 'SalesDocument'],
      expectedMetrics: ['net_sales', 'line_net_sales'],
    },
  ];

  for (const testCase of cases) {
    const retrieval = retrieveRelevantTables(schema, testCase.question, { maxTables: 4 });

    assert.equal(retrieval.fallbackToDefaultSelection, false, testCase.question);
    for (const tableName of testCase.expectedTables) {
      assert.ok(retrieval.expandedTableNames.includes(tableName), `${testCase.question} should retrieve ${tableName}`);
    }
    for (const metricName of testCase.expectedMetrics) {
      assert.ok(
        retrieval.semanticPlan.metrics.some((metric) => metric.name === metricName),
        `${testCase.question} should match metric ${metricName}`
      );
    }
  }
});

test('product-only prompts do not trigger product net sales metric without sales intent', () => {
  const schema = createSemanticRetrievalSchema();
  const retrieval = retrieveRelevantTables(schema, 'List protein bar SKUs', { maxTables: 4 });

  assert.ok(retrieval.expandedTableNames.includes('Product'));
  assert.ok(!retrieval.semanticPlan.metrics.some((metric) => metric.name === 'line_net_sales'));
  assert.ok(!retrieval.semanticPlan.metrics.some((metric) => metric.name === 'net_sales'));
  assert.ok(!retrieval.expandedTableNames.includes('SalesDocument'));
  assert.ok(!retrieval.expandedTableNames.includes('SalesDocumentLine'));
});

test('semantic plan captures mixed-language product alternatives as OR filter hints', () => {
  const plan = buildSemanticPlan('Show sparkling water, protein bar or cold brew product sales by branch monthwise');
  const filterHint = plan.filterHints.find((entry) => entry.name === 'demo_product_terms');

  assert.ok(plan.entities.some((entry) => entry.name === 'store_location'));
  assert.ok(plan.entities.some((entry) => entry.name === 'product'));
  assert.ok(filterHint);
  assert.deepEqual(filterHint.matchedValues, ['sparkling water', 'protein bar', 'cold brew']);
  assert.equal(filterHint.operator, 'OR_LIKE');
  assert.ok(plan.metrics.some((metric) => metric.name === 'line_net_sales'));
});

test('optimized prompt includes semantic hints for product alternatives and semantic joins', () => {
  const schema = createSemanticRetrievalSchema();
  const prompt = buildOptimizedPrompt(
    schema,
    'Show sparkling water, protein bar or cold brew product sales by branch monthwise'
  );

  assert.match(prompt.user, /Semantic retrieval hints:/);
  assert.match(prompt.user, /Filter hint "demo_product_terms"/);
  assert.match(prompt.user, /sparkling water, protein bar, cold brew/);
  assert.match(prompt.user, /OR_LIKE/);
  assert.match(prompt.user, /Semantic join "document_to_location"/);
  assert.ok(prompt.context.semanticPlan.requiredTables.includes('StoreLocation'));
  assert.ok(prompt.context.semanticPlan.requiredTables.includes('Product'));
});

test('optimized prompt renders semantic default filters and matched clarification rules', () => {
  const schema = createSemanticRetrievalSchema();
  const prompt = buildOptimizedPrompt(schema, 'Show revenue by document');

  assert.match(prompt.user, /apply default filters IFNULL\(SalesDocument\.IsCanceled, 0\) = 0/);
  assert.match(prompt.user, /Clarification rule "revenue"/);
  assert.ok(prompt.context.semanticPlan.defaultFilters.includes('IFNULL(SalesDocument.IsCanceled, 0) = 0'));
  assert.ok(prompt.context.semanticPlan.clarificationRules.some((rule) => rule.trigger === 'revenue'));
});

test('document-type wording pulls DocumentType into retrieval for named document types', () => {
  const schema = {
    tables: [
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        description: 'document header',
        file: 'SalesDocument.js',
        columns: [
          createColumn('SalesDocumentId', { primaryKey: true }),
          createColumn('DocumentTypeId', { references: { model: 'DocumentType', key: 'DocumentTypeId' } }),
          createColumn('CustomerId', { references: { model: 'Customer', key: 'CustomerId' } }),
          createColumn('NetAmount', { type: 'DECIMAL(10,2)' }),
        ],
        foreignKeys: [
          { column: 'DocumentTypeId', references: { model: 'DocumentType', key: 'DocumentTypeId' } },
          { column: 'CustomerId', references: { model: 'Customer', key: 'CustomerId' } },
        ],
      },
      {
        name: 'DocumentType',
        tableName: 'DocumentType',
        description: 'document types',
        file: 'DocumentType.js',
        columns: [createColumn('DocumentTypeId', { primaryKey: true }), createColumn('DocumentTypeName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'Customer',
        tableName: 'Customer',
        description: 'customers',
        file: 'Customer.js',
        columns: [createColumn('CustomerId', { primaryKey: true }), createColumn('CustomerName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'CustomerProductPrice',
        tableName: 'CustomerProductPrice',
        description: 'customer pricing',
        file: 'CustomerProductPrice.js',
        columns: [createColumn('CustomerProductPriceId', { primaryKey: true }), createColumn('CustomerProductPriceCustomerId', { references: { model: 'Customer', key: 'CustomerId' } })],
        foreignKeys: [{ column: 'CustomerProductPriceCustomerId', references: { model: 'Customer', key: 'CustomerId' } }],
      },
    ],
  };

  const retrieval = retrieveRelevantTables(schema, 'Show the top 10 AR Invoice customers by document net amount.');

  assert.ok(retrieval.initialTableNames.includes('DocumentType'));
});

test('generic payment wording does not force DocumentType into retrieval', () => {
  const schema = {
    tables: [
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        description: 'document header',
        file: 'SalesDocument.js',
        columns: [createColumn('SalesDocumentId', { primaryKey: true }), createColumn('PaidAmount', { type: 'DECIMAL(10,2)' })],
        foreignKeys: [],
      },
      {
        name: 'DocumentType',
        tableName: 'DocumentType',
        description: 'document types',
        file: 'DocumentType.js',
        columns: [createColumn('DocumentTypeId', { primaryKey: true }), createColumn('DocumentTypeName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'Customer',
        tableName: 'Customer',
        description: 'customers',
        file: 'Customer.js',
        columns: [createColumn('CustomerId', { primaryKey: true }), createColumn('CustomerName', { type: 'STRING(50)' })],
        foreignKeys: [],
      },
      {
        name: 'SalesDocumentLine',
        tableName: 'SalesDocumentLine',
        description: 'document detail lines',
        file: 'SalesDocumentLine.js',
        columns: [createColumn('SalesDocumentLineId', { primaryKey: true }), createColumn('NetAmount', { type: 'DECIMAL(10,2)' })],
        foreignKeys: [],
      },
    ],
  };

  const retrieval = retrieveRelevantTables(schema, 'Show customer payment totals', { maxTables: 2 });

  assert.ok(!retrieval.initialTableNames.includes('DocumentType'));
  assert.ok(!retrieval.expandedTableNames.includes('DocumentType'));
});

test('semantic retrieval uses Campaign through Product for campaign-filtered product sales', () => {
  const retrieval = retrieveRelevantTables(
    createMasterDataRetrievalSchema(),
    'Total campaign sales for urban refresh in March and April 2026'
  );

  assert.ok(retrieval.expandedTableNames.includes('Campaign'));
  assert.ok(retrieval.expandedTableNames.includes('Product'));
  assert.ok(retrieval.expandedTableNames.includes('SalesDocumentLine'));
  assert.ok(retrieval.expandedTableNames.includes('SalesDocument'));
  assert.ok(retrieval.semanticPlan.metrics.some((metric) => metric.name === 'line_net_sales'));
  assert.ok(retrieval.semanticPlan.joinHints.some((joinHint) => joinHint.name === 'product_to_campaign'));
});

test('optimized prompt guides fuzzy entity matching and current product category joins', () => {
  const prompt = buildOptimizedPrompt(
    createMasterDataRetrievalSchema(),
    'Snack category sales for North District Market in Jan and Feb,26 separate columns for each month to compare? (Product categories table is ProductCategory)'
  );

  assert.match(prompt.system, /prefer LIKE with surrounding wildcards/);
  assert.match(prompt.system, /include Customer\.CustomerName and StoreLocation\.LocationName as candidate text filters/);
  assert.match(prompt.system, /prefer ProductCategory joined through Product\.ProductCategoryId/);
  assert.match(prompt.user, /Filter hint "product_category_terms"/);
  assert.ok(prompt.context.semanticPlan.requiredTables.includes('ProductCategory'));
  assert.ok(prompt.context.semanticPlan.joinHints.some((joinHint) => joinHint.name === 'product_to_category'));
});

test('semantic retrieval includes brand master context for brand sales comparison', () => {
  const retrieval = retrieveRelevantTables(
    createMasterDataRetrievalSchema(),
    'sales comparison by brand in Mar and April this year ... seperate columns for each month'
  );

  assert.ok(retrieval.expandedTableNames.includes('Brand'));
  assert.ok(retrieval.expandedTableNames.includes('ProductBrand') || retrieval.expandedTableNames.includes('Product'));
  assert.ok(retrieval.semanticPlan.metrics.some((metric) => metric.name === 'line_net_sales'));
  assert.ok(
    retrieval.semanticPlan.joinHints.some((joinHint) =>
      ['product_brand_to_brand', 'product_to_brand'].includes(joinHint.name)
    )
  );
});
