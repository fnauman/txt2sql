import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOptimizedPrompt, validateReadOnlySql } from '../src/pipeline.js';
import { validateSqlGuardrails } from '../src/sql-guardrails.js';

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

function createGuardrailSchema() {
  return {
    tables: [
      {
        name: 'Customer',
        tableName: 'Customer',
        description: 'Customer master',
        columns: [
          createColumn('CustomerId', { type: 'INTEGER', primaryKey: true }),
          createColumn('CustomerName'),
          createColumn('CustomerCode'),
        ],
        foreignKeys: [],
      },
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        description: 'Document header',
        columns: [
          createColumn('SalesDocumentId', { type: 'INTEGER', primaryKey: true }),
          createColumn('CustomerId', {
            type: 'INTEGER',
            references: { model: 'Customer', key: 'CustomerId' },
          }),
          createColumn('NetAmount', { type: 'DECIMAL(10,2)' }),
          createColumn('BillTotalAmount', { type: 'DECIMAL(10,2)' }),
          createColumn('DocumentDate', { type: 'DATE' }),
          createColumn('IsCanceled', { type: 'INTEGER(1)' }),
        ],
        foreignKeys: [{ column: 'CustomerId', references: { model: 'Customer', key: 'CustomerId' } }],
      },
      {
        name: 'Product',
        tableName: 'Product',
        description: 'Product master',
        columns: [
          createColumn('ProductId', { type: 'INTEGER', primaryKey: true }),
          createColumn('ProductName'),
          createColumn('ProductCode'),
        ],
        foreignKeys: [],
      },
      {
        name: 'SalesDocumentLine',
        tableName: 'SalesDocumentLine',
        description: 'Document detail',
        columns: [
          createColumn('SalesDocumentLineId', { type: 'INTEGER', primaryKey: true }),
          createColumn('ProductId', {
            type: 'INTEGER',
            references: { model: 'Product', key: 'ProductId' },
          }),
          createColumn('SalesDocumentId', {
            type: 'INTEGER',
            references: { model: 'SalesDocument', key: 'SalesDocumentId' },
          }),
          createColumn('NetAmount', { type: 'DECIMAL(10,2)' }),
        ],
        foreignKeys: [
          { column: 'ProductId', references: { model: 'Product', key: 'ProductId' } },
          { column: 'SalesDocumentId', references: { model: 'SalesDocument', key: 'SalesDocumentId' } },
        ],
      },
    ],
  };
}

function allowedTables(prompt) {
  return prompt.tables.map((table) => table.tableName);
}

function buildSparklingWaterSalesPrompt() {
  return buildOptimizedPrompt(createGuardrailSchema(), 'sparkling water sales', {
    masterDataCandidates: [
      {
        entity: 'product',
        searchColumns: ['ProductName', 'ProductCode'],
        terms: [
          {
            term: 'sparkling water',
            expandedTerms: ['sparkling water', 'seltzer'],
            candidates: [
              { ProductId: 101, ProductCode: 'SW12', ProductName: 'Sparkling Water 12 Pack', score: 85 },
            ],
          },
        ],
        totalCandidateCount: 1,
      },
    ],
  });
}

test('validateReadOnlySql rejects hallucinated qualified columns in prompt context', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT c.CustomerDisplayName, SUM(v.NetAmount) AS total_net_amount
         FROM SalesDocument v
         JOIN Customer c ON v.CustomerId = c.CustomerId
         GROUP BY c.CustomerDisplayName`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['SalesDocument', 'Customer'] },
        }
      ),
    /unknown column "CustomerDisplayName"/
  );
});

test('validateReadOnlySql rejects joins outside in-scope relationships', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT c.CustomerName, SUM(v.NetAmount) AS total_net_amount
         FROM SalesDocument v
         JOIN Customer c ON v.SalesDocumentId = c.CustomerId
         GROUP BY c.CustomerName`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['SalesDocument', 'Customer'] },
        }
      ),
    /not an in-scope relationship/
  );
});

test('validateReadOnlySql enforces preferred semantic metric columns', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT c.CustomerName, SUM(v.BillTotalAmount) AS total_net_amount
         FROM SalesDocument v
         JOIN Customer c ON v.CustomerId = c.CustomerId
         GROUP BY c.CustomerName`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['SalesDocument', 'Customer'] },
        }
      ),
    /preferred column for semantic metric "net_sales"/
  );
});

test('validateReadOnlySql enforces resolved ProductId candidates', () => {
  const prompt = buildSparklingWaterSalesPrompt();

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT SUM(d.NetAmount) AS total_net_amount
         FROM SalesDocumentLine d
         JOIN Product i ON d.ProductId = i.ProductId
         WHERE i.ProductId IN (999)`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['SalesDocumentLine', 'Product'] },
        }
      ),
    /ProductId 999/
  );
});

