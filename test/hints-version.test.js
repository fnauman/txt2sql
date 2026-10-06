import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import {
  DEFAULT_HINTS_VERSION,
  describeHintsVersion,
  HINTS_VERSIONS,
  normalizeHintsVersion,
  resolveHintsVersion,
} from '../src/hints-version.js';
import { buildOptimizedPrompt, buildSemanticPlan } from '../src/pipeline.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// HINTS_VERSION (src/hints-version.js) switches the prompt's knowledge layer
// between version 1 (every prompt and semantic plan before the switch existed)
// and version 2 ("hints v2", docs/experiments/02-hints-v2.md). Version 1 must
// reproduce the base branch byte for byte, so the A/B changes one thing.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
const V1 = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/hints-v1-prompts.json'), 'utf8'));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('resolveHintsVersion: 2 by default, 1 or 2 accepted, anything else is a configuration error', () => {
  assert.deepEqual(HINTS_VERSIONS, [1, 2]);
  assert.equal(DEFAULT_HINTS_VERSION, 2);
  assert.equal(resolveHintsVersion({}), 2);
  assert.equal(resolveHintsVersion({ HINTS_VERSION: '  ' }), 2, 'blank counts as unset');
  assert.equal(resolveHintsVersion({ HINTS_VERSION: '1' }), 1);
  assert.equal(resolveHintsVersion({ HINTS_VERSION: ' 2 ' }), 2);
  for (const raw of ['3', '0', 'v2', '1.0', 'two', '-1']) {
    assert.throws(
      () => resolveHintsVersion({ HINTS_VERSION: raw }),
      (error) => error.code === 'INVALID_CONFIG' && error.message === `HINTS_VERSION must be one of 1, 2; got "${raw}".`
    );
  }
  assert.equal(normalizeHintsVersion(undefined), 2);
  assert.equal(normalizeHintsVersion(null), 2);
  assert.equal(normalizeHintsVersion(1), 1);
  assert.equal(normalizeHintsVersion('2'), 2);
  assert.throws(() => normalizeHintsVersion(3), { code: 'INVALID_CONFIG' });
  assert.throws(() => normalizeHintsVersion({ hintsVersion: 1 }), { code: 'INVALID_CONFIG' });
  assert.equal(describeHintsVersion(2), '2 (default)');
  assert.equal(describeHintsVersion(1), '1');
  assert.equal(describeHintsVersion(null), 'not recorded (before HINTS_VERSION: 1)');
});

// test/fixtures/hints-v1-prompts.json was written by the base branch
// (exp/schema-scope) before HINTS_VERSION existed: 20 questions chosen to cover
// every hints-v2 change (temporal phrases, posting dates, brands, money words,
// counts, totals, ledger metrics), in both schema scopes.
test('HINTS_VERSION=1 reproduces the base branch prompts and semantic plans byte for byte (20 questions, both scopes)', () => {
  assert.equal(V1.prompts.length, 20);
  for (const expected of V1.prompts) {
    const plan = buildSemanticPlan(expected.question, { hintsVersion: 1 });
    assert.deepEqual(plan, expected.semanticPlan, expected.question);
    assert.equal(JSON.stringify(plan), JSON.stringify(expected.semanticPlan), `${expected.question}: key order too`);

    const full = buildOptimizedPrompt(schema, expected.question, { semanticPlan: plan, schemaScope: 'full', hintsVersion: 1 });
    assert.equal(full.system, V1.full.system, expected.question);
    assert.equal(sha256(full.user), expected.full.userSha256, expected.question);
    assert.equal(full.user.slice(full.user.indexOf('Question-specific context:')), expected.full.questionContext, expected.question);
    assert.deepEqual(full.tables.map((table) => table.tableName), expected.full.allowedTables);
    assert.equal(full.context.hintsVersion, 1);

    const retrieved = buildOptimizedPrompt(schema, expected.question, { semanticPlan: plan, schemaScope: 'retrieved', hintsVersion: 1 });
    assert.equal(sha256(retrieved.system), V1.retrieved.systemSha256, expected.question);
    assert.equal(sha256(retrieved.user), expected.retrieved.userSha256, expected.question);
    assert.deepEqual(retrieved.tables.map((table) => table.tableName), expected.retrieved.allowedTables);

    // An unmarked (version-1) plan builds a version-1 prompt without the option.
    assert.equal(buildOptimizedPrompt(schema, expected.question, { semanticPlan: plan, schemaScope: 'full' }).user, full.user);
  }
});

test('a version-2 plan is marked and builds a version-2 prompt; mixing versions is refused', () => {
  const question = 'Show the top customers by total net sales amount in March 2026.';
  const v2 = buildSemanticPlan(question);
  assert.equal(v2.hintsVersion, 2);
  assert.equal(buildSemanticPlan(question, { hintsVersion: 1 }).hintsVersion, undefined);
  assert.equal(buildOptimizedPrompt(schema, question, { semanticPlan: v2 }).context.hintsVersion, 2);
  assert.equal(buildOptimizedPrompt(schema, question).context.hintsVersion, 2, 'the default');
  assert.equal(buildOptimizedPrompt(schema, question, { hintsVersion: 1 }).context.hintsVersion, 1);
  assert.throws(
    () => buildOptimizedPrompt(schema, question, { semanticPlan: v2, hintsVersion: 1 }),
    /The semantic plan was built with hints version 2, the prompt asks for 1\./
  );
  assert.throws(() => buildSemanticPlan(question, { hintsVersion: 3 }), { code: 'INVALID_CONFIG' });
});
