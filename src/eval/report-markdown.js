// report.md: the human-readable view of report.json, readable in a terminal
// and rendered on GitHub (plain Markdown tables, no HTML).

import { describeHintsVersion, sameHintsVersion } from '../hints-version.js';
import { describeSchemaScope, sameSchemaScopeBehaviour } from '../schema-scope.js';
import { BUCKET_ORDER, EXCLUDED_OUTCOMES, OUTCOME_BUCKETS, OUTCOME_ORDER, summarizeAttribution, summarizeBehavior } from './attribution.js';
import { summarizePairs } from './compare.js';
import { hiddenHoldoutNote, holdoutRecordIds } from './holdout.js';
import { legacySummary } from './runner.js';
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, summarizeAccuracy, summarizeBreakdowns, summarizeRunUsage } from './stats.js';

// Holdout display policy (src/eval/holdout.js): unless `revealHoldout` is
// set, report.md and the console show holdout results in aggregate only (the
// split breakdown): no per-case holdout rows, and every other figure,
// the comparison's included, covers the dev cases. report.json keeps
// everything. `holdoutSummary` (--holdout-summary, to conclude a
// pre-registered experiment) adds one line: the comparison's paired holdout
// cases in aggregate (holdoutPairSummary), nothing per case.

// The ids report.md and the console must not list: the holdout cases of the
// report and of its comparison (empty when they are revealed).
function hiddenIds(report, { revealHoldout = false } = {}) {
  if (revealHoldout) {
    return new Set();
  }
  return new Set([...holdoutRecordIds(report?.results), ...(report?.comparison?.holdoutCases || [])]);
}

function comparisonHiddenIds(comparison, { revealHoldout = false } = {}) {
  return revealHoldout ? new Set() : new Set(comparison?.holdoutCases || []);
}

// The comparison report.md and the console show. Its figures over every
// paired case next to the listed dev flips would give the holdout's flips
// away by subtraction (and its interval, McNemar p and verdict depend on
// them), so with holdout cases hidden every figure is recomputed over the
// paired dev cases (summarizePairs, with the comparison's alpha and
// bootstrap settings) and the lists leave the holdout cases out, uncounted:
// the number of holdout cases in the comparison (a property of the two case
// sets, not of an outcome) is all that is said about them. --gate still tests
// every paired case; its verdict is the exit code. `hiddenCases` is that
// number (0 when nothing is hidden).
function displayedComparison(comparison, { revealHoldout = false } = {}) {
  const hidden = comparisonHiddenIds(comparison, { revealHoldout });
  if (hidden.size === 0) {
    return { ...comparison, hiddenCases: 0 };
  }
  const visible = (entries) => (entries || []).filter((entry) => !hidden.has(typeof entry === 'string' ? entry : entry.id));
  const pairs = visible(comparison.pairedCases);
  return {
    ...comparison,
    ...summarizePairs(pairs, comparisonStatsOptions(comparison)),
    pairedCases: pairs,
    excluded: { goldChanged: visible(comparison.excluded?.goldChanged), notCounted: visible(comparison.excluded?.notCounted) },
    newCases: visible(comparison.newCases),
    removedCases: visible(comparison.removedCases),
    hiddenCases: hidden.size,
  };
}

// The settings a comparison's figures were computed with (its alpha, and the
// resamples and seed of its accuracy-change interval), so figures recomputed
// over a subset of its pairs are drawn the same way.
function comparisonStatsOptions(comparison) {
  const ci = comparison.accuracy?.deltaCi95 || {};
  return { alpha: comparison.alpha ?? 0.05, resamples: ci.resamples ?? BOOTSTRAP_RESAMPLES, seed: ci.seed ?? BOOTSTRAP_SEED };
}

// A canonical order of paired outcomes (pass rates, then majority verdicts).
const outcomeKey = (side) => [side.passRate ?? -1, side.majorityPass ? 1 : 0];
function byPairedOutcome(left, right) {
  const a = [...outcomeKey(left.baseline), ...outcomeKey(left.candidate)];
  const b = [...outcomeKey(right.baseline), ...outcomeKey(right.candidate)];
  const index = a.findIndex((value, position) => value !== b[position]);
  return index === -1 ? 0 : a[index] - b[index];
}

/**
 * --holdout-summary: the paired holdout cases of a recorded comparison in
 * aggregate (the comparison's holdout cases that are paired, which the dev
 * figures leave out): summarizePairs over them, with the comparison's alpha
 * and bootstrap settings. The number of pairs, the flips, the 2x2 table, the
 * McNemar p and the verdict are exactly those of the holdout subset of the
 * full comparison that --reveal-holdout lists; the accuracies and their
 * change are too, up to the order of a floating-point sum (at a rounding tie
 * of round(), one unit in the 4th decimal, which can move the last printed
 * digit by one; exact with one repetition, where pass rates are 0 or 1).
 * Null without a comparison, without its pairs (a comparison recorded before
 * they were stored) or without a paired holdout case. Each pair keeps only
 * its outcome (pass rates, majority verdicts: no id, question or outcome
 * name), in a canonical order of outcomes instead of by id: the bootstrap
 * draws cases by position, so in id order its interval (and, at a tie, a
 * sum) would move with WHICH holdout cases flipped; in this order every
 * figure depends only on the paired outcomes, and two runs whose holdout
 * pairs differ only in which cases they are print the same line.
 */
export function holdoutPairSummary(comparison) {
  const holdout = new Set(comparison?.holdoutCases || []);
  const pairs = Array.isArray(comparison?.pairedCases) ? comparison.pairedCases.filter((entry) => holdout.has(entry.id)) : [];
  if (pairs.length === 0) {
    return null;
  }
  const outcome = (side) => ({ passRate: side.passRate, majorityPass: side.majorityPass });
  const canonical = pairs.map((entry) => ({ baseline: outcome(entry.baseline), candidate: outcome(entry.candidate) })).sort(byPairedOutcome);
  return summarizePairs(canonical, comparisonStatsOptions(comparison));
}

// The holdout note of a displayed comparison, or null when nothing is hidden.
function hiddenComparisonNote(comparison) {
  return comparison.hiddenCases > 0
    ? `Dev cases only: the comparison's ${comparison.hiddenCases} holdout case(s) are left out of these figures and lists (the holdout is ` +
        'read as its accuracy by split). `--gate` still tests every paired case, holdout included; its verdict is the exit code. ' +
        '`--reveal-holdout` shows them.'
    : null;
}

const isBehaviorRecord = (record) => Boolean(record.expected_behavior && record.expected_behavior !== 'answer');

// The bootstrap settings the report's own intervals used (a test run may use
// fewer resamples), so recomputed intervals are drawn the same way.
function statsOptionsOf(report) {
  const ci = report.stats?.strictAccuracy?.ci95 || {};
  return { resamples: ci.resamples ?? BOOTSTRAP_RESAMPLES, seed: ci.seed ?? BOOTSTRAP_SEED };
}

