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

// Dataset splits: `dev` cases are the ones the prompt rules and the semantic
// layer were tuned on; `holdout` cases (new intents, and wording the semantic
// layer does not contain) estimate how the product does on what it was not
// tuned for. A case without a split is dev.
export const CASE_SPLITS = Object.freeze(['dev', 'holdout']);

// What a correct product does with a case: answer it with SQL (scored against
// the gold), abstain (the data cannot answer it: no gold SQL), or ask a
// clarifying question (the question is ambiguous: no gold SQL). Behaviour
// cases are reported on their own and never count in strict accuracy.
export const EXPECTED_BEHAVIORS = Object.freeze(['answer', 'abstain', 'clarify']);

export function isBehaviorCase(testCase) {
  return Boolean(testCase?.expected_behavior) && testCase.expected_behavior !== 'answer';
}

/**
 * Every raw (not yet normalized) case whose split is not one of CASE_SPLITS,
 * as [{ id, split }], so a verifier can name them all instead of stopping at
 * the first one normalizeBenchmarkCase throws on.
 */
export function findInvalidSplits(rawCases) {
  return (Array.isArray(rawCases) ? rawCases : [])
    .filter((testCase) => {
      const value = testCase?.split;
      return !(value === undefined || value === null || value === '') && !CASE_SPLITS.includes(String(value).trim().toLowerCase());
    })
    .map((testCase) => ({ id: String(testCase?.id ?? '?'), split: testCase.split }));
}

function normalizeSplit(value, id) {
  if (value === undefined || value === null || value === '') {
    return 'dev';
  }
  const split = String(value).trim().toLowerCase();
  if (!CASE_SPLITS.includes(split)) {
    throw new Error(`Benchmark case ${id} has split "${value}"; use one of ${CASE_SPLITS.join(', ')}.`);
  }
  return split;
}

function normalizeExpectedBehavior(value, id) {
  if (value === undefined || value === null || value === '') {
    return 'answer';
  }
  const behavior = String(value).trim().toLowerCase();
  if (!EXPECTED_BEHAVIORS.includes(behavior)) {
    throw new Error(`Benchmark case ${id} has expected_behavior "${value}"; use one of ${EXPECTED_BEHAVIORS.join(', ')}.`);
  }
  return behavior;
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

  const split = normalizeSplit(testCase.split, id);
  const expectedBehavior = normalizeExpectedBehavior(testCase.expected_behavior, id);
  const knownValidatorRejection = testCase.known_validator_rejection ? String(testCase.known_validator_rejection).trim() : null;

  if (expectedBehavior !== 'answer') {
    // No SQL is a correct answer to an abstain or clarify case, so there is
    // nothing to score against: a gold here would be ignored, so it is an error.
    const stray = ['expected_sql', 'alternative_expected_sql', 'comparison', 'expected_row_counts', 'known_validator_rejection'].filter((field) => {
      const value = testCase[field];
      return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
    });
    if (stray.length > 0) {
      throw new Error(`Benchmark case ${id} expects behavior "${expectedBehavior}" and must not carry ${stray.join(', ')}.`);
    }
    return {
      ...testCase,
      id,
      intentId: String(testCase.intentId || id).trim(),
      split,
      expected_behavior: expectedBehavior,
      question,
      canonicalQuestion: String(testCase.canonicalQuestion || question).trim(),
      difficulty: testCase.difficulty || null,
      tags: uniqueStrings(testCase.tags),
      expected_sql: '',
      expected_tables: uniqueStrings(testCase.expected_tables),
      expected_columns: [],
      disallowed_columns: [],
      signal_checks: null,
      comparison: null,
      alternative_expected_sql: [],
      expected_row_counts: null,
      known_validator_rejection: null,
      failure_class: testCase.failure_class || null,
    };
  }

  if (!expectedSql) {
    throw new Error(`Benchmark case ${id} is missing expected_sql.`);
  }

  return {
    ...testCase,
    id,
    intentId: String(testCase.intentId || id).trim(),
    split,
    expected_behavior: expectedBehavior,
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
    known_validator_rejection: knownValidatorRejection,
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
  if (isBehaviorCase(testCase)) {
    return [];
  }
  return [
    { label: 'expected_sql', sql: testCase.expected_sql },
    ...(testCase.alternative_expected_sql || []).map((sql, index) => ({ label: `alternative_expected_sql[${index}]`, sql })),
  ];
}

// The row-count token of a query's outermost LIMIT (`LIMIT n`, `LIMIT offset,
// n`, `LIMIT n OFFSET m`) and its value, or null when there is no LIMIT at
// paren depth 0 or its count is not a literal. A LIMIT inside a subquery or
// CTE does not count, and neither does text in strings or comments.
function locateTopLevelLimitCount(sql) {
  let tokens;
  try {
    tokens = tokenizeSql(String(sql ?? ''), { tolerant: true });
  } catch {
    return null;
  }
  const significant = tokens.filter((token) => !['whitespace', 'comment', 'executable_comment'].includes(token.type));
  let depth = 0;
  let limitAt = -1;
  significant.forEach((token, index) => {
    if (token.type === 'punct' && token.value === '(') {
      depth += 1;
    } else if (token.type === 'punct' && token.value === ')') {
      depth -= 1;
    } else if (depth === 0 && isKeywordToken(token, 'LIMIT')) {
      limitAt = index;
    }
  });
  if (limitAt === -1) {
    return null;
  }
  const separator = significant[limitAt + 2];
  const token = significant[separator?.type === 'punct' && separator.value === ',' ? limitAt + 3 : limitAt + 1];
  return token?.type === 'number' && /^\d+$/.test(token.value) ? { token, count: Number(token.value) } : null;
}

/**
 * Row count of a query's outermost LIMIT (`LIMIT n`, `LIMIT offset, n`,
 * `LIMIT n OFFSET m`), or null when it has none at paren depth 0 or its count
 * is not a literal. A LIMIT inside a subquery or CTE does not count, and
 * neither does text in strings or comments.
 */
export function topLevelLimitRowCount(sql) {
  return locateTopLevelLimitCount(sql)?.count ?? null;
}

/**
 * The same query with its outermost LIMIT's row count replaced by `count`
 * (its offset, if any, kept), or null when topLevelLimitRowCount finds none.
 */
export function withTopLevelLimitRowCount(sql, count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`count must be a non-negative integer; got ${count}.`);
  }
  const located = locateTopLevelLimitCount(sql);
  if (!located) {
    return null;
  }
  const text = String(sql);
  return `${text.slice(0, located.token.start)}${count}${text.slice(located.token.end)}`;
}

