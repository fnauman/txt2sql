import test from 'node:test';
import assert from 'node:assert/strict';
import { perturbRequest, summarizeRobustness } from '../src/eval/prompt-robustness.js';
const prefix = 'In-scope schema:\nTable A\nColumns:\nid\n\nTable B\nColumns:\nname';
const suffix = '\n\nQuestion-specific context:\n\nQuestion:\nShow total sales.\n\nResolved temporal references:\n2026\n';
const native = { messages: [{ role: 'system', content: 'Fixed rules' }, { role: 'user', content: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }, { type: 'text', text: suffix }] }] };
test('schema reordering preserves every intact table and native cache block metadata', () => {
  const out = perturbRequest(native, 'schema_order');
  assert.equal(out.messages[0], native.messages[0]);
  assert.equal(out.messages[1].content[1].text, suffix);
  assert.deepEqual(out.messages[1].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(out.messages[1].content[0].text, 'In-scope schema:\nTable B\nColumns:\nname\n\nTable A\nColumns:\nid');
  assert.equal(native.messages[1].content[0].text, prefix);
});
test('question changes preserve hints and leave replayed assistant messages intact', () => {
  const assistant = { role: 'assistant', content: 'answer', reasoning_details: [{ signed: true }] };
  const req = { messages: [...native.messages, assistant] };
  const out = perturbRequest(req, 'polite');
  assert.equal(out.messages[2], assistant);
  assert.equal(out.messages[1].content[0].text, prefix);
  assert.match(out.messages[1].content[1].text, /Please answer this question: Show total sales\./);
  assert.match(out.messages[1].content[1].text, /Resolved temporal references:\n2026/);
  assert.match(perturbRequest(req, 'whitespace').messages[1].content[1].text, /Show  total  sales\./);
});
test('correctness sensitivity separates unchanged stochastic flips, tweak losses, improvements, and outages', () => {
  const result = state => state === null ? { outcome: 'llm_outage', counted: false, bucket: 'infra' } : { outcome: state ? 'pass' : 'wrong_result', counted: true, bucket: state ? 'pass' : 'model' };
  const rows = [[true, true, false, true, true], [false, false, true, false, false], [true, false, true, true, true], [true, true, true, null, true]].map((states, i) => ({ id: String(i), repetitions: states.map(result) }));
  const s = summarizeRobustness(rows);
  assert.equal(s.completeCases, 3);
  assert.equal(s.unchangedRepeatFlips, 1);
  assert.equal(s.allFiveWrong, 0);
  assert.equal(s.lostUnderAnyTweak, 1);
  assert.equal(s.baselineCorrectCases, 2);
  assert.equal(s.stableBaselineCorrectCases, 1);
  assert.equal(s.stableBaselineLostUnderAnyTweak, 1);
  assert.equal(s.byVariant[2].losses, 1);
  assert.equal(s.byVariant[2].improvements, 1);
  assert.equal(s.byVariant[3].valid, 3);
});
