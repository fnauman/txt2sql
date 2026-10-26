import assert from 'node:assert/strict';
import test from 'node:test';

import { describeModelProduct } from '../src/eval/provenance.js';
import { completionSettingsOf, normalizeReasoningEffort, resolveModelConfig } from '../src/model-config.js';
import { createOpenAiClient, generateOptimizedResponse } from '../src/pipeline.js';
import { calculateCost, mergeUsage } from '../src/pricing.js';

const answer = JSON.stringify({ sql: 'SELECT 1', explanation: 'ok', tables_used: [], assumptions: [] });
const signed = [
  { type: 'thinking', thinking: '', signature: 'opaque-signed-block' },
  { type: 'text', text: answer },
];
const prompt = {
  system: 'instructions',
  user: 'stable schema\n\nquestion',
  context: { promptCache: { cacheablePrefixChars: 'instructions'.length + 'stable schema'.length } },
};

for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
  for (const effort of ['low', 'high']) {
    test(`${model} ${effort}: native wire format, cache prefix, usage, and signed retry`, async () => {
      const env = {
        ANTHROPIC_API_KEY: 'native-test-key',
        OPENAI_API_KEY: 'wrong-provider-key',
        MODEL_NAME: model,
        REASONING_EFFORT: effort,
        OPENAI_MAX_RETRIES: '0',
      };
      const config = resolveModelConfig({ env });
      assert.equal(config.baseUrlHost, 'api.anthropic.com');
      const requests = [];
      const client = createOpenAiClient({
        env,
        fetch: async (url, init) => {
          assert.equal(url, 'https://api.anthropic.com/v1/messages');
          assert.equal(init.headers.get('x-api-key'), 'native-test-key');
          assert.equal(init.headers.get('authorization'), null);
          assert.equal(init.headers.get('content-length'), null);
          requests.push(JSON.parse(init.body));
          return Response.json({
            id: 'native-id',
            model,
            content: signed,
            stop_reason: 'end_turn',
            usage: { input_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 10 },
          });
        },
      });
      const modelConfig = { ...completionSettingsOf(config), reasoningEffort: effort };
      const result = await generateOptimizedResponse({ client, model, prompt, modelConfig });

      const first = requests[0];
      assert.deepEqual(first.thinking, { type: 'adaptive', display: 'omitted' });
      assert.equal(first.output_config.effort, effort);
      assert.equal(first.output_config.format.type, 'json_schema');
      assert.equal(first.max_tokens, 16000);
      assert.equal(first.temperature, undefined);
      assert.equal(first.reasoning_effort, undefined);
      assert.deepEqual(first.system, [{ type: 'text', text: prompt.system }]);
      // The cache breakpoint splits the user text without changing a character.
      assert.equal(first.messages[0].content.map((block) => block.text).join(''), prompt.user);
      assert.deepEqual(first.messages[0].content[0].cache_control, { type: 'ephemeral' });

      assert.equal(result.sql, 'SELECT 1');
      assert.equal(result.usage.prompt_tokens, 150);
      assert.equal(result.usage.total_tokens, 160);
      assert.equal(result.usage.completion_tokens_details, undefined);

      // A corrective retry replays the signed thinking blocks unchanged.
      await generateOptimizedResponse({
        client,
        model,
        prompt,
        modelConfig,
        retryContext: { sql: result.sql, error: 'guardrail', assistantMessage: result.assistantMessage },
      });
      assert.deepEqual(requests[1].messages[1].content, signed);
    });
  }
}

for (const model of ['google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash']) {
  test(`${model}: OpenRouter reasoning controls and reasoning_details round-trip unchanged`, async () => {
    const env = {
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-test-key',
      MODEL_NAME: model,
      REASONING_EFFORT: 'high',
      OPENAI_MAX_RETRIES: '0',
    };
    const config = resolveModelConfig({ env });
    const requests = [];
    const details = [{ type: 'reasoning.encrypted', data: 'opaque', id: 'reasoning-id', format: 'google-gemini-v1' }];
    const client = createOpenAiClient({
      env,
      fetch: async (url, init) => {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer router-test-key');
        requests.push(JSON.parse(init.body));
        return Response.json({
          id: 'gemini-id',
          model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer, reasoning_details: details } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 },
        });
      },
    });
    const result = await generateOptimizedResponse({
      client,
      model,
      prompt,
      modelConfig: { ...completionSettingsOf(config), reasoningEffort: 'high' },
    });
    assert.deepEqual(requests[0].reasoning, { enabled: true, effort: 'high' });
    assert.equal(requests[0].reasoning_effort, undefined);
    assert.equal(requests[0].max_tokens, 16000);
    assert.deepEqual(requests[0].provider, { require_parameters: true });
    assert.equal(result.cost.source, 'provider');

    await generateOptimizedResponse({
      client,
      model,
      prompt,
      modelConfig: { ...completionSettingsOf(config), reasoningEffort: 'low' },
      retryContext: { sql: result.sql, error: 'guardrail', assistantMessage: result.assistantMessage },
    });
    assert.deepEqual(requests[1].reasoning, { enabled: true, effort: 'low' });
    assert.deepEqual(requests[1].messages[2].reasoning_details, details);
  });
}

