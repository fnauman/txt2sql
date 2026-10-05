import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { extractAttempts } from '../src/eval/case-trace.js';
import { createGoldCache, GOLD_STATEMENT_TIMEOUT_MS } from '../src/eval/oracle.js';
import { runOptimizedQuestion } from '../src/query-service.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { assertSharedMasterData, describeFixtureStatus, evaluateQuestion } from '../scripts/evaluate.js';

// The benchmark must exercise the product loop itself (EVAL-3 / EVAL-ENG-3):
// same prompt, same retry message, same retry budget, same statement timeout.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

const savedEnv = {
  QUERY_STATEMENT_TIMEOUT_MS: process.env.QUERY_STATEMENT_TIMEOUT_MS,
  WEB_QUERY_MAX_RETRIES: process.env.WEB_QUERY_MAX_RETRIES,
};
before(() => {
  delete process.env.QUERY_STATEMENT_TIMEOUT_MS;
  delete process.env.WEB_QUERY_MAX_RETRIES;
});
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const QUESTION = 'How many active customers do we have?';
const GOLD = 'SELECT COUNT(*) AS active_customer_count FROM Customer WHERE IsActive = 1';
const GOOD = 'SELECT COUNT(*) AS active_customers FROM Customer WHERE IsActive = 1';
const WRONG = 'SELECT COUNT(*) AS active_customers FROM Customer';

const activeCase = normalizeBenchmarkCase({
  id: 'core_public_007',
  intentId: 'active_customer_count',
  question: QUESTION,
  expected_sql: GOLD,
  expected_tables: ['Customer'],
  comparison: { mode: 'scalar' },
  signal_checks: { min_row_count: 1, require_nonzero_columns: ['active_customer_count'] },
});

// Scripted fake OpenAI client: returns the given SQL per call, records each
// request's messages verbatim.
function scriptedClient(sqlPerCall, { failWith = null } = {}) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        async create(request) {
          requests.push(JSON.stringify(request.messages));
          if (failWith) {
            throw failWith;
          }
          const sql = sqlPerCall[Math.min(requests.length - 1, sqlPerCall.length - 1)];
          return {
            id: `resp_${requests.length}`,
            model: request.model,
            usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify({ sql, explanation: 'x', tables_used: ['Customer'], assumptions: [] }) },
              },
            ],
          };
        },
      },
    },
  };
}

// A fake fixture database answering by SQL text (bounds prefix stripped).
function fakeDatabase(answers) {
  const sent = [];
  return {
    sent,
    async query(statement) {
      sent.push(statement);
      const sql = statement.replace(/^SET STATEMENT .*? FOR /, '');
      if (!(sql in answers)) {
        throw Object.assign(new Error(`Unexpected SQL: ${sql}`), { code: 'ER_PARSE_ERROR' });
      }
      const answer = answers[sql];
      if (answer instanceof Error) {
        throw answer;
      }
      return [answer];
    },
  };
}

function collector() {
  const events = [];
  return { events, trace: { async emit(event, payload = {}) { events.push({ event, ...payload }); } } };
}

test('benchmark and product loop send byte-identical messages, including the retry after a validation failure', async () => {
  const answers = { [GOLD]: [{ active_customer_count: 7 }], [GOOD]: [{ active_customers: 7 }] };
  const benchmarkClient = scriptedClient(['DELETE FROM Customer', GOOD]);
  const productClient = scriptedClient(['DELETE FROM Customer', GOOD]);

  const result = await evaluateQuestion({
    client: benchmarkClient,
    connection: fakeDatabase(answers),
    schema,
    model: 'gpt-4o-mini',
    testCase: activeCase,
    caseIndex: 1,
    trace: collector().trace,
  });
  const product = await runOptimizedQuestion({
    client: productClient,
    connection: fakeDatabase(answers),
    schema,
    model: 'gpt-4o-mini',
    question: QUESTION,
  });

  assert.equal(product.success, true);
  assert.equal(result.status, 'pass');
  assert.equal(benchmarkClient.requests.length, 2);
  assert.deepEqual(benchmarkClient.requests, productClient.requests);
  const retryMessage = JSON.parse(benchmarkClient.requests[1]).at(-1).content;
  assert.match(retryMessage, /^The SQL above was rejected by SQL validation \(guardrails\) with this error:\nOnly read-only SQL is allowed\./);
});

