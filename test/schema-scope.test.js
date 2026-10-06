import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import {
  buildOptimizedPrompt,
  buildSemanticPlan,
  estimateFullSchemaTokens,
  rankedTableNames,
  resolveEffectiveSchemaScope,
  tablesToWidenFor,
  validateReadOnlySql,
  validateSqlSafety,
} from '../src/pipeline.js';
import { createBufferedTraceLogger, runOptimizedQuestion } from '../src/query-service.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import {
  DEFAULT_SCHEMA_FULL_MAX_TOKENS,
  describeSchemaScope,
  normalizeSchemaScopeConfig,
  resolveSchemaScopeConfig,
} from '../src/schema-scope.js';

// Schema scope (src/schema-scope.js): 'full' sends every in-scope table as one
// stable prompt prefix and allows them all; 'retrieved' is the prompt and
// allow-list every question had before (byte for byte), plus widen-on-demand
// after a TABLE_SCOPE rejection of an in-scope table; 'auto' (default) picks
// full when the full schema block fits SCHEMA_FULL_MAX_TOKENS.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const ALL_TABLES = schema.tables.map((table) => table.tableName);
const MAIN_PROMPTS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/retrieved-scope-prompts-main.json'), 'utf8'));

// A retrieval miss on main: no table matches "outlet" or "turnover", so
// retrieval falls back to four alphabetical tables and StoreLocation is not
// in the allow-list (hard_vocab_outlet_turnover_top1_mar_2026). That is hints
// version 1 (HINTS_VERSION=1): version 2 maps "turnover" to net sales, so
// these schema-scope tests build their prompts with version 1 unless they
// say otherwise.
const OUTLET_QUESTION = 'Which outlet had the highest turnover in March 2026?';
const OUTLET_GOLD =
  "SELECT s.LocationName, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocument d JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY s.StoreLocationId, s.LocationName ORDER BY SUM(COALESCE(d.NetAmount, 0)) DESC, s.LocationName ASC LIMIT 1";

function promptFor(question, schemaScope, extra = {}) {
  const { hintsVersion = 1, ...rest } = extra;
  return buildOptimizedPrompt(schema, question, { semanticPlan: buildSemanticPlan(question, { hintsVersion }), schemaScope, ...rest });
}

function validateIn(prompt, sql) {
  try {
    validateReadOnlySql(sql, prompt.tables.map((table) => table.tableName), {
      promptContext: prompt.context,
      response: { sql, tables_used: validateSqlSafety(sql, ALL_TABLES).tablesUsed },
    });
    return null;
  } catch (error) {
    return error;
  }
}

function cacheablePrefix(prompt) {
  return prompt.user.slice(0, prompt.context.promptCache.cacheablePrefixChars - prompt.system.length);
}

