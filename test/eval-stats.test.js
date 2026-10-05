import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootstrapMeanInterval,
  clusterBootstrapInterval,
  mcnemarExact,
  pairedBootstrapDeltaInterval,
  percentile,
  summarizeRunStatistics,
  wilsonInterval,
  wilsonLowerBound,
} from '../src/eval/stats.js';

test('exact McNemar matches hand-computed binomial tails', () => {
  // p = min(1, 2 * P(X <= min(b, c))), X ~ Binomial(b + c, 1/2).
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  assert.equal(mcnemarExact(0, 0), 1);
  close(mcnemarExact(0, 6), 2 / 64); // 0.03125: six unanimous flips are significant
  close(mcnemarExact(0, 5), 2 / 32); // 0.0625: five are not
  close(mcnemarExact(6, 0), 2 / 64); // symmetric
  close(mcnemarExact(1, 5), 14 / 64); // (1 + 6) / 64 * 2
  close(mcnemarExact(2, 8), 112 / 1024); // (1 + 10 + 45) / 1024 * 2
  assert.equal(mcnemarExact(3, 3), 1);
  assert.equal(mcnemarExact(4, 5), 1);
  // Large n stays finite (log-space).
  const large = mcnemarExact(400, 600);
  assert.ok(large > 0 && large < 1e-9, `got ${large}`);
});

test('Wilson interval reproduces the audit per-case bound and agrees with the legacy lower bound', () => {
  const interval = wilsonInterval(12, 17);
  assert.equal(interval.lower, 0.4687); // the review's "per-case LB for 12/17: 0.469"
  assert.equal(interval.upper, 0.8672);
  assert.ok(Math.abs(wilsonLowerBound(12, 17) - interval.lower) < 1e-3);
  assert.deepEqual(wilsonInterval(0, 0), { lower: null, upper: null });
  assert.equal(wilsonInterval(5, 5).upper, 1);
  assert.equal(wilsonInterval(0, 5).lower, 0);
});

test('percentile interpolates between closest ranks', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5, 1, 3], 0), 1);
  assert.equal(percentile([5, 1, 3], 1), 5);
  assert.ok(Math.abs(percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95) - 95) < 1e-9);
});

test('case bootstrap is deterministic for a seed and brackets the mean', () => {
  const values = [1, 1, 1, 0, 1, 0.5, 1, 0, 1, 1, 1, 0.6667];
  const first = bootstrapMeanInterval(values, { resamples: 2000, seed: 7 });
  const again = bootstrapMeanInterval(values, { resamples: 2000, seed: 7 });
  const other = bootstrapMeanInterval(values, { resamples: 2000, seed: 8 });
  assert.deepEqual(first, again);
  assert.equal(other.seed, 8);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(first.lower < mean && mean < first.upper, JSON.stringify(first));
  assert.ok(other.lower < mean && mean < other.upper, JSON.stringify(other));
  assert.ok(first.upper <= 1 && first.lower >= 0);
  // All-equal data has a degenerate interval.
  const flat = bootstrapMeanInterval([1, 1, 1], { resamples: 100 });
  assert.equal(flat.lower, 1);
  assert.equal(flat.upper, 1);
  assert.deepEqual(bootstrapMeanInterval([], { resamples: 100 }).lower, null);
});

test('cluster bootstrap weighs every cluster equally and paired bootstrap centres on the delta', () => {
  const unbalanced = clusterBootstrapInterval([[1, 1, 1, 1, 1, 1], [0]], { resamples: 2000, seed: 3 });
  // Cluster means are 1 and 0: the interval spans both, whatever the cluster sizes.
  assert.equal(unbalanced.lower, 0);
  assert.equal(unbalanced.upper, 1);

  const pairs = [
    { baseline: 1, candidate: 1 },
    { baseline: 1, candidate: 0 },
    { baseline: 0, candidate: 0 },
    { baseline: 1, candidate: 1 },
  ];
  const delta = pairedBootstrapDeltaInterval(pairs, { resamples: 2000, seed: 1 });
  assert.ok(delta.lower <= -0.25 && delta.upper >= -0.25 && delta.upper <= 0, JSON.stringify(delta));
  assert.deepEqual(delta, pairedBootstrapDeltaInterval(pairs, { resamples: 2000, seed: 1 }));
});

function record(id, intentId, outcomes, extra = {}) {
  const repetitions = outcomes.map((outcome, index) => ({
    repetition: index + 1,
    status: outcome === 'pass' ? 'pass' : outcome === 'skipped_budget' ? 'skipped_budget' : 'result_mismatch',
    outcome,
    counted: outcome !== 'skipped_budget' && outcome !== 'infra_error',
    attempt_count: extra.retry ? 2 : 1,
    attempts: [{ attempt: 1, retry: false, llm: { ok: true, durationMs: 1000 } }, ...(extra.retry ? [{ attempt: 2, retry: true, llm: { ok: true, durationMs: 3000 } }] : [])],
    llm_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } },
    llm_cost: outcome === 'skipped_budget' ? null : { totalCost: 0.001 },
    timings: { totalMs: extra.ms ?? 2000 },
  }));
  const counted = repetitions.filter((repetition) => repetition.counted);
  const passes = counted.filter((repetition) => repetition.outcome === 'pass').length;
  return {
    id,
    intentId,
    tags: extra.tags || [],
    difficulty: extra.difficulty || null,
    failure_class: extra.failureClass || null,
    repetitions,
    summary: {
      counted: counted.length,
      passes,
      passRate: counted.length ? passes / counted.length : null,
      majorityPass: counted.length ? passes * 2 > counted.length : null,
    },
  };
}

