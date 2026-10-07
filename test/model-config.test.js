import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  baseModelId,
  buildCompletionOptions,
  DEFAULT_MODEL,
  defaultReasoningEffort,
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

// A quoted model id (optionally vendor-prefixed): 'gpt-4o-mini',
// "openai/gpt-6-luna", `o3-mini`. Independent of DEFAULT_MODEL's value, so a
// leftover default of the old model is still caught after the default changes.
const MODEL_ID_LITERAL = /['"`](?:[a-z0-9-]+\/)?(?:gpt-\d[\w.-]*|o\d[\w.-]*|chatgpt-[\w.-]+)['"`]/;
// The same id unquoted, as a shell default would spell it (${MODEL_NAME:-...}).
const MODEL_ID_WORD = /(?:^|[^\w.])(?:[a-z0-9-]+\/)?(?:gpt-\d[\w.-]*|o\d-[\w.-]+|chatgpt-[\w.-]+)/;

// Where a model id may appear outside a comment: the one default, the
// capability map's family ids, and the price rows (prices, not defaults).
const ALLOWED_MODEL_LITERALS = {
  'src/model-config.js': [/^export const DEFAULT_MODEL = '[^']+';$/, /^\s*(?:Object\.freeze\(\{ )?family: '[^']+',/],
  'src/pricing.js': [/^ {2}'[^']+': Object\.freeze\(\{$/],
};

test('DEFAULT_MODEL is the one default model: no other model id literal in src/, scripts/, the web server or CI', () => {
  const offenders = [];
  const files = [...listSourceFiles('src'), ...listSourceFiles('scripts'), ...listSourceFiles('apps/web/src/server')];
  for (const file of files) {
    for (const [index, line] of fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').entries()) {
      if (!MODEL_ID_LITERAL.test(line)) {
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      if ((ALLOWED_MODEL_LITERALS[file] || []).some((pattern) => pattern.test(line))) {
        continue;
      }
      offenders.push(`${file}:${index + 1}: ${trimmed}`);
    }
  }
  // The CI workflow asks the runner for the default baseline instead of
  // repeating the default in shell (${MODEL_NAME:-...}).
  for (const [index, line] of fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n').entries()) {
    if (MODEL_ID_WORD.test(line) && !line.trim().startsWith('#')) {
      offenders.push(`.github/workflows/ci.yml:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'use DEFAULT_MODEL (src/model-config.js) instead of repeating a model id');
  // The allow-list entries still match a line (a stale entry would hide nothing).
  for (const [file, patterns] of Object.entries(ALLOWED_MODEL_LITERALS)) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    for (const pattern of patterns) {
      assert.ok(lines.some((line) => pattern.test(line)), `${file} still has a line matching ${pattern}`);
    }
  }
  // The guard sees what it must: a default spelled out in code, or in shell.
  for (const line of ["  const model = process.env.MODEL_NAME || 'gpt-4o-mini';", '  model: "openai/gpt-6-luna",', "const fallback = `o3-mini`;"]) {
    assert.ok(MODEL_ID_LITERAL.test(line), line);
  }
  assert.ok(MODEL_ID_WORD.test('if [ -f "eval/baselines/${MODEL_NAME:-gpt-4o-mini}.json" ]; then'));
  assert.ok(!MODEL_ID_WORD.test('        run: npm run eval -- --offline --gate'));
});

test('resolveModelName: --model, then MODEL_NAME, then DEFAULT_MODEL, each with its source', () => {
  assert.deepEqual(resolveModelName({}), { model: DEFAULT_MODEL, source: 'default' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: '  ' }), { model: DEFAULT_MODEL, source: 'default' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: ' gpt-6-luna ' }), { model: 'gpt-6-luna', source: 'MODEL_NAME' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: 'gpt-6-luna' }, { flag: 'openai/gpt-6-luna' }), { model: 'openai/gpt-6-luna', source: '--model' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: 'gpt-6-luna' }, { flag: null }), { model: 'gpt-6-luna', source: 'MODEL_NAME' });
});

test('every entry point falls back to the same DEFAULT_MODEL', () => {
  // Pinned on purpose: the committed baseline (eval/baselines/gpt-4o-mini.json)
  // is the default model's, and the CI db job gates against the default
  // model's baseline only when it exists, so a changed default would silently
  // turn the offline gate off until a baseline of the new default is committed.
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
    ['gpt-5', 'gpt-5', true],
    ['gpt-5-mini', 'gpt-5', true],
    ['gpt-5-nano-2025-08-07', 'gpt-5', true],
    ['gpt-5.1', 'gpt-5.1', true],
    ['gpt-5.1-codex', 'gpt-5.1', true],
    ['gpt-5.2', 'gpt-5.2+', true],
    ['gpt-5.4-mini', 'gpt-5.2+', true],
    ['openai/gpt-5.4', 'gpt-5.2+', true],
    ['gpt-5.10', 'gpt-5.2+', true],
    ['o3-mini', 'o-series', true],
    ['o4-mini-2025-04-16', 'o-series', true],
  ]) {
    const capability = modelCapabilities(model);
    assert.equal(capability.family, family, model);
    assert.equal(capability.reasoning, reasoning, model);
  }
  // Not a family: a lookalike prefix, a gpt-5.x chat model (it takes no
  // effort), or a model the map does not know.
  for (const model of ['gpt-4omni', 'gpt-60', 'gpt-50', 'omni-1', 'gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'anthropic/claude-sonnet-4.5', 'acme-sql-1']) {
    assert.deepEqual(
      modelCapabilities(model),
      { id: baseModelId(model), family: null, reasoning: null, efforts: UNKNOWN_FAMILY_REASONING_EFFORTS, defaultEffort: null },
      model
    );
  }
  assert.deepEqual(modelCapabilities('gpt-6-luna').efforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  // The efforts each gpt-5 generation takes: no none for the original
  // gpt-5 / -mini / -nano, xhigh from gpt-5.2 on.
  assert.deepEqual(modelCapabilities('gpt-5-mini').efforts, ['low', 'medium', 'high']);
  assert.deepEqual(modelCapabilities('gpt-5.1').efforts, ['none', 'low', 'medium', 'high']);
  assert.deepEqual(modelCapabilities('gpt-5.4-mini').efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
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
  invalid('gpt-5.4-mini', 'max', /REASONING_EFFORT "max" is not supported by gpt-5\.4-mini \(the gpt-5\.2\+ family\); allowed: none, low, medium, high, xhigh\./);
  invalid('gpt-5.1', 'xhigh', /\(the gpt-5\.1 family\); allowed: none, low, medium, high\./);
  invalid('gpt-5-mini', 'none', /REASONING_EFFORT "none" is not supported by gpt-5-mini \(the gpt-5 family\); allowed: low, medium, high\./);
  invalid('o3-mini', 'none', /allowed: low, medium, high\./);
  invalid('acme-sql-1', 'max', /a model outside the capability map\); allowed: none, low, medium, high\./);
  assert.equal(normalizeReasoningEffort('gpt-5.4-mini', 'xhigh'), 'xhigh');
  // An effort from an env file names the file, and how to clear it for one run.
  invalid(
    'gpt-4o-mini',
    'low',
    /^REASONING_EFFORT \(from \/home\/you\/\.env\) "low" does not apply to gpt-4o-mini: .* Unset REASONING_EFFORT in \/home\/you\/\.env \(or override it with an empty REASONING_EFFORT= in the shell\), or pick a reasoning model\.$/,
    { file: '/home/you/.env' }
  );
});

test('with no effort set, a family whose provider default reasons runs at it explicitly; a none default keeps the base request', () => {
  for (const [model, effort] of [
    ['gpt-6-luna', 'medium'],
    ['openai/gpt-6-sol', 'medium'],
    ['gpt-5-mini', 'medium'],
    ['o3', 'medium'],
    ['gpt-5.1', null],
    ['gpt-5.4-mini', null],
    ['gpt-4o-mini', null],
    ['acme-sql-1', null],
  ]) {
    assert.equal(defaultReasoningEffort(model), effort, model);
    assert.equal(reasoningEnabled(model), effort !== null, model);
  }
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
  // A reasoning model with no effort set runs at its family's default effort,
  // sent explicitly (gpt-6: medium) ...
  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-6-luna', maxCompletionTokens: 9000 }), {
    max_completion_tokens: 9000,
    response_format: { type: 'json_object' },
    reasoning_effort: 'medium',
  });
  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-5-mini' }), { max_completion_tokens: 16000, response_format: { type: 'json_object' }, reasoning_effort: 'medium' });
  // ... unless that default is none (gpt-5.1 and later): the base request,
  // as these models got before the capability map, until an effort is set.
  assert.equal(buildCompletionOptions(base, { model: 'gpt-5.4-mini' }), base);
  assert.equal(buildCompletionOptions(base, { model: 'gpt-5-chat-latest' }), base);
  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-5.4-mini', reasoningEffort: 'xhigh' }), {
    max_completion_tokens: 16000,
    response_format: { type: 'json_object' },
    reasoning_effort: 'xhigh',
  });
  assert.throws(() => buildCompletionOptions(base, { model: 'gpt-5-mini', reasoningEffort: 'none' }), { code: 'INVALID_CONFIG' });
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
  assert.equal(reasoningEnabled('gpt-5.4-mini', 'low'), true);
  assert.equal(reasoningEnabled('gpt-4o-mini'), false);
});
