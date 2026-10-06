import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUSINESS_RULES, DEFAULT_INCLUDED_TABLES, FEW_SHOT_EXAMPLES } from '../src/constants.js';
import {
  collectProvenance,
  computePromptVersion,
  describeLlmEndpoint,
  repoRelative,
  resolveGitState,
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
  assert.equal(computePromptVersion(schema, { systemPrompt: system, businessRules: BUSINESS_RULES, fewShotExamples: FEW_SHOT_EXAMPLES }), version);
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
  assert.equal(provenance.semanticLayerVersion, sha256(await fs.readFile(SEMANTIC_LAYER_PATH)));
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
  });
});

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

  const retrieved = await collectProvenance({ ...base, schemaScope: { schemaScope: 'retrieved', widenOnDemand: false } });
  assert.equal(retrieved.product.schemaScope.effective, 'retrieved');
  assert.equal(retrieved.product.schemaScope.widenOnDemand, false);
  // The retrieved scope's prompt is the pre-scope prompt: same version as the
  // committed baseline; the full scope's system prompt differs.
  const baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'eval/baselines/gpt-4o-mini.json'), 'utf8'));
  assert.equal(retrieved.promptVersion, baseline.provenance.promptVersion);
  assert.notEqual(byDefault.promptVersion, retrieved.promptVersion);
  assert.equal(baseline.provenance.product, undefined, 'the baseline predates the product block');
  assert.equal(traceMetadataFromProvenance(retrieved).schemaScopeEffective, 'retrieved');
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
