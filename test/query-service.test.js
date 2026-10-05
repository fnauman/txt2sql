import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, before } from 'node:test';

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

import {
  createBufferedTraceLogger,
  errorCodeOf,
  isLlmUnavailableCode,
  resolveMaxRetries,
  runOptimizedQuestion,
} from '../src/query-service.js';

// These tests pin the default statement timeout (8000 ms); keep a developer's
// shell setting from leaking in.
const savedTimeout = process.env.QUERY_STATEMENT_TIMEOUT_MS;
before(() => {
  delete process.env.QUERY_STATEMENT_TIMEOUT_MS;
});
after(() => {
  if (savedTimeout !== undefined) {
    process.env.QUERY_STATEMENT_TIMEOUT_MS = savedTimeout;
  }
});

const BOUNDED = 'SET STATEMENT max_statement_time=8.000 FOR ';

function createMockClient(content) {
  return {
    chat: {
      completions: {
        async create(request) {
          return {
            id: 'resp_web_test',
            model: request.model,
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
            choices: [
              {
                finish_reason: 'stop',
                message: { content },
              },
            ],
          };
        },
      },
    },
  };
}

const schema = {
  tables: [
    {
      name: 'Customer',
      tableName: 'Customer',
      file: 'Customer.js',
      description: 'Customer master',
      columns: [
        { name: 'CustomerId', type: 'INTEGER', allowNull: false, primaryKey: true, references: null, comment: null },
        { name: 'CustomerName', type: 'STRING(100)', allowNull: false, primaryKey: false, references: null, comment: null },
        { name: 'IsActive', type: 'BOOLEAN', allowNull: true, primaryKey: false, references: null, comment: null },
      ],
      foreignKeys: [],
      ignoredForeignKeys: [],
    },
  ],
};

test('runOptimizedQuestion returns normalized rows, columns, insights, and debug trace events', async () => {
  const trace = createBufferedTraceLogger({ enabled: true, pipeline: 'test-query' });
  const connection = {
    async query(sql) {
      // Model SQL now always runs under the default statement timeout.
      assert.equal(sql, `${BOUNDED}SELECT COUNT(*) AS active_count FROM Customer`);
      return [[{ active_count: 3 }]];
    },
  };
  const client = createMockClient(
    JSON.stringify({
      sql: 'SELECT COUNT(*) AS active_count FROM Customer',
      explanation: 'Counts active customers.',
      tables_used: ['Customer'],
      assumptions: ['Active flag is represented by IsActive.'],
    })
  );

  const result = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'How many active customers do we have?',
    trace,
  });

  assert.equal(result.success, true);
  assert.equal(result.errorStage, null);
  assert.deepEqual(result.rows, [{ active_count: 3 }]);
  assert.equal(result.columns[0].key, 'active_count');
  assert.equal(result.columns[0].type, 'number');
  assert.ok(result.insights.some((insight) => insight.id === 'row-count'));
  assert.ok(trace.events.some((event) => event.event === 'prompt.built'));
  assert.ok(trace.events.some((event) => event.event === 'sql.executed'));
});

