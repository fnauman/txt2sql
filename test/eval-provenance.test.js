import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUSINESS_RULES, BUSINESS_RULES_V2, DEFAULT_INCLUDED_TABLES, FEW_SHOT_EXAMPLES } from '../src/constants.js';
import {
  collectProvenance,
  computePromptVersion,
  describeLlmEndpoint,
  repoRelative,
  resolveGitState,
  SEMANTIC_LAYER_OVERLAY_PATH,
  SEMANTIC_LAYER_PATH,
  stableStringify,
  traceMetadataFromProvenance,
} from '../src/eval/provenance.js';
import { buildOptimizedPrompt } from '../src/pipeline.js';
import { createBufferedTraceLogger } from '../src/query-service.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

test('promptVersion hashes the real system prompt, business rules, few-shots and request options', () => {
  const version = computePromptVersion(schema);
  assert.match(version, /^[0-9a-f]{64}$/);
  assert.equal(computePromptVersion(schema), version, 'stable across calls');
  // Built from the product's builder: passing the same parts explicitly gives the same hash.
  const system = buildOptimizedPrompt(schema, 'anything at all').system;
  assert.equal(computePromptVersion(schema, { systemPrompt: system, businessRules: BUSINESS_RULES_V2, fewShotExamples: FEW_SHOT_EXAMPLES }), version);
  // The hints version decides the system prompt and the business rules.
  const v1System = buildOptimizedPrompt(schema, 'anything at all', { hintsVersion: 1 }).system;
  assert.equal(
    computePromptVersion(schema, { hintsVersion: 1 }),
    computePromptVersion(schema, { systemPrompt: v1System, businessRules: BUSINESS_RULES, fewShotExamples: FEW_SHOT_EXAMPLES })
  );
  assert.notEqual(computePromptVersion(schema, { hintsVersion: 1 }), version);
  assert.equal(computePromptVersion(schema, { hintsVersion: 2 }), version, 'version 2 is the default');
  // Any one input changing changes the version.
  assert.notEqual(computePromptVersion(schema, { fewShotExamples: FEW_SHOT_EXAMPLES.slice(1) }), version);
  assert.notEqual(computePromptVersion(schema, { businessRules: [...BUSINESS_RULES, 'New rule.'] }), version);
  assert.notEqual(computePromptVersion(schema, { systemPrompt: `${system} ` }), version);
  assert.notEqual(computePromptVersion(schema, { requestOptions: { temperature: 0.2 } }), version);
});

