// Model configuration: which model a run uses, where that choice came from,
// its reasoning effort, and the request options that model accepts.
//
// - DEFAULT_MODEL is the one default model of the repository: the web server,
//   the basic and optimized CLIs, the query service and npm run eval all fall
//   back to it when neither --model (eval only) nor MODEL_NAME is set. A test
//   (test/model-config.test.js) fails on any other model id literal in src/,
//   scripts/, apps/web/src/server/ or the CI workflow (the capability map's
//   family ids and the price rows aside), so changing the default is a
//   one-line change here, plus a baseline of the new default for the CI gate
//   (the test pins the value until then).
// - The capability map (MODEL_FAMILIES) is keyed by the model id with any
//   vendor prefix stripped (openai/gpt-6-luna is gpt-6-luna, as OpenRouter
//   names it): gpt-4o* and gpt-4.1* take temperature 0 and no reasoning
//   effort; gpt-6*, gpt-5* and the o-series are reasoning models. A model
//   outside the map keeps the request every model got before this module
//   existed, unless a reasoning effort is set (then it is treated as a
//   reasoning model with the conservative effort list).
// - With no effort set, a family whose provider default reasons (gpt-6*,
//   gpt-5 / -mini / -nano, the o-series: medium) runs at that default, sent
//   and recorded explicitly, so a provider changing its default cannot change
//   a run unseen and `medium` set or defaulted is the same run. A family whose
//   default is `none` (gpt-5.1 and later) keeps the base request until an
//   effort is set.
// - The reasoning effort (REASONING_EFFORT, or --reasoning-effort in npm run
//   eval) is validated per family before anything is started: an unknown
//   value, an effort the family does not list, or any effort for a known
//   non-reasoning model fails with the allowed values in the message.
// - buildCompletionOptions turns a base request (the basic or optimized
//   pipeline's options) into what the model accepts. With reasoning on (a
//   reasoning model at any effort but `none`) temperature and top_p are
//   dropped (reasoning models reject or ignore them), reasoning_effort is sent
//   when one is set, and max_completion_tokens is raised to
//   LLM_MAX_COMPLETION_TOKENS (default 16000), because reasoning tokens count
//   against it and the 1200 / 3200 of the base options would truncate. At
//   effort `none` the base options stay, with reasoning_effort: 'none'. With
//   no effort and a non-reasoning or unknown model the base options are
//   returned as they are: the gpt-4o-mini request is byte for byte the one of
//   the committed baseline.
// - OpenRouter (an OPENAI_BASE_URL on openrouter.ai) gets
//   provider: { require_parameters: true }, so it routes only to endpoints
//   that support every parameter sent (response_format, reasoning_effort,
//   max_completion_tokens); OPENROUTER_REQUIRE_PARAMETERS=0 turns it off.
//   With OPENAI_API_KEY unset, OPENROUTER_API_KEY is the key there
//   (resolveLlmApiKey).

import { createHash } from 'node:crypto';

export const DEFAULT_MODEL = 'gpt-4o-mini';

// Every reasoning effort any family accepts, in increasing order.
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// The efforts allowed for a reasoning family the map does not list (an
// unknown model with REASONING_EFFORT set): the values every current
// reasoning API accepts or rejects cleanly.
export const UNKNOWN_FAMILY_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);

// max_completion_tokens for a request with reasoning on, unless
// LLM_MAX_COMPLETION_TOKENS says otherwise.
export const DEFAULT_REASONING_MAX_COMPLETION_TOKENS = 16_000;
const MAX_COMPLETION_TOKENS_LIMIT = 1_000_000;

