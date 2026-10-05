import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRows, extractTablesFromSql } from './pipeline.js';
import { outputAliasDefinitions } from './sql-guardrails.js';
import { analyzeSqlStructure, isKeywordToken, tokenizeSql } from './sql-tokenizer.js';

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
    alternative_expected_sql: uniqueStrings(testCase.alternative_expected_sql).filter((sql) => sql !== expectedSql),
    expected_row_counts: normalizeExpectedRowCounts(testCase.expected_row_counts),
    failure_class: testCase.failure_class || null,
  };
}

function normalizeExpectedRowCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return null;
  }
  const entries = Object.entries(counts)
    .map(([fixture, count]) => [String(fixture).trim(), count])
    .filter(([fixture, count]) => fixture && Number.isInteger(count) && count >= 0);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * The pinned gold row count for one fixture, or null when none is pinned.
 * Datasets pin `expected_row_counts: { seed, v2, v3 }`; an external dataset
 * may still carry the older single `expected_row_count`, which was measured on
 * the demo seed and therefore applies to the primary fixture only.
 */
export function resolveExpectedRowCount(testCase, fixtureName, { primaryFixture = 'seed' } = {}) {
  const pinned = testCase?.expected_row_counts?.[fixtureName];
  if (Number.isInteger(pinned)) {
    return pinned;
  }
  if (!testCase?.expected_row_counts && fixtureName === primaryFixture && Number.isInteger(testCase?.expected_row_count)) {
    return testCase.expected_row_count;
  }
  return null;
}

/** Gold SQL variants a prediction may match: the gold first, then alternatives. */
export function listGoldVariants(testCase) {
  return [
    { label: 'expected_sql', sql: testCase.expected_sql },
    ...(testCase.alternative_expected_sql || []).map((sql, index) => ({ label: `alternative_expected_sql[${index}]`, sql })),
  ];
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

// Signal checks name gold columns, but a correct prediction may alias them
// differently. Resolve each gold column through the comparator's assignment
// (gold column -> prediction column) so a renamed alias is checked by value.
export function remapRowsThroughAssignment(rows, assignment) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const entries = Object.entries(assignment || {});
  if (entries.length === 0) {
    return normalizedRows;
  }
  return normalizedRows.map((row) => {
    const remapped = { ...row };
    for (const [goldColumn, actualColumn] of entries) {
      remapped[goldColumn] = row?.[actualColumn];
    }
    return remapped;
  });
}

/**
 * runSignalChecks on a prediction, with gold column names resolved through the
 * comparator's assignment. Column checks whose gold column the prediction does
 * not carry (not assigned and not present under the same name) are skipped and
 * listed in `unresolvedColumns`, instead of failing on a missing alias.
 * Informational only: a value match is never turned into a failure by it.
 */
export function runSignalChecksThroughAssignment(rows, signalChecks, assignment = null) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const checks = normalizeSignalChecks(signalChecks);
  const remapped = remapRowsThroughAssignment(normalizedRows, assignment);
  if (!checks || remapped.length === 0) {
    return { ...runSignalChecks(remapped, checks), unresolvedColumns: [] };
  }

  const available = new Set([...Object.keys(normalizedRows[0] ?? {}), ...Object.keys(assignment || {})]);
  const unresolved = new Set();
  const keep = (column) => {
    if (available.has(column)) {
      return true;
    }
    unresolved.add(column);
    return false;
  };
  const resolved = {
    ...(checks.min_row_count != null ? { min_row_count: checks.min_row_count } : {}),
    require_nonzero_columns: (checks.require_nonzero_columns || []).filter(keep),
    require_nonnull_columns: (checks.require_nonnull_columns || []).filter(keep),
    min_distinct_counts: Object.fromEntries(Object.entries(checks.min_distinct_counts || {}).filter(([column]) => keep(column))),
  };
  return { ...runSignalChecks(remapped, resolved), unresolvedColumns: [...unresolved] };
}

const NON_SIGNIFICANT_TOKEN_TYPES = new Set(['whitespace', 'comment', 'executable_comment']);

function isIdentifierLikeToken(token) {
  return token?.type === 'word' || token?.type === 'quoted_identifier';
}

function tokenIdentifierName(token) {
  return token.type === 'quoted_identifier' ? token.name : token.value;
}

function isPunctTokenValue(token, value) {
  return token?.type === 'punct' && token.value === value;
}