test('resolveSchemaScopeConfig: auto, 8000 tokens and widen-on-demand by default; every value validated', () => {
  assert.deepEqual({ ...resolveSchemaScopeConfig({}) }, { schemaScope: 'auto', fullSchemaMaxTokens: 8000, widenOnDemand: true });
  // An explicit 'retrieved' is today's behaviour exactly: no widening unless asked for.
  assert.deepEqual({ ...resolveSchemaScopeConfig({ SCHEMA_SCOPE: 'retrieved' }) }, { schemaScope: 'retrieved', fullSchemaMaxTokens: 8000, widenOnDemand: false });
  assert.equal(resolveSchemaScopeConfig({ SCHEMA_SCOPE: 'retrieved', SCHEMA_WIDEN_ON_DEMAND: '1' }).widenOnDemand, true);
  assert.equal(resolveSchemaScopeConfig({ SCHEMA_SCOPE: 'auto', SCHEMA_WIDEN_ON_DEMAND: '0' }).widenOnDemand, false);
  assert.deepEqual(
    { ...resolveSchemaScopeConfig({ SCHEMA_SCOPE: ' Retrieved ', SCHEMA_FULL_MAX_TOKENS: '1200', SCHEMA_WIDEN_ON_DEMAND: 'off' }) },
    { schemaScope: 'retrieved', fullSchemaMaxTokens: 1200, widenOnDemand: false }
  );
  // Blank values count as unset, like the other settings.
  assert.equal(resolveSchemaScopeConfig({ SCHEMA_SCOPE: '  ', SCHEMA_FULL_MAX_TOKENS: '' }).schemaScope, 'auto');
  for (const [env, pattern] of [
    [{ SCHEMA_SCOPE: 'everything' }, /SCHEMA_SCOPE must be one of retrieved, full, auto; got "everything"/],
    [{ SCHEMA_FULL_MAX_TOKENS: '8e3' }, /SCHEMA_FULL_MAX_TOKENS must be an integer/],
    [{ SCHEMA_FULL_MAX_TOKENS: '0' }, /SCHEMA_FULL_MAX_TOKENS must be an integer between 1/],
    [{ SCHEMA_WIDEN_ON_DEMAND: 'maybe' }, /SCHEMA_WIDEN_ON_DEMAND must be a boolean/],
  ]) {
    assert.throws(() => resolveSchemaScopeConfig(env), (error) => error.code === 'INVALID_CONFIG' && pattern.test(error.message));
  }
  assert.deepEqual({ ...normalizeSchemaScopeConfig('full') }, { schemaScope: 'full', fullSchemaMaxTokens: DEFAULT_SCHEMA_FULL_MAX_TOKENS, widenOnDemand: true });
  assert.deepEqual({ ...normalizeSchemaScopeConfig({ widenOnDemand: false }) }, { schemaScope: 'auto', fullSchemaMaxTokens: 8000, widenOnDemand: false });
  assert.equal(normalizeSchemaScopeConfig('retrieved').widenOnDemand, false);
  assert.equal(normalizeSchemaScopeConfig({ schemaScope: 'retrieved' }).widenOnDemand, false);
  assert.equal(normalizeSchemaScopeConfig({ schemaScope: 'retrieved', widenOnDemand: true }).widenOnDemand, true);
  assert.equal(normalizeSchemaScopeConfig({}).widenOnDemand, true);
  assert.throws(() => normalizeSchemaScopeConfig('narrow'), { code: 'INVALID_CONFIG' });
});

test('auto is full while the full schema block fits SCHEMA_FULL_MAX_TOKENS, else retrieved; explicit scopes win', () => {
  const estimate = estimateFullSchemaTokens(schema);
  assert.ok(estimate > 1000 && estimate < DEFAULT_SCHEMA_FULL_MAX_TOKENS, `the 13-table schema block is ${estimate} estimated tokens`);

  assert.equal(resolveEffectiveSchemaScope(schema).effective, 'full', 'the demo schema fits the default budget');
  assert.equal(resolveEffectiveSchemaScope(schema, { fullSchemaMaxTokens: estimate }).effective, 'full', 'the budget is inclusive');
  assert.equal(resolveEffectiveSchemaScope(schema, { fullSchemaMaxTokens: estimate - 1 }).effective, 'retrieved');
  assert.equal(resolveEffectiveSchemaScope(schema, { schemaScope: 'full', fullSchemaMaxTokens: 1 }).effective, 'full');
  assert.equal(resolveEffectiveSchemaScope(schema, { schemaScope: 'retrieved' }).effective, 'retrieved');
  assert.deepEqual(resolveEffectiveSchemaScope(schema, 'auto'), {
    requested: 'auto',
    effective: 'full',
    fullSchemaEstimatedTokens: estimate,
    fullSchemaMaxTokens: 8000,
    widenOnDemand: true,
    inScopeTableCount: 13,
  });
  assert.match(describeSchemaScope(resolveEffectiveSchemaScope(schema)), new RegExp(`^auto -> full \\(${estimate.toLocaleString('en-US')} of 8,000 estimated tokens for the full schema; 13 in-scope tables\\)$`));

  // The prompt follows the effective scope: a budget below the schema size
  // gives the retrieved prompt, byte for byte.
  const autoRetrieved = promptFor(OUTLET_QUESTION, { schemaScope: 'auto', fullSchemaMaxTokens: estimate - 1 });
  assert.equal(autoRetrieved.user, promptFor(OUTLET_QUESTION, 'retrieved').user);
  assert.equal(autoRetrieved.context.schemaScope.effective, 'retrieved');
});