// The capability map, first match wins. `efforts` lists what the family
// accepts (null: no reasoning effort at all); `defaultEffort` is the effort
// the provider applies when none is sent. gpt-6: verified on 2026-10-07
// (developers.openai.com/api/docs/models/gpt-6-luna and gpt-6-sol: none, low,
// medium (default), high, xhigh, max). gpt-5: the original gpt-5, -mini and
// -nano take minimal (not offered here), low, medium (default) and high, and
// no `none`; gpt-5.1 added `none` and made it the default; gpt-5.2 and later
// add xhigh. The -chat models of gpt-5.x take no effort and stay outside the
// map (the request they always had). A snapshot that differs needs its own
// entry here.
export const MODEL_FAMILIES = Object.freeze([
  Object.freeze({ family: 'gpt-4o', label: 'gpt-4o*', pattern: /^gpt-4o(?:-|$)/, reasoning: false, efforts: null, defaultEffort: null }),
  Object.freeze({ family: 'gpt-4.1', label: 'gpt-4.1*', pattern: /^gpt-4\.1(?:-|$)/, reasoning: false, efforts: null, defaultEffort: null }),
  Object.freeze({ family: 'gpt-6', label: 'gpt-6*', pattern: /^gpt-6(?:[.-]|$)/, reasoning: true, efforts: REASONING_EFFORTS, defaultEffort: 'medium' }),
  Object.freeze({
    family: 'gpt-5.2+',
    label: 'gpt-5.2* and later',
    pattern: /^gpt-5\.(?:[2-9]|[1-9]\d+)(?:-(?!chat)|$)/,
    reasoning: true,
    efforts: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']),
    defaultEffort: 'none',
  }),
  Object.freeze({
    family: 'gpt-5.1',
    label: 'gpt-5.1*',
    pattern: /^gpt-5\.1(?:-(?!chat)|$)/,
    reasoning: true,
    efforts: Object.freeze(['none', 'low', 'medium', 'high']),
    defaultEffort: 'none',
  }),
  Object.freeze({
    family: 'gpt-5',
    label: 'gpt-5, gpt-5-mini, gpt-5-nano',
    pattern: /^gpt-5(?:-(?!chat)|$)/,
    reasoning: true,
    efforts: Object.freeze(['low', 'medium', 'high']),
    defaultEffort: 'medium',
  }),
  Object.freeze({
    family: 'o-series',
    label: 'o1*, o3*, o4*, ...',
    pattern: /^o\d+(?:-|$)/,
    reasoning: true,
    efforts: Object.freeze(['low', 'medium', 'high']),
    defaultEffort: 'medium',
  }),
]);

function configError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  return error;
}

function nonBlank(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
}

/**
 * The model and its source: `--model` (the flag, eval only), `MODEL_NAME` (the
 * environment, which includes the loaded env file) or `default`
 * (DEFAULT_MODEL). Blank values count as unset.
 */
export function resolveModelName(env = process.env, { flag = null } = {}) {
  const fromFlag = nonBlank(flag);
  if (fromFlag) {
    return { model: fromFlag, source: '--model' };
  }
  const fromEnv = nonBlank(env.MODEL_NAME);
  if (fromEnv) {
    return { model: fromEnv, source: 'MODEL_NAME' };
  }
  return { model: DEFAULT_MODEL, source: 'default' };
}

/**
 * The model id the capability map and the price list are keyed by: lower
 * case, any vendor prefix (`openai/`) and OpenRouter variant suffix
 * (`:free`, `:nitro`) removed.
 */
export function baseModelId(model) {
  const id = String(model || '').trim().toLowerCase();
  return id.slice(id.lastIndexOf('/') + 1).replace(/:.*$/, '');
}

/**
 * What the capability map says about a model: { id, family, reasoning,
 * efforts, defaultEffort }. reasoning is true / false for a listed family and
 * null for an unknown model (family null, efforts the conservative list,
 * defaultEffort null).
 */
export function modelCapabilities(model) {
  const id = baseModelId(model);
  const entry = MODEL_FAMILIES.find((candidate) => candidate.pattern.test(id));
  if (!entry) {
    return { id, family: null, reasoning: null, efforts: UNKNOWN_FAMILY_REASONING_EFFORTS, defaultEffort: null };
  }
  return { id, family: entry.family, reasoning: entry.reasoning, efforts: entry.efforts, defaultEffort: entry.defaultEffort };
}

/**
 * The effort a run of `model` uses when none is set: its family's provider
 * default when that default reasons (medium for gpt-6*, gpt-5 / -mini /
 * -nano and the o-series), sent and recorded like a set one; null for a
 * family whose default is `none` (gpt-5.1 and later keep the base request),
 * a non-reasoning family and a model outside the map.
 */
export function defaultReasoningEffort(model) {
  const { reasoning, defaultEffort } = modelCapabilities(model);
  return reasoning === true && defaultEffort && defaultEffort !== 'none' ? defaultEffort : null;
}

/**
 * A reasoning effort for `model`, validated: null when unset (undefined, null
 * or blank), else the lower-cased value. Throws INVALID_CONFIG for a value
 * that is not an effort, one the model's family does not accept, or any
 * effort for a known non-reasoning model. `source` names the setting in the
 * message (REASONING_EFFORT, --reasoning-effort, ...); `file`, the env file
 * it came from, when one did.
 */
