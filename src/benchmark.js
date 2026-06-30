import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRows, extractTablesFromSql } from './pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_DATASETS_DIR = path.resolve(__dirname, '../datasets');
export const DEFAULT_DATASET_NAME = 'core-public';
export const DEFAULT_RUNS_DIR = path.resolve(__dirname, '../generated/runs');

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeSignalChecks(signalChecks) {
  if (!signalChecks || typeof signalChecks !== 'object') {
    return null;
  }

  const minDistinctCounts =
    signalChecks.min_distinct_counts && typeof signalChecks.min_distinct_counts === 'object'
      ? Object.fromEntries(
          Object.entries(signalChecks.min_distinct_counts)
            .map(([column, minimum]) => [String(column).trim(), Number(minimum)])
            .filter(([column, minimum]) => column && Number.isFinite(minimum))
        )
      : {};

  const normalized = {
    ...(Number.isFinite(Number(signalChecks.min_row_count))
      ? {
          min_row_count: Number(signalChecks.min_row_count),
        }
      : {}),
    ...(uniqueStrings(signalChecks.require_nonzero_columns).length > 0
      ? {
          require_nonzero_columns: uniqueStrings(signalChecks.require_nonzero_columns),
        }
      : {}),
    ...(uniqueStrings(signalChecks.require_nonnull_columns).length > 0
      ? {
          require_nonnull_columns: uniqueStrings(signalChecks.require_nonnull_columns),
        }
      : {}),
    ...(Object.keys(minDistinctCounts).length > 0
      ? {
          min_distinct_counts: minDistinctCounts,
        }
      : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function normalizeBenchmarkCase(testCase) {
  if (!testCase || typeof testCase !== 'object') {
    throw new Error('Benchmark cases must be objects.');
  }

  const id = String(testCase.id || '').trim();
  const question = String(testCase.question || '').trim();
  const expectedSql = String(testCase.expected_sql || '').trim();

  if (!id) {
    throw new Error('Benchmark case is missing id.');
  }

  if (!question) {
    throw new Error(`Benchmark case ${id} is missing question.`);
  }

  if (!expectedSql) {
    throw new Error(`Benchmark case ${id} is missing expected_sql.`);
  }

  return {
    ...testCase,
    id,
    intentId: String(testCase.intentId || id).trim(),
    question,
    canonicalQuestion: String(testCase.canonicalQuestion || question).trim(),
    difficulty: testCase.difficulty || null,
    tags: uniqueStrings(testCase.tags),
    expected_sql: expectedSql,
    expected_tables:
      uniqueStrings(testCase.expected_tables).length > 0
        ? uniqueStrings(testCase.expected_tables)
        : extractTablesFromSql(expectedSql),
    expected_columns: uniqueStrings(testCase.expected_columns),
    disallowed_columns: uniqueStrings(testCase.disallowed_columns),
    signal_checks: normalizeSignalChecks(testCase.signal_checks),
    comparison: normalizeComparison(testCase.comparison),
    failure_class: testCase.failure_class || null,
  };
}

export function caseMatchesId(testCase, caseId) {
  if (caseId == null) {
    return true;
  }

  return String(testCase.id) === String(caseId);
}

export function caseHasTag(testCase, tag) {
  if (!tag) {
    return true;
  }

  return Array.isArray(testCase.tags) && testCase.tags.includes(tag);
}

export async function loadBenchmarkDataset({
  datasetName = DEFAULT_DATASET_NAME,
  datasetPath = null,
  datasetsDir = DEFAULT_DATASETS_DIR,
  caseId = null,
  tag = null,
} = {}) {
  const resolvedDatasetPath = datasetPath
    ? path.resolve(datasetPath)
    : path.resolve(datasetsDir, `${datasetName}.json`);
  const raw = JSON.parse(await fs.readFile(resolvedDatasetPath, 'utf8'));

  if (!Array.isArray(raw)) {
    throw new Error(`Benchmark dataset at ${resolvedDatasetPath} must be a JSON array.`);
  }

  const normalizedCases = raw.map(normalizeBenchmarkCase);
  const resolvedDatasetName = datasetName || path.basename(resolvedDatasetPath, '.json');
  const filteredCases = normalizedCases.filter((testCase) => caseMatchesId(testCase, caseId) && caseHasTag(testCase, tag));

  if (filteredCases.length === 0) {
    const filterDescription = [caseId != null ? `case id ${caseId}` : null, tag ? `tag ${tag}` : null].filter(Boolean).join(', ');
    throw new Error(
      `No benchmark cases matched ${filterDescription || 'the current selection'} in dataset ${resolvedDatasetName}.`
    );
  }

  return {
    datasetName: resolvedDatasetName,
    datasetPath: resolvedDatasetPath,
    cases: filteredCases,
    totalCases: normalizedCases.length,
    filters: {
      caseId: caseId == null ? null : String(caseId),
      tag: tag || null,
    },
  };
}

function sanitizePathSegment(value) {
  const sanitized = String(value || 'unknown')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'unknown';
}

export function createRunDirectoryTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:]/g, '-');
}

