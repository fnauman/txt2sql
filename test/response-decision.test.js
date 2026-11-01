import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { runOptimizedQuestion } from '../src/query-service.js';
import { responseDecision } from '../src/response-decision.js';
import { compactReport } from '../src/eval/compact-report.js';
import { rescoreRepetition } from '../src/eval/rescore.js';
import { evaluateQuestion } from '../scripts/evaluate.js';
import { attributeRepetition, summarizeCaseRepetitions } from '../src/eval/attribution.js';

const schema = { tables: [{ name: 'Entry', tableName: 'Entry', columns: [
  { name: 'Id', type: 'INTEGER', primaryKey: true, allowNull: false, references: null, comment: null },
], foreignKeys: [], ignoredForeignKeys: [] }] };
const reply = decision => ({ decision, sql: '', explanation: 'A business definition is needed.',
  tables_used: [], assumptions: [], clarification_questions: decision === 'clarify' ? ['Which date basis should apply?'] : [] });
function clientFor(payload) {
  const requests = [];
  return { requests, chat: { completions: { create: async request => {
    requests.push(request);
    return { model: request.model, usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] };
  } } } };
}

for (const decision of ['clarify', 'abstain']) {
  test(`${decision} completes in one call without executing SQL and retains cost/usage`, async () => {
    let queries = 0;
    const client = clientFor(reply(decision));
    const result = await runOptimizedQuestion({ client, schema, question: 'Show entries', model: 'gpt-4o-mini',
      connection: { query: async () => { queries++; throw new Error('Must not execute a non-answer'); } } });
    assert.equal(result.success, true);
    assert.equal(result.decision, decision);
    assert.equal(result.sql, '');
    assert.deepEqual(result.rows, []);
    assert.equal(queries, 0);
    assert.equal(client.requests.length, 1);
    assert.equal(result.llmUsage.total_tokens, 60);
    assert.ok(result.llmCost.totalCost > 0);
    assert.match(client.requests[0].messages[0].content, /do not guess that business meaning/);
    const format = client.requests[0].response_format.json_schema.schema;
    assert.deepEqual(format.properties.decision.enum, ['answer', 'clarify', 'abstain']);
    assert.ok(format.required.includes('clarification_questions'));
  });

  test(`${decision} passes through the real product/evaluation path without SQL or oracle execution`, async () => {
    const testCase = normalizeBenchmarkCase({ id: `decision_${decision}`, question: 'Show entries', expected_behavior: decision });
    const result = await evaluateQuestion({ client: clientFor(reply(decision)), model: 'gpt-4o-mini', schema, testCase, trace: { emit: async () => {} },
      connection: { query: async () => { throw new Error('No SQL for a behavior case'); } },
      dependencies: { scorePrediction: async () => { throw new Error('Must not score a non-answer as SQL'); } } });
    assert.equal(result.status, decision);
    assert.equal(result.generated_sql, '');
    const attributed = attributeRepetition(result, testCase);
    assert.equal(attributed.behavior_counted, true);
    assert.equal(attributed.counted, false);
    assert.equal(attributed.outcome, decision === 'clarify' ? 'clarified' : 'abstained');
    assert.equal(summarizeCaseRepetitions([attributed]).behavior.majorityHandled, true);
  });
}

test('wrong decision types fail behavior scoring and nonanswers count against answer accuracy', () => {
  assert.equal(attributeRepetition({ status: 'abstain', generated_sql: '' }, { expected_behavior: 'clarify' }).outcome, 'wrong_behavior');
  const answer = attributeRepetition({ status: 'clarify', generated_sql: '' }, { expected_behavior: 'answer' });
  assert.equal(answer.outcome, 'declined_answer');
  assert.equal(answer.counted, true);
});

test('inconsistent decisions never become executable SQL or a successful refusal', async () => {
  const malformed = [
    reply('answer'),
    { ...reply('answer'), sql: 'SELECT Id FROM Entry', clarification_questions: null },
    { ...reply('abstain'), clarification_questions: null },
    { ...reply('clarify'), sql: 'SELECT Id FROM Entry' },
    { ...reply('clarify'), clarification_questions: [] },
    { ...reply('abstain'), explanation: 42 },
    { ...reply('abstain'), tables_used: ['Entry'] },
    { ...reply('answer'), clarification_questions: ['Which entries?'] },
    { ...reply('clarify'), decision: null },
    { ...reply('clarify'), decision: 'execute' },
  ];
  for (const payload of malformed) {
    assert.throws(() => responseDecision(payload), error => error.code === 'LLM_INVALID_DECISION');
    const client = clientFor(payload);
    const result = await runOptimizedQuestion({ client, schema, model: 'gpt-4o-mini', question: 'Show entries', maxRetries: 0,
      connection: { query: async () => { throw new Error('Invalid decision must not execute'); } } });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'LLM_INVALID_DECISION');
    assert.equal(result.llmUsage.total_tokens, 60);
  }
});