test('stableStringify does not depend on key order', () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('the LLM endpoint is recorded as a host only', () => {
  assert.deepEqual(describeLlmEndpoint({}), { host: 'api.openai.com', source: 'default' });
  const described = describeLlmEndpoint({ OPENAI_BASE_URL: 'https://user:secret-token@gateway.example.com:8443/v1?api-key=sk-123', OPENAI_API_KEY: 'sk-live-abc' });
  assert.deepEqual(described, { host: 'gateway.example.com:8443', source: 'OPENAI_BASE_URL' });
  assert.equal(describeLlmEndpoint({ OPENAI_BASE_URL: 'not a url' }).host, null);
});

test('git state reports the sha and a dirty flag, and degrades to nulls without git', async () => {
  const calls = [];
  const fakeGit = (dirtyOutput) => async (command, args) => {
    calls.push(args.join(' '));
    return { stdout: args[0] === 'rev-parse' ? 'abc123\n' : dirtyOutput };
  };
  assert.deepEqual(await resolveGitState('/repo', { run: fakeGit('') }), { sha: 'abc123', dirty: false, changedFiles: 0 });
  assert.deepEqual(await resolveGitState('/repo', { run: fakeGit(' M src/a.js\n?? new.js\n') }), { sha: 'abc123', dirty: true, changedFiles: 2 });
  assert.deepEqual(calls.slice(0, 2), ['rev-parse HEAD', 'status --porcelain']);
  const noGit = async () => {
    throw new Error('git: not found');
  };
  assert.deepEqual(await resolveGitState('/repo', { run: noGit }), { sha: null, dirty: null, changedFiles: null });
});

test('collectProvenance hashes files, keeps repo-relative paths and never records credentials', async () => {
  const datasetPath = path.join(REPO_ROOT, 'datasets/core-public.json');
  const controlsPath = path.join(REPO_ROOT, 'datasets/controls/core-public.json');
  const provenance = await collectProvenance({
    schema,
    schemaPath: path.join(REPO_ROOT, 'generated/schema.json'),
    fixtures: [{ name: 'seed', database: 'demo_retail', status: 'current', contentHash: 'c'.repeat(64), expectedContentHash: 'c'.repeat(64) }],
    datasets: [{ name: 'core-public', path: datasetPath }],
    controlsFiles: [controlsPath],
    model: 'gpt-4o-mini',
    env: { OPENAI_API_KEY: 'sk-secret-key-value', OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1' },
    runner: { repeat: 3, concurrency: 4 },
    gitState: { sha: 'f00', dirty: true, changedFiles: 1 },
  });
  // Hints version 2 (the default) reads the base layer and its overlay.
  const baseHash = sha256(await fs.readFile(SEMANTIC_LAYER_PATH));
  const overlayHash = sha256(await fs.readFile(SEMANTIC_LAYER_OVERLAY_PATH));
  assert.deepEqual(provenance.semanticLayerOverlay, { path: 'metadata/semantic-layer.hints-v2.json', sha256: overlayHash });
  assert.equal(provenance.semanticLayerVersion, sha256(stableStringify({ base: baseHash, overlay: overlayHash })));
  // Version 1 keeps the plain file hash of the reports before HINTS_VERSION.
  const v1 = await collectProvenance({ schema, gitState: { sha: 'f00', dirty: false, changedFiles: 0 }, env: {}, hintsVersion: 1 });
  assert.equal(v1.semanticLayerVersion, baseHash);
  assert.equal(v1.semanticLayerOverlay, null);
  assert.deepEqual(provenance.datasets, [{ name: 'core-public', path: 'datasets/core-public.json', sha256: sha256(await fs.readFile(datasetPath)) }]);
  assert.deepEqual(provenance.controls, [{ path: 'datasets/controls/core-public.json', sha256: sha256(await fs.readFile(controlsPath)) }]);
  assert.equal(provenance.schemaPath, 'generated/schema.json');
  assert.equal(provenance.promptVersion, computePromptVersion(schema));
  assert.deepEqual(provenance.llmEndpoint, { host: '127.0.0.1:9999', source: 'OPENAI_BASE_URL' });
  assert.equal(provenance.node, process.version);
  assert.deepEqual(provenance.runner, { repeat: 3, concurrency: 4 });
  assert.doesNotMatch(JSON.stringify(provenance), /sk-secret-key-value/);
  assert.equal(repoRelative('/elsewhere/file.json'), '/elsewhere/file.json');

  const metadata = traceMetadataFromProvenance(provenance);
  assert.deepEqual(metadata, {
    promptVersion: provenance.promptVersion.slice(0, 12),
    semanticLayerVersion: provenance.semanticLayerVersion.slice(0, 12),
    dbProfileVersion: provenance.fixturesVersion.slice(0, 12),
    gitSha: 'f00',
    gitDirty: true,
    schemaScopeRequested: 'auto',
    schemaScopeEffective: 'full',
    schemaFullEstimatedTokens: provenance.product.schemaScope.fullSchemaEstimatedTokens,
    schemaWidenOnDemand: true,
    hintsVersion: 2,
  });
});

// Prompt version of the optimized prompt before SCHEMA_SCOPE existed (the
// retrieved scope without widen-on-demand), recorded by the first committed
// baseline (eval: commit the gpt-4o-mini baseline, 1aa30a3).
const PRE_SCOPE_PROMPT_VERSION = '0c314451d4b7a5f347f574d4cebc60e20b0f92a592a71b1dd6d4ca35fcb1f10f';

test('provenance records the product configuration (schema scope) and the prompt version it implies', async () => {
  const base = { schema, gitState: { sha: 'f00', dirty: false, changedFiles: 0 }, env: {} };
  const byDefault = await collectProvenance(base);
  assert.deepEqual(byDefault.product.schemaScope, {
    requested: 'auto',
    effective: 'full',
    fullSchemaEstimatedTokens: byDefault.product.schemaScope.fullSchemaEstimatedTokens,
    fullSchemaMaxTokens: 8000,
    widenOnDemand: true,
    inScopeTableCount: 13,
  });
  assert.ok(byDefault.product.schemaScope.fullSchemaEstimatedTokens > 1000);
  assert.equal(byDefault.promptVersion, computePromptVersion(schema, { schemaScope: 'full' }));

  assert.equal(byDefault.product.hintsVersion, 2);
  assert.equal(byDefault.promptVersion, computePromptVersion(schema, { schemaScope: 'full', hintsVersion: 2 }));

  const retrieved = await collectProvenance({ ...base, schemaScope: { schemaScope: 'retrieved', widenOnDemand: false }, hintsVersion: 1 });
  assert.equal(retrieved.product.schemaScope.effective, 'retrieved');
  assert.equal(retrieved.product.schemaScope.widenOnDemand, false);
  assert.equal(retrieved.product.hintsVersion, 1);
  // The retrieved scope's version-1 prompt is the pre-scope prompt, byte for
  // byte: the prompt version of the first committed baseline (before
  // SCHEMA_SCOPE). The full scope's system prompt differs.
  assert.equal(retrieved.promptVersion, PRE_SCOPE_PROMPT_VERSION);
  assert.notEqual(byDefault.promptVersion, retrieved.promptVersion);
  // The committed baseline was produced with the default schema scope and
  // hints version 1 (before HINTS_VERSION existed: not recorded).
  const fullV1 = await collectProvenance({ ...base, hintsVersion: 1 });
  const baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'eval/baselines/gpt-4o-mini.json'), 'utf8'));
  assert.equal(baseline.provenance.promptVersion, fullV1.promptVersion);
  assert.equal(baseline.provenance.product.schemaScope.requested, 'auto');
  assert.equal(baseline.provenance.product.schemaScope.effective, 'full');
  assert.equal(baseline.provenance.product.hintsVersion, undefined);
  assert.equal(traceMetadataFromProvenance(retrieved).schemaScopeEffective, 'retrieved');
  assert.equal(traceMetadataFromProvenance(retrieved).hintsVersion, 1);
  assert.equal(traceMetadataFromProvenance(baseline.provenance).hintsVersion, null);
});

test('trace metadata keeps one type per key: the run-level scope never collides with the prompt events\' schemaScope object', async () => {
  const provenance = await collectProvenance({ schema, gitState: { sha: 'f00', dirty: false, changedFiles: 0 }, env: {} });
  const trace = createBufferedTraceLogger({ metadata: traceMetadataFromProvenance(provenance) });
  await trace.emit('run.started', {});
  // The product loop's prompt.built payload carries the scope as an object.
  await trace.emit('prompt.built', { schemaScope: { requested: 'auto', effective: 'full' } });
  for (const line of trace.events) {
    assert.equal(line.schemaScopeRequested, 'auto', `${line.event} carries the requested scope as a string`);
    assert.equal(line.schemaScopeEffective, 'full');
  }
  assert.equal(trace.events.find((line) => line.event === 'run.started').schemaScope, undefined);
});
