import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  baseModelId,
  buildCompletionOptions,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  defaultReasoningEffort,
  DEFAULT_REASONING_MAX_COMPLETION_TOKENS,
  isDefaultModel,
  modelCapabilities,
  normalizeReasoningEffort,
  REASONING_EFFORTS,
  reasoningEnabled,
  resolveCompletionSettings,
  resolveEndpoint,
  resolveModelConfig,
  resolveModelName,
  UNKNOWN_FAMILY_REASONING_EFFORTS,
  unsupportedModelReason,
} from '../src/model-config.js';
import { loadEnvironment } from '../src/env.js';
import { calculateCost } from '../src/pricing.js';
import { resolveRunModelSettings } from '../src/query-service.js';
import { defaultBaselineForEnv, parseEvalArgs } from '../scripts/eval.js';
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

test('every entry point falls back to the same DEFAULT_MODEL at DEFAULT_REASONING_EFFORT', () => {
  // Pinned on purpose: the committed default baseline
  // (eval/baselines/gpt-6-luna.low.json, Experiment 3) is the default pair's,
  // and the CI db job gates against the default pair's baseline only when it
  // exists, so a changed default would silently turn the offline gate off
  // until a baseline of the new default is committed.
  assert.deepEqual([DEFAULT_MODEL, DEFAULT_REASONING_EFFORT], ['gpt-6-luna', 'low']);
  assert.ok(fs.existsSync(defaultBaselineForEnv({})), `the default pair has a committed baseline: ${defaultBaselineForEnv({})}`);
  assert.match(defaultBaselineForEnv({}), /eval\/baselines\/gpt-6-luna\.low\.json$/);
  // The product default's effort is one the default model accepts.
  assert.equal(normalizeReasoningEffort(DEFAULT_MODEL, DEFAULT_REASONING_EFFORT), DEFAULT_REASONING_EFFORT);
  const evalDefaults = parseEvalArgs([], { env: {} });
  assert.deepEqual(
    [evalDefaults.model, evalDefaults.modelSource, evalDefaults.reasoningEffort, evalDefaults.reasoningEffortSource],
    [DEFAULT_MODEL, 'default', DEFAULT_REASONING_EFFORT, 'default']
  );
  assert.deepEqual([DEFAULT_WEB_CONFIG.model, DEFAULT_WEB_CONFIG.reasoningEffort], [DEFAULT_MODEL, DEFAULT_REASONING_EFFORT]);
  const web = loadWebConfig({});
  assert.deepEqual([web.model, web.reasoningEffort], [DEFAULT_MODEL, DEFAULT_REASONING_EFFORT]);
});

test('.env.example, the documented starting point, leaves the default model and effort alone', async () => {
  // A fresh setup copies it to .env, and the env beats DEFAULT_MODEL /
  // DEFAULT_REASONING_EFFORT at every entry point: an active MODEL_NAME or
  // REASONING_EFFORT there is a second default, and once pinned the old
  // reference model (gpt-4o-mini) under the adopted one. Comment them out.
  const env = {};
  const loaded = await loadEnvironment(['--dotenv', path.join(REPO_ROOT, '.env.example')], { env });
  assert.equal(loaded.loaded, true, '.env.example exists');
  const pinned = ['MODEL_NAME', 'REASONING_EFFORT'].filter((name) => name in env);
  assert.deepEqual(pinned, [], 'leave MODEL_NAME and REASONING_EFFORT unset (commented out) in .env.example: the default is DEFAULT_MODEL at DEFAULT_REASONING_EFFORT');
  const config = resolveModelConfig({ env });
  assert.deepEqual(
    [config.model, config.modelSource, config.reasoningEffort, config.reasoningEffortSource],
    [DEFAULT_MODEL, 'default', DEFAULT_REASONING_EFFORT, 'default']
  );
});