test('null clarification questions trigger a corrective retry without executing SQL', async () => {
  const invalid = clientFor({ ...reply('abstain'), clarification_questions: null });
  const corrected = clientFor(reply('abstain'));
  let calls = 0;
  const client = { chat: { completions: { create: async request =>
    (++calls === 1 ? invalid : corrected).chat.completions.create(request),
  } } };
  const result = await runOptimizedQuestion({ client, schema, model: 'gpt-4o-mini', question: 'Show entries', maxRetries: 1,
    connection: { query: async () => { throw new Error('A non-answer must not execute SQL'); } } });
  assert.equal(result.success, true);
  assert.equal(result.decision, 'abstain');
  assert.equal(result.attemptCount, 2);
  assert.equal(calls, 2);
  assert.equal(result.llmUsage.total_tokens, 120);
  assert.match(corrected.requests[0].messages.at(-1).content, /inconsistent response decision/);
});

test('supported and legacy answer responses still go through SQL safety and execution', async () => {
  for (const explicit of [true, false]) {
    const payload = { sql: 'SELECT Id FROM Entry', explanation: 'Entries.', tables_used: ['Entry'], assumptions: [] };
    if (explicit) Object.assign(payload, { decision: 'answer', clarification_questions: [] });
    let queries = 0;
    const result = await runOptimizedQuestion({ client: clientFor(payload), schema, model: 'gpt-4o-mini', question: 'Show entries',
      connection: { query: async sql => { assert.match(sql, /SELECT Id FROM Entry$/); queries++; return [[{ Id: 1 }]]; } } });
    assert.equal(result.success, true);
    assert.equal(queries, 1);
    assert.deepEqual(result.rows, [{ Id: 1 }]);
  }
});


test('compact recordings retain clarification content and rescore does not invent a new response', async () => {
  const testCase = normalizeBenchmarkCase({ id: 'typed_clarification', question: 'Show entries', expected_behavior: 'clarify' });
  const repetition = { status: 'clarify', decision: 'clarify', generated_sql: '',
    clarification_questions: ['Which date basis should apply?'],
    attempts: [{ attempt: 1, generatedSql: '', llm: { ok: true, decision: 'clarify',
      clarificationQuestions: ['Which date basis should apply?'] }, validation: null, execution: null }] };
  const compact = compactReport({ results: [{ ...testCase, repetitions: [repetition] }] });
  const recorded = compact.results[0].repetitions[0];
  assert.equal(recorded.decision, 'clarify');
  assert.deepEqual(recorded.clarification_questions, repetition.clarification_questions);
  assert.deepEqual(recorded.attempts[0].llm.clarificationQuestions, repetition.clarification_questions);
  const replayed = await rescoreRepetition(recorded, { testCase });
  assert.equal(replayed.status, 'clarify');
  assert.deepEqual(replayed.clarification_questions, repetition.clarification_questions);
  assert.equal(attributeRepetition(replayed, testCase).outcome, 'clarified');
});


test('rescore replays earlier SQL before inheriting a later clarification on an answer case', async () => {
  const testCase = normalizeBenchmarkCase({ id: 'earlier_answer', question: 'Show entries', expected_sql: 'SELECT Id FROM Entry' });
  const repetition = { status: 'clarify', decision: 'clarify', generated_sql: '',
    clarification_questions: ['Which entries?'], attempts: [
      { attempt: 1, generatedSql: 'SELECT Id FROM Entry', llm: { ok: true, decision: 'answer' } },
      { attempt: 2, generatedSql: '', llm: { ok: true, decision: 'clarify', clarificationQuestions: ['Which entries?'] } },
    ] };
  for (const accepted of [true, false]) {
    const validate = async () => accepted ? null : { code: 'UNKNOWN_COLUMN', layer: 'guardrail', message: 'Still rejected' };
    validate.promptFor = async () => ({ allowedTables: ['Entry'], context: {} });
    const replayed = await rescoreRepetition(repetition, { testCase, schema, validate,
      score: async () => ({ match: true, perFixture: [{ actualRowCount: 1 }], signalWarnings: [], disallowedWarnings: [] }) });
    assert.equal(replayed.status, accepted ? 'pass' : 'clarify');
    assert.equal(replayed.decision, accepted ? 'answer' : 'clarify');
    assert.equal(replayed.generated_sql, accepted ? 'SELECT Id FROM Entry' : '');
    assert.equal(replayed.rescore.replayedAttemptCount, accepted ? 1 : 2);
  }
});
