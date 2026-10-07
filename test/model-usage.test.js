import assert from 'node:assert/strict';
import test from 'node:test';

import { compactReport } from '../src/eval/compact-report.js';
import { costOfResult, runCaseRepetitions } from '../src/eval/pool.js';
import { summarizeRunUsage } from '../src/eval/stats.js';
import { generateOptimizedResponse } from '../src/pipeline.js';
import { calculateCost, formatUsageAndCost, mergeCosts, mergeUsage } from '../src/pricing.js';
import { createBufferedTraceLogger, runOptimizedQuestion } from '../src/query-service.js';

// Reasoning models report the reasoning tokens inside completion_tokens
// (completion_tokens_details.reasoning_tokens); OpenRouter also reports what
// a call cost (usage.cost). Both are recorded, summed and shown.

const reasoningUsage = (extra = {}) => ({
  prompt_tokens: 2000,
  completion_tokens: 900,
  total_tokens: 2900,
  prompt_tokens_details: { cached_tokens: 1024 },
  completion_tokens_details: { reasoning_tokens: 640, audio_tokens: 0 },
  ...extra,
});

test('calculateCost records the reasoning tokens (billed as output) and a provider-reported cost', () => {
  const cost = calculateCost('gpt-5.4-mini', reasoningUsage({ cost: 0.0042 }));
  assert.equal(cost.reasoningTokens, 640);
  assert.equal(cost.completionTokens, 900);
  // Output is all 900 completion tokens, reasoning included: 900 / 1e6 * 4.5.
  assert.equal(cost.outputCost, 0.00405);
  assert.equal(cost.providerCost, 0.0042);
  // Priced here too, but the provider said what it charged: that is the cost,
  // and the local estimate is kept beside it.
  assert.equal(cost.source, 'provider');
  assert.equal(cost.totalCost, 0.0042);
  assert.equal(cost.estimatedCost, 0.0048588);
  // A usage without the breakdowns has neither field, and the estimate is the cost.
  const plain = calculateCost('gpt-5.4-mini', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal('reasoningTokens' in plain, false);
  assert.equal('providerCost' in plain, false);
  assert.equal('source' in plain, false);
  assert.equal('estimatedCost' in plain, false);

  // No price here: the provider's reported cost is the cost; without one there is none.
  const provider = calculateCost('anthropic/claude-sonnet-4.5', reasoningUsage({ cost: 0.0123 }));
  assert.deepEqual(
    { source: provider.source, totalCost: provider.totalCost, providerCost: provider.providerCost, reasoningTokens: provider.reasoningTokens, cachedPromptTokens: provider.cachedPromptTokens },
    { source: 'provider', totalCost: 0.0123, providerCost: 0.0123, reasoningTokens: 640, cachedPromptTokens: 1024 }
  );
  assert.equal(calculateCost('anthropic/claude-sonnet-4.5', reasoningUsage()), null);
  assert.equal(calculateCost('anthropic/claude-sonnet-4.5', reasoningUsage({ cost: 'free' })), null);
});

test('mergeUsage and mergeCosts sum the reasoning tokens and the provider cost across calls', () => {
  const merged = mergeUsage([reasoningUsage({ cost: 0.001 }), reasoningUsage({ cost: 0.002 }), { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }]);
  assert.deepEqual(merged, {
    prompt_tokens: 4100,
    completion_tokens: 1810,
    total_tokens: 5910,
    prompt_tokens_details: { cached_tokens: 2048 },
    completion_tokens_details: { reasoning_tokens: 1280 },
    cost: 0.003,
  });
  // No call reported them: no breakdown (the old shape).
  assert.deepEqual(mergeUsage([{ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }]), { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });

  const costs = mergeCosts([calculateCost('gpt-5.4-mini', reasoningUsage({ cost: 0.001 })), calculateCost('gpt-5.4-mini', reasoningUsage())]);
  assert.equal(costs.reasoningTokens, 1280);
  assert.equal(costs.providerCost, 0.001);
  // The reported call counts at what the provider charged, the other at the estimate.
  assert.equal(costs.totalCost, 0.0058588);
  assert.equal(costs.estimatedCost, 0.0097176);
});

test('merged costs keep the source: provider when every cost is provider-reported, mixed when only some are', () => {
  // A model with no price here: every call's cost is the provider's.
  const unpriced = calculateCost('acme/sql-1', reasoningUsage({ cost: 0.01 }));
  const question = mergeCosts([unpriced, unpriced]);
  assert.deepEqual([question.source, question.totalCost, question.providerCost], ['provider', 0.02, 0.02]);
  assert.equal('estimatedCost' in question, false, 'no price here: no estimate to sum');
  const run = mergeCosts([question, question]);
  assert.deepEqual([run.source, run.totalCost], ['provider', 0.04]);
  assert.match(
    formatUsageAndCost({ usage: mergeUsage([reasoningUsage({ cost: 0.01 }), reasoningUsage({ cost: 0.01 })]), cost: question, model: 'acme/sql-1' }),
    /^\$0\.020000 \(4000 input.*, acme\/sql-1, cost reported by the provider\)$/
  );

  // Some calls reported, some estimated: the total says it is mixed.
  const reported = calculateCost('gpt-5.4-mini', reasoningUsage({ cost: 0.0042 }));
  const estimated = calculateCost('gpt-5.4-mini', reasoningUsage());
  const mixed = mergeCosts([reported, estimated]);
  assert.deepEqual([mixed.source, mixed.totalCost, mixed.estimatedCost], ['mixed', 0.0090588, 0.0097176]);
  assert.match(
    formatUsageAndCost({ usage: mergeUsage([reasoningUsage({ cost: 0.0042 }), reasoningUsage()]), cost: mixed, model: 'gpt-5.4-mini' }),
    /, gpt-5\.4-mini, cost partly reported by the provider \(local estimate \$0\.009718\)\)$/
  );
  assert.equal(mergeCosts([mixed, question]).source, 'mixed');
  assert.equal(mergeCosts([question, estimated]).source, 'mixed');
  assert.equal(mergeCosts([reported, null, reported]).source, 'provider');
  // Estimates only: no source, the shape the committed baseline was recorded with.
  assert.equal('source' in mergeCosts([estimated, estimated]), false);
});