export function normalizeReasoningEffort(model, effort, { source = 'REASONING_EFFORT', file = null } = {}) {
  const raw = nonBlank(effort);
  if (raw === null) {
    return null;
  }
  const named = file ? `${source} (from ${file})` : source;
  // An env file never overrides the shell, so an empty value there clears it.
  const unset = file ? `Unset ${source} in ${file} (or override it with an empty ${source}= in the shell)` : `Unset ${source}`;
  const value = raw.toLowerCase();
  if (!REASONING_EFFORTS.includes(value)) {
    throw configError(`${named} must be one of ${REASONING_EFFORTS.join(', ')}; got "${raw}".`);
  }
  const capability = modelCapabilities(model);
  if (capability.reasoning === false) {
    throw configError(
      `${named} "${value}" does not apply to ${model}: the ${capability.family} family is not a reasoning model (allowed: unset). ` +
        `${unset}, or pick a reasoning model.`
    );
  }
  if (!capability.efforts.includes(value)) {
    const family = capability.family ? `the ${capability.family} family` : 'a model outside the capability map';
    throw configError(`${named} "${value}" is not supported by ${model} (${family}); allowed: ${capability.efforts.join(', ')}.`);
  }
  return value;
}

/**
 * Whether a request for `model` at `reasoningEffort` reasons: any effort but
 * `none` (for an unknown model too); with no effort, the family's default
 * effort decides (defaultReasoningEffort).
 */
export function reasoningEnabled(model, reasoningEffort = null) {
  const effort = reasoningEffort || defaultReasoningEffort(model);
  return Boolean(effort) && effort !== 'none';
}

/**
 * The OpenAI-compatible endpoint host (with port) of OPENAI_BASE_URL, and
 * whether it is OpenRouter. No base URL means the SDK default,
 * api.openai.com; an unparseable one has host null.
 */
export function resolveEndpoint(env = process.env) {
  const raw = nonBlank(env.OPENAI_BASE_URL);
  if (!raw) {
    return { baseUrlHost: 'api.openai.com', isOpenRouter: false };
  }
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    return { baseUrlHost: url.host || null, isOpenRouter: hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai') };
  } catch {
    return { baseUrlHost: null, isOpenRouter: false };
  }
}

/**
 * The API key for the configured endpoint and the variable it came from:
 * OPENAI_API_KEY, else (only when OPENAI_BASE_URL is on openrouter.ai)
 * OPENROUTER_API_KEY; { apiKey: null, source: null } when neither applies.
 * The key itself is never logged or recorded.
 */
export function resolveLlmApiKey(env = process.env) {
  const openAiKey = nonBlank(env.OPENAI_API_KEY);
  if (openAiKey) {
    return { apiKey: openAiKey, source: 'OPENAI_API_KEY' };
  }
  const openRouterKey = nonBlank(env.OPENROUTER_API_KEY);
  if (openRouterKey && resolveEndpoint(env).isOpenRouter) {
    return { apiKey: openRouterKey, source: 'OPENROUTER_API_KEY' };
  }
  return { apiKey: null, source: null };
}

function readBooleanEnv(env, name, fallback) {
  const raw = nonBlank(env[name]);
  if (raw === null) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw configError(`${name} must be a boolean (1/0, true/false, yes/no, on/off); got "${env[name]}".`);
}

function readTokenLimitEnv(env, name, fallback) {
  const raw = nonBlank(env[name]);
  if (raw === null) {
    return fallback;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_COMPLETION_TOKENS_LIMIT) {
    throw configError(`${name} must be an integer between 1 and ${MAX_COMPLETION_TOKENS_LIMIT}; got "${env[name]}".`);
  }
  return value;
}

/**
 * The endpoint-level request settings from an env object: { baseUrlHost,
 * isOpenRouter, requireParameters (OPENROUTER_REQUIRE_PARAMETERS, default on;
 * only sent to OpenRouter), maxCompletionTokens (LLM_MAX_COMPLETION_TOKENS,
 * default 16000; only for requests with reasoning on) }. Throws INVALID_CONFIG
 * on a bad value.
 */
export function resolveCompletionSettings(env = process.env) {
  return {
    ...resolveEndpoint(env),
    requireParameters: readBooleanEnv(env, 'OPENROUTER_REQUIRE_PARAMETERS', true),
    maxCompletionTokens: readTokenLimitEnv(env, 'LLM_MAX_COMPLETION_TOKENS', DEFAULT_REASONING_MAX_COMPLETION_TOKENS),
  };
}