// test/fixtures/retrieved-scope-prompts-main.json was written by main's
// buildOptimizedPrompt before schema scopes existed (its prompt version is the
// committed baseline's; test/eval-provenance.test.js checks that), and so
// before HINTS_VERSION existed: hints version 1.
test('retrieved scope reproduces main\'s prompt and allow-list byte for byte (hints version 1)', () => {
  for (const expected of MAIN_PROMPTS.prompts) {
    const prompt = promptFor(expected.question, 'retrieved', { hintsVersion: 1 });
    assert.equal(prompt.system, expected.system, expected.question);
    assert.equal(prompt.user, expected.user, expected.question);
    assert.deepEqual(prompt.tables.map((table) => table.tableName), expected.allowedTables);
    assert.equal(prompt.context.schemaScope.effective, 'retrieved');
  }
});

test('full scope: every in-scope table once, in one prefix shared by every question; retrieval is a one-line hint', () => {
  const outlet = promptFor(OUTLET_QUESTION, 'full');
  const customers = promptFor('Show the top customers by total net sales amount in March 2026.', 'full');

  assert.deepEqual(outlet.tables.map((table) => table.tableName), ALL_TABLES);
  const allowedBlock = outlet.user.split('\n\nIn-scope relationships:')[0];
  assert.deepEqual(
    allowedBlock.split('Allowed tables:\n')[1].split('\n').map((line) => line.replace(/^- /, '')),
    ALL_TABLES
  );
  for (const tableName of ALL_TABLES) {
    // Printed exactly once: no question-ranked duplicate block (audit D8).
    assert.equal(outlet.user.split(`Table ${tableName}\n`).length - 1, 1, tableName);
  }
  assert.doesNotMatch(outlet.user, /Question-ranked schema details:/);
  assert.match(outlet.system, /lists every in-scope table and is the same for every question/);

  // One cacheable prefix for every question.
  assert.equal(cacheablePrefix(outlet), cacheablePrefix(customers));
  assert.ok(outlet.user.indexOf('In-scope schema context:') < outlet.user.indexOf('Question-specific context:'));

  // The hint is one line: ranked tables with their question-matched columns.
  const hint = customers.user.split('Retrieval relevance hint (a ranking only; every allowed table may be used):\n')[1].split('\n\n')[0];
  assert.equal(hint.split('\n').length, 1);
  assert.match(hint, /^- Most relevant tables\/columns for this question: SalesDocument \(NetAmount, NetPayableAmount, [^)]*\); Customer; /);
  assert.deepEqual(customers.context.relevanceHint[0], { tableName: 'SalesDocument', columns: customers.context.relevanceHint[0].columns, connector: false });
  // A question nothing matches gets no arbitrary "relevant" tables.
  assert.match(outlet.user, /- No table matched the wording of this question; choose tables from the schema above\./);

  // The full prompt is shorter than the retrieved one, which prints its tables twice.
  const retrieved = promptFor('Show the top customers by total net sales amount in March 2026.', 'retrieved');
  assert.ok(customers.user.length < retrieved.user.length + 2000, `${customers.user.length} vs ${retrieved.user.length}`);
});

test('allow-list per scope: full admits every in-scope table, retrieved only the retrieved ones; nothing outside the schema passes', () => {
  const full = promptFor(OUTLET_QUESTION, 'full');
  const retrieved = promptFor(OUTLET_QUESTION, 'retrieved');

  assert.equal(validateIn(full, OUTLET_GOLD), null);
  const rejection = validateIn(retrieved, OUTLET_GOLD);
  assert.equal(rejection?.code, 'TABLE_SCOPE');
  assert.equal(rejection.details.table, 'StoreLocation');

  // Outside the in-scope schema: rejected in every scope.
  const narrow = { ...schema, tables: schema.tables.filter((table) => table.tableName !== 'StoreLocation') };
  const narrowFull = buildOptimizedPrompt(narrow, OUTLET_QUESTION, { schemaScope: 'full', hintsVersion: 1 });
  assert.ok(!narrowFull.tables.some((table) => table.tableName === 'StoreLocation'));
  for (const prompt of [full, retrieved, narrowFull]) {
    const allowed = prompt.tables.map((table) => table.tableName);
    assert.throws(() => validateSqlSafety('SELECT TABLE_NAME FROM information_schema.TABLES', allowed), { code: 'METADATA_SCHEMA' });
    assert.throws(() => validateSqlSafety('SELECT CustomerName FROM demo_retail_v2.Customer', allowed), { code: 'CROSS_DATABASE' });
    assert.throws(() => validateSqlSafety('SELECT * FROM Employee', allowed), { code: 'TABLE_SCOPE' });
  }
  assert.throws(() => validateSqlSafety(OUTLET_GOLD, narrowFull.tables.map((table) => table.tableName)), { code: 'TABLE_SCOPE' });
});