test('per-attempt data: generated SQL, validation code/layer, execution, usage and timings', async () => {
  const runTrace = collector();
  const database = fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [GOOD]: [{ active_customers: 7 }] });
  const result = await evaluateQuestion({
    client: scriptedClient(['DELETE FROM Customer', GOOD]),
    connection: database,
    schema,
    model: 'gpt-4o-mini',
    testCase: activeCase,
    caseIndex: 3,
    datasetName: 'core-public',
    trace: runTrace.trace,
  });

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.attempt_count, 2);
  assert.equal(result.attempts.length, 2);
  const [first, second] = result.attempts;
  assert.equal(first.generatedSql, 'DELETE FROM Customer');
  assert.deepEqual(
    { ok: first.validation.ok, code: first.validation.code, layer: first.validation.layer },
    { ok: false, code: 'NOT_READ_ONLY', layer: 'safety' }
  );
  assert.equal(first.execution, null);
  assert.equal(first.llm.ok, true);
  assert.equal(first.llm.usage.prompt_tokens, 1000);
  assert.equal(typeof first.llm.durationMs, 'number');
  assert.equal(second.retry, true);
  assert.equal(second.validation.ok, true);
  assert.deepEqual(second.execution && { ok: second.execution.ok, rowCount: second.execution.rowCount }, { ok: true, rowCount: 1 });
  assert.equal(result.llm_usage.prompt_tokens, 2000);
  assert.equal(result.generated_sql, GOOD);
  assert.equal(typeof result.timings.totalMs, 'number');
  assert.ok(result.timings.llmMs >= 0);
  assert.deepEqual(result.oracle.per_fixture.map((entry) => [entry.fixture, entry.match]), [['seed', true]]);
  assert.deepEqual(result.oracle.assignment, { active_customer_count: 'active_customers' });

  // The product loop ran under the default statement timeout and row cap;
  // the gold under its own, longer timeout (GOLD_STATEMENT_TIMEOUT_MS).
  assert.ok(database.sent.includes(`SET STATEMENT max_statement_time=8.000, sql_select_limit=1001 FOR ${GOOD}`));
  assert.ok(database.sent.includes(`SET STATEMENT max_statement_time=${(GOLD_STATEMENT_TIMEOUT_MS / 1000).toFixed(3)} FOR ${GOLD}`));
  assert.equal(GOLD_STATEMENT_TIMEOUT_MS, 30_000);

  // Product-loop events reach the run trace, tagged with the case.
  const forwarded = runTrace.events.filter((entry) => entry.event === 'sql.validation_failed');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].caseId, 'core_public_007');
  assert.equal(forwarded[0].datasetName, 'core-public');
  assert.equal(forwarded[0].error.layer, 'safety');
  const order = runTrace.events.map((entry) => entry.event);
  for (const event of ['case.started', 'expected_sql.executed', 'question.started', 'prompt.built', 'llm.completed', 'sql.validated', 'sql.executed', 'question.completed', 'result.compared', 'result.signal_checked', 'case.completed']) {
    assert.ok(order.includes(event), `missing ${event}`);
  }
  assert.ok(order.indexOf('expected_sql.executed') < order.indexOf('llm.completed'), 'gold runs before the model is called');
});

test('a guardrail rejection is captured with layer "guardrail"', async () => {
  const question = 'Show the top customers by total net sales amount in March 2026.';
  const fanOut =
    "SELECT c.CustomerName, ROUND(SUM(d.NetAmount), 2) AS total_net_amount FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId JOIN Customer c ON d.CustomerId = c.CustomerId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY c.CustomerId, c.CustomerName ORDER BY SUM(d.NetAmount) DESC LIMIT 10";
  const gold =
    "SELECT c.CustomerName, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY c.CustomerId, c.CustomerName ORDER BY SUM(COALESCE(d.NetAmount, 0)) DESC, c.CustomerName ASC LIMIT 10";
  const result = await evaluateQuestion({
    client: scriptedClient([fanOut]),
    connection: fakeDatabase({ [gold]: [{ CustomerName: 'A', total_net_amount: 10 }] }),
    schema,
    model: 'gpt-4o-mini',
    testCase: normalizeBenchmarkCase({ id: 'c1', question, expected_sql: gold, comparison: { mode: 'ranked' } }),
    caseIndex: 1,
    trace: collector().trace,
  });
  assert.equal(result.status, 'validation_error');
  assert.equal(result.error_stage, 'validation');
  assert.equal(result.error_code, 'FAN_OUT');
  assert.deepEqual(result.attempts.map((attempt) => [attempt.validation.code, attempt.validation.layer]), [
    ['FAN_OUT', 'guardrail'],
    ['FAN_OUT', 'guardrail'],
  ]);
});

