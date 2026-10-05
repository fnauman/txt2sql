// Multi-fixture (test-suite) oracle: a prediction is correct only when it
// returns the gold answer on EVERY fixture database (Zhong et al. 2020). The
// fixtures share master data and differ in facts (src/eval/fixtures.js), so
// SQL that merely coincides with the gold on one dataset is caught on another.
//
// Rules, all applied per case:
// - Gold variants: the gold SQL plus any `alternative_expected_sql` (readings
//   the dataset accepts as equally correct). A prediction must match ONE
//   variant on every fixture; mixing readings across fixtures does not count.
// - One column mapping: the comparator's gold -> prediction column assignment
//   must be the same on every fixture (the same SQL means the same columns).
//   findSharedAssignment searches for one mapping valid on every fixture at
//   once; a search cut off by its step bound fails closed
//   ('assignment_search_exhausted'), never a pass.
// - Gold runs with its own generous timeout (GOLD_STATEMENT_TIMEOUT_MS) so a
//   slow gold never looks like a model failure, and is cached per fixture.
// - The prediction runs as the read-only query user with the statement timeout
//   and a row cap of (largest gold row count + 1): more rows than the gold is
//   already a mismatch, so nothing beyond that is ever read.
// - Signal checks (resolved through the assignment) and the disallowed-column
//   lint are reported as warnings; they never change the verdict.

import {
  findDisallowedColumnsUsed,
  findSharedAssignment,
  listGoldVariants,
  matchResultSets,
  runSignalChecksThroughAssignment,
} from '../benchmark.js';
import { createMariaDbConnection, executeReadOnlySql } from '../pipeline.js';
import { errorCodeOf } from '../query-service.js';
import { isEvalInfraError } from './infra-errors.js';
import { FIXTURES } from './fixtures.js';

export const GOLD_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * One query-role connection per fixture, as `[{ name, database, connection }]`
 * in fixture order. The first entry is where the product loop runs.
 */
export async function openFixtureConnections({
  fixtures = FIXTURES,
  env = process.env,
  connect = createMariaDbConnection,
  role = 'query',
} = {}) {
  const opened = [];
  try {
    for (const fixture of fixtures) {
      try {
        const connection = await connect({ role, env: { ...env, DB_NAME: fixture.database } });
        opened.push({ name: fixture.name, database: fixture.database, connection });
      } catch (error) {
        if (error?.code === 'ER_BAD_DB_ERROR' || error?.code === 'ER_DBACCESS_DENIED_ERROR') {
          const wrapped = new Error(
            `Fixture "${fixture.name}" (database ${fixture.database}) is not available: ${error.message} ` +
              'Run "npm run seed-fixtures" (admin credentials) to create every fixture database.',
            { cause: error }
          );
          wrapped.code = error.code;
          throw wrapped;
        }
        throw error;
      }
    }
  } catch (error) {
    await closeFixtureConnections(opened);
    throw error;
  }
  return opened;
}

export async function closeFixtureConnections(connections) {
  await Promise.allSettled((connections || []).map((entry) => entry.connection?.end?.()));
}

export function createGoldCache() {
  return new Map();
}

export class GoldSqlError extends Error {
  constructor(message, { fixture, label, cause }) {
    super(message, { cause });
    this.name = 'GoldSqlError';
    this.code = 'GOLD_SQL_ERROR';
    this.fixture = fixture;
    this.label = label;
  }
}

/** Gold rows on one fixture, cached by (fixture, SQL). Throws GoldSqlError. */
export async function executeGoldSql(fixtureConnection, sql, { goldCache = null, timeoutMs = GOLD_STATEMENT_TIMEOUT_MS, label = 'expected_sql' } = {}) {
  const key = `${fixtureConnection.name}\u0000${sql}`;
  if (goldCache?.has(key)) {
    return goldCache.get(key);
  }
  const pending = executeReadOnlySql(fixtureConnection.connection, sql, { timeoutMs }).catch((error) => {
    goldCache?.delete(key);
    throw new GoldSqlError(`Gold SQL (${label}) failed on fixture ${fixtureConnection.name}: ${error.message}`, {
      fixture: fixtureConnection.name,
      label,
      cause: error,
    });
  });
  goldCache?.set(key, pending);
  return pending;
}

function describeError(error) {
  return {
    code: errorCodeOf(error),
    message: error?.message || String(error),
    infra: isEvalInfraError(error),
  };
}

async function executePrediction(fixtureConnection, sql, { timeoutMs, maxRows }) {
  try {
    const rows = await executeReadOnlySql(fixtureConnection.connection, sql, { timeoutMs, maxRows });
    return { rows, truncated: Array.isArray(rows) && rows.length >= maxRows, error: null };
  } catch (error) {
    return { rows: null, truncated: false, error: describeError(error) };
  }
}

function toAssignmentObject(goldColumns, assignment) {
  return assignment?.length ? Object.fromEntries(goldColumns.map((column, index) => [column, assignment[index]])) : null;
}

/**
 * Scores a predicted SQL against a case's gold on every fixture connection.
 *
 * Returns { match, matchedGold, perFixture, assignment, signalWarnings,
 * disallowedWarnings, variants, killedOn, executionError, infraError }:
 * - perFixture: [{ fixture, match, matchAny, reason, goldRowCount,
 *   actualRowCount, truncated, error }] for the matched gold variant (else
 *   for expected_sql); `matchAny` = some variant matches on this fixture alone.
 * - killedOn: fixtures on which no gold variant matches (who caught it).
 * - assignment: gold column -> prediction column of the match (null if none).
 * - reason: 'match', the first per-fixture mismatch reason, or, when every
 *   fixture matches alone, 'inconsistent_assignment' (no one mapping fits
 *   every fixture) or 'assignment_search_exhausted' (the bounded search gave
 *   up; never a pass).
 * Throws GoldSqlError when a gold variant itself fails.
 */
