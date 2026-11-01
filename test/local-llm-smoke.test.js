import assert from 'node:assert/strict';
import test from 'node:test';
import { localSmokeSettings, smokeLocalLlm, validateLocalEndpoint } from '../scripts/smoke-local-llm.mjs';

const env = { OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1', OPENAI_API_KEY: 'local-secret', MODEL_NAME: 'local-sql' };
const answer = { decision: 'answer', clarification_questions: [], sql: 'SELECT 1 AS smoke_value', explanation: 'Returns one.', tables_used: [], assumptions: [] };
const completion = (content = JSON.stringify(answer), finish_reason = 'stop') => Response.json({
  id: 'smoke-test', model: 'local-sql', choices: [{ finish_reason, message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
});

test('smoke configuration refuses hosted endpoints, URL credentials and accidental hosted model settings', () => {
  for (const endpoint of ['https://api.openai.com/v1', 'http://127.0.0.1.evil/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?key=x', 'file:///v1', 'http://localhost/api', 'http://192.168.1.2/v1']) {
    assert.throws(() => validateLocalEndpoint(endpoint), { code: 'LOCAL_LLM_CHECK_FAILED' });
  }
  assert.equal(validateLocalEndpoint('http://[::1]:8000/v1/'), 'http://[::1]:8000/v1');
  assert.throws(() => localSmokeSettings({ ...env, MODEL_NAME: 'gpt-4o' }), /MODEL_NAME must be local-sql/);
  assert.throws(() => localSmokeSettings({ ...env, OPENAI_API_KEY: '' }), /dedicated local inference secret/);
  assert.throws(() => localSmokeSettings({ ...env, LOCAL_SMOKE_TIMEOUT_MS: '1e4' }), /integer/);
});

test('one bounded local request uses application structured output and emits no credentials or model text', async () => {
  let calls = 0;
  const report = await smokeLocalLlm({ env, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:8000/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer local-secret');
    const request = JSON.parse(init.body);
    assert.equal(request.model, 'local-sql');
    assert.equal(request.max_completion_tokens, 256);
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.ok(request.response_format.json_schema.schema.required.includes('sql'));
    return completion();
  } });
  assert.equal(calls, 1);
  assert.equal(report.status, 'passed');
  assert.equal(report.usage.completionTokens, 20);
  assert.equal(JSON.stringify(report).includes('local-secret'), false);
  assert.equal(JSON.stringify(report).includes('Returns one.'), false);
});

test('smoke fails on malformed or incomplete structured output and on unexpected SQL', async () => {
  for (const output of ['not json', '{"sql":"SELECT 1 AS smoke_value"}', JSON.stringify({ ...answer, sql: 'SELECT 2 AS smoke_value' }), JSON.stringify({ ...answer, sql: 'DELETE FROM Customer' })]) {
    await assert.rejects(smokeLocalLlm({ env, fetch: async () => completion(output) }));
  }
  await assert.rejects(smokeLocalLlm({ env, fetch: async () => completion('{"sql":', 'length') }), { code: 'LLM_TRUNCATED' });
});

test('smoke has no transport retries after a provider failure', async () => {
  let calls = 0;
  await assert.rejects(smokeLocalLlm({ env, fetch: async () => { calls++; return Response.json({ error: { message: 'unavailable' } }, { status: 503 }); } }));
  assert.equal(calls, 1);
});

test('deadline and caller cancellation bound a transport that ignores abort', async () => {
  const never = async () => new Promise(() => {});
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = Date.now();
    await assert.rejects(smokeLocalLlm({ env: { ...env, LOCAL_SMOKE_TIMEOUT_MS: '100' }, fetch: never }));
    assert.ok(Date.now() - started < 2000);
    const controller = new AbortController();
    const result = smokeLocalLlm({ env, fetch: never, signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await assert.rejects(result);
  } finally { clearInterval(keepAlive); }
});