/**
 * The gold was cut by its own LIMIT: it returned as many rows as its outermost
 * LIMIT allows, so items tied with its last row may have been left out. A gold
 * with fewer rows, or without a LIMIT, holds every item. Being cut is not yet
 * a tie: the oracle runs such a gold past its LIMIT to find the rows it left
 * out (ties at the cut-off in the comparison spec).
 */
export function isCutByLimit(sql, rowCount) {
  const limit = topLevelLimitRowCount(sql);
  return limit !== null && limit > 0 && rowCount >= limit;
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
// - ties at the cut-off (ranked only, and only when the caller passes
//   `goldTies`: the rows the gold's own LIMIT left out, see isCutByLimit):
//   the gold rows whose ranking values (every value column) equal its last
//   row's are the boundary, and the left-out rows with those same ranking
//   values are its ties. A LIMIT through a group of tied items keeps
//   whichever of them its tiebreak (or, without one, MariaDB's execution
//   plan) puts first, so another of those items is as correct. When the gold
//   has ties, each prediction row with the boundary's ranking values must
//   equal, by its full tuple, a distinct row of (boundary rows + ties): the
//   number of boundary-valued rows must agree and each must be a real tied
//   item, listed once. Every row above the boundary still pairs by its full
//   tuple, and the ranking must still hold. Without ties (no rows left out
//   share the boundary value, or the gold returned fewer rows than its LIMIT,
//   or has none) the comparison is strict: another label at the last value
//   is an item that does not belong there.
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
//   (a conditional SUM without ELSE 0 returns NULL for a month with no sales),
//   in the ranking check too: a ranked metric listed here is ranked with its
//   NULLs as 0, the values it was matched with.
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
// Upper bound on the partial assignments findSharedAssignment tries; past it
// the search fails closed ('assignment_search_exhausted').
const MAX_SHARED_ASSIGNMENT_STEPS = 20000;

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

// Is every key of `subset` in `superset`, counting repeats? Both sorted.
function containsSortedKeys(superset, subset) {
  let index = 0;
  for (const key of subset) {
    while (index < superset.length && superset[index] < key) {
      index += 1;
    }
    if (index >= superset.length || superset[index] !== key) {
      return false;
    }
    index += 1;
  }
  return true;
}

// Necessary condition for pairing each of `goldCells` with a distinct equal
// cell of the prediction column (an injection, not a bijection): the gold
// rows above a cut-off's boundary must all appear in a carrier, which may
// hold other items at the boundary. With a tolerance each gold number takes
// the smallest unused prediction number within it; the windows all have the
// same width, so this greedy pass finds an injection whenever one exists.
function columnContains(goldCells, actualCells, tolerance) {
  for (const kind of ['null', 'time', 'text']) {
    if (!containsSortedKeys(sortedKeys(actualCells, kind), sortedKeys(goldCells, kind))) {
      return false;
    }
  }
  if (tolerance <= 0) {
    return containsSortedKeys(sortedKeys(actualCells, 'num'), sortedKeys(goldCells, 'num'));
  }
  const goldNumbers = goldCells.filter((cell) => cell.kind === 'num').map((cell) => cell.num).sort((a, b) => a - b);
  const actualNumbers = actualCells.filter((cell) => cell.kind === 'num').map((cell) => cell.num).sort((a, b) => a - b);
  let index = 0;
  for (const value of goldNumbers) {
    while (index < actualNumbers.length && actualNumbers[index] < value - tolerance - 1e-9) {
      index += 1;
    }
    if (index >= actualNumbers.length || actualNumbers[index] > value + tolerance + 1e-9) {
      return false;
    }
    index += 1;
  }
  return true;
}

function tupleKey(tuple) {
  return tuple.map((cell) => cell.key).join('\u0001');
}

// Ties at the cut-off (see the comparison spec): which gold rows have the
// ranking values (the cells at `rankIndexes`) of the gold's last row.
function boundaryRowFlags(goldTuples, rankIndexes, tolerance) {
  const last = goldTuples[goldTuples.length - 1];
  return goldTuples.map((tuple) => rankIndexes.every((index) => cellsEqual(tuple[index], last[index], tolerance)));
}

// matchRowsUnordered for a gold cut through a tie: every gold row above the
// boundary pairs with an equal prediction tuple, and every other prediction
// row with a distinct equal tuple of the pool (the gold's boundary rows plus
// its ties, all with the boundary's ranking values). Without a tolerance
// equality is exact, so a prediction row with the boundary's ranking values
// can only pair with a pool row and every other row only with a row above
// the boundary: the rest must be the same multiset of tuples as the gold's
// rows above the boundary, and the boundary-valued rows (as many as the
// gold's, since the lengths agree) a sub-multiset of the pool. With a
// tolerance it is a perfect matching (Hopcroft-Karp, as above) between the
// gold rows plus the ties and the prediction rows plus one stand-in per tie;
// a stand-in pairs with any pool row and so absorbs the pool rows the
// prediction did not pick, never a row above the boundary.
function matchRowsAcrossBoundary(goldTuples, actualTuples, isBoundary, tieTuples, rankIndexes, tolerance) {
  if (goldTuples.length !== actualTuples.length) {
    return false;
  }
  if (tolerance <= 0) {
    const rankKey = (tuple) => rankIndexes.map((index) => tuple[index].key).join('\u0001');
    const boundaryKey = rankKey(goldTuples[goldTuples.length - 1]);
    const goldAbove = goldTuples.filter((_tuple, index) => !isBoundary[index]).map(tupleKey).sort();
    const actualAbove = actualTuples.filter((tuple) => rankKey(tuple) !== boundaryKey).map(tupleKey).sort();
    const pool = [...goldTuples.filter((_tuple, index) => isBoundary[index]), ...tieTuples].map(tupleKey).sort();
    const actualAtBoundary = actualTuples.filter((tuple) => rankKey(tuple) === boundaryKey).map(tupleKey).sort();
    return sameList(goldAbove, actualAbove) && containsSortedKeys(pool, actualAtBoundary);
  }
  const tuplesEqual = (gold, actual) => gold.every((cell, index) => cellsEqual(cell, actual[index], tolerance));
  const standIns = tieTuples.map((_tuple, index) => actualTuples.length + index);
  const left = [...goldTuples.map((tuple, index) => ({ tuple, inPool: isBoundary[index] })), ...tieTuples.map((tuple) => ({ tuple, inPool: true }))];
  const adjacency = left.map(({ tuple, inPool }) => {
    const neighbours = [];
    actualTuples.forEach((actual, j) => {
      if (tuplesEqual(tuple, actual)) {
        neighbours.push(j);
      }
    });
    return inPool ? [...neighbours, ...standIns] : neighbours;
  });
  if (adjacency.some((neighbours) => neighbours.length === 0)) {
    return false;
  }
  return hasPerfectMatching(adjacency, actualTuples.length + standIns.length);
}

// Order-insensitive: is there a bijection (gold rows <-> actual rows) where every
// matched pair is cell-equal? Without a tolerance cell equality is an
// equivalence, so comparing sorted tuple keys is exact. With a tolerance it is
// not transitive (1.000 ~ 1.008 ~ 1.016), so the question is a perfect
// matching in the bipartite "within tolerance" graph: Hopcroft-Karp answers it
// exactly in O(E * sqrt(V)), with no step cap whose cut-off would read as
// 'values' (backtracking over near-duplicate rows used to hit one).
function matchRowsUnordered(goldTuples, actualTuples, tolerance) {
  if (goldTuples.length !== actualTuples.length) {
    return false;
  }
  if (tolerance <= 0) {
    return sameList(goldTuples.map(tupleKey).sort(), actualTuples.map(tupleKey).sort());
  }
  const tuplesEqual = (gold, actual) => gold.every((cell, index) => cellsEqual(cell, actual[index], tolerance));
  const adjacency = goldTuples.map((gold) => {
    const neighbours = [];
    actualTuples.forEach((actual, j) => {
      if (tuplesEqual(gold, actual)) {
        neighbours.push(j);
      }
    });
    return neighbours;
  });
  if (adjacency.some((neighbours) => neighbours.length === 0)) {
    return false;
  }
  return hasPerfectMatching(adjacency, actualTuples.length);
}

// Hopcroft-Karp: does the bipartite graph (left i -> adjacency[i], right
// 0..rightCount-1) have a matching that covers every left vertex?
function hasPerfectMatching(adjacency, rightCount) {
  const leftCount = adjacency.length;
  const matchLeft = new Array(leftCount).fill(-1);
  const matchRight = new Array(rightCount).fill(-1);
  const layer = new Array(leftCount).fill(0);
  let matched = 0;

  const buildLayers = () => {
    const queue = [];
    for (let i = 0; i < leftCount; i += 1) {
      layer[i] = matchLeft[i] === -1 ? 0 : Infinity;
      if (matchLeft[i] === -1) {
        queue.push(i);
      }
    }
    let reachesFree = false;
    for (let head = 0; head < queue.length; head += 1) {
      const i = queue[head];
      for (const j of adjacency[i]) {
        const next = matchRight[j];
        if (next === -1) {
          reachesFree = true;
        } else if (layer[next] === Infinity) {
          layer[next] = layer[i] + 1;
          queue.push(next);
        }
      }
    }
    return reachesFree;
  };

  const augment = (i) => {
    for (const j of adjacency[i]) {
      const next = matchRight[j];
      if (next === -1 || (layer[next] === layer[i] + 1 && augment(next))) {
        matchLeft[i] = j;
        matchRight[j] = i;
        return true;
      }
    }
    layer[i] = Infinity;
    return false;
  };

  while (buildLayers()) {
    for (let i = 0; i < leftCount; i += 1) {
      if (matchLeft[i] === -1 && augment(i)) {
        matched += 1;
      }
    }
  }
  return matched === leftCount;
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

// `nullAsZero`: the ranking column's gold column is listed in null_as_zero,
// so a NULL is ranked as the 0 it was matched as.
function rankingHolds(actualRows, primaryActualColumn, order, tolerance, { nullAsZero = false } = {}) {
  if (!primaryActualColumn) {
    return true;
  }
  const slack = tolerance > 0 ? tolerance : 1e-6;
  let previous = null;
  for (const row of actualRows) {
    const raw = row?.[primaryActualColumn];
    const value = rankValueOf(nullAsZero && (raw === null || raw === undefined) ? 0 : raw);
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

// Requirements an assignment must meet, in the order they are checked; the
// first one no assignment met is a mismatch's reason.
const ASSIGNMENT_REQUIREMENTS = ['values', 'column_order', 'scalar_column', 'ranking'];

// Everything needed to test gold-column -> prediction-column assignments for
// one (gold, prediction) pair under a comparison spec. Returns `{ outcome }`
// when the pair is decided without any assignment (legacy exact rows, row
// count, two empty results, missing columns), else
// `{ goldColumns, actualColumns, candidates, check, prefixHolds }`:
// - candidates[g]: prediction columns that may carry gold column g (name
//   pinning, and a per-column multiset check that every valid assignment meets);
// - check(assignment): null when the full assignment is valid, else the first
//   requirement it fails;
// - prefixHolds(partial): a necessary condition on the first gold columns'
//   carriers (their row tuples agree as multisets), or always true when a
//   tolerance makes that check unsound to prune with.
// `goldTies` (ranked mode only): the rows the gold's own LIMIT left out, in
// any order; those with the boundary's ranking values are its ties (see the
// spec above). With ties, the per-column and prefix checks require the gold
// rows above the boundary to appear in the prediction and the prediction's
// rows to appear among the gold rows plus the ties.
function prepareResultSetMatch(expected, actual, comparison, { goldTies = null } = {}) {
  if (!comparison || typeof comparison !== 'object') {
    return { outcome: legacyOutcome(expected, actual) };
  }

  const goldColumns =
    Array.isArray(comparison.compare_columns) && comparison.compare_columns.length > 0
      ? comparison.compare_columns
      : Object.keys(expected[0] ?? {});
  const fail = (reason) => ({ outcome: { match: false, goldColumns, assignments: [], reason, truncated: false, empty: false } });

  if (expected.length !== actual.length) {
    return fail('row_count');
  }
  if (expected.length === 0 || goldColumns.length === 0) {
    return { outcome: { match: true, goldColumns, assignments: [], reason: 'match', truncated: false, empty: true } };
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

  // Ties at the cut-off: the ranking columns (every value column the gold
  // compares), which gold rows share the last row's ranking values, and the
  // left-out rows that share them too. No ties, no relaxation.
  const rankIndexes =
    mode === 'ranked' && Array.isArray(goldTies) && goldTies.length > 0
      ? [...new Set(valueColumns.map((column) => goldColumns.indexOf(column)).filter((index) => index !== -1))]
      : [];
  let isBoundary = null;
  let tieTuples = [];
  if (rankIndexes.length > 0) {
    const last = goldTuples[goldTuples.length - 1];
    const tieCells = goldColumns.map((column) => describeColumn(goldTies, column, decimals, { nullAsZero: nullAsZero.has(column) }));
    tieTuples = goldTies
      .map((_row, rowIndex) => tieCells.map((cells) => cells[rowIndex]))
      .filter((tuple) => rankIndexes.every((index) => cellsEqual(tuple[index], last[index], tolerance)));
    isBoundary = tieTuples.length > 0 ? boundaryRowFlags(goldTuples, rankIndexes, tolerance) : null;
  }
  const aboveBoundary = (cells) => cells.filter((_cell, rowIndex) => !isBoundary[rowIndex]);
  const withTies = (cells, goldIndex) => [...cells, ...tieTuples.map((tuple) => tuple[goldIndex])];

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
  const compatible = (cells, goldIndex, column) =>
    isBoundary
      ? columnContains(aboveBoundary(cells), cellsFor(goldIndex, column), tolerance) &&
        columnContains(cellsFor(goldIndex, column), withTies(cells, goldIndex), tolerance)
      : columnsCompatible(cells, cellsFor(goldIndex, column), tolerance);
  const candidates = goldCells.map((cells, goldIndex) =>
    (pinned[goldIndex] ? [pinned[goldIndex]] : actualColumns.filter((column) => !pinnedColumns.has(column))).filter((column) =>
      compatible(cells, goldIndex, column)
    )
  );

  const check = (assignment) => {
    const actualTuples = actual.map((_row, rowIndex) => assignment.map((column, goldIndex) => cellsFor(goldIndex, column)[rowIndex]));
    const valuesMatch = isBoundary
      ? matchRowsAcrossBoundary(goldTuples, actualTuples, isBoundary, tieTuples, rankIndexes, tolerance)
      : matchRowsUnordered(goldTuples, actualTuples, tolerance);
    if (!valuesMatch) {
      return 'values';
    }
    if (columnOrder.length > 0 && !columnOrderHolds(columnOrder, goldColumns, assignment, actualColumns)) {
      return 'column_order';
    }
    if (scalarSingleValue && !scalarRuleHolds(goldColumns[0], assignment[0], actual[0], actualColumns)) {
      return 'scalar_column';
    }
    if (
      mode === 'ranked' &&
      primaryValueIndex !== -1 &&
      !rankingHolds(actual, assignment[primaryValueIndex], order, tolerance, { nullAsZero: nullAsZero.has(goldColumns[primaryValueIndex]) })
    ) {
      return 'ranking';
    }
    return null;
  };

  // Without a tolerance cell equality is exact, so any valid assignment's
  // first k carriers hold the gold's first k columns as the same multiset of
  // row tuples (the full bijection restricted to those columns). Across a
  // tie at the cut-off the gold rows above the boundary must be among the
  // prediction's restricted tuples, and those among the gold's plus the ties'.
  const prefixKey = (tuple, length) => tupleKey(tuple.slice(0, length));
  const prefixHolds =
    tolerance > 0
      ? () => true
      : (partial) => {
          const actualKeys = actual
            .map((_row, rowIndex) => tupleKey(partial.map((column, goldIndex) => cellsFor(goldIndex, column)[rowIndex])))
            .sort();
          if (!isBoundary) {
            return sameList(goldTuples.map((tuple) => prefixKey(tuple, partial.length)).sort(), actualKeys);
          }
          const aboveKeys = aboveBoundary(goldTuples).map((tuple) => prefixKey(tuple, partial.length)).sort();
          const poolKeys = [...goldTuples, ...tieTuples].map((tuple) => prefixKey(tuple, partial.length)).sort();
          return containsSortedKeys(actualKeys, aboveKeys) && containsSortedKeys(poolKeys, actualKeys);
        };

  return { goldColumns, actualColumns, candidates, check, prefixHolds };
}

/**
 * Every valid gold-column -> prediction-column assignment (up to `limit`) under
 * a case's comparison spec. Returns
 * `{ match, goldColumns, assignments, reason, truncated, empty }` where each
 * assignment is an array of prediction column names aligned with
 * `goldColumns`, and `reason` is 'match' or the first failed requirement:
 * 'row_count', 'missing_columns', 'values', 'column_order', 'scalar_column' or
 * 'ranking' ('values' also covers the legacy exact-row comparison), or
 * 'assignment_search_exhausted' when the step bound stopped the search before
 * any valid assignment was found (never a match). `empty` marks two empty
 * results, which match under any assignment. `truncated` means the list may
 * be incomplete; the multi-fixture oracle never relies on it and uses
 * findSharedAssignment for its one-mapping rule. `goldTies`: the rows the
 * gold's own LIMIT left out (isCutByLimit); in ranked mode those tied with the
 * gold's last ranking value may stand in for its boundary rows (ties at the
 * cut-off, see the spec).
 */
export function matchResultSets(expectedRows, actualRows, comparison = null, { limit = MAX_ASSIGNMENTS, goldTies = null } = {}) {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const actual = Array.isArray(actualRows) ? actualRows : [];
  const prepared = prepareResultSetMatch(expected, actual, comparison, { goldTies });
  if (prepared.outcome) {
    return prepared.outcome;
  }
  const { goldColumns, candidates, check } = prepared;

  const assignments = [];
  const failures = { values: true, column_order: true, scalar_column: true, ranking: true };
  let steps = 0;
  let truncated = false;
  let exhausted = false;
  const used = new Set();
  const current = [];

  const accept = (assignment) => {
    const failed = check(assignment);
    for (const requirement of ASSIGNMENT_REQUIREMENTS) {
      if (requirement === failed) {
        return;
      }
      failures[requirement] = false;
    }
    assignments.push(assignment.slice());
  };

  (function backtrack(index) {
    if (assignments.length >= limit || truncated) {
      return;
    }
    if ((steps += 1) > MAX_ASSIGNMENT_STEPS) {
      truncated = true;
      exhausted = true;
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
    : exhausted
      ? 'assignment_search_exhausted'
      : ASSIGNMENT_REQUIREMENTS.find((requirement) => failures[requirement]) || 'ranking';
  return { match, goldColumns, assignments, reason, truncated, empty: false };
}

/**
 * The multi-fixture one-mapping rule: ONE gold-column -> prediction-column
 * assignment that is valid on every (gold, prediction) pair at once (one pair
 * per fixture, all from the same prediction SQL). Pairs of two empty results
 * match under any assignment and do not constrain it. A pair's `goldTies`
 * holds the rows its gold's own LIMIT left out (see matchResultSets).
 *
 * The search intersects each gold column's candidate carriers over the pairs,
 * then backtracks, pruning a partial assignment as soon as its row tuples
 * disagree with the gold on some pair, and checks every full assignment on
 * every pair. It never infers consistency from per-pair results.
 *
 * Returns `{ match, goldColumns, assignment, reason }`: `assignment` is an
 * array aligned with `goldColumns` (empty when no pair constrains it, null
 * without a match); `reason` is 'match', a pair's own mismatch reason when it
 * cannot match at all, 'inconsistent_assignment' (no single assignment fits
 * every pair) or 'assignment_search_exhausted' (the search hit `maxSteps`
 * before deciding; fails closed, never a match).
 */
export function findSharedAssignment(pairs, comparison = null, { maxSteps = MAX_SHARED_ASSIGNMENT_STEPS } = {}) {
  const prepared = pairs.map(({ expected, actual, goldTies = null }) =>
    prepareResultSetMatch(Array.isArray(expected) ? expected : [], Array.isArray(actual) ? actual : [], comparison, { goldTies })
  );
  const goldColumns = prepared.map((entry) => entry.goldColumns ?? entry.outcome.goldColumns).find((columns) => columns.length > 0) ?? [];
  const decided = prepared.filter((entry) => entry.outcome);
  const failed = decided.find((entry) => !entry.outcome.match);
  if (failed) {
    return { match: false, goldColumns, assignment: null, reason: failed.outcome.reason };
  }

  // Legacy exact-row pairs carry their one (name-based) assignment.
  const legacy = decided.filter((entry) => !entry.outcome.empty).map((entry) => entry.outcome.assignments[0]);
  const searchable = prepared.filter((entry) => !entry.outcome);
  if (searchable.length === 0) {
    if (legacy.length === 0) {
      return { match: true, goldColumns, assignment: [], reason: 'match' };
    }
    const consistent = legacy.every((assignment) => sameList(assignment, legacy[0]));
    return consistent
      ? { match: true, goldColumns, assignment: legacy[0].slice(), reason: 'match' }
      : { match: false, goldColumns, assignment: null, reason: 'inconsistent_assignment' };
  }

  const [first] = searchable;
  const candidateSets = searchable.map((entry) => entry.candidates.map((columns) => new Set(columns)));
  const candidates = first.candidates.map((columns, goldIndex) => columns.filter((column) => candidateSets.every((sets) => sets[goldIndex].has(column))));

  let steps = 0;
  let exhausted = false;
  const used = new Set();
  const current = [];
  const search = (index) => {
    if (index === first.goldColumns.length) {
      return searchable.every((entry) => entry.check(current) === null) ? current.slice() : null;
    }
    for (const column of candidates[index]) {
      if (used.has(column)) {
        continue;
      }
      if ((steps += 1) > maxSteps) {
        exhausted = true;
        return null;
      }
      current.push(column);
      if (searchable.every((entry) => entry.prefixHolds(current))) {
        used.add(column);
        const found = search(index + 1);
        used.delete(column);
        if (found || exhausted) {
          current.pop();
          return found;
        }
      }
      current.pop();
    }
    return null;
  };

  const assignment = search(0);
  if (assignment) {
    return { match: true, goldColumns: first.goldColumns, assignment, reason: 'match' };
  }
  return { match: false, goldColumns: first.goldColumns, assignment: null, reason: exhausted ? 'assignment_search_exhausted' : 'inconsistent_assignment' };
}

/**
 * Value-aware comparison with an explanation: `{ match, assignment, reason }`.
 * `assignment` maps each compared gold column to the prediction column that
 * carries it (null when nothing matched; `{}` for two empty results).
 * `goldTies`: the rows the gold's own LIMIT left out (see matchResultSets).
 */
export function compareResultsDetailed(expectedRows, actualRows, comparison = null, { goldTies = null } = {}) {
  const outcome = matchResultSets(expectedRows, actualRows, comparison, { limit: 1, goldTies });
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

export function compareResults(expectedRows, actualRows, comparison = null, options = {}) {
  return compareResultsDetailed(expectedRows, actualRows, comparison, options).match;
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
