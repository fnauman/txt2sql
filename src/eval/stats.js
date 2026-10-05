// Statistics for evaluation reports. The unit is the CASE, not the attempt:
// repetitions of one case at temperature 0 are strongly correlated (the audit
// saw 16 of 17 edge cases at 0% or 100% across repeats), so pooling them as
// independent trials (the old pooled Wilson bound) overstates confidence.
//
// - strict accuracy = mean over cases of the per-case pass rate (passes /
//   counted repetitions), with a 95% CI from a deterministic case bootstrap;
// - Wilson 95% interval on the number of cases whose majority of repetitions
//   passed;
// - intent-clustered accuracy: the mean over intents of the intent's mean
//   case pass rate (paraphrases of one intent are not independent evidence),
//   with a cluster (intent) bootstrap CI;
// - exact two-sided McNemar test and a paired bootstrap CI for comparisons.
//
// Every resampling uses the seeded mulberry32 PRNG (src/eval/prng.js), so the
// same inputs always give the same intervals.

import { createPrng } from './prng.js';

export const BOOTSTRAP_SEED = 20261005;
export const BOOTSTRAP_RESAMPLES = 10_000;
const Z_95 = 1.959963984540054;

export function round(value, digits = 4) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

export function mean(values) {
  if (!values || values.length === 0) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/**
 * Percentile with linear interpolation between closest ranks (the common
 * "type 7" definition). `p` is in [0, 1]. Returns null for no values.
 */
export function percentile(values, p) {
  const sorted = [...(values || [])].filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Wilson score interval for `successes` out of `n` (95% by default). */
export function wilsonInterval(successes, n, z = Z_95) {
  if (!Number.isFinite(n) || n <= 0) {
    return { lower: null, upper: null };
  }
  const phat = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return {
    lower: round(Math.max(0, (center - margin) / denominator)),
    upper: round(Math.min(1, (center + margin) / denominator)),
  };
}

/**
 * Percentile bootstrap: resamples `items` with replacement `resamples` times
 * and returns the (alpha/2, 1 - alpha/2) quantiles of `statistic(sample)`.
 * Deterministic for a given seed. `items` may be anything the statistic
 * understands (numbers, pairs, clusters).
 */
export function bootstrapInterval(items, statistic, { resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED, alpha = 0.05 } = {}) {
  const list = items || [];
  if (list.length === 0) {
    return { lower: null, upper: null, resamples, seed };
  }
  const prng = createPrng(seed);
  const estimates = new Array(resamples);
  const sample = new Array(list.length);
  for (let draw = 0; draw < resamples; draw += 1) {
    for (let index = 0; index < list.length; index += 1) {
      sample[index] = list[Math.floor(prng.next() * list.length)];
    }
    estimates[draw] = statistic(sample);
  }
  return {
    lower: round(percentile(estimates, alpha / 2)),
    upper: round(percentile(estimates, 1 - alpha / 2)),
    resamples,
    seed,
  };
}

/** Case bootstrap CI of a mean (e.g. of per-case pass rates). */
export function bootstrapMeanInterval(values, options = {}) {
  return bootstrapInterval(values, mean, options);
}

/**
 * Cluster bootstrap: `clusters` is an array of arrays of values; the statistic
 * is the mean over clusters of each cluster's mean (every intent weighs the
 * same however many paraphrases it has). Clusters are resampled whole.
 */
export function clusterBootstrapInterval(clusters, options = {}) {
  const clusterMeans = (clusters || []).filter((cluster) => cluster.length > 0).map((cluster) => mean(cluster));
  return bootstrapInterval(clusterMeans, mean, options);
}

/**
 * Paired bootstrap CI of mean(candidate - baseline) over aligned cases:
 * `pairs` = [{ baseline, candidate }] of per-case scores.
 */
export function pairedBootstrapDeltaInterval(pairs, options = {}) {
  const deltas = (pairs || []).map((pair) => pair.candidate - pair.baseline);
  return bootstrapInterval(deltas, mean, options);
}

/**
 * Exact two-sided McNemar test on the discordant pairs: `regressions` (b,
 * baseline right / candidate wrong) and `improvements` (c). Under H0 the
 * discordant pairs are Binomial(b + c, 1/2), so
 * p = min(1, 2 * P(X <= min(b, c))). Computed in log space, so any n works.
 * With no discordant pair p = 1.
 */
export function mcnemarExact(regressions, improvements) {
  const b = Math.max(0, Math.trunc(regressions || 0));
  const c = Math.max(0, Math.trunc(improvements || 0));
  const n = b + c;
  if (n === 0) {
    return 1;
  }
  const k = Math.min(b, c);
  let logPmf = n * Math.log(0.5);
  let tail = Math.exp(logPmf);
  for (let i = 0; i < k; i += 1) {
    logPmf += Math.log(n - i) - Math.log(i + 1);
    tail += Math.exp(logPmf);
  }
  // 12 significant digits drop the log/exp round-off (2 * 0.5 = 1, not 0.9999...).
  return Math.min(1, Number((2 * tail).toPrecision(12)));
}

function costOf(repetition) {
  const total = repetition?.llm_cost?.totalCost;
  return Number.isFinite(total) ? total : null;
}

function groupBy(records, keysOf) {
  const groups = new Map();
  for (const record of records) {
    for (const key of keysOf(record)) {
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(record);
    }
  }
  return groups;
}

function breakdown(records, keysOf) {
  return [...groupBy(records, keysOf).entries()]
    .map(([key, group]) => ({
      key,
      cases: group.length,
      accuracy: round(mean(group.map((record) => record.summary.passRate))),
      majorityPasses: group.filter((record) => record.summary.majorityPass).length,
    }))
    .sort((left, right) => String(left.key).localeCompare(String(right.key)));
}

// Repetitions that actually asked the model (skipped and gold-error
// repetitions made no call; a cancelled one only if it got that far).
function isExecuted(repetition) {
  if (repetition.status === 'cancelled') {
    return (repetition.attempts || []).length > 0;
  }
  return !['skipped_budget', 'expected_sql_error', 'evaluation_error'].includes(repetition.status);
}

/**
 * Headline statistics over case records ({ id, intentId, tags, difficulty,
 * failure_class, repetitions[], summary }) as built by the runner
 * (summary from summarizeCaseRepetitions in attribution.js).
 */
export function summarizeRunStatistics(caseRecords, { resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED } = {}) {
  const records = caseRecords || [];
  // Abstain / clarify cases never count in accuracy (their repetitions are
  // never `counted`); cost, latency, retries and tokens below cover them too.
  const behaviorRecords = new Set(records.filter((record) => record.expected_behavior && record.expected_behavior !== 'answer'));
  const counted = records.filter((record) => record.summary?.counted > 0);
  const passRates = counted.map((record) => record.summary.passRate);
  const majorityPasses = counted.filter((record) => record.summary.majorityPass).length;
  const repeat = records.reduce((max, record) => Math.max(max, record.repetitions?.length || 0), 0);

  const intents = groupBy(counted, (record) => [record.intentId || record.id]);
  const perIntent = [...intents.entries()]
    .map(([intentId, group]) => ({
      intentId,
      cases: group.length,
      accuracy: round(mean(group.map((record) => record.summary.passRate))),
    }))
    .sort((left, right) => left.intentId.localeCompare(right.intentId));

  const repetitions = records.flatMap((record) => record.repetitions || []);
  const executed = repetitions.filter(isExecuted);
  const passing = repetitions.filter((repetition) => repetition.outcome === 'pass');
  const knownCosts = executed.map(costOf).filter((value) => value !== null);
  const totalCost = knownCosts.reduce((sum, value) => sum + value, 0);
  // A question whose LLM calls used tokens but got no price (an unknown
  // model) understates the total; one that completed no LLM call at all (a
  // timeout or outage before the answer) simply cost nothing.
  const withoutPrice = executed.filter((repetition) => repetition.llm_usage && costOf(repetition) === null).length;
  const withoutLlmCall = executed.filter((repetition) => !repetition.llm_usage && costOf(repetition) === null).length;
  // Product-loop wall time per question (older reports only have the case
  // total, which also includes the gold runs and the oracle).
  const questionMs = (repetition) => repetition.timings?.questionMs ?? repetition.timings?.totalMs;
  const caseMs = (repetition) => repetition.timings?.totalMs;
  const llmCalls = executed.flatMap((repetition) => (repetition.attempts || []).filter((attempt) => attempt.llm));
  const tokens = { prompt: 0, cached: 0, completion: 0, total: 0 };
  for (const repetition of executed) {
    const usage = repetition.llm_usage;
    if (!usage) {
      continue;
    }
    tokens.prompt += usage.prompt_tokens || 0;
    tokens.completion += usage.completion_tokens || 0;
    tokens.total += usage.total_tokens || 0;
    tokens.cached += usage.prompt_tokens_details?.cached_tokens || 0;
  }

  const excluded = {};
  for (const repetition of records.filter((record) => !behaviorRecords.has(record)).flatMap((record) => record.repetitions || []).filter((entry) => !entry.counted)) {
    excluded[repetition.outcome] = (excluded[repetition.outcome] || 0) + 1;
  }

  return {
    unit: 'case',
    repeat,
    cases: {
      selected: records.length,
      counted: counted.length,
      excluded: records.length - behaviorRecords.size - counted.length,
      behavior: behaviorRecords.size,
      intents: intents.size,
    },
    repetitions: {
      total: repetitions.length,
      counted: repetitions.filter((repetition) => repetition.counted).length,
      excludedByOutcome: excluded,
    },
    strictAccuracy: {
      value: round(mean(passRates)),
      n: counted.length,
      definition: 'mean over counted cases of the per-case pass rate across repetitions',
      ci95: { method: 'case bootstrap (percentile)', ...bootstrapMeanInterval(passRates, { resamples, seed }) },
    },
    majority: {
      passes: majorityPasses,
      n: counted.length,
      rate: counted.length ? round(majorityPasses / counted.length) : null,
      definition: 'cases where more than half of the counted repetitions passed',
      wilson95: wilsonInterval(majorityPasses, counted.length),
    },
    intentClustered: {
      value: round(mean(perIntent.map((entry) => entry.accuracy))),
      intents: perIntent.length,
      ci95: {
        method: 'intent cluster bootstrap (percentile)',
        ...clusterBootstrapInterval(
          [...intents.values()].map((group) => group.map((record) => record.summary.passRate)),
          { resamples, seed }
        ),
      },
      perIntent,
    },
    bySplit: breakdown(counted, (record) => [record.split || 'dev']),
    byFailureClass: breakdown(counted, (record) => [record.failure_class || '(none)']),
    byTag: breakdown(counted, (record) => (record.tags?.length ? record.tags : ['(none)'])),
    byDifficulty: breakdown(counted, (record) => [record.difficulty || '(none)']),
    cost: {
      currency: 'USD',
      total: round(totalCost, 6),
      questions: executed.length,
      perQuestion: executed.length ? round(totalCost / executed.length, 6) : null,
      correct: passing.length,
      perCorrect: passing.length ? round(totalCost / passing.length, 6) : null,
      questionsWithoutCost: withoutPrice,
      questionsWithoutLlmCall: withoutLlmCall,
    },
    latency: {
      questionWallMs: {
        definition: 'the product loop (master data, prompt, LLM, validation, execution, retries) per question',
        n: executed.filter((repetition) => Number.isFinite(questionMs(repetition))).length,
        p50: round(percentile(executed.map(questionMs), 0.5), 1),
        p95: round(percentile(executed.map(questionMs), 0.95), 1),
      },
      caseWallMs: {
        definition: 'per question including the harness: gold runs and scoring on every fixture',
        n: executed.filter((repetition) => Number.isFinite(caseMs(repetition))).length,
        p50: round(percentile(executed.map(caseMs), 0.5), 1),
        p95: round(percentile(executed.map(caseMs), 0.95), 1),
      },
      llmCallMs: {
        n: llmCalls.filter((attempt) => Number.isFinite(attempt.llm.durationMs)).length,
        p50: round(percentile(llmCalls.map((attempt) => attempt.llm.durationMs), 0.5), 1),
        p95: round(percentile(llmCalls.map((attempt) => attempt.llm.durationMs), 0.95), 1),
      },
    },
    retries: {
      questions: executed.length,
      questionsWithRetry: executed.filter((repetition) => (repetition.attempt_count || 0) > 1).length,
      rate: executed.length ? round(executed.filter((repetition) => (repetition.attempt_count || 0) > 1).length / executed.length) : null,
      llmCalls: llmCalls.length,
      retryCalls: llmCalls.filter((attempt) => attempt.retry).length,
    },
    tokens,
  };
}

// --- Legacy pooled reliability ----------------------------------------------
// Kept for report consumers that read `reliability` (scripts/evaluate.js
// re-exports both functions). It pools every repetition as if independent;
// the headline statistics above treat the case as the unit instead.

// Lower bound of the Wilson score interval for a binomial proportion. Reported
// alongside raw pass-rate so a small, noisy sample is not mistaken for proof of
// reliability (e.g. 6/6 has a 95% lower bound near 0.6, not 1.0).
export function wilsonLowerBound(passes, attempts, z = 1.96) {
  if (attempts <= 0) {
    return 0;
  }

  const phat = passes / attempts;
  const z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const center = phat + z2 / (2 * attempts);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * attempts)) / attempts);
  return Number(Math.max(0, (center - margin) / denominator).toFixed(4));
}