test('the default model runs at the product default effort whenever no effort is set, named or defaulted', () => {
  for (const model of ['gpt-6-luna', ' GPT-6-Luna ', 'openai/gpt-6-luna']) {
    assert.equal(isDefaultModel(model), true, model);
    assert.equal(defaultReasoningEffort(model), 'low', model);
  }
  // A dated snapshot of the default model is the default model too, as the
  // price table reads it (src/pricing.js prices it as gpt-6-luna).
  for (const model of ['gpt-6-luna-2026-09-30', 'gpt-6-luna-20260930', 'openai/gpt-6-luna-2026-09-30']) {
    assert.equal(isDefaultModel(model), true, model);
    assert.equal(defaultReasoningEffort(model), 'low', model);
    assert.equal(calculateCost(model, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })?.model, DEFAULT_MODEL, model);
  }
  // Other models keep their family's default; a lookalike is another model.
  for (const [model, effort] of [
    ['gpt-6-sol', 'medium'],
    ['gpt-6-luna-mini', 'medium'],
    ['gpt-6-luna-2026', 'medium'],
    ['gpt-6-luna-mini-2026-09-30', 'medium'],
    ['gpt-4o-mini', null],
  ]) {
    assert.equal(isDefaultModel(model), false, model);
    assert.equal(defaultReasoningEffort(model), effort, model);
  }
  // MODEL_NAME naming the default model with no effort set is the default
  // pair, so it pairs with the same baseline file.
  assert.equal(defaultBaselineForEnv({ MODEL_NAME: 'gpt-6-luna' }), defaultBaselineForEnv({}));
  // A set effort always wins.
  assert.equal(parseEvalArgs(['--reasoning-effort', 'medium'], { env: {} }).reasoningEffort, 'medium');
  assert.equal(parseEvalArgs([], { env: { REASONING_EFFORT: 'high' } }).reasoningEffort, 'high');
  assert.equal(parseEvalArgs([], { env: { REASONING_EFFORT: 'none' } }).reasoningEffort, 'none');
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
    ['gpt-6-astra', 'gpt-6-astra', true],
    ['openai/gpt-6-astra-2026-09-01', 'gpt-6-astra', true],
    ['gpt-6.1-sol', 'gpt-6.1-sol', true],
    ['openai/gpt-6.1-sol', 'gpt-6.1-sol', true],
    ['gpt-6.1', 'gpt-6', true],
    ['gpt-5', 'gpt-5', true],
    ['gpt-5-mini', 'gpt-5', true],
    ['gpt-5-nano-2025-08-07', 'gpt-5', true],
    ['gpt-5.1', 'gpt-5.1', true],
    ['gpt-5.1-codex', 'gpt-5.1', true],
    ['gpt-5.2', 'gpt-5.2+', true],
    ['gpt-5.4-mini', 'gpt-5.2+', true],
    ['openai/gpt-5.4', 'gpt-5.2+', true],
    ['gpt-5.5', 'gpt-5.5', true],
    ['gpt-5.5-2026-07-01', 'gpt-5.5', true],
    ['openai/gpt-5.6', 'gpt-5.6', true],
    ['gpt-5.6-mini', 'gpt-5.6', true],
    ['gpt-5.7', 'gpt-5.2+', true],
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
  // gpt-6-astra and gpt-6.1-sol take no `none` (their pages and the reasoning guide, 2026-10-09).
  assert.deepEqual(modelCapabilities('gpt-6-astra').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelCapabilities('gpt-6.1-sol').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  // gpt-5.5 and gpt-5.6 default to medium again; 5.6 adds max.
  assert.deepEqual(modelCapabilities('gpt-5.5').efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(modelCapabilities('gpt-5.6').efforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  // The efforts each gpt-5 generation takes: no none for the original
  // gpt-5 / -mini / -nano, xhigh from gpt-5.2 on.
  assert.deepEqual(modelCapabilities('gpt-5-mini').efforts, ['low', 'medium', 'high']);
  assert.deepEqual(modelCapabilities('gpt-5.1').efforts, ['none', 'low', 'medium', 'high']);
  assert.deepEqual(modelCapabilities('gpt-5.4-mini').efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(REASONING_EFFORTS, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('the -pro models (Responses API only) are refused before anything starts, on every entry point', () => {
  const RESPONSES_ONLY = /served only by the Responses API/;
  // gpt-5*-pro and the o-series -pro (o1-pro, o3-pro): Responses API only.
  for (const [model, family] of [
    ['gpt-5.4-pro', 'gpt-5-pro'],
    ['gpt-5.4-pro-2026-03-05', 'gpt-5-pro'],
    ['openai/gpt-5.4-pro', 'gpt-5-pro'],
    ['gpt-5.2-pro', 'gpt-5-pro'],
    ['gpt-5.5-pro', 'gpt-5-pro'],
    ['gpt-5.6-pro', 'gpt-5-pro'],
    ['gpt-5-pro', 'gpt-5-pro'],
    ['o3-pro', 'o-series-pro'],
    ['o1-pro-2025-03-19', 'o-series-pro'],
  ]) {
    assert.equal(modelCapabilities(model).family, family, model);
    assert.match(unsupportedModelReason(model) || '', RESPONSES_ONLY, model);
  }
  // The reason is the Responses API alone: OpenAI lists structured outputs for gpt-5-pro.
  assert.doesNotMatch(unsupportedModelReason('gpt-5-pro'), /structured outputs/);
  // Their siblings stay what they were.
  for (const [model, family] of [
    ['gpt-5.4', 'gpt-5.2+'],
    ['gpt-5.4-mini', 'gpt-5.2+'],
    ['gpt-5', 'gpt-5'],
    ['o3', 'o-series'],
    ['o3-mini', 'o-series'],
  ]) {
    assert.equal(modelCapabilities(model).family, family, model);
    assert.equal(unsupportedModelReason(model), null, model);
  }
  for (const model of ['gpt-4o-mini', 'gpt-6-luna', 'acme/sql-1']) {
    assert.equal(unsupportedModelReason(model), null, model);
  }

  const refused = (fn, pattern) => assert.throws(fn, (error) => error.code === 'INVALID_CONFIG' && pattern.test(error.message));
  // The shared resolver (CLIs, eval, web), with where the model came from.
  refused(
    () => resolveModelConfig({ env: { MODEL_NAME: 'gpt-5.4-pro' } }),
    /^MODEL_NAME "gpt-5\.4-pro" is not supported: the gpt-5\*-pro models are served only by the Responses API; this pipeline sends Chat Completions requests with a strict json_schema response format\. Pick another model\.$/
  );
  refused(() => resolveModelConfig({ env: { MODEL_NAME: 'o3-pro' }, envFile: { path: '/home/you/.env', vars: ['MODEL_NAME'] } }), /^MODEL_NAME \(from \/home\/you\/\.env\) "o3-pro" is not supported: /);
  // Also with an effort the model would list: the model is refused first.
  refused(() => resolveModelConfig({ env: { MODEL_NAME: 'gpt-5.4-pro', REASONING_EFFORT: 'high' } }), /^MODEL_NAME "gpt-5\.4-pro" is not supported/);
  assert.throws(() => parseEvalArgs(['--model', 'openai/gpt-5.4-pro', '--reasoning-effort', 'high'], { env: {} }), (error) => error.code === 'INVALID_CONFIG' && /^--model "openai\/gpt-5\.4-pro" is not supported/.test(error.message));
  assert.throws(() => loadWebConfig({ MODEL_NAME: 'gpt-5.4-pro' }), /MODEL_NAME "gpt-5\.4-pro" is not supported/);
  // And where a request is built, or the query service resolves its model.
  refused(() => buildCompletionOptions({ temperature: 0 }, { model: 'gpt-5.4-pro' }), /^model "gpt-5\.4-pro" is not supported/);
  refused(() => normalizeReasoningEffort('gpt-5.4-pro', 'high'), /^model "gpt-5\.4-pro" is not supported/);
  refused(() => resolveRunModelSettings({ model: 'o1-pro' }, {}), /^model "o1-pro" is not supported/);
  refused(() => resolveRunModelSettings({}, { MODEL_NAME: 'gpt-5-pro' }), /^MODEL_NAME "gpt-5-pro" is not supported/);
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
  // Astra and 6.1 Sol: `none` is refused here, not by the API (a 400).
  invalid('gpt-6-astra', 'none', /REASONING_EFFORT "none" is not supported by gpt-6-astra \(the gpt-6-astra family\); allowed: low, medium, high, xhigh, max\./);
  invalid('openai/gpt-6.1-sol', 'none', /\(the gpt-6\.1-sol family\); allowed: low, medium, high, xhigh, max\./);
  invalid('gpt-5.5', 'max', /\(the gpt-5\.5 family\); allowed: none, low, medium, high, xhigh\./);
  assert.equal(normalizeReasoningEffort('gpt-5.6', 'max'), 'max');
  assert.equal(normalizeReasoningEffort('gpt-6.1-sol', 'xhigh'), 'xhigh');
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
    // The default model: the product default's effort, not its family's.
    ['gpt-6-luna', 'low'],
    ['gpt-6-sol', 'medium'],
    ['openai/gpt-6-sol', 'medium'],
    ['gpt-5-mini', 'medium'],
    ['o3', 'medium'],
    ['gpt-6-astra', 'medium'],
    ['openai/gpt-6.1-sol', 'medium'],
    ['gpt-5.5', 'medium'],
    ['gpt-5.6', 'medium'],
    ['gpt-5.1', null],
    ['gpt-5.4-mini', null],
    ['gpt-5.7', null],
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
  // Plain http on openrouter.ai is not OpenRouter: OPENROUTER_API_KEY must never travel without TLS.
  assert.deepEqual(resolveEndpoint({ OPENAI_BASE_URL: 'http://openrouter.ai/api/v1' }), { baseUrlHost: 'openrouter.ai', isOpenRouter: false });
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
  // sent explicitly (gpt-6: medium), the default model at the product
  // default's (gpt-6-luna: low) ...
  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-6-sol', maxCompletionTokens: 9000 }), {
    max_completion_tokens: 9000,
    response_format: { type: 'json_object' },
    reasoning_effort: 'medium',
  });
  assert.deepEqual(buildCompletionOptions(base, { model: 'gpt-6-luna', maxCompletionTokens: 9000 }), {
    max_completion_tokens: 9000,
    response_format: { type: 'json_object' },
    reasoning_effort: 'low',
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
