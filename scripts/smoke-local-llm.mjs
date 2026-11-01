// Validate local settings; make one synthetic request only with --run.
// No model download, database access, hosted fallback, or transport retry.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../src/env.js';
import { createOpenAiClient } from '../src/llm-client.js';
import { generateOptimizedResponse, OPTIMIZED_MODEL_REQUEST_OPTIONS, validateSqlSafety } from '../src/pipeline.js';
import { resolveCompletionSettings } from '../src/model-config.js';

const USAGE = `Usage: node scripts/smoke-local-llm.mjs [--dotenv <file>] [--run]
Without --run: validate loopback endpoint, local-sql model and dedicated API key.
With --run: send one synthetic SELECT 1 structured-output request; never execute SQL.
Optional LOCAL_SMOKE_TIMEOUT_MS (default 10000), LOCAL_SMOKE_MAX_TOKENS (default 256).
Optional --output <file>: save a report without credentials, prompts or model text.`;

function fail(message) {
  return Object.assign(new Error(message), { code: 'LOCAL_LLM_CHECK_FAILED' });
}

export function validateLocalEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('OPENAI_BASE_URL must be an explicit loopback URL ending in /v1.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw fail('OPENAI_BASE_URL must use http(s) on 127.0.0.1, localhost or [::1], with /v1 and no credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

function integer(value, fallback, name, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw fail(`${name} must be an integer between ${min} and ${max}.`);
  return n;
}

export function localSmokeSettings(env = process.env) {
  const baseURL = validateLocalEndpoint(env.OPENAI_BASE_URL);
  const model = env.MODEL_NAME?.trim() || 'local-sql';
  if (model !== 'local-sql') throw fail('MODEL_NAME must be local-sql, the serving template model name.');
  if (!env.OPENAI_API_KEY?.trim()) throw fail('OPENAI_API_KEY must contain the dedicated local inference secret.');
  return {
    baseURL, model,
    timeoutMs: integer(env.LOCAL_SMOKE_TIMEOUT_MS, 10000, 'LOCAL_SMOKE_TIMEOUT_MS', 100, 120000),
    maxTokens: integer(env.LOCAL_SMOKE_MAX_TOKENS, 256, 'LOCAL_SMOKE_MAX_TOKENS', 32, 4096),
  };
}

export async function smokeLocalLlm({ env = process.env, fetch: transport = globalThis.fetch, signal = null } = {}) {
  const settings = localSmokeSettings(env);
  const endpoint = `${settings.baseURL}/chat/completions`;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(fail('Local inference smoke request exceeded its deadline.')), settings.timeoutMs);
  const sdk = createOpenAiClient({
    model: settings.model, timeoutMs: settings.timeoutMs, maxRetries: 0,
    env: { OPENAI_BASE_URL: settings.baseURL, OPENAI_API_KEY: env.OPENAI_API_KEY },
    fetch: (url, init) => {
      // Even a local reverse proxy may redirect. Never forward a local secret
      // to a different destination and never follow a redirect to a hosted API.
      if (String(url) !== endpoint) throw fail('The SDK attempted an unexpected endpoint.');
      return transport(url, { ...init, redirect: 'error' });
    },
  });
  const client = { chat: { completions: { create: (request, options) =>
    sdk.chat.completions.create({ ...request, max_completion_tokens: settings.maxTokens }, options),
  } } };
  const started = Date.now();
  try {
    const completionSettings = resolveCompletionSettings({ OPENAI_BASE_URL: settings.baseURL });
    const response = await generateOptimizedResponse({
      client, model: settings.model, signal: controller.signal,
      prompt: {
        system: 'This is a synthetic local inference compatibility check. Return the required structured response. Use SELECT 1 AS smoke_value with no table. Do not request clarification.',
        user: 'Use decision answer, the SQL SELECT 1 AS smoke_value, explain that it returns one, and use empty clarification_questions, tables_used and assumptions arrays.',
      },
      modelConfig: { ...completionSettings, maxCompletionTokens: settings.maxTokens, reasoningEffort: null },
    });
    let parsed;
    try { parsed = JSON.parse(response.rawText); } catch { throw fail('The local model did not return valid structured JSON.'); }
    const schema = OPTIMIZED_MODEL_REQUEST_OPTIONS.response_format.json_schema.schema;
    const validProperty = (value, property) => property.type === 'array'
      ? Array.isArray(value) && value.every(item => typeof item === property.items.type)
      : typeof value === property.type && (!property.enum || property.enum.includes(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        schema.required.some(key => !Object.hasOwn(parsed, key)) ||
        Object.entries(parsed).some(([key, value]) => !schema.properties[key] || !validProperty(value, schema.properties[key]))) {
      throw fail('The local model response does not satisfy the application SQL response contract.');
    }
    validateSqlSafety(parsed.sql, []);
    if ((parsed.decision && parsed.decision !== 'answer') || !/^SELECT\s+1\s+AS\s+smoke_value\s*;?$/i.test(parsed.sql.trim()) || parsed.tables_used.length !== 0) {
      throw fail('The local model did not return the requested table-free SELECT 1 query.');
    }
    return {
      status: 'passed', scope: 'one synthetic structured-output request; SQL was not executed',
      endpoint: settings.baseURL, model: settings.model,
      elapsedMs: Date.now() - started, deadlineMs: settings.timeoutMs, maxOutputTokens: settings.maxTokens,
      usage: response.usage ? { promptTokens: response.usage.prompt_tokens ?? null, completionTokens: response.usage.completion_tokens ?? null } : null,
      remaining: ['real SQL accuracy', 'corrective retry', 'GPU capacity released after cancellation', 'concurrent load and isolation'],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(USAGE); return; }
  await loadEnvironment(args);
  const settings = localSmokeSettings();
  const report = args.includes('--run')
    ? await smokeLocalLlm()
    : { status: 'settings-valid', requestSent: false, ...settings };
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0) {
    const file = args[outputIndex + 1];
    if (!file || file.startsWith('--')) throw fail('--output requires a filename.');
    await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // SDK messages can include provider response text; keep terminal/report
    // output bounded to a typed failure and no credentials or model response.
    console.error(JSON.stringify({ status: 'failed', code: error.code || error.name || 'ERROR',
      ...(error.code === 'LOCAL_LLM_CHECK_FAILED' ? { message: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
