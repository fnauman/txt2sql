import assert from 'node:assert/strict';
import test from 'node:test';

import { generateBasicSql, generateOptimizedResponse } from '../src/pipeline.js';
import { calculateCost, formatUsageAndCost, mergeCosts, mergeUsage } from '../src/pricing.js';

function createMockClient(content) {
  return {
    chat: {
      completions: {
        async create() {
          return {
            id: 'resp_123',
            model: 'gpt-5.4-mini-2026-03-05',
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 200,
              total_tokens: 1200,
            },
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content,
                },
              },
            ],
          };
        },
      },
    },
  };
}

test('calculateCost returns an estimate for known GPT-5.4 models', () => {
  assert.deepEqual(calculateCost('gpt-5.4-mini', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  }), {
    model: 'gpt-5.4-mini',
    currency: 'USD',
    promptTokens: 1000,
    cachedPromptTokens: 0,
    uncachedPromptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    inputCost: 0.00075,
    outputCost: 0.0009,
    totalCost: 0.00165,
  });
});

test('calculateCost resolves GPT-5.4 snapshot model names without prefix ambiguity', () => {
  const miniCost = calculateCost('gpt-5.4-mini-2026-03-05', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  });
  const nanoCost = calculateCost('gpt-5.4-nano-2026-03-05', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  });
  const baseSnapshotCost = calculateCost('gpt-5.4-2026-03-05', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  });
  const baseAliasCost = calculateCost('gpt-5.4', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  });

  assert.equal(miniCost?.model, 'gpt-5.4-mini');
  assert.equal(miniCost?.totalCost, 0.00165);
  assert.equal(nanoCost?.model, 'gpt-5.4-nano');
  assert.equal(nanoCost?.totalCost, 0.00045);
  assert.equal(baseSnapshotCost?.model, 'gpt-5.4');
  assert.equal(baseSnapshotCost?.totalCost, 0.0055);
  assert.equal(baseAliasCost?.model, 'gpt-5.4');
  assert.equal(baseAliasCost?.totalCost, 0.0055);
});

test('calculateCost prices the repo default gpt-4o-mini model', () => {
  assert.deepEqual(calculateCost('gpt-4o-mini', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  }), {
    model: 'gpt-4o-mini',
    currency: 'USD',
    promptTokens: 1000,
    cachedPromptTokens: 0,
    uncachedPromptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    inputCost: 0.00015,
    outputCost: 0.00012,
    totalCost: 0.00027,
  });
});

test('calculateCost returns null for unknown models', () => {
  assert.equal(calculateCost('gpt-unpriced', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  }), null);
});

test('calculateCost charges cached prompt tokens at the cached-input rate', () => {
  assert.deepEqual(calculateCost('gpt-5.4-mini', {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: {
      cached_tokens: 400,
    },
  }), {
    model: 'gpt-5.4-mini',
    currency: 'USD',
    promptTokens: 1000,
    cachedPromptTokens: 400,
    uncachedPromptTokens: 600,
    completionTokens: 200,
    totalTokens: 1200,
    inputCost: 0.00048,
    outputCost: 0.0009,
    totalCost: 0.00138,
  });
});

test('mergeUsage and mergeCosts sum multiple calls', () => {
  assert.deepEqual(mergeUsage([
    {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: {
        cached_tokens: 300,
      },
    },
    {
      prompt_tokens: 300,
      completion_tokens: 50,
      total_tokens: 350,
      prompt_tokens_details: {
        cached_tokens: 100,
      },
    },
  ]), {
    prompt_tokens: 1300,
    completion_tokens: 250,
    total_tokens: 1550,
    prompt_tokens_details: {
      cached_tokens: 400,
    },
  });

  assert.deepEqual(mergeCosts([
    {
      inputCost: 0.00075,
      outputCost: 0.0009,
      totalCost: 0.00165,
    },
    {
      inputCost: 0.000225,
      outputCost: 0.000225,
      totalCost: 0.00045,
    },
  ]), {
    currency: 'USD',
    inputCost: 0.000975,
    outputCost: 0.001125,
    totalCost: 0.0021,
  });
});