test('tablesToWidenFor widens only in-scope tables rejected by TABLE_SCOPE', () => {
  const retrieved = promptFor(OUTLET_QUESTION, 'retrieved');
  const allowedTables = retrieved.tables.map((table) => table.tableName);
  const rejection = validateIn(retrieved, OUTLET_GOLD);
  assert.deepEqual(tablesToWidenFor(rejection, OUTLET_GOLD, { schema, allowedTables }), ['StoreLocation']);
  // Two missing in-scope tables are added at once.
  const twoMissing = 'SELECT s.LocationName, t.DocumentTypeName FROM SalesDocument d JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId JOIN DocumentType t ON d.DocumentTypeId = t.DocumentTypeId';
  assert.deepEqual(tablesToWidenFor({ code: 'TABLE_SCOPE', layer: 'safety', table: 'StoreLocation' }, twoMissing, { schema, allowedTables }), ['StoreLocation', 'DocumentType']);
  // Not in scope, or not a scope rejection: nothing to widen.
  assert.deepEqual(tablesToWidenFor({ code: 'TABLE_SCOPE', layer: 'safety', details: { table: 'Employee' } }, 'SELECT * FROM Employee JOIN StoreLocation', { schema, allowedTables }), []);
  assert.deepEqual(tablesToWidenFor({ code: 'METADATA_SCHEMA', layer: 'safety' }, 'SELECT * FROM information_schema.TABLES', { schema, allowedTables }), []);
  assert.deepEqual(tablesToWidenFor({ code: 'JOIN_PATH', layer: 'guardrail', table: 'StoreLocation' }, OUTLET_GOLD, { schema, allowedTables }), []);

  // The widened prompt: retrieved tables + the added one (and its join path),
  // in the schema context and the allow-list.
  const widened = promptFor(OUTLET_QUESTION, 'retrieved', { extraTables: ['StoreLocation'] });
  assert.deepEqual(widened.context.schemaScope.widenedTables, ['StoreLocation']);
  assert.ok(widened.tables.some((table) => table.tableName === 'StoreLocation'));
  assert.match(widened.user, /\nTable StoreLocation\n/);
  assert.equal(validateIn(widened, OUTLET_GOLD), null);
  // Unknown and already-retrieved names change nothing.
  assert.equal(promptFor(OUTLET_QUESTION, 'retrieved', { extraTables: ['Employee', 'SalesDocument'] }).user, retrieved.user);
});

// --- widen-on-demand in the product loop ------------------------------------

function scriptedClient(sqls) {
  const requests = [];
  const queue = [...sqls];
  return {
    requests,
    chat: {
      completions: {
        async create(request) {
          requests.push(request);
          const sql = queue.shift();
          if (sql === undefined) {
            throw new Error('unexpected LLM call');
          }
          return {
            id: `resp_${requests.length}`,
            model: request.model,
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            // A consistent model: tables_used lists the SQL's own tables.
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify({ sql, explanation: '', tables_used: validateSqlSafety(sql, ALL_TABLES).tablesUsed, assumptions: [] }) },
              },
            ],
          };
        },
      },
    },
  };
}

function fakeConnection() {
  const executed = [];
  return {
    executed,
    async query(statement) {
      executed.push(String(statement));
      return [[{ LocationName: 'Central Store', total_net_amount: 100 }]];
    },
  };
}

