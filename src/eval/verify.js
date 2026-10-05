// Dataset verification against every fixture, without any LLM call
// (scripts/verify-dataset.js). Per case:
// - gold health: the gold SQL and every alternative_expected_sql execute on
//   every fixture, match their per-fixture row-count pins, are self-consistent
//   under the case's comparison spec (whose column names must exist in the
//   gold result), pass the case's own signal checks, and pass the production
//   validator in the real optimized prompt context;
// - positive controls (correct alternatives) match the gold or an alternative
//   on every fixture AND pass the production validator;
// - negative controls (plausible-wrong SQL) are killed: they execute on every
//   fixture and fail to match on at least one (or break the one-reading /
//   one-mapping rules). Their kill rate measures the oracle. A control that
//   fails to execute is not a kill: an SQL error makes it an invalid control
//   and an infrastructure error leaves it unscored; both are problems (so
//   verify-dataset exits non-zero) and both stay in the kill-rate denominator
//   as not killed, so a broken control or a dropped connection can only
//   lower the reported rate, never raise it. Likewise a verdict that rests on
//   a column-mapping search cut off by its bound (the oracle fails closed,
//   which is right for a model's SQL) is undecided, not a kill: it is listed
//   and counts as not killed, like a survivor.

import {
  compareResults,
  listGoldVariants,
  resolveExpectedRowCount,
  runSignalChecks,
} from '../benchmark.js';
import { resolveMasterDataCandidates } from '../master-data-resolver.js';
import { buildOptimizedPrompt, buildSemanticPlan, validateReadOnlySql, validateSqlSafety } from '../pipeline.js';
import { resolveCaseControls } from './controls.js';
import { PRIMARY_FIXTURE } from './fixtures.js';
import { createGoldCache, executeGoldSql, GOLD_STATEMENT_TIMEOUT_MS, GoldSqlError, scoreAgainstGold } from './oracle.js';

/**
 * Validates SQL the way the product does for `question`: master-data
 * candidates from the primary fixture, the optimized prompt's table set and
 * context, and a response whose tables_used lists the SQL's own tables (what a
 * consistent model returns). Returns null when accepted, else the error.
 */
export function createValidatorProbe({ schema, connection = null }) {
  const prompts = new Map();
  const promptFor = async (question) => {
    if (!prompts.has(question)) {
      prompts.set(
        question,
        (async () => {
          const semanticPlan = buildSemanticPlan(question);
          let masterDataCandidates = [];
          if (connection) {
            try {
              masterDataCandidates = await resolveMasterDataCandidates({ connection, semanticPlan });
            } catch {
              masterDataCandidates = [];
            }
          }
          const prompt = buildOptimizedPrompt(schema, question, { masterDataCandidates, semanticPlan });
          return { context: prompt.context, allowedTables: prompt.tables.map((table) => table.tableName) };
        })()
      );
    }
    return prompts.get(question);
  };

  return async function validate(question, sql) {
    const { context, allowedTables } = await promptFor(question);
    try {
      let tablesUsed = [];
      try {
        tablesUsed = validateSqlSafety(sql, allowedTables).tablesUsed;
      } catch {
        tablesUsed = [];
      }
      validateReadOnlySql(sql, allowedTables, { promptContext: context, response: { sql, tables_used: tablesUsed } });
      return null;
    } catch (error) {
      return { code: error.code || null, layer: error.layer || null, message: error.message };
    }
  };
}

/**
 * Verdicts of a negative control: killed (executed on every fixture and did
 * not match), survived (matched), undecided (the mismatch rests on a
 * column-mapping search cut off by its bound), invalid (an SQL error such as
 * a bad column or a timeout on some fixture) or unscored (an infrastructure
 * error such as a dropped connection). Only `killed` counts as a kill.
 */
export const NEGATIVE_STATUS = Object.freeze({
  killed: 'killed',
  survived: 'survived',
  undecided: 'undecided',
  invalid: 'invalid',
  unscored: 'unscored',
});

const EXHAUSTED = 'assignment_search_exhausted';

// Some part of the oracle's verdict came from a search that gave up.
function restsOnExhaustedSearch(score) {
  return score.reason === EXHAUSTED || score.variants.some((variant) => variant.reason === EXHAUSTED || variant.perFixture.some((entry) => entry.reason === EXHAUSTED));
}

