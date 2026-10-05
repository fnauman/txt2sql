// Dataset verification against every fixture, without any LLM call
// (scripts/verify-dataset.js). Per case:
// - gold health: the gold SQL and every alternative_expected_sql execute on
//   every fixture, match their per-fixture row-count pins, are self-consistent
//   under the case's comparison spec (whose column names must exist in the
//   gold result), pass the case's own signal checks, and pass the production
//   validator in the real optimized prompt context;
// - positive controls (correct alternatives) match the gold or an alternative
//   on every fixture AND pass the production validator;
// - negative controls (plausible-wrong SQL) are killed: they fail to match on
//   at least one fixture. Their kill rate measures the oracle.

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
import { createGoldCache, executeGoldSql, GoldSqlError, scoreAgainstGold } from './oracle.js';

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

function goldColumnsOf(rows) {
  return Object.keys(rows?.[0] ?? {});
}

function checkComparisonColumns(testCase, rows, label, fixture) {
  if (!testCase.comparison || !rows || rows.length === 0) {
    return [];
  }
  const columns = new Set(goldColumnsOf(rows));
  const problems = [];
  for (const key of ['compare_columns', 'value_columns', 'column_order']) {
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
        rows = await executeGoldSql(fixtureConnection, variant.sql, { goldCache, label: variant.label });
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
      const score = await scoreAgainstGold({ testCase, predictedSql: control.sql, connections, goldCache });
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
      const score = await scoreAgainstGold({ testCase, predictedSql: control.sql, connections, goldCache });
      negative.push({
        id: control.id,
        type: control.type,
        heldout: control.heldout,
        note: control.note,
        killed: !score.match,
        killedOn: score.killedOn,
        reason: score.reason,
        executionError: score.executionError,
      });
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
 * { total, killed, rate, seedOnlyKilled, seedOnlyRate, survivors }.
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

  const group = (list) => {
    const killed = list.filter((control) => control.killed).length;
    const seedOnlyKilled = list.filter((control) => control.killedOn.includes(primaryFixture)).length;
    return {
      total: list.length,
      killed,
      rate: rate(killed, list.length),
      seedOnlyKilled,
      seedOnlyRate: rate(seedOnlyKilled, list.length),
      survivors: list.filter((control) => !control.killed).map((control) => `${control.caseId}/${control.id} (${control.type}${control.note ? `: ${control.note}` : ''})`),
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
    byType[key].killed += control.killed ? 1 : 0;
    byType[key].seedOnlyKilled += control.killedOn.includes(primaryFixture) ? 1 : 0;
  }
  const byFixture = {};
  for (const fixture of fixtureNames) {
    byFixture[fixture] = {
      killed: negatives.filter((control) => control.killedOn.includes(fixture)).length,
      onlyThisFixture: negatives.filter((control) => control.killedOn.length === 1 && control.killedOn[0] === fixture).length,
    };
  }
  // Killed although every fixture alone matched some reading (mixed gold
  // variants or an inconsistent column mapping across fixtures).
  const crossFixtureOnly = negatives.filter((control) => control.killed && control.killedOn.length === 0).length;

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
