// Model configuration: which model a run uses, where that choice came from,
// its reasoning effort, and the request options that model accepts.
//
// - DEFAULT_MODEL is the one default model of the repository: the web server,
//   the basic and optimized CLIs, the query service and npm run eval all fall
//   back to it when neither --model (eval only) nor MODEL_NAME is set. A test
//   (test/model-config.test.js) fails on any other default model literal in
//   src/, scripts/, apps/web/src/server/ or the CI workflow, so changing the
//   default is a one-line change here.
// - The capability map (MODEL_FAMILIES) is keyed by the model id with any
//   vendor prefix stripped (openai/gpt-6-luna is gpt-6-luna, as OpenRouter
//   names it): gpt-4o* and gpt-4.1* take temperature 0 and no reasoning
//   effort; gpt-6*, gpt-5* and the o-series are reasoning models. A model
//   outside the map keeps the request every model got before this module
//   existed, unless a reasoning effort is set (then it is treated as a
//   reasoning model with the conservative effort list).
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
// accepts (null: no reasoning effort at all). gpt-6: verified on 2026-10-07
// (developers.openai.com/api/docs/models/gpt-6-luna and gpt-6-sol: none, low,
// medium (default), high, xhigh, max). gpt-5 and the o-series: the efforts
// their snapshots have in common; a snapshot that accepts more needs a map
// entry here.
export const MODEL_FAMILIES = Object.freeze([
  Object.freeze({ family: 'gpt-4o', label: 'gpt-4o*', pattern: /^gpt-4o(?:-|$)/, reasoning: false, efforts: null }),
  Object.freeze({ family: 'gpt-4.1', label: 'gpt-4.1*', pattern: /^gpt-4\.1(?:-|$)/, reasoning: false, efforts: null }),
  Object.freeze({ family: 'gpt-6', label: 'gpt-6*', pattern: /^gpt-6(?:[.-]|$)/, reasoning: true, efforts: REASONING_EFFORTS }),
  Object.freeze({ family: 'gpt-5', label: 'gpt-5*', pattern: /^gpt-5(?:[.-]|$)/, reasoning: true, efforts: Object.freeze(['none', 'low', 'medium', 'high']) }),
  Object.freeze({ family: 'o-series', label: 'o1*, o3*, o4*, ...', pattern: /^o\d+(?:-|$)/, reasoning: true, efforts: Object.freeze(['low', 'medium', 'high']) }),
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
 * What the capability map says about a model: { id, family, reasoning, efforts }.
 * reasoning is true / false for a listed family and null for an unknown model
 * (family null, efforts the conservative list).
 */
export function modelCapabilities(model) {
  const id = baseModelId(model);
  const entry = MODEL_FAMILIES.find((candidate) => candidate.pattern.test(id));
  if (!entry) {
    return { id, family: null, reasoning: null, efforts: UNKNOWN_FAMILY_REASONING_EFFORTS };
  }
  return { id, family: entry.family, reasoning: entry.reasoning, efforts: entry.efforts };
}

/**
 * A reasoning effort for `model`, validated: null when unset (undefined, null
 * or blank), else the lower-cased value. Throws INVALID_CONFIG for a value
 * that is not an effort, one the model's family does not accept, or any
 * effort for a known non-reasoning model. `source` names the setting in the
 * message (REASONING_EFFORT, --reasoning-effort, ...).
 */
export function normalizeReasoningEffort(model, effort, { source = 'REASONING_EFFORT' } = {}) {
  const raw = nonBlank(effort);
  if (raw === null) {
    return null;
  }
  const value = raw.toLowerCase();
  if (!REASONING_EFFORTS.includes(value)) {
    throw configError(`${source} must be one of ${REASONING_EFFORTS.join(', ')}; got "${raw}".`);
  }
  const capability = modelCapabilities(model);
  if (capability.reasoning === false) {
    throw configError(
      `${source} "${value}" does not apply to ${model}: the ${capability.family} family is not a reasoning model (allowed: unset). ` +
        `Unset ${source}, or pick a reasoning model.`
    );
  }
  if (!capability.efforts.includes(value)) {
    const family = capability.family ? `the ${capability.family} family` : 'a model outside the capability map';
    throw configError(`${source} "${value}" is not supported by ${model} (${family}); allowed: ${capability.efforts.join(', ')}.`);
  }
  return value;
}

/**
 * Whether a request for `model` at `reasoningEffort` reasons: a reasoning
 * family at any effort but `none` (no effort: the provider's default, which
 * reasons), or an unknown model with an effort other than `none`.
 */
export function reasoningEnabled(model, reasoningEffort = null) {
  if (reasoningEffort) {
    return reasoningEffort !== 'none';
  }
  return modelCapabilities(model).reasoning === true;
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
 * for the model. Unchanged base options are returned as the same object.
 */
export function buildCompletionOptions(base, settings = {}) {
  const {
    model,
    reasoningEffort = null,
    isOpenRouter = false,
    requireParameters = true,
    maxCompletionTokens = DEFAULT_REASONING_MAX_COMPLETION_TOKENS,
  } = settings;
  const effort = normalizeReasoningEffort(model, reasoningEffort, { source: 'reasoningEffort' });
  let options = base;
  if (reasoningEnabled(model, effort)) {
    const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'temperature' && key !== 'top_p'));
    options = { ...rest, max_completion_tokens: maxCompletionTokens, ...(effort ? { reasoning_effort: effort } : {}) };
  } else if (effort) {
    // Effort `none`: no reasoning, so the deterministic base options stay.
    options = { ...base, reasoning_effort: effort };
  }
  if (isOpenRouter && requireParameters) {
    options = { ...options, provider: { require_parameters: true } };
  }
  return options;
}
