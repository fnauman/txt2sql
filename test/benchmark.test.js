import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  classifyBenchmarkStatus,
  createBenchmarkRunPaths,
  findDisallowedColumnsUsed,
  listGoldVariants,
  loadBenchmarkDataset,
  normalizeBenchmarkCase,
  resolveExpectedRowCount,
  runSignalChecks,
  runSignalChecksThroughAssignment,
} from '../src/benchmark.js';

const execFileAsync = promisify(execFile);

test('normalizeBenchmarkCase backfills intent and expected table metadata', () => {
  const normalized = normalizeBenchmarkCase({
    id: 21,
    question: 'List customers',
    expected_sql: 'SELECT CustomerName FROM Customer',
    tags: ['customer', 'customer'],
  });

  assert.equal(normalized.id, '21');
  assert.equal(normalized.intentId, '21');
  assert.equal(normalized.canonicalQuestion, 'List customers');
  assert.deepEqual(normalized.tags, ['customer']);
  assert.deepEqual(normalized.expected_tables, ['Customer']);
  assert.deepEqual(normalized.expected_columns, []);
  assert.equal(normalized.signal_checks, null);
});

test('loadBenchmarkDataset filters by case id and tag', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'text-to-sql-dataset-'));
  const datasetPath = path.join(tmpDir, 'demo.json');

  await fs.writeFile(
    datasetPath,
    JSON.stringify([
      {
        id: 'alpha',
        intentId: 'alpha_intent',
        question: 'Alpha question',
        expected_sql: 'SELECT 1 FROM Customer',
        tags: ['customer'],
      },
      {
        id: 'beta',
        intentId: 'beta_intent',
        question: 'Beta question',
        expected_sql: 'SELECT 1 FROM SalesDocument',
        tags: ['document'],
      },
    ]),
    'utf8'
  );

  const filtered = await loadBenchmarkDataset({
    datasetName: 'demo',
    datasetPath,
    caseId: 'beta',
    tag: 'document',
  });

  assert.equal(filtered.datasetName, 'demo');
  assert.equal(filtered.totalCases, 2);
  assert.equal(filtered.cases.length, 1);
  assert.equal(filtered.cases[0].id, 'beta');
  assert.equal(filtered.filters.caseId, 'beta');
  assert.equal(filtered.filters.tag, 'document');
});

test('runSignalChecks catches all-zero metrics and null display columns', () => {
  const result = runSignalChecks(
    [
      { CustomerName: 'Acme', total_net_amount: 0 },
      { CustomerName: null, total_net_amount: 0 },
    ],
    {
      min_row_count: 2,
      require_nonzero_columns: ['total_net_amount'],
      require_nonnull_columns: ['CustomerName'],
      min_distinct_counts: {
        CustomerName: 2,
      },
    }
  );

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code).sort(),
    ['min_distinct_counts', 'require_nonnull_columns', 'require_nonzero_columns']
  );
});

test('runSignalChecks reports a single empty-result failure when only column checks are configured', () => {
  const result = runSignalChecks([], {
    require_nonzero_columns: ['total_net_amount'],
    require_nonnull_columns: ['CustomerName'],
    min_distinct_counts: {
      CustomerName: 2,
    },
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    {
      code: 'empty_result_set',
      actual: 0,
      message: 'Signal checks could not be validated because the result set is empty.',
    },
  ]);
});

test('findDisallowedColumnsUsed still matches an identifier spelled exactly like the entry', () => {
  const used = findDisallowedColumnsUsed(
    'SELECT `SalesDocumentNet.Amount`, SafeColumn FROM ExampleTable',
    ['SalesDocumentNet.Amount', 'Other[Column]']
  );

  assert.deepEqual(used, ['SalesDocumentNet.Amount']);
});

// Behavior change (ORACLE-8): the lint used to be a regex over the raw text,
// so comments, string literals and `AS` aliases triggered it while a table
// alias (`d.CampaignId`) hid a qualified entry. It now reads tokens.
test('findDisallowedColumnsUsed ignores comments, strings and alias definitions', () => {
  assert.deepEqual(findDisallowedColumnsUsed('SELECT 1 AS x /* not NetPayableAmount */ FROM SalesDocument', ['NetPayableAmount']), []);
  assert.deepEqual(findDisallowedColumnsUsed("SELECT 'NetPayableAmount' AS label FROM SalesDocument", ['NetPayableAmount']), []);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(d.NetAmount) AS NetPayableAmount FROM SalesDocument d', ['NetPayableAmount']), []);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(d.netpayableamount) FROM SalesDocument d', ['NetPayableAmount']), ['NetPayableAmount']);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(`NetPayableAmount`) FROM SalesDocument', ['NetPayableAmount']), ['NetPayableAmount']);
});

