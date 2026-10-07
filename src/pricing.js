// Per-million-token USD prices used only for local cost ESTIMATES shown in the
// CLI/web UI and traces. These are not billing figures. Verify against the
// provider's current price list before relying on them.
//
// Provenance: gpt-4o-mini rates are OpenAI's published prices. gpt-6-luna
// and gpt-6-sol are OpenAI's published prices, verified on 2026-10-07 at
// developers.openai.com/api/docs/models/gpt-6-luna and .../gpt-6-sol. The
// gpt-5.4-* rows are the rates configured for the OpenAI-compatible gateway
// this repo targets (set via OPENAI_BASE_URL); confirm them with your provider.
// Last reviewed: 2026-10.
//
// A model id is looked up without its vendor prefix, so OpenRouter's
// openai/gpt-6-luna resolves to the gpt-6-luna row (a variant such as
// openai/gpt-6-luna:free does not: its price differs). A row prices its own
// id and that id's dated snapshots (gpt-4o-mini-2024-07-18, or the
// -YYYYMMDD form), nothing else: gpt-6-sol-pro or gpt-6-luna-mini is another
// model at another price, so it has no price (and --budget-usd refuses it)
// rather than the base row's.
//
// Override without editing code by setting MODEL_PRICING_OVERRIDES to a JSON map,
// e.g. MODEL_PRICING_OVERRIDES='{"gpt-5.4-mini":{"inputPerMillion":0.7,"outputPerMillion":4.2}}'.
// An override for a listed model replaces the given fields; one for a model
// that is not listed adds it when it has both inputPerMillion and
// outputPerMillion (cachedInputPerMillion optional), so --budget-usd can track
// any model. A key without a vendor prefix applies under any vendor, like the
// rows; a key with one (openai/gpt-6-luna, acme/sql-1) only to model ids
// under that vendor, and wins over a key without one.
//
// Reasoning tokens (usage.completion_tokens_details.reasoning_tokens) are
// part of completion_tokens and billed as output; they are summed and shown
// separately. A cost the provider reports itself (usage.cost, as OpenRouter
// does) is what the call was charged, so it is the cost (totalCost, source
// 'provider', also kept as providerCost) whether or not the model has a price
// here: run totals and the --budget-usd pool (src/eval/pool.js) count it. For
// a priced model the local estimate stays beside it: inputCost / outputCost
// are the estimate's split and estimatedCost its sum.
const BASE_MODEL_PRICING = Object.freeze({
  'gpt-4o-mini': Object.freeze({
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
    currency: 'USD',
  }),
  'gpt-5.4-nano': Object.freeze({
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.25,
    currency: 'USD',
  }),
  'gpt-5.4-mini': Object.freeze({
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
    currency: 'USD',
  }),
  'gpt-5.4': Object.freeze({
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    currency: 'USD',
  }),
  'gpt-6-luna': Object.freeze({
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.01,
    outputPerMillion: 0.5,
    currency: 'USD',
  }),
  'gpt-6-sol': Object.freeze({
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 10,
    currency: 'USD',
  }),
});

// Parse MODEL_PRICING_OVERRIDES lazily and memoize on the raw string. Parsing
// at resolution time (not module-import time) is required because entrypoints
// call loadEnvironment() AFTER their static imports already evaluated this
// module, so an override supplied via .env / --dotenv would otherwise be
// missed. Memoizing on the raw value means it is parsed once in practice while
// still picking up a changed env (e.g. between tests).
let cachedOverridesRaw;
let cachedOverrides = [];

function getPricingOverrides() {
  const raw = process.env.MODEL_PRICING_OVERRIDES || '';
  if (raw === cachedOverridesRaw) {
    return cachedOverrides;
  }

  cachedOverridesRaw = raw;
  if (!raw) {
    cachedOverrides = [];
    return cachedOverrides;
  }

  let parsed = {};
  try {
    const value = JSON.parse(raw);
    parsed = value && typeof value === 'object' ? value : {};
  } catch {
    // Ignore malformed overrides rather than break cost estimation.
  }
  // Split like the model ids they price: { vendor, id, pricing } per entry.
  cachedOverrides = Object.entries(parsed)
    .filter(([, pricing]) => pricing && typeof pricing === 'object')
    .map(([name, pricing]) => ({ ...splitModelId(name), pricing }))
    .filter((entry) => entry.id);
  return cachedOverrides;
}

// At most one row prices an id (its own id or a dated snapshot of it), so
// the order does not matter.
const MODEL_PRICING_ENTRIES = Object.freeze(Object.entries(BASE_MODEL_PRICING));

