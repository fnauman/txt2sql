// Paired baseline-vs-candidate comparison of two evaluation reports.
//
// Cases are aligned by id. A case is paired only when both reports counted it
// (see attribution.js), neither report's majority outcome for it is a
// deadline or infrastructure outcome (timeout, aborted: they are counted in
// accuracy, but a slow provider is not a model or system change, so they never
// feed the McNemar flips), and its gold is unchanged: a case whose gold
// fingerprint (or, when both reports record it, its scoring fingerprint: gold
// + alternatives + comparison spec) changed is listed and excluded, because
// its two verdicts answer different questions. Per paired case the verdict is
// the majority over repetitions; the flips (regressions / improvements) feed
// an exact two-sided McNemar test, and a paired case bootstrap gives a CI for
// the change in strict accuracy (mean per-case pass rate).
//
// Reports from before the runner rewrite (no results[i].summary) are read too:
// their per-case pass rate comes from reliability.perCase when present, else
// from the single recorded status.

import { isLlmUnavailableCode } from '../query-service.js';
import { OUTCOME_BUCKETS } from './attribution.js';
import { goldFingerprint } from './controls.js';
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, mcnemarExact, mean, pairedBootstrapDeltaInterval, round } from './stats.js';

const LEGACY_EXCLUDED = new Set(['infra_error', 'expected_sql_error', 'evaluation_error', 'skipped_budget']);

function isInfraOutcome(outcome) {
  return OUTCOME_BUCKETS[outcome] === 'infra';
}

function legacyCounted(result) {
  if (LEGACY_EXCLUDED.has(result.status)) {
    return false;
  }
  return !(result.status === 'llm_error' && isLlmUnavailableCode(result.error_code));
}

/**
 * Per-case view of a report: Map id -> { id, question, intentId,
 * goldFingerprint, scoringFingerprint, counted, passRate, majorityPass,
 * outcome }.
 */
export function caseOutcomesFromReport(report) {
  const outcomes = new Map();
  const legacyPerCase = new Map((report?.reliability?.perCase || []).map((entry) => [entry.id, entry]));
  for (const result of report?.results || []) {
    const fingerprint = result.gold_fingerprint || (result.expected_sql ? goldFingerprint(result.expected_sql) : null);
    let entry;
    if (result.summary) {
      entry = {
        counted: result.summary.counted > 0,
        passRate: result.summary.passRate,
        majorityPass: result.summary.majorityPass,
        outcome: result.summary.outcome,
      };
    } else {
      const perCase = legacyPerCase.get(result.id);
      const counted = legacyCounted(result);
      const passRate = perCase && perCase.attempts > 0 ? perCase.passes / perCase.attempts : result.status === 'pass' ? 1 : 0;
      entry = {
        counted,
        passRate: counted ? round(passRate) : null,
        majorityPass: counted ? (perCase && perCase.attempts > 0 ? perCase.passes * 2 > perCase.attempts : result.status === 'pass') : null,
        outcome: result.status,
      };
    }
    outcomes.set(result.id, {
      id: result.id,
      question: result.question,
      intentId: result.intentId || null,
      goldFingerprint: fingerprint,
      scoringFingerprint: result.scoring_fingerprint || null,
      ...entry,
    });
  }
  return outcomes;
}

function describeReport(report, label) {
  return {
    label: label || null,
    model: report?.model || null,
    generatedAt: report?.generatedAt || null,
    gitSha: report?.provenance?.git?.sha || report?.gitSha || null,
    gitDirty: report?.provenance?.git?.dirty ?? null,
    promptVersion: report?.provenance?.promptVersion || null,
    mode: report?.mode || 'run',
  };
}

/**
 * Compares a candidate report with a baseline report. Returns
 * { baseline, candidate, paired, excluded: { goldChanged, notCounted },
 *   newCases, removedCases, flips: { regressions, improvements },
 *   rateChanges, accuracy: { baseline, candidate, delta, deltaCi95 },
 *   majority: { baselinePasses, candidatePasses }, mcnemar: { b, c, p },
 *   verdict: 'worse' | 'better' | 'no_significant_difference' | 'no_paired_cases' }.
 */