test('validateReadOnlySql enforces resolved ProductId candidates on product foreign keys', () => {
  const prompt = buildSparklingWaterSalesPrompt();

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT SUM(d.NetAmount) AS total_net_amount
         FROM SalesDocumentLine d
         WHERE d.ProductId IN (999)`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['SalesDocumentLine'] },
        }
      ),
    /ProductId 999/
  );
});

test('validateReadOnlySql does not treat unrelated numeric predicates as ProductIds', () => {
  const prompt = buildSparklingWaterSalesPrompt();
  const validated = validateReadOnlySql(
    `SELECT SUM(d.NetAmount) AS total_net_amount
     FROM SalesDocumentLine d
     JOIN Product i ON d.ProductId = i.ProductId
     WHERE i.ProductId = 101 AND d.SalesDocumentLineId > 0`,
    allowedTables(prompt),
    {
      promptContext: prompt.context,
      response: { tables_used: ['SalesDocumentLine', 'Product'] },
    }
  );

  assert.deepEqual(validated.guardrails.masterDataChecks.referencedIds, [101]);
});

test('validateSqlGuardrails recognizes multiple CamelCase CTE names', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'List customers');

  assert.doesNotThrow(() =>
    validateSqlGuardrails(
      `WITH FirstCustomers AS (
         SELECT CustomerId FROM Customer
       ),
       ActiveCustomers AS (
         SELECT CustomerId FROM FirstCustomers
       )
       SELECT COUNT(*) AS total_customers FROM ActiveCustomers`,
      {
        allowedTables: allowedTables(prompt),
        promptContext: prompt.context,
        response: { tables_used: ['Customer'] },
        tablesUsed: ['Customer'],
      }
    )
  );
});

test('validateReadOnlySql returns guardrail metadata for valid SQL', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');
  const validated = validateReadOnlySql(
    `SELECT c.CustomerName, SUM(v.NetAmount) AS total_net_amount
     FROM SalesDocument v
     JOIN Customer c ON v.CustomerId = c.CustomerId
     GROUP BY c.CustomerName`,
    allowedTables(prompt),
    {
      promptContext: prompt.context,
      response: { tables_used: ['SalesDocument', 'Customer'] },
    }
  );

  assert.equal(validated.guardrails.metricChecks[0].name, 'net_sales');
  assert.equal(validated.guardrails.joinChecks[0].leftColumn, 'CustomerId');
});

test('validateReadOnlySql allows qualified columns from derived table aliases', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'product sales by brand');
  const validated = validateReadOnlySql(
    `SELECT x.brand_name, SUM(x.line_amount) AS total_net_amount
     FROM (
       SELECT i.ProductName AS brand_name, d.NetAmount AS line_amount
       FROM SalesDocumentLine d
       JOIN Product i ON d.ProductId = i.ProductId
     ) x
     GROUP BY x.brand_name`,
    allowedTables(prompt),
    {
      promptContext: prompt.context,
      response: { tables_used: ['SalesDocumentLine', 'Product'] },
    }
  );

  assert.deepEqual(validated.tablesUsed, ['SalesDocumentLine', 'Product']);
  assert.ok(
    validated.guardrails.columnChecks.qualifiedColumns.some(
      (column) => column.qualifier === 'x' && column.columnName === 'brand_name'
    )
  );
});

test('validateReadOnlySql rejects unknown columns from derived table aliases', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'product sales by brand');

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT x.brand_nam, SUM(x.line_amount) AS total_net_amount
         FROM (
           SELECT i.ProductName AS brand_name, d.NetAmount AS line_amount
           FROM SalesDocumentLine d
           JOIN Product i ON d.ProductId = i.ProductId
         ) x
         GROUP BY x.brand_nam`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['SalesDocumentLine', 'Product'] },
        }
      ),
    /unknown column "brand_nam"/
  );
});

test('validateReadOnlySql enforces join relationships for simple derived table columns', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT x.CustomerId, SUM(v.NetAmount) AS total_net_amount
         FROM (
           SELECT c.CustomerId
           FROM Customer c
         ) x
         JOIN SalesDocument v ON x.CustomerId = v.SalesDocumentId
         GROUP BY x.CustomerId`,
        allowedTables(prompt),
        {
          promptContext: prompt.context,
          response: { tables_used: ['Customer', 'SalesDocument'] },
        }
      ),
    /Customer\.CustomerId to SalesDocument\.SalesDocumentId/
  );
});

test('validateReadOnlySql accepts valid joins through simple derived table columns', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');
  const validated = validateReadOnlySql(
    `SELECT x.CustomerId, SUM(v.NetAmount) AS total_net_amount
     FROM (
       SELECT c.CustomerId
       FROM Customer c
     ) x
     JOIN SalesDocument v ON x.CustomerId = v.CustomerId
     GROUP BY x.CustomerId`,
    allowedTables(prompt),
    {
      promptContext: prompt.context,
      response: { tables_used: ['Customer', 'SalesDocument'] },
    }
  );

  assert.ok(
    validated.guardrails.joinChecks.some(
      (join) => join.leftTable === 'Customer' && join.rightColumn === 'CustomerId'
    )
  );
});
