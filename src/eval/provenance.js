// Run provenance: enough to say WHAT produced a number, so two reports are
// only compared when that is meaningful and a regression can be traced to a
// prompt, semantic-layer, fixture or dataset change.
//
// - git: HEAD sha and whether the working tree is dirty (uncommitted or
//   untracked files; ignored files such as generated/ do not count);
// - promptVersion: sha256 over the optimized system prompt (built by the real
//   builder, so it includes the business rules), the BUSINESS_RULES and
//   FEW_SHOT_EXAMPLES constants and the model request options;
// - semanticLayerVersion: sha256 of metadata/semantic-layer.json;
// - schemaVersion: sha256 of the compiled schema the prompts were built from;
// - fixtures: expected and actual content hashes per fixture database;
// - datasets and controls: sha256 of every file read;
// - model, the OpenAI-compatible endpoint HOST only (never a key, path or
//   query), Node version and the runner flags;
// - product: the product configuration that shapes the prompt and the
//   validator: the schema scope (requested and effective, the full-schema
//   token estimate and budget, widen-on-demand). Reports from before
//   SCHEMA_SCOPE existed have no `product` block; they ran the retrieved scope
//   without widening.
// Paths are stored relative to the repository root.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BUSINESS_RULES, FEW_SHOT_EXAMPLES } from '../constants.js';
import { OPTIMIZED_MODEL_REQUEST_OPTIONS, buildOptimizedPrompt, resolveEffectiveSchemaScope } from '../pipeline.js';

const execFileAsync = promisify(execFile);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SEMANTIC_LAYER_PATH = path.resolve(REPO_ROOT, 'metadata/semantic-layer.json');

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
 * as the product builds it under `parts.schemaScope` (default: the product
 * default), the business rules, the few-shot pool and the request options.
 * `parts` lets tests vary one input. The retrieved scope's system prompt is
 * the one every run had before schema scopes existed, so its version matches
 * older reports.
 */
export function computePromptVersion(schema, parts = {}) {
  const systemPrompt = parts.systemPrompt ?? buildOptimizedPrompt(schema, 'Prompt version probe', { schemaScope: parts.schemaScope }).system;
  const material = {
    systemPrompt,
    businessRules: parts.businessRules ?? BUSINESS_RULES,
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
 * The product configuration block: { schemaScope: { requested, effective,
 * fullSchemaEstimatedTokens, fullSchemaMaxTokens, widenOnDemand,
 * inScopeTableCount } } for `schemaScope` (a scope name or config).
 */
export function describeProductConfig(schema, schemaScope = undefined) {
  return { schemaScope: resolveEffectiveSchemaScope(schema, schemaScope) };
}

/**
 * Provenance block of a report.
 * - fixtures: [{ name, database, status, contentHash, expectedContentHash }]
 * - datasets: [{ name, path }] (hashed here); controlsFiles: [paths]
 * - runner: the run's options (recorded verbatim)
 */
export async function collectProvenance({
  schema,
  schemaPath = null,
  fixtures = [],
  datasets = [],
  controlsFiles = [],
  model = null,
  env = process.env,
  runner = {},
  repoRoot = REPO_ROOT,
  semanticLayerPath = SEMANTIC_LAYER_PATH,
  gitState = null,
  schemaScope = undefined,
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
  const fixtureEntries = fixtures.map((fixture) => ({
    name: fixture.name,
    database: fixture.database,
    status: fixture.status ?? null,
    contentHash: fixture.contentHash ?? null,
    expectedContentHash: fixture.expectedContentHash ?? null,
  }));
  return {
    git,
    promptVersion: computePromptVersion(schema, { schemaScope }),
    product: describeProductConfig(schema, schemaScope),
    semanticLayerVersion: await hashFile(semanticLayerPath),
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

/** The short form stamped on every trace line (createTraceLogger metadata). */
export function traceMetadataFromProvenance(provenance) {
  return {
    promptVersion: shortHash(provenance?.promptVersion),
    semanticLayerVersion: shortHash(provenance?.semanticLayerVersion),
    dbProfileVersion: shortHash(provenance?.fixturesVersion),
    gitSha: provenance?.git?.sha || null,
    gitDirty: provenance?.git?.dirty ?? null,
    schemaScope: provenance?.product?.schemaScope?.requested ?? null,
    schemaScopeEffective: provenance?.product?.schemaScope?.effective ?? null,
    schemaFullEstimatedTokens: provenance?.product?.schemaScope?.fullSchemaEstimatedTokens ?? null,
    schemaWidenOnDemand: provenance?.product?.schemaScope?.widenOnDemand ?? null,
  };
}
