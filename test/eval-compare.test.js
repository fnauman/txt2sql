import assert from 'node:assert/strict';
import test from 'node:test';

import { caseOutcomesFromReport, compareReports } from '../src/eval/compare.js';
import { goldFingerprint } from '../src/eval/controls.js';

function caseResult(id, { passes, counted = 3, gold = `SELECT ${id}`, scoring = null, outcome = null } = {}) {
  return {
    id,
    question: `Question ${id}?`,
    expected_sql: gold,
    gold_fingerprint: goldFingerprint(gold),
    scoring_fingerprint: scoring,
    summary: {
      counted,
      passes,
      passRate: counted ? Number((passes / counted).toFixed(4)) : null,
      majorityPass: counted ? passes * 2 > counted : null,
      outcome: outcome || (counted === 0 ? 'infra_error' : passes * 2 > counted ? 'pass' : 'wrong_result'),
    },
  };
}

const report = (results, extra = {}) => ({ model: 'gpt-4o-mini', generatedAt: '2026-10-05T00:00:00.000Z', results, ...extra });

test('cases align by id; changed gold, uncounted, new and removed cases are listed, not paired', () => {
  const baseline = report([
    caseResult('a', { passes: 3 }),
    caseResult('b', { passes: 3 }),
    caseResult('c', { passes: 0 }),
    caseResult('d', { passes: 3, gold: 'SELECT old' }),
    caseResult('e', { passes: 3, scoring: 'aaaa' }),
    caseResult('f', { passes: 0, counted: 0 }),
    caseResult('gone', { passes: 3 }),
  ]);
  const candidate = report([
    caseResult('a', { passes: 3 }),
    caseResult('b', { passes: 1 }),
    caseResult('c', { passes: 2 }),
    caseResult('d', { passes: 3, gold: 'SELECT new' }),
    caseResult('e', { passes: 3, scoring: 'bbbb' }),
    caseResult('f', { passes: 3 }),
    caseResult('new', { passes: 3 }),
  ]);
  const comparison = compareReports(baseline, candidate, { resamples: 500 });
  assert.equal(comparison.paired, 3);
  assert.deepEqual(comparison.excluded.goldChanged.map((entry) => [entry.id, entry.reason]), [
    ['d', 'gold SQL changed'],
    ['e', 'alternatives or comparison spec changed'],
  ]);
  assert.deepEqual(comparison.excluded.notCounted.map((entry) => entry.id), ['f']);
  assert.deepEqual(comparison.newCases, ['new']);
  assert.deepEqual(comparison.removedCases, ['gone']);
  assert.deepEqual(comparison.flips.regressions.map((entry) => entry.id), ['b']);
  assert.deepEqual(comparison.flips.improvements.map((entry) => entry.id), ['c']);
  assert.deepEqual(comparison.mcnemar, { regressions: 1, improvements: 1, p: 1, test: 'exact two-sided (binomial on discordant pairs)' });
  assert.equal(comparison.verdict, 'no_significant_difference');
  // Mean per-case pass rate over the paired cases: (1 + 1 + 0) / 3 -> (1 + 1/3 + 2/3) / 3.
  assert.equal(comparison.accuracy.baseline, 0.6667);
  assert.equal(comparison.accuracy.candidate, 0.6667);
  assert.equal(comparison.accuracy.delta, 0);
});

test('six unanimous regressions are significantly worse; the delta CI is deterministic', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const baseline = report(ids.map((id) => caseResult(id, { passes: 3 })));
  const candidate = report(ids.map((id, index) => caseResult(id, { passes: index < 6 ? 0 : 3 })));
  const comparison = compareReports(baseline, candidate, { resamples: 1000 });
  assert.equal(comparison.mcnemar.regressions, 6);
  assert.equal(comparison.mcnemar.improvements, 0);
  assert.equal(comparison.mcnemar.p, 0.03125);
  assert.equal(comparison.verdict, 'worse');
  assert.equal(comparison.accuracy.delta, -0.75);
  assert.ok(comparison.accuracy.deltaCi95.upper < 0);
  assert.deepEqual(comparison, compareReports(baseline, candidate, { resamples: 1000 }));

  const five = compareReports(baseline, report(ids.map((id, index) => caseResult(id, { passes: index < 5 ? 0 : 3 }))), { resamples: 100 });
  assert.equal(five.mcnemar.p, 0.0625);
  assert.equal(five.verdict, 'no_significant_difference');

  const better = compareReports(candidate, baseline, { resamples: 100 });
  assert.equal(better.verdict, 'better');
});

test('pass-rate changes without a flip are reported separately', () => {
  const comparison = compareReports(report([caseResult('a', { passes: 3 })]), report([caseResult('a', { passes: 2 })]), { resamples: 100 });
  assert.equal(comparison.flips.regressions.length, 0);
  assert.deepEqual(comparison.rateChanges.map((entry) => [entry.id, entry.baseline.passRate, entry.candidate.passRate]), [['a', 1, 0.6667]]);
  assert.equal(compareReports(report([]), report([caseResult('a', { passes: 1 })])).verdict, 'no_paired_cases');
});

test('reports written before the runner rewrite are read from status and reliability.perCase', () => {
  const legacy = {
    model: 'gpt-4o-mini',
    gitSha: 'abc',
    results: [
      { id: 'a', question: 'qa', status: 'pass', expected_sql: 'SELECT a' },
      { id: 'b', question: 'qb', status: 'result_mismatch', expected_sql: 'SELECT b' },
      { id: 'c', question: 'qc', status: 'infra_error', expected_sql: 'SELECT c' },
      { id: 'd', question: 'qd', status: 'llm_error', error_code: 'HTTP_503', expected_sql: 'SELECT d' },
    ],
    reliability: { perCase: [{ id: 'a', attempts: 3, passes: 2 }, { id: 'b', attempts: 3, passes: 1 }] },
  };
  const outcomes = caseOutcomesFromReport(legacy);
  assert.deepEqual([outcomes.get('a').passRate, outcomes.get('a').majorityPass], [0.6667, true]);
  assert.deepEqual([outcomes.get('b').passRate, outcomes.get('b').majorityPass], [0.3333, false]);
  assert.equal(outcomes.get('c').counted, false);
  assert.equal(outcomes.get('d').counted, false);
  assert.equal(outcomes.get('a').goldFingerprint, goldFingerprint('SELECT a'));

  const candidate = report([caseResult('a', { passes: 3, gold: 'SELECT a' }), caseResult('b', { passes: 3, gold: 'SELECT b' })]);
  const comparison = compareReports(legacy, candidate, { resamples: 100 });
  assert.equal(comparison.paired, 2);
  assert.deepEqual(comparison.flips.improvements.map((entry) => entry.id), ['b']);
  assert.equal(comparison.baseline.gitSha, 'abc');
});