// Behavior change (SAFE-11 / WEB-5): rowLimit used to slice rows only AFTER
// mysql2 had buffered the full result. The cap is now applied server-side
// (sql_select_limit = rowLimit + 1), and a capped result reports an unknown
// (null) total instead of the fetched count.
test('runOptimizedQuestion caps rows server-side only when rowLimit is provided', async () => {
  const rows = Array.from({ length: 1005 }, (_product, index) => ({
    CustomerId: index + 1,
    CustomerName: `Customer ${index + 1}`,
  }));
  const sent = [];
  // Honors sql_select_limit like MariaDB does.
  const connection = {
    async query(sql) {
      sent.push(sql);
      const limit = /sql_select_limit=(\d+)/.exec(sql);
      return [limit ? rows.slice(0, Number(limit[1])) : rows];
    },
  };
  const client = createMockClient(
    JSON.stringify({
      sql: 'SELECT CustomerId, CustomerName FROM Customer',
      explanation: 'Lists customers.',
      tables_used: ['Customer'],
      assumptions: [],
    })
  );

  const fullResult = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'List customers',
  });

  assert.equal(sent[0], `${BOUNDED}SELECT CustomerId, CustomerName FROM Customer`);
  assert.equal(fullResult.rows.length, rows.length);
  assert.equal(fullResult.totalRowCount, rows.length);
  assert.equal(fullResult.truncated, false);

  const limitedResult = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'List customers',
    rowLimit: 1000,
  });

  assert.equal(sent[1], 'SET STATEMENT max_statement_time=8.000, sql_select_limit=1001 FOR SELECT CustomerId, CustomerName FROM Customer');
  assert.equal(limitedResult.rows.length, 1000);
  assert.equal(limitedResult.rowCount, 1000);
  assert.equal(limitedResult.totalRowCount, null, 'only "more than 1000" is known');
  assert.equal(limitedResult.truncated, true);

  const exactResult = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'List customers',
    rowLimit: 2000,
  });
  assert.equal(exactResult.truncated, false);
  assert.equal(exactResult.totalRowCount, 1005);
});

// Behavior change: an explicit LIMIT outranks sql_select_limit in MariaDB, so
// all 30 rows used to be buffered and reported as an exact total of 30. The
// read now stops after rowLimit + 1 rows, so the total is unknown (null) and
// the rest is never materialized.
test('an explicit LIMIT larger than the cap cannot lift the row cap', async () => {
  const emitted = { count: 0 };
  const connection = {
    // Buffered queries (master-data lookups have no row cap) find nothing.
    async query() {
      return [[]];
    },
    // Minimal mysql2 core connection: streams 30 rows one at a time, ignoring
    // sql_select_limit the way MariaDB does under an explicit LIMIT.
    connection: {
      query() {
        const query = new EventEmitter();
        let index = 0;
        const next = () => {
          if (index === 30) {
            query.emit('end');
            return;
          }
          index += 1;
          emitted.count = index;
          query.emit('result', { CustomerId: index });
          setImmediate(next);
        };
        setImmediate(next);
        return query;
      },
    },
  };
  const client = createMockClient(
    JSON.stringify({ sql: 'SELECT CustomerId FROM Customer LIMIT 30', explanation: '', tables_used: ['Customer'], assumptions: [] })
  );
  const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', rowLimit: 10 });
  assert.equal(result.rows.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.totalRowCount, null, 'only "more than 10" is known');
  assert.ok(emitted.count < 30, `the read stopped early (resolved after ${emitted.count} rows)`);
});

test('runOptimizedQuestion short-circuits an already-aborted signal before any LLM or DB work', async () => {
  let llmCalls = 0;
  const client = {
    chat: {
      completions: {
        async create() {
          llmCalls += 1;
          return {
            id: 'resp',
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            choices: [{ finish_reason: 'stop', message: { content: '{"sql":"SELECT 1","tables_used":[],"assumptions":[]}' } }],
          };
        },
      },
    },
  };
  const connection = {
    async query() {
      throw new Error('DB must not be reached for an already-aborted request');
    },
  };

  const controller = new AbortController();
  controller.abort();

  const trace = createBufferedTraceLogger({ enabled: true, pipeline: 'test-query' });
  const result = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'How many active customers do we have?',
    maxRetries: 1,
    signal: controller.signal,
    trace,
  });

  assert.equal(result.success, false);
  assert.equal(result.errorStage, 'aborted');
  assert.equal(llmCalls, 0, 'must not call the LLM when the signal is already aborted');
  assert.ok(trace.events.some((event) => event.event === 'question.aborted'));
});