// Retrieved scope with widen-on-demand switched on (SCHEMA_SCOPE=retrieved
// SCHEMA_WIDEN_ON_DEMAND=1).
const RETRIEVED_WIDENING = Object.freeze({ schemaScope: 'retrieved', widenOnDemand: true });

async function runOutlet({ sqls, schemaScope, maxRetries = 1, onSchema = schema }) {
  const client = scriptedClient(sqls);
  const connection = fakeConnection();
  const trace = createBufferedTraceLogger();
  const result = await runOptimizedQuestion({ client, connection, schema: onSchema, question: OUTLET_QUESTION, trace, maxRetries, schemaScope, statementTimeoutMs: 0, hintsVersion: 1 });
  return { result, client, connection, trace };
}

test('widen-on-demand: a TABLE_SCOPE rejection of an in-scope table retries with that table in the prompt, within the retry budget', async () => {
  const { result, client, connection, trace } = await runOutlet({ sqls: [OUTLET_GOLD, OUTLET_GOLD], schemaScope: RETRIEVED_WIDENING });

  assert.equal(result.success, true, result.error?.message);
  assert.equal(result.attemptCount, 2);
  assert.equal(connection.executed.length, 1);
  assert.deepEqual(result.schemaScope.widenedTables, ['StoreLocation']);
  assert.ok(result.promptTables.includes('StoreLocation'), 'the allow-list of the answer includes the widened table');

  // The retry's prompt is the widened one, and it is told the table was added.
  const [first, second] = client.requests;
  assert.doesNotMatch(first.messages[1].content, /\nTable StoreLocation\n/);
  assert.match(second.messages[1].content, /\nTable StoreLocation\n/);
  const note = second.messages.at(-1).content;
  assert.match(note, /used a table that was missing from the schema context; the schema context above has been widened/);
  assert.match(note, /Table "StoreLocation" was not in the previous schema context\. It is in scope, and the schema context above now includes StoreLocation\./);
  assert.doesNotMatch(note, /outside the allowed table set/);

  const widenedEvent = trace.events.find((event) => event.event === 'prompt.widened');
  assert.equal(widenedEvent.rejectedTable, 'StoreLocation');
  assert.deepEqual(widenedEvent.addedTables, ['StoreLocation']);
  assert.equal(widenedEvent.attempt, 1);
  assert.equal(trace.events.find((event) => event.event === 'prompt.built').schemaScope.effective, 'retrieved');
});

test('widen-on-demand never widens past the retry budget, a table outside the schema, or when it is off', async () => {
  // No retry left: fails as before, nothing widened.
  const noBudget = await runOutlet({ sqls: [OUTLET_GOLD], schemaScope: RETRIEVED_WIDENING, maxRetries: 0 });
  assert.equal(noBudget.result.errorStage, 'validation');
  assert.equal(noBudget.result.errorCode, 'TABLE_SCOPE');
  assert.ok(!noBudget.trace.events.some((event) => event.event === 'prompt.widened'));

  // A table outside the in-scope schema stays rejected exactly as today.
  const narrow = { ...schema, tables: schema.tables.filter((table) => table.tableName !== 'StoreLocation') };
  const outside = await runOutlet({ sqls: [OUTLET_GOLD, OUTLET_GOLD], schemaScope: RETRIEVED_WIDENING, onSchema: narrow });
  assert.equal(outside.result.errorStage, 'validation');
  assert.equal(outside.result.errorCode, 'TABLE_SCOPE');
  assert.ok(!outside.trace.events.some((event) => event.event === 'prompt.widened'));
  assert.equal(outside.client.requests[0].messages[1].content, outside.client.requests[1].messages[1].content, 'the retry keeps the same prompt');
  assert.match(outside.client.requests[1].messages.at(-1).content, /was rejected by SQL validation \(guardrails\) with this error:\nSQL references table "StoreLocation" which is outside the allowed table set\./);

  // Widening off (SCHEMA_WIDEN_ON_DEMAND=0, and the default of an explicit
  // SCHEMA_SCOPE=retrieved): the product loop as it was before schema scopes.
  for (const scope of [{ schemaScope: 'retrieved', widenOnDemand: false }, 'retrieved', { schemaScope: 'retrieved' }]) {
    const off = await runOutlet({ sqls: [OUTLET_GOLD, OUTLET_GOLD], schemaScope: scope });
    assert.equal(off.result.errorCode, 'TABLE_SCOPE');
    assert.equal(off.result.attemptCount, 2);
    assert.equal(off.result.schemaScope.widenOnDemand, false);
    assert.ok(!off.trace.events.some((event) => event.event === 'prompt.widened'));
    assert.equal(off.client.requests[0].messages[1].content, off.client.requests[1].messages[1].content);
    assert.match(off.client.requests[1].messages.at(-1).content, /outside the allowed table set/);
  }
});