function collectColumnReferences(significant, skippedIndexes) {
  const references = [];
  for (let index = 0; index < significant.length; index += 1) {
    const token = significant[index];
    if (!isIdentifierLikeToken(token) || skippedIndexes.has(index)) {
      continue;
    }
    // `q.col` (or `db.q.col`): record the last two parts.
    if (isPunctTokenValue(significant[index + 1], '.') && isIdentifierLikeToken(significant[index + 2])) {
      let end = index + 2;
      while (isPunctTokenValue(significant[end + 1], '.') && isIdentifierLikeToken(significant[end + 2])) {
        end += 2;
      }
      references.push({
        index,
        qualifier: tokenIdentifierName(significant[end - 2]).toLowerCase(),
        column: tokenIdentifierName(significant[end]).toLowerCase(),
        whole: significant.slice(index, end + 1).map(tokenIdentifierName).join('.').toLowerCase(),
      });
      index = end;
      continue;
    }
    const previous = significant[index - 1];
    // Not a column: an alias definition (`AS name`) or a function call (`name(`).
    if (isKeywordToken(previous, 'AS') || isPunctTokenValue(significant[index + 1], '(')) {
      continue;
    }
    const name = tokenIdentifierName(token);
    references.push({ index, qualifier: null, column: name.toLowerCase(), whole: name.toLowerCase() });
  }
  return references;
}

const CLAUSE_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'ON', 'USING', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'UNION']);

// The clause keyword each significant token falls under, at its own
// parenthesis depth (a parenthesized expression inherits the outer clause).
function clauseOfTokens(significant) {
  const clauses = new Array(significant.length).fill(null);
  const current = [null];
  let depth = 0;
  significant.forEach((token, index) => {
    if (isPunctTokenValue(token, '(')) {
      depth += 1;
      current[depth] = current[depth - 1];
    } else if (isPunctTokenValue(token, ')')) {
      depth = Math.max(0, depth - 1);
    } else if (token.type === 'word' && !token.afterDot && CLAUSE_KEYWORDS.has(token.upper)) {
      current[depth] = token.upper;
    }
    clauses[index] = current[depth];
  });
  return clauses;
}

// Clauses where a bare name may refer to an output alias instead of a column.
const ALIAS_REFERENCE_CLAUSES = new Set(['GROUP', 'HAVING', 'ORDER']);

/**
 * Token-based lint: which `disallowed_columns` entries the SQL actually uses.
 * Reads SQL through the shared MariaDB tokenizer, so string literals, comments
 * and output alias definitions (`AS alias` and the implicit `expr alias`, read
 * the way the validator reads them) never count, nor does a bare name in
 * GROUP BY / HAVING / ORDER BY that refers to such an alias. Entries are
 * - `Column`: any reference to that column, bare or qualified;
 * - `Table.Column`: a reference qualified by that table or one of its aliases,
 *   or a bare reference when the column resolves to that table (the only
 *   referenced table, or the only referenced table carrying the column per the
 *   optional compiled `schema`);
 * - a table name: the table is referenced at all.
 * Matching is case-insensitive, like MariaDB identifiers. Reported as a
 * warning: the comparator, not this lint, decides whether a case passes.
 */