function goldColumnsOf(rows) {
  return Object.keys(rows?.[0] ?? {});
}

function checkComparisonColumns(testCase, rows, label, fixture) {
  if (!testCase.comparison || !rows || rows.length === 0) {
    return [];
  }
  const columns = new Set(goldColumnsOf(rows));
  const problems = [];
  for (const key of ['compare_columns', 'value_columns', 'column_order', 'null_as_zero']) {
    for (const column of testCase.comparison[key] || []) {
      if (!columns.has(column)) {
        problems.push(`comparison.${key} names "${column}", which ${label} does not return on ${fixture}`);
      }
    }
  }
  return problems;
}

/**
 * Verifies one normalized case. `connections` come from
 * openFixtureConnections (the first is the primary fixture).
 * Returns { id, problems, notes, goldRowCounts, controls }.
 */
export async function verifyCase(testCase, {
  connections,
  goldCache = createGoldCache(),
  validate = null,
  controlsIndex = null,
  checkControls = true,
} = {}) {
  const problems = [];
  const notes = [];
  const goldRowCounts = {};
  const variants = listGoldVariants(testCase);
  let goldFailed = false;

  for (const variant of variants) {
    for (const fixtureConnection of connections) {
      let rows;
      try {
        rows = await executeGoldSql(fixtureConnection, variant.sql, { goldCache, timeoutMs: GOLD_STATEMENT_TIMEOUT_MS, label: variant.label });
      } catch (error) {
        problems.push(error instanceof GoldSqlError ? error.message : `gold error on ${fixtureConnection.name}: ${error.message}`);
        goldFailed = true;
        continue;
      }
      const fixture = fixtureConnection.name;
      if (variant.label === 'expected_sql') {
        goldRowCounts[fixture] = rows.length;
        const pinned = resolveExpectedRowCount(testCase, fixture, { primaryFixture: PRIMARY_FIXTURE.name });
        if (pinned !== null && pinned !== rows.length) {
          problems.push(`${fixture}: expected ${pinned} row(s) but gold returned ${rows.length}`);
        }
      }
      if (!compareResults(rows, rows, testCase.comparison)) {
        problems.push(`${variant.label} is not self-consistent under its comparison spec on ${fixture}`);
      }
      problems.push(...checkComparisonColumns(testCase, rows, variant.label, fixture));
      const signal = runSignalChecks(rows, testCase.signal_checks);
      if (!signal.passed) {
        problems.push(`${variant.label} fails its signal_checks on ${fixture}: ${signal.failures.map((failure) => failure.code).join(', ')}`);
      }
    }
    if (validate) {
      const rejection = await validate(testCase.question, variant.sql);
      if (rejection) {
        problems.push(`${variant.label} is rejected by the production validator: ${rejection.code} (${rejection.layer}) ${rejection.message}`);
      }
    }
  }

  let controls = null;
  if (checkControls && controlsIndex && !goldFailed) {
    const resolved = resolveCaseControls(testCase, controlsIndex);
    if (resolved.stale) {
      problems.push(`controls ${resolved.source} were written for a different gold SQL (gold_fingerprint mismatch); review them`);
    }
    const positive = [];
    for (const control of resolved.positive) {
      const score = await scoreAgainstGold({ testCase, predictedSql: control.sql, connections, goldCache, goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS });
      const rejection = validate ? await validate(testCase.question, control.sql) : null;
      positive.push({ id: control.id, match: score.match, matchedGold: score.matchedGold, reason: score.reason, perFixture: score.perFixture, rejection });
      if (!score.match) {
        const where = score.perFixture.filter((entry) => !entry.match).map((entry) => `${entry.fixture}: ${entry.reason}`).join(', ');
        problems.push(`positive control ${control.id} does not match the gold on every fixture (${where || score.reason})`);
      }
      if (rejection) {
        if (control.validator_known_false_rejection) {
          notes.push(`positive control ${control.id}: known validator false rejection (${rejection.code})`);
        } else {
          problems.push(`positive control ${control.id} is rejected by the production validator: ${rejection.code} (${rejection.layer}) ${rejection.message}`);
        }
      }
    }
    const negative = [];
    for (const control of resolved.negative) {
      const score = await scoreAgainstGold({ testCase, predictedSql: control.sql, connections, goldCache, goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS });
      const errors = score.perFixture
        .filter((entry) => entry.error)
        .map((entry) => ({ fixture: entry.fixture, code: entry.error.code, message: entry.error.message, infra: entry.error.infra }));
      const status = errors.some((error) => error.infra)
        ? NEGATIVE_STATUS.unscored
        : errors.length > 0
          ? NEGATIVE_STATUS.invalid
          : score.match
            ? NEGATIVE_STATUS.survived
            : restsOnExhaustedSearch(score)
              ? NEGATIVE_STATUS.undecided
              : NEGATIVE_STATUS.killed;
      const killed = status === NEGATIVE_STATUS.killed;
      negative.push({
        id: control.id,
        type: control.type,
        heldout: control.heldout,
        note: control.note,
        status,
        killed,
        killedOn: killed ? score.killedOn : [],
        reason: score.reason,
        executionError: score.executionError,
        errors,
      });
      const where = errors.map((error) => `${error.fixture}: ${error.code} ${error.message}`).join('; ');
      if (status === NEGATIVE_STATUS.unscored) {
        problems.push(`negative control ${control.id} could not be scored: infrastructure error (${where}); not counted as killed`);
      } else if (status === NEGATIVE_STATUS.invalid) {
        problems.push(`negative control ${control.id} is invalid: it fails to execute (${where}); an error is not a kill, fix or remove it`);
      }
    }
    controls = { source: resolved.source, matchedBy: resolved.matchedBy, positive, negative };
  }

  return { id: testCase.id, problems, notes, goldRowCounts, controls };
}