test('the CLI cost line names the reasoning tokens and a provider-reported cost', () => {
  const usage = reasoningUsage();
  assert.equal(
    formatUsageAndCost({ usage, cost: calculateCost('gpt-5.4-mini', usage), model: 'gpt-5.4-mini' }),
    '$0.004859 (2000 input, 1024 cached input (51.2%) + 900 output tokens incl. 640 reasoning, gpt-5.4-mini)'
  );
  const provider = reasoningUsage({ cost: 0.0123 });
  assert.match(
    formatUsageAndCost({ usage: provider, cost: calculateCost('acme/sql-1', provider), model: 'acme/sql-1' }),
    /^\$0\.012300 \(2000 input.* \+ 900 output tokens incl\. 640 reasoning, acme\/sql-1, cost reported by the provider\)$/
  );
  // Priced here too: the charge is the cost, the local estimate is named beside it.
  assert.equal(
    formatUsageAndCost({ usage: provider, cost: calculateCost('gpt-5.4-mini', provider), model: 'gpt-5.4-mini' }),
    '$0.012300 (2000 input, 1024 cached input (51.2%) + 900 output tokens incl. 640 reasoning, gpt-5.4-mini, cost reported by the provider (local estimate $0.004859))'
  );
  assert.equal(formatUsageAndCost({ usage: { prompt_tokens: 10, completion_tokens: 5 }, cost: null, model: 'x' }), 'cost unavailable (10 input + 5 output tokens, x)');
});

function reasoningClient(usages) {
  let call = 0;
  return {
    chat: {
      completions: {
        async create(request) {
          const usage = usages[Math.min(call, usages.length - 1)];
          const sql = call === 0 && usages.length > 1 ? 'SELECT * FROM Secrets' : 'SELECT CustomerName FROM Customer';
          call += 1;
          return {
            id: `resp_${call}`,
            model: request.model,
            usage,
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sql, explanation: '', tables_used: ['Customer'], assumptions: [] }) } }],
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
      columns: [{ name: 'CustomerName', type: 'STRING(100)', allowNull: false, primaryKey: false, references: null, comment: null }],
      foreignKeys: [],
      ignoredForeignKeys: [],
    },
  ],
};

test('a provider-reported cost above the estimate is what totals and the --budget-usd pool count', async () => {
  // OpenRouter billed $0.02 for a call the price list estimates at $0.0048588.
  const call = calculateCost('openai/gpt-5.4-mini', reasoningUsage({ cost: 0.02 }));
  assert.equal(call.totalCost, 0.02);
  assert.deepEqual([call.inputCost, call.outputCost, call.estimatedCost], [0.0008088, 0.00405, 0.0048588]);
  const question = mergeCosts([call, call]);
  assert.deepEqual([question.totalCost, question.providerCost, question.estimatedCost], [0.04, 0.04, 0.0097176]);

  // A case (two calls) is charged $0.04: under a $0.05 budget the second
  // case still starts (0.04 < 0.05) and the third does not (0.08).
  const run = await runCaseRepetitions({
    cases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    concurrency: 1,
    budgetUsd: 0.05,
    runRepetition: async () => ({ status: 'pass', attempts: [], llm_cost: mergeCosts([call, call]) }),
  });
  assert.equal(costOfResult(run.repetitions[0][0]), 0.04);
  assert.equal(run.spentUsd, 0.08);
  assert.deepEqual(run.skippedCaseIds, ['c']);

  // The product loop sums each call's reported cost into the question's total.
  const result = await runOptimizedQuestion({
    client: reasoningClient([reasoningUsage({ cost: 0.02 }), reasoningUsage({ cost: 0.03 })]),
    connection: { query: async () => [[{ CustomerName: 'Acme' }]] },
    schema,
    model: 'gpt-5.4-mini',
    reasoningEffort: 'low',
    question: 'List customer names',
    maxRetries: 1,
    statementTimeoutMs: 0,
  });
  assert.equal(result.success, true, result.error?.message);
  assert.deepEqual(result.llmCalls.map((entry) => entry.cost.totalCost), [0.02, 0.03]);
  assert.equal(result.llmCost.totalCost, 0.05);
  assert.equal(result.llmCost.estimatedCost, 0.0097176);
});

