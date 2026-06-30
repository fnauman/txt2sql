import assert from 'node:assert/strict';
import test from 'node:test';

import { createBufferedTraceLogger, runOptimizedQuestion } from '../src/query-service.js';

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
      assert.equal(sql, 'SELECT COUNT(*) AS active_count FROM Customer');
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
  assert.deepEqual(result.rows, [{ active_count: 3 }]);
  assert.equal(result.columns[0].key, 'active_count');
  assert.equal(result.columns[0].type, 'number');
  assert.ok(result.insights.some((insight) => insight.id === 'row-count'));
  assert.ok(trace.events.some((event) => event.event === 'prompt.built'));
  assert.ok(trace.events.some((event) => event.event === 'sql.executed'));
});

test('runOptimizedQuestion leaves results unbounded unless rowLimit is provided', async () => {
  const rows = Array.from({ length: 1005 }, (_product, index) => ({
    CustomerId: index + 1,
    CustomerName: `Customer ${index + 1}`,
  }));
  const connection = {
    async query(sql) {
      assert.equal(sql, 'SELECT CustomerId, CustomerName FROM Customer');
      return [rows];
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

  assert.equal(limitedResult.rows.length, 1000);
  assert.equal(limitedResult.totalRowCount, rows.length);
  assert.equal(limitedResult.truncated, true);
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