test('runOptimizedQuestion does not retry when the signal aborts during the LLM call', async () => {
  let llmCalls = 0;
  const controller = new AbortController();
  const client = {
    chat: {
      completions: {
        async create() {
          llmCalls += 1;
          controller.abort();
          const error = new Error('Request aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
    },
  };
  const connection = {
    async query() {
      throw new Error('DB must not be reached after an aborted LLM call');
    },
  };

  const result = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'How many active customers do we have?',
    maxRetries: 1,
    signal: controller.signal,
  });

  assert.equal(result.success, false);
  assert.equal(llmCalls, 1, 'must not retry after an abort');
});

test('runOptimizedQuestion skips DB execution when the signal aborts before execution', async () => {
  let llmCalls = 0;
  let executed = false;
  const controller = new AbortController();
  const client = {
    chat: {
      completions: {
        async create() {
          llmCalls += 1;
          // The client disconnects in the window between the LLM returning and
          // the DB query starting.
          controller.abort();
          return {
            id: 'resp',
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            choices: [
              {
                finish_reason: 'stop',
                message: { content: '{"sql":"SELECT COUNT(*) AS active_count FROM Customer","tables_used":["Customer"],"assumptions":[]}' },
              },
            ],
          };
        },
      },
    },
  };
  const connection = {
    async query() {
      executed = true;
      return [[{ active_count: 3 }]];
    },
  };

  const result = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'gpt-4o-mini',
    question: 'How many active customers do we have?',
    maxRetries: 1,
    signal: controller.signal,
  });

  assert.equal(result.success, false);
  assert.equal(llmCalls, 1);
  assert.equal(executed, false, 'must not execute SQL once the client has disconnected');
});


// --- Failure stages (EVAL-ENG-13) -------------------------------------------

function createScriptedClient(responses) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        async create(request) {
          requests.push(request);
          const next = responses[Math.min(requests.length - 1, responses.length - 1)];
          if (next instanceof Error) {
            throw next;
          }
          return {
            id: `resp_${requests.length}`,
            model: request.model,
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            choices: [next],
          };
        },
      },
    },
  };
}

const answer = (sql) => ({
  finish_reason: 'stop',
  message: { content: JSON.stringify({ sql, explanation: '', tables_used: ['Customer'], assumptions: [] }) },
});

test('a guardrail rejection on every attempt fails with errorStage "validation"', async () => {
  const client = createScriptedClient([answer('SELECT * FROM SecretTable'), answer('SELECT * FROM SecretTable')]);
  const connection = { async query() { throw new Error('must not execute rejected SQL'); } };
  const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', maxRetries: 1 });

  assert.equal(result.success, false);
  assert.equal(result.errorStage, 'validation');
  assert.equal(result.attemptCount, 2);
  assert.equal(client.requests.length, 2);
});

test('truncated completions fail with errorStage "llm" / errorCode LLM_TRUNCATED and still count their tokens', async () => {
  const truncated = { finish_reason: 'length', message: { content: '{"sql":"SELECT Cust' } };
  const client = createScriptedClient([truncated, truncated]);
  const connection = { async query() { throw new Error('must not execute'); } };
  const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', maxRetries: 1 });

  assert.equal(result.errorStage, 'llm');
  assert.equal(result.errorCode, 'LLM_TRUNCATED');
  assert.equal(result.error.name, 'LlmResponseError');
  assert.equal(result.llmUsage.total_tokens, 240, 'both billed calls are counted');
});

