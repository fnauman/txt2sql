// Hints version: which generation of the prompt's knowledge layer (business
// rules, temporal resolution, semantic-layer hints, retrieval stopwords and
// the metric guardrail's arbitration) the optimized pipeline uses. One switch,
// so the two generations can be A/B'd with everything else fixed
// (docs/experiments/02-hints-v2.md).
//
// - 1: the prompts, semantic plans and validator decisions every run had
//   before HINTS_VERSION existed, byte for byte (the version-1 baselines').
// - 2 (default): "hints v2": no resolved range for a date phrase the resolver
//   only partly understands, unambiguous business rules (posting date, brand
//   path, ranking limits, count and single-total shapes, time grain), the
//   semantic-layer overlay metadata/semantic-layer.hints-v2.json, metric
//   default filters and notes in the hints, no entity display columns for a
//   word a metric consumed, retrieval stopwords, and sales metrics that do not
//   enforce in a ledger (debit/credit) question.
//
// Every entry point (web server, optimized CLI, npm run eval, verify-dataset,
// measure-prompt-cache) reads HINTS_VERSION with resolveHintsVersion, like
// SCHEMA_SCOPE. The basic pipeline (npm run basic) has no hints and ignores it.

export const HINTS_VERSIONS = Object.freeze([1, 2]);
export const DEFAULT_HINTS_VERSION = 2;

function configError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  return error;
}

function parseHintsVersion(raw, name) {
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!HINTS_VERSIONS.includes(value)) {
    throw configError(`${name} must be one of ${HINTS_VERSIONS.join(', ')}; got "${raw}".`);
  }
  return value;
}

/**
 * HINTS_VERSION from an env object (blank counts as unset: the default).
 * Throws INVALID_CONFIG on any other value, so a typo never silently runs the
 * other arm of an A/B.
 */
export function resolveHintsVersion(env = process.env) {
  const raw = env.HINTS_VERSION;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_HINTS_VERSION;
  }
  return parseHintsVersion(raw, 'HINTS_VERSION');
}

/**
 * A hints-version option as callers pass it: undefined/null (the default), a
 * number or a numeric string. Throws INVALID_CONFIG on anything else.
 */
export function normalizeHintsVersion(option) {
  if (option === undefined || option === null) {
    return DEFAULT_HINTS_VERSION;
  }
  if (typeof option !== 'number' && typeof option !== 'string') {
    throw configError(`hintsVersion must be one of ${HINTS_VERSIONS.join(', ')}; got ${typeof option}.`);
  }
  return parseHintsVersion(option, 'hintsVersion');
}

/**
 * Whether two recorded hints versions (provenance.product.hintsVersion; null =
 * recorded before HINTS_VERSION, i.e. version 1) are the same.
 */
export function sameHintsVersion(left, right) {
  return (left ?? 1) === (right ?? 1);
}

/** One line for logs: "2 (default)" or "1". */
export function describeHintsVersion(version) {
  if (version === undefined || version === null) {
    return 'not recorded (before HINTS_VERSION: 1)';
  }
  return version === DEFAULT_HINTS_VERSION ? `${version} (default)` : String(version);
}