test('auto falling back to retrieved (schema over the budget) widens on demand by default', async () => {
  const estimate = estimateFullSchemaTokens(schema);
  const { result, trace } = await runOutlet({ sqls: [OUTLET_GOLD, OUTLET_GOLD], schemaScope: { schemaScope: 'auto', fullSchemaMaxTokens: estimate - 1 } });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(result.schemaScope.requested, 'auto');
  assert.equal(result.schemaScope.effective, 'retrieved');
  assert.equal(result.schemaScope.widenOnDemand, true);
  assert.deepEqual(result.schemaScope.widenedTables, ['StoreLocation']);
  assert.ok(trace.events.some((event) => event.event === 'prompt.widened'));
});

test('full scope in the product loop: the same SQL is accepted at once, and the result says which scope applied', async () => {
  const { result, client } = await runOutlet({ sqls: [OUTLET_GOLD], schemaScope: 'full' });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(result.attemptCount, 1);
  assert.equal(client.requests.length, 1);
  assert.deepEqual(result.promptTables, ALL_TABLES);
  assert.equal(result.schemaScope.effective, 'full');
  // Nothing matched this question: retrieval's default selection is not a
  // ranking, so no ranked tables are reported (the prompt's hint says so too).
  assert.equal(promptFor(OUTLET_QUESTION, 'full').context.retrieval.fallbackToDefaultSelection, true);
  assert.ok(promptFor(OUTLET_QUESTION, 'full').context.retrieval.expandedTableNames.length > 0);
  assert.deepEqual(result.rankedTables, []);
  assert.deepEqual(rankedTableNames(promptFor(OUTLET_QUESTION, 'full').context.retrieval), []);
  const matchedPrompt = promptFor('Show the top customers by total net sales amount in March 2026.', 'full');
  const matched = matchedPrompt.context.retrieval;
  assert.equal(matched.fallbackToDefaultSelection, false);
  // Score order (strongest match first), then the join-path connectors: the
  // order of the prompt's relevance hint, not the schema order of the
  // expanded set.
  assert.deepEqual(rankedTableNames(matched), matchedPrompt.context.relevanceHint.map((entry) => entry.tableName));
  assert.equal(rankedTableNames(matched)[0], 'SalesDocument');
  assert.notDeepEqual(rankedTableNames(matched), matched.expandedTableNames);
  assert.deepEqual([...rankedTableNames(matched)].sort(), [...matched.expandedTableNames].sort());
  assert.ok(rankedTableNames(matched).includes('Customer'));
  // The retrieved scope reports the same ranking.
  assert.deepEqual(
    rankedTableNames(promptFor('Show the top customers by total net sales amount in March 2026.', 'retrieved').context.retrieval),
    rankedTableNames(matched)
  );

  // Without an explicit setting the product loop reads SCHEMA_SCOPE (unset: auto).
  const saved = process.env.SCHEMA_SCOPE;
  try {
    process.env.SCHEMA_SCOPE = 'retrieved';
    const fromEnv = await runOutlet({ sqls: [OUTLET_GOLD, OUTLET_GOLD], schemaScope: undefined });
    assert.equal(fromEnv.result.schemaScope.effective, 'retrieved');
    assert.equal(fromEnv.result.schemaScope.widenOnDemand, false, 'an explicit retrieved scope does not widen by default');
    assert.equal(fromEnv.result.errorCode, 'TABLE_SCOPE');
  } finally {
    if (saved === undefined) {
      delete process.env.SCHEMA_SCOPE;
    } else {
      process.env.SCHEMA_SCOPE = saved;
    }
  }
});
