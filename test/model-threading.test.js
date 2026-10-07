import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { completionSettingsOf, describeModelConfig, modelFileLabel, resolveCompletionSettings, resolveModelConfig } from '../src/model-config.js';
import { compareReports } from '../src/eval/compare.js';
import { collectProvenance, traceMetadataFromProvenance } from '../src/eval/provenance.js';
import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { renderComparisonConsole, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { attributeCaseRuns, buildReport } from '../src/eval/runner.js';
import { createBufferedTraceLogger, loadOptimizedQueryRuntime, resolveRunModelSettings, runOptimizedQuestion } from '../src/query-service.js';
import {
  baselineModelNote,
  baselineTarget,
  budgetPricingRefusal,
  defaultBaselineForEnv,
  defaultBaselinePath,
  describeRunnerFlags,
  parseEvalArgs,
  runEval,
  USAGE,
  validateEvalArgv,
} from '../scripts/eval.js';
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

test('a paid eval with --budget-usd refuses to start for a model without a price', () => {
  assert.equal(budgetPricingRefusal(parseEvalArgs(['--budget-usd', '1'], { env: {} })), null);
  assert.equal(budgetPricingRefusal(parseEvalArgs(['--model', 'gpt-6-luna', '--reasoning-effort', 'low', '--budget-usd', '1'], { env: {} })), null);
  assert.equal(budgetPricingRefusal(parseEvalArgs(['--model', 'openai/gpt-6-luna', '--budget-usd', '1'], { env: {} })), null);
  assert.equal(budgetPricingRefusal(parseEvalArgs(['--model', 'acme/sql-1'], { env: {} })), null, 'no budget: nothing to enforce');
  assert.match(
    budgetPricingRefusal(parseEvalArgs(['--model', 'anthropic/claude-sonnet-4.5', '--budget-usd', '1'], { env: {} })),
    /^--budget-usd needs a price for model "anthropic\/claude-sonnet-4\.5" \(src\/pricing\.js, or MODEL_PRICING_OVERRIDES with inputPerMillion and outputPerMillion\); without it the budget cannot be enforced, so the run does not start\.$/
  );
  // Another tier that shares a priced prefix has no price of its own: refused.
  for (const model of ['gpt-6-sol-pro', 'gpt-6-luna-mini', 'gpt-5.4-pro']) {
    assert.match(budgetPricingRefusal(parseEvalArgs(['--model', model, '--budget-usd', '1'], { env: {} })) || '', /^--budget-usd needs a price for model/, model);
  }
  assert.equal(budgetPricingRefusal(parseEvalArgs(['--model', 'gpt-6-luna-2026-10-01', '--budget-usd', '1'], { env: {} })), null);
});

test('the default baseline is eval/baselines/<model>[.<effort>].json, with / in the model id as __', async () => {
  assert.equal(modelFileLabel('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(modelFileLabel('gpt-6-luna', 'low'), 'gpt-6-luna.low');
  assert.equal(modelFileLabel('openai/gpt-6-luna', 'medium'), 'openai__gpt-6-luna.medium');
  assert.equal(modelFileLabel('openai/gpt-6-luna:free'), 'openai__gpt-6-luna-free');
  assert.match(defaultBaselinePath('gpt-4o-mini'), /eval\/baselines\/gpt-4o-mini\.json$/);
  assert.match(defaultBaselinePath('gpt-4o-mini', null), /eval\/baselines\/gpt-4o-mini\.json$/);
  assert.match(defaultBaselinePath('gpt-6-luna', 'low'), /eval\/baselines\/gpt-6-luna\.low\.json$/);
  assert.match(defaultBaselinePath('openai/gpt-6-luna', 'medium'), /eval\/baselines\/openai__gpt-6-luna\.medium\.json$/);
  assert.match(defaultBaselineForEnv({}), /eval\/baselines\/gpt-4o-mini\.json$/);
  assert.match(defaultBaselineForEnv({ MODEL_NAME: 'openai/gpt-6-luna', REASONING_EFFORT: 'low' }), /eval\/baselines\/openai__gpt-6-luna\.low\.json$/);

  // --write-baseline writes the model's and effort's own file, and refuses another model's.
  const write = parseEvalArgs(['--model', 'gpt-6-luna', '--reasoning-effort', 'low', '--write-baseline'], { env: {} });
  assert.match(baselineTarget(write), /eval\/baselines\/gpt-6-luna\.low\.json$/);
  assert.throws(
    () => parseEvalArgs(['--model', 'gpt-6-luna', '--reasoning-effort', 'low', '--write-baseline', '--baseline-file', 'eval/baselines/gpt-6-luna.json'], { env: {} }),
    /this run's model gpt-6-luna \(reasoning effort low\) writes eval\/baselines\/gpt-6-luna\.low\.json/
  );

  // --gate looks for the effort's baseline.
  const lines = [];
  const cli = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  await assert.rejects(
    runEval(parseEvalArgs(['--model', 'gpt-6-luna', '--reasoning-effort', 'low', '--gate'], { env: {} }), { cli, env: {} }),
    (error) => error.code === 'NO_BASELINE' && /there is none at eval\/baselines\/gpt-6-luna\.low\.json/.test(error.message)
  );
});

test('comparisons flag a model or reasoning-effort change (comparison, report.md, console, baseline note)', () => {
  const record = (id, pass) => ({ id, question: id, gold_fingerprint: 'g', summary: { counted: 1, passes: pass ? 1 : 0, passRate: pass ? 1 : 0, majorityPass: pass, outcome: pass ? 'pass' : 'wrong_result' } });
  const results = [record('a', true), record('b', false)];
  const report = (model, reasoningEffort, extra = {}) => ({
    model,
    results,
    provenance: { product: reasoningEffort === undefined ? {} : { reasoningEffort } },
    ...extra,
  });

  const same = compareReports(report('gpt-4o-mini', undefined), report('gpt-4o-mini', null), { resamples: 20 });
  assert.equal(same.modelChange, null, 'a report from before REASONING_EFFORT sent none');
  const model = compareReports(report('gpt-4o-mini', undefined), report('gpt-6-luna', 'low'), { resamples: 20 });
  assert.deepEqual(model.modelChange, { model: true, reasoningEffort: true });
  assert.equal(model.candidate.reasoningEffort, 'low');
  const effort = compareReports(report('gpt-6-luna', 'low'), report('gpt-6-luna', 'medium'), { resamples: 20 });
  assert.deepEqual(effort.modelChange, { model: false, reasoningEffort: true });

  const printed = renderComparisonConsole(model);
  assert.match(printed, /\n {2}model: gpt-4o-mini → gpt-6-luna \(reasoning effort low\) \(the comparison measures the model change\)/);
  assert.doesNotMatch(renderComparisonConsole(same), /model:/);

  assert.equal(baselineModelNote(report('gpt-4o-mini', undefined), 'gpt-4o-mini', null), null);
  assert.equal(
    baselineModelNote(report('gpt-4o-mini', undefined), 'gpt-6-luna', 'low'),
    '  note: the baseline was run with gpt-4o-mini, this run uses gpt-6-luna (reasoning effort low): the comparison measures the model change too.'
  );
  assert.match(baselineModelNote(report('gpt-6-luna', 'low'), 'gpt-6-luna', 'medium'), /run with gpt-6-luna \(reasoning effort low\), this run uses gpt-6-luna \(reasoning effort medium\)/);
});

test('report.md\'s comparison table shows both efforts and states a model change', async () => {
  const caseRecords = await attributeCaseRuns(
    [
      {
        entry: { testCase: normalizeBenchmarkCase({ id: 'case_1', question: 'How many customers?', expected_sql: 'SELECT 1', expected_tables: ['Customer'] }), datasets: ['core'] },
        repetitions: [{ status: 'pass', warnings: [], attempts: [], attempt_count: 1, llm_usage: null, llm_cost: null, timings: { totalMs: 10 } }],
      },
    ],
    { checkGuardrails: false }
  );
  const provenance = { product: { reasoningEffort: 'low', modelSource: '--model', model: 'gpt-6-luna' }, model: 'gpt-6-luna' };
  const baselineReport = { model: 'gpt-4o-mini', results: caseRecords, provenance: { product: {} } };
  const comparison = compareReports(baselineReport, { model: 'gpt-6-luna', results: caseRecords, provenance }, { resamples: 20, baselineLabel: 'eval/baselines/gpt-4o-mini.json' });
  const markdown = renderReportMarkdown(
    buildReport({
      mode: 'run',
      generatedAt: '2026-10-07T10:00:00.000Z',
      model: 'gpt-6-luna',
      suite: { name: 'all', datasets: [], selectedCaseCount: 1, totalCaseCount: 1, filters: { split: 'all', caseIds: [], tags: [], intents: [] } },
      oracle: { fixtures: [] },
      runner: { repeat: 1 },
      provenance,
      verification: { skipped: true },
      caseRecords,
      comparison,
      statsOptions: { resamples: 20 },
    })
  );
  assert.match(markdown, /\| Reasoning effort \| unset \| low \|/);
  assert.match(markdown, /\*\*Model change:\*\* the baseline ran gpt-4o-mini and the candidate gpt-6-luna \(reasoning effort low\)/);
});