test('run statistics treat the case as the unit and cluster by intent', () => {
  const records = [
    record('a1', 'intent_a', ['pass', 'pass', 'pass'], { tags: ['x'], difficulty: 'easy' }),
    record('a2', 'intent_a', ['pass', 'pass', 'wrong_result'], { tags: ['x', 'y'], difficulty: 'easy' }),
    record('b1', 'intent_b', ['wrong_result', 'wrong_result', 'wrong_result'], { failureClass: 'grain_confusion', retry: true, ms: 5000 }),
    record('c1', 'intent_c', ['skipped_budget', 'skipped_budget', 'skipped_budget']),
  ];
  const stats = summarizeRunStatistics(records, { resamples: 1000 });
  assert.equal(stats.unit, 'case');
  assert.equal(stats.repeat, 3);
  assert.deepEqual(stats.cases, { selected: 4, counted: 3, excluded: 1, intents: 2 });
  // Mean of per-case pass rates (1, 2/3, 0), not pooled passes / attempts.
  assert.equal(stats.strictAccuracy.value, Number(((1 + 2 / 3 + 0) / 3).toFixed(4)));
  assert.equal(stats.strictAccuracy.n, 3);
  assert.equal(stats.strictAccuracy.ci95.resamples, 1000);
  assert.equal(stats.majority.passes, 2);
  assert.equal(stats.majority.n, 3);
  // Intent-clustered: mean of intent means ((1 + 2/3) / 2 and 0).
  assert.equal(stats.intentClustered.value, Number((((1 + 2 / 3) / 2 + 0) / 2).toFixed(4)));
  assert.equal(stats.intentClustered.intents, 2);
  assert.deepEqual(stats.byFailureClass.map((entry) => [entry.key, entry.cases]), [['(none)', 2], ['grain_confusion', 1]]);
  assert.deepEqual(stats.byTag.map((entry) => entry.key), ['(none)', 'x', 'y']);
  assert.deepEqual(stats.byDifficulty.map((entry) => [entry.key, entry.accuracy]), [['(none)', 0], ['easy', 0.8333]]);
  // 9 executed repetitions at $0.001, 5 correct.
  assert.equal(stats.cost.questions, 9);
  assert.equal(stats.cost.total, 0.009);
  assert.equal(stats.cost.perQuestion, 0.001);
  assert.equal(stats.cost.correct, 5);
  assert.equal(stats.cost.perCorrect, 0.0018);
  assert.equal(stats.retries.questionsWithRetry, 3);
  assert.equal(stats.retries.llmCalls, 12);
  assert.equal(stats.retries.retryCalls, 3);
  assert.equal(stats.latency.questionWallMs.p50, 2000);
  assert.equal(stats.latency.llmCallMs.p95, 3000);
  assert.deepEqual(stats.tokens, { prompt: 900, cached: 360, completion: 90, total: 990 });
  assert.deepEqual(stats.repetitions.excludedByOutcome, { skipped_budget: 3 });
  // Deterministic.
  assert.deepEqual(stats, summarizeRunStatistics(records, { resamples: 1000 }));
});

test('run statistics with nothing counted report nulls, not zeros', () => {
  const stats = summarizeRunStatistics([record('c1', 'intent_c', ['skipped_budget'])], { resamples: 100 });
  assert.equal(stats.strictAccuracy.value, null);
  assert.equal(stats.strictAccuracy.ci95.lower, null);
  assert.equal(stats.majority.rate, null);
  assert.equal(stats.cost.perQuestion, null);
});

test('cost: only questions that used tokens without a price are "without a price"; latency is the product loop', () => {
  const rep = (status, outcome, extra = {}) => ({ status, outcome, counted: true, attempts: [], attempt_count: 1, ...extra });
  const records = [
    {
      id: 'a',
      intentId: 'a',
      summary: { counted: 3, passes: 1, passRate: 1 / 3, majorityPass: false },
      repetitions: [
        // priced, with product-loop and case wall times
        rep('pass', 'pass', { llm_usage: { prompt_tokens: 10 }, llm_cost: { totalCost: 0.001 }, timings: { questionMs: 1000, totalMs: 4000 } }),
        // a deadline before any LLM answer: no usage, no cost
        rep('aborted', 'timeout', { llm_usage: null, llm_cost: null, timed_out: true }),
        // an unknown model: tokens used, no price
        rep('result_mismatch', 'wrong_result', { llm_usage: { prompt_tokens: 10 }, llm_cost: null, timings: { questionMs: 3000, totalMs: 6000 } }),
      ],
    },
  ];
  const stats = summarizeRunStatistics(records, { resamples: 100 });
  assert.deepEqual([stats.cost.questions, stats.cost.questionsWithoutCost, stats.cost.questionsWithoutLlmCall], [3, 1, 1]);
  assert.deepEqual([stats.latency.questionWallMs.n, stats.latency.questionWallMs.p50], [2, 2000]);
  assert.deepEqual([stats.latency.caseWallMs.n, stats.latency.caseWallMs.p50], [2, 5000]);
  // An older report without questionMs falls back to the case total.
  const legacy = summarizeRunStatistics([{ ...records[0], repetitions: [rep('pass', 'pass', { timings: { totalMs: 2500 } })] }], { resamples: 100 });
  assert.equal(legacy.latency.questionWallMs.p50, 2500);
});
