import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  baseModelId,
  buildCompletionOptions,
  DEFAULT_MODEL,
  DEFAULT_REASONING_MAX_COMPLETION_TOKENS,
  modelCapabilities,
  normalizeReasoningEffort,
  REASONING_EFFORTS,
  reasoningEnabled,
  resolveCompletionSettings,
  resolveEndpoint,
  resolveModelName,
  UNKNOWN_FAMILY_REASONING_EFFORTS,
} from '../src/model-config.js';
import { parseEvalArgs } from '../scripts/eval.js';
import { DEFAULT_WEB_CONFIG, loadWebConfig } from '../apps/web/src/server/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relative));
    } else if (/\.(?:c|m)?[jt]s$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

// Where the default model's id may appear outside a comment: the one
// definition, and its price row (a price, not a default).
const ALLOWED_DEFAULT_LITERALS = {
  'src/model-config.js': /^export const DEFAULT_MODEL = 'gpt-4o-mini';$/,
  'src/pricing.js': /^ {2}'gpt-4o-mini': Object\.freeze\(\{$/,
};

test('DEFAULT_MODEL is the one default model: no other gpt-4o-mini literal in src/, scripts/, the web server or CI', () => {
  const offenders = [];
  const files = [...listSourceFiles('src'), ...listSourceFiles('scripts'), ...listSourceFiles('apps/web/src/server')];
  for (const file of files) {
    for (const [index, line] of fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').entries()) {
      if (!line.includes(DEFAULT_MODEL)) {
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      if (ALLOWED_DEFAULT_LITERALS[file]?.test(line)) {
        continue;
      }
      offenders.push(`${file}:${index + 1}: ${trimmed}`);
    }
  }
  // The CI workflow asks the runner for the default baseline instead of
  // repeating the default in shell (${MODEL_NAME:-...}).
  for (const [index, line] of fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n').entries()) {
    if (line.includes(DEFAULT_MODEL) && !line.trim().startsWith('#')) {
      offenders.push(`.github/workflows/ci.yml:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'use DEFAULT_MODEL (src/model-config.js) instead of repeating the default model');
  // The allow-list entries still exist (a stale entry would hide nothing).
  for (const [file, pattern] of Object.entries(ALLOWED_DEFAULT_LITERALS)) {
    assert.ok(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').some((line) => pattern.test(line)), `${file} still has its allowed line`);
  }
});

test('resolveModelName: --model, then MODEL_NAME, then DEFAULT_MODEL, each with its source', () => {
  assert.deepEqual(resolveModelName({}), { model: DEFAULT_MODEL, source: 'default' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: '  ' }), { model: DEFAULT_MODEL, source: 'default' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: ' gpt-6-luna ' }), { model: 'gpt-6-luna', source: 'MODEL_NAME' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: 'gpt-6-luna' }, { flag: 'openai/gpt-6-luna' }), { model: 'openai/gpt-6-luna', source: '--model' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: 'gpt-6-luna' }, { flag: null }), { model: 'gpt-6-luna', source: 'MODEL_NAME' });
});

test('every entry point falls back to the same DEFAULT_MODEL', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-4o-mini');
  assert.equal(parseEvalArgs([], { env: {} }).model, DEFAULT_MODEL);
  assert.equal(DEFAULT_WEB_CONFIG.model, DEFAULT_MODEL);
  assert.equal(loadWebConfig({}).model, DEFAULT_MODEL);
});

test('the capability map is keyed by the model id without a vendor prefix or variant suffix', () => {
  assert.equal(baseModelId('openai/gpt-6-luna'), 'gpt-6-luna');
  assert.equal(baseModelId(' OpenAI/GPT-6-Luna:free '), 'gpt-6-luna');
  for (const [model, family, reasoning] of [
    ['gpt-4o-mini', 'gpt-4o', false],
    ['gpt-4o', 'gpt-4o', false],
    ['gpt-4o-2024-08-06', 'gpt-4o', false],
    ['openai/gpt-4o-mini', 'gpt-4o', false],
    ['gpt-4.1-mini', 'gpt-4.1', false],
    ['gpt-6-luna', 'gpt-6', true],
    ['openai/gpt-6-sol', 'gpt-6', true],
    ['gpt-6', 'gpt-6', true],
    ['gpt-5.4-mini', 'gpt-5', true],
    ['gpt-5', 'gpt-5', true],
    ['o3-mini', 'o-series', true],
    ['o4-mini-2025-04-16', 'o-series', true],
  ]) {
    const capability = modelCapabilities(model);
    assert.equal(capability.family, family, model);
    assert.equal(capability.reasoning, reasoning, model);
  }
  // Not a family: a lookalike prefix, or a model the map does not know.
  for (const model of ['gpt-4omni', 'gpt-60', 'omni-1', 'anthropic/claude-sonnet-4.5', 'acme-sql-1']) {
    assert.deepEqual(modelCapabilities(model), { id: baseModelId(model), family: null, reasoning: null, efforts: UNKNOWN_FAMILY_REASONING_EFFORTS }, model);
  }
  assert.deepEqual(modelCapabilities('gpt-6-luna').efforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(REASONING_EFFORTS, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('normalizeReasoningEffort validates the effort per family and fails with the allowed values', () => {
  assert.equal(normalizeReasoningEffort('gpt-6-luna', undefined), null);
  assert.equal(normalizeReasoningEffort('gpt-6-luna', '  '), null);
  assert.equal(normalizeReasoningEffort('gpt-4o-mini', null), null);
  assert.equal(normalizeReasoningEffort('gpt-6-luna', ' Low '), 'low');
  assert.equal(normalizeReasoningEffort('openai/gpt-6-luna', 'max'), 'max');
  assert.equal(normalizeReasoningEffort('acme-sql-1', 'medium'), 'medium');
  assert.equal(normalizeReasoningEffort('o3-mini', 'high'), 'high');

  const invalid = (model, effort, pattern, options) =>
    assert.throws(() => normalizeReasoningEffort(model, effort, options), (error) => error.code === 'INVALID_CONFIG' && pattern.test(error.message), `${model} ${effort}`);
  invalid('gpt-6-luna', 'extreme', /^REASONING_EFFORT must be one of none, low, medium, high, xhigh, max; got "extreme"\.$/);
  invalid('gpt-6-luna', 'minimal', /--reasoning-effort must be one of/, { source: '--reasoning-effort' });
  // A known non-reasoning model takes no effort at all, not even none.
  invalid('gpt-4o-mini', 'low', /REASONING_EFFORT "low" does not apply to gpt-4o-mini: the gpt-4o family is not a reasoning model \(allowed: unset\)/);
  invalid('gpt-4o-mini', 'none', /not a reasoning model/);
  invalid('gpt-4.1-mini', 'medium', /the gpt-4\.1 family is not a reasoning model/);
  // An effort the family does not list.
  invalid('gpt-5.4-mini', 'xhigh', /REASONING_EFFORT "xhigh" is not supported by gpt-5\.4-mini \(the gpt-5 family\); allowed: none, low, medium, high\./);
  invalid('o3-mini', 'none', /allowed: low, medium, high\./);
  invalid('acme-sql-1', 'max', /a model outside the capability map\); allowed: none, low, medium, high\./);
});

test('resolveCompletionSettings: endpoint host, OpenRouter, require_parameters and the reasoning token limit', () => {
  assert.deepEqual(resolveCompletionSettings({}), {
    baseUrlHost: 'api.openai.com',
    isOpenRouter: false,
    requireParameters: true,
    maxCompletionTokens: DEFAULT_REASONING_MAX_COMPLETION_TOKENS,
  });
  assert.equal(DEFAULT_REASONING_MAX_COMPLETION_TOKENS, 16000);
  assert.deepEqual(resolveEndpoint({ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }), { baseUrlHost: 'openrouter.ai', isOpenRouter: true });
  assert.deepEqual(resolveEndpoint({ OPENAI_BASE_URL: 'https://eu.OpenRouter.ai/api/v1' }), { baseUrlHost: 'eu.openrouter.ai', isOpenRouter: true });
  assert.deepEqual(resolveEndpoint({ OPENAI_BASE_URL: 'https://notopenrouter.ai/v1' }), { baseUrlHost: 'notopenrouter.ai', isOpenRouter: false });
  assert.deepEqual(resolveEndpoint({ OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1' }), { baseUrlHost: '127.0.0.1:9999', isOpenRouter: false });
  assert.deepEqual(resolveEndpoint({ OPENAI_BASE_URL: 'not a url' }), { baseUrlHost: null, isOpenRouter: false });
  assert.equal(resolveCompletionSettings({ OPENROUTER_REQUIRE_PARAMETERS: '0' }).requireParameters, false);
  assert.equal(resolveCompletionSettings({ OPENROUTER_REQUIRE_PARAMETERS: 'yes' }).requireParameters, true);
  assert.equal(resolveCompletionSettings({ LLM_MAX_COMPLETION_TOKENS: '32000' }).maxCompletionTokens, 32000);
  for (const env of [{ OPENROUTER_REQUIRE_PARAMETERS: 'maybe' }, { LLM_MAX_COMPLETION_TOKENS: '0' }, { LLM_MAX_COMPLETION_TOKENS: '16k' }, { LLM_MAX_COMPLETION_TOKENS: '2000000' }]) {
    assert.throws(() => resolveCompletionSettings(env), { code: 'INVALID_CONFIG' }, JSON.stringify(env));
  }
});

test('buildCompletionOptions keeps the base options for non-reasoning models and adapts them for reasoning and OpenRouter', () => {
  const base = { temperature: 0, top_p: 1, max_completion_tokens: 3200, response_format: { type: 'json_object' } };
  // Unchanged: the same object, so the request is byte for byte the old one.
  assert.equal(buildCompletionOptions(base, { model: 'gpt-4o-mini' }), base);
  assert.equal(buildCompletionOptions(base, { model: 'acme-sql-1' }), base);
  assert.equal(buildCompletionOptions(base, { model: 'gpt-4o-mini', isOpenRouter: true, requireParameters: false }), base);

  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-6-luna', reasoningEffort: 'none' }), { ...base, reasoning_effort: 'none' });
  for (const effort of ['low', 'medium', 'xhigh']) {
    assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-6-luna', reasoningEffort: effort }), {
      max_completion_tokens: 16000,
      response_format: { type: 'json_object' },
      reasoning_effort: effort,
    });
  }
  // A reasoning model with no effort set reasons at the provider's default:
  // no reasoning_effort is sent, but temperature still goes and the limit rises.
  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-6-luna', maxCompletionTokens: 9000 }), { max_completion_tokens: 9000, response_format: { type: 'json_object' } });
  // An unknown model with an effort is treated as a reasoning model.
  assert.deepEqual(buildCompletionOptions(base, { model: 'acme-sql-1', reasoningEffort: 'high' }), {
    max_completion_tokens: 16000,
    response_format: { type: 'json_object' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(buildCompletionOptions(base, { model: 'openai/gpt-4o-mini', isOpenRouter: true }), { ...base, provider: { require_parameters: true } });
  assert.deepEqual(buildCompletionOptions(base, { model: 'openai/gpt-6-luna', reasoningEffort: 'low', isOpenRouter: true }), {
    max_completion_tokens: 16000,
    response_format: { type: 'json_object' },
    reasoning_effort: 'low',
    provider: { require_parameters: true },
  });
  assert.throws(() => buildCompletionOptions(base, { model: 'gpt-4o-mini', reasoningEffort: 'low' }), { code: 'INVALID_CONFIG' });
  // The base options are never modified.
  assert.deepEqual(base, { temperature: 0, top_p: 1, max_completion_tokens: 3200, response_format: { type: 'json_object' } });
  assert.equal(reasoningEnabled('gpt-6-luna'), true);
  assert.equal(reasoningEnabled('gpt-6-luna', 'none'), false);
  assert.equal(reasoningEnabled('gpt-4o-mini'), false);
});