export function compareReports(baselineReport, candidateReport, {
  baselineLabel = null,
  candidateLabel = null,
  alpha = 0.05,
  resamples = BOOTSTRAP_RESAMPLES,
  seed = BOOTSTRAP_SEED,
} = {}) {
  const baseline = caseOutcomesFromReport(baselineReport);
  const candidate = caseOutcomesFromReport(candidateReport);

  const paired = [];
  const goldChanged = [];
  const notCounted = [];
  for (const [id, cand] of candidate) {
    const base = baseline.get(id);
    if (!base) {
      continue;
    }
    const scoringChanged = Boolean(base.scoringFingerprint && cand.scoringFingerprint && base.scoringFingerprint !== cand.scoringFingerprint);
    if (base.goldFingerprint !== cand.goldFingerprint || scoringChanged) {
      goldChanged.push({
        id,
        reason: base.goldFingerprint !== cand.goldFingerprint ? 'gold SQL changed' : 'alternatives or comparison spec changed',
        baseline: base.goldFingerprint,
        candidate: cand.goldFingerprint,
      });
      continue;
    }
    if (!base.counted || !cand.counted || isInfraOutcome(base.outcome) || isInfraOutcome(cand.outcome)) {
      const label = (side) => (side.counted && !isInfraOutcome(side.outcome) ? 'counted' : side.outcome);
      notCounted.push({ id, baseline: label(base), candidate: label(cand) });
      continue;
    }
    paired.push({
      id,
      question: cand.question,
      intentId: cand.intentId,
      baseline: { passRate: base.passRate, majorityPass: base.majorityPass, outcome: base.outcome },
      candidate: { passRate: cand.passRate, majorityPass: cand.majorityPass, outcome: cand.outcome },
    });
  }
  paired.sort((left, right) => left.id.localeCompare(right.id));

  const regressions = paired.filter((entry) => entry.baseline.majorityPass && !entry.candidate.majorityPass);
  const improvements = paired.filter((entry) => !entry.baseline.majorityPass && entry.candidate.majorityPass);
  const rateChanges = paired.filter(
    (entry) => entry.baseline.majorityPass === entry.candidate.majorityPass && entry.baseline.passRate !== entry.candidate.passRate
  );
  const p = mcnemarExact(regressions.length, improvements.length);
  const baselineAccuracy = mean(paired.map((entry) => entry.baseline.passRate));
  const candidateAccuracy = mean(paired.map((entry) => entry.candidate.passRate));
  const deltaCi95 = pairedBootstrapDeltaInterval(
    paired.map((entry) => ({ baseline: entry.baseline.passRate, candidate: entry.candidate.passRate })),
    { resamples, seed }
  );

  let verdict = 'no_significant_difference';
  if (paired.length === 0) {
    verdict = 'no_paired_cases';
  } else if (p < alpha && regressions.length > improvements.length) {
    verdict = 'worse';
  } else if (p < alpha && improvements.length > regressions.length) {
    verdict = 'better';
  }

  const pick = (entry) => ({ id: entry.id, question: entry.question, baseline: entry.baseline, candidate: entry.candidate });
  return {
    baseline: describeReport(baselineReport, baselineLabel),
    candidate: describeReport(candidateReport, candidateLabel),
    alpha,
    paired: paired.length,
    pairedCases: paired.map(pick),
    excluded: { goldChanged, notCounted },
    newCases: [...candidate.keys()].filter((id) => !baseline.has(id)).sort(),
    removedCases: [...baseline.keys()].filter((id) => !candidate.has(id)).sort(),
    flips: { regressions: regressions.map(pick), improvements: improvements.map(pick) },
    rateChanges: rateChanges.map(pick),
    majority: {
      baselinePasses: paired.filter((entry) => entry.baseline.majorityPass).length,
      candidatePasses: paired.filter((entry) => entry.candidate.majorityPass).length,
    },
    accuracy: {
      baseline: round(baselineAccuracy),
      candidate: round(candidateAccuracy),
      delta: baselineAccuracy === null ? null : round(candidateAccuracy - baselineAccuracy),
      deltaCi95: { method: 'paired case bootstrap (percentile)', ...deltaCi95 },
    },
    mcnemar: { regressions: regressions.length, improvements: improvements.length, p: round(p, 6), test: 'exact two-sided (binomial on discordant pairs)' },
    verdict,
  };
}
