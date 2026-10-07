import assert from 'node:assert/strict';
import test from 'node:test';

import { compactReport } from '../src/eval/compact-report.js';
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
  assert.equal(cost.source, undefined, 'priced here: the estimate is the cost');
  // A usage without the breakdowns has neither field.
  const plain = calculateCost('gpt-5.4-mini', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal('reasoningTokens' in plain, false);
  assert.equal('providerCost' in plain, false);

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
