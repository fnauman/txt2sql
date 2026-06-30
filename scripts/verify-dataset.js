// Verify benchmark datasets against the public demo database WITHOUT calling the LLM.
//
// For every case it: executes the gold `expected_sql`, confirms the gold result
// is self-consistent under its own `comparison` spec (gold-vs-gold must match),
// and confirms the gold result satisfies its `signal_checks`. This is the guard
// that keeps the datasets rock-solid: schema/data drift that would silently
// break a gold query is caught here instead of being misread as a model failure
// during evaluation.
//
// Usage:
//   node scripts/verify-dataset.js                      # all datasets in datasets/
//   node scripts/verify-dataset.js --dataset edge-cases-public
//   node scripts/verify-dataset.js --dataset-file path/to/custom.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOptionValue, loadEnvironment } from '../src/env.js';
import {
  DEFAULT_DATASETS_DIR,
  compareResults,
  loadBenchmarkDataset,
  runSignalChecks,
} from '../src/benchmark.js';
import { createMariaDbConnection, executeReadOnlySql } from '../src/pipeline.js';

const __filename = fileURLToPath(import.meta.url);

async function resolveDatasetNames(argv) {
  const datasetFile = getOptionValue(argv, '--dataset-file');
  if (datasetFile) {
    return [{ datasetPath: path.resolve(datasetFile) }];
  }
  const datasetName = getOptionValue(argv, '--dataset');
  if (datasetName) {
    return [{ datasetName }];
  }
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const entries = await fs.readdir(datasetsDir);
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ datasetName: path.basename(name, '.json') }));
}

async function verifyCase(connection, testCase) {
  let rows;
  try {
    rows = await executeReadOnlySql(connection, testCase.expected_sql);
  } catch (error) {
    return { ok: false, rowCount: 0, problems: [`gold SQL error: ${error.message}`] };
  }

  const rowCount = Array.isArray(rows) ? rows.length : 0;
  const problems = [];

  // Pinned row count catches the drift compareResults cannot: an empty-by-design
  // case (e.g. April 2026 sales) that starts returning rows after a backfill, or
  // a fixed-shape case whose population changed. gold-vs-gold is always true, so
  // without this an "empty" case would silently pass while testing nothing.
  if (Number.isInteger(testCase.expected_row_count) && rowCount !== testCase.expected_row_count) {
    problems.push(`expected ${testCase.expected_row_count} row(s) but gold returned ${rowCount}`);
  }

  if (!compareResults(rows, rows, testCase.comparison)) {
    problems.push('gold result is not self-consistent under its comparison spec');
  }

  const signal = runSignalChecks(rows, testCase.signal_checks);
  if (!signal.passed) {
    problems.push(`signal_checks failed: ${signal.failures.map((failure) => failure.code).join(', ')}`);
  }

  return { ok: problems.length === 0, rowCount, problems };
}

export async function main() {
  const argv = process.argv.slice(2);
  await loadEnvironment(argv);

  const datasets = await resolveDatasetNames(argv);
  const connection = await createMariaDbConnection();

  let totalCases = 0;
  let totalFailures = 0;

  try {
    for (const target of datasets) {
      const info = await loadBenchmarkDataset(target);
      console.log(`\n# ${info.datasetName} (${info.cases.length} cases)`);
      for (const testCase of info.cases) {
        totalCases += 1;
        const result = await verifyCase(connection, testCase);
        if (result.ok) {
          console.log(`  ✓ ${testCase.id}  rows=${result.rowCount}`);
        } else {
          totalFailures += 1;
          console.log(`  ✗ ${testCase.id}  rows=${result.rowCount}  -> ${result.problems.join('; ')}`);
        }
      }
    }
  } finally {
    await connection.end();
  }

  console.log(`\nVerified ${totalCases} cases across ${datasets.length} dataset(s); ${totalFailures} failure(s).`);
  if (totalFailures > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`Dataset verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