export function findDisallowedColumnsUsed(sql, disallowedColumns, { schema = null } = {}) {
  const entries = uniqueStrings(disallowedColumns);
  if (entries.length === 0) {
    return [];
  }

  let tokens;
  try {
    tokens = tokenizeSql(String(sql || ''), { tolerant: true });
  } catch {
    return [];
  }
  const significant = tokens.filter((token) => !NON_SIGNIFICANT_TOKEN_TYPES.has(token.type));
  let tableRefs = [];
  try {
    tableRefs = analyzeSqlStructure(tokens, { tolerant: true }).tableRefs.filter((ref) => ref.kind === 'table' && ref.name);
  } catch {
    tableRefs = [];
  }

  // Table-reference name/alias tokens are not column references.
  const skippedIndexes = new Set();
  const qualifierTables = new Map();
  const addQualifier = (qualifier, tableName) => {
    const key = String(qualifier).toLowerCase();
    if (!qualifierTables.has(key)) {
      qualifierTables.set(key, new Set());
    }
    qualifierTables.get(key).add(tableName.toLowerCase());
  };
  for (const ref of tableRefs) {
    skippedIndexes.add(ref.index);
    addQualifier(ref.name, ref.name);
    if (ref.alias) {
      addQualifier(ref.alias, ref.name);
      for (const offset of [1, 2]) {
        const aliasToken = significant[ref.index + offset];
        if (isIdentifierLikeToken(aliasToken) && tokenIdentifierName(aliasToken) === ref.alias) {
          skippedIndexes.add(ref.index + offset);
          break;
        }
      }
    }
  }
  const referencedTables = new Set(tableRefs.map((ref) => ref.name.toLowerCase()));
  // Output alias definitions are names, not column references; a bare alias
  // name in GROUP BY / HAVING / ORDER BY refers to the alias.
  const aliasDefinitions = outputAliasDefinitions(significant);
  for (const index of aliasDefinitions.keys()) {
    skippedIndexes.add(index);
  }
  const aliasNames = new Set([...aliasDefinitions.values()].map((name) => name.toLowerCase()));
  const clauses = clauseOfTokens(significant);
  const references = collectColumnReferences(significant, skippedIndexes).filter(
    (reference) => !(reference.qualifier === null && aliasNames.has(reference.column) && ALIAS_REFERENCE_CLAUSES.has(clauses[reference.index]))
  );

  const schemaColumns = new Map(
    (schema?.tables || []).map((table) => [
      String(table.tableName || table.name).toLowerCase(),
      new Set((table.columns || []).map((column) => String(column.name).toLowerCase())),
    ])
  );
  const tablesHavingColumn = (column) =>
    [...referencedTables].filter((tableName) => schemaColumns.get(tableName)?.has(column));

  return entries.filter((entry) => {
    const lower = entry.toLowerCase();
    if (references.some((reference) => reference.whole === lower)) {
      return true; // e.g. a quoted identifier spelled exactly like the entry
    }
    const dot = lower.lastIndexOf('.');
    if (dot === -1) {
      return referencedTables.has(lower) || references.some((reference) => reference.column === lower);
    }

    const tableName = lower.slice(0, dot);
    const column = lower.slice(dot + 1);
    if (!referencedTables.has(tableName)) {
      return false;
    }
    return references.some((reference) => {
      if (reference.column !== column) {
        return false;
      }
      if (reference.qualifier !== null) {
        return qualifierTables.get(reference.qualifier)?.has(tableName) ?? false;
      }
      if (referencedTables.size === 1) {
        return true;
      }
      const owners = tablesHavingColumn(column);
      return owners.length === 1 && owners[0] === tableName;
    });
  });
}

/**
 * Benchmark status from the oracle verdict. Only values decide: a value match
 * is 'pass' even when signal checks or the disallowed-column lint complain
 * (those are reported as warnings, see collectBenchmarkWarnings). Otherwise a
 * missing expected table in the retrieved set is a 'retrieval_miss', and
 * anything else a 'result_mismatch'. `signalCheckResult` and
 * `disallowedColumnsUsed` are accepted for compatibility and ignored.
 */
export function classifyBenchmarkStatus({ rowsMatch, expectedTables, retrievedTables } = {}) {
  if (rowsMatch) {
    return 'pass';
  }

  return findMissingExpectedTables(expectedTables, retrievedTables).length > 0 ? 'retrieval_miss' : 'result_mismatch';
}

