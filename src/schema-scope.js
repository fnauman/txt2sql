// Schema scope: how much of the in-scope schema the optimized prompt shows and
// which tables the validator allows (audit findings EVAL-RET-2, EVAL-RET-9).
//
// - 'retrieved': the prompt shows the tables retrieval picked (plus join-path
//   connectors) and the validator allows exactly those. A retrieval miss is a
//   TABLE_SCOPE rejection. With widen-on-demand (the default) a TABLE_SCOPE
//   rejection of an in-scope table rebuilds the prompt with that table for the
//   retry; SCHEMA_WIDEN_ON_DEMAND=0 turns it off, which reproduces the product
//   loop as it was before schema scopes existed (and so the committed
//   baseline).
// - 'full': the prompt shows every in-scope table in one stable schema block
//   (the same for every question, so it caches as one prefix), retrieval output
//   is only a one-line relevance hint, and the validator allows every in-scope
//   table.
// - 'auto' (default): 'full' when the full schema block fits
//   SCHEMA_FULL_MAX_TOKENS estimated tokens (default 8000; about 4 characters
//   per token), else 'retrieved'. A small schema (the demo's 13 tables) gets
//   'full'; a large ERP schema keeps retrieval with widen-on-demand.
//
// Tables outside the in-scope schema (other databases, metadata schemas,
// tables not in DEFAULT_INCLUDED_TABLES) are rejected in every mode.
//
// Every entry point (web server, optimized CLI, npm run eval, verify-dataset,
// measure-prompt-cache) reads these settings with resolveSchemaScopeConfig.

export const SCHEMA_SCOPES = Object.freeze(['retrieved', 'full', 'auto']);
export const DEFAULT_SCHEMA_SCOPE = 'auto';
export const DEFAULT_SCHEMA_FULL_MAX_TOKENS = 8000;
const MAX_SCHEMA_FULL_MAX_TOKENS = 1_000_000;

export const DEFAULT_SCHEMA_SCOPE_CONFIG = Object.freeze({
  schemaScope: DEFAULT_SCHEMA_SCOPE,
  fullSchemaMaxTokens: DEFAULT_SCHEMA_FULL_MAX_TOKENS,
  widenOnDemand: true,
});

function configError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  return error;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function parseScope(raw, name) {
  const value = String(raw).trim().toLowerCase();
  if (!SCHEMA_SCOPES.includes(value)) {
    throw configError(`${name} must be one of ${SCHEMA_SCOPES.join(', ')}; got "${raw}".`);
  }
  return value;
}

function parseMaxTokens(raw, name) {
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SCHEMA_FULL_MAX_TOKENS) {
    throw configError(`${name} must be an integer between 1 and ${MAX_SCHEMA_FULL_MAX_TOKENS}; got "${raw}".`);
  }
  return value;
}

function parseBoolean(raw, name) {
  if (typeof raw === 'boolean') {
    return raw;
  }
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  throw configError(`${name} must be a boolean (1/0, true/false, yes/no, on/off); got "${raw}".`);
}

/**
 * The schema-scope settings from an env object: { schemaScope, fullSchemaMaxTokens,
 * widenOnDemand } from SCHEMA_SCOPE, SCHEMA_FULL_MAX_TOKENS and
 * SCHEMA_WIDEN_ON_DEMAND (blank values count as unset). Throws INVALID_CONFIG
 * on a bad value, so a typo never silently runs another configuration.
 */
export function resolveSchemaScopeConfig(env = process.env) {
  return Object.freeze({
    schemaScope: isBlank(env.SCHEMA_SCOPE) ? DEFAULT_SCHEMA_SCOPE : parseScope(env.SCHEMA_SCOPE, 'SCHEMA_SCOPE'),
    fullSchemaMaxTokens: isBlank(env.SCHEMA_FULL_MAX_TOKENS)
      ? DEFAULT_SCHEMA_FULL_MAX_TOKENS
      : parseMaxTokens(env.SCHEMA_FULL_MAX_TOKENS, 'SCHEMA_FULL_MAX_TOKENS'),
    widenOnDemand: isBlank(env.SCHEMA_WIDEN_ON_DEMAND) ? true : parseBoolean(env.SCHEMA_WIDEN_ON_DEMAND, 'SCHEMA_WIDEN_ON_DEMAND'),
  });
}

/**
 * A schema-scope option as callers pass it: undefined/null (the defaults), a
 * scope name ('full'), or a partial config object. Returns a complete, frozen
 * config; throws INVALID_CONFIG on a bad value.
 */
export function normalizeSchemaScopeConfig(option) {
  if (option === undefined || option === null) {
    return DEFAULT_SCHEMA_SCOPE_CONFIG;
  }
  if (typeof option === 'string') {
    return Object.freeze({ ...DEFAULT_SCHEMA_SCOPE_CONFIG, schemaScope: parseScope(option, 'schemaScope') });
  }
  if (typeof option !== 'object') {
    throw configError(`schemaScope must be a scope name or a config object; got ${typeof option}.`);
  }
  return Object.freeze({
    schemaScope: option.schemaScope === undefined ? DEFAULT_SCHEMA_SCOPE : parseScope(option.schemaScope, 'schemaScope'),
    fullSchemaMaxTokens:
      option.fullSchemaMaxTokens === undefined ? DEFAULT_SCHEMA_FULL_MAX_TOKENS : parseMaxTokens(option.fullSchemaMaxTokens, 'fullSchemaMaxTokens'),
    widenOnDemand: option.widenOnDemand === undefined ? true : parseBoolean(option.widenOnDemand, 'widenOnDemand'),
  });
}

/** One line for logs: "auto -> full (2,412 of 8,000 schema tokens; widen-on-demand on)". */
export function describeSchemaScope(scope) {
  if (!scope) {
    return 'n/a';
  }
  const tokens = Number.isFinite(scope.fullSchemaEstimatedTokens)
    ? `${scope.fullSchemaEstimatedTokens.toLocaleString('en-US')} of ${Number(scope.fullSchemaMaxTokens).toLocaleString('en-US')} estimated tokens for the full schema`
    : null;
  const mode = scope.requested === scope.effective ? scope.effective : `${scope.requested} -> ${scope.effective}`;
  const widen = scope.effective === 'retrieved' ? `widen-on-demand ${scope.widenOnDemand ? 'on' : 'off'}` : null;
  const details = [tokens, Number.isInteger(scope.inScopeTableCount) ? `${scope.inScopeTableCount} in-scope tables` : null, widen].filter(Boolean);
  return details.length > 0 ? `${mode} (${details.join('; ')})` : mode;
}