export function createBenchmarkRunPaths({
  datasetName,
  model,
  timestamp = createRunDirectoryTimestamp(),
  outputDir = DEFAULT_RUNS_DIR,
  traceDir = null,
} = {}) {
  const segments = [sanitizePathSegment(timestamp), sanitizePathSegment(datasetName), sanitizePathSegment(model)];
  const reportDir = path.resolve(outputDir, ...segments);
  const traceRoot = traceDir ? path.resolve(traceDir) : path.resolve(outputDir);
  const traceDirectory = path.resolve(traceRoot, ...segments);

  return {
    timestamp,
    reportDir,
    reportPath: path.resolve(reportDir, 'report.json'),
    traceDir: traceDirectory,
    tracePath: path.resolve(traceDirectory, 'trace.jsonl'),
  };
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function runSignalChecks(rows, signalChecks) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const checks = normalizeSignalChecks(signalChecks);

  if (!checks) {
    return {
      passed: true,
      failures: [],
      metrics: {
        rowCount: normalizedRows.length,
        columns: {},
      },
    };
  }

  const failures = [];
  const columnMetrics = {};

  if (checks.min_row_count != null && normalizedRows.length < checks.min_row_count) {
    failures.push({
      code: 'min_row_count',
      expected: checks.min_row_count,
      actual: normalizedRows.length,
      message: `Expected at least ${checks.min_row_count} rows but found ${normalizedRows.length}.`,
    });
  }

  if (normalizedRows.length === 0) {
    const hasColumnChecks =
      (checks.require_nonzero_columns || []).length > 0 ||
      (checks.require_nonnull_columns || []).length > 0 ||
      Object.keys(checks.min_distinct_counts || {}).length > 0;

    if (failures.length === 0 && hasColumnChecks) {
      failures.push({
        code: 'empty_result_set',
        actual: 0,
        message: 'Signal checks could not be validated because the result set is empty.',
      });
    }

    return {
      passed: failures.length === 0,
      failures,
      metrics: {
        rowCount: normalizedRows.length,
        columns: columnMetrics,
      },
    };
  }

  for (const column of checks.require_nonzero_columns || []) {
    const values = normalizedRows.map((row) => numericValue(row?.[column])).filter((value) => value != null);
    const nonZeroCount = values.filter((value) => value !== 0).length;

    columnMetrics[column] = {
      ...(columnMetrics[column] || {}),
      nonZeroCount,
      valueCount: values.length,
    };

    if (nonZeroCount === 0) {
      failures.push({
        code: 'require_nonzero_columns',
        column,
        actual: nonZeroCount,
        message: `Column ${column} was zero or null for every returned row.`,
      });
    }
  }

  for (const column of checks.require_nonnull_columns || []) {
    const nullCount = normalizedRows.filter((row) => row?.[column] == null).length;

    columnMetrics[column] = {
      ...(columnMetrics[column] || {}),
      nullCount,
      rowCount: normalizedRows.length,
    };

    if (nullCount > 0) {
      failures.push({
        code: 'require_nonnull_columns',
        column,
        actual: nullCount,
        message: `Column ${column} was null in ${nullCount} returned row(s).`,
      });
    }
  }

  for (const [column, minimum] of Object.entries(checks.min_distinct_counts || {})) {
    const distinctCount = new Set(normalizedRows.map((row) => row?.[column]).filter((value) => value != null)).size;

    columnMetrics[column] = {
      ...(columnMetrics[column] || {}),
      distinctCount,
    };

    if (distinctCount < minimum) {
      failures.push({
        code: 'min_distinct_counts',
        column,
        expected: minimum,
        actual: distinctCount,
        message: `Column ${column} had ${distinctCount} distinct non-null value(s); expected at least ${minimum}.`,
      });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    metrics: {
      rowCount: normalizedRows.length,
      columns: columnMetrics,
    },
  };
}

export function findMissingExpectedTables(expectedTables, retrievedTables) {
  const retrieved = new Set(Array.isArray(retrievedTables) ? retrievedTables : []);
  return uniqueStrings(expectedTables).filter((tableName) => !retrieved.has(tableName));
}

export function findDisallowedColumnsUsed(sql, disallowedColumns) {
  const sqlText = String(sql || '');

  return uniqueStrings(disallowedColumns).filter((column) =>
    new RegExp(`\\b${escapeRegExp(column)}\\b`, 'i').test(sqlText)
  );
}

export function classifyBenchmarkStatus({
  rowsMatch,
  signalCheckResult,
  expectedTables,
  retrievedTables,
  disallowedColumnsUsed = [],
} = {}) {
  if (rowsMatch) {
    // Value comparison ignores extra projected columns, so a query can return
    // the right answer while also selecting a trap column the case forbids
    // (e.g. the correct gross total plus SalesDocument.NetPayableAmount). That must not be a
    // pass — the disallowed-column guard would otherwise be silently bypassed.
    if (Array.isArray(disallowedColumnsUsed) && disallowedColumnsUsed.length > 0) {
      return 'disallowed_column_used';
    }
    return signalCheckResult?.passed === false ? 'low_signal_success' : 'pass';
  }

  return findMissingExpectedTables(expectedTables, retrievedTables).length > 0 ? 'retrieval_miss' : 'result_mismatch';
}

// --- Value-aware result comparison -------------------------------------------
//
// The legacy `compareRows` keys each row by its exact (lowercased) column name,
// so a model that returns the right answer with a different aggregate alias
// (`total_net_sales_amount` vs `total_net_amount`) or an extra projected column
// (`CustomerId`, `CustomerCode`) is scored as a `result_mismatch`. In practice
// that cosmetic brittleness dominated real failures. `compareResults` compares
// on VALUES instead of column names: it matches the gold's compared columns to
// the model's columns by value (any name, any position, extra columns ignored)
// and checks the row tuples agree. This is the standard execution-match idea
// (Spider-style), adapted to allow extra predicted columns.
//
// A case opts in via a `comparison` block; without one, the legacy exact-row
// behavior is preserved so existing datasets and `compareRows` callers are
// unchanged.
//
//   comparison: {
//     mode: 'scalar' | 'rowset' | 'ranked'   // default 'rowset'
//     compare_columns: [..gold column names]  // default: all gold columns
//     value_columns: [..gold column names]    // ranked: the ranking metric(s)
//     order: 'desc' | 'asc'                    // ranked: default 'desc'
//     decimals: number                         // rounding precision, default 2
//     tolerance: number                        // absolute numeric tolerance
//   }
//
// Numbers are compared either by equality after rounding to `decimals` (default
// 2, matching the gold queries' ROUND(..., 2)) or, when `tolerance` is set, by a
// true absolute difference (|gold - actual| <= tolerance) rather than bucketing.
//
// - scalar/rowset: a bijection of compared row tuples must exist (order-blind).
// - ranked: that bijection must exist AND the model's primary value column must
//   be monotonic in `order` (catches "didn't sort / sorted wrong" while tolerating
//   tie reordering by label, which the gold's tiebreak fixes but the model's
//   may not).

function toComparableNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

const DEFAULT_DECIMALS = 2;

// Numeric view of a cell: real numbers, bigints, numeric strings (DECIMAL from
// the driver), and Dates (epoch ms). Everything else is null (treated as text).
function numericValueOf(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  return toComparableNumber(value);
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// Stable key for sorting / column-signature prefiltering. Numbers are rounded to
// `decimals` (default 2) so a model returning more precision than the gold's
// ROUND(..., 2) is not bucketed apart from it.
function cellKey(value, decimals) {
  const numeric = numericValueOf(value);
  if (numeric !== null) {
    return `n:${roundTo(numeric, decimals)}`;
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  return `s:${String(value).trim()}`;
}

// Cell equality. Numbers compare with a true absolute tolerance when one is set
// (|gold - actual| <= tolerance), otherwise by equality after rounding to
// `decimals`. A numeric cell never equals a text/NULL cell; two NULLs are equal.
function cellsEqual(goldValue, actualValue, decimals, tolerance) {
  const goldNum = numericValueOf(goldValue);
  const actualNum = numericValueOf(actualValue);
  if (goldNum !== null && actualNum !== null) {
    return tolerance > 0
      ? Math.abs(goldNum - actualNum) <= tolerance + 1e-9
      : roundTo(goldNum, decimals) === roundTo(actualNum, decimals);
  }
  if (goldNum !== null || actualNum !== null) {
    return false;
  }
  const goldNull = goldValue === null || goldValue === undefined;
  const actualNull = actualValue === null || actualValue === undefined;
  if (goldNull || actualNull) {
    return goldNull && actualNull;
  }
  return String(goldValue).trim() === String(actualValue).trim();
}

function projectRows(rows, columns) {
  return rows.map((row) => columns.map((column) => row?.[column]));
}

function rowTuplesEqual(goldTuple, actualTuple, decimals, tolerance) {
  return goldTuple.every((cell, index) => cellsEqual(cell, actualTuple[index], decimals, tolerance));
}

// Order-insensitive: is there a bijection (gold rows <-> actual rows) where every
// matched pair is cell-equal? A pairwise matcher (rather than comparing canonical
// string multisets) is what lets numeric tolerance be a true absolute difference.
// Backtracking is fine for the small result sets these datasets produce; a step
// cap guards against pathological duplicate rows.
function matchRowsUnordered(goldTuples, actualTuples, decimals, tolerance) {
  if (goldTuples.length !== actualTuples.length) {
    return false;
  }
  const used = new Array(actualTuples.length).fill(false);
  let steps = 0;

  function backtrack(index) {
    if (index === goldTuples.length) {
      return true;
    }
    if ((steps += 1) > 500000) {
      return false;
    }
    for (let j = 0; j < actualTuples.length; j += 1) {
      if (used[j] || !rowTuplesEqual(goldTuples[index], actualTuples[j], decimals, tolerance)) {
        continue;
      }
      used[j] = true;
      if (backtrack(index + 1)) {
        return true;
      }
      used[j] = false;
    }
    return false;
  }

  return backtrack(0);
}

function columnSignature(rows, column, decimals) {
  return rows
    .map((row) => cellKey(row?.[column], decimals))
    .sort()
    .join('');
}

// Injective gold-column -> actual-column assignments to try. With no tolerance,
// candidates are pre-filtered to actual columns with an identical value multiset
// (fast, exact). With a tolerance that prefilter is unsafe (near-but-unequal
// values bucket differently), so every actual column is a candidate and the row
// matcher does the real work.
function findColumnAssignments(goldColumns, actualColumns, goldRows, actualRows, decimals, tolerance) {
  const candidates = goldColumns.map((goldColumn) => {
    if (tolerance > 0) {
      return actualColumns;
    }
    const signature = columnSignature(goldRows, goldColumn, decimals);
    return actualColumns.filter((actualColumn) => columnSignature(actualRows, actualColumn, decimals) === signature);
  });

  const assignments = [];
  const used = new Set();
  const current = [];

  (function backtrack(index) {
    if (assignments.length >= 64) {
      return; // safety cap on pathological duplicate-column cases
    }
    if (index === goldColumns.length) {
      assignments.push(current.slice());
      return;
    }
    for (const actualColumn of candidates[index]) {
      if (used.has(actualColumn)) {
        continue;
      }
      used.add(actualColumn);
      current.push(actualColumn);
      backtrack(index + 1);
      current.pop();
      used.delete(actualColumn);
    }
  })(0);

  return assignments;
}

function isNumericColumn(rows, column) {
  let sawNumber = false;
  for (const row of rows) {
    const value = row?.[column];
    if (value === null || value === undefined) {
      continue;
    }
    if (toComparableNumber(value) === null) {
      return false;
    }
    sawNumber = true;
  }
  return sawNumber;
}

function rankingHolds(actualRows, primaryActualColumn, order, tolerance) {
  if (!primaryActualColumn) {
    return true;
  }
  const slack = tolerance > 0 ? tolerance : 1e-6;
  let previous = null;
  for (const row of actualRows) {
    const value = numericValueOf(row?.[primaryActualColumn]);
    if (value === null) {
      // Skip NULL metric rows WITHOUT resetting the running bound: a correct
      // ORDER BY puts NULLs at the end, and a NULL must never license a jump
      // back past the last real value mid-sequence.
      continue;
    }
    if (previous !== null) {
      if (order === 'asc' && value < previous - slack) {
        return false;
      }
      if (order !== 'asc' && value > previous + slack) {
        return false;
      }
    }
    previous = value;
  }
  return true;
}

export function compareResults(expectedRows, actualRows, comparison = null) {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const actual = Array.isArray(actualRows) ? actualRows : [];

  if (!comparison || typeof comparison !== 'object') {
    return compareRows(expected, actual);
  }

  if (expected.length !== actual.length) {
    return false;
  }
  if (expected.length === 0) {
    return true;
  }

  const tolerance = toComparableNumber(comparison.tolerance) ?? 0;
  const decimals = Number.isInteger(comparison.decimals) ? comparison.decimals : DEFAULT_DECIMALS;
  const goldColumns =
    Array.isArray(comparison.compare_columns) && comparison.compare_columns.length > 0
      ? comparison.compare_columns
      : Object.keys(expected[0] ?? {});
  if (goldColumns.length === 0) {
    return true;
  }

  const actualColumns = Object.keys(actual[0] ?? {});
  if (actualColumns.length < goldColumns.length) {
    return false;
  }

  const mode = comparison.mode || 'rowset';
  const order = (comparison.order || 'desc').toLowerCase();
  const goldTuples = projectRows(expected, goldColumns);

  const valueColumns =
    Array.isArray(comparison.value_columns) && comparison.value_columns.length > 0
      ? comparison.value_columns
      : goldColumns.filter((column) => isNumericColumn(expected, column));
  const primaryValueColumn = valueColumns[0] || null;

  for (const assignment of findColumnAssignments(goldColumns, actualColumns, expected, actual, decimals, tolerance)) {
    if (!matchRowsUnordered(goldTuples, projectRows(actual, assignment), decimals, tolerance)) {
      continue;
    }
    if (mode !== 'ranked') {
      return true;
    }
    const primaryActualColumn = primaryValueColumn ? assignment[goldColumns.indexOf(primaryValueColumn)] : null;
    if (rankingHolds(actual, primaryActualColumn, order, tolerance)) {
      return true;
    }
  }

  return false;
}

function normalizeComparison(comparison) {
  if (!comparison || typeof comparison !== 'object') {
    return null;
  }

  const mode = ['scalar', 'rowset', 'ranked'].includes(comparison.mode) ? comparison.mode : 'rowset';
  const order = comparison.order === 'asc' ? 'asc' : 'desc';
  const tolerance = Number.isFinite(Number(comparison.tolerance)) ? Number(comparison.tolerance) : 0;

  const normalized = { mode, order, tolerance };
  if (Number.isInteger(comparison.decimals)) {
    normalized.decimals = comparison.decimals;
  }
  const compareColumns = uniqueStrings(comparison.compare_columns);
  const valueColumns = uniqueStrings(comparison.value_columns);
  if (compareColumns.length > 0) {
    normalized.compare_columns = compareColumns;
  }
  if (valueColumns.length > 0) {
    normalized.value_columns = valueColumns;
  }
  return normalized;
}

export function summarizeBenchmarkResults(results) {
  const normalizedResults = Array.isArray(results) ? results : [];
  const statusCounts = normalizedResults.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});
  const passed = normalizedResults.filter((result) => result.status === 'pass').length;

  return {
    total: normalizedResults.length,
    passed,
    failed: normalizedResults.length - passed,
    statusCounts,
  };
}
