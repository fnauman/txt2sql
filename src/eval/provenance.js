// Run provenance: enough to say WHAT produced a number, so two reports are
// only compared when that is meaningful and a regression can be traced to a
// prompt, semantic-layer, fixture or dataset change.
//
// - git: HEAD sha and whether the working tree is dirty (uncommitted or
//   untracked files; ignored files such as generated/ do not count);
// - promptVersion: sha256 over the optimized system prompt (built by the real
//   builder, so it includes the business rules), the BUSINESS_RULES and
//   FEW_SHOT_EXAMPLES constants and the model request options;
// - semanticLayerVersion: sha256 of metadata/semantic-layer.json (hints
//   version 1), or for hints version 2 of that file's and its overlay's
//   hashes together; semanticLayerOverlay names the overlay (null for 1);
// - schemaVersion: sha256 of the compiled schema the prompts were built from;
// - fixtures: expected and actual content hashes per fixture database;
// - datasets and controls: sha256 of every file read;
// - model, the OpenAI-compatible endpoint HOST only (never a key, path or
//   query), Node version and the runner flags;
// - product: the product configuration that shapes the prompt and the
//   validator: the schema scope (requested and effective, the full-schema
//   token estimate and budget, widen-on-demand) and the hints version
//   (HINTS_VERSION); and the model settings: product.model, modelSource
//   (--model, MODEL_NAME or default; `recorded` in a rescore, which reuses
//   the recording's), reasoningEffort (null: none set), reasoningEffortSource
//   and requestOptions (the optimized request's options as sent, without the
//   response_format that the prompt version already covers). Reports from
//   before SCHEMA_SCOPE existed have no `product` block; they ran the
//   retrieved scope without widening. Reports from before HINTS_VERSION
//   existed have no `product.hintsVersion`; they ran hints version 1. Reports
//   from before REASONING_EFFORT have no `product.reasoningEffort`; they sent
//   none.
// Paths are stored relative to the repository root.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { businessRulesFor, FEW_SHOT_EXAMPLES } from '../constants.js';
import { normalizeHintsVersion } from '../hints-version.js';
import { buildCompletionOptions } from '../model-config.js';
import { OPTIMIZED_MODEL_REQUEST_OPTIONS, buildOptimizedPrompt, resolveEffectiveSchemaScope } from '../pipeline.js';

const execFileAsync = promisify(execFile);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SEMANTIC_LAYER_PATH = path.resolve(REPO_ROOT, 'metadata/semantic-layer.json');
export const SEMANTIC_LAYER_OVERLAY_PATH = path.resolve(REPO_ROOT, 'metadata/semantic-layer.hints-v2.json');

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Stable JSON (object keys sorted) so a hash does not depend on key order. */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function hashFile(filePath) {
  try {
    return sha256Hex(await fs.readFile(filePath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function repoRelative(filePath, root = REPO_ROOT) {
  if (!filePath) {
    return null;
  }
  const relative = path.relative(root, path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : path.resolve(filePath);
}

/** { sha, dirty, changedFiles } of a git work tree (nulls when git is unavailable). */
export async function resolveGitState(cwd = REPO_ROOT, { run = execFileAsync } = {}) {
  let sha = null;
  try {
    sha = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim() || null;
  } catch {
    return { sha: null, dirty: null, changedFiles: null };
  }
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd });
    const changed = stdout.split('\n').filter((line) => line.trim() !== '');
    return { sha, dirty: changed.length > 0, changedFiles: changed.length };
  } catch {
    return { sha, dirty: null, changedFiles: null };
  }
}

/**
 * Prompt version: sha256 of what decides the prompt the model sees apart from
 * the question and the schema (hashed separately): the optimized system prompt
 * as the product builds it under `parts.schemaScope` and `parts.hintsVersion`
 * (default: the product defaults), the business rules of that hints version,
 * the few-shot pool and the request options. `parts` lets tests vary one
 * input. The retrieved scope's version-1 system prompt is the one every run
 * had before schema scopes existed, so its version matches older reports.
 */
export function computePromptVersion(schema, parts = {}) {
  const hintsVersion = normalizeHintsVersion(parts.hintsVersion);
  const systemPrompt =
    parts.systemPrompt ?? buildOptimizedPrompt(schema, 'Prompt version probe', { schemaScope: parts.schemaScope, hintsVersion }).system;
  const material = {
    systemPrompt,
    businessRules: parts.businessRules ?? businessRulesFor(hintsVersion),
    fewShotExamples: parts.fewShotExamples ?? FEW_SHOT_EXAMPLES,
    requestOptions: parts.requestOptions ?? OPTIMIZED_MODEL_REQUEST_OPTIONS,
  };
  return sha256Hex(stableStringify(material));
}

export function computeSchemaVersion(schema) {
  return sha256Hex(stableStringify(schema?.tables || []));
}

/**
 * The OpenAI-compatible endpoint, host only: credentials, path and query
 * never reach a report. The SDK default is api.openai.com.
 */
export function describeLlmEndpoint(env = process.env) {
  const raw = env.OPENAI_BASE_URL;
  if (!raw || String(raw).trim() === '') {
    return { host: 'api.openai.com', source: 'default' };
  }
  try {
    return { host: new URL(String(raw).trim()).host || null, source: 'OPENAI_BASE_URL' };
  } catch {
    return { host: null, source: 'OPENAI_BASE_URL (unparseable)' };
  }
}

export function shortHash(hash, length = 12) {
  return hash ? String(hash).slice(0, length) : null;
}

/**
 * The model part of the product block for `modelConfig` ({ model,
 * modelSource, reasoningEffort, reasoningEffortSource, and either
 * completionSettings, from which the request options are built, or the
 * recorded requestOptions }); `model` alone when there is no modelConfig.
 */
export function describeModelProduct(modelConfig = null, model = null) {
  const config = modelConfig || {};
  const resolvedModel = config.model ?? model ?? null;
  const reasoningEffort = config.reasoningEffort ?? null;
  let requestOptions = config.requestOptions ?? null;
  if (requestOptions === null && config.completionSettings && resolvedModel) {
    const options = buildCompletionOptions(OPTIMIZED_MODEL_REQUEST_OPTIONS, { ...config.completionSettings, model: resolvedModel, reasoningEffort });
    requestOptions = Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'response_format'));
  }
  return {
    model: resolvedModel,
    modelSource: config.modelSource ?? null,
    reasoningEffort,
    reasoningEffortSource: config.reasoningEffortSource ?? null,
    requestOptions,
  };
}