test('Claude cache writes are billed separately from uncached input and cache reads', () => {
  const cost = calculateCost('claude-sonnet-5-5', {
    prompt_tokens: 150,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 100, cache_creation_tokens: 20 },
  });
  assert.equal(cost.inputCost, 0.00012); // (30 * $2 + 20 * $2.50 + 100 * $0.10) / 1M
  assert.equal(cost.outputCost, 0.0001);
  assert.equal(cost.totalCost, 0.00022);
});

test('Provider models reject unsupported effort before any call', () => {
  assert.throws(() => normalizeReasoningEffort('claude-sonnet-5-5', 'none'), /not supported/);
  assert.throws(() => normalizeReasoningEffort('google/gemini-3.8-flash', 'xhigh'), /not supported/);
  assert.throws(() => normalizeReasoningEffort('deepseek/deepseek-v4.1-flash', 'medium'), /not supported/);
});

test('Native Claude requires its own key and records native options without repeating the schema', () => {
  assert.throws(
    () => createOpenAiClient({ model: 'claude-haiku-5-5', env: { OPENAI_API_KEY: 'wrong-provider-key' } }),
    (error) => error.code === 'ANTHROPIC_NOT_CONFIGURED'
  );
  const config = resolveModelConfig({ env: { MODEL_NAME: 'claude-sonnet-5-5' } });
  const product = describeModelProduct({ ...config, completionSettings: completionSettingsOf(config) });
  assert.deepEqual(product.requestOptions, {
    max_tokens: 16000,
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: 'high' },
  });
});

test('Native Claude truncation retains billed usage and refuses to parse partial output', async () => {
  const model = 'claude-haiku-5-5';
  const client = createOpenAiClient({
    env: { MODEL_NAME: model, ANTHROPIC_API_KEY: 'test-key' },
    fetch: async () =>
      Response.json({
        id: 'truncated',
        model,
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{"sql":' }],
        usage: { input_tokens: 50, output_tokens: 16000 },
      }),
  });
  await assert.rejects(
    generateOptimizedResponse({ client, model, prompt }),
    (error) => error.code === 'LLM_TRUNCATED' && error.usage.completion_tokens === 16000 && error.cost.totalCost > 0
  );
});

test('A malformed native reply still replays its signed thinking on the corrective retry', async () => {
  const model = 'claude-sonnet-5-5';
  const malformed = [
    { type: 'thinking', thinking: '', signature: 'signed-malformed' },
    { type: 'text', text: 'SELECT 1 -- not JSON' },
  ];
  const requests = [];
  let call = 0;
  const client = createOpenAiClient({
    env: { MODEL_NAME: model, ANTHROPIC_API_KEY: 'test-key', OPENAI_MAX_RETRIES: '0' },
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      call += 1;
      return Response.json({
        id: `reply-${call}`,
        model,
        stop_reason: 'end_turn',
        content: call === 1 ? malformed : signed,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
  const first = await generateOptimizedResponse({ client, model, prompt });
  assert.equal(first.explanation, 'Model response was not valid JSON.');
  assert.deepEqual(first.assistantMessage.anthropic_content, malformed);
  await generateOptimizedResponse({
    client,
    model,
    prompt,
    retryContext: { sql: first.sql, error: 'invalid JSON', assistantMessage: first.assistantMessage },
  });
  assert.deepEqual(requests[1].messages[1].content, malformed);
});

test('Question usage totals keep cache-write tokens across calls', () => {
  const call = { prompt_tokens: 150, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100, cache_creation_tokens: 20 } };
  assert.deepEqual(mergeUsage([call]).prompt_tokens_details, { cached_tokens: 100, cache_creation_tokens: 20 });
  assert.deepEqual(mergeUsage([call, call]).prompt_tokens_details, { cached_tokens: 200, cache_creation_tokens: 40 });
  // OpenAI usage has no cache-write field, and its totals do not gain one.
  assert.deepEqual(mergeUsage([{ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } }]).prompt_tokens_details, { cached_tokens: 2 });
});
