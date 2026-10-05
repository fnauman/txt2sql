// report.md: the human-readable view of report.json, readable in a terminal
// and rendered on GitHub (plain Markdown tables, no HTML).

import { BUCKET_ORDER, EXCLUDED_OUTCOMES, OUTCOME_BUCKETS, OUTCOME_ORDER } from './attribution.js';

const BUCKET_LABELS = {
  pass: 'pass',
  model: 'model errors',
  system: 'system errors (guardrail false rejections, retrieval misses)',
  infra: 'infrastructure (timeouts, DB/provider failures)',
  skipped: 'skipped (budget)',
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

function headline(report) {
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
  if (stats.cases.excluded > 0) {
    lines.push('');
    lines.push(
      `${stats.cases.excluded} of ${stats.cases.selected} selected case(s) had no counted repetition and are left out of accuracy (see Attribution).`
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
      `${attribution.system.retrievalMisses} retrieval miss(es) (a failure where an expected table was not retrieved, so not allowed). ` +
      'A model-bucket failure tagged retrieval_miss is counted as a system error.'
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
  const excluded = Object.entries(attribution.excluded);
  lines.push('');
  lines.push(
    excluded.length > 0
      ? `Excluded from accuracy: ${excluded.map(([outcome, count]) => `${outcome} ${count}`).join(', ')}.`
      : 'Excluded from accuracy: none.'
  );
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

function breakdownSection(report) {
  const stats = report.stats;
  const rows = [];
  for (const [label, entries] of [
    ['failure_class', stats.byFailureClass],
    ['difficulty', stats.byDifficulty],
    ['tag', stats.byTag],
  ]) {
    for (const entry of entries) {
      rows.push([label, entry.key, entry.cases, formatPercent(entry.accuracy), `${entry.majorityPasses}/${entry.cases}`]);
    }
  }
  return ['## By failure class, difficulty and tag', '', table(['Group', 'Value', 'Cases', 'Accuracy', 'Majority passes'], rows) || 'No counted cases.'].join('\n');
}

function casesSection(report) {
  const rows = report.results.map((record) => [
    record.id,
    truncate(record.question, 60),
    passRateText(record.summary),
    record.summary?.outcome || record.status,
    [record.summary?.bucket, ...(record.summary?.tags || [])].filter(Boolean).join(', '),
  ]);
  return ['## Cases', '', table(['Case', 'Question', 'Passes', 'Outcome', 'Attribution'], rows)].join('\n');
}

function costSection(report) {
  const { cost, latency, retries, tokens } = report.stats;
  const rows = [
    ['Total LLM cost', `${formatUsd(cost.total)}${cost.questionsWithoutCost ? ` (${cost.questionsWithoutCost} question(s) without a price)` : ''}`],
    ['Cost per question', formatUsd(cost.perQuestion, 5)],
    ['Cost per correct answer', formatUsd(cost.perCorrect, 5)],
    ['Question latency p50 / p95 (wall)', `${formatMs(latency.questionWallMs.p50)} / ${formatMs(latency.questionWallMs.p95)} (n=${latency.questionWallMs.n})`],
    ['LLM call latency p50 / p95', `${formatMs(latency.llmCallMs.p50)} / ${formatMs(latency.llmCallMs.p95)} (n=${latency.llmCallMs.n})`],
    [
      'Retry rate',
      `${formatPercent(retries.rate)} of questions (${retries.questionsWithRetry}/${retries.questions}); ${retries.retryCalls} of ${retries.llmCalls} LLM calls were retries`,
    ],
    ['Tokens', `prompt ${formatCount(tokens.prompt)} (cached ${formatCount(tokens.cached)}) · completion ${formatCount(tokens.completion)}`],
  ];
  if (report.budget?.limitUsd != null) {
    rows.push([
      'Budget',
      `${formatUsd(report.budget.spentUsd)} of ${formatLimitUsd(report.budget.limitUsd)}${
        report.budget.skippedCases.length ? `; ${report.budget.skippedCases.length} case(s) skipped: ${report.budget.skippedCases.join(', ')}` : ''
      }`,
    ]);
  }
  return ['## Cost, latency, retries, tokens', '', table(['Metric', 'Value'], rows)].join('\n');
}

function comparisonSection(comparison) {
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
        ['Strict accuracy (paired cases)', formatPercent(comparison.accuracy.baseline), formatPercent(comparison.accuracy.candidate)],
        ['Majority passes (paired cases)', `${comparison.majority.baselinePasses}/${comparison.paired}`, `${comparison.majority.candidatePasses}/${comparison.paired}`],
      ]
    )
  );
  lines.push('');
  lines.push(comparisonLine(comparison));
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
  const rows = verification.datasets
    .filter((dataset) => dataset.controls)
    .map((dataset) => [
      dataset.name,
      `${dataset.controls.design.killed}/${dataset.controls.design.total} (${formatPercent(dataset.controls.design.rate)})`,
      `${dataset.controls.heldout.killed}/${dataset.controls.heldout.total} (${formatPercent(dataset.controls.heldout.rate)})`,
      `${dataset.controls.design.seedOnlyKilled}/${dataset.controls.design.total}`,
      `${dataset.controls.positive.matched}/${dataset.controls.positive.total} match, ${dataset.controls.positive.validatorAccepted} accepted`,
    ]);
  if (rows.length) {
    lines.push('');
    lines.push(table(['Dataset', 'Design kill rate', 'Held-out kill rate', 'Killed on seed alone', 'Positive controls'], rows));
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

/** Renders report.json as Markdown. */
export function renderReportMarkdown(report) {
  const title = `# Evaluation report: ${report.suite?.name || report.dataset?.name || 'suite'} · ${report.model}${report.mode === 'rescore' ? ' (rescore)' : ''}`;
  const sections = [
    title,
    headline(report),
    attributionSection(report),
    confusionSection(report),
    report.comparison ? comparisonSection(report.comparison) : '',
    casesSection(report),
    breakdownSection(report),
    costSection(report),
    verificationSection(report),
    provenanceSection(report),
    legacySection(report),
  ].filter(Boolean);
  return `${sections.join('\n\n')}\n`;
}

/** Short console headline (a few lines). */
export function renderHeadline(report) {
  const stats = report.stats;
  const attribution = report.attribution;
  const buckets = attribution.repetitions.byBucket;
  const lines = [
    `Strict accuracy ${formatPercent(stats.strictAccuracy.value)} (95% CI ${formatInterval(stats.strictAccuracy.ci95)}) over ${stats.cases.counted} cases / ${stats.cases.intents} intents, ` +
      `${stats.repeat} repetition(s), ${report.model}${report.mode === 'rescore' ? ' [rescore, no LLM calls]' : ''}`,
    `Majority-pass cases ${stats.majority.passes}/${stats.majority.n} (Wilson 95% ${formatInterval(stats.majority.wilson95)}); intent-clustered ${formatPercent(stats.intentClustered.value)}`,
    `Attribution (repetitions): pass ${buckets.pass || 0} · model ${buckets.model || 0} · system ${buckets.system || 0} ` +
      `(guardrail false rejections ${attribution.system.guardrailFalseRejections}, retrieval misses ${attribution.system.retrievalMisses}) · ` +
      `infra ${buckets.infra || 0} · skipped ${buckets.skipped || 0} · harness ${buckets.harness || 0}`,
    `Cost ${formatUsd(stats.cost.total)} (${formatUsd(stats.cost.perQuestion, 5)}/question, ${formatUsd(stats.cost.perCorrect, 5)}/correct) · ` +
      `latency p50 ${formatMs(stats.latency.questionWallMs.p50)} p95 ${formatMs(stats.latency.questionWallMs.p95)} · retry rate ${formatPercent(stats.retries.rate)}`,
  ];
  if (report.comparison) {
    lines.push(comparisonLine(report.comparison));
  }
  return lines.join('\n');
}