test('a SQL execution error is retried with the model and reported as "execution" when retries run out', async () => {
  const client = createScriptedClient([answer('SELECT CustomerName FROM Customer'), answer('SELECT CustomerName FROM Customer')]);
  let calls = 0;
  const connection = {
    async query() {
      calls += 1;
      throw Object.assign(new Error("Unknown column 'Nope' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR', errno: 1054 });
    },
  };
  const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', maxRetries: 1 });

  assert.equal(result.errorStage, 'execution');
  assert.equal(result.errorCode, 'ER_BAD_FIELD_ERROR');
  assert.equal(calls, 2);
  assert.match(client.requests[1].messages.at(-1).content, /failed with this database error/);
});

test('a statement timeout surfaces as ER_STATEMENT_TIMEOUT even though mysql2 gives it no code', () => {
  const error = Object.assign(new Error('Query execution was interrupted (max_statement_time exceeded)'), { errno: 1969 });
  assert.equal(errorCodeOf(error), 'ER_STATEMENT_TIMEOUT');
  assert.equal(errorCodeOf(new Error('Pool is closed.')), 'POOL_CLOSED');
  assert.equal(errorCodeOf(null), null);
});

// The SDK sets neither `code` nor a distinctive `name` on its transport errors
// (all are name 'Error'), so these use real instances, not look-alikes.
test('errorCodeOf classifies real OpenAI SDK errors by class', () => {
  assert.equal(new APIConnectionTimeoutError().name, 'Error', 'the SDK does not set a distinctive name');
  assert.equal(errorCodeOf(new APIConnectionTimeoutError()), 'LLM_TIMEOUT');
  assert.equal(errorCodeOf(new APIConnectionError({})), 'LLM_CONNECTION_ERROR');
  assert.equal(errorCodeOf(new APIUserAbortError()), 'LLM_ABORTED');
  // Provider HTTP errors map to their status even when the body carries a code.
  const rateLimited = APIError.generate(429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 'slow down', {});
  assert.equal(errorCodeOf(rateLimited), 'HTTP_429');
  assert.equal(errorCodeOf(APIError.generate(401, { error: { message: 'bad key', code: 'invalid_api_key' } }, 'bad key', {})), 'HTTP_401');
  assert.equal(errorCodeOf(APIError.generate(503, { error: { message: 'down' } }, 'down', {})), 'HTTP_503');

  for (const code of ['LLM_TIMEOUT', 'LLM_CONNECTION_ERROR', 'HTTP_401', 'HTTP_429', 'HTTP_500', 'HTTP_503']) {
    assert.equal(isLlmUnavailableCode(code), true, code);
  }
  for (const code of ['LLM_TRUNCATED', 'LLM_REFUSED', 'HTTP_400', 'ER_BAD_FIELD_ERROR', null]) {
    assert.equal(isLlmUnavailableCode(code), false, String(code));
  }
});

test('a provider outage fails fast as "llm" with a typed code instead of a second app attempt', async () => {
  const outages = [
    [new APIConnectionTimeoutError(), 'LLM_TIMEOUT'],
    [new APIConnectionError({}), 'LLM_CONNECTION_ERROR'],
    [APIError.generate(429, { error: { message: 'slow down' } }, 'slow down', {}), 'HTTP_429'],
    [APIError.generate(502, { error: { message: 'bad gateway' } }, 'bad gateway', {}), 'HTTP_502'],
  ];
  for (const [error, code] of outages) {
    const client = createScriptedClient([error, answer('SELECT CustomerName FROM Customer')]);
    const connection = {
      async query() {
        return [[]];
      },
    };
    const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', maxRetries: 1 });
    assert.equal(result.errorStage, 'llm', code);
    assert.equal(result.errorCode, code);
    assert.equal(client.requests.length, 1, `${code}: the SDK already retried the transport`);
  }

  // An LLM failure that is not an outage still gets the self-correction retry.
  const flaky = createScriptedClient([new Error('unexpected provider payload'), answer('SELECT CustomerName FROM Customer')]);
  const connection = {
    async query() {
      return [[{ CustomerName: 'A' }]];
    },
  };
  const recovered = await runOptimizedQuestion({ client: flaky, connection, schema, question: 'List customers', maxRetries: 1 });
  assert.equal(recovered.success, true);
  assert.equal(flaky.requests.length, 2);
});

test('a real SDK abort error is reported as "aborted" without a retry', async () => {
  const client = createScriptedClient([new APIUserAbortError(), answer('SELECT CustomerName FROM Customer')]);
  const connection = {
    async query() {
      return [[]];
    },
  };
  const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', maxRetries: 1 });
  assert.equal(result.errorStage, 'aborted');
  assert.equal(result.errorCode, 'LLM_ABORTED');
  assert.equal(client.requests.length, 1);
});

test('connection-level failures fail fast as "infra" without a paid LLM retry', async () => {
  const client = createScriptedClient([answer('SELECT CustomerName FROM Customer')]);
  const connection = {
    async query() {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
    },
  };
  const result = await runOptimizedQuestion({ client, connection, schema, question: 'List customers', maxRetries: 1 });

  assert.equal(result.errorStage, 'infra');
  assert.equal(result.errorCode, 'ECONNREFUSED');
  assert.equal(client.requests.length, 1, 'the model is not asked to "fix" SQL that never ran');
});

test('master-data lookups run under the statement timeout and short-circuit when the DB is down', async () => {
  const sent = [];
  const recording = {
    async query(sql, params) {
      sent.push({ sql, params });
      return [[]];
    },
  };
  const client = createScriptedClient([answer('SELECT CustomerName FROM Customer')]);
  await runOptimizedQuestion({
    client,
    connection: recording,
    schema,
    question: 'sparkling water sales',
    statementTimeoutMs: 1234,
    maxRetries: 0,
  });
  const lookups = sent.filter((call) => /FROM Product WHERE/.test(call.sql));
  assert.ok(lookups.length > 0, 'the product term triggers a master-data lookup');
  for (const lookup of lookups) {
    assert.match(lookup.sql, /^SET STATEMENT max_statement_time=1\.234 FOR SELECT ProductId/);
    assert.ok(Array.isArray(lookup.params) && lookup.params.length > 0, 'still parameterized');
  }

  const down = createScriptedClient([answer('SELECT CustomerName FROM Customer')]);
  const failing = {
    async query() {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
    },
  };
  const result = await runOptimizedQuestion({ client: down, connection: failing, schema, question: 'sparkling water sales' });
  assert.equal(result.errorStage, 'infra');
  assert.equal(down.requests.length, 0, 'no LLM call when the database is unreachable');
});

test('an abort during execution kills the query and reports errorStage "aborted" with the abort code', async () => {
  const client = createScriptedClient([answer('SELECT CustomerName FROM Customer')]);
  const controller = new AbortController();
  const events = [];
  let rejectRunning;
  const dedicated = {
    threadId: 7,
    query() {
      events.push('query');
      // Abort while the statement is running (e.g. the request deadline fires).
      setImmediate(() => controller.abort(Object.assign(new Error('deadline'), { name: 'AbortError', code: 'REQUEST_TIMEOUT' })));
      return new Promise((_resolve, reject) => {
        rejectRunning = reject;
      });
    },
    release() {
      events.push('release');
    },
    destroy() {
      events.push('destroy');
    },
  };
  const pool = {
    async getConnection() {
      return dedicated;
    },
    async query(sql) {
      events.push(sql);
      if (/^KILL QUERY/.test(sql)) {
        rejectRunning(Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' }));
      }
      return [[]];
    },
  };

  const result = await runOptimizedQuestion({
    client,
    connection: pool,
    schema,
    question: 'List customers',
    maxRetries: 1,
    signal: controller.signal,
  });

  assert.equal(result.errorStage, 'aborted');
  assert.equal(result.errorCode, 'REQUEST_TIMEOUT');
  assert.ok(events.includes('KILL QUERY 7'));
  assert.equal(client.requests.length, 1, 'no retry after an abort');
});

test('WEB_QUERY_MAX_RETRIES is validated instead of silently disabling every question', () => {
  assert.equal(resolveMaxRetries({}), 1);
  assert.equal(resolveMaxRetries({ WEB_QUERY_MAX_RETRIES: '0' }), 0);
  for (const bad of ['abc', '-1', '9', '0x1', '1e0']) {
    assert.throws(() => resolveMaxRetries({ WEB_QUERY_MAX_RETRIES: bad }), { code: 'INVALID_CONFIG' });
  }
});
