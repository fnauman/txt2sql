import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { completionSettingsOf, describeModelConfig, resolveCompletionSettings, resolveModelConfig } from '../src/model-config.js';
import { collectProvenance, traceMetadataFromProvenance } from '../src/eval/provenance.js';
import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { renderReportMarkdown } from '../src/eval/report-markdown.js';
import { attributeCaseRuns, buildReport } from '../src/eval/runner.js';
import { createBufferedTraceLogger, loadOptimizedQueryRuntime, resolveRunModelSettings, runOptimizedQuestion } from '../src/query-service.js';
import { describeRunnerFlags, parseEvalArgs, runEval, USAGE, validateEvalArgv } from '../scripts/eval.js';
import { evaluateQuestion } from '../scripts/evaluate.js';

// The model, its source and the reasoning effort travel from the settings
// (flags, env) to every LLM call, the run header, the trace and the
// provenance. Tests that read the env keep a developer's shell out of it.
const MODEL_VARS = ['MODEL_NAME', 'REASONING_EFFORT', 'OPENAI_BASE_URL', 'OPENROUTER_REQUIRE_PARAMETERS', 'LLM_MAX_COMPLETION_TOKENS', 'QUERY_STATEMENT_TIMEOUT_MS'];
const saved = {};
before(() => {
  for (const name of MODEL_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
after(() => {
  for (const name of MODEL_VARS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  const restore = () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(restore);
  }
  restore();
  return result;
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
      ],
      foreignKeys: [],
      ignoredForeignKeys: [],
    },
  ],
};

// Answers with each SQL in turn; records every request.
function scriptedClient(sqls) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        async create(request) {
          requests.push(request);
          const sql = sqls[Math.min(requests.length - 1, sqls.length - 1)];
          return {
            id: `resp_${requests.length}`,
            model: request.model,
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sql, explanation: '', tables_used: ['Customer'], assumptions: [] }) } }],
          };
        },
      },
    },
  };
}

const connection = {
  async query() {
    return [[{ CustomerName: 'Acme' }]];
  },
};

test('runOptimizedQuestion sends the effort and the endpoint settings on every attempt, retries included', async () => {
  // The first answer is rejected by the guardrails (unknown table), so the
  // retry goes through the same request options.
  const client = scriptedClient(['SELECT * FROM Secrets', 'SELECT CustomerName FROM Customer']);
  const trace = createBufferedTraceLogger({ enabled: true });
  const result = await runOptimizedQuestion({
    client,
    connection,
    schema,
    model: 'openai/gpt-6-luna',
    reasoningEffort: 'low',
    completionSettings: resolveCompletionSettings({ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }),
    question: 'List customer names',
    maxRetries: 1,
    trace,
  });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(client.requests.length, 2);
  for (const request of client.requests) {
    assert.equal(request.model, 'openai/gpt-6-luna');
    assert.equal(request.reasoning_effort, 'low');
    assert.equal(request.max_completion_tokens, 16000);
    assert.equal('temperature' in request, false);
    assert.deepEqual(request.provider, { require_parameters: true });
  }
  // The trace records the request as sent.
  const completed = trace.events.filter((event) => event.event === 'llm.completed');
  assert.deepEqual(completed.map((event) => event.request.reasoning_effort), ['low', 'low']);
});

test('runOptimizedQuestion reads MODEL_NAME and REASONING_EFFORT when the caller passes neither, and validates them first', async () => {
  const client = scriptedClient(['SELECT CustomerName FROM Customer']);
  await withEnv({ MODEL_NAME: 'gpt-6-luna', REASONING_EFFORT: 'medium' }, () =>
    runOptimizedQuestion({ client, connection, schema, question: 'List customer names', maxRetries: 0 })
  );
  assert.equal(client.requests[0].model, 'gpt-6-luna');
  assert.equal(client.requests[0].reasoning_effort, 'medium');

  // An explicit null effort is "none set": REASONING_EFFORT is not read.
  const explicit = scriptedClient(['SELECT CustomerName FROM Customer']);
  await withEnv({ REASONING_EFFORT: 'medium' }, () =>
    runOptimizedQuestion({ client: explicit, connection, schema, model: 'gpt-4o-mini', reasoningEffort: null, question: 'List customer names', maxRetries: 0 })
  );
  assert.deepEqual(
    Object.keys(explicit.requests[0]).filter((key) => key !== 'messages' && key !== 'response_format'),
    ['model', 'temperature', 'max_completion_tokens']
  );

  // An effort that does not fit the model fails before any LLM call.
  const never = scriptedClient(['SELECT 1']);
  await assert.rejects(
    withEnv({ REASONING_EFFORT: 'low' }, () => runOptimizedQuestion({ client: never, connection, schema, model: 'gpt-4o-mini', question: 'q' })),
    (error) => error.code === 'INVALID_CONFIG' && /REASONING_EFFORT "low" does not apply to gpt-4o-mini/.test(error.message)
  );
  await assert.rejects(runOptimizedQuestion({ client: never, connection, schema, model: 'gpt-6-luna', reasoningEffort: 'extreme', question: 'q' }), {
    code: 'INVALID_CONFIG',
  });
  assert.equal(never.requests.length, 0);

  assert.deepEqual(resolveRunModelSettings({}, {}), { model: 'gpt-4o-mini', reasoningEffort: null, completionSettings: resolveCompletionSettings({}) });
});