export async function scoreAgainstGold({
  testCase,
  predictedSql,
  connections,
  goldCache = createGoldCache(),
  timeoutMs = null,
  goldTimeoutMs = GOLD_STATEMENT_TIMEOUT_MS,
  schema = null,
} = {}) {
  if (!Array.isArray(connections) || connections.length === 0) {
    throw new Error('scoreAgainstGold needs at least one fixture connection.');
  }

  const variants = listGoldVariants(testCase);
  const comparison = testCase.comparison ?? null;

  // Gold rows: [variant][fixture].
  const goldRows = await Promise.all(
    variants.map((variant) =>
      Promise.all(
        connections.map((fixtureConnection) =>
          executeGoldSql(fixtureConnection, variant.sql, { goldCache, timeoutMs: goldTimeoutMs, label: variant.label })
        )
      )
    )
  );

  const predictions = await Promise.all(
    connections.map((fixtureConnection, fixtureIndex) => {
      const largestGold = Math.max(...goldRows.map((rowsByFixture) => rowsByFixture[fixtureIndex].length));
      return executePrediction(fixtureConnection, predictedSql, { timeoutMs, maxRows: largestGold + 1 });
    })
  );

  const scored = variants.map((variant, variantIndex) => {
    const outcomes = connections.map((fixtureConnection, fixtureIndex) => {
      const prediction = predictions[fixtureIndex];
      const gold = goldRows[variantIndex][fixtureIndex];
      if (prediction.error) {
        return { match: false, reason: 'execution_error', assignments: [], goldColumns: [], empty: false, truncated: false };
      }
      // Per-fixture verdict and reason; the shared mapping is searched below.
      return matchResultSets(gold, prediction.rows, comparison, { limit: 1 });
    });
    const allMatch = outcomes.every((outcome) => outcome.match);
    const shared = allMatch
      ? findSharedAssignment(
          connections.map((_fixtureConnection, fixtureIndex) => ({ expected: goldRows[variantIndex][fixtureIndex], actual: predictions[fixtureIndex].rows })),
          comparison
        )
      : null;
    const perFixture = connections.map((fixtureConnection, fixtureIndex) => ({
      fixture: fixtureConnection.name,
      match: outcomes[fixtureIndex].match,
      reason: outcomes[fixtureIndex].reason,
      goldRowCount: goldRows[variantIndex][fixtureIndex].length,
      actualRowCount: predictions[fixtureIndex].rows ? predictions[fixtureIndex].rows.length : null,
      truncated: predictions[fixtureIndex].truncated,
      error: predictions[fixtureIndex].error,
    }));
    return {
      label: variant.label,
      match: Boolean(shared?.match),
      reason: shared ? shared.reason : outcomes.find((outcome) => !outcome.match).reason,
      outcomes,
      assignment: shared?.match ? shared.assignment : null,
      perFixture,
    };
  });

  const matched = scored.find((variant) => variant.match) || null;
  const reported = matched || scored[0];
  const perFixture = reported.perFixture.map((entry, fixtureIndex) => ({
    ...entry,
    matchAny: scored.some((variant) => variant.outcomes[fixtureIndex].match),
  }));

  // Column mapping per fixture for the warnings: the match's consistent
  // mapping, else whatever the reported variant matched on that fixture.
  const goldColumns = reported.outcomes.find((outcome) => outcome.goldColumns?.length)?.goldColumns || [];
  const assignmentFor = (fixtureIndex) => {
    if (matched) {
      return toAssignmentObject(goldColumns, matched.assignment) || {};
    }
    const [first] = reported.outcomes[fixtureIndex].assignments || [];
    return toAssignmentObject(goldColumns, first);
  };

  const signalWarnings = [];
  if (testCase.signal_checks) {
    predictions.forEach((prediction, fixtureIndex) => {
      if (!prediction.rows) {
        return;
      }
      const result = runSignalChecksThroughAssignment(prediction.rows, testCase.signal_checks, assignmentFor(fixtureIndex));
      for (const failure of result.failures) {
        signalWarnings.push({ fixture: connections[fixtureIndex].name, ...failure });
      }
    });
  }

  const errors = predictions.map((prediction) => prediction.error).filter(Boolean);
  const reportedIndex = scored.indexOf(reported);
  return {
    // First rows on the primary fixture, for reports.
    preview: {
      gold: goldRows[reportedIndex][0].slice(0, 5),
      actual: predictions[0].rows ? predictions[0].rows.slice(0, 5) : [],
    },
    match: Boolean(matched),
    matchedGold: matched ? matched.label : null,
    reason: matched ? 'match' : reported.reason,
    perFixture,
    assignment: matched ? toAssignmentObject(goldColumns, matched.assignment) || {} : assignmentFor(0),
    signalWarnings,
    disallowedWarnings: findDisallowedColumnsUsed(predictedSql, testCase.disallowed_columns, { schema }),
    variants: scored.map(({ label, match, reason, perFixture: variantFixtures }) => ({ label, match, reason, perFixture: variantFixtures })),
    killedOn: perFixture.filter((entry) => !entry.matchAny).map((entry) => entry.fixture),
    executionError: errors[0] || null,
    infraError: errors.some((error) => error.infra),
  };
}