// The summaries report.md and the console show. A summary over every case
// next to the listed dev rows gives the hidden holdout outcomes away by
// subtraction (combined behaviour or attribution counts minus the dev rows),
// so with holdout cases hidden the behaviour summary, the attribution, the
// guardrail confusion matrix and the cost, latency, retry and token figures
// are recomputed from the listed records (a holdout case that completed no
// LLM call, or made a retry, would otherwise show up in those counts; a live
// run's console also prints each dev repetition's cost). So are the
// headline's intervals, majority-pass cases and intent-clustered accuracy
// (`accuracy`) and the legacy pooled rate (`reliability`): two runs with the
// same holdout accuracy can differ in how its pass rates spread over cases
// and intents, and in excluded or skipped holdout repetitions. Hidden holdout
// behaviour cases are only counted (the dataset says how many there are),
// never with their outcomes. The holdout's one shown aggregate is its
// accuracy by split (with its case count), and the headline's strict
// accuracy over every case, which the split rows give anyway. Without hidden
// cases these are the report's own.
function displayedSummaries(report, hidden = new Set()) {
  const results = report.results || [];
  const listed = results.filter((record) => !hidden.has(record.id));
  if (listed.length === results.length) {
    const { cost, latency, retries, tokens } = report.stats || {};
    return {
      attribution: report.attribution,
      behavior: report.behavior,
      usage: { cost, latency, retries, tokens },
      accuracy: null,
      reliability: report.reliability || null,
      records: results,
      hidden: false,
      hiddenAnswerCases: 0,
      hiddenBehaviorCases: 0,
    };
  }
  const hiddenRecords = results.filter((record) => hidden.has(record.id));
  const listedAnswers = listed.filter((record) => !isBehaviorRecord(record));
  return {
    attribution: summarizeAttribution(listedAnswers),
    behavior: summarizeBehavior(listed),
    usage: summarizeRunUsage(listed),
    accuracy: summarizeAccuracy(listedAnswers, statsOptionsOf(report)),
    // A report without the legacy block (a compact baseline) shows none.
    reliability: report.reliability ? legacySummary(listedAnswers.filter((record) => Array.isArray(record.repetitions))).reliability : null,
    records: listed,
    hidden: true,
    hiddenAnswerCases: hiddenRecords.filter((record) => !isBehaviorRecord(record)).length,
    hiddenBehaviorCases: hiddenRecords.filter(isBehaviorRecord).length,
  };
}

// With the holdout hidden, a run can list no dev answer case (or no dev case
// at all, e.g. --split holdout): its sections then say so in one line
// instead of printing empty or all-zero tables.
const noListedAnswerCase = (shown) => shown.hidden && !shown.records.some((record) => !isBehaviorRecord(record));
const NO_DEV_ANSWER_CASE = 'No dev answer case in this run';

function hiddenBehaviorNote(count) {
  return count > 0
    ? `${count} holdout behaviour case(s) not listed and not in these counts: holdout results are read in aggregate only, and the ` +
        'behaviour cases are not in the split accuracy, so their outcomes are not shown; pass --reveal-holdout to list them.'
    : null;
}

const BUCKET_LABELS = {
  pass: 'pass',
  model: 'model errors',
  system: 'system errors (guardrail false rejections, retrieval misses, known validator rejections)',
  infra: 'infrastructure (timeouts, DB/provider failures)',
  skipped: 'skipped (budget, or the run was stopped)',
  harness: 'harness (gold or runner errors)',
};

