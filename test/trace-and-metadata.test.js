import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildBasicPrompt,
  buildOptimizedPrompt,
  generateBasicSql,
  generateOptimizedResponse,
  LlmResponseError,
  OPTIMIZED_MODEL_REQUEST_OPTIONS,
  validateReadOnlySql,
} from '../src/pipeline.js';
import { applyEvaluationFailureExitCode, evaluateQuestion } from '../scripts/evaluate.js';
import { createCliOutput, createTraceLogger, resolveTraceOptions, serializeError } from '../src/trace.js';

function createWideTable(tableName, columnCount = 30) {
  return {
    name: tableName,
    tableName,
    file: `${tableName}.js`,
    description: `${tableName} records`,
    columns: Array.from({ length: columnCount }, (_value, index) => ({
      name: `${tableName}Column${String(index + 1).padStart(2, '0')}`,
      type: 'STRING(50)',
      allowNull: true,
      primaryKey: index === 0,
      references: null,
      comment: null,
    })),
    foreignKeys: [],
    ignoredForeignKeys: [],
  };
}

function createMockClient(content, overrides = {}, onCreate = null) {
  return {
    chat: {
      completions: {
        async create(request) {
          onCreate?.(request);
          return {
            id: 'resp_123',
            model: 'gpt-test',
            usage: {
              prompt_tokens: 123,
              completion_tokens: 45,
              total_tokens: 168,
            },
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content,
                },
              },
            ],
            ...overrides,
          };
        },
      },
    },
  };
}

function createTraceCollector() {
  const events = [];

  return {
    events,
    trace: {
      async emit(event, payload = {}) {
        events.push({ event, ...payload });
      },
    },
  };
}

test('buildBasicPrompt exposes included and omitted columns in prompt metadata', () => {
  const schema = {
    tables: [createWideTable('Customer')],
  };

  const prompt = buildBasicPrompt(schema, 'List customers');

  assert.equal(prompt.context.allowedTables[0], 'Customer');
  assert.equal(prompt.context.tables[0].includedColumns[0].name, 'CustomerColumn01');
  assert.match(prompt.context.tables[0].includedColumns[0].type, /STRING/);
  assert.ok(prompt.context.tables[0].omittedColumnNames.includes('CustomerColumn30'));
});

test('buildOptimizedPrompt includes retrieval metadata for traceability', () => {
  const schema = {
    tables: [
      {
        name: 'Customer',
        tableName: 'Customer',
        file: 'Customer.js',
        description: 'Customer master',
        columns: [
          { name: 'CustomerId', type: 'INTEGER', allowNull: false, primaryKey: true, references: null, comment: null },
          { name: 'CustomerName', type: 'STRING(50)', allowNull: false, primaryKey: false, references: null, comment: 'customer name' },
        ],
        foreignKeys: [],
        ignoredForeignKeys: [],
      },
      {
        name: 'SalesDocument',
        tableName: 'SalesDocument',
        file: 'SalesDocument.js',
        description: 'Document header',
        columns: [
          { name: 'SalesDocumentId', type: 'INTEGER', allowNull: false, primaryKey: true, references: null, comment: null },
          { name: 'CustomerId', type: 'INTEGER', allowNull: false, primaryKey: false, references: { model: 'Customer', key: 'CustomerId' }, comment: null },
          { name: 'BalanceAmount', type: 'DECIMAL(10,2)', allowNull: true, primaryKey: false, references: null, comment: 'outstanding balance' },
        ],
        foreignKeys: [{ column: 'CustomerId', references: { model: 'Customer', key: 'CustomerId' } }],
        ignoredForeignKeys: [],
      },
    ],
  };

  const prompt = buildOptimizedPrompt(schema, 'Show outstanding balance by customer');

  assert.equal(prompt.context.retrieval.fallbackToDefaultSelection, false);
  assert.ok(prompt.context.retrieval.initialTableNames.includes('Customer'));
  assert.ok(prompt.context.retrieval.tableScores.some((table) => table.tableName === 'SalesDocument' && table.score > 0));
  assert.ok(prompt.context.relationships.some((relationship) => relationship.fromTable === 'SalesDocument'));
});

test('generateBasicSql returns cleaned SQL plus raw response metadata', async () => {
  const result = await generateBasicSql({
    client: createMockClient('```sql\nSELECT 1;\n```'),
    model: 'gpt-4o-mini',
    prompt: {
      system: 'system prompt',
      user: 'user prompt',
    },
  });

  assert.equal(result.sql, 'SELECT 1;');
  assert.equal(result.rawText, '```sql\nSELECT 1;\n```');
  assert.equal(result.responseModel, 'gpt-test');
  assert.deepEqual(result.request, {
    model: 'gpt-4o-mini',
    temperature: 0,
    max_completion_tokens: 1200,
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ],
  });
});

test('optimized response budget allows complex structured SQL responses', () => {
  assert.ok(OPTIMIZED_MODEL_REQUEST_OPTIONS.max_completion_tokens >= 3000);
});