// Warning flags that used to be failure statuses: 'low_signal_success' (values
// matched but a signal check, resolved through the column assignment, still
// complained) and 'disallowed_column_used' (the lint saw a trap column).
export function collectBenchmarkWarnings({ rowsMatch, signalWarnings = [], disallowedColumnsUsed = [] } = {}) {
  const warnings = [];
  if (rowsMatch && Array.isArray(signalWarnings) && signalWarnings.length > 0) {
    warnings.push('low_signal_success');
  }
  if (Array.isArray(disallowedColumnsUsed) && disallowedColumnsUsed.length > 0) {
    warnings.push('disallowed_column_used');
  }
  return warnings;
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
//     column_order: [..gold column names]      // these must keep their relative
//                                              // SELECT-list order in the prediction
//     null_as_zero: [..gold column names]      // NULL counts as 0 in these columns
//   }
//
// Cells are compared by kind:
// - Dates: a JS Date (mysql2 returns DATE/DATETIME as local-time Dates) and a
//   date/datetime string normalize to one canonical wall-clock string,
//   `YYYY-MM-DD` (or `YYYY-MM-DD hh:mm:ss[.fff]` when the time is not midnight),
//   so a DATE column matches a model's DATE_FORMAT/CAST output.
// - Numbers (numbers, bigints, numeric strings) compare either by equality
//   after rounding to `decimals` (default 2, matching the gold queries'
//   ROUND(..., 2)) or, when `tolerance` is set, by a true absolute difference
//   (|gold - actual| <= tolerance) rather than bucketing.
// - Everything else compares as trimmed text; two NULLs are equal; a NULL, a
//   number, a date and a text cell never equal each other.
//
// - scalar/rowset: a bijection of compared row tuples must exist (order-blind).
// - ranked: that bijection must exist AND the model's primary value column must
//   be monotonic in `order` (catches "didn't sort / sorted wrong" while
//   tolerating tie reordering by label, which the gold's tiebreak fixes but the
//   model's may not). The default ranking column is the first truly numeric
//   gold column (JS numbers, not numeric-looking code strings like '4000').
// - name pinning: when exactly one prediction column has a gold column's name
//   (ignoring case and punctuation), only that column may carry that gold
//   column, and it carries no other. Names are otherwise ignored, but a column
//   the model labeled like the gold must hold the gold's values: a wrong
//   `total_net_amount` cannot pass because an extra `net_amount_excl_fees`
//   happens to hold the right numbers.
// - column_order: values alone cannot tell `jan_net_amount` from
//   `feb_net_amount`. For the listed gold columns, a carrier named like its
//   gold column (see isColumnNamedLike) identifies itself; the other carriers
//   must keep the gold's relative SELECT-list order, and none may be named
//   like a different listed gold column. Limit: carriers named unlike any
//   listed column (`january`, `february`) are judged by position only, so a
//   label-only swap of such names in the right positions still passes.
// - null_as_zero: in the listed gold columns NULL counts as 0 on both sides
//   (a conditional SUM without ELSE 0 returns NULL for a month with no sales).
// - scalar rule: when the gold is a single value (one row, one compared
//   column) and the prediction has several columns, the column carrying the
//   gold value must be the one named exactly like the gold column when there
//   is one; otherwise the prediction's only column of the gold value's kind
//   (only numeric column for a number), or the only column named like the
//   gold column (a longer name containing its words, e.g.
//   `posted_document_count` for `document_count`, but not
//   `inactive_customer_count` for `active_customer_count` or
//   `non_canceled_count` for `canceled_count`). A correct-looking incidental
//   extra column can then not carry a wrong headline number
//   (`{product_count: 4, feb_product_count: 1}` vs gold 1 fails). Known false
//   negative: a correct answer plus one more numeric column under an unrelated
//   alias (`{urban_refresh_net_sales: 1400, line_count: 3}`) fails.

const DEFAULT_DECIMALS = 2;
// Upper bound on enumerated column assignments (and on the permutations tried
// to find them), guarding pathological duplicate-column results.
const MAX_ASSIGNMENTS = 64;
const MAX_ASSIGNMENT_STEPS = 20000;

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

function padNumber(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatWallClock(year, month, day, hours, minutes, seconds, fraction) {
  const date = `${padNumber(year, 4)}-${padNumber(month)}-${padNumber(day)}`;
  const trimmedFraction = String(fraction || '').replace(/0+$/, '');
  if (!hours && !minutes && !seconds && !trimmedFraction) {
    return date;
  }
  const time = `${padNumber(hours)}:${padNumber(minutes)}:${padNumber(seconds)}`;
  return `${date} ${time}${trimmedFraction ? `.${trimmedFraction}` : ''}`;
}

const TEMPORAL_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Canonical wall-clock text for a Date or a date/datetime string, or null when
 * the value is not temporal. Dates use local time, which is how mysql2 builds
 * them from DATE/DATETIME columns (timezone 'local'); a string with an explicit
 * zone (`...Z`, `+02:00`) is an instant and is converted the same way.
 */
export function canonicalTemporalValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return formatWallClock(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      padNumber(value.getMilliseconds(), 3)
    );
  }

  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  const match = TEMPORAL_TEXT.exec(text);
  if (!match) {
    return null;
  }

  const [, year, month, day, hours = '00', minutes = '00', seconds = '00', fraction = '', zone] = match;
  if (zone) {
    const instant = new Date(text);
    return Number.isNaN(instant.getTime()) ? null : canonicalTemporalValue(instant);
  }

  const parts = [Number(month), Number(day), Number(hours), Number(minutes), Number(seconds)];
  if (parts[0] < 1 || parts[0] > 12 || parts[1] < 1 || parts[1] > 31 || parts[2] > 23 || parts[3] > 59 || parts[4] > 59) {
    return null;
  }
  return formatWallClock(Number(year), ...parts, fraction);
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// Comparison view of one cell: its kind plus an exact key (numbers rounded to
// `decimals`). Two cells are equal only when their kinds agree; numbers then
// compare by key, or by absolute difference when a tolerance is set.
function describeCell(value, decimals) {
  if (value === null || value === undefined) {
    return { kind: 'null', key: 'null', num: null };
  }
  const temporal = canonicalTemporalValue(value);
  if (temporal !== null) {
    return { kind: 'time', key: `t:${temporal}`, num: null };
  }
  const numeric = toComparableNumber(value);
  if (numeric !== null) {
    return { kind: 'num', key: `n:${roundTo(numeric, decimals)}`, num: numeric };
  }
  return { kind: 'text', key: `s:${String(value).trim()}`, num: null };
}

function cellsEqual(gold, actual, tolerance) {
  if (gold.kind !== actual.kind) {
    return false;
  }
  if (gold.kind === 'num' && tolerance > 0) {
    return Math.abs(gold.num - actual.num) <= tolerance + 1e-9;
  }
  return gold.key === actual.key;
}

function describeColumn(rows, column, decimals, { nullAsZero = false } = {}) {
  return rows.map((row) => {
    const value = row?.[column];
    return describeCell(nullAsZero && (value === null || value === undefined) ? 0 : value, decimals);
  });
}

function sortedKeys(cells, kind) {
  return cells
    .filter((cell) => cell.kind === kind)
    .map((cell) => cell.key)
    .sort();
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Necessary condition for a row bijection that pairs these two columns: equal
// NULL/date/text multisets and numeric multisets that agree after rounding or,
// with a tolerance, pairwise within it once sorted (if any pairing of two
// 1-D multisets is within the tolerance, the sorted pairing is too).
function columnsCompatible(goldCells, actualCells, tolerance) {
  for (const kind of ['null', 'time', 'text']) {
    if (!sameList(sortedKeys(goldCells, kind), sortedKeys(actualCells, kind))) {
      return false;
    }
  }
  if (tolerance <= 0) {
    return sameList(sortedKeys(goldCells, 'num'), sortedKeys(actualCells, 'num'));
  }
  const goldNumbers = goldCells.filter((cell) => cell.kind === 'num').map((cell) => cell.num).sort((a, b) => a - b);
  const actualNumbers = actualCells.filter((cell) => cell.kind === 'num').map((cell) => cell.num).sort((a, b) => a - b);
  return (
    goldNumbers.length === actualNumbers.length &&
    goldNumbers.every((value, index) => Math.abs(value - actualNumbers[index]) <= tolerance + 1e-9)
  );
}

function tupleKey(tuple) {
  return tuple.map((cell) => cell.key).join('\u0001');
}

// Order-insensitive: is there a bijection (gold rows <-> actual rows) where every
// matched pair is cell-equal? Without a tolerance cell equality is an
// equivalence, so comparing sorted tuple keys is exact. With a tolerance a
// pairwise matcher is needed so the tolerance is a true absolute difference;
// backtracking is fine for the small result sets these datasets produce, and a
// step cap guards against pathological duplicate rows.
function matchRowsUnordered(goldTuples, actualTuples, tolerance) {
  if (goldTuples.length !== actualTuples.length) {
    return false;
  }
  if (tolerance <= 0) {
    return sameList(goldTuples.map(tupleKey).sort(), actualTuples.map(tupleKey).sort());
  }

  const used = new Array(actualTuples.length).fill(false);
  let steps = 0;
  const tuplesEqual = (gold, actual) => gold.every((cell, index) => cellsEqual(cell, actual[index], tolerance));

  function backtrack(index) {
    if (index === goldTuples.length) {
      return true;
    }
    if ((steps += 1) > 500000) {
      return false;
    }
    for (let j = 0; j < actualTuples.length; j += 1) {
      if (used[j] || !tuplesEqual(goldTuples[index], actualTuples[j])) {
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

// Truly numeric column: every non-NULL value is a JS number or bigint. Numeric
// strings (VARCHAR codes such as AccountCode '4000') do not count, so they are
// never picked as the default ranking column.
function isTrulyNumericColumn(rows, column) {
  let sawNumber = false;
  for (const row of rows) {
    const value = row?.[column];
    if (value === null || value === undefined) {
      continue;
    }
    if (!(typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value)))) {
      return false;
    }
    sawNumber = true;
  }
  return sawNumber;
}

function valueKind(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value))) {
    return 'number';
  }
  return canonicalTemporalValue(value) !== null ? 'temporal' : 'text';
}

function normalizedColumnName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Same column name ignoring case and punctuation (`Total_Net` = `totalnet`). */
export function isSameColumnName(goldColumn, actualColumn) {
  const gold = normalizedColumnName(goldColumn);
  return Boolean(gold) && gold === normalizedColumnName(actualColumn);
}

// Words of a column name: split at punctuation, camelCase and letter/digit
// boundaries, lowercased (`postedDocumentCount` -> posted, document, count).
function columnNameWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// A word right before the gold name that negates it: `non_canceled_count` is
// not a `canceled_count`.
const NEGATING_NAME_WORDS = new Set(['non', 'not', 'no', 'un', 'without', 'excluding', 'excl', 'except']);

/**
 * The prediction column is named like the gold column: the same name ignoring
 * case and punctuation, or a longer name that contains the gold name's words
 * as a whole run (`posted_document_count` for `document_count`) not directly
 * preceded by a negation (`non_canceled_count` is not `canceled_count`).
 * Word boundaries matter: `inactive_customer_count` is not named like
 * `active_customer_count`.
 */
export function isColumnNamedLike(goldColumn, actualColumn) {
  if (isSameColumnName(goldColumn, actualColumn)) {
    return true;
  }
  const gold = columnNameWords(goldColumn);
  const actual = columnNameWords(actualColumn);
  if (gold.length === 0 || actual.length <= gold.length) {
    return false;
  }
  for (let start = 0; start + gold.length <= actual.length; start += 1) {
    if (gold.every((word, offset) => actual[start + offset] === word) && !NEGATING_NAME_WORDS.has(actual[start - 1])) {
      return true;
    }
  }
  return false;
}

// Scalar rule (see the comparison spec above). A column with the gold
// column's exact name is the only one allowed to carry the value; otherwise
// the carrier must be the only column, the only column of the value's kind,
// or the only column named like the gold column.
function scalarRuleHolds(goldColumn, actualColumn, actualRow, actualColumns) {
  if (actualColumns.length === 1) {
    return true;
  }
  const exact = actualColumns.filter((column) => isSameColumnName(goldColumn, column));
  if (exact.length > 0) {
    return exact.includes(actualColumn);
  }
  const kind = valueKind(actualRow?.[actualColumn]);
  const sameKind = actualColumns.filter((column) => valueKind(actualRow?.[column]) === kind);
  if (sameKind.length === 1) {
    return true;
  }
  const named = actualColumns.filter((column) => isColumnNamedLike(goldColumn, column));
  return named.length === 1 && named[0] === actualColumn;
}

function rankValueOf(value) {
  const numeric = toComparableNumber(value);
  if (numeric !== null) {
    return numeric;
  }
  const temporal = canonicalTemporalValue(value);
  return temporal === null ? null : Date.parse(temporal.replace(' ', 'T'));
}

function rankingHolds(actualRows, primaryActualColumn, order, tolerance) {
  if (!primaryActualColumn) {
    return true;
  }
  const slack = tolerance > 0 ? tolerance : 1e-6;
  let previous = null;
  for (const row of actualRows) {
    const value = rankValueOf(row?.[primaryActualColumn]);
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

// column_order (see the comparison spec above): a listed gold column must not
// be carried by a column named like ANOTHER listed gold column, and the listed
// columns whose carrier is not named like them must keep the gold's relative
// SELECT-list order. A carrier named like its gold column identifies itself,
// so its position does not matter.
function columnOrderHolds(columnOrder, goldColumns, assignment, actualColumns) {
  const listed = columnOrder
    .map((goldColumn) => ({ goldColumn, carrier: assignment[goldColumns.indexOf(goldColumn)] }))
    .filter((entry) => goldColumns.includes(entry.goldColumn));
  let previousPosition = -1;
  for (const { goldColumn, carrier } of listed) {
    if (isColumnNamedLike(goldColumn, carrier)) {
      continue;
    }
    if (listed.some((other) => other.goldColumn !== goldColumn && isColumnNamedLike(other.goldColumn, carrier))) {
      return false;
    }
    const position = actualColumns.indexOf(carrier);
    if (position <= previousPosition) {
      return false;
    }
    previousPosition = position;
  }
  return true;
}

function legacyOutcome(expected, actual) {
  const match = compareRows(expected, actual);
  const goldColumns = Object.keys(expected[0] ?? {});
  if (!match) {
    return {
      match,
      goldColumns,
      assignments: [],
      reason: expected.length !== actual.length ? 'row_count' : 'values',
      truncated: false,
      empty: false,
    };
  }
  const actualByLowerName = new Map(Object.keys(actual[0] ?? {}).map((column) => [column.toLowerCase(), column]));
  return {
    match,
    goldColumns,
    assignments: expected.length > 0 ? [goldColumns.map((column) => actualByLowerName.get(column.toLowerCase()) ?? column)] : [],
    reason: 'match',
    truncated: false,
    empty: expected.length === 0,
  };
}

/**
 * Every valid gold-column -> prediction-column assignment (up to `limit`) under
 * a case's comparison spec. Returns
 * `{ match, goldColumns, assignments, reason, truncated, empty }` where each
 * assignment is an array of prediction column names aligned with
 * `goldColumns`, and `reason` is 'match' or the first failed requirement:
 * 'row_count', 'missing_columns', 'values', 'column_order', 'scalar_column' or
 * 'ranking' ('values' also covers the legacy exact-row comparison). `empty`
 * marks two empty results, which match under any assignment. The multi-fixture
 * oracle intersects these sets so one column mapping must hold on every
 * fixture.
 */
export function matchResultSets(expectedRows, actualRows, comparison = null, { limit = MAX_ASSIGNMENTS } = {}) {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const actual = Array.isArray(actualRows) ? actualRows : [];

  if (!comparison || typeof comparison !== 'object') {
    return legacyOutcome(expected, actual);
  }

  const goldColumns =
    Array.isArray(comparison.compare_columns) && comparison.compare_columns.length > 0
      ? comparison.compare_columns
      : Object.keys(expected[0] ?? {});
  const fail = (reason) => ({ match: false, goldColumns, assignments: [], reason, truncated: false, empty: false });

  if (expected.length !== actual.length) {
    return fail('row_count');
  }
  if (expected.length === 0 || goldColumns.length === 0) {
    return { match: true, goldColumns, assignments: [], reason: 'match', truncated: false, empty: true };
  }

  const actualColumns = Object.keys(actual[0] ?? {});
  if (actualColumns.length < goldColumns.length) {
    return fail('missing_columns');
  }

  const tolerance = toComparableNumber(comparison.tolerance) ?? 0;
  const decimals = Number.isInteger(comparison.decimals) ? comparison.decimals : DEFAULT_DECIMALS;
  const mode = comparison.mode || 'rowset';
  const order = String(comparison.order || 'desc').toLowerCase();
  const columnOrder = Array.isArray(comparison.column_order) ? comparison.column_order : [];
  const nullAsZero = new Set(Array.isArray(comparison.null_as_zero) ? comparison.null_as_zero : []);
  const scalarSingleValue = mode === 'scalar' && expected.length === 1 && goldColumns.length === 1;

  const goldCells = goldColumns.map((column) => describeColumn(expected, column, decimals, { nullAsZero: nullAsZero.has(column) }));
  const actualCells = new Map(actualColumns.map((column) => [column, describeColumn(actual, column, decimals)]));
  const actualCellsNullAsZero = new Map(
    nullAsZero.size > 0 ? actualColumns.map((column) => [column, describeColumn(actual, column, decimals, { nullAsZero: true })]) : []
  );
  // Prediction cells as seen by gold column `goldIndex` (NULL read as 0 when
  // that gold column is listed in null_as_zero).
  const cellsFor = (goldIndex, column) =>
    (nullAsZero.has(goldColumns[goldIndex]) ? actualCellsNullAsZero : actualCells).get(column);
  const goldTuples = expected.map((_row, rowIndex) => goldCells.map((cells) => cells[rowIndex]));

  const valueColumns =
    Array.isArray(comparison.value_columns) && comparison.value_columns.length > 0
      ? comparison.value_columns
      : goldColumns.filter((column) => isTrulyNumericColumn(expected, column));
  const primaryValueIndex = valueColumns.length > 0 ? goldColumns.indexOf(valueColumns[0]) : -1;

  // Name pinning: a gold column whose exact name (ignoring case and
  // punctuation) appears on exactly one prediction column may only be carried
  // by that column, and that column carries no other gold column. A wrong
  // headline column can then not pass on the strength of an incidental extra
  // column that happens to hold the gold values.
  const pinned = goldColumns.map((goldColumn) => {
    const sameName = actualColumns.filter((column) => isSameColumnName(goldColumn, column));
    return sameName.length === 1 ? sameName[0] : null;
  });
  const pinnedColumns = new Set(pinned.filter(Boolean));
  const candidates = goldCells.map((cells, goldIndex) =>
    (pinned[goldIndex] ? [pinned[goldIndex]] : actualColumns.filter((column) => !pinnedColumns.has(column))).filter((column) =>
      columnsCompatible(cells, cellsFor(goldIndex, column), tolerance)
    )
  );

  const assignments = [];
  const failures = { values: true, column_order: true, scalar_column: true, ranking: true };
  let steps = 0;
  let truncated = false;
  const used = new Set();
  const current = [];

  const accept = (assignment) => {
    const actualTuples = actual.map((_row, rowIndex) => assignment.map((column, goldIndex) => cellsFor(goldIndex, column)[rowIndex]));
    if (!matchRowsUnordered(goldTuples, actualTuples, tolerance)) {
      return;
    }
    failures.values = false;
    if (columnOrder.length > 0 && !columnOrderHolds(columnOrder, goldColumns, assignment, actualColumns)) {
      return;
    }
    failures.column_order = false;
    if (scalarSingleValue && !scalarRuleHolds(goldColumns[0], assignment[0], actual[0], actualColumns)) {
      return;
    }
    failures.scalar_column = false;
    if (mode === 'ranked' && primaryValueIndex !== -1 && !rankingHolds(actual, assignment[primaryValueIndex], order, tolerance)) {
      return;
    }
    failures.ranking = false;
    assignments.push(assignment.slice());
  };

  (function backtrack(index) {
    if (assignments.length >= limit || truncated) {
      return;
    }
    if ((steps += 1) > MAX_ASSIGNMENT_STEPS) {
      truncated = true;
      return;
    }
    if (index === goldColumns.length) {
      accept(current);
      return;
    }
    for (const column of candidates[index]) {
      if (used.has(column)) {
        continue;
      }
      used.add(column);
      current.push(column);
      backtrack(index + 1);
      current.pop();
      used.delete(column);
      if (assignments.length >= limit) {
        truncated = true;
        return;
      }
    }
  })(0);

  const match = assignments.length > 0;
  const reason = match
    ? 'match'
    : failures.values
      ? 'values'
      : failures.column_order
        ? 'column_order'
        : failures.scalar_column
          ? 'scalar_column'
          : 'ranking';
  return { match, goldColumns, assignments, reason, truncated, empty: false };
}

/**
 * Value-aware comparison with an explanation: `{ match, assignment, reason }`.
 * `assignment` maps each compared gold column to the prediction column that
 * carries it (null when nothing matched; `{}` for two empty results).
 */
export function compareResultsDetailed(expectedRows, actualRows, comparison = null) {
  const outcome = matchResultSets(expectedRows, actualRows, comparison, { limit: 1 });
  const [first] = outcome.assignments;
  return {
    match: outcome.match,
    assignment: first
      ? Object.fromEntries(outcome.goldColumns.map((column, index) => [column, first[index]]))
      : outcome.match
        ? {}
        : null,
    reason: outcome.reason,
  };
}

export function compareResults(expectedRows, actualRows, comparison = null) {
  return compareResultsDetailed(expectedRows, actualRows, comparison).match;
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
  const columnOrder = uniqueStrings(comparison.column_order);
  const nullAsZero = uniqueStrings(comparison.null_as_zero);
  if (compareColumns.length > 0) {
    normalized.compare_columns = compareColumns;
  }
  if (valueColumns.length > 0) {
    normalized.value_columns = valueColumns;
  }
  if (columnOrder.length > 0) {
    normalized.column_order = columnOrder;
  }
  if (nullAsZero.length > 0) {
    normalized.null_as_zero = nullAsZero;
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
