import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOptimizedPrompt, buildSemanticPlan, loadNarrowSchema, validateReadOnlySql } from '../src/pipeline.js';

// The guardrails as a classifier over real model output: 96 gpt-4o-mini
// generations from the audit's paid benchmark run (edge + paraphrase suites,
// 3 repetitions). Labels:
// - 'accept': 84 correct or guardrail-irrelevant generations, including the 20
//   the old metric guardrail falsely rejected (each re-executed on the seeded
//   demo DB and confirmed to return the gold result; see `reason`).
// - 'reject': 9 fan-out errors (header SalesDocument.NetAmount summed across a
//   SalesDocumentLine join, which the old guardrails let through) and 3 joins on
//   SalesDocument.CampaignId = Product.CampaignId (not a relationship).
// Every generation is validated in its own question's real prompt context.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'live-generations.json'), 'utf8'));
const schema = await loadNarrowSchema({
  modelsDir: path.join(REPO_ROOT, 'models'),
  schemaPath: path.join(REPO_ROOT, 'generated', 'schema.json'),
});

const promptCache = new Map();
function buildRealPrompt(question) {
  if (!promptCache.has(question)) {
    const prompt = buildOptimizedPrompt(schema, question, {
      masterDataCandidates: [],
      semanticPlan: buildSemanticPlan(question),
    });
    promptCache.set(question, { promptContext: prompt.context, allowedTables: prompt.tables.map((table) => table.tableName) });
  }
  return promptCache.get(question);
}

test('fixture shape: 96 labelled generations with questions', () => {
  assert.equal(FIXTURE.length, 96);
  assert.equal(FIXTURE.filter((entry) => entry.expected === 'accept').length, 84);
  assert.equal(FIXTURE.filter((entry) => entry.expectedCode === 'FAN_OUT').length, 9);
  assert.equal(FIXTURE.filter((entry) => entry.expectedCode === 'JOIN_PATH').length, 3);
  for (const entry of FIXTURE) {
    assert.ok(entry.question && entry.sql && entry.reason, `${entry.caseId} is incomplete`);
  }
});

FIXTURE.forEach((entry, index) => {
  const label = `#${index} ${entry.caseId} attempt ${entry.attempt}${entry.liveRejection ? ' (live-rejected)' : ''}`;

  if (entry.expected === 'accept') {
    test(`accepts ${label}`, () => {
      const { promptContext, allowedTables } = buildRealPrompt(entry.question);
      assert.doesNotThrow(() => validateReadOnlySql(entry.sql, allowedTables, { promptContext }), entry.reason);
    });
    return;
  }

  test(`rejects ${label} with ${entry.expectedCode}`, () => {
    const { promptContext, allowedTables } = buildRealPrompt(entry.question);
    assert.throws(
      () => validateReadOnlySql(entry.sql, allowedTables, { promptContext }),
      (error) => {
        assert.equal(error.code, entry.expectedCode, error.message);
        assert.equal(error.layer, 'guardrail');
        if (entry.expectedCode === 'FAN_OUT') {
          // The retry message must tell the model how to fix it.
          assert.match(error.message, /^Fan-out: SUM over SalesDocument\.NetAmount while joining SalesDocumentLine/);
          assert.match(error.message, /Use SalesDocumentLine\.NetAmount/);
        }
        return true;
      }
    );
  });
});