function normalizeModelName(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

// A model id split into its vendor prefix (null without one) and the id a
// price is looked up by: openai/gpt-6-luna -> { vendor: 'openai', id: 'gpt-6-luna' }.
function splitModelId(model) {
  const normalized = normalizeModelName(model);
  const slash = normalized.lastIndexOf('/');
  return { vendor: slash >= 0 ? normalized.slice(0, slash) : null, id: normalized.slice(slash + 1) };
}

// A dated snapshot suffix: -2024-07-18 (OpenAI) or -20240718.
const SNAPSHOT_SUFFIX = /^-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

// Whether `id` is the priced id `name` or one of its dated snapshots.
function isSnapshotOf(id, name) {
  return id === name || (id.startsWith(`${name}-`) && SNAPSHOT_SUFFIX.test(id.slice(name.length)));
}

// Whether an override entry applies under the model's vendor.
function appliesToVendor(entry, vendor) {
  return entry.vendor === null || entry.vendor === vendor;
}

// Vendor-specific entries last, so they win when merged.
function byVendorSpecificity(left, right) {
  return Number(left.vendor !== null) - Number(right.vendor !== null);
}

function isPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeTokenCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Number(value.toFixed(12));
}

// The provider's own breakdowns: reasoning tokens (part of completion_tokens)
// and a reported cost in USD; null when the usage does not carry them.
function reasoningTokensOf(usage) {
  return normalizeTokenCount(usage?.completion_tokens_details?.reasoning_tokens);
}