test('loadOptimizedQueryRuntime validates the effort before it creates a client or opens anything', async () => {
  await assert.rejects(loadOptimizedQueryRuntime({ model: 'gpt-4o-mini', reasoningEffort: 'low' }), { code: 'INVALID_CONFIG' });
  await assert.rejects(withEnv({ MODEL_NAME: 'gpt-6-luna', REASONING_EFFORT: 'minimal' }, () => loadOptimizedQueryRuntime()), (error) =>
    /REASONING_EFFORT must be one of none, low, medium, high, xhigh, max; got "minimal"/.test(error.message)
  );
});

test('evaluateQuestion passes the effort and the endpoint settings to the product loop', async () => {
  const calls = [];
  const runQuestion = async (args) => {
    calls.push(args);
    return { success: false, error: new Error('no'), errorStage: 'llm', errorCode: 'LLM_TRUNCATED' };
  };
  const base = {
    schema,
    model: 'gpt-6-luna',
    testCase: { id: 'abstain_1', question: 'q', expected_behavior: 'abstain' },
    caseIndex: 1,
    connection: {},
    trace: { emit: async () => {} },
    dependencies: { runQuestion },
  };
  const settings = completionSettingsOf(resolveModelConfig({ env: {} }));
  await evaluateQuestion({ ...base, reasoningEffort: 'low', completionSettings: settings });
  await evaluateQuestion(base);
  assert.equal(calls[0].reasoningEffort, 'low');
  assert.deepEqual(calls[0].completionSettings, settings);
  // Omitted: the product loop reads REASONING_EFFORT & co. itself.
  assert.equal('reasoningEffort' in calls[1], false);
  assert.equal('completionSettings' in calls[1], false);
});

test('eval options: --model and --reasoning-effort with their sources; a flag that overrides the env is a notice', () => {
  validateEvalArgv(['--reasoning-effort', 'low']);
  assert.match(USAGE, /--reasoning-effort <v> {6}none\|low\|medium\|high\|xhigh\|max, checked per model family/);

  const defaults = parseEvalArgs([], { env: {} });
  assert.deepEqual([defaults.model, defaults.modelSource, defaults.reasoningEffort, defaults.reasoningEffortSource], ['gpt-4o-mini', 'default', null, 'default']);

  const fromEnv = parseEvalArgs([], { env: { MODEL_NAME: 'gpt-6-luna', REASONING_EFFORT: 'medium' } });
  assert.deepEqual([fromEnv.model, fromEnv.modelSource, fromEnv.reasoningEffort, fromEnv.reasoningEffortSource], ['gpt-6-luna', 'MODEL_NAME', 'medium', 'REASONING_EFFORT']);
  assert.deepEqual(fromEnv.modelConfig.notices, []);

  const flags = parseEvalArgs(['--model', 'gpt-6-luna', '--reasoning-effort', 'low'], { env: { MODEL_NAME: 'gpt-4o-mini', REASONING_EFFORT: 'medium' } });
  assert.deepEqual([flags.model, flags.modelSource, flags.reasoningEffort, flags.reasoningEffortSource], ['gpt-6-luna', '--model', 'low', '--reasoning-effort']);
  assert.deepEqual(flags.modelConfig.notices, ['--model gpt-6-luna overrides MODEL_NAME=gpt-4o-mini.', '--reasoning-effort low overrides REASONING_EFFORT=medium.']);
  // The same value is no override.
  assert.deepEqual(parseEvalArgs(['--model', 'gpt-6-luna'], { env: { MODEL_NAME: 'gpt-6-luna' } }).modelConfig.notices, []);

  // runner.flags records the model and effort with their sources, not the resolved object.
  const recorded = describeRunnerFlags(flags);
  assert.deepEqual([recorded.model, recorded.modelSource, recorded.reasoningEffort, recorded.reasoningEffortSource], ['gpt-6-luna', '--model', 'low', '--reasoning-effort']);
  assert.equal('modelConfig' in recorded, false);

  // An invalid effort (flag or env) stops before anything starts, with the allowed values.
  assert.throws(
    () => parseEvalArgs(['--reasoning-effort', 'low'], { env: {} }),
    (error) => error.code === 'INVALID_CONFIG' && /--reasoning-effort "low" does not apply to gpt-4o-mini/.test(error.message)
  );
  assert.throws(() => parseEvalArgs(['--model', 'gpt-6-luna'], { env: { REASONING_EFFORT: 'turbo' } }), /REASONING_EFFORT must be one of none, low, medium, high, xhigh, max/);
  assert.throws(() => parseEvalArgs(['--reasoning-effort'], { env: {} }), /--reasoning-effort needs a value/);
});

