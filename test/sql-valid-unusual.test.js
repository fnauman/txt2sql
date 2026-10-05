import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOptimizedPrompt, buildSemanticPlan, validateReadOnlySql } from '../src/pipeline.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// Valid, read-only MariaDB SQL that the old regex validators falsely rejected
// (or that is easy to break again): EXTRACT/TRIM ... FROM, CTE chains, window
// functions, derived tables, CASE, comma joins, and string literals containing
// SQL keywords or comment markers. Every query here was executed successfully
// against the seeded demo database. Each must pass both the basic path and the
// optimized path with the real prompt context of a matching question.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Compiled in memory from the models, so tests never write generated/schema.json.
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const ALL_TABLES = schema.tables.map((table) => table.tableName);

const promptCache = new Map();
function buildRealPrompt(question) {
  if (!promptCache.has(question)) {
    const prompt = buildOptimizedPrompt(schema, question, { semanticPlan: buildSemanticPlan(question) });
    promptCache.set(question, { promptContext: prompt.context, allowedTables: prompt.tables.map((table) => table.tableName) });
  }
  return promptCache.get(question);
}

const Q_NET = 'What were net sales by customer in March 2026?';
const Q_CUST = 'Show the top customers by total net sales amount in March 2026.';
const Q_QTY = 'Which products sold the most quantity in March 2026?';
const Q_LIST = 'List all customer names.';
// Metric-free question whose prompt context has the document, line and product
// tables, for shapes that are about structure rather than a measure.
const Q_LINES = 'List sales documents with their product lines.';
const Q_POSTINGS = 'How many non-canceled sales documents do not have any accounting postings?';
const JOIN_CUSTOMER = 'FROM SalesDocument d JOIN Customer c ON c.CustomerId = d.CustomerId';

