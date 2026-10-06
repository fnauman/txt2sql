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

test('an implicit alias before ORDER BY is known there; other names in ORDER BY are not', () => {
  // The accepted forms are in test/sql-valid-unusual.test.js; here the alias
  // is known (the rejection names the stray name, not TotalCount).
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');
  assert.throws(
    () =>
      validateReadOnlySql('SELECT (SELECT COUNT(*) FROM Customer x) TotalCount ORDER BY TotalCount, CustomerRank', allowedTables(prompt), {
        promptContext: prompt.context,
      }),
    (error) => error.code === 'UNKNOWN_IDENTIFIER' && /"CustomerRank"/.test(error.message)
  );
});

test('an implicit alias after WITHIN GROUP (...) OVER () is known; other names are not', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');
  const run = (sql) => () => validateReadOnlySql(sql, allowedTables(prompt), { promptContext: prompt.context });
  const median = 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.NetAmount) OVER ()';
  assert.throws(
    run(`SELECT d.SalesDocumentId, ${median} MedianNet FROM SalesDocument d ORDER BY MedianNet, CustomerRank`),
    (error) => error.code === 'UNKNOWN_IDENTIFIER' && /"CustomerRank"/.test(error.message)
  );
});

test('guardrail rejections carry error.code and error.layer', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'Who are our biggest buyers in March 2026?');
  const cases = [
    ['SELECT c.CustomerDisplayName FROM Customer c', 'UNKNOWN_COLUMN'],
    ['SELECT x.CustomerName FROM Customer c', 'UNKNOWN_TABLE_ALIAS'],
    ['SELECT CustomerDisplayName FROM Customer', 'UNKNOWN_IDENTIFIER'],
    // Still unknown after the output-alias fix: not an alias, a reference.
    ['SELECT c.CustomerName FROM Customer c WHERE CustomerDisplayName = 1', 'UNKNOWN_IDENTIFIER'],
    ['SELECT `Customer Display` FROM Customer', 'UNKNOWN_IDENTIFIER'],
    ['SELECT c.CustomerName AS shown FROM Customer c ORDER BY CustomerRank', 'UNKNOWN_IDENTIFIER'],
    // An implicit alias exists only at the end of a select item: a stray
    // identifier after a literal in WHERE or after OFFSET is not one.
    ["SELECT c.CustomerName FROM Customer c WHERE c.CustomerName = 'x' CustomerDisplay", 'UNKNOWN_IDENTIFIER'],
    ['SELECT c.CustomerName FROM Customer c ORDER BY c.CustomerName LIMIT 5 OFFSET 0 CustomerRank', 'UNKNOWN_IDENTIFIER'],
    // The name after an operator word is an operand, not an alias.
    ['SELECT c.CustomerId DIV CustomerRank FROM Customer c', 'UNKNOWN_IDENTIFIER'],
    ['SELECT (SELECT MAX(x.CustomerId) FROM Customer x) MOD CustomerRank ORDER BY 1', 'UNKNOWN_IDENTIFIER'],
    // The name after a SELECT modifier (DISTINCTROW, SQL_NO_CACHE, ...) is the
    // first select item, not an alias, also before LIMIT / ORDER BY.
    ['SELECT c.CustomerId FROM Customer c WHERE c.CustomerId = (SELECT DISTINCTROW CustomerKey LIMIT 1)', 'UNKNOWN_IDENTIFIER'],
    ['SELECT c.CustomerId FROM Customer c WHERE c.CustomerId IN (SELECT DISTINCTROW CustomerRank ORDER BY 1)', 'UNKNOWN_IDENTIFIER'],
    ['SELECT c.CustomerId, (SELECT SQL_NO_CACHE CustomerRank LIMIT 1) FROM Customer c', 'UNKNOWN_IDENTIFIER'],
    ['SELECT DISTINCTROW CustomerRank FROM Customer', 'UNKNOWN_IDENTIFIER'],
    ['SELECT HIGH_PRIORITY STRAIGHT_JOIN CustomerRank FROM Customer', 'UNKNOWN_IDENTIFIER'],
    [
      'SELECT c.CustomerName, SUM(v.NetAmount) AS total FROM SalesDocument v JOIN Customer c ON v.SalesDocumentId = c.CustomerId GROUP BY c.CustomerName',
      'JOIN_PATH',
    ],
    [
      'SELECT c.CustomerName, SUM(v.BillTotalAmount) AS total FROM SalesDocument v JOIN Customer c ON v.CustomerId = c.CustomerId GROUP BY c.CustomerName',
      'METRIC_COLUMN',
    ],
  ];

  for (const [sql, code] of cases) {
    assert.throws(
      () => validateReadOnlySql(sql, allowedTables(prompt), { promptContext: prompt.context }),
      (error) => error.code === code && error.layer === 'guardrail',
      code
    );
  }

  const sparkling = buildSparklingWaterSalesPrompt();
  assert.throws(
    () =>
      validateReadOnlySql('SELECT SUM(d.NetAmount) AS total FROM SalesDocumentLine d WHERE d.ProductId = 999', allowedTables(sparkling), {
        promptContext: sparkling.context,
      }),
    (error) => error.code === 'MASTER_DATA_ID' && error.layer === 'guardrail'
  );
});

