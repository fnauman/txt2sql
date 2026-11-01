import OpenAI from 'openai';

import { configError, readIntegerEnv } from './config-values.js';
import { isNativeAnthropic, resolveLlmApiKey } from './model-config.js';
import { createAnthropicClient } from './anthropic-client.js';

// Explicit transport bounds for the OpenAI SDK. Its defaults (10-minute timeout,
// 2 retries) let one question run for over an hour against a hung provider, and
// the app's own self-correction loop multiplies that. OPENAI_TIMEOUT_MS (default
// 60000) bounds each HTTP attempt; OPENAI_MAX_RETRIES (default 1) bounds
// transport retries (connection errors, 408/409/429/5xx) inside one app attempt.
export const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENAI_MAX_RETRIES = 1;

export function resolveOpenAiClientOptions({ timeoutMs, maxRetries } = {}, env = process.env) {
  const resolvedTimeoutMs =
    timeoutMs ?? readIntegerEnv(env, 'OPENAI_TIMEOUT_MS', DEFAULT_OPENAI_TIMEOUT_MS, { min: 1, max: 600_000 });
  const resolvedMaxRetries =
    maxRetries ?? readIntegerEnv(env, 'OPENAI_MAX_RETRIES', DEFAULT_OPENAI_MAX_RETRIES, { min: 0, max: 10 });

  if (!Number.isInteger(resolvedTimeoutMs) || resolvedTimeoutMs < 1) {
    throw configError(`OpenAI timeoutMs must be a positive integer; got ${timeoutMs}.`);
  }
  if (!Number.isInteger(resolvedMaxRetries) || resolvedMaxRetries < 0) {
    throw configError(`OpenAI maxRetries must be a non-negative integer; got ${maxRetries}.`);
  }

  return { timeoutMs: resolvedTimeoutMs, maxRetries: resolvedMaxRetries };
}

// `fetch` (optional) replaces the SDK's fetch: tests route an
// https://openrouter.ai base URL to a local stand-in with it.
// The key is OPENAI_API_KEY, else OPENROUTER_API_KEY for an openrouter.ai
// OPENAI_BASE_URL (resolveLlmApiKey).
export function createOpenAiClient({ timeoutMs, maxRetries, env = process.env, fetch = undefined, model = env.MODEL_NAME } = {}) {
  const providerEnv = { ...env, MODEL_NAME: model };
  const { apiKey } = resolveLlmApiKey(providerEnv);
  if (!apiKey) {
    const error = new Error(isNativeAnthropic(model, env) ? 'ANTHROPIC_API_KEY is required for a native Claude request.' : 'OPENAI_API_KEY is required (or OPENROUTER_API_KEY with an https://openrouter.ai OPENAI_BASE_URL).');
    error.code = isNativeAnthropic(model, env) ? 'ANTHROPIC_NOT_CONFIGURED' : 'OPENAI_NOT_CONFIGURED';
    throw error;
  }

  const options = resolveOpenAiClientOptions({ timeoutMs, maxRetries }, env);
  if (isNativeAnthropic(model, env)) return createAnthropicClient({ apiKey, ...options, ...(fetch && { fetch }) });
  return new OpenAI({
    apiKey,
    ...(env.OPENAI_BASE_URL && { baseURL: env.OPENAI_BASE_URL }),
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    ...(fetch && { fetch }),
  });
}