/**
 * The product configuration block: { schemaScope: { requested, effective,
 * fullSchemaEstimatedTokens, fullSchemaMaxTokens, widenOnDemand,
 * inScopeTableCount }, hintsVersion, model, modelSource, reasoningEffort,
 * reasoningEffortSource, requestOptions } for `schemaScope` (a scope name or
 * config), `hintsVersion` (1 or 2; default 2) and `modelConfig` (see
 * describeModelProduct).
 */
export function describeProductConfig(schema, schemaScope = undefined, hintsVersion = undefined, modelConfig = null, model = null) {
  return {
    schemaScope: resolveEffectiveSchemaScope(schema, schemaScope),
    hintsVersion: normalizeHintsVersion(hintsVersion),
    ...describeModelProduct(modelConfig, model),
  };
}

/**
 * Provenance block of a report.
 * - fixtures: [{ name, database, status, contentHash, expectedContentHash }]
 * - datasets: [{ name, path }] (hashed here); controlsFiles: [paths]
 * - runner: the run's options (recorded verbatim)
 * - modelConfig: the model settings (see describeModelProduct)
 */
export async function collectProvenance({
  schema,
  schemaPath = null,
  fixtures = [],
  datasets = [],
  controlsFiles = [],
  model = null,
  modelConfig = null,
  env = process.env,
  runner = {},
  repoRoot = REPO_ROOT,
  semanticLayerPath = SEMANTIC_LAYER_PATH,
  semanticLayerOverlayPath = SEMANTIC_LAYER_OVERLAY_PATH,
  gitState = null,
  schemaScope = undefined,
  hintsVersion = undefined,
} = {}) {
  const git = gitState || (await resolveGitState(repoRoot));
  const datasetEntries = [];
  for (const dataset of datasets) {
    datasetEntries.push({ name: dataset.name, path: repoRelative(dataset.path, repoRoot), sha256: await hashFile(dataset.path) });
  }
  const controlsEntries = [];
  for (const file of controlsFiles) {
    controlsEntries.push({ path: repoRelative(file, repoRoot), sha256: await hashFile(file) });
  }
  // The semantic layer the run read: the base file, plus the hints-v2
  // overlay under version 2 (both hashes together, so the version changes
  // when either file does; version 1 keeps the plain file hash of older
  // reports).
  const version = normalizeHintsVersion(hintsVersion);
  const baseLayerHash = await hashFile(semanticLayerPath);
  const overlay = version === 1 ? null : { path: repoRelative(semanticLayerOverlayPath, repoRoot), sha256: await hashFile(semanticLayerOverlayPath) };
  const semanticLayerVersion = overlay ? sha256Hex(stableStringify({ base: baseLayerHash, overlay: overlay.sha256 })) : baseLayerHash;
  const fixtureEntries = fixtures.map((fixture) => ({
    name: fixture.name,
    database: fixture.database,
    status: fixture.status ?? null,
    contentHash: fixture.contentHash ?? null,
    expectedContentHash: fixture.expectedContentHash ?? null,
  }));
  return {
    git,
    promptVersion: computePromptVersion(schema, { schemaScope, hintsVersion }),
    product: describeProductConfig(schema, schemaScope, hintsVersion, modelConfig, model),
    semanticLayerVersion,
    semanticLayerOverlay: overlay,
    schemaVersion: computeSchemaVersion(schema),
    schemaPath: repoRelative(schemaPath, repoRoot),
    fixturesVersion: sha256Hex(stableStringify(fixtureEntries.map((fixture) => [fixture.name, fixture.expectedContentHash]))),
    fixtures: fixtureEntries,
    datasets: datasetEntries,
    controls: controlsEntries,
    model,
    llmEndpoint: describeLlmEndpoint(env),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runner,
  };
}

/**
 * The short form stamped on every trace line (createTraceLogger metadata). The
 * scope keys are flat strings/numbers and never `schemaScope`: prompt.built and
 * prompt.widened carry a `schemaScope` object in their payload, which would
 * override a metadata key of that name on those lines.
 */
export function traceMetadataFromProvenance(provenance) {
  return {
    promptVersion: shortHash(provenance?.promptVersion),
    semanticLayerVersion: shortHash(provenance?.semanticLayerVersion),
    dbProfileVersion: shortHash(provenance?.fixturesVersion),
    gitSha: provenance?.git?.sha || null,
    gitDirty: provenance?.git?.dirty ?? null,
    schemaScopeRequested: provenance?.product?.schemaScope?.requested ?? null,
    schemaScopeEffective: provenance?.product?.schemaScope?.effective ?? null,
    schemaFullEstimatedTokens: provenance?.product?.schemaScope?.fullSchemaEstimatedTokens ?? null,
    schemaWidenOnDemand: provenance?.product?.schemaScope?.widenOnDemand ?? null,
    hintsVersion: provenance?.product?.hintsVersion ?? null,
    reasoningEffort: provenance?.product?.reasoningEffort ?? null,
  };
}