test('with your own provider key (OpenRouter BYOK) the charge includes the upstream cost, so --budget-usd still stops the run', async () => {
  // 100k input + 20k output tokens of gpt-5.4-mini: an estimate of
  // 0.075 + 0.09 = $0.165. With BYOK, usage.cost is only OpenRouter's fee (5%
  // here, or 0) and the provider's charge is cost_details.upstream_inference_cost.
  const byokUsage = (extra = {}) => ({ prompt_tokens: 100_000, completion_tokens: 20_000, total_tokens: 120_000, is_byok: true, ...extra });
  const feeAndUpstream = calculateCost('openai/gpt-5.4-mini', byokUsage({ cost: 0.00825, cost_details: { upstream_inference_cost: 0.165 } }));
  assert.deepEqual(
    [feeAndUpstream.source, feeAndUpstream.totalCost, feeAndUpstream.providerCost, feeAndUpstream.estimatedCost],
    ['provider', 0.17325, 0.17325, 0.165]
  );
  // The review's probe: no fee, the whole charge upstream. It used to count $0.
  const noFee = calculateCost('openai/gpt-5.4-mini', byokUsage({ cost: 0, cost_details: { upstream_inference_cost: 0.165 } }));
  assert.deepEqual([noFee.source, noFee.totalCost, noFee.providerCost, noFee.estimatedCost], ['provider', 0.165, 0.165, 0.165]);
  assert.equal(
    formatUsageAndCost({ usage: byokUsage({ cost: 0.00825 }), cost: feeAndUpstream, model: 'openai/gpt-5.4-mini' }),
    '$0.173250 (100000 input + 20000 output tokens, gpt-5.4-mini, cost reported by the provider (local estimate $0.165000))'
  );
  // An unpriced model's BYOK charge is the sum too.
  assert.equal(calculateCost('acme/sql-1', byokUsage({ cost: 0.001, cost_details: { upstream_inference_cost: 0.02 } })).totalCost, 0.021);

  // BYOK without the upstream cost: the fee alone is not the charge. A priced
  // model keeps its estimate as the cost (as with no reported cost); a model
  // with no price has no cost.
  const partial = calculateCost('openai/gpt-5.4-mini', byokUsage({ cost: 0 }));
  assert.equal(partial.totalCost, 0.165);
  assert.equal('source' in partial, false);
  assert.equal('providerCost' in partial, false);
  assert.equal('estimatedCost' in partial, false);
  assert.equal(calculateCost('openai/gpt-5.4-mini', byokUsage({ cost: 0.00825, cost_details: { upstream_inference_cost: null } })).totalCost, 0.165);
  assert.equal(calculateCost('acme/sql-1', byokUsage({ cost: 0.001 })), null);

  // Not BYOK: usage.cost is the whole charge, and an upstream cost is not added again.
  const notByok = { prompt_tokens: 100_000, completion_tokens: 20_000, total_tokens: 120_000, is_byok: false };
  assert.equal(calculateCost('openai/gpt-5.4-mini', { ...notByok, cost: 0.2, cost_details: { upstream_inference_cost: null } }).totalCost, 0.2);
  assert.equal(calculateCost('openai/gpt-5.4-mini', { ...notByok, cost: 0.2, cost_details: { upstream_inference_cost: 0.19 } }).totalCost, 0.2);
  // No is_byok at all (OpenRouter's documented example): an upstream cost is BYOK's, so it counts.
  assert.equal(calculateCost('acme/sql-1', { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.95, cost_details: { upstream_inference_cost: 19 } }).totalCost, 19.95);
  assert.equal(calculateCost('acme/sql-1', { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.95, cost_details: { upstream_inference_cost: 0 } }).totalCost, 0.95);

  // The budget pool counts the whole charge: each case (one BYOK call) spends
  // $0.165 of a $0.30 budget, so the second case starts (0.165 < 0.30) and
  // the third does not (0.33). Counting only the fee ($0) ran all three.
  const run = await runCaseRepetitions({
    cases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    concurrency: 1,
    budgetUsd: 0.3,
    runRepetition: async () => ({ status: 'pass', attempts: [], llm_cost: mergeCosts([noFee]) }),
  });
  assert.equal(costOfResult(run.repetitions[0][0]), 0.165);
  assert.equal(run.spentUsd, 0.33);
  assert.deepEqual(run.skippedCaseIds, ['c']);
});