test('validateReadOnlySql resolves qualified CTE references through both layers', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'List customers');
  const validated = validateReadOnlySql(
    `WITH FirstCustomers AS (SELECT c.CustomerId, c.CustomerName FROM Customer c),
     Named (Id, Label) AS (SELECT fc.CustomerId, fc.CustomerName FROM FirstCustomers fc)
     SELECT n.Label, FirstCustomers.CustomerId FROM Named n JOIN FirstCustomers ON FirstCustomers.CustomerId = n.Id`,
    allowedTables(prompt),
    { promptContext: prompt.context, response: { tables_used: ['Customer'] } }
  );

  assert.deepEqual(validated.tablesUsed, ['Customer']);
  assert.ok(validated.guardrails.columnChecks.qualifiedColumns.some((column) => column.qualifier === 'n' && column.columnName === 'Label'));

  assert.throws(
    () =>
      validateReadOnlySql(
        'WITH fc AS (SELECT c.CustomerId FROM Customer c) SELECT fc.CustomerName FROM fc',
        allowedTables(prompt),
        { promptContext: prompt.context }
      ),
    (error) => error.code === 'UNKNOWN_COLUMN' && /"CustomerName"/.test(error.message)
  );
});

test('qualifiers resolve in their own SELECT scope, the way MariaDB resolves them', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'List customers');
  const validate = (sql) => validateReadOnlySql(sql, allowedTables(prompt), { promptContext: prompt.context });

  // The CTE's `d` (SalesDocument) and the outer `d` (Customer) do not collide.
  const scoped = validate(
    'WITH t AS (SELECT d.CustomerId, SUM(d.NetAmount) AS net FROM SalesDocument d GROUP BY d.CustomerId) SELECT d.CustomerName, t.net FROM t JOIN Customer d ON d.CustomerId = t.CustomerId'
  );
  assert.deepEqual(
    scoped.guardrails.columnChecks.qualifiedColumns.map(({ tableName, columnName }) => `${tableName}.${columnName}`).slice(0, 3),
    ['SalesDocument.CustomerId', 'SalesDocument.NetAmount', 'SalesDocument.CustomerId']
  );
  assert.ok(scoped.guardrails.columnChecks.qualifiedColumns.some((column) => column.tableName === 'Customer' && column.columnName === 'CustomerName'));

  // Each of these fails on MariaDB 10.6 with "Unknown column": a CTE or derived
  // body cannot see outer or sibling aliases, UNION branches do not share FROM
  // clauses, aliases are case-sensitive, an aliased table is no longer
  // reachable by its name, and a CTE is qualified by its FROM spelling.
  for (const [sql, qualifier] of [
    ['WITH x AS (SELECT d.CustomerId FROM SalesDocument d WHERE d.CustomerId = c.CustomerId) SELECT 1 FROM x JOIN Customer c ON c.CustomerId = x.CustomerId', 'c'],
    ['SELECT 1 FROM Customer c JOIN (SELECT d.CustomerId FROM SalesDocument d WHERE d.CustomerId = c.CustomerId) x ON x.CustomerId = c.CustomerId', 'c'],
    ['SELECT c.CustomerId FROM Customer c WHERE EXISTS (SELECT 1 FROM (SELECT d.CustomerId FROM SalesDocument d WHERE d.CustomerId = c.CustomerId) x)', 'c'],
    ['SELECT c.CustomerId FROM Customer c UNION SELECT c.CustomerId FROM SalesDocument d', 'c'],
    ['SELECT D.CustomerId FROM SalesDocument d', 'D'],
    ['SELECT SalesDocument.CustomerId FROM SalesDocument d', 'SalesDocument'],
    ['SELECT Customer.CustomerName FROM SalesDocument d', 'Customer'],
    ['WITH x AS (SELECT CustomerId FROM Customer) SELECT x.CustomerId FROM X', 'x'],
    ['WITH x AS (SELECT CustomerId FROM Customer) SELECT X.CustomerId FROM x', 'X'],
    ['WITH x AS (SELECT CustomerId FROM Customer) SELECT x.CustomerId FROM x y', 'x'],
  ]) {
    assert.throws(
      () => validate(sql),
      (error) => error.code === 'UNKNOWN_TABLE_ALIAS' && error.message.includes(`"${qualifier}"`),
      sql
    );
  }
});