/**
 * The request options for `model` built from a pipeline's base options (see
 * the file comment). `settings`: { model, reasoningEffort, isOpenRouter,
 * requireParameters, maxCompletionTokens }; a resolved model config (or the
 * completion settings plus model and effort) fits. The effort is validated
 * for the model; with none set, the family's default effort applies
 * (defaultReasoningEffort). Unchanged base options are returned as the same
 * object.
 */
export function buildCompletionOptions(base, settings = {}) {
  const {
    model,
    reasoningEffort = null,
    isOpenRouter = false,
    requireParameters = true,
    maxCompletionTokens = DEFAULT_REASONING_MAX_COMPLETION_TOKENS,
  } = settings;
  const effort = normalizeReasoningEffort(model, reasoningEffort, { source: 'reasoningEffort' }) ?? defaultReasoningEffort(model);
  let options = base;
  if (reasoningEnabled(model, effort)) {
    const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'temperature' && key !== 'top_p'));
    options = { ...rest, max_completion_tokens: maxCompletionTokens, reasoning_effort: effort };
  } else if (effort) {
    // Effort `none`: no reasoning, so the deterministic base options stay.
    options = { ...base, reasoning_effort: effort };
  }
  if (isOpenRouter && requireParameters) {
    options = { ...options, provider: { require_parameters: true } };
  }
  return options;
}

function sourceLabel(source, file, name) {
  return file && source === name ? `${source} from ${file}` : source;
}

/**
 * The whole model configuration of a run from an env object and the eval's
 * flags ({ model: --model, reasoningEffort: --reasoning-effort }; null or
 * undefined when absent):
 * { model, modelSource ('--model' | 'MODEL_NAME' | 'default'),
 *   reasoningEffort (unset: the family's default effort, null when that is
 *   none or the model is not a known reasoning model), reasoningEffortSource
 *   ('--reasoning-effort' | 'REASONING_EFFORT' | 'default'),
 *   modelSourceFile / reasoningEffortSourceFile (the env file a variable came
 *   from, when `envFile` = { path, vars } says so; else null),
 *   baseUrlHost, isOpenRouter, requireParameters, maxCompletionTokens,
 *   capability, notices (a flag that overrides a different env value; an
 *   OPENAI_API_KEY that, set next to OPENROUTER_API_KEY, goes to OpenRouter) }.
 * Throws INVALID_CONFIG on an invalid effort or endpoint setting.
 */
export function resolveModelConfig({ env = process.env, flags = {}, envFile = null } = {}) {
  const { model, source: modelSource } = resolveModelName(env, { flag: flags.model });
  const flagEffort = nonBlank(flags.reasoningEffort);
  const envEffort = nonBlank(env.REASONING_EFFORT);
  const reasoningEffortSource = flagEffort ? '--reasoning-effort' : envEffort ? 'REASONING_EFFORT' : 'default';
  const fromFile = (name) => (envFile?.path && (envFile.vars || []).includes(name) ? envFile.path : null);
  const reasoningEffort =
    normalizeReasoningEffort(model, flagEffort ?? envEffort, {
      source: reasoningEffortSource === 'default' ? 'REASONING_EFFORT' : reasoningEffortSource,
      file: reasoningEffortSource === 'REASONING_EFFORT' ? fromFile('REASONING_EFFORT') : null,
    }) ?? defaultReasoningEffort(model);
  const notices = [];
  const envModel = nonBlank(env.MODEL_NAME);
  if (modelSource === '--model' && envModel && envModel !== model) {
    notices.push(`--model ${model} overrides MODEL_NAME=${envModel}${fromFile('MODEL_NAME') ? ` (from ${fromFile('MODEL_NAME')})` : ''}.`);
  }
  if (reasoningEffortSource === '--reasoning-effort' && envEffort && envEffort.toLowerCase() !== reasoningEffort) {
    notices.push(
      `--reasoning-effort ${reasoningEffort} overrides REASONING_EFFORT=${envEffort}${fromFile('REASONING_EFFORT') ? ` (from ${fromFile('REASONING_EFFORT')})` : ''}.`
    );
  }
  const completionSettings = resolveCompletionSettings(env);
  // OPENAI_API_KEY wins over OPENROUTER_API_KEY (resolveLlmApiKey), also on
  // OpenRouter: say so, so an OpenAI key is never sent there unnoticed.
  if (completionSettings.isOpenRouter && nonBlank(env.OPENAI_API_KEY) && nonBlank(env.OPENROUTER_API_KEY)) {
    notices.push(
      `OPENAI_API_KEY and OPENROUTER_API_KEY are both set: OPENAI_API_KEY is the key sent to ${completionSettings.baseUrlHost} ` +
        '(unset OPENAI_API_KEY to use OPENROUTER_API_KEY).'
    );
  }
  return {
    model,
    modelSource,
    modelSourceFile: modelSource === 'MODEL_NAME' ? fromFile('MODEL_NAME') : null,
    reasoningEffort,
    reasoningEffortSource,
    reasoningEffortSourceFile: reasoningEffortSource === 'REASONING_EFFORT' ? fromFile('REASONING_EFFORT') : null,
    ...completionSettings,
    capability: modelCapabilities(model),
    notices,
  };
}