function providerCostOf(usage) {
  const value = usage?.cost;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveModelPricing(model) {
  const { vendor, id } = splitModelId(model);
  const overrides = getPricingOverrides().filter((entry) => appliesToVendor(entry, vendor));

  for (const [modelName, pricing] of MODEL_PRICING_ENTRIES) {
    if (isSnapshotOf(id, modelName)) {
      const fields = overrides
        .filter((entry) => entry.id === modelName)
        .sort(byVendorSpecificity)
        .map((entry) => entry.pricing);
      return Object.assign({ model: modelName, ...pricing }, ...fields);
    }
  }

  // A model that is not listed: a complete override entry prices it (one
  // keyed with the model's vendor wins over one without).
  const added = overrides
    .filter((entry) => isPrice(entry.pricing.inputPerMillion) && isPrice(entry.pricing.outputPerMillion) && isSnapshotOf(id, entry.id))
    .sort(byVendorSpecificity);
  if (added.length > 0) {
    const { id: name, pricing } = added.at(-1);
    return {
      model: name,
      inputPerMillion: pricing.inputPerMillion,
      ...(isPrice(pricing.cachedInputPerMillion) ? { cachedInputPerMillion: pricing.cachedInputPerMillion } : {}),
      outputPerMillion: pricing.outputPerMillion,
      currency: typeof pricing.currency === 'string' ? pricing.currency : 'USD',
    };
  }

  return null;
}

/**
 * Whether `model` has a price (a listed row or a MODEL_PRICING_OVERRIDES
 * entry), i.e. whether its cost, and so a --budget-usd cap, can be computed
 * before any call.
 */
export function hasModelPrice(model) {
  return resolveModelPricing(model) !== null;
}

function formatTokenCount(value) {
  return Number.isFinite(value) ? String(value) : '?';
}

export function calculateCost(model, usage) {
  const pricing = resolveModelPricing(model);
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);
  const reasoningTokens = reasoningTokensOf(usage);
  const providerCost = providerCostOf(usage);

  if (promptTokens === null || completionTokens === null || (!pricing && providerCost === null)) {
    return null;
  }

  const cachedPromptTokens = Math.min(
    promptTokens,
    Math.max(0, normalizeTokenCount(usage?.prompt_tokens_details?.cached_tokens) ?? 0)
  );
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;
  const totalTokens = normalizeTokenCount(usage?.total_tokens) ?? promptTokens + completionTokens;
  if (!pricing) {
    // No price here: the provider's reported cost is the cost (with no input /
    // output split to estimate).
    return {
      model: normalizeModelName(model),
      currency: 'USD',
      source: 'provider',
      promptTokens,
      cachedPromptTokens,
      uncachedPromptTokens,
      completionTokens,
      ...(reasoningTokens !== null ? { reasoningTokens } : {}),
      totalTokens,
      inputCost: 0,
      outputCost: 0,
      totalCost: roundCurrency(providerCost),
      providerCost: roundCurrency(providerCost),
    };
  }
  const inputCost = roundCurrency(
    (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion +
      (cachedPromptTokens / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
  );
  const outputCost = roundCurrency((completionTokens / 1_000_000) * pricing.outputPerMillion);
  const estimatedCost = roundCurrency(inputCost + outputCost);

  if (providerCost !== null) {
    // Priced here, but the provider said what it charged: that is the cost
    // (what totals and --budget-usd count); inputCost / outputCost stay the
    // local estimate's split, and estimatedCost its sum.
    return {
      model: pricing.model,
      currency: pricing.currency || 'USD',
      source: 'provider',
      promptTokens,
      cachedPromptTokens,
      uncachedPromptTokens,
      completionTokens,
      ...(reasoningTokens !== null ? { reasoningTokens } : {}),
      totalTokens,
      inputCost,
      outputCost,
      totalCost: roundCurrency(providerCost),
      providerCost: roundCurrency(providerCost),
      estimatedCost,
    };
  }

  return {
    model: pricing.model,
    currency: pricing.currency || 'USD',
    promptTokens,
    cachedPromptTokens,
    uncachedPromptTokens,
    completionTokens,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    totalTokens,
    inputCost,
    outputCost,
    totalCost: estimatedCost,
  };
}

// The local estimate of a cost: its estimatedCost when the provider's charge
// replaced it, the total of one with no source (an estimate), else unknown
// (null: a provider-reported cost of a model with no price here).
function estimateOf(cost) {
  if (typeof cost.estimatedCost === 'number' && Number.isFinite(cost.estimatedCost)) {
    return cost.estimatedCost;
  }
  return cost.source === undefined || cost.source === null ? cost.totalCost || 0 : null;
}

export function mergeUsage(usages = []) {
  const totals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let hasUsage = false;
  let hasCachedPromptTokens = false;
  let cachedPromptTokens = 0;
  let hasReasoningTokens = false;
  let reasoningTokens = 0;
  let hasProviderCost = false;
  let providerCost = 0;

  for (const usage of usages) {
    const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
    const completionTokens = normalizeTokenCount(usage?.completion_tokens);

    if (promptTokens === null || completionTokens === null) {
      continue;
    }

    hasUsage = true;
    totals.prompt_tokens += promptTokens;
    totals.completion_tokens += completionTokens;
    totals.total_tokens += normalizeTokenCount(usage?.total_tokens) ?? promptTokens + completionTokens;

    const cachedTokens = normalizeTokenCount(usage?.prompt_tokens_details?.cached_tokens);
    if (cachedTokens !== null) {
      hasCachedPromptTokens = true;
      cachedPromptTokens += Math.min(promptTokens, Math.max(0, cachedTokens));
    }

    const callReasoningTokens = reasoningTokensOf(usage);
    if (callReasoningTokens !== null) {
      hasReasoningTokens = true;
      reasoningTokens += Math.min(completionTokens, Math.max(0, callReasoningTokens));
    }

    const callProviderCost = providerCostOf(usage);
    if (callProviderCost !== null) {
      hasProviderCost = true;
      providerCost += callProviderCost;
    }
  }

  if (!hasUsage) {
    return null;
  }

  if (hasCachedPromptTokens) {
    totals.prompt_tokens_details = {
      cached_tokens: cachedPromptTokens,
    };
  }

  if (hasReasoningTokens) {
    totals.completion_tokens_details = {
      reasoning_tokens: reasoningTokens,
    };
  }

  if (hasProviderCost) {
    totals.cost = roundCurrency(providerCost);
  }

  return totals;
}

export function mergeCosts(costs = []) {
  const totals = {
    currency: null,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
  };
  let hasCost = false;
  let hasTokenBreakdown = false;
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let uncachedPromptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasReasoningTokens = false;
  let reasoningTokens = 0;
  let hasProviderCost = false;
  let providerCost = 0;
  // The sum of the local estimates, kept when some cost is not its own
  // estimate (the provider's charge replaced it) and every cost has one.
  let hasReplacedEstimate = false;
  let estimateKnown = true;
  let estimatedCost = 0;

  for (const cost of costs) {
    if (!cost) {
      continue;
    }

    const currency = cost.currency || 'USD';
    if (totals.currency !== null && currency !== totals.currency) {
      throw new Error(`Currency mismatch in mergeCosts: cannot merge ${totals.currency} with ${currency}`);
    }

    hasCost = true;
    totals.currency = totals.currency ?? currency;
    totals.inputCost = roundCurrency(totals.inputCost + (cost.inputCost || 0));
    totals.outputCost = roundCurrency(totals.outputCost + (cost.outputCost || 0));
    totals.totalCost = roundCurrency(totals.totalCost + (cost.totalCost || 0));

    if (
      normalizeTokenCount(cost.promptTokens) !== null ||
      normalizeTokenCount(cost.cachedPromptTokens) !== null ||
      normalizeTokenCount(cost.uncachedPromptTokens) !== null ||
      normalizeTokenCount(cost.completionTokens) !== null ||
      normalizeTokenCount(cost.totalTokens) !== null
    ) {
      hasTokenBreakdown = true;
      promptTokens += normalizeTokenCount(cost.promptTokens) ?? 0;
      cachedPromptTokens += normalizeTokenCount(cost.cachedPromptTokens) ?? 0;
      uncachedPromptTokens += normalizeTokenCount(cost.uncachedPromptTokens) ?? 0;
      completionTokens += normalizeTokenCount(cost.completionTokens) ?? 0;
      totalTokens += normalizeTokenCount(cost.totalTokens) ?? 0;
    }
    if (normalizeTokenCount(cost.reasoningTokens) !== null) {
      hasReasoningTokens = true;
      reasoningTokens += normalizeTokenCount(cost.reasoningTokens);
    }
    if (typeof cost.providerCost === 'number' && Number.isFinite(cost.providerCost)) {
      hasProviderCost = true;
      providerCost = roundCurrency(providerCost + cost.providerCost);
    }
    const estimate = estimateOf(cost);
    if (estimate === null) {
      estimateKnown = false;
    } else {
      estimatedCost = roundCurrency(estimatedCost + estimate);
    }
    if ((cost.source !== undefined && cost.source !== null) || typeof cost.estimatedCost === 'number') {
      hasReplacedEstimate = true;
    }
  }

  if (!hasCost) {
    return null;
  }

  totals.currency = totals.currency ?? 'USD';
  if (hasTokenBreakdown) {
    totals.promptTokens = promptTokens;
    totals.cachedPromptTokens = cachedPromptTokens;
    totals.uncachedPromptTokens = uncachedPromptTokens;
    totals.completionTokens = completionTokens;
    totals.totalTokens = totalTokens;
  }
  if (hasReasoningTokens) {
    totals.reasoningTokens = reasoningTokens;
  }
  if (hasProviderCost) {
    totals.providerCost = providerCost;
  }
  if (hasReplacedEstimate && estimateKnown) {
    totals.estimatedCost = estimatedCost;
  }

  return totals;
}

export function formatUsageAndCost({ usage = null, cost = null, model = null } = {}) {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens) ?? normalizeTokenCount(cost?.promptTokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens) ?? normalizeTokenCount(cost?.completionTokens);
  const cachedPromptTokens =
    normalizeTokenCount(usage?.prompt_tokens_details?.cached_tokens) ?? normalizeTokenCount(cost?.cachedPromptTokens);
  const reasoningTokens = reasoningTokensOf(usage) ?? normalizeTokenCount(cost?.reasoningTokens);
  const resolvedModel = cost?.model || normalizeModelName(model) || 'unknown-model';
  const cachedText =
    cachedPromptTokens !== null && cachedPromptTokens > 0 && promptTokens !== null && promptTokens > 0
      ? `, ${formatTokenCount(cachedPromptTokens)} cached input (${((cachedPromptTokens / promptTokens) * 100).toFixed(1)}%)`
      : '';
  const reasoningText = reasoningTokens !== null && reasoningTokens > 0 ? ` incl. ${formatTokenCount(reasoningTokens)} reasoning` : '';
  const estimateText = Number.isFinite(cost?.estimatedCost) ? ` (local estimate $${cost.estimatedCost.toFixed(6)})` : '';
  const sourceText = cost?.source === 'provider' ? `, cost reported by the provider${estimateText}` : '';

  if (cost) {
    return `$${cost.totalCost.toFixed(6)} (${formatTokenCount(promptTokens)} input${cachedText} + ${formatTokenCount(completionTokens)} output tokens${reasoningText}, ${resolvedModel}${sourceText})`;
  }

  if (promptTokens !== null || completionTokens !== null) {
    return `cost unavailable (${formatTokenCount(promptTokens)} input${cachedText} + ${formatTokenCount(completionTokens)} output tokens${reasoningText}, ${resolvedModel})`;
  }

  return `cost unavailable (${resolvedModel})`;
}
