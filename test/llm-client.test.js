import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_TIMEOUT_MS,
  LlmResponseError,
  createOpenAiClient,
  generateBasicSql,
  generateOptimizedResponse,
  resolveOpenAiClientOptions,
} from '../src/pipeline.js';

const prompt = { system: 'system prompt', user: 'user prompt' };

function createFakeClient(choice, { usage = { prompt_tokens: 50, completion_tokens: 3200, total_tokens: 3250 } } = {}) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        async create(request, options) {
          requests.push({ request, options });
          return { id: 'resp_fake', model: request.model, usage, choices: [choice] };
        },
      },
    },
  };
}

// WEB-4: the SDK defaults (10-minute timeout, 2 transport retries) were never
// overridden, so one question could run for over an hour against a hung provider.
test('createOpenAiClient passes explicit timeout and maxRetries to the SDK', () => {
  const defaults = createOpenAiClient({ env: { OPENAI_API_KEY: 'sk-test' } });
  assert.equal(defaults.timeout, DEFAULT_OPENAI_TIMEOUT_MS);
  assert.equal(defaults.maxRetries, DEFAULT_OPENAI_MAX_RETRIES);
  assert.equal(DEFAULT_OPENAI_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_OPENAI_MAX_RETRIES, 1);

  const fromEnv = createOpenAiClient({ env: { OPENAI_API_KEY: 'sk-test', OPENAI_TIMEOUT_MS: '15000', OPENAI_MAX_RETRIES: '0' } });
  assert.equal(fromEnv.timeout, 15_000);
  assert.equal(fromEnv.maxRetries, 0);

  const explicit = createOpenAiClient({
    timeoutMs: 1234,
    maxRetries: 3,
    env: { OPENAI_API_KEY: 'sk-test', OPENAI_TIMEOUT_MS: '15000', OPENAI_MAX_RETRIES: '0' },
  });
  assert.equal(explicit.timeout, 1234);
  assert.equal(explicit.maxRetries, 3);
});

test('createOpenAiClient fails with typed errors for a missing key or invalid transport settings', () => {
  assert.throws(() => createOpenAiClient({ env: {} }), { code: 'OPENAI_NOT_CONFIGURED' });
  for (const env of [{ OPENAI_TIMEOUT_MS: 'soon' }, { OPENAI_TIMEOUT_MS: '0' }, { OPENAI_MAX_RETRIES: '-1' }, { OPENAI_MAX_RETRIES: '2.5' }]) {
    assert.throws(
      () => resolveOpenAiClientOptions({}, env),
      (error) => error.code === 'INVALID_CONFIG' && /OPENAI_(TIMEOUT_MS|MAX_RETRIES)/.test(error.message),
      JSON.stringify(env)
    );
  }
});

test('generateOptimizedResponse throws LLM_TRUNCATED instead of parsing a length-truncated completion', async () => {
  const client = createFakeClient({
    finish_reason: 'length',
    message: { content: '{"sql":"SELECT c.CustomerName FROM Customer c WHERE c.IsAct' },
  });

  await assert.rejects(generateOptimizedResponse({ client, model: 'gpt-4o-mini', prompt }), (error) => {
    assert.ok(error instanceof LlmResponseError);
    assert.equal(error.code, 'LLM_TRUNCATED');
    assert.equal(error.stage, 'llm');
    assert.equal(error.finishReason, 'length');
    // The tokens were billed; usage/cost travel with the error.
    assert.equal(error.usage.total_tokens, 3250);
    assert.ok(error.cost);
    return true;
  });
});

test('generateOptimizedResponse throws LLM_REFUSED for content_filter and structured-output refusals', async () => {
  const filtered = createFakeClient({ finish_reason: 'content_filter', message: { content: '' } });
  await assert.rejects(generateOptimizedResponse({ client: filtered, model: 'gpt-4o-mini', prompt }), {
    name: 'LlmResponseError',
    code: 'LLM_REFUSED',
  });

  const refused = createFakeClient({ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } });
  await assert.rejects(generateOptimizedResponse({ client: refused, model: 'gpt-4o-mini', prompt }), (error) => {
    assert.equal(error.code, 'LLM_REFUSED');
    assert.equal(error.refusal, 'I cannot help with that.');
    return true;
  });
});

test('generateBasicSql applies the same finish_reason checks', async () => {
  const truncated = createFakeClient({ finish_reason: 'length', message: { content: 'SELECT * FROM Cust' } });
  await assert.rejects(generateBasicSql({ client: truncated, model: 'gpt-4o-mini', prompt }), { code: 'LLM_TRUNCATED' });

  const filtered = createFakeClient({ finish_reason: 'content_filter', message: { content: '' } });
  await assert.rejects(generateBasicSql({ client: filtered, model: 'gpt-4o-mini', prompt }), { code: 'LLM_REFUSED' });

  const ok = createFakeClient({ finish_reason: 'stop', message: { content: '```sql\nSELECT 1\n```' } });
  const generated = await generateBasicSql({ client: ok, model: 'gpt-4o-mini', prompt });
  assert.equal(generated.sql, 'SELECT 1');
  assert.equal(generated.finishReason, 'stop');
});

test('a complete completion still parses normally and forwards the abort signal', async () => {
  const client = createFakeClient({
    finish_reason: 'stop',
    message: { content: JSON.stringify({ sql: 'SELECT 1', explanation: 'one', tables_used: [], assumptions: [] }) },
  });
  const controller = new AbortController();
  const response = await generateOptimizedResponse({ client, model: 'gpt-4o-mini', prompt, signal: controller.signal });
  assert.equal(response.sql, 'SELECT 1');
  assert.equal(response.finishReason, 'stop');
  assert.equal(client.requests[0].options.signal, controller.signal);
});