test('generateOptimizedResponse keeps raw response metadata on JSON parse fallback', async () => {
  const result = await generateOptimizedResponse({
    client: createMockClient('```sql\nSELECT 1;\n```'),
    model: 'gpt-4o-mini',
    prompt: {
      system: 'system prompt',
      user: 'user prompt',
    },
  });

  assert.equal(result.sql, 'SELECT 1;');
  assert.equal(result.explanation, 'Model response was not valid JSON.');
  assert.deepEqual(result.assumptions, ['Response parsing failed; SQL was extracted from raw output.']);
  assert.equal(result.rawText, '```sql\nSELECT 1;\n```');
  assert.deepEqual(result.request, {
    model: 'gpt-4o-mini',
    ...OPTIMIZED_MODEL_REQUEST_OPTIONS,
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ],
  });
});

test('generateOptimizedResponse traces the full retry request messages', async () => {
  let capturedRequest = null;

  const result = await generateOptimizedResponse({
    client: createMockClient(
      JSON.stringify({
        sql: 'SELECT CustomerId FROM Customer',
        explanation: 'retry response',
        tables_used: ['Customer'],
        assumptions: [],
      }),
      {},
      (request) => {
        capturedRequest = request;
      }
    ),
    model: 'gpt-4o-mini',
    prompt: {
      system: 'system prompt',
      user: 'user prompt',
    },
    retryContext: {
      sql: 'SELECT BadColumn FROM Customer',
      error: 'Unknown column BadColumn',
      tablesUsed: ['Customer'],
      assumptions: ['BadColumn existed'],
    },
  });

  assert.equal(result.sql, 'SELECT CustomerId FROM Customer');
  assert.deepEqual(result.request, capturedRequest);
  assert.deepEqual(result.request.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' },
    {
      role: 'assistant',
      content: JSON.stringify({
        sql: 'SELECT BadColumn FROM Customer',
        explanation: 'Previous attempt',
        tables_used: ['Customer'],
        assumptions: ['BadColumn existed'],
      }),
    },
    {
      role: 'user',
      content: 'The SQL above failed with this database error:\nUnknown column BadColumn\n\nReturn corrected JSON only.',
    },
  ]);
});

test('generateOptimizedResponse labels a validation-stage retry as a guardrail rejection, not a database error', async () => {
  let capturedRequest = null;

  await generateOptimizedResponse({
    client: createMockClient(
      JSON.stringify({ sql: 'SELECT CustomerId FROM Customer', explanation: 'retry', tables_used: ['Customer'], assumptions: [] }),
      {},
      (request) => {
        capturedRequest = request;
      }
    ),
    model: 'gpt-4o-mini',
    prompt: { system: 'system prompt', user: 'user prompt' },
    retryContext: {
      sql: 'SELECT * FROM Secret',
      error: 'references table "Secret" which is outside the allowed table set.',
      stage: 'validation',
      tablesUsed: [],
      assumptions: [],
    },
  });

  const retryMessage = capturedRequest.messages.at(-1).content;
  assert.match(retryMessage, /rejected by SQL validation/);
  assert.doesNotMatch(retryMessage, /database error/);
});

test('validateReadOnlySql returns validation metadata for tracing', () => {
  const validated = validateReadOnlySql('SELECT * FROM Customer;', ['Customer']);

  assert.equal(validated.sql, 'SELECT * FROM Customer');
  assert.equal(validated.firstKeyword, 'SELECT');
  assert.equal(validated.statementCount, 1);
  assert.deepEqual(validated.tablesUsed, ['Customer']);
});

test('trace logger writes JSONL to stdout and file sinks', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'text-to-sql-trace-'));
  const traceFile = path.join(tmpDir, 'run.jsonl');
  const chunks = [];
  const stream = {
    write(chunk, callback) {
      chunks.push(chunk);
      if (callback) {
        callback();
      }
      return true;
    },
  };
  const trace = await createTraceLogger({
    enabled: true,
    logToStdout: true,
    filePath: traceFile,
    pipeline: 'basic',
    stream,
  });

  await trace.emit('question.started', {
    questionIndex: 1,
    question: 'List customers',
  });

  const fileContents = await fs.readFile(traceFile, 'utf8');
  const record = JSON.parse(fileContents.trim());

  assert.equal(chunks.length, 1);
  assert.equal(record.pipeline, 'basic');
  assert.equal(record.event, 'question.started');
  assert.equal(record.question, 'List customers');
});

test('createCliOutput redirects human-readable output to stderr when tracing uses stdout', () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = '';
  let stderrText = '';

  stdout.on('data', (chunk) => {
    stdoutText += chunk.toString('utf8');
  });
  stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  const cli = createCliOutput({
    traceToStdout: true,
    stdout,
    stderr,
  });

  cli.log('hello');
  cli.write('world\n');

  assert.equal(stdoutText, '');
  assert.match(stderrText, /hello/);
  assert.match(stderrText, /world/);
});