test('CTE bodies see earlier CTEs: stars expand from their columns and lineage carries forward', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'List customers');
  const validate = (sql) => validateReadOnlySql(sql, allowedTables(prompt), { promptContext: prompt.context });
  const CHAIN = 'WITH c1 AS (SELECT c.CustomerId FROM Customer c), c2 AS (SELECT c1.* FROM c1), c3 AS (SELECT * FROM c2)';

  // The join through two star copies is checked against Customer.CustomerId.
  const joined = validate(`${CHAIN} SELECT c3.CustomerId, d.NetAmount FROM c3 JOIN SalesDocument d ON d.CustomerId = c3.CustomerId`);
  assert.deepEqual(
    joined.guardrails.joinChecks.map(({ leftTable, leftColumn, rightTable, rightColumn }) => `${leftTable}.${leftColumn}=${rightTable}.${rightColumn}`),
    ['SalesDocument.CustomerId=Customer.CustomerId']
  );
  assert.throws(
    () => validate(`${CHAIN} SELECT c3.CustomerId FROM c3 JOIN SalesDocument d ON d.SalesDocumentId = c3.CustomerId`),
    (error) => error.code === 'JOIN_PATH' && /SalesDocument\.SalesDocumentId to Customer\.CustomerId/.test(error.message)
  );
  // Only the projected columns exist on the copies.
  assert.throws(
    () => validate(`${CHAIN} SELECT c3.CustomerName FROM c3`),
    (error) => error.code === 'UNKNOWN_COLUMN' && /"CustomerName" on derived table or CTE "c3"/.test(error.message)
  );

  // Computed columns survive a star copy and a column list renames them.
  assert.doesNotThrow(() =>
    validate('WITH a AS (SELECT CustomerId, SUM(NetAmount) AS net FROM SalesDocument GROUP BY CustomerId), b AS (SELECT * FROM a) SELECT b.net, b.CustomerId FROM b')
  );
  assert.doesNotThrow(() =>
    validate('WITH a AS (SELECT CustomerId, SUM(NetAmount) AS net FROM SalesDocument GROUP BY CustomerId), b (id, total) AS (SELECT a.* FROM a) SELECT b.total, b.id FROM b')
  );
  assert.throws(
    () => validate('WITH a AS (SELECT CustomerId, SUM(NetAmount) AS net FROM SalesDocument GROUP BY CustomerId), b (id, total) AS (SELECT a.* FROM a) SELECT b.net FROM b'),
    (error) => error.code === 'UNKNOWN_COLUMN'
  );
});

test('the ProductId candidate check ignores numbers inside IN (SELECT ...) subqueries', () => {
  const prompt = buildSparklingWaterSalesPrompt();
  const validated = validateReadOnlySql(
    `SELECT SUM(d.NetAmount) AS total_net_amount
     FROM SalesDocumentLine d
     WHERE d.ProductId = 101
       AND d.ProductId IN (SELECT d2.ProductId FROM SalesDocumentLine d2 WHERE d2.SalesDocumentLineId > 10)`,
    allowedTables(prompt),
    { promptContext: prompt.context }
  );
  assert.deepEqual(validated.guardrails.masterDataChecks.referencedIds, [101]);
});

test('validateSqlGuardrails rejects header amounts summed across a line join (fan-out)', () => {
  const prompt = buildOptimizedPrompt(createGuardrailSchema(), 'product sales by brand');

  assert.throws(
    () =>
      validateReadOnlySql(
        `SELECT i.ProductName, SUM(v.NetAmount) AS total_net_amount
         FROM SalesDocument v
         JOIN SalesDocumentLine d ON d.SalesDocumentId = v.SalesDocumentId
         JOIN Product i ON d.ProductId = i.ProductId
         GROUP BY i.ProductName`,
        allowedTables(prompt),
        { promptContext: prompt.context }
      ),
    (error) => error.code === 'FAN_OUT' && /Use SalesDocumentLine\.NetAmount/.test(error.message)
  );
});
