// report.md: the human-readable view of report.json, readable in a terminal
// and rendered on GitHub (plain Markdown tables, no HTML).

import { describeSchemaScope, sameSchemaScopeBehaviour } from '../schema-scope.js';
import { BUCKET_ORDER, EXCLUDED_OUTCOMES, OUTCOME_BUCKETS, OUTCOME_ORDER } from './attribution.js';
import { hiddenHoldoutNote, holdoutRecordIds } from './holdout.js';
import { summarizeBreakdowns } from './stats.js';

// Holdout display policy (src/eval/holdout.js): unless `revealHoldout` is
// set, report.md and the console show holdout results in aggregate only (the
// split breakdown): no per-case holdout rows, no holdout flip lists and no
// holdout ids in the comparison's lists. report.json keeps everything.

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

function headline(report, hidden = new Set()) {
  const stats = report.stats;
  const strict = stats.strictAccuracy;
  const date = report.generatedAt ? report.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'n/a';
  const lines = [];
  lines.push(
    `**Strict accuracy ${formatPercent(strict.value)}** (95% CI ${formatInterval(strict.ci95)}, case bootstrap) · ` +
      `${stats.cases.counted} cases · ${stats.cases.intents} intents · ${stats.repeat} repetition${stats.repeat === 1 ? '' : 's'} · ` +
      `${report.model} · ${date}`
  );
  lines.push('');
  lines.push(
    `Majority-pass cases ${stats.majority.passes}/${stats.majority.n} (Wilson 95% ${formatInterval(stats.majority.wilson95)}) · ` +
      `intent-clustered accuracy ${formatPercent(stats.intentClustered.value)} (95% CI ${formatInterval(stats.intentClustered.ci95)}, ${stats.intentClustered.intents} intents)`
  );
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
        'failures only. `--reveal-holdout` lists them.'
    );
  }
  if (report.behavior?.cases > 0) {
    lines.push('');
    lines.push(behaviorLine(report.behavior) + ' Not in strict accuracy (see Behaviour cases).');
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
      `**The run was stopped early**: ${report.stopped.reason}. ${report.stopped.cancelledCases?.length || 0} case(s) did not finish ` +
        '(outcome `cancelled`, excluded); the numbers cover only what finished.'
    );
  }
  if (report.mode === 'rescore' && report.rescoredFrom) {
    lines.push('');
    lines.push(
      `Rescored with zero LLM calls from \`${report.rescoredFrom.path}\` (generated ${report.rescoredFrom.generatedAt || 'n/a'}, ` +
        `sha256 ${short(report.rescoredFrom.sha256)}); cost and latency are the original run's.`
    );
  }
  if (report.comparison) {
    lines.push('');
    lines.push(comparisonLine(report.comparison));
  }
  return lines.join('\n');
}

const VERDICT_TEXT = {
  worse: 'significantly WORSE than the baseline',
  better: 'significantly better than the baseline',
  no_significant_difference: 'no significant difference from the baseline',
  no_paired_cases: 'no case could be paired with the baseline',
};