test('findDisallowedColumnsUsed treats implicit aliases and alias references in GROUP BY / HAVING / ORDER BY as names', () => {
  const entry = ['NetPayableAmount'];
  // Alias without AS, read the way the validator reads it.
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(d.NetAmount) NetPayableAmount FROM SalesDocument d', entry), []);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(d.NetAmount) AS NetPayableAmount FROM SalesDocument d ORDER BY NetPayableAmount DESC', entry), []);
  assert.deepEqual(
    findDisallowedColumnsUsed('SELECT d.CustomerId, SUM(d.NetAmount) NetPayableAmount FROM SalesDocument d GROUP BY d.CustomerId HAVING NetPayableAmount > 0', entry),
    []
  );
  // An implicit alias before ORDER BY (a SELECT without FROM) is a name too.
  assert.deepEqual(
    findDisallowedColumnsUsed('SELECT (SELECT SUM(d.NetAmount) FROM SalesDocument d) NetPayableAmount ORDER BY NetPayableAmount', entry),
    []
  );
  // Still a use: the column itself (bare or qualified, even aliased to its own
  // name), a bare name in WHERE (aliases do not exist there), the operand of
  // an operator word, or a name that is not an alias.
  assert.deepEqual(findDisallowedColumnsUsed('SELECT d.NetAmount DIV NetPayableAmount FROM SalesDocument d', entry), entry);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT NetPayableAmount AS NetPayableAmount FROM SalesDocument', entry), entry);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT d.NetPayableAmount AS NetPayableAmount FROM SalesDocument d', entry), entry);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(d.NetAmount) AS NetPayableAmount FROM SalesDocument d WHERE NetPayableAmount > 0', entry), entry);
  assert.deepEqual(findDisallowedColumnsUsed('SELECT SUM(d.NetAmount) AS total FROM SalesDocument d ORDER BY SUM(NetPayableAmount)', entry), entry);
});

test('findDisallowedColumnsUsed resolves table aliases for qualified entries', () => {
  const entry = ['SalesDocument.CampaignId'];
  assert.deepEqual(
    findDisallowedColumnsUsed('SELECT 1 FROM SalesDocument d JOIN Campaign c ON d.CampaignId = c.CampaignId', entry),
    entry
  );
  assert.deepEqual(
    findDisallowedColumnsUsed('SELECT 1 FROM SalesDocument JOIN Campaign ON SalesDocument.CampaignId = Campaign.CampaignId', entry),
    entry
  );
  // Product.CampaignId is the right path and must not be flagged.
  assert.deepEqual(
    findDisallowedColumnsUsed(
      'SELECT 1 FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId JOIN Campaign c ON p.CampaignId = c.CampaignId',
      entry
    ),
    []
  );
  // A bare column resolves to the only referenced table...
  assert.deepEqual(findDisallowedColumnsUsed('SELECT CampaignId FROM SalesDocument', entry), entry);
  // ...or, with a schema, to the only referenced table that has it.
  const schema = {
    tables: [
      { tableName: 'SalesDocument', columns: [{ name: 'CampaignId' }, { name: 'SalesDocumentId' }] },
      { tableName: 'SalesDocumentLine', columns: [{ name: 'SalesDocumentId' }] },
    ],
  };
  const joined = 'SELECT CampaignId FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId';
  assert.deepEqual(findDisallowedColumnsUsed(joined, entry), []);
  assert.deepEqual(findDisallowedColumnsUsed(joined, entry, { schema }), entry);
});

test('findDisallowedColumnsUsed treats a table-name entry as a table reference', () => {
  assert.deepEqual(
    findDisallowedColumnsUsed('SELECT b.BrandName FROM ProductBrand pb JOIN Brand b ON pb.BrandId = b.BrandId', ['ProductBrand', 'BrandNameSnapshot']),
    ['ProductBrand']
  );
});

test('classifyBenchmarkStatus distinguishes retrieval misses; low signal is no longer a failure', () => {
  assert.equal(
    classifyBenchmarkStatus({
      rowsMatch: false,
      expectedTables: ['Customer', 'SalesDocument'],
      retrievedTables: ['Customer'],
      signalCheckResult: { passed: true },
    }),
    'retrieval_miss'
  );

  assert.equal(
    classifyBenchmarkStatus({
      rowsMatch: true,
      expectedTables: ['Customer'],
      retrievedTables: ['Customer'],
      signalCheckResult: { passed: false },
    }),
    'pass'
  );
});

