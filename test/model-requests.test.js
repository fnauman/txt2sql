import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

import { resolveCompletionSettings } from '../src/model-config.js';
import { createOpenAiClient, generateBasicSql, generateOptimizedResponse } from '../src/pipeline.js';

// The exact HTTP request bodies each model gets, through the real OpenAI SDK
// against a local OpenAI-compatible stand-in (no network, no key). The
// expected bodies are written out literally: gpt-4o-mini's must stay byte for
// byte the request of the committed baseline.

const prompt = { system: 'system prompt', user: 'user prompt' };
const messages = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'user prompt' },
];
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'text_to_sql_response',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sql', 'explanation', 'tables_used', 'assumptions'],
      properties: {
        sql: { type: 'string' },
        explanation: { type: 'string' },
        tables_used: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

let server;
let baseUrl;
const received = [];

before(async () => {
  server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    received.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    const parsed = JSON.parse(body);
    const content = parsed.response_format ? JSON.stringify({ sql: 'SELECT 1', explanation: '', tables_used: [], assumptions: [] }) : 'SELECT 1';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-local',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const FAKE_KEY = 'fake-key-for-a-local-stub';

// The bytes the SDK puts on the wire for a request body (it indents by 2).
const wire = (body) => JSON.stringify(body, null, 2);

function localClient(env = {}) {
  return createOpenAiClient({ env: { OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: baseUrl, OPENAI_MAX_RETRIES: '0', ...env } });
}

// A client configured for https://openrouter.ai whose requests reach the
// local stand-in instead (the SDK's fetch is replaced; nothing leaves the host).
function openRouterClient(env = {}) {
  const openRouterBase = 'https://openrouter.ai/api/v1';
  return createOpenAiClient({
    env: { OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: openRouterBase, OPENAI_MAX_RETRIES: '0', ...env },
    fetch: (url, init) => {
      assert.ok(String(url).startsWith(openRouterBase), `the SDK targets OpenRouter: ${url}`);
      return fetch(String(url).replace(openRouterBase, baseUrl), init);
    },
  });
}

async function lastBodyOf(call) {
  const before = received.length;
  await call();
  assert.equal(received.length, before + 1, 'one HTTP request per call (no retry)');
  const last = received.at(-1);
  assert.equal(last.method, 'POST');
  assert.equal(last.url, '/v1/chat/completions');
  return last.body;
}

test('gpt-4o-mini: the optimized and basic requests are byte for byte unchanged', async () => {
  const client = localClient();
  const optimized = await lastBodyOf(() => generateOptimizedResponse({ client, model: 'gpt-4o-mini', prompt }));
  assert.equal(optimized, wire({ model: 'gpt-4o-mini', temperature: 0, max_completion_tokens: 3200, response_format: RESPONSE_FORMAT, messages }));
  // The resolved settings of a default setup change nothing either.
  const withSettings = await lastBodyOf(() =>
    generateOptimizedResponse({ client, model: 'gpt-4o-mini', prompt, modelConfig: { ...resolveCompletionSettings({}), reasoningEffort: null } })
  );
  assert.equal(withSettings, optimized);
  const basic = await lastBodyOf(() => generateBasicSql({ client, model: 'gpt-4o-mini', prompt }));
  assert.equal(basic, wire({ model: 'gpt-4o-mini', temperature: 0, max_completion_tokens: 1200, messages }));
  assert.equal(received.at(-1).authorization, `Bearer ${FAKE_KEY}`);
});

test('gpt-6-luna: effort none keeps temperature 0; low and medium drop it, send the effort and raise the token limit', async () => {
  const client = localClient();
  const body = (reasoningEffort) =>
    lastBodyOf(() => generateOptimizedResponse({ client, model: 'gpt-6-luna', prompt, modelConfig: { ...resolveCompletionSettings({}), reasoningEffort } }));
  assert.equal(
    await body('none'),
    wire({ model: 'gpt-6-luna', temperature: 0, max_completion_tokens: 3200, response_format: RESPONSE_FORMAT, reasoning_effort: 'none', messages })
  );
  for (const effort of ['low', 'medium']) {
    assert.equal(
      await body(effort),
      wire({ model: 'gpt-6-luna', max_completion_tokens: 16000, response_format: RESPONSE_FORMAT, reasoning_effort: effort, messages })
    );
  }
  // LLM_MAX_COMPLETION_TOKENS sets the limit of a reasoning request.
  const capped = await lastBodyOf(() =>
    generateOptimizedResponse({ client, model: 'gpt-6-luna', prompt, modelConfig: { ...resolveCompletionSettings({ LLM_MAX_COMPLETION_TOKENS: '8000' }), reasoningEffort: 'low' } })
  );
  assert.equal(JSON.parse(capped).max_completion_tokens, 8000);
  // The retry request and the basic pipeline go through the same options.
  const retry = JSON.parse(
    await lastBodyOf(() =>
      generateOptimizedResponse({
        client,
        model: 'gpt-6-luna',
        prompt,
        retryContext: { sql: 'SELECT', error: 'syntax error', stage: 'execution' },
        modelConfig: { reasoningEffort: 'low' },
      })
    )
  );
  assert.deepEqual(Object.keys(retry), ['model', 'max_completion_tokens', 'response_format', 'reasoning_effort', 'messages']);
  assert.equal(retry.reasoning_effort, 'low');
  assert.equal(retry.messages.length, 4);
  const basic = await lastBodyOf(() => generateBasicSql({ client, model: 'gpt-6-luna', prompt, modelConfig: { reasoningEffort: 'medium' } }));
  assert.equal(basic, wire({ model: 'gpt-6-luna', max_completion_tokens: 16000, reasoning_effort: 'medium', messages }));
});

test('an unknown model keeps the request every model had before; with an effort it is treated as a reasoning model', async () => {
  const client = localClient();
  const plain = await lastBodyOf(() => generateOptimizedResponse({ client, model: 'acme-sql-1', prompt, modelConfig: resolveCompletionSettings({}) }));
  assert.equal(plain, wire({ model: 'acme-sql-1', temperature: 0, max_completion_tokens: 3200, response_format: RESPONSE_FORMAT, messages }));
  const reasoning = await lastBodyOf(() => generateOptimizedResponse({ client, model: 'acme-sql-1', prompt, modelConfig: { reasoningEffort: 'high' } }));
  assert.equal(reasoning, wire({ model: 'acme-sql-1', max_completion_tokens: 16000, response_format: RESPONSE_FORMAT, reasoning_effort: 'high', messages }));
});

test('OpenRouter: vendor-prefixed ids pass through and provider.require_parameters is on unless OPENROUTER_REQUIRE_PARAMETERS=0', async () => {
  const env = { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' };
  const client = openRouterClient();
  const luna = await lastBodyOf(() =>
    generateOptimizedResponse({ client, model: 'openai/gpt-6-luna', prompt, modelConfig: { ...resolveCompletionSettings(env), reasoningEffort: 'low' } })
  );
  assert.equal(
    luna,
    wire({
      model: 'openai/gpt-6-luna',
      max_completion_tokens: 16000,
      response_format: RESPONSE_FORMAT,
      reasoning_effort: 'low',
      provider: { require_parameters: true },
      messages,
    })
  );
  assert.equal(received.at(-1).authorization, `Bearer ${FAKE_KEY}`);
  const mini = await lastBodyOf(() => generateOptimizedResponse({ client, model: 'openai/gpt-4o-mini', prompt, modelConfig: resolveCompletionSettings(env) }));
  assert.equal(
    mini,
    wire({ model: 'openai/gpt-4o-mini', temperature: 0, max_completion_tokens: 3200, response_format: RESPONSE_FORMAT, provider: { require_parameters: true }, messages })
  );
  const off = await lastBodyOf(() =>
    generateOptimizedResponse({ client, model: 'openai/gpt-4o-mini', prompt, modelConfig: resolveCompletionSettings({ ...env, OPENROUTER_REQUIRE_PARAMETERS: '0' }) })
  );
  assert.equal(off, wire({ model: 'openai/gpt-4o-mini', temperature: 0, max_completion_tokens: 3200, response_format: RESPONSE_FORMAT, messages }));
});

test('an effort that does not fit the model never reaches the provider', async () => {
  const client = localClient();
  const before = received.length;
  await assert.rejects(generateOptimizedResponse({ client, model: 'gpt-4o-mini', prompt, modelConfig: { reasoningEffort: 'low' } }), { code: 'INVALID_CONFIG' });
  await assert.rejects(generateBasicSql({ client, model: 'gpt-6-luna', prompt, modelConfig: { reasoningEffort: 'extreme' } }), { code: 'INVALID_CONFIG' });
  assert.equal(received.length, before);
});