export function comparisonLine(comparison) {
  return (
    `vs baseline: Δ ${formatPoints(comparison.accuracy.delta)} (95% CI ${formatSignedInterval(comparison.accuracy.deltaCi95)}) on ` +
    `${comparison.paired} paired case(s); ${comparison.mcnemar.regressions} regression(s), ${comparison.mcnemar.improvements} improvement(s); ` +
    `exact McNemar p = ${comparison.mcnemar.p.toFixed(3)} → ${VERDICT_TEXT[comparison.verdict] || comparison.verdict}`
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

function flipList(entries, hidden = new Set()) {
  const listed = entries.filter((entry) => !hidden.has(entry.id));
  const holdout = entries.length - listed.length;
  const holdoutText = holdout > 0 ? `${holdout} holdout case(s) (not listed)` : '';
  if (listed.length === 0) {
    return holdoutText || 'none';
  }
  const shown = listed.slice(0, 12).map((entry) => `${entry.id} (${entry.baseline.outcome} → ${entry.candidate.outcome})`);
  return (
    `${shown.join(', ')}${listed.length > shown.length ? `, … ${listed.length - shown.length} more (report.md)` : ''}` +
    (holdoutText ? `; ${holdoutText}` : '')
  );
}

/**
 * The comparison as a few plain-text lines for the console: the paired 2x2
 * table of majority verdicts, the accuracy change, the exact McNemar p and
 * the flipped cases by id (holdout flips only counted, unless revealHoldout).
 */
export function renderComparisonConsole(comparison, { revealHoldout = false } = {}) {
  const hidden = comparisonHiddenIds(comparison, { revealHoldout });
  const contingency = contingencyOf(comparison);
  const width = Math.max(4, ...[contingency.bothPass, contingency.regressions, contingency.improvements, contingency.bothFail].map((value) => String(value).length));
  const row = (label, left, right) => `  ${label.padEnd(15)}${String(left).padStart(14 + width - 4)}${String(right).padStart(16 + width - 4)}`;
  const excluded = comparison.excluded || { goldChanged: [], notCounted: [] };
  const lines = [
    `Paired comparison with ${comparison.baseline.label || 'the baseline'}: ${comparison.paired} paired case(s)`,
    `  ${''.padEnd(15)}${'candidate pass'.padStart(14 + width - 4)}${'candidate fail'.padStart(16 + width - 4)}`,
    row('baseline pass', contingency.bothPass, contingency.regressions),
    row('baseline fail', contingency.improvements, contingency.bothFail),
    `  strict accuracy (paired cases) ${formatPercent(comparison.accuracy.baseline)} → ${formatPercent(comparison.accuracy.candidate)}: ` +
      `Δ ${formatPoints(comparison.accuracy.delta)} (95% CI ${formatSignedInterval(comparison.accuracy.deltaCi95)})`,
    `  exact McNemar p = ${comparison.mcnemar.p.toFixed(3)} (${comparison.mcnemar.regressions} regression(s), ${comparison.mcnemar.improvements} improvement(s)) → ` +
      `${VERDICT_TEXT[comparison.verdict] || comparison.verdict}`,
    `  regressions: ${flipList(comparison.flips.regressions, hidden)}`,
    `  improvements: ${flipList(comparison.flips.improvements, hidden)}`,
  ];
  if (!sameSchemaScope(comparison.baseline?.schemaScope, comparison.candidate?.schemaScope)) {
    lines.push(`  schema scope: ${schemaScopeText(comparison.baseline?.schemaScope)} → ${schemaScopeText(comparison.candidate?.schemaScope)}`);
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

function attributionSection(report) {
  const attribution = report.attribution;
  const lines = ['## Attribution', ''];
  lines.push(
    'Who caused each outcome. Repetitions are every (case, repetition) run; cases use each case\'s majority outcome. ' +
      'Excluded outcomes are not in the accuracy denominator.'
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
  // Excluded outcomes (repetitions of answer cases), and the abstain /
  // clarify cases, which are never in accuracy or in the tables above.
  const excluded = Object.entries(attribution.excluded);
  const behaviorCases = (report.results || []).filter((record) => record.expected_behavior && record.expected_behavior !== 'answer');
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
  lines.push('');
  lines.push(`Excluded from accuracy: ${parts.length > 0 ? parts.join('; ') : 'none'}.`);
  return lines.join('\n');
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

function confusionSection(report) {
  const matrix = report.attribution.guardrailConfusion;
  const lines = ['## Guardrail confusion matrix', ''];
  lines.push(
    'Every attempt, retries included. "Rejected" = a guardrail-layer rejection; correctness of rejected SQL is decided by re-running it ' +
      'read-only on every fixture (only after it passes the safety layer). An accepted attempt that failed at execution counts as incorrect.'
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
      rows.push([label, entry.key, entry.cases, formatPercent(entry.accuracy), `${entry.majorityPasses}/${entry.cases}`]);
    }
  }
  return [
    '## By split, failure class, difficulty and tag',
    '',
    ...(holdoutHidden ? ['Failure class, difficulty and tag rows cover the dev cases only (the holdout is shown in aggregate, by split).', ''] : []),
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

function behaviorSection(report, hidden = new Set()) {
  const behavior = report.behavior;
  if (!behavior || behavior.cases === 0) {
    return '';
  }
  const lines = ['## Behaviour cases (abstain / clarify)', '', behaviorLine(behavior), ''];
  lines.push(
    'These questions have no correct SQL: the data cannot answer them (abstain) or they are ambiguous (clarify). A case is handled when the ' +
      'product returned no SQL in more than half of its counted repetitions (`declined`); producing SQL is `answered_instead_of_abstain` / ' +
      '`answered_instead_of_clarify` (model bucket, tagged `not_executed` when the SQL was rejected or failed). The product has no ' +
      'abstention or clarification channel yet, so today it is expected to fail these. They are not in strict accuracy or the paired comparison.'
  );
  lines.push('');
  lines.push(
    table(
      ['Expected behaviour', 'Cases', 'Handled', 'Outcomes (majority)'],
      Object.entries(behavior.byBehavior).map(([name, entry]) => [
        name,
        entry.cases,
        `${entry.handled}/${entry.counted}`,
        Object.entries(entry.outcomes)
          .map(([outcome, count]) => `${outcome} ${count}`)
          .join(', '),
      ])
    )
  );
  const behaviorCases = report.results.filter((record) => record.expected_behavior && record.expected_behavior !== 'answer');
  const cases = behaviorCases.filter((record) => !hidden.has(record.id));
  if (cases.length > 0) {
    lines.push('');
    lines.push(
      table(
        ['Case', 'Question', 'Expects', 'Declined', 'Outcome'],
        cases.map((record) => [record.id, truncate(record.question, 60), record.expected_behavior, behaviorPassText(record.summary), record.summary?.outcome || record.status])
      )
    );
  }
  const note = hiddenHoldoutNote(behaviorCases.length - cases.length, 'behaviour case(s)');
  if (note) {
    lines.push('');
    lines.push(note);
  }
  return lines.join('\n');
}

function costSection(report, hidden = new Set()) {
  const { cost, latency, retries, tokens } = report.stats;
  const rows = [
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
  if (report.budget?.limitUsd != null) {
    // Skipped holdout cases are counted, not named (aggregate only).
    const skipped = report.budget.skippedCases || [];
    const listed = skipped.filter((id) => !hidden.has(id));
    const holdoutSkipped = skipped.length - listed.length;
    const names = [...listed, ...(holdoutSkipped > 0 ? [`${holdoutSkipped} holdout case(s)`] : [])].join(', ');
    rows.push(['Budget', `${formatUsd(report.budget.spentUsd)} of ${formatLimitUsd(report.budget.limitUsd)}${skipped.length ? `; ${skipped.length} case(s) skipped: ${names}` : ''}`]);
  }
  return ['## Cost, latency, retries, tokens', '', table(['Metric', 'Value'], rows)].join('\n');
}

function comparisonSection(comparison, { revealHoldout = false } = {}) {
  const hidden = comparisonHiddenIds(comparison, { revealHoldout });
  const visible = (entries) => entries.filter((entry) => !hidden.has(entry.id));
  const visibleIds = (ids) => ids.filter((id) => !hidden.has(id));
  const lines = ['## Comparison with the baseline', ''];
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
        ['Strict accuracy (paired cases)', formatPercent(comparison.accuracy.baseline), formatPercent(comparison.accuracy.candidate)],
        ['Majority passes (paired cases)', `${comparison.majority.baselinePasses}/${comparison.paired}`, `${comparison.majority.candidatePasses}/${comparison.paired}`],
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
  const holdoutFlips = [
    ['regression(s)', comparison.flips.regressions],
    ['improvement(s)', comparison.flips.improvements],
    ['pass-rate change(s) without a flip', comparison.rateChanges],
  ]
    .map(([label, entries]) => [label, entries.length - visible(entries).length])
    .filter(([, count]) => count > 0);
  if (holdoutFlips.length > 0) {
    lines.push('');
    lines.push(
      `Holdout cases in the comparison (aggregate only, not listed below): ${holdoutFlips.map(([label, count]) => `${count} ${label}`).join(', ')}. ` +
        '`--reveal-holdout` lists them.'
    );
  }
  for (const [title, all] of [
    ['Regressions (baseline majority pass → candidate fail)', comparison.flips.regressions],
    ['Improvements (baseline fail → candidate majority pass)', comparison.flips.improvements],
    ['Pass-rate changes without a flip', comparison.rateChanges],
  ]) {
    const entries = visible(all);
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
  // Lists with their holdout ids counted, not named.
  const named = (count, ids) => (count > ids.length ? `${ids.length ? `${ids.join(', ')}, and ` : ''}${count - ids.length} holdout case(s)` : ids.join(', '));
  const goldChanged = visible(comparison.excluded.goldChanged);
  if (comparison.excluded.goldChanged.length) {
    notes.push(`Excluded, gold changed: ${named(comparison.excluded.goldChanged.length, goldChanged.map((entry) => `${entry.id} (${entry.reason})`))}.`);
  }
  const notCounted = visible(comparison.excluded.notCounted);
  if (comparison.excluded.notCounted.length) {
    notes.push(
      `Excluded from the paired test (not counted, or a timeout/infrastructure majority, in one report): ${named(comparison.excluded.notCounted.length, notCounted.map((entry) => `${entry.id} (baseline ${entry.baseline}, candidate ${entry.candidate})`))}.`
    );
  }
  if (comparison.newCases.length) {
    notes.push(`New cases (not in the baseline): ${named(comparison.newCases.length, visibleIds(comparison.newCases))}.`);
  }
  if (comparison.removedCases.length) {
    notes.push(`Baseline cases not in this run: ${comparison.removedCases.length} (${truncate(named(comparison.removedCases.length, visibleIds(comparison.removedCases)), 300)}).`);
  }
  if (notes.length) {
    lines.push('');
    lines.push(...notes.flatMap((note) => [note, '']).slice(0, -1));
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
    ['Semantic layer version', short(provenance.semanticLayerVersion)],
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
  }
  return ['## Provenance', '', table(['', ''], rows)].join('\n');
}

function legacySection(report) {
  const reliability = report.reliability;
  if (!reliability) {
    return '';
  }
  return [
    '## Legacy pooled reliability',
    '',
    `Pooled pass rate ${formatPercent(reliability.passRate)} over ${reliability.totalAttempts} repetition(s), pooled Wilson 95% lower bound ${formatPercent(reliability.wilsonLower95)}. ` +
      'Kept for older consumers only: repetitions of one case are correlated, so the pooled bound overstates confidence. Use the case-level numbers above.',
  ].join('\n');
}

/**
 * Renders report.json as Markdown. Holdout results are shown in aggregate
 * only unless `revealHoldout` (see the holdout display policy above).
 */
export function renderReportMarkdown(report, { revealHoldout = false } = {}) {
  const hidden = hiddenIds(report, { revealHoldout });
  const title = `# Evaluation report: ${report.suite?.name || report.dataset?.name || 'suite'} · ${report.model}${report.mode === 'rescore' ? ' (rescore)' : ''}`;
  const sections = [
    title,
    headline(report, hidden),
    attributionSection(report),
    confusionSection(report),
    report.comparison ? comparisonSection(report.comparison, { revealHoldout }) : '',
    behaviorSection(report, hidden),
    casesSection(report, hidden),
    breakdownSection(report, hidden),
    costSection(report, hidden),
    verificationSection(report),
    provenanceSection(report),
    legacySection(report),
  ].filter(Boolean);
  return `${sections.join('\n\n')}\n`;
}

/** Short console headline (a few lines); holdout flips only counted unless `revealHoldout`. */
export function renderHeadline(report, { revealHoldout = false } = {}) {
  const stats = report.stats;
  const attribution = report.attribution;
  const buckets = attribution.repetitions.byBucket;
  const lines = [
    `Strict accuracy ${formatPercent(stats.strictAccuracy.value)} (95% CI ${formatInterval(stats.strictAccuracy.ci95)}) over ${stats.cases.counted} cases / ${stats.cases.intents} intents, ` +
      `${stats.repeat} repetition(s), ${report.model}${report.mode === 'rescore' ? ' [rescore, no LLM calls]' : ''}`,
    `Majority-pass cases ${stats.majority.passes}/${stats.majority.n} (Wilson 95% ${formatInterval(stats.majority.wilson95)}); intent-clustered ${formatPercent(stats.intentClustered.value)}`,
    `Attribution (repetitions): pass ${buckets.pass || 0} · model ${buckets.model || 0} · system ${buckets.system || 0} ` +
      `(guardrail false rejections ${attribution.system.guardrailFalseRejections}, retrieval misses ${attribution.system.retrievalMisses}, ` +
      `known validator rejections ${attribution.system.knownValidatorRejections ?? 0}) · ` +
      `infra ${buckets.infra || 0} · skipped ${buckets.skipped || 0} · harness ${buckets.harness || 0}`,
    ...((stats.bySplit || []).length > 1
      ? [`By split: ${stats.bySplit.map((entry) => `${entry.key} ${formatPercent(entry.accuracy)} (${entry.cases})`).join(' · ')}`]
      : []),
    ...(report.behavior?.cases > 0 ? [`${behaviorLine(report.behavior)} (not in accuracy)`] : []),
    `Cost ${formatUsd(stats.cost.total)} (${formatUsd(stats.cost.perQuestion, 5)}/question, ${formatUsd(stats.cost.perCorrect, 5)}/correct) · ` +
      `latency p50 ${formatMs(stats.latency.questionWallMs.p50)} p95 ${formatMs(stats.latency.questionWallMs.p95)} · retry rate ${formatPercent(stats.retries.rate)}`,
  ];
  if (report.stopped) {
    lines.push(`Stopped early: ${report.stopped.reason}; ${report.stopped.cancelledCases?.length || 0} case(s) did not finish (partial report).`);
  }
  if (report.comparison) {
    lines.push(renderComparisonConsole(report.comparison, { revealHoldout }));
  }
  return lines.join('\n');
}
