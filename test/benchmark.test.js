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
  loadBenchmarkDataset,
  normalizeBenchmarkCase,
  runSignalChecks,
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

test('findDisallowedColumnsUsed escapes regex characters in column names', () => {
  const used = findDisallowedColumnsUsed(
    'SELECT `SalesDocumentNet.Amount`, SafeColumn FROM ExampleTable',
    ['SalesDocumentNet.Amount', 'Other[Column]']
  );

  assert.deepEqual(used, ['SalesDocumentNet.Amount']);
});

test('classifyBenchmarkStatus distinguishes retrieval misses and low-signal successes', () => {
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
    'low_signal_success'
  );
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