export function formatPercent(value, digits = 1) {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function formatInterval(interval) {
  if (!interval || interval.lower == null || interval.upper == null) {
    return 'n/a';
  }
  return `${formatPercent(interval.lower)}–${formatPercent(interval.upper)}`;
}

function formatPoints(value) {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  const points = value * 100;
  return `${points >= 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} pts`;
}

function formatUsd(value, digits = 4) {
  return value == null || !Number.isFinite(value) ? 'n/a' : `$${value.toFixed(digits)}`;
}

// A budget or limit: cents when it is at least a cent, else four decimals.
function formatLimitUsd(value) {
  return value == null || !Number.isFinite(value) ? 'none' : `$${value.toFixed(value >= 0.01 ? 2 : 4)}`;
}

function formatMs(value) {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : 'n/a';
}

function short(hash, length = 12) {
  return hash ? String(hash).slice(0, length) : 'n/a';
}

// The schema scope of a report's product configuration; a report from before
// it was recorded ran the retrieved scope without widen-on-demand.
function schemaScopeText(scope) {
  return scope ? describeSchemaScope(scope) : 'not recorded (before SCHEMA_SCOPE: retrieved, no widening)';
}

// Same behaviour: the same effective scope (and, for the retrieved scope, the
// same widen-on-demand setting); auto -> full behaves like full.
const sameSchemaScope = sameSchemaScopeBehaviour;

/** Escapes a value for a Markdown table cell (pipes, newlines). */
export function cell(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function truncate(text, length = 60) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function table(headers, rows) {
  if (rows.length === 0) {
    return '';
  }
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function passRateText(summary) {
  if (!summary || summary.counted === 0) {
    return 'excluded';
  }
  return `${summary.passes}/${summary.counted}`;
}

// The headline's dev-case line while the holdout is hidden: strict accuracy
// with its interval, majority-pass cases and intent-clustered accuracy over
// the listed dev answer cases.
function devAccuracyText(accuracy) {
  if (!accuracy || accuracy.cases.counted === 0) {
    return 'Dev cases: no counted dev answer case in this run (the holdout is shown in aggregate, by split).';
  }
  const { strictAccuracy: strict, majority, intentClustered } = accuracy;
  return (
    `Dev cases: strict accuracy ${formatPercent(strict.value)} (95% CI ${formatInterval(strict.ci95)}, case bootstrap) over ` +
    `${accuracy.cases.counted} cases · majority-pass cases ${majority.passes}/${majority.n} (Wilson 95% ${formatInterval(majority.wilson95)}) · ` +
    `intent-clustered accuracy ${formatPercent(intentClustered.value)} (95% CI ${formatInterval(intentClustered.ci95)}, ${intentClustered.intents} intents)`
  );
}

// "N case(s) did not finish" of a stopped run. While the holdout is hidden it
// counts the listed (dev) cases: which holdout repetitions a stop cut off is
// a holdout outcome the split accuracy does not show (a case cut off after
// passing repetitions keeps its pass rate).
function cancelledText(report, hidden, shown) {
  const cancelled = (report.stopped?.cancelledCases || []).filter((id) => !hidden.has(id));
  return `${cancelled.length} ${shown.hidden ? 'dev ' : ''}case(s) did not finish`;
}

function headline(report, hidden = new Set(), shown = displayedSummaries(report, hidden), comparison = report.comparison) {
  const stats = report.stats;
  const strict = stats.strictAccuracy;
  const date = report.generatedAt ? report.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'n/a';
  const repetitions = `${stats.repeat} repetition${stats.repeat === 1 ? '' : 's'}`;
  const lines = [];
  if (shown.hidden) {
    // Every case: a point estimate only (the split accuracies weighted by
    // their case counts); the intervals and the finer statistics are the dev
    // cases' (displayedSummaries).
    lines.push(
      `**Strict accuracy ${formatPercent(strict.value)}** (every split; no interval while the holdout is hidden) · ` +
        `${stats.cases.counted} cases · ${repetitions} · ${report.model} · ${date}`
    );
    lines.push('');
    lines.push(devAccuracyText(shown.accuracy));
  } else {
    lines.push(
      `**Strict accuracy ${formatPercent(strict.value)}** (95% CI ${formatInterval(strict.ci95)}, case bootstrap) · ` +
        `${stats.cases.counted} cases · ${stats.cases.intents} intents · ${repetitions} · ${report.model} · ${date}`
    );
    lines.push('');
    lines.push(
      `Majority-pass cases ${stats.majority.passes}/${stats.majority.n} (Wilson 95% ${formatInterval(stats.majority.wilson95)}) · ` +
        `intent-clustered accuracy ${formatPercent(stats.intentClustered.value)} (95% CI ${formatInterval(stats.intentClustered.ci95)}, ${stats.intentClustered.intents} intents)`
    );
  }
  const splits = stats.bySplit || [];
  if (splits.length > 1) {
    lines.push('');
    lines.push(
      `By split: ${splits.map((entry) => `${entry.key} ${formatPercent(entry.accuracy)} (${entry.cases} case${entry.cases === 1 ? '' : 's'})`).join(' · ')}. ` +
        'Dev cases include the wording the prompt rules and the semantic layer were tuned on; holdout cases are new intents whose questions contain ' +
        'no multi-word phrase of the semantic layer and not the tuned word "revenue" (single words such as customer, store or units still match it).'
    );
  }
  const hiddenHoldout = (report.results || []).filter((record) => hidden.has(record.id)).length;
  if (hiddenHoldout > 0) {
    lines.push('');
    lines.push(
      `Holdout: ${hiddenHoldout} case(s), shown in aggregate only (accuracy by split); error analysis and experiment design use dev ` +
        'failures only (the intervals, majority-pass cases, intent-clustered accuracy, attribution, the guardrail matrix, behaviour cases, ' +
        'cost, latency, the finer breakdowns and the pooled rate cover dev cases). `--reveal-holdout` lists them.'
    );
  }
  const behaviorText = behaviorSummaryText(shown);
  if (behaviorText) {
    lines.push('');
    lines.push(`${behaviorText} Not in strict accuracy (see Behaviour cases).`);
  }
  if (stats.cases.excluded > 0) {
    lines.push('');
    // The denominator is the answer cases: abstain/clarify cases never have a
    // counted repetition and are reported on their own, so counting them here
    // would make "excluded of selected" disagree with the accuracy's n.
    const behaviorCases = stats.cases.behavior || 0;
    const answerCases = stats.cases.selected - behaviorCases;
    lines.push(
      behaviorCases > 0
        ? `${stats.cases.excluded} of ${answerCases} answer case(s) had no counted repetition and are left out of accuracy (see Attribution); ` +
            `the ${behaviorCases} abstain/clarify case(s) are scored apart.`
        : `${stats.cases.excluded} of ${stats.cases.selected} selected case(s) had no counted repetition and are left out of accuracy (see Attribution).`
    );
  }
  if (report.stopped) {
    lines.push('');
    lines.push(
      `**The run was stopped early**: ${report.stopped.reason}. ${cancelledText(report, hidden, shown)} ` +
        `(outcome \`cancelled\`, excluded${shown.hidden ? '; holdout cases are not counted here' : ''}); the numbers cover only what finished.`
    );
  }
  if (report.mode === 'rescore' && report.rescoredFrom) {
    lines.push('');
    lines.push(
      `Rescored with zero LLM calls from \`${report.rescoredFrom.path}\` (generated ${report.rescoredFrom.generatedAt || 'n/a'}, ` +
        `sha256 ${short(report.rescoredFrom.sha256)}); cost and latency are the original run's.`
    );
  }
  if (comparison) {
    lines.push('');
    lines.push(comparisonLine(comparison));
  }
  return lines.join('\n');
}

const VERDICT_TEXT = {
  worse: 'significantly WORSE than the baseline',
  better: 'significantly better than the baseline',
  no_significant_difference: 'no significant difference from the baseline',
  no_paired_cases: 'no case could be paired with the baseline',
};

// The verdict of a displayed comparison. With the holdout hidden and no dev
// case paired, "no case could be paired" would be wrong whenever holdout
// cases were (--gate decides on them); the wording does not say whether any was.
function verdictText(comparison) {
  if (comparison.verdict === 'no_paired_cases' && comparison.hiddenCases > 0) {
    return 'no dev case is paired with the baseline (its holdout cases are not shown)';
  }
  return VERDICT_TEXT[comparison.verdict] || comparison.verdict;
}

/** The comparison's one-line summary (of a displayed comparison: dev cases only while the holdout is hidden). */
export function comparisonLine(comparison) {
  const dev = comparison.hiddenCases > 0;
  return (
    `vs baseline${dev ? ' (dev cases)' : ''}: Δ ${formatPoints(comparison.accuracy.delta)} (95% CI ${formatSignedInterval(comparison.accuracy.deltaCi95)}) on ` +
    `${comparison.paired} paired ${dev ? 'dev ' : ''}case(s); ${comparison.mcnemar.regressions} regression(s), ${comparison.mcnemar.improvements} improvement(s); ` +
    `exact McNemar p = ${comparison.mcnemar.p.toFixed(3)} → ${verdictText(comparison)}` +
    (dev ? ` (the comparison's ${comparison.hiddenCases} holdout case(s) are not shown; --gate tests every paired case)` : '')
  );
}

/**
 * The --holdout-summary line (holdoutPairSummary): the number of paired
 * holdout cases, their improvements and regressions, the exact McNemar p
 * with the verdict's usual wording, and strict accuracy on those cases,
 * baseline → candidate, with the change and its paired bootstrap 95% CI.
 * Nothing else about the holdout.
 */
function holdoutSummaryText(summary) {
  return (
    `${summary.paired} paired holdout case(s); ${summary.mcnemar.improvements} improvement(s), ${summary.mcnemar.regressions} regression(s); ` +
    `exact McNemar p = ${summary.mcnemar.p.toFixed(3)} → ${VERDICT_TEXT[summary.verdict] || summary.verdict}; ` +
    `strict accuracy ${formatPercent(summary.accuracy.baseline)} → ${formatPercent(summary.accuracy.candidate)}, ` +
    `Δ ${formatPoints(summary.accuracy.delta)} (95% CI ${formatSignedInterval(summary.accuracy.deltaCi95)})`
  );
}

// The 2x2 table, also for comparisons recorded before it was stored.
function contingencyOf(comparison) {
  if (comparison.contingency) {
    return comparison.contingency;
  }
  const regressions = comparison.mcnemar.regressions;
  const improvements = comparison.mcnemar.improvements;
  const bothPass = comparison.majority.baselinePasses - regressions;
  return { bothPass, regressions, improvements, bothFail: comparison.paired - bothPass - regressions - improvements };
}

function flipList(entries) {
  if (entries.length === 0) {
    return 'none';
  }
  const shown = entries.slice(0, 12).map((entry) => `${entry.id} (${entry.baseline.outcome} → ${entry.candidate.outcome})`);
  return `${shown.join(', ')}${entries.length > shown.length ? `, … ${entries.length - shown.length} more (report.md)` : ''}`;
}

/**
 * The comparison as a few plain-text lines for the console: the paired 2x2
 * table of majority verdicts, the accuracy change, the exact McNemar p and
 * the flipped cases by id (over the paired dev cases, unless revealHoldout);
 * with holdoutSummary, one more line for the paired holdout cases in
 * aggregate (holdoutPairSummary), when there is one.
 */
export function renderComparisonConsole(recorded, { revealHoldout = false, holdoutSummary = false } = {}) {
  const comparison = displayedComparison(recorded, { revealHoldout });
  const holdout = holdoutSummary ? holdoutPairSummary(recorded) : null;
  const dev = comparison.hiddenCases > 0;
  const contingency = contingencyOf(comparison);
  const width = Math.max(4, ...[contingency.bothPass, contingency.regressions, contingency.improvements, contingency.bothFail].map((value) => String(value).length));
  const row = (label, left, right) => `  ${label.padEnd(15)}${String(left).padStart(14 + width - 4)}${String(right).padStart(16 + width - 4)}`;
  const excluded = comparison.excluded || { goldChanged: [], notCounted: [] };
  const lines = [
    `Paired comparison with ${comparison.baseline.label || 'the baseline'}: ${comparison.paired} paired ${dev ? 'dev ' : ''}case(s)` +
      (dev ? ` (the comparison's ${comparison.hiddenCases} holdout case(s) are not shown; --gate tests every paired case, its verdict is the exit code)` : ''),
    `  ${''.padEnd(15)}${'candidate pass'.padStart(14 + width - 4)}${'candidate fail'.padStart(16 + width - 4)}`,
    row('baseline pass', contingency.bothPass, contingency.regressions),
    row('baseline fail', contingency.improvements, contingency.bothFail),
    `  strict accuracy (paired ${dev ? 'dev ' : ''}cases) ${formatPercent(comparison.accuracy.baseline)} → ${formatPercent(comparison.accuracy.candidate)}: ` +
      `Δ ${formatPoints(comparison.accuracy.delta)} (95% CI ${formatSignedInterval(comparison.accuracy.deltaCi95)})`,
    `  exact McNemar p = ${comparison.mcnemar.p.toFixed(3)} (${comparison.mcnemar.regressions} regression(s), ${comparison.mcnemar.improvements} improvement(s)) → ` +
      `${verdictText(comparison)}`,
    `  regressions: ${flipList(comparison.flips.regressions)}`,
    `  improvements: ${flipList(comparison.flips.improvements)}`,
  ];
  if (holdout) {
    lines.push(`  holdout in aggregate (--holdout-summary): ${holdoutSummaryText(holdout)}`);
  }
  if (!sameSchemaScope(comparison.baseline?.schemaScope, comparison.candidate?.schemaScope)) {
    lines.push(`  schema scope: ${schemaScopeText(comparison.baseline?.schemaScope)} → ${schemaScopeText(comparison.candidate?.schemaScope)}`);
  }
  if (!sameHintsVersion(comparison.baseline?.hintsVersion, comparison.candidate?.hintsVersion)) {
    lines.push(`  hints version: ${describeHintsVersion(comparison.baseline?.hintsVersion)} → ${describeHintsVersion(comparison.candidate?.hintsVersion)}`);
  }
  const notes = [
    excluded.goldChanged.length ? `${excluded.goldChanged.length} gold changed` : null,
    excluded.notCounted.length ? `${excluded.notCounted.length} not counted or timed out in one report` : null,
    comparison.newCases?.length ? `${comparison.newCases.length} new` : null,
    comparison.removedCases?.length ? `${comparison.removedCases.length} not in this run` : null,
  ].filter(Boolean);
  if (notes.length) {
    lines.push(`  not paired: ${notes.join(', ')} (listed in report.md)`);
  }
  return lines.join('\n');
}

function formatSignedInterval(interval) {
  if (!interval || interval.lower == null) {
    return 'n/a';
  }
  return `${formatPoints(interval.lower)} to ${formatPoints(interval.upper)}`;
}

// The outcome's bucket, split when some repetitions moved (a model outcome
// tagged retrieval_miss is a system error): "model 3 / system 1".
function bucketText(attribution, outcome) {
  const split = attribution.byOutcomeBucket?.[outcome];
  const entries = split ? Object.entries(split) : [];
  if (entries.length <= 1) {
    return entries[0]?.[0] || OUTCOME_BUCKETS[outcome];
  }
  return entries.map(([bucket, count]) => `${bucket} ${count}`).join(' / ');
}

function attributionSection(report, shown = displayedSummaries(report)) {
  const attribution = shown.attribution;
  const lines = ['## Attribution', ''];
  if (noListedAnswerCase(shown)) {
    lines.push(
      `${NO_DEV_ANSWER_CASE}${shown.hiddenAnswerCases > 0 ? `: the ${shown.hiddenAnswerCases} holdout answer case(s) are shown in aggregate (accuracy by split)` : ''}.`
    );
    lines.push('');
    lines.push(excludedLine(attribution, shown));
    return lines.join('\n');
  }
  lines.push(
    'Who caused each outcome. Repetitions are every (case, repetition) run; cases use each case\'s majority outcome. ' +
      'Excluded outcomes are not in the accuracy denominator.' +
      (shown.hiddenAnswerCases > 0 ? ` Dev cases only: the ${shown.hiddenAnswerCases} holdout answer case(s) are shown in aggregate (accuracy by split).` : '')
  );
  lines.push('');
  lines.push(
    table(
      ['Bucket', 'Repetitions', 'Cases (majority)'],
      BUCKET_ORDER.filter((bucket) => attribution.repetitions.byBucket[bucket] || attribution.cases.byBucket[bucket]).map((bucket) => [
        BUCKET_LABELS[bucket] || bucket,
        attribution.repetitions.byBucket[bucket] || 0,
        attribution.cases.byBucket[bucket] || 0,
      ])
    )
  );
  lines.push('');
  lines.push(
    table(
      ['Outcome', 'Bucket', 'Repetitions', 'Cases (majority)', 'In accuracy'],
      OUTCOME_ORDER.filter((outcome) => attribution.repetitions.byOutcome[outcome] || attribution.cases.byOutcome[outcome]).map((outcome) => [
        outcome,
        bucketText(attribution, outcome),
        attribution.repetitions.byOutcome[outcome] || 0,
        attribution.cases.byOutcome[outcome] || 0,
        EXCLUDED_OUTCOMES.has(outcome) ? 'excluded' : 'counted',
      ])
    )
  );
  lines.push('');
  lines.push(
    `System errors (counted repetitions): ${attribution.system.guardrailFalseRejections} guardrail false rejection(s), ` +
      `${attribution.system.retrievalMisses} retrieval miss(es) (a failure where an expected table was not retrieved, so not allowed), ` +
      `${attribution.system.knownValidatorRejections ?? 0} known validator rejection(s) (a case flagged known_validator_rejection whose final attempt ` +
      'the validator rejected with the flagged code: it rejects every correct answer to that question today; any other failure of a flagged case ' +
      'is judged as usual). A model-bucket failure tagged retrieval_miss or known_validator_rejection is counted as a system error.'
  );
  if (attribution.system.guardrailFalseRejectionsElsewhere) {
    lines.push('');
    lines.push(
      `${attribution.system.guardrailFalseRejectionsElsewhere} more repetition(s) had a guardrail false rejection but ended in another outcome ` +
        '(e.g. the retry hit a provider outage or the deadline); they keep that outcome and are tagged guardrail_false_rejection.'
    );
  }
  if (attribution.system.guardrailUnverified) {
    lines.push('');
    lines.push(
      `${attribution.system.guardrailUnverified} repetition(s) with a guardrail rejection that could not be re-checked (the database failed) ` +
        'are infra_error, not model errors: the rejection might have been a false one.'
    );
  }
  lines.push('');
  lines.push(excludedLine(attribution, shown));
  return lines.join('\n');
}

// Excluded outcomes (repetitions of answer cases), and the abstain / clarify
// cases, which are never in accuracy or in the attribution tables.
function excludedLine(attribution, shown) {
  const excluded = Object.entries(attribution.excluded);
  const behaviorCases = shown.records.filter(isBehaviorRecord);
  const parts = [];
  if (excluded.length > 0) {
    parts.push(excluded.map(([outcome, count]) => `${outcome} ${count}`).join(', '));
  }
  if (behaviorCases.length > 0) {
    const repetitions = behaviorCases.reduce((total, record) => total + (record.repetitions?.length || 0), 0);
    parts.push(
      `${behaviorCases.length} abstain/clarify case${behaviorCases.length === 1 ? '' : 's'} ` +
        `(${repetitions} repetition${repetitions === 1 ? '' : 's'}; see Behaviour cases)`
    );
  }
  if (shown.hiddenBehaviorCases > 0) {
    parts.push(`${shown.hiddenBehaviorCases} holdout abstain/clarify case(s) (not listed)`);
  }
  return `Excluded from accuracy: ${parts.length > 0 ? parts.join('; ') : 'none'}.`;
}

const UNKNOWN_LABELS = {
  unsafe: 'rejected SQL fails the safety layer now, not run',
  checkFailed: 're-check failed',
  unchecked: 'not re-checked',
  infra: 'database failure',
  notFinal: 'accepted, run cut short',
};

function unknownBreakdown(unknownBy) {
  const parts = Object.entries(unknownBy || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${UNKNOWN_LABELS[key] || key} ${count}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function confusionSection(report, shown = displayedSummaries(report)) {
  const matrix = shown.attribution.guardrailConfusion;
  const lines = ['## Guardrail confusion matrix', ''];
  if (noListedAnswerCase(shown)) {
    lines.push(`${NO_DEV_ANSWER_CASE} (the holdout is shown in aggregate, by split).`);
    return lines.join('\n');
  }
  lines.push(
    'Every attempt, retries included. "Rejected" = a guardrail-layer rejection; correctness of rejected SQL is decided by re-running it ' +
      'read-only on every fixture (only after it passes the safety layer). An accepted attempt that failed at execution counts as incorrect.' +
      (shown.hiddenAnswerCases > 0 ? ' Dev cases only (the holdout is shown in aggregate, by split).' : '')
  );
  lines.push('');
  lines.push(
    table(
      ['', 'SQL correct', 'SQL incorrect'],
      [
        ['Rejected by a guardrail', `${matrix.fp} (false rejection)`, `${matrix.tp} (caught)`],
        ['Accepted', `${matrix.tn}`, `${matrix.fn} (missed)`],
      ]
    )
  );
  lines.push('');
  lines.push(
    `Precision ${formatPercent(matrix.precision)} · recall ${formatPercent(matrix.recall)} · false rejection rate ${formatPercent(matrix.falseRejectionRate)} · ` +
      `unknown ${matrix.unknown}${unknownBreakdown(matrix.unknownBy)} · safety-layer rejections (never run) ${matrix.safetyRejections} · attempts ${matrix.attempts}`
  );
  return lines.join('\n');
}

function breakdownSection(report, hidden = new Set()) {
  const stats = report.stats;
  // With the holdout in aggregate only, the finer breakdowns cover dev cases
  // (a small group of holdout cases would show their per-case results).
  const holdoutHidden = (report.results || []).some((record) => hidden.has(record.id));
  const finer = holdoutHidden ? summarizeBreakdowns((report.results || []).filter((record) => !hidden.has(record.id))) : stats;
  const rows = [];
  for (const [label, entries] of [
    ['split', stats.bySplit || []],
    ['failure_class', finer.byFailureClass || []],
    ['difficulty', finer.byDifficulty || []],
    ['tag', finer.byTag || []],
  ]) {
    for (const entry of entries) {
      // The hidden holdout's row is its accuracy (and case count) only: its
      // majority passes would say how its pass rates spread over cases.
      const majority = holdoutHidden && label === 'split' && entry.key === 'holdout' ? 'not shown' : `${entry.majorityPasses}/${entry.cases}`;
      rows.push([label, entry.key, entry.cases, formatPercent(entry.accuracy), majority]);
    }
  }
  return [
    '## By split, failure class, difficulty and tag',
    '',
    ...(holdoutHidden
      ? ['Failure class, difficulty and tag rows cover the dev cases only, and the holdout row shows its accuracy only (the holdout is shown in aggregate, by split).', '']
      : []),
    table(['Group', 'Value', 'Cases', 'Accuracy', 'Majority passes'], rows) || 'No counted cases.',
  ].join('\n');
}

/** "M/N declined" for a behaviour case's summary (its handled repetitions), or "excluded". */
export function behaviorPassText(summary) {
  const behavior = summary?.behavior;
  return behavior && behavior.counted > 0 ? `${behavior.handled}/${behavior.counted} declined` : 'excluded';
}

function casesSection(report, hidden = new Set()) {
  const listed = report.results.filter((record) => !hidden.has(record.id));
  const rows = listed.map((record) => {
    const behavior = record.expected_behavior && record.expected_behavior !== 'answer';
    return [
      record.id,
      truncate(record.question, 60),
      behavior ? behaviorPassText(record.summary) : passRateText(record.summary),
      record.summary?.outcome || record.status,
      [behavior ? `expects ${record.expected_behavior}` : null, record.summary?.bucket, ...(record.summary?.tags || [])].filter(Boolean).join(', '),
    ];
  });
  const note = hiddenHoldoutNote(report.results.length - listed.length);
  return ['## Cases', '', table(['Case', 'Question', 'Passes', 'Outcome', 'Attribution'], rows) || 'No case listed.', ...(note ? ['', note] : [])].join('\n');
}

export function behaviorLine(behavior) {
  return `Behaviour cases: abstain/clarify — ${behavior.cases} case${behavior.cases === 1 ? '' : 's'}, ${behavior.handled} handled correctly` +
    (behavior.counted < behavior.cases ? ` (${behavior.cases - behavior.counted} without a counted repetition)` : '') +
    '.';
}

// The behaviour line of the shown summary; hidden holdout behaviour cases are
// counted apart, without their outcomes. Null when there is none of either.
function behaviorSummaryText(shown) {
  const hidden = shown.hiddenBehaviorCases;
  const hiddenText = hidden > 0 ? `${hidden} holdout abstain/clarify case(s), outcomes not shown` : '';
  if (shown.behavior?.cases > 0) {
    return `${behaviorLine(shown.behavior)}${hiddenText ? ` Not counted here: ${hiddenText}.` : ''}`;
  }
  return hiddenText ? `Behaviour cases: ${hiddenText}.` : null;
}

function behaviorSection(report, hidden = new Set(), shown = displayedSummaries(report, hidden)) {
  const behavior = shown.behavior;
  const text = behaviorSummaryText(shown);
  if (!text) {
    return '';
  }
  const lines = ['## Behaviour cases (abstain / clarify)', '', text, ''];
  lines.push(
    'These questions have no correct SQL: the data cannot answer them (abstain) or they are ambiguous (clarify). A case is handled when the ' +
      'product returned no SQL in more than half of its counted repetitions (`declined`); producing SQL is `answered_instead_of_abstain` / ' +
      '`answered_instead_of_clarify` (model bucket, tagged `not_executed` when the SQL was rejected or failed). The product has no ' +
      'abstention or clarification channel yet, so today it is expected to fail these. They are not in strict accuracy or the paired comparison.'
  );
  const summary = table(
    ['Expected behaviour', 'Cases', 'Handled', 'Outcomes (majority)'],
    Object.entries(behavior?.byBehavior || {}).map(([name, entry]) => [
      name,
      entry.cases,
      `${entry.handled}/${entry.counted}`,
      Object.entries(entry.outcomes)
        .map(([outcome, count]) => `${outcome} ${count}`)
        .join(', '),
    ])
  );
  if (summary) {
    lines.push('');
    lines.push(summary);
  }
  const cases = shown.records.filter(isBehaviorRecord);
  if (cases.length > 0) {
    lines.push('');
    lines.push(
      table(
        ['Case', 'Question', 'Expects', 'Declined', 'Outcome'],
        cases.map((record) => [record.id, truncate(record.question, 60), record.expected_behavior, behaviorPassText(record.summary), record.summary?.outcome || record.status])
      )
    );
  }
  const note = hiddenBehaviorNote(shown.hiddenBehaviorCases);
  if (note) {
    lines.push('');
    lines.push(note);
  }
  return lines.join('\n');
}

function costSection(report, hidden = new Set(), shown = displayedSummaries(report, hidden)) {
  const { cost, latency, retries, tokens } = shown.usage;
  const noListedCase = shown.hidden && shown.records.length === 0;
  const usageRows = [
    [
      'Total LLM cost',
      `${formatUsd(cost.total)}${cost.questionsWithoutCost ? ` (${cost.questionsWithoutCost} question(s) used tokens without a known price, so this is a lower bound)` : ''}` +
        `${cost.questionsWithoutLlmCall ? `; ${cost.questionsWithoutLlmCall} question(s) completed no LLM call (timeout or outage)` : ''}`,
    ],
    ['Cost per question', formatUsd(cost.perQuestion, 5)],
    ['Cost per correct answer', formatUsd(cost.perCorrect, 5)],
    ['Question latency p50 / p95 (product loop, wall)', `${formatMs(latency.questionWallMs.p50)} / ${formatMs(latency.questionWallMs.p95)} (n=${latency.questionWallMs.n})`],
    ...(latency.caseWallMs
      ? [['Per question incl. gold and scoring p50 / p95', `${formatMs(latency.caseWallMs.p50)} / ${formatMs(latency.caseWallMs.p95)} (n=${latency.caseWallMs.n})`]]
      : []),
    ['LLM call latency p50 / p95', `${formatMs(latency.llmCallMs.p50)} / ${formatMs(latency.llmCallMs.p95)} (n=${latency.llmCallMs.n})`],
    [
      'Retry rate',
      `${formatPercent(retries.rate)} of questions (${retries.questionsWithRetry}/${retries.questions}); ${retries.retryCalls} of ${retries.llmCalls} LLM calls were retries`,
    ],
    ['Tokens', `prompt ${formatCount(tokens.prompt)} (cached ${formatCount(tokens.cached)}) · completion ${formatCount(tokens.completion)}`],
  ];
  const rows = noListedCase ? [] : usageRows;
  if (report.budget?.limitUsd != null) {
    // Skipped holdout cases are counted, not named (aggregate only).
    const skipped = report.budget.skippedCases || [];
    const listed = skipped.filter((id) => !hidden.has(id));
    const holdoutSkipped = skipped.length - listed.length;
    const names = [...listed, ...(holdoutSkipped > 0 ? [`${holdoutSkipped} holdout case(s)`] : [])].join(', ');
    rows.push(['Budget', `${formatUsd(report.budget.spentUsd)} of ${formatLimitUsd(report.budget.limitUsd)}${skipped.length ? `; ${skipped.length} case(s) skipped: ${names}` : ''}`]);
  }
  return [
    '## Cost, latency, retries, tokens',
    '',
    ...(shown.hidden
      ? [
          `${noListedCase ? 'No dev case in this run: c' : 'C'}ost, latency, retries and tokens cover the dev cases only (the holdout is shown in ` +
            'aggregate, by split; the Budget row, when there is one, is the whole run\'s spend). `--reveal-holdout` covers every case.',
        ]
      : []),
    ...(rows.length > 0 ? [...(shown.hidden ? [''] : []), table(['Metric', 'Value'], rows)] : []),
  ].join('\n');
}

// The comparison section of a displayed comparison (displayedComparison:
// the paired dev cases while the holdout is hidden), with the
// --holdout-summary line when `holdoutSummary` (holdoutPairSummary) is given.
function comparisonSection(comparison, holdoutSummary = null) {
  const dev = comparison.hiddenCases > 0 ? 'dev ' : '';
  const lines = ['## Comparison with the baseline', ''];
  const note = hiddenComparisonNote(comparison);
  if (note) {
    lines.push(note);
    lines.push('');
  }
  const base = comparison.baseline;
  const cand = comparison.candidate;
  lines.push(
    table(
      ['', 'Baseline', 'Candidate'],
      [
        ['Report', base.label || 'n/a', cand.label || 'this run'],
        ['Model', base.model || 'n/a', cand.model || 'n/a'],
        ['Generated', base.generatedAt || 'n/a', cand.generatedAt || 'n/a'],
        ['Git', `${short(base.gitSha, 10)}${base.gitDirty ? ' (dirty)' : ''}`, `${short(cand.gitSha, 10)}${cand.gitDirty ? ' (dirty)' : ''}`],
        ['Prompt version', short(base.promptVersion), short(cand.promptVersion)],
        ['Schema scope', schemaScopeText(base.schemaScope), schemaScopeText(cand.schemaScope)],
        ['Hints version', describeHintsVersion(base.hintsVersion), describeHintsVersion(cand.hintsVersion)],
        [`Strict accuracy (paired ${dev}cases)`, formatPercent(comparison.accuracy.baseline), formatPercent(comparison.accuracy.candidate)],
        [`Majority passes (paired ${dev}cases)`, `${comparison.majority.baselinePasses}/${comparison.paired}`, `${comparison.majority.candidatePasses}/${comparison.paired}`],
      ]
    )
  );
  const contingency = contingencyOf(comparison);
  lines.push('');
  lines.push('Paired majority verdicts (the exact McNemar test uses the off-diagonal cells):');
  lines.push('');
  lines.push(
    table(
      ['', 'Candidate pass', 'Candidate fail'],
      [
        ['Baseline pass', contingency.bothPass, `${contingency.regressions} (regressions)`],
        ['Baseline fail', `${contingency.improvements} (improvements)`, contingency.bothFail],
      ]
    )
  );
  lines.push('');
  lines.push(comparisonLine(comparison));
  if (holdoutSummary) {
    lines.push('');
    lines.push(`Holdout in aggregate (\`--holdout-summary\`): ${holdoutSummaryText(holdoutSummary)}.`);
  }
  for (const [title, entries] of [
    ['Regressions (baseline majority pass → candidate fail)', comparison.flips.regressions],
    ['Improvements (baseline fail → candidate majority pass)', comparison.flips.improvements],
    ['Pass-rate changes without a flip', comparison.rateChanges],
  ]) {
    if (entries.length === 0) {
      continue;
    }
    lines.push('');
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(
      table(
        ['Case', 'Question', 'Baseline', 'Candidate'],
        entries.map((entry) => [
          entry.id,
          truncate(entry.question, 50),
          `${formatPercent(entry.baseline.passRate, 0)} (${entry.baseline.outcome})`,
          `${formatPercent(entry.candidate.passRate, 0)} (${entry.candidate.outcome})`,
        ])
      )
    );
  }
  const notes = [];
  if (comparison.excluded.goldChanged.length) {
    notes.push(`Excluded, gold changed: ${comparison.excluded.goldChanged.map((entry) => `${entry.id} (${entry.reason})`).join(', ')}.`);
  }
  if (comparison.excluded.notCounted.length) {
    notes.push(
      `Excluded from the paired test (not counted, or a timeout/infrastructure majority, in one report): ${comparison.excluded.notCounted.map((entry) => `${entry.id} (baseline ${entry.baseline}, candidate ${entry.candidate})`).join(', ')}.`
    );
  }
  if (comparison.newCases.length) {
    notes.push(`New cases (not in the baseline): ${comparison.newCases.join(', ')}.`);
  }
  if (comparison.removedCases.length) {
    notes.push(`Baseline cases not in this run: ${comparison.removedCases.length} (${truncate(comparison.removedCases.join(', '), 300)}).`);
  }
  if (notes.length) {
    lines.push('');
    lines.push(...notes.flatMap((line) => [line, '']).slice(0, -1));
  }
  return lines.join('\n');
}

function verificationSection(report) {
  const verification = report.verification;
  const lines = ['## Verification', ''];
  const fixtures = (report.oracle?.fixtures || []).map((fixture) => `${fixture.name} ${fixture.status}${fixture.action ? ` (${fixture.action})` : ''}`).join(', ');
  lines.push(`Fixtures: ${fixtures || 'n/a'}.`);
  lines.push('');
  if (!verification || verification.skipped) {
    lines.push('Gold and controls: not verified in this run (--skip-verify, or the benchmark profile).');
    return lines.join('\n');
  }
  lines.push(
    `Gold and controls: ${verification.cases} case(s) verified on every fixture, ${verification.problems.length} with problems; ` +
      `gates ${verification.gateFailures.length === 0 ? 'passed' : `FAILED (${verification.gateFailures.join('; ')})`}.`
  );
  if (verification.warnings?.length) {
    lines.push('');
    lines.push(`Warnings (npm run verify-dataset fails on these): ${verification.warnings.join('; ')}.`);
  }
  // Negative controls that are not a verdict, design + held-out. Undecided
  // ones (mapping search cut off) count as not killed; invalid (an SQL error)
  // and unscored (an infrastructure error) ones are problems. A summary
  // written before these statuses existed shows n/a.
  const statusCount = (controls, key) =>
    Array.isArray(controls.design?.[key]) || Array.isArray(controls.heldout?.[key])
      ? String((controls.design?.[key]?.length || 0) + (controls.heldout?.[key]?.length || 0))
      : 'n/a';
  const rows = verification.datasets
    .filter((dataset) => dataset.controls)
    .map((dataset) => [
      dataset.name,
      `${dataset.controls.design.killed}/${dataset.controls.design.total} (${formatPercent(dataset.controls.design.rate)})`,
      `${dataset.controls.heldout.killed}/${dataset.controls.heldout.total} (${formatPercent(dataset.controls.heldout.rate)})`,
      `${dataset.controls.design.seedOnlyKilled}/${dataset.controls.design.total}`,
      statusCount(dataset.controls, 'undecided'),
      statusCount(dataset.controls, 'invalid'),
      statusCount(dataset.controls, 'unscored'),
      `${dataset.controls.positive.matched}/${dataset.controls.positive.total} match, ${dataset.controls.positive.validatorAccepted} accepted`,
    ]);
  if (rows.length) {
    lines.push('');
    lines.push(table(['Dataset', 'Design kill rate', 'Held-out kill rate', 'Killed on seed alone', 'Undecided', 'Invalid', 'Unscored', 'Positive controls'], rows));
  }
  const status = verification.controlStatus || {};
  for (const [key, label] of [
    ['invalid', 'Invalid controls (fail to execute; a problem, not a kill)'],
    ['unscored', 'Unscored controls (infrastructure error; a problem, not a kill)'],
    ['undecided', 'Undecided controls (mapping search cut off; counted as not killed)'],
  ]) {
    if (status[key]?.length) {
      lines.push('');
      lines.push(`${label}: ${truncate(status[key].join(', '), 600)}.`);
    }
  }
  return lines.join('\n');
}

function provenanceSection(report) {
  const provenance = report.provenance || {};
  const runner = report.runner || {};
  const filters = report.suite?.filters || {};
  const filterText = [
    filters.split && filters.split !== 'all' ? `split ${filters.split}` : null,
    filters.caseIds?.length ? `case-id ${filters.caseIds.join(',')}` : null,
    filters.tags?.length ? `tag ${filters.tags.join(',')}` : null,
    filters.intents?.length ? `intent ${filters.intents.join(',')}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  const rows = [
    ['Git', provenance.git?.sha ? `${provenance.git.sha.slice(0, 12)}${provenance.git.dirty ? ' (dirty working tree)' : ''}` : 'n/a'],
    ['Prompt version', short(provenance.promptVersion)],
    ['Schema scope', schemaScopeText(provenance.product?.schemaScope)],
    ['Hints version', describeHintsVersion(provenance.product?.hintsVersion)],
    [
      'Semantic layer version',
      `${short(provenance.semanticLayerVersion)}${provenance.semanticLayerOverlay ? ` (with overlay ${provenance.semanticLayerOverlay.path} ${short(provenance.semanticLayerOverlay.sha256)})` : ''}`,
    ],
    ['Schema version', short(provenance.schemaVersion)],
    ['Fixtures', (provenance.fixtures || []).map((fixture) => `${fixture.name} ${short(fixture.contentHash)}`).join(', ') || 'n/a'],
    ['Datasets', (provenance.datasets || []).map((dataset) => `${dataset.name} ${short(dataset.sha256)}`).join(', ') || 'n/a'],
    ['Controls', (provenance.controls || []).map((file) => `${file.path} ${short(file.sha256)}`).join(', ') || 'none'],
    ['Model / endpoint', `${provenance.model || report.model} @ ${provenance.llmEndpoint?.host || 'n/a'}`],
    ['Node', `${provenance.node || 'n/a'} (${provenance.platform || 'n/a'})`],
    [
      'Runner',
      `suite ${report.suite?.name || 'n/a'}; repeat ${runner.repeat ?? 'n/a'}; concurrency ${runner.concurrency ?? 'n/a'}; case timeout ${formatMs(runner.caseTimeoutMs)}; ` +
        `budget ${formatLimitUsd(runner.budgetUsd)}; retries ${runner.maxRetries ?? 'n/a'}; statement timeout ${formatMs(runner.statementTimeoutMs)}` +
        (filterText ? `; filters: ${filterText}` : ''),
    ],
  ];
  if (report.rescoredFrom) {
    rows.push(['Rescored from', `${report.rescoredFrom.path} (sha256 ${short(report.rescoredFrom.sha256)}, git ${short(report.rescoredFrom.gitSha, 10)})`]);
    if ('schemaScope' in report.rescoredFrom && !sameSchemaScope(report.rescoredFrom.schemaScope, provenance.product?.schemaScope)) {
      rows.push(['Recorded schema scope', `${schemaScopeText(report.rescoredFrom.schemaScope)} (recorded SQL re-judged with today's scope)`]);
    }
    if ('hintsVersion' in report.rescoredFrom && !sameHintsVersion(report.rescoredFrom.hintsVersion, provenance.product?.hintsVersion)) {
      rows.push([
        'Recorded hints version',
        `${describeHintsVersion(report.rescoredFrom.hintsVersion)} (recorded SQL re-judged with today's semantic plan; the prompts are not regenerated)`,
      ]);
    }
  }
  return ['## Provenance', '', table(['', ''], rows)].join('\n');
}

function legacySection(report, shown = displayedSummaries(report)) {
  const reliability = shown.reliability;
  if (!reliability) {
    return '';
  }
  if (noListedAnswerCase(shown)) {
    return ['## Legacy pooled reliability', '', `${NO_DEV_ANSWER_CASE} (the holdout is shown in aggregate, by split).`].join('\n');
  }
  return [
    '## Legacy pooled reliability',
    '',
    `${shown.hidden ? 'Dev cases only (the holdout is shown in aggregate, by split): p' : 'P'}ooled pass rate ${formatPercent(reliability.passRate)} over ` +
      `${reliability.totalAttempts} repetition(s), pooled Wilson 95% lower bound ${formatPercent(reliability.wilsonLower95)}. ` +
      'Kept for older consumers only: repetitions of one case are correlated, so the pooled bound overstates confidence. Use the case-level numbers above.',
  ].join('\n');
}

/**
 * Renders report.json as Markdown. Holdout results are shown in aggregate
 * only unless `revealHoldout` (see the holdout display policy above);
 * `holdoutSummary` adds one line for the comparison's paired holdout cases in
 * aggregate (holdoutPairSummary) to the comparison section, when there is
 * one, with or without revealHoldout.
 */
export function renderReportMarkdown(report, { revealHoldout = false, holdoutSummary = false } = {}) {
  const hidden = hiddenIds(report, { revealHoldout });
  const shown = displayedSummaries(report, hidden);
  const comparison = report.comparison ? displayedComparison(report.comparison, { revealHoldout }) : null;
  const holdout = holdoutSummary && report.comparison ? holdoutPairSummary(report.comparison) : null;
  const title = `# Evaluation report: ${report.suite?.name || report.dataset?.name || 'suite'} · ${report.model}${report.mode === 'rescore' ? ' (rescore)' : ''}`;
  const sections = [
    title,
    headline(report, hidden, shown, comparison),
    attributionSection(report, shown),
    confusionSection(report, shown),
    comparison ? comparisonSection(comparison, holdout) : '',
    behaviorSection(report, hidden, shown),
    casesSection(report, hidden),
    breakdownSection(report, hidden),
    costSection(report, hidden, shown),
    verificationSection(report),
    provenanceSection(report),
    legacySection(report, shown),
  ].filter(Boolean);
  return `${sections.join('\n\n')}\n`;
}

/**
 * Short console headline (a few lines). Unless `revealHoldout`, the holdout
 * is its accuracy by split, as in report.md: every other figure, the
 * comparison's included, covers the dev cases; `holdoutSummary` adds the
 * paired holdout cases in aggregate to the comparison, as in report.md.
 */
export function renderHeadline(report, { revealHoldout = false, holdoutSummary = false } = {}) {
  const stats = report.stats;
  // As in report.md: with holdout cases hidden, attribution and behaviour
  // cover the listed (dev) cases, so nothing hidden can be subtracted out.
  const hidden = hiddenIds(report, { revealHoldout });
  const shown = displayedSummaries(report, hidden);
  const attribution = shown.attribution;
  const usage = shown.usage;
  const buckets = attribution.repetitions.byBucket;
  const run = `${stats.repeat} repetition(s), ${report.model}${report.mode === 'rescore' ? ' [rescore, no LLM calls]' : ''}`;
  const dev = shown.accuracy;
  const lines = [
    ...(shown.hidden
      ? [
          `Strict accuracy ${formatPercent(stats.strictAccuracy.value)} over ${stats.cases.counted} cases (every split; no interval while the holdout is hidden), ${run}`,
          dev.cases.counted === 0
            ? 'Dev cases: no counted dev answer case in this run (the holdout is shown in aggregate, by split)'
            : `Dev cases: strict accuracy ${formatPercent(dev.strictAccuracy.value)} (95% CI ${formatInterval(dev.strictAccuracy.ci95)}) over ${dev.cases.counted} cases / ` +
              `${dev.cases.intents} intents; majority-pass ${dev.majority.passes}/${dev.majority.n} (Wilson 95% ${formatInterval(dev.majority.wilson95)}); ` +
              `intent-clustered ${formatPercent(dev.intentClustered.value)}`,
        ]
      : [
          `Strict accuracy ${formatPercent(stats.strictAccuracy.value)} (95% CI ${formatInterval(stats.strictAccuracy.ci95)}) over ${stats.cases.counted} cases / ${stats.cases.intents} intents, ${run}`,
          `Majority-pass cases ${stats.majority.passes}/${stats.majority.n} (Wilson 95% ${formatInterval(stats.majority.wilson95)}); intent-clustered ${formatPercent(stats.intentClustered.value)}`,
        ]),
    noListedAnswerCase(shown)
      ? `Attribution: ${NO_DEV_ANSWER_CASE.toLowerCase()} (the holdout is shown in aggregate, by split)`
      : `Attribution (repetitions${shown.hiddenAnswerCases > 0 ? ', dev cases' : ''}): pass ${buckets.pass || 0} · model ${buckets.model || 0} · system ${buckets.system || 0} ` +
        `(guardrail false rejections ${attribution.system.guardrailFalseRejections}, retrieval misses ${attribution.system.retrievalMisses}, ` +
        `known validator rejections ${attribution.system.knownValidatorRejections ?? 0}) · ` +
        `infra ${buckets.infra || 0} · skipped ${buckets.skipped || 0} · harness ${buckets.harness || 0}`,
    ...((stats.bySplit || []).length > 1
      ? [`By split: ${stats.bySplit.map((entry) => `${entry.key} ${formatPercent(entry.accuracy)} (${entry.cases})`).join(' · ')}`]
      : []),
    ...(behaviorSummaryText(shown) ? [`${behaviorSummaryText(shown)} (not in accuracy)`] : []),
    shown.hidden && shown.records.length === 0
      ? 'Cost: no dev case in this run (cost, latency and retries cover dev cases only while the holdout is hidden)'
      : `Cost${shown.hidden ? ' (dev cases)' : ''} ${formatUsd(usage.cost.total)} (${formatUsd(usage.cost.perQuestion, 5)}/question, ` +
        `${formatUsd(usage.cost.perCorrect, 5)}/correct) · ` +
        `latency p50 ${formatMs(usage.latency.questionWallMs.p50)} p95 ${formatMs(usage.latency.questionWallMs.p95)} · retry rate ${formatPercent(usage.retries.rate)}`,
  ];
  if (report.stopped) {
    lines.push(
      `Stopped early: ${report.stopped.reason}; ${cancelledText(report, hidden, shown)} (${shown.hidden ? 'holdout cases not counted; ' : ''}partial report).`
    );
  }
  if (report.comparison) {
    lines.push(renderComparisonConsole(report.comparison, { revealHoldout, holdoutSummary }));
  }
  return lines.join('\n');
}