function rate(killed, total) {
  return total === 0 ? null : Number((killed / total).toFixed(4));
}

/**
 * Kill-rate summary over verified cases:
 * { design, heldout, byType, byFixture, positive } where design/heldout are
 * { total, killed, rate, seedOnlyKilled, seedOnlyRate, survivors, undecided,
 * invalid, unscored, executionErrors }. `undecided` lists the controls whose
 * verdict rests on a mapping search cut off by its bound; `invalid` and
 * `unscored` list the controls that did not execute (SQL error /
 * infrastructure error). All three count in `total` as not killed, so they
 * can only lower `rate`.
 */
export function summarizeControls(caseResults, { fixtureNames = [], primaryFixture = PRIMARY_FIXTURE.name } = {}) {
  const negatives = [];
  const positives = [];
  for (const result of caseResults) {
    for (const control of result.controls?.negative || []) {
      negatives.push({ caseId: result.id, ...control });
    }
    for (const control of result.controls?.positive || []) {
      positives.push({ caseId: result.id, ...control });
    }
  }

  const statusOf = (control) => control.status ?? (control.killed ? NEGATIVE_STATUS.killed : NEGATIVE_STATUS.survived);
  const describe = (control) => `${control.caseId}/${control.id} (${control.type}${control.note ? `: ${control.note}` : ''})`;
  const describeErrors = (control) =>
    `${control.caseId}/${control.id} (${(control.errors || []).map((error) => `${error.fixture}: ${error.code}`).join(', ') || control.executionError?.code || 'error'})`;
  const group = (list) => {
    const killed = list.filter((control) => statusOf(control) === NEGATIVE_STATUS.killed).length;
    const seedOnlyKilled = list.filter((control) => statusOf(control) === NEGATIVE_STATUS.killed && control.killedOn.includes(primaryFixture)).length;
    return {
      total: list.length,
      killed,
      rate: rate(killed, list.length),
      seedOnlyKilled,
      seedOnlyRate: rate(seedOnlyKilled, list.length),
      survivors: list.filter((control) => statusOf(control) === NEGATIVE_STATUS.survived).map(describe),
      undecided: list.filter((control) => statusOf(control) === NEGATIVE_STATUS.undecided).map(describe),
      invalid: list.filter((control) => statusOf(control) === NEGATIVE_STATUS.invalid).map(describeErrors),
      unscored: list.filter((control) => statusOf(control) === NEGATIVE_STATUS.unscored).map(describeErrors),
      executionErrors: list.filter((control) => control.executionError).length,
    };
  };

  const design = negatives.filter((control) => !control.heldout);
  const heldout = negatives.filter((control) => control.heldout);
  const byType = {};
  for (const control of negatives) {
    const key = control.type;
    byType[key] ||= { total: 0, killed: 0, seedOnlyKilled: 0 };
    byType[key].total += 1;
    const killed = statusOf(control) === NEGATIVE_STATUS.killed;
    byType[key].killed += killed ? 1 : 0;
    byType[key].seedOnlyKilled += killed && control.killedOn.includes(primaryFixture) ? 1 : 0;
  }
  const byFixture = {};
  for (const fixture of fixtureNames) {
    const killedHere = negatives.filter((control) => statusOf(control) === NEGATIVE_STATUS.killed && control.killedOn.includes(fixture));
    byFixture[fixture] = {
      killed: killedHere.length,
      onlyThisFixture: killedHere.filter((control) => control.killedOn.length === 1).length,
    };
  }
  // Killed although every fixture alone matched some reading (mixed gold
  // variants or an inconsistent column mapping across fixtures).
  const crossFixtureOnly = negatives.filter((control) => statusOf(control) === NEGATIVE_STATUS.killed && control.killedOn.length === 0).length;

  return {
    design: group(design),
    heldout: group(heldout),
    byType,
    byFixture,
    crossFixtureOnly,
    positive: {
      total: positives.length,
      matched: positives.filter((control) => control.match).length,
      validatorAccepted: positives.filter((control) => !control.rejection).length,
    },
  };
}