test('runSignalChecksThroughAssignment resolves gold names through the comparator assignment', () => {
  const checks = {
    min_row_count: 2,
    require_nonzero_columns: ['total_net_amount'],
    require_nonnull_columns: ['CustomerName'],
    min_distinct_counts: { CustomerName: 2 },
  };
  const rows = [
    { customer: 'Acme', revenue: 10 },
    { customer: 'Beta', revenue: 5 },
  ];
  // Keyed by gold name, the renamed aliases look like empty columns.
  assert.equal(runSignalChecks(rows, checks).passed, false);
  const resolved = runSignalChecksThroughAssignment(rows, checks, { CustomerName: 'customer', total_net_amount: 'revenue' });
  assert.equal(resolved.passed, true);
  assert.deepEqual(resolved.unresolvedColumns, []);

  // Real problems still show up through the assignment.
  const zero = runSignalChecksThroughAssignment(
    rows.map((row) => ({ ...row, revenue: 0 })),
    checks,
    { CustomerName: 'customer', total_net_amount: 'revenue' }
  );
  assert.deepEqual(zero.failures.map((failure) => failure.code), ['require_nonzero_columns']);

  // Without an assignment, a column the prediction does not carry is skipped.
  const unresolved = runSignalChecksThroughAssignment(rows, checks, null);
  assert.deepEqual(unresolved.unresolvedColumns.sort(), ['CustomerName', 'total_net_amount']);
  assert.equal(unresolved.passed, true);
});

test('normalizeBenchmarkCase keeps per-fixture pins and alternative gold SQL', () => {
  const normalized = normalizeBenchmarkCase({
    id: 'x',
    question: 'q',
    expected_sql: 'SELECT 1 FROM Customer',
    alternative_expected_sql: ['SELECT 2 FROM Customer', 'SELECT 1 FROM Customer', ''],
    expected_row_counts: { seed: 1, v2: 2, v3: -1, bogus: 'x' },
    comparison: { mode: 'rowset', column_order: ['a', 'b'] },
  });
  assert.deepEqual(normalized.alternative_expected_sql, ['SELECT 2 FROM Customer']);
  assert.deepEqual(normalized.expected_row_counts, { seed: 1, v2: 2 });
  assert.deepEqual(normalized.comparison.column_order, ['a', 'b']);
  assert.equal(resolveExpectedRowCount(normalized, 'v2'), 2);
  assert.equal(resolveExpectedRowCount(normalized, 'v3'), null);
  assert.deepEqual(listGoldVariants(normalized).map((variant) => variant.label), ['expected_sql', 'alternative_expected_sql[0]']);

  // An external dataset with the older single pin: it applies to the seed only.
  const legacy = normalizeBenchmarkCase({ id: 'y', question: 'q', expected_sql: 'SELECT 1 FROM Customer', expected_row_count: 4 });
  assert.equal(resolveExpectedRowCount(legacy, 'seed'), 4);
  assert.equal(resolveExpectedRowCount(legacy, 'v2'), null);
});

test('createBenchmarkRunPaths nests report and trace outputs under dataset and model segments', () => {
  const runPaths = createBenchmarkRunPaths({
    datasetName: 'paraphrase-public',
    model: 'gpt-4o-mini',
    timestamp: '2026-04-03T10:11:12.000Z',
    outputDir: '/tmp/benchmark-output',
    traceDir: '/tmp/benchmark-traces',
  });

  assert.equal(
    runPaths.reportPath,
    path.resolve('/tmp/benchmark-output/2026-04-03T10-11-12.000Z/paraphrase-public/gpt-4o-mini/report.json')
  );
  assert.equal(
    runPaths.tracePath,
    path.resolve('/tmp/benchmark-traces/2026-04-03T10-11-12.000Z/paraphrase-public/gpt-4o-mini/trace.jsonl')
  );
});

test('debug-retrieval honors tag filtering when selecting the default dataset case', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'text-to-sql-debug-retrieval-'));
  const datasetPath = path.join(tmpDir, 'debug.json');

  await fs.writeFile(
    datasetPath,
    JSON.stringify([
      {
        id: 'alpha',
        question: 'Alpha question',
        expected_sql: 'SELECT CustomerName FROM Customer',
        tags: ['alpha'],
      },
      {
        id: 'temporal_case',
        question: 'Tagged temporal question',
        expected_sql: 'SELECT DocumentDate FROM SalesDocument',
        tags: ['temporal'],
      },
    ]),
    'utf8'
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.resolve('scripts/debug-retrieval.js'), '--dataset-file', datasetPath, '--tag', 'temporal'],
    {
      cwd: path.resolve('.'),
      maxBuffer: 1024 * 1024,
    }
  );

  assert.match(stdout, /Question: Tagged temporal question/);
  assert.match(stdout, /Source: dataset-default \(case temporal_case\)/);
});
