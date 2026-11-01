import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEvalArgs } from '../scripts/eval.js';
import { resolveOraclePolicy } from '../src/eval/oracle-policy.js';
import { verifySuite } from '../src/eval/verify.js';
import { normalizeBenchmarkCase } from '../src/benchmark.js';

test('strict oracle policy uses the existing design tolerance for both independent control tiers', () => {
  const policy = resolveOraclePolicy();
  assert.equal(policy.name, 'strict');
  assert.equal(policy.minKillRate, 0.95);
  assert.equal(policy.minHeldoutKillRate, 0.95);
  assert.equal(policy.baselineEligible, true);
  for (const options of [{ minKillRate: 0.94 }, { minHeldoutKillRate: 0 }, { name: 'unknown' }, { minKillRate: NaN }]) {
    assert.throws(() => resolveOraclePolicy(options));
  }
});

test('historical regression is explicit, recorded, and cannot write even a custom baseline', () => {
  const options = parseEvalArgs(['--oracle-policy', 'regression'], { env: {} });
  assert.equal(options.minHeldoutKillRate, 0);
  assert.equal(options.oraclePolicy.baselineEligible, false);
  for (const flags of [['--oracle-policy', 'regression'], ['--skip-controls'], ['--skip-verify']]) {
    assert.throws(() => parseEvalArgs(['--write-baseline', '--baseline-file', '/tmp/custom-baseline.json', ...flags], { env: {} }), /strict oracle verification/);
  }
  assert.throws(() => parseEvalArgs(['--min-heldout-kill-rate', '0'], { env: {} }), /--oracle-policy regression/);
  assert.equal(parseEvalArgs(['--oracle-policy', 'regression', '--min-heldout-kill-rate', '0.7'], { env: {} }).minHeldoutKillRate, 0.7);
});

test('direct verification callers cannot certify missing controls or a diagnostic floor', async () => {
  const cases = ['covered', 'uncovered'].map(id => normalizeBenchmarkCase({ id, question: `${id}?`, expected_sql: 'SELECT 1' }));
  const verify = async testCase => ({ id: testCase.id, problems: [], notes: [], goldRowCounts: {}, controls: testCase.id === 'covered' ? {
    positive: [], negative: [false, true].map((heldout, index) => ({ id: `n${index}`, type: 'test', heldout, status: 'killed', killed: true, killedOn: ['seed'] })),
  } : null });
  const run = (selected, extra = {}) => verifySuite({ datasets: [{ name: 'test', cases: selected }], connections: [{ name: 'seed' }], verify, ...extra });
  assert.equal((await run(cases.slice(0, 1))).baselineEligible, true);
  const missing = await run(cases);
  assert.equal(missing.baselineEligible, false);
  assert.match(missing.gateFailures[0], /1\/2 answer case\(s\) lack verified negative-control coverage/);
  assert.equal((await run(cases.slice(0, 1), { minHeldoutKillRate: 0 })).baselineEligible, false);
  assert.equal((await run(cases.slice(0, 1), { checkControls: false })).baselineEligible, false);
  assert.equal((await run(cases.slice(0, 1), { requireCompleteControls: false })).baselineEligible, false);
});
