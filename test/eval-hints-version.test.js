import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateQuestion } from '../scripts/evaluate.js';
import { rescoreHintsVersionNote } from '../scripts/eval.js';
import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { createValidatorProbe } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';

// npm run eval, its rescore and verification follow HINTS_VERSION
// (src/hints-version.js) like they follow SCHEMA_SCOPE: the live run passes it
// to the product loop, the validator probe builds its semantic plan with it,
// and a rescore of a recording made with another version says so.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);

test('the rescore console note fires only when the recorded hints version differs (unrecorded = 1)', () => {
  assert.equal(rescoreHintsVersionNote(null, 1), null);
  assert.equal(rescoreHintsVersionNote(1, 1), null);
  assert.equal(rescoreHintsVersionNote(2, 2), null);
  assert.match(
    rescoreHintsVersionNote(null, 2),
    /note: the recording ran with hints version not recorded \(before HINTS_VERSION: 1\); today's validator uses 2 \(default\), so recorded SQL is re-judged with today's semantic plan \(the prompts are not regenerated: only validator and semantic-plan effects show\)\./
  );
  assert.match(rescoreHintsVersionNote(2, 1), /recording ran with hints version 2 \(default\); today's validator uses 1,/);
});

test('the validator probe builds its prompt context with the configured hints version (default 2)', async () => {
  const question = 'Show the top customers by total net sales amount in March 2026.';
  const byDefault = createValidatorProbe({ schema });
  const v1 = createValidatorProbe({ schema, hintsVersion: 1 });
  assert.equal(byDefault.hintsVersion, 2);
  assert.equal(v1.hintsVersion, 1);
  assert.equal((await byDefault.promptFor(question)).context.hintsVersion, 2);
  assert.equal((await byDefault.promptFor(question)).context.semanticPlan.hintsVersion, 2);
  assert.equal((await v1.promptFor(question)).context.hintsVersion, 1);
  assert.equal((await v1.promptFor(question)).context.semanticPlan.hintsVersion, undefined);
  assert.throws(() => createValidatorProbe({ schema, hintsVersion: 7 }), { code: 'INVALID_CONFIG' });
});

test('evaluateQuestion passes the hints version to the product loop only when it is given', async () => {
  const testCase = normalizeBenchmarkCase({
    id: 'hints_case',
    question: 'How many active customers do we have?',
    expected_sql: 'SELECT COUNT(*) AS active_customer_count FROM Customer WHERE IsActive = 1',
  });
  const connection = { query: async () => [[{ active_customer_count: 7 }], []] };
  const seen = [];
  const runQuestion = async (args) => {
    seen.push(Object.hasOwn(args, 'hintsVersion') ? args.hintsVersion : 'absent');
    return { success: false, error: new Error('stub'), errorStage: 'llm', errorCode: null, llmCalls: [], promptTables: [], rankedTables: [], sql: '' };
  };
  const trace = { enabled: false, emit: async () => {} };
  const base = { schema, model: 'gpt-4o-mini', testCase, caseIndex: 1, connection, trace, dependencies: { runQuestion } };
  await evaluateQuestion({ ...base, hintsVersion: 1 });
  await evaluateQuestion(base);
  assert.deepEqual(seen, [1, 'absent']);
});