// Behavior change (EVAL-3): evaluateQuestion used to reimplement the product
// loop and threw when the gold SQL failed. It now runs the gold first on every
// fixture and reports a broken gold as 'expected_sql_error' without calling the
// model; the rest of the trace comes from runOptimizedQuestion itself (see
// test/eval-benchmark.test.js).
test('evaluateQuestion reports a failing gold as expected_sql_error before any LLM call', async () => {
  const { trace, events } = createTraceCollector();
  let llmCalls = 0;
  const client = createMockClient('{}', {}, () => {
    llmCalls += 1;
  });
  const connection = {
    async query() {
      throw Object.assign(new Error("Table 'demo_retail.legacy_customer' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    },
  };

  const result = await evaluateQuestion({
    client,
    connection,
    schema: { tables: [] },
    model: 'gpt-4o-mini',
    testCase: {
      id: '7',
      question: 'List legacy customers',
      expected_sql: 'SELECT * FROM legacy_customer',
    },
    caseIndex: 1,
    trace,
  });

  assert.equal(result.status, 'expected_sql_error');
  assert.equal(result.error_code, 'ER_NO_SUCH_TABLE');
  assert.equal(llmCalls, 0);
  assert.deepEqual(
    events.map((entry) => entry.event),
    ['case.started', 'expected_sql.failed', 'case.completed']
  );
  const completionEvent = events.at(-1);
  assert.equal(completionEvent.success, false);
  assert.equal(completionEvent.status, 'expected_sql_error');
  assert.equal(completionEvent.attempts, 0);
  assert.equal(events[1].fixture, 'seed');
  assert.match(completionEvent.error.message, /legacy_customer/);
});

test('applyEvaluationFailureExitCode sets a non-zero exit code only when failures exist', () => {
  const successProcess = {};
  applyEvaluationFailureExitCode(0, successProcess);
  assert.equal(successProcess.exitCode, undefined);

  const failedProcess = {};
  applyEvaluationFailureExitCode(3, failedProcess);
  assert.equal(failedProcess.exitCode, 1);
});

test('resolveTraceOptions enables tracing for stdout or file output', () => {
  assert.deepEqual(resolveTraceOptions(['--trace']), {
    enabled: true,
    logToStdout: true,
    filePath: null,
  });

  assert.equal(resolveTraceOptions(['--trace-file', './generated/basic.jsonl']).enabled, true);
});

test('serializeError keeps the validation code, layer and any failure stage for traces', () => {
  let safetyError;
  try {
    validateReadOnlySql('SELECT 1 -- note', []);
  } catch (error) {
    safetyError = error;
  }
  const serialized = serializeError(safetyError);
  assert.equal(serialized.name, 'SqlValidationError');
  assert.equal(serialized.code, 'SQL_COMMENT');
  assert.equal(serialized.layer, 'safety');

  const staged = Object.assign(new Error('provider timed out'), { code: 'LLM_TIMEOUT', errorStage: 'llm' });
  assert.deepEqual(
    { code: serializeError(staged).code, errorStage: serializeError(staged).errorStage },
    { code: 'LLM_TIMEOUT', errorStage: 'llm' }
  );

  // LlmResponseError carries its stage as `stage`.
  const truncated = new LlmResponseError('cut off', { code: 'LLM_TRUNCATED' });
  assert.equal(serializeError(truncated).errorStage, 'llm');
  assert.equal(serializeError(truncated).code, 'LLM_TRUNCATED');

  // An unrelated `stage` (e.g. from a third-party library) is not a pipeline stage.
  const foreign = Object.assign(new Error('upload failed'), { stage: 'multipart-upload' });
  assert.equal('errorStage' in serializeError(foreign), false);

  // Plain errors keep the old shape: no empty layer/errorStage keys.
  const plain = serializeError(new Error('boom'));
  assert.equal('layer' in plain, false);
  assert.equal('errorStage' in plain, false);
  assert.equal(plain.code, null);
});

test('evaluateQuestion counts the tokens and cost of failed (truncated or refused) completions', async () => {
  const { trace, events } = createTraceCollector();
  const billed = (code) =>
    new LlmResponseError('the completion was billed but unusable', {
      code,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      cost: { currency: 'USD', inputCost: 0.001, outputCost: 0.002, totalCost: 0.003 },
    });
  const failures = [billed('LLM_TRUNCATED'), billed('LLM_REFUSED')];

  const result = await evaluateQuestion({
    client: null,
    connection: null,
    schema: { tables: [{ tableName: 'Customer' }] },
    model: 'gpt-4o-mini',
    testCase: { id: 'billed_failures', question: 'List customers', expected_sql: 'SELECT 1' },
    caseIndex: 1,
    trace,
    dependencies: {
      buildPrompt: () => ({ system: 's', user: 'u', context: {}, tables: [{ tableName: 'Customer' }] }),
      resolveMasterData: async () => [],
      executeSql: async () => [{ one: 1 }],
      generateResponse: async () => {
        throw failures.shift();
      },
    },
  });

  assert.equal(result.status, 'llm_error');
  assert.equal(result.llm_usage.total_tokens, 300, 'both billed attempts are counted');
  assert.equal(result.llm_cost.totalCost, 0.006);
  const completed = events.find((entry) => entry.event === 'case.completed');
  assert.equal(completed.llmCost.totalCost, 0.006);
});
