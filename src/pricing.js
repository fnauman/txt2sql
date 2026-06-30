// Per-million-token USD prices used only for local cost ESTIMATES shown in the
// CLI/web UI and traces. These are not billing figures. Verify against the
// provider's current price list before relying on them.
//
// Provenance: gpt-4o-mini rates are OpenAI's published prices. The gpt-5.4-*
// rows are the rates configured for the OpenAI-compatible gateway this repo
// targets (set via OPENAI_BASE_URL); confirm them with your provider.
// Last reviewed: 2026-06.
//
// Override without editing code by setting MODEL_PRICING_OVERRIDES to a JSON map,
// e.g. MODEL_PRICING_OVERRIDES='{"gpt-5.4-mini":{"inputPerMillion":0.7,"outputPerMillion":4.2}}'.
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
});

// Parse MODEL_PRICING_OVERRIDES lazily and memoize on the raw string. Parsing
// at resolution time (not module-import time) is required because entrypoints
// call loadEnvironment() AFTER their static imports already evaluated this
// module, so an override supplied via .env / --env-file would otherwise be
// missed. Memoizing on the raw value means it is parsed once in practice while
// still picking up a changed env (e.g. between tests).
let cachedOverridesRaw;
let cachedOverrides = {};

function getPricingOverrides() {
  const raw = process.env.MODEL_PRICING_OVERRIDES || '';
  if (raw === cachedOverridesRaw) {
    return cachedOverrides;
  }

  cachedOverridesRaw = raw;
  if (!raw) {
    cachedOverrides = {};
    return cachedOverrides;
  }

  try {
    const parsed = JSON.parse(raw);
    cachedOverrides = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Ignore malformed overrides rather than break cost estimation.
    cachedOverrides = {};
  }
  return cachedOverrides;
}

const MODEL_PRICING_ENTRIES = Object.freeze(
  Object.entries(BASE_MODEL_PRICING).sort(([left], [right]) => right.length - left.length)
);

function normalizeModelName(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function normalizeTokenCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Number(value.toFixed(12));
}

function resolveModelPricing(model) {
  const normalized = normalizeModelName(model);
  const overrides = getPricingOverrides();

  for (const [modelName, pricing] of MODEL_PRICING_ENTRIES) {
    if (normalized === modelName || normalized.startsWith(`${modelName}-`)) {
      const override = overrides[modelName];
      return {
        model: modelName,
        ...pricing,
        ...(override && typeof override === 'object' ? override : {}),
      };
    }
  }

  return null;
}

function formatTokenCount(value) {
  return Number.isFinite(value) ? String(value) : '?';
}

export function calculateCost(model, usage) {
  const pricing = resolveModelPricing(model);
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);

  if (!pricing || promptTokens === null || completionTokens === null) {
    return null;
  }

  const cachedPromptTokens = Math.min(
    promptTokens,
    Math.max(0, normalizeTokenCount(usage?.prompt_tokens_details?.cached_tokens) ?? 0)
  );
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;
  const totalTokens = normalizeTokenCount(usage?.total_tokens) ?? promptTokens + completionTokens;
  const inputCost = roundCurrency(
    (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion +
      (cachedPromptTokens / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
  );
  const outputCost = roundCurrency((completionTokens / 1_000_000) * pricing.outputPerMillion);

  return {
    model: pricing.model,
    currency: pricing.currency || 'USD',
    promptTokens,
    cachedPromptTokens,
    uncachedPromptTokens,
    completionTokens,
    totalTokens,
    inputCost,
    outputCost,
    totalCost: roundCurrency(inputCost + outputCost),
  };
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
  }

  if (!hasUsage) {
    return null;
  }

  if (hasCachedPromptTokens) {
    totals.prompt_tokens_details = {
      cached_tokens: cachedPromptTokens,
    };
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

  return totals;
}

export function formatUsageAndCost({ usage = null, cost = null, model = null } = {}) {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens) ?? normalizeTokenCount(cost?.promptTokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens) ?? normalizeTokenCount(cost?.completionTokens);
  const cachedPromptTokens =
    normalizeTokenCount(usage?.prompt_tokens_details?.cached_tokens) ?? normalizeTokenCount(cost?.cachedPromptTokens);
  const resolvedModel = cost?.model || normalizeModelName(model) || 'unknown-model';
  const cachedText =
    cachedPromptTokens !== null && cachedPromptTokens > 0 && promptTokens !== null && promptTokens > 0
      ? `, ${formatTokenCount(cachedPromptTokens)} cached input (${((cachedPromptTokens / promptTokens) * 100).toFixed(1)}%)`
      : '';

  if (cost) {
    return `$${cost.totalCost.toFixed(6)} (${formatTokenCount(promptTokens)} input${cachedText} + ${formatTokenCount(completionTokens)} output tokens, ${resolvedModel})`;
  }

  if (promptTokens !== null || completionTokens !== null) {
    return `cost unavailable (${formatTokenCount(promptTokens)} input${cachedText} + ${formatTokenCount(completionTokens)} output tokens, ${resolvedModel})`;
  }

  return `cost unavailable (${resolvedModel})`;
}