const VALID = [
  [
    Q_CUST,
    'EXTRACT(MONTH FROM ...)',
    "SELECT EXTRACT(MONTH FROM d.DocumentDate) AS month_no, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocument d WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY EXTRACT(MONTH FROM d.DocumentDate)",
  ],
  [Q_NET, "TRIM(LEADING 'The ' FROM ...)", `SELECT TRIM(LEADING 'The ' FROM c.CustomerName) AS n, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY n`],
  [Q_NET, "TRIM(LEADING '0' FROM ...)", "SELECT TRIM(LEADING '0' FROM d.DocumentNo) AS doc, SUM(d.NetAmount) AS net FROM SalesDocument d GROUP BY doc"],
  [Q_NET, 'SUBSTRING(x FROM 1 FOR 3)', `SELECT SUBSTRING(c.CustomerName FROM 1 FOR 3) AS p, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY p`],
  [
    Q_CUST,
    'CTE chain selecting FROM CTEs',
    "WITH march AS (SELECT d.CustomerId, d.NetAmount FROM SalesDocument d WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'), totals AS (SELECT CustomerId, SUM(COALESCE(NetAmount, 0)) AS net FROM march GROUP BY CustomerId) SELECT c.CustomerName, ROUND(t.net, 2) AS total_net_amount FROM totals t JOIN Customer c ON t.CustomerId = c.CustomerId ORDER BY t.net DESC, c.CustomerName ASC LIMIT 10",
  ],
  [
    Q_CUST,
    'CTE with a column list',
    'WITH m (CustomerId, Net) AS (SELECT d.CustomerId, SUM(COALESCE(d.NetAmount, 0)) FROM SalesDocument d GROUP BY d.CustomerId) SELECT c.CustomerName, ROUND(m.Net, 2) AS total_net_amount FROM m JOIN Customer c ON m.CustomerId = c.CustomerId LIMIT 10',
  ],
  [Q_LIST, 'simple CTE', 'WITH x AS (SELECT CustomerId FROM Customer) SELECT COUNT(*) AS n FROM x'],
  // Star columns of a CTE chain come from the earlier CTE's projection.
  [Q_LIST, 'CTE chain copying an earlier CTE with q.*', 'WITH c1 AS (SELECT c.CustomerId FROM Customer c), c2 AS (SELECT c1.* FROM c1) SELECT c2.CustomerId FROM c2'],
  [
    Q_CUST,
    'CTE chain copying an aggregate CTE with *',
    'WITH a AS (SELECT CustomerId, SUM(NetAmount) AS net FROM SalesDocument GROUP BY CustomerId), b AS (SELECT * FROM a) SELECT b.net FROM b',
  ],
  [
    Q_CUST,
    'derived table over a CTE, star and string alias',
    "WITH a AS (SELECT d.CustomerId, SUM(d.NetAmount) AS 'net' FROM SalesDocument d GROUP BY d.CustomerId) SELECT c.CustomerName, x.net FROM (SELECT * FROM a) x JOIN Customer c ON c.CustomerId = x.CustomerId",
  ],
  // A string alias needs no AS, and column names (of CTEs and tables alike) are case-insensitive.
  [Q_CUST, 'CTE column with a string alias without AS', "WITH a AS (SELECT CustomerId, SUM(NetAmount) 'net' FROM SalesDocument GROUP BY CustomerId) SELECT a.net FROM a"],
  [Q_CUST, 'CTE columns referenced in another case', 'WITH a AS (SELECT CustomerId, SUM(NetAmount) AS net FROM SalesDocument GROUP BY CustomerId) SELECT a.NET, a.customerid FROM a'],
  [Q_NET, 'table columns and join keys in another case', 'SELECT c.customername, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN Customer c ON c.customerid = d.CUSTOMERID GROUP BY c.customername'],
  [Q_LINES, 'derived column named by a keyword alias without AS', 'SELECT x.year FROM (SELECT YEAR(d.DocumentDate) year FROM SalesDocument d) x'],
  // MariaDB resolves CTE names case-insensitively; qualifiers follow the FROM spelling.
  [Q_LIST, 'CTE referenced in another case', 'WITH x AS (SELECT CustomerId FROM Customer) SELECT COUNT(*) AS n FROM X'],
  [Q_LIST, 'CTE columns qualified by the FROM spelling', 'WITH x AS (SELECT CustomerId FROM Customer) SELECT X.CustomerId FROM X'],
  [Q_LIST, 'CTE referenced in another case with an alias', 'WITH x AS (SELECT CustomerId FROM Customer) SELECT y.CustomerId FROM X y'],
  // Aliases are scoped per SELECT: `d` is SalesDocument inside the CTE and Customer outside.
  [
    Q_CUST,
    'one alias bound to different tables in a CTE and the outer query',
    'WITH t AS (SELECT d.CustomerId, SUM(d.NetAmount) AS net FROM SalesDocument d GROUP BY d.CustomerId) SELECT d.CustomerName, t.net FROM t JOIN Customer d ON d.CustomerId = t.CustomerId',
  ],
  [
    Q_CUST,
    'a subquery alias shadowing an outer alias',
    'SELECT d.CustomerName FROM Customer d WHERE EXISTS (SELECT 1 FROM SalesDocument d WHERE d.NetAmount > 0)',
  ],
  [
    Q_CUST,
    'a correlated subquery using an outer alias',
    'SELECT c.CustomerName, (SELECT SUM(d.NetAmount) FROM SalesDocument d WHERE d.CustomerId = c.CustomerId) AS net FROM Customer c',
  ],
  [
    Q_CUST,
    'window RANK() OVER',
    `SELECT c.CustomerName, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount, RANK() OVER (ORDER BY SUM(COALESCE(d.NetAmount, 0)) DESC) AS sales_rank ${JOIN_CUSTOMER} WHERE IFNULL(d.IsCanceled, 0) = 0 GROUP BY c.CustomerId, c.CustomerName ORDER BY sales_rank, c.CustomerName LIMIT 10`,
  ],
  [
    Q_NET,
    'ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)',
    `SELECT c.CustomerName, d.DocumentNo, d.NetAmount, ROW_NUMBER() OVER (PARTITION BY d.CustomerId ORDER BY d.NetAmount DESC) AS rn ${JOIN_CUSTOMER}`,
  ],
  [
    Q_NET,
    'window function over a derived table',
    `SELECT x.CustomerName, x.net, ROW_NUMBER() OVER (ORDER BY x.net DESC) AS RowNum FROM (SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY c.CustomerName) x`,
  ],
  [
    Q_NET,
    'LAG window',
    "SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS ym, SUM(d.NetAmount) AS net, LAG(SUM(d.NetAmount)) OVER (ORDER BY DATE_FORMAT(d.DocumentDate, '%Y-%m')) AS prev FROM SalesDocument d GROUP BY ym",
  ],
  [
    Q_CUST,
    'derived table + CASE bucket',
    "SELECT CASE WHEN t.net >= 1000 THEN 'large' ELSE 'small' END AS bucket, COUNT(*) AS customer_count FROM (SELECT d.CustomerId, SUM(COALESCE(d.NetAmount, 0)) AS net FROM SalesDocument d WHERE IFNULL(d.IsCanceled, 0) = 0 GROUP BY d.CustomerId) t GROUP BY bucket",
  ],
  [Q_NET, 'CASE inside SUM', `SELECT c.CustomerName, SUM(CASE WHEN d.DocumentDate < '2026-03-15' THEN d.NetAmount ELSE 0 END) AS first_half ${JOIN_CUSTOMER} GROUP BY c.CustomerName`],
  [
    Q_QTY,
    'correlated NOT EXISTS',
    "SELECT p.ProductName, ROUND(SUM(COALESCE(l.Quantity, 0)), 3) AS total_qty FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId WHERE d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' AND NOT EXISTS (SELECT 1 FROM SalesDocumentLine l2 JOIN SalesDocument d2 ON l2.SalesDocumentId = d2.SalesDocumentId WHERE l2.ProductId = p.ProductId AND d2.DocumentDate >= '2026-02-01' AND d2.DocumentDate < '2026-03-01') GROUP BY p.ProductId, p.ProductName ORDER BY SUM(COALESCE(l.Quantity, 0)) DESC LIMIT 10",
  ],
  [Q_QTY, 'unqualified columns on one table', 'SELECT ProductId, ROUND(SUM(COALESCE(Quantity, 0)), 3) AS total_qty FROM SalesDocumentLine GROUP BY ProductId ORDER BY total_qty DESC LIMIT 10'],
  [Q_NET, 'comma join with aliases', 'SELECT c.CustomerName, SUM(d.NetAmount) AS net FROM SalesDocument d, Customer c WHERE d.CustomerId = c.CustomerId GROUP BY c.CustomerName'],
  [
    Q_NET,
    'comma join without aliases',
    'SELECT Customer.CustomerName, SUM(SalesDocument.NetAmount) AS net FROM SalesDocument, Customer WHERE SalesDocument.CustomerId = Customer.CustomerId GROUP BY Customer.CustomerName',
  ],
  [Q_NET, "literal 'Fresh from Farm'", `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} WHERE c.CustomerName <> 'Fresh from Farm' GROUP BY c.CustomerName`],
  [Q_NET, 'double-quoted literal with "from"', `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} WHERE c.CustomerName <> "Fresh from Farm" GROUP BY c.CustomerName`],
  [Q_NET, "LIKE '%join Club%'", `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} WHERE c.CustomerName LIKE '%join Club%' GROUP BY c.CustomerName`],
  [
    Q_NET,
    'literals containing update/drop/delete',
    `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} WHERE c.CustomerName NOT IN ('Update Store', 'drop zone', 'please DELETE this; DROP it') GROUP BY c.CustomerName`,
  ],
  [
    Q_NET,
    'literals containing --, #, /*, /*!, @ and doubled quotes',
    `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} WHERE c.CustomerName NOT IN ('A--B', 'x -- y', '#1 shop', '/* deal */', '/*!x', '@home', 'it''s') GROUP BY c.CustomerName`,
  ],
  [
    Q_NET,
    'backtick-quoted identifiers',
    'SELECT `c`.`CustomerName`, SUM(`d`.`NetAmount`) AS `net` FROM `SalesDocument` `d` JOIN `Customer` `c` ON `c`.`CustomerId` = `d`.`CustomerId` GROUP BY `c`.`CustomerName`',
  ],
  [Q_NET, 'REPLACE() string function', `SELECT REPLACE(c.CustomerName, ' Market', '') AS customer, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY customer`],
  [Q_NET, 'INSERT() string function', `SELECT INSERT(c.CustomerName, 1, 0, '* ') AS customer, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY customer`],
  [Q_NET, 'CAST ... CHARACTER SET', `SELECT CAST(c.CustomerName AS CHAR CHARACTER SET utf8mb4) AS customer, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY customer`],
  [Q_NET, 'GROUP_CONCAT ... SEPARATOR', `SELECT GROUP_CONCAT(c.CustomerName ORDER BY c.CustomerName SEPARATOR ', ') AS names, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER}`],
  [Q_LIST, 'FROM DUAL', 'SELECT 1 AS one FROM DUAL'],
  [Q_NET, 'UNION ALL', "SELECT 'doc' AS src, SUM(d.NetAmount) AS net FROM SalesDocument d UNION ALL SELECT 'cust' AS src, COUNT(*) AS net FROM Customer c"],
  [Q_NET, 'JOIN ... USING', 'SELECT c.CustomerName, SUM(d.NetAmount) AS net FROM SalesDocument d JOIN Customer c USING (CustomerId) GROUP BY c.CustomerName'],
  [Q_NET, 'uppercase aliases', 'SELECT C.CustomerName, SUM(D.NetAmount) AS net FROM SalesDocument D JOIN Customer C ON C.CustomerId = D.CustomerId GROUP BY C.CustomerName'],
  [
    Q_NET,
    'HAVING + IN subquery',
    `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} WHERE d.CustomerId IN (SELECT d3.CustomerId FROM SalesDocument d3 WHERE d3.IsCanceled = 0) GROUP BY c.CustomerName HAVING SUM(d.NetAmount) > 0`,
  ],
  [Q_NET, 'share-of-total scalar subquery', `SELECT c.CustomerName, SUM(d.NetAmount) / (SELECT SUM(d2.NetAmount) FROM SalesDocument d2) AS share ${JOIN_CUSTOMER} GROUP BY c.CustomerName`],
  [Q_NET, 'lowercase keywords', 'select c.CustomerName, sum(d.NetAmount) as net from SalesDocument d join Customer c on c.CustomerId = d.CustomerId group by c.CustomerName'],
  [Q_NET, 'GROUP BY ... WITH ROLLUP', `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY c.CustomerName WITH ROLLUP`],
  [Q_NET, 'single trailing semicolon', `SELECT c.CustomerName, SUM(d.NetAmount) AS net ${JOIN_CUSTOMER} GROUP BY c.CustomerName;`],
  [Q_NET, 'derived table selecting *', 'SELECT x.CustomerName, SUM(d.NetAmount) AS net FROM (SELECT * FROM Customer) x JOIN SalesDocument d ON d.CustomerId = x.CustomerId GROUP BY x.CustomerName'],
  // Header-grain sums that do NOT fan out.
  [
    Q_POSTINGS,
    'header SUM with an anti-joined child (LEFT JOIN ... IS NULL)',
    'SELECT COUNT(*) AS document_count, ROUND(SUM(d.NetAmount), 2) AS total_net_amount FROM SalesDocument d LEFT JOIN AccountingPosting p ON p.SalesDocumentId = d.SalesDocumentId WHERE p.AccountingPostingId IS NULL',
  ],
  [
    Q_QTY,
    'line-grain expression',
    'SELECT p.ProductName, SUM(l.Quantity * l.SalePrice) AS revenue, SUM(l.NetAmount) AS net, SUM(l.Quantity) AS qty FROM SalesDocumentLine l JOIN SalesDocument d ON d.SalesDocumentId = l.SalesDocumentId JOIN Product p ON p.ProductId = l.ProductId GROUP BY p.ProductName',
  ],
  [
    Q_LINES,
    'header SUM filtered through EXISTS',
    "SELECT ROUND(SUM(d.NetAmount), 2) AS total_net_amount FROM SalesDocument d WHERE EXISTS (SELECT 1 FROM SalesDocumentLine l JOIN Product p ON p.ProductId = l.ProductId WHERE l.SalesDocumentId = d.SalesDocumentId AND p.ProductName LIKE '%Water%')",
  ],
  [
    Q_LINES,
    'header SUM joined to a pre-aggregated child',
    'SELECT ROUND(SUM(d.NetAmount), 2) AS total_net_amount, SUM(x.qty) AS total_qty FROM SalesDocument d JOIN (SELECT l.SalesDocumentId, SUM(l.Quantity) AS qty FROM SalesDocumentLine l GROUP BY l.SalesDocumentId) x ON x.SalesDocumentId = d.SalesDocumentId',
  ],
  [
    Q_LINES,
    'header SUM with a child pre-filtered by DISTINCT',
    'SELECT ROUND(SUM(d.NetAmount), 2) AS total_net_amount FROM SalesDocument d JOIN (SELECT DISTINCT l.SalesDocumentId FROM SalesDocumentLine l WHERE l.Quantity > 1) x ON x.SalesDocumentId = d.SalesDocumentId',
  ],
  [
    Q_LINES,
    'header SUM next to line totals pre-aggregated per document in a CTE',
    'WITH line_totals AS (SELECT SalesDocumentId, SUM(NetAmount) AS line_net FROM SalesDocumentLine GROUP BY SalesDocumentId) SELECT SUM(d.NetAmount) AS header_net, SUM(t.line_net) AS line_net FROM SalesDocument d JOIN line_totals t ON t.SalesDocumentId = d.SalesDocumentId',
  ],
  [
    Q_LINES,
    'distinct child keys first in FROM, joined by the header ON clause',
    'SELECT SUM(d.NetAmount) AS n FROM (SELECT DISTINCT SalesDocumentId FROM SalesDocumentLine) x JOIN SalesDocument d ON d.SalesDocumentId = x.SalesDocumentId',
  ],
  [
    Q_LINES,
    'line value scaled by a header ratio (line grain)',
    'SELECT ROUND(SUM(l.NetAmount * d.NetAmount / NULLIF(d.GrossAmount, 0)), 2) AS adjusted FROM SalesDocumentLine l JOIN SalesDocument d ON d.SalesDocumentId = l.SalesDocumentId',
  ],
  [Q_LIST, 'parenthesized UNION branches', '(SELECT CustomerName FROM Customer ORDER BY CustomerName LIMIT 2) UNION ALL (SELECT CustomerName FROM Customer LIMIT 1)'],
  [
    Q_NET,
    'mixed-case built-in functions (DateDiff, YearWeek, Round, Sum)',
    'SELECT YearWeek(d.DocumentDate) AS wk, AVG(DateDiff(d.DueDate, d.DocumentDate)) AS days, Round(Sum(d.NetAmount), 2) AS net FROM SalesDocument d GROUP BY wk',
  ],
  [Q_LIST, 'an alias named minus', 'SELECT minus.CustomerName FROM Customer minus ORDER BY minus.CustomerName'],
  [Q_LIST, 'an alias that is a non-reserved keyword', 'SELECT year.CustomerName FROM Customer year ORDER BY year.CustomerName'],
  // Positive controls of the evaluation oracle (datasets/controls) that the
  // unknown-identifier guardrail used to reject: an output alias in backticks
  // with a space was split at the space ("unknown identifier Name"), and an
  // output alias without AS was not known at all (SAFE-8).
  [
    Q_CUST,
    'backtick output aliases with spaces (control core_public_001/a5)',
    "SELECT c.CustomerName AS `Customer Name`, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS `Total Net Sales` FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY c.CustomerId, c.CustomerName ORDER BY `Total Net Sales` DESC, `Customer Name` ASC LIMIT 10",
  ],
  [
    'Show the top customers by gross amount in March 2026.',
    'CamelCase output alias without AS (control edge_public_005/a3)',
    "SELECT c.CustomerName CustomerName, ROUND(SUM(COALESCE(d.GrossAmount, 0)), 2) TotalGrossAmount FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY c.CustomerId, c.CustomerName ORDER BY TotalGrossAmount DESC LIMIT 10",
  ],
  [Q_LIST, 'implicit alias after a quoted expression', 'SELECT c.CustomerName `Display Name`, c.CustomerCode Code FROM Customer c ORDER BY `Display Name`'],
  [Q_LIST, 'WINDOW clause', 'SELECT c.CustomerName, ROW_NUMBER() OVER w AS rn FROM Customer c WINDOW w AS (ORDER BY c.CustomerName)'],
  [
    Q_LINES,
    'window SUM over a per-document MAX with a line join',
    'SELECT d.SalesDocumentId, MAX(d.NetAmount) AS amount, SUM(MAX(d.NetAmount)) OVER () AS total FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId GROUP BY d.SalesDocumentId',
  ],
  [
    Q_LINES,
    'header SUM with a child restricted to one row by its primary key',
    'SELECT SUM(d.NetAmount) FROM SalesDocument d LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId AND l.SalesDocumentLineId = 1',
  ],
  [
    Q_QTY,
    'COUNT/MAX over header columns with a line join',
    'SELECT p.ProductName, COUNT(DISTINCT d.SalesDocumentId) AS docs, MAX(d.NetAmount) AS biggest, SUM(l.Quantity) AS qty FROM SalesDocumentLine l JOIN SalesDocument d ON d.SalesDocumentId = l.SalesDocumentId JOIN Product p ON p.ProductId = l.ProductId GROUP BY p.ProductName',
  ],
];