/** The endpoint-level settings of a model config (what runOptimizedQuestion takes as completionSettings). */
export function completionSettingsOf(config) {
  return {
    baseUrlHost: config.baseUrlHost ?? null,
    isOpenRouter: Boolean(config.isOpenRouter),
    requireParameters: config.requireParameters ?? true,
    maxCompletionTokens: config.maxCompletionTokens ?? DEFAULT_REASONING_MAX_COMPLETION_TOKENS,
  };
}

/**
 * The effort as logs show it: the effort, else `unset` (no reasoning_effort
 * is sent: a non-reasoning or unknown model, or a family whose default is
 * none; a reasoning model's default effort is resolved up front).
 */
export function describeReasoningEffort(reasoningEffort) {
  return reasoningEffort || 'unset';
}

/**
 * One line for a run header: "model gpt-6-luna (MODEL_NAME from /x/.env);
 * reasoning effort low (--reasoning-effort); endpoint openrouter.ai
 * (OpenRouter, require_parameters on)".
 */
export function describeModelConfig(config) {
  const endpoint = config.isOpenRouter
    ? `${config.baseUrlHost} (OpenRouter, require_parameters ${config.requireParameters ? 'on' : 'off'})`
    : `${config.baseUrlHost ?? 'unparseable OPENAI_BASE_URL'}`;
  return (
    `model ${config.model} (${sourceLabel(config.modelSource, config.modelSourceFile, 'MODEL_NAME')}); ` +
    `reasoning effort ${describeReasoningEffort(config.reasoningEffort)} ` +
    `(${sourceLabel(config.reasoningEffortSource, config.reasoningEffortSourceFile, 'REASONING_EFFORT')}); ` +
    `endpoint ${endpoint}`
  );
}

/** "gpt-6-luna" or, with an effort, "gpt-6-luna (reasoning effort low)": a short label for reports. */
export function modelLabel(model, reasoningEffort = null) {
  return reasoningEffort ? `${model} (reasoning effort ${reasoningEffort})` : String(model);
}

// A model id written as is in a file label: lower-case letters and digits,
// with single `.` or `-` between them, in parts separated by `/` (written
// `__`). Such an id and its label map one to one: `_` never occurs in it, so
// `__` can only be a `/`; nothing in it changes on a case-insensitive file
// system or in the run directory's segment sanitizer (benchmark.js collapses
// `--` and trims `-`).
const PLAIN_MODEL_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/;

function sanitizeLabelPart(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * A file or directory name for a model and effort, distinct for distinct
 * ids: `<id>[.<effort>]`.
 * - A plain id (PLAIN_MODEL_ID, not ending in `.<effort>`) is written as is,
 *   with `/` mapped to `__`: gpt-4o-mini -> gpt-4o-mini (so the committed
 *   baseline keeps its name), gpt-6-luna at low -> gpt-6-luna.low,
 *   openai/gpt-6-luna -> openai__gpt-6-luna.
 * - Any other id is written sanitized (`/` -> `__`, other characters outside
 *   [A-Za-z0-9._-] -> `-`) plus `_` and the first 8 hex digits of the
 *   SHA-256 of the whole id, so ids that sanitize alike stay apart:
 *   acme/sql-1:free -> acme__sql-1-free_<hash>, while acme/sql-1-free stays
 *   acme__sql-1-free (a plain label never has a single `_`).
 */
export function modelFileLabel(model, reasoningEffort = null) {
  const id = String(model ?? '').trim();
  const effort = reasoningEffort ? `.${sanitizeLabelPart(String(reasoningEffort).toLowerCase())}` : '';
  const endsInEffort = REASONING_EFFORTS.some((value) => id.endsWith(`.${value}`));
  if (PLAIN_MODEL_ID.test(id) && !endsInEffort) {
    return `${id.replace(/\//g, '__')}${effort}`;
  }
  const readable = id.split('/').map(sanitizeLabelPart).join('__') || 'model';
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${readable}_${hash}${effort}`;
}