export function summarizeReliability(perRepetition, repeat) {
  const accuracies = perRepetition.map((entry) => entry.accuracy);
  const perCase = new Map();

  for (const entry of perRepetition) {
    for (const caseResult of entry.results) {
      const current = perCase.get(caseResult.id) || {
        id: caseResult.id,
        intentId: caseResult.intentId,
        question: caseResult.question,
        attempts: 0,
        passes: 0,
        statuses: {},
      };
      current.attempts += 1;
      if (caseResult.status === 'pass') {
        current.passes += 1;
      }
      current.statuses[caseResult.status] = (current.statuses[caseResult.status] || 0) + 1;
      perCase.set(caseResult.id, current);
    }
  }

  const totalAttempts = perRepetition.reduce((sum, entry) => sum + entry.total, 0);
  const totalPasses = perRepetition.reduce((sum, entry) => sum + entry.passed, 0);
  const fullPassReps = perRepetition.filter((entry) => entry.total > 0 && entry.passed === entry.total).length;

  return {
    repeat,
    perRepetition: perRepetition.map((entry) => ({
      repetition: entry.repetition,
      total: entry.total,
      passed: entry.passed,
      failed: entry.failed,
      accuracy: entry.accuracy,
      statusCounts: entry.statusCounts,
    })),
    meanAccuracy: accuracies.length ? Number((accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length).toFixed(4)) : 0,
    minAccuracy: accuracies.length ? Math.min(...accuracies) : 0,
    maxAccuracy: accuracies.length ? Math.max(...accuracies) : 0,
    allCasesPassedRate: perRepetition.length ? Number((fullPassReps / perRepetition.length).toFixed(4)) : 0,
    totalAttempts,
    totalPasses,
    passRate: totalAttempts ? Number((totalPasses / totalAttempts).toFixed(4)) : 0,
    wilsonLower95: wilsonLowerBound(totalPasses, totalAttempts),
    method: 'pooled Wilson over every repetition (legacy)',
    note:
      'Repetitions of one case are correlated, so this pooled bound overstates confidence. ' +
      'Use stats.strictAccuracy (case bootstrap) and stats.majority (Wilson over cases) instead.',
    perCase: [...perCase.values()].map((entry) => ({
      ...entry,
      passRate: entry.attempts ? Number((entry.passes / entry.attempts).toFixed(4)) : 0,
    })),
  };
}
