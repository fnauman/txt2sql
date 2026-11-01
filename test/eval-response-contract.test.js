import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { evaluateQuestion } from '../scripts/evaluate.js';
import { formatProgress } from '../scripts/eval.js';
import { classifyRepetition, summarizeCaseRepetitions } from '../src/eval/attribution.js';
import { compactReport } from '../src/eval/compact-report.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { rescoreReportCases, rescoreRepetition } from '../src/eval/rescore.js';

const trace = { emit: async () => {} };
const noQuery = { query: async () => assert.fail('a failed behavior response must not execute SQL') };
const makeCase = expected_behavior => normalizeBenchmarkCase({
  id: `protocol_${expected_behavior}`, question: 'Show entries', expected_behavior,
});
const emptyReply = JSON.stringify({ sql: '', explanation: 'No SQL.', tables_used: [], assumptions: [] });
const clientFor = finish_reason => ({ chat: { completions: { create: async request => {
  assert.ok(request.response_format.json_schema.schema.required.includes('decision'));
  return { model: request.model, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{ finish_reason, message: { content: finish_reason === 'stop' ? emptyReply : '' } }] };
} } } });

for (const expected of ['clarify', 'abstain']) {
  for (const [finishReason, code] of [['content_filter', 'LLM_REFUSED'], ['stop', 'EMPTY_SQL']]) {
    test(`live v2 ${expected}: ${code} is a counted failure, including compact/rescore round trip`, async () => {
      const testCase = makeCase(expected);
      const repetition = await evaluateQuestion({ client: clientFor(finishReason), connection: noQuery,
        schema: { tables: [] }, model: 'gpt-4o-mini', testCase, trace, maxRetries: 0 });
      assert.equal(repetition.responseContractVersion, 2);
      assert.equal(repetition.error_code, code);
      const judged = classifyRepetition(repetition, testCase);
      assert.equal(judged.outcome, 'llm_error');
      assert.equal(judged.bucket, 'model');
      assert.equal(judged.behavior_counted, true);
      assert.equal(summarizeCaseRepetitions([judged]).behavior.majorityHandled, false);

      const report = { provenance: { product: { responseContractVersion: 2 } },
        results: [{ ...testCase, repetitions: [repetition] }] };
      const compact = compactReport(report);
      assert.equal(compact.results[0].repetitions[0].responseContractVersion, 2);
      const [rescored] = await rescoreReportCases(compact, { connections: [], goldCache: createGoldCache() });
      assert.equal(rescored.repetitions[0].responseContractVersion, 2);
      assert.equal(classifyRepetition(rescored.repetitions[0], testCase).outcome, 'llm_error');
    });
  }
}

test('missing repetition version inherits original protocol, while unversioned legacy declines stay v1', async () => {
  const testCase = makeCase('clarify');
  const repetition = { status: 'llm_error', error_code: 'LLM_REFUSED', generated_sql: '', attempts: [] };
  const contexts = [
    [{ provenance: { product: { responseContractVersion: 2 } } }, 2, 'llm_error'],
    [{}, 1, 'declined'],
    [{ mode: 'rescore', provenance: { product: { responseContractVersion: 2 } }, rescoredFrom: { responseContractVersion: 1 } }, 1, 'declined'],
  ];
  for (const [metadata, version, outcome] of contexts) {
    const source = { ...metadata, results: [{ ...testCase, repetitions: [repetition] }] };
    for (const report of [source, compactReport(source)]) {
      const [rescored] = await rescoreReportCases(report, { connections: [], goldCache: createGoldCache() });
      const current = rescored.repetitions[0];
      assert.equal(current.responseContractVersion, version);
      assert.equal(classifyRepetition(current, testCase).outcome, outcome);
      const again = compactReport({ mode: 'rescore', provenance: { product: { responseContractVersion: 2 } },
        results: [{ ...testCase, repetitions: [current] }] });
      assert.equal(again.results[0].repetitions[0].responseContractVersion, version);
    }
  }
});

test('progress labels matching typed decisions ok and mismatches or current refusals FAIL', () => {
  for (const [expected, status, label, outcome] of [
    ['clarify', 'clarify', 'ok  ', 'clarified'],
    ['abstain', 'abstain', 'ok  ', 'abstained'],
    ['clarify', 'abstain', 'FAIL', 'wrong_behavior'],
    ['abstain', 'clarify', 'FAIL', 'wrong_behavior'],
    ['clarify', 'llm_error', 'FAIL', 'llm_error'],
  ]) {
    const testCase = makeCase(expected);
    const result = { status, responseContractVersion: 2, generated_sql: '', attempts: [],
      ...(status === 'llm_error' ? { error_code: 'LLM_REFUSED' } : {}) };
    const line = formatProgress({ testCase, result, repetition: 1, completed: 1, total: 1, repeat: 1 });
    assert.ok(line.startsWith(`[1/1] ${label} ${testCase.id}: ${outcome} (expects ${expected})`), line);
  }
});


test('direct rescore stamps an unversioned historical decline as v1 before a later compact report', async () => {
  const testCase = makeCase('clarify');
  const source = { status: 'llm_error', error_code: 'LLM_REFUSED', attempts: [], generated_sql: '' };
  const rescored = await rescoreRepetition(source, { testCase });
  assert.equal(rescored.responseContractVersion, 1);
  const compact = compactReport({ mode: 'rescore', provenance: { product: { responseContractVersion: 2 } },
    results: [{ ...testCase, repetitions: [rescored] }] });
  assert.equal(compact.results[0].repetitions[0].responseContractVersion, 1);
  assert.equal(classifyRepetition(compact.results[0].repetitions[0], testCase).outcome, 'declined');
});