test('the product loop keeps each call\'s reasoning tokens and sums them over retries (result, trace)', async () => {
  const first = reasoningUsage();
  const second = reasoningUsage({ completion_tokens: 500, total_tokens: 2500, completion_tokens_details: { reasoning_tokens: 300 } });
  const response = await generateOptimizedResponse({ client: reasoningClient([first]), model: 'gpt-5.4-mini', prompt: { system: 's', user: 'u' }, modelConfig: { reasoningEffort: 'low' } });
  assert.deepEqual(response.usage.completion_tokens_details, { reasoning_tokens: 640, audio_tokens: 0 });
  assert.equal(response.cost.reasoningTokens, 640);

  const trace = createBufferedTraceLogger({ enabled: true });
  const result = await runOptimizedQuestion({
    client: reasoningClient([first, second]),
    connection: { query: async () => [[{ CustomerName: 'Acme' }]] },
    schema,
    model: 'gpt-5.4-mini',
    reasoningEffort: 'low',
    question: 'List customer names',
    maxRetries: 1,
    statementTimeoutMs: 0,
    trace,
  });
  assert.equal(result.success, true, result.error?.message);
  assert.deepEqual(result.llmUsage.completion_tokens_details, { reasoning_tokens: 940 });
  assert.equal(result.llmCost.reasoningTokens, 940);
  assert.deepEqual(result.llmCalls.map((call) => call.usage.completion_tokens_details.reasoning_tokens), [640, 300]);
  const completed = trace.events.find((event) => event.event === 'question.completed');
  assert.equal(completed.llmUsage.completion_tokens_details.reasoning_tokens, 940);
  assert.deepEqual(
    trace.events.filter((event) => event.event === 'llm.completed').map((event) => event.response.usage.completion_tokens_details.reasoning_tokens),
    [640, 300]
  );
});

test('a question and a run of a model priced only by the provider keep the provider label', async () => {
  const usage = reasoningUsage({ cost: 0.01 });
  const result = await runOptimizedQuestion({
    client: reasoningClient([usage, usage]),
    connection: { query: async () => [[{ CustomerName: 'Acme' }]] },
    schema,
    model: 'acme/sql-1',
    question: 'List customer names',
    maxRetries: 1,
    statementTimeoutMs: 0,
  });
  assert.equal(result.success, true, result.error?.message);
  assert.deepEqual(result.llmCalls.map((entry) => entry.cost.source), ['provider', 'provider']);
  assert.deepEqual([result.llmCost.source, result.llmCost.totalCost], ['provider', 0.02]);
  assert.match(formatUsageAndCost({ usage: result.llmUsage, cost: mergeCosts([result.llmCost]), model: 'acme/sql-1' }), /, acme\/sql-1, cost reported by the provider\)$/);
});

const compactRepetition = (repetition) => compactReport({ results: [{ id: 'case_1', repetitions: [repetition] }] }).results[0].repetitions[0];

test('reports sum the reasoning tokens; compact baselines keep them and a provider cost', () => {
  const repetition = (usage) => ({ status: 'pass', outcome: 'pass', attempts: [{ attempt: 1, retry: false, llm: { ok: true, durationMs: 1000, usage, cost: { totalCost: 0.001 } } }], attempt_count: 1, llm_usage: usage, llm_cost: { totalCost: 0.001 }, timings: { totalMs: 1000 } });
  const usage = summarizeRunUsage([
    { repetitions: [repetition(mergeUsage([reasoningUsage()]))] },
    { repetitions: [repetition({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 })] },
  ]);
  assert.deepEqual(usage.tokens, { prompt: 2100, cached: 1024, completion: 910, reasoning: 640, total: 3010 });

  const compact = compactRepetition(repetition(reasoningUsage({ cost: 0.0042 })));
  assert.deepEqual(compact.llm_usage, {
    prompt_tokens: 2000,
    completion_tokens: 900,
    total_tokens: 2900,
    prompt_tokens_details: { cached_tokens: 1024 },
    completion_tokens_details: { reasoning_tokens: 640 },
    cost: 0.0042,
  });
  // gpt-4o-mini reports reasoning_tokens 0: nothing is added to a baseline.
  const mini = compactRepetition(repetition({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 0 } }));
  assert.deepEqual(mini.llm_usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});