test('mergeCosts rejects mismatched currencies', () => {
  assert.throws(
    () =>
      mergeCosts([
        {
          currency: 'USD',
          inputCost: 0.1,
          outputCost: 0.2,
          totalCost: 0.3,
        },
        {
          currency: 'EUR',
          inputCost: 0.1,
          outputCost: 0.2,
          totalCost: 0.3,
        },
      ]),
    /Currency mismatch in mergeCosts/
  );
});

test('formatUsageAndCost renders estimated cost when available', () => {
  assert.equal(
    formatUsageAndCost({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
      },
      cost: {
        model: 'gpt-5.4-mini',
        totalCost: 0.00165,
      },
    }),
    '$0.001650 (1000 input + 200 output tokens, gpt-5.4-mini)'
  );
});

test('formatUsageAndCost renders cached prompt-token measurements when available', () => {
  assert.equal(
    formatUsageAndCost({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: {
          cached_tokens: 400,
        },
      },
      cost: {
        model: 'gpt-5.4-mini',
        cachedPromptTokens: 400,
        totalCost: 0.00138,
      },
    }),
    '$0.001380 (1000 input, 400 cached input (40.0%) + 200 output tokens, gpt-5.4-mini)'
  );
});

test('formatUsageAndCost suppresses cached percentage when prompt tokens are zero', () => {
  assert.equal(
    formatUsageAndCost({
      usage: {
        prompt_tokens: 0,
        completion_tokens: 2,
        prompt_tokens_details: {
          cached_tokens: 10,
        },
      },
      cost: {
        model: 'gpt-5.4-mini',
        cachedPromptTokens: 10,
        totalCost: 0,
      },
    }),
    '$0.000000 (0 input + 2 output tokens, gpt-5.4-mini)'
  );
});

test('generateBasicSql adds additive cost metadata when pricing is known', async () => {
  const result = await generateBasicSql({
    client: createMockClient('SELECT 1;'),
    model: 'gpt-5.4-mini',
    prompt: {
      system: 'system prompt',
      user: 'user prompt',
    },
  });

  assert.equal(result.sql, 'SELECT 1;');
  assert.equal(result.cost?.model, 'gpt-5.4-mini');
  assert.equal(result.cost?.totalCost, 0.00165);
});

test('generateOptimizedResponse keeps additive cost metadata on JSON responses', async () => {
  const result = await generateOptimizedResponse({
    client: createMockClient(JSON.stringify({
      sql: 'SELECT 1',
      explanation: 'test',
      tables_used: ['Customer'],
      assumptions: [],
    })),
    model: 'gpt-5.4-mini',
    prompt: {
      system: 'system prompt',
      user: 'user prompt',
    },
  });

  assert.equal(result.sql, 'SELECT 1');
  assert.equal(result.cost?.model, 'gpt-5.4-mini');
  assert.equal(result.cost?.totalCost, 0.00165);
});

test('calculateCost applies MODEL_PRICING_OVERRIDES parsed after env load', () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0 };
  const before = calculateCost('gpt-4o-mini', usage);
  assert.equal(before.inputCost, 0.15); // base rate

  process.env.MODEL_PRICING_OVERRIDES = JSON.stringify({ 'gpt-4o-mini': { inputPerMillion: 99 } });
  try {
    const after = calculateCost('gpt-4o-mini', usage);
    assert.equal(after.inputCost, 99); // override applied lazily, not at import time
  } finally {
    delete process.env.MODEL_PRICING_OVERRIDES;
  }

  // Removing the override restores the base rate (memo re-parses on change).
  assert.equal(calculateCost('gpt-4o-mini', usage).inputCost, 0.15);
});