const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/**
 * verify-dataset's kill-rate gate for one dataset's controls summary: the
 * design (non-held-out) kill rate must reach `minKillRate` and the held-out
 * rate `minHeldoutKillRate`. A group without controls is not gated. Returns
 * the failure messages (empty when the gate passes).
 */
export function killRateGateFailures(summary, { datasetName, minKillRate, minHeldoutKillRate = 0 }) {
  const failures = [];
  if (!summary) {
    return failures;
  }
  if (summary.design.total > 0 && summary.design.rate < minKillRate) {
    failures.push(`${datasetName}: design kill rate ${percent(summary.design.rate)} < ${percent(minKillRate)}`);
  }
  if (summary.heldout.total > 0 && summary.heldout.rate < minHeldoutKillRate) {
    failures.push(`${datasetName}: held-out kill rate ${percent(summary.heldout.rate)} < ${percent(minHeldoutKillRate)}`);
  }
  return failures;
}

/**
 * verify-dataset's fixture gate over checkFixtureContent results
 * ([{ name, status, masterDataMatches }]): every fixture must hold exactly the
 * generated content, and its master data must be the shared MASTER_DATA.
 */
export function fixtureGateFailures(checks) {
  const failures = [];
  for (const check of checks) {
    if (check.masterDataMatches === false) {
      failures.push(
        `fixture ${check.name}: master data differs from the shared MASTER_DATA (every fixture must carry identical dimension rows; run "npm run seed-fixtures")`
      );
    }
    if (check.status !== 'current') {
      failures.push(`fixture ${check.name}: content is ${check.status}, not what the generator writes (run "npm run seed-fixtures")`);
    }
  }
  return failures;
}

/**
 * Why `verify-dataset --write-pins` must not write pins from these fixture
 * checks, or null when it may: pins record the gold's row counts on the
 * generated fixture content, so every fixture must be current and carry the
 * shared master data. Counts read from a stale, drifted or missing fixture
 * would be wrong pins, ready to commit.
 */
export function pinWriteRefusal(checks) {
  const reasons = [];
  for (const check of checks) {
    if (check.status !== 'current') {
      reasons.push(`fixture ${check.name} is ${check.status}`);
    }
    if (check.masterDataMatches === false) {
      reasons.push(`fixture ${check.name} has master data that differs from the shared MASTER_DATA`);
    }
  }
  if (reasons.length === 0) {
    return null;
  }
  return (
    `--write-pins refused, no pins written: ${reasons.join('; ')}. ` +
    'Run "npm run seed-fixtures" (admin credentials) so every fixture holds the generated content, then rerun with --write-pins.'
  );
}