for (const [question, label, sql] of VALID) {
  test(`accepts valid SQL: ${label}`, () => {
    const basic = validateReadOnlySql(sql, ALL_TABLES);
    assert.equal(basic.statementCount, 1);

    const { promptContext, allowedTables } = buildRealPrompt(question);
    const optimized = validateReadOnlySql(sql, allowedTables, { promptContext });
    assert.ok(optimized.guardrails, 'optimized path should run the guardrail layer');
  });
}

test('CTE names never reach tablesUsed; the tables inside CTE bodies do', () => {
  const { allowedTables, promptContext } = buildRealPrompt(Q_CUST);
  const result = validateReadOnlySql(VALID.find(([, label]) => label === 'CTE chain selecting FROM CTEs')[2], allowedTables, {
    promptContext,
    // A model that lists its CTE names in tables_used is not claiming extra tables.
    response: { tables_used: ['SalesDocument', 'Customer', 'march', 'totals'] },
  });
  assert.deepEqual(result.tablesUsed, ['SalesDocument', 'Customer']);
  assert.deepEqual(result.guardrails.responseTableChecks.declaredTables, ['SalesDocument', 'Customer']);

  // CTE names are case-insensitive, so a differently cased CTE name is dropped too.
  const recased = validateReadOnlySql(VALID.find(([, label]) => label === 'CTE chain selecting FROM CTEs')[2], allowedTables, {
    promptContext,
    response: { tables_used: ['SalesDocument', 'Customer', 'MARCH', 'Totals'] },
  });
  assert.deepEqual(recased.guardrails.responseTableChecks.declaredTables, ['SalesDocument', 'Customer']);
});

test('a CTE that shadows the table it reads keeps that table in tables_used', () => {
  // The CTE body reads the physical Customer table (a CTE is not visible inside
  // its own definition); the outer query reads the CTE. Runs on MariaDB 10.6.
  const { allowedTables, promptContext } = buildRealPrompt(Q_LIST);
  const sql = 'WITH Customer AS (SELECT CustomerId FROM Customer) SELECT COUNT(*) AS n FROM Customer';
  const result = validateReadOnlySql(sql, allowedTables, { promptContext, response: { tables_used: ['Customer'] } });
  assert.deepEqual(result.tablesUsed, ['Customer']);
  assert.deepEqual(result.guardrails.responseTableChecks.declaredTables, ['Customer']);

  // Omitting the physical table is still an incomplete declaration.
  assert.throws(
    () => validateReadOnlySql(sql, allowedTables, { promptContext, response: { tables_used: [] } }),
    (error) => error.code === 'RESPONSE_TABLES' && /omitted SQL table\(s\): Customer/.test(error.message)
  );
});
