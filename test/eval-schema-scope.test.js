import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { rescoreRepetition } from '../src/eval/rescore.js';
import { createValidatorProbe, verifyCase } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// The evaluation side of the schema scope: verification and rescore validate
// with the product's configuration, and a rescore replays widen-on-demand.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

const OUTLET_GOLD =
  "SELECT s.LocationName, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocument d JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY s.StoreLocationId, s.LocationName ORDER BY SUM(COALESCE(d.NetAmount, 0)) DESC, s.LocationName ASC LIMIT 1";
const outletCase = normalizeBenchmarkCase({
  id: 'hard_vocab_outlet_turnover_top1_mar_2026',
  question: 'Which outlet had the highest turnover in March 2026?',
  expected_sql: OUTLET_GOLD,
  expected_tables: ['SalesDocument', 'StoreLocation'],
  comparison: { mode: 'ranked', value_columns: ['total_net_amount'], order: 'desc', decimals: 2 },
});

// A fake oracle: every executed SQL matches on the one fixture.
async function matchingScore() {
  return {
    match: true,
    matchedGold: 'expected_sql',
    reason: 'match',
    perFixture: [{ fixture: 'seed', match: true, matchAny: true, reason: 'match', goldRowCount: 1, actualRowCount: 1, truncated: false, error: null }],
    killedOn: [],
    assignment: {},
    signalWarnings: [],
    disallowedWarnings: [],
    preview: { gold: [], actual: [] },
    infraError: false,
  };
}

// The baseline's shape of a retrieval miss: attempt 1 rejected (TABLE_SCOPE,
// StoreLocation), the retry used the table again and was rejected again.
const recordedMiss = {
  repetition: 1,
  status: 'validation_error',
  error_stage: 'validation',
  error_code: 'TABLE_SCOPE',
  attempt_count: 2,
  attempts: [1, 2].map((attempt) => ({
    attempt,
    retry: attempt > 1,
    generatedSql: OUTLET_GOLD,
    llm: { ok: true, durationMs: 900, usage: null, cost: null },
    validation: { ok: false, durationMs: 1, code: 'TABLE_SCOPE', layer: 'safety', message: 'SQL references table "StoreLocation" which is outside the allowed table set.' },
    execution: null,
  })),
};

function rescoreUnder(schemaScope) {
  const validate = createValidatorProbe({ schema, schemaScope });
  return rescoreRepetition(recordedMiss, { testCase: outletCase, connections: [], goldCache: createGoldCache(), schema, validate, score: matchingScore });
}

test('a rescore re-judges recorded TABLE_SCOPE rejections with today\'s schema scope', async () => {
  // The baseline's own configuration (retrieved, no widening): still rejected.
  const asRecorded = await rescoreUnder({ schemaScope: 'retrieved', widenOnDemand: false });
  assert.equal(asRecorded.status, 'validation_error');
  assert.equal(asRecorded.error_code, 'TABLE_SCOPE');
  assert.equal(asRecorded.widened_tables, undefined);
  assert.ok(!asRecorded.retrieved_tables.includes('StoreLocation'));

  // Full scope: the first attempt is accepted and scored; the retry is not reached.
  const full = await rescoreUnder('full');
  assert.equal(full.status, 'pass');
  assert.equal(full.rescore.replayedAttemptCount, 1);
  assert.deepEqual(full.attempts.map((attempt) => attempt.replay), ['reached', 'not_reached']);
  assert.ok(full.retrieved_tables.includes('StoreLocation'));
  assert.ok(Array.isArray(full.ranked_tables) && !full.ranked_tables.includes('StoreLocation'), 'ranked_tables is what retrieval picked');

  // Retrieved with widen-on-demand: the product would have widened the
  // retry's prompt, so the recorded retry is judged against the widened one.
  const widened = await rescoreUnder('retrieved');
  assert.equal(widened.status, 'pass');
  assert.equal(widened.rescore.replayedAttemptCount, 2);
  assert.deepEqual(widened.widened_tables, ['StoreLocation']);
  assert.deepEqual(widened.rescore.widenedTables, ['StoreLocation']);
  assert.equal(widened.attempts[0].validation.code, 'TABLE_SCOPE');
  assert.equal(widened.attempts[1].validation.ok, true);
  assert.ok(widened.retrieved_tables.includes('StoreLocation'));

  // The last recorded attempt has no retry after it: nothing to widen for.
  const single = { ...recordedMiss, attempt_count: 1, attempts: recordedMiss.attempts.slice(0, 1) };
  const validate = createValidatorProbe({ schema, schemaScope: 'retrieved' });
  const lone = await rescoreRepetition(single, { testCase: outletCase, connections: [], goldCache: createGoldCache(), schema, validate, score: matchingScore });
  assert.equal(lone.status, 'validation_error');
  assert.equal(lone.widened_tables, undefined);
});