test('the eval header names the model and the effort with their sources and the endpoint host, then any override notice', async () => {
  const lines = [];
  const cli = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const env = { MODEL_NAME: 'gpt-4o-mini', REASONING_EFFORT: 'none', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' };
  const options = parseEvalArgs(['--model', 'openai/gpt-6-luna', '--gate', '--no-baseline'], {
    env,
    envFile: { path: '/home/someone/.env', vars: ['MODEL_NAME', 'REASONING_EFFORT'] },
  });
  // --gate without a baseline stops right after the header, before any setup.
  await assert.rejects(runEval(options, { cli, env }), { code: 'NO_BASELINE' });
  assert.equal(
    lines[0],
    'txt2sql eval (eval profile): model openai/gpt-6-luna (--model); reasoning effort none (REASONING_EFFORT from /home/someone/.env); ' +
      'endpoint openrouter.ai (OpenRouter, require_parameters on); fixtures seed, v2, v3'
  );
  assert.equal(lines[1], '  note: --model openai/gpt-6-luna overrides MODEL_NAME=gpt-4o-mini (from /home/someone/.env).');

  assert.equal(
    describeModelConfig(resolveModelConfig({ env: {} })),
    'model gpt-4o-mini (default); reasoning effort unset (default); endpoint api.openai.com'
  );
  assert.equal(
    describeModelConfig(resolveModelConfig({ env: { MODEL_NAME: 'gpt-6-luna' }, envFile: { path: '/x/.env', vars: ['MODEL_NAME'] } })),
    'model gpt-6-luna (MODEL_NAME from /x/.env); reasoning effort provider default (default); endpoint api.openai.com'
  );
});

test('provenance records the model, its source, the effort and the request options; a rescore records the recording\'s', async () => {
  const gitState = { sha: 'f00', dirty: false, changedFiles: 0 };
  const config = resolveModelConfig({ env: { MODEL_NAME: 'gpt-6-luna' }, flags: { reasoningEffort: 'low' } });
  const live = await collectProvenance({
    schema,
    gitState,
    env: {},
    model: config.model,
    modelConfig: { ...config, completionSettings: completionSettingsOf(config) },
  });
  assert.deepEqual(
    { ...live.product, schemaScope: undefined, hintsVersion: undefined },
    {
      schemaScope: undefined,
      hintsVersion: undefined,
      model: 'gpt-6-luna',
      modelSource: 'MODEL_NAME',
      reasoningEffort: 'low',
      reasoningEffortSource: '--reasoning-effort',
      requestOptions: { max_completion_tokens: 16000, reasoning_effort: 'low' },
    }
  );
  assert.equal(traceMetadataFromProvenance(live).reasoningEffort, 'low');

  const mini = resolveModelConfig({ env: {} });
  const baseline = await collectProvenance({ schema, gitState, env: {}, model: mini.model, modelConfig: { ...mini, completionSettings: completionSettingsOf(mini) } });
  assert.deepEqual(baseline.product.requestOptions, { temperature: 0, max_completion_tokens: 3200 });
  assert.equal(baseline.product.reasoningEffort, null);
  // The prompt version does not depend on the model: the comparison names the model change instead.
  assert.equal(live.promptVersion, baseline.promptVersion);

  const rescored = await collectProvenance({
    schema,
    gitState,
    env: {},
    model: 'gpt-6-luna',
    modelConfig: { model: 'gpt-6-luna', modelSource: 'recorded', reasoningEffort: 'low', reasoningEffortSource: 'recorded', requestOptions: { max_completion_tokens: 16000, reasoning_effort: 'low' } },
  });
  assert.equal(rescored.product.modelSource, 'recorded');
  assert.deepEqual(rescored.product.requestOptions, { max_completion_tokens: 16000, reasoning_effort: 'low' });

  // report.md labels the model with its effort and shows the settings.
  const caseRecords = await attributeCaseRuns(
    [
      {
        entry: { testCase: normalizeBenchmarkCase({ id: 'case_1', question: 'How many customers?', expected_sql: 'SELECT 1', expected_tables: ['Customer'] }), datasets: ['core'] },
        repetitions: [{ status: 'pass', warnings: [], attempts: [], attempt_count: 1, llm_usage: null, llm_cost: null, timings: { totalMs: 10 } }],
      },
    ],
    { checkGuardrails: false }
  );
  const report = buildReport({
    mode: 'run',
    generatedAt: '2026-10-07T10:00:00.000Z',
    model: 'gpt-6-luna',
    suite: { name: 'all', datasets: [], selectedCaseCount: 1, totalCaseCount: 1, filters: { split: 'all', caseIds: [], tags: [], intents: [] } },
    oracle: { fixtures: [] },
    runner: { repeat: 1 },
    provenance: live,
    verification: { skipped: true },
    caseRecords,
    statsOptions: { resamples: 50 },
  });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /^# Evaluation report: all · gpt-6-luna \(reasoning effort low\)\n/);
  assert.match(markdown, /\| Model settings \| model from MODEL_NAME; reasoning effort low \(--reasoning-effort\); request options: max_completion_tokens 16000, reasoning_effort low \|/);
});