test('the retry budget is the product setting (maxRetries / WEB_QUERY_MAX_RETRIES)', async () => {
  const answers = { [GOLD]: [{ active_customer_count: 7 }] };
  const run = async (options) => {
    const client = scriptedClient(['DELETE FROM Customer']);
    const result = await evaluateQuestion({
      client,
      connection: fakeDatabase(answers),
      schema,
      model: 'gpt-4o-mini',
      testCase: activeCase,
      caseIndex: 1,
      trace: collector().trace,
      ...options,
    });
    return { result, calls: client.requests.length };
  };

  const defaults = await run({});
  assert.equal(defaults.calls, 2, 'default: 1 retry');
  assert.equal(defaults.result.status, 'validation_error');
  assert.equal(defaults.result.error_code, 'NOT_READ_ONLY');

  assert.equal((await run({ maxRetries: 0 })).calls, 1);

  process.env.WEB_QUERY_MAX_RETRIES = '2';
  try {
    assert.equal((await run({})).calls, 3);
  } finally {
    delete process.env.WEB_QUERY_MAX_RETRIES;
  }
});

test('statuses: mismatch, retrieval miss, LLM failure, infra failure', async () => {
  const base = { schema, model: 'gpt-4o-mini', caseIndex: 1, trace: collector().trace };

  const mismatch = await evaluateQuestion({
    ...base,
    client: scriptedClient([WRONG]),
    connection: fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [WRONG]: [{ active_customers: 8 }] }),
    testCase: activeCase,
  });
  assert.equal(mismatch.status, 'result_mismatch');
  assert.equal(mismatch.oracle.reason, 'values');

  const missing = await evaluateQuestion({
    ...base,
    client: scriptedClient([WRONG]),
    connection: fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [WRONG]: [{ active_customers: 8 }] }),
    testCase: normalizeBenchmarkCase({ ...activeCase, expected_tables: ['Customer', 'LedgerAccount'] }),
  });
  assert.equal(missing.status, 'retrieval_miss');

  const llmDown = await evaluateQuestion({
    ...base,
    client: scriptedClient([], { failWith: Object.assign(new Error('rate limited'), { status: 429 }) }),
    connection: fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }] }),
    testCase: activeCase,
  });
  assert.equal(llmDown.status, 'llm_error');

  const infra = await evaluateQuestion({
    ...base,
    client: scriptedClient([GOOD]),
    connection: fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [GOOD]: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
    testCase: activeCase,
  });
  assert.equal(infra.status, 'infra_error');
  assert.equal(infra.attempt_count, 1, 'infra failures are not retried');
});

test('a value match with a trap column or a signal complaint is a pass with warnings', async () => {
  const trapSql = 'SELECT COUNT(*) AS active_customer_count, MAX(CustomerSegment) AS seg FROM Customer WHERE IsActive = 1';
  const result = await evaluateQuestion({
    client: scriptedClient([trapSql]),
    connection: fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [trapSql]: [{ active_customer_count: 7, seg: 'Retail' }] }),
    schema,
    model: 'gpt-4o-mini',
    testCase: normalizeBenchmarkCase({ ...activeCase, disallowed_columns: ['CustomerSegment'] }),
    caseIndex: 1,
    trace: collector().trace,
  });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.warnings, ['disallowed_column_used']);
  assert.deepEqual(result.disallowed_column_warnings, ['CustomerSegment']);
});

test('multi-fixture: a prediction that coincides on the primary fixture fails on another', async () => {
  const seed = fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [WRONG]: [{ active_customers: 7 }] });
  const v2 = fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [WRONG]: [{ active_customers: 8 }] });
  const goldCache = createGoldCache();
  const result = await evaluateQuestion({
    client: scriptedClient([WRONG]),
    connections: [
      { name: 'seed', database: 'demo_retail', connection: seed },
      { name: 'v2', database: 'demo_retail_v2', connection: v2 },
    ],
    schema,
    model: 'gpt-4o-mini',
    testCase: activeCase,
    caseIndex: 1,
    trace: collector().trace,
    goldCache,
  });
  assert.equal(result.status, 'result_mismatch');
  assert.deepEqual(result.oracle.killed_on, ['v2']);
  assert.deepEqual(result.oracle.per_fixture.map((entry) => [entry.fixture, entry.match]), [
    ['seed', true],
    ['v2', false],
  ]);
  const strip = (statement) => statement.replace(/^SET STATEMENT .*? FOR /, '');
  assert.deepEqual(v2.sent.map(strip), [GOLD, WRONG], 'only gold and the oracle run on other fixtures');
  assert.deepEqual(seed.sent.map(strip), [GOLD, WRONG, WRONG], 'the product loop runs on the primary fixture');
  assert.equal(goldCache.size, 2);
});