test('verification follows the schema scope: a retrieval-scope rejection is a note under SCHEMA_SCOPE=retrieved, never a problem', async () => {
  const fixture = {
    name: 'seed',
    database: 'demo_retail',
    connection: {
      async query() {
        return [[{ LocationName: 'Central Store', total_net_amount: 100 }]];
      },
    },
  };
  const verify = (schemaScope, testCase = outletCase) =>
    verifyCase(testCase, { connections: [fixture], validate: createValidatorProbe({ schema, schemaScope }), checkControls: false });

  const full = await verify(undefined);
  assert.deepEqual(full.problems, []);
  assert.ok(!full.notes.some((note) => /retrieved schema scope/.test(note)));

  const retrieved = await verify('retrieved');
  assert.deepEqual(retrieved.problems, []);
  assert.ok(retrieved.notes.some((note) => /^expected_sql: rejected under the retrieved schema scope because retrieval did not pick StoreLocation \(TABLE_SCOPE\)/.test(note)), retrieved.notes.join('; '));

  // A stale TABLE_SCOPE flag is a problem in the default scope (verify-dataset
  // makes the dataset drop it) and still a known rejection under retrieved.
  const flagged = { ...outletCase, known_validator_rejection: 'TABLE_SCOPE' };
  assert.match((await verify(undefined, flagged)).problems.join('\n'), /known_validator_rejection is TABLE_SCOPE, but the production validator accepts the gold now/);
  assert.deepEqual((await verify('retrieved', flagged)).problems, []);

  // A table outside the in-scope schema is a problem in every scope.
  const narrow = { ...schema, tables: schema.tables.filter((table) => table.tableName !== 'StoreLocation') };
  const outside = await verifyCase(outletCase, { connections: [fixture], validate: createValidatorProbe({ schema: narrow }), checkControls: false });
  assert.match(outside.problems.join('\n'), /expected_sql is rejected by the production validator: TABLE_SCOPE \(safety\)/);
});

test('the validator probe reports the TABLE_SCOPE table and whether only the retrieved allow-list lacks it', async () => {
  const retrieved = createValidatorProbe({ schema, schemaScope: 'retrieved' });
  const rejection = await retrieved(outletCase.question, OUTLET_GOLD);
  assert.deepEqual({ code: rejection.code, layer: rejection.layer, table: rejection.table, retrievalScope: rejection.retrievalScope }, {
    code: 'TABLE_SCOPE',
    layer: 'safety',
    table: 'StoreLocation',
    retrievalScope: true,
  });
  assert.equal(retrieved.schemaScope.effective, 'retrieved');
  assert.equal(await retrieved(outletCase.question, OUTLET_GOLD, { extraTables: ['StoreLocation'] }), null);
  const widenedPrompt = await retrieved.promptFor(outletCase.question, { extraTables: ['StoreLocation'] });
  assert.deepEqual(widenedPrompt.schemaScope.widenedTables, ['StoreLocation']);

  const outside = await retrieved(outletCase.question, 'SELECT * FROM Employee');
  assert.equal(outside.code, 'TABLE_SCOPE');
  assert.equal(outside.retrievalScope, false, 'Employee is not an in-scope table');

  const full = createValidatorProbe({ schema });
  assert.equal(full.schemaScope.effective, 'full');
  assert.equal(await full(outletCase.question, OUTLET_GOLD), null);
});