test('an infrastructure failure while the oracle re-runs the prediction on another fixture is infra_error', async () => {
  const seed = fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [GOOD]: [{ active_customers: 7 }] });
  const v2 = fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [GOOD]: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  const result = await evaluateQuestion({
    client: scriptedClient([GOOD]),
    connections: [
      { name: 'seed', database: 'demo_retail', connection: seed },
      { name: 'v2', database: 'demo_retail_v2', connection: v2 },
    ],
    schema,
    model: 'gpt-4o-mini',
    testCase: activeCase,
    caseIndex: 1,
    trace: collector().trace,
  });
  assert.equal(result.status, 'infra_error', 'not a model mismatch');
  assert.equal(result.attempt_count, 1, 'the product loop itself succeeded');
  assert.deepEqual(result.oracle.per_fixture.map((entry) => [entry.fixture, entry.match, entry.error?.code ?? null]), [
    ['seed', true, null],
    ['v2', false, 'ECONNRESET'],
  ]);

  // A query error there (not infrastructure) is an ordinary mismatch.
  const v2Timeout = fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [GOOD]: Object.assign(new Error('interrupted'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }) });
  const timedOut = await evaluateQuestion({
    client: scriptedClient([GOOD]),
    connections: [
      { name: 'seed', database: 'demo_retail', connection: fakeDatabase({ [GOLD]: [{ active_customer_count: 7 }], [GOOD]: [{ active_customers: 7 }] }) },
      { name: 'v2', database: 'demo_retail_v2', connection: v2Timeout },
    ],
    schema,
    model: 'gpt-4o-mini',
    testCase: activeCase,
    caseIndex: 1,
    trace: collector().trace,
  });
  assert.equal(timedOut.status, 'result_mismatch');
});

test('fixture status comes from the deep content check; differing master data stops the benchmark', async () => {
  const connections = [
    { name: 'seed', database: 'demo_retail', connection: {} },
    { name: 'v2', database: 'demo_retail_v2', connection: {} },
  ];
  const results = {
    demo_retail: { status: 'current', masterDataMatches: true, contentHash: 'a', expected: { contentHash: 'a' }, meta: { contentHash: 'a' } },
    demo_retail_v2: { status: 'drifted', masterDataMatches: true, contentHash: 'b', expected: { contentHash: 'c' }, meta: { contentHash: 'c' } },
  };
  const status = await describeFixtureStatus(connections, { check: async (_connection, fixture) => results[fixture.database] });
  assert.deepEqual(status.map((entry) => [entry.name, entry.status, entry.masterDataMatches]), [
    ['seed', 'current', true],
    ['v2', 'drifted', true],
  ]);
  assert.doesNotThrow(() => assertSharedMasterData(status), 'drifted facts only warn');

  results.demo_retail_v2.masterDataMatches = false;
  const broken = await describeFixtureStatus(connections, { check: async (_connection, fixture) => results[fixture.database] });
  assert.throws(() => assertSharedMasterData(broken), /master data differs .* v2 \(demo_retail_v2\).*npm run seed-fixtures/);

  const failing = await describeFixtureStatus(connections, {
    check: async () => {
      throw new Error('SELECT denied');
    },
  });
  assert.deepEqual(failing.map((entry) => entry.status), ['unknown', 'unknown']);
  assert.doesNotThrow(() => assertSharedMasterData(failing), 'an unknown status is not a master-data mismatch');
});

test('extractAttempts tolerates partial traces', () => {
  assert.deepEqual(extractAttempts([]), []);
  const attempts = extractAttempts([
    { event: 'llm.failed', attempt: 1, durationMs: 5, errorCode: 'LLM_TRUNCATED', error: { name: 'LlmResponseError', code: 'LLM_TRUNCATED', message: 'cut off' } },
    { event: 'question.completed', success: false },
  ]);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].llm, {
    ok: false,
    durationMs: 5,
    code: 'LLM_TRUNCATED',
    error: { name: 'LlmResponseError', code: 'LLM_TRUNCATED', message: 'cut off' },
  });
  assert.equal(attempts[0].validation, null);
});
