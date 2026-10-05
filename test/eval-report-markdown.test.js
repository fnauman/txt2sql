import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { compareReports } from '../src/eval/compare.js';
import { cell, renderHeadline, renderReportMarkdown, truncate } from '../src/eval/report-markdown.js';
import { attributeCaseRuns, buildReport } from '../src/eval/runner.js';

const testCase = (id, question, extra = {}) =>
  normalizeBenchmarkCase({ id, question, expected_sql: `SELECT '${id}'`, expected_tables: ['Customer'], intentId: extra.intentId || id, ...extra });

const attempt = (ok, extra = {}) => ({
  attempt: 1,
  retry: false,
  generatedSql: 'SELECT 1',
  llm: { ok: true, durationMs: 1200, usage: null, cost: null },
  validation: ok ? { ok: true, durationMs: 1, tablesUsed: ['Customer'] } : { ok: false, durationMs: 1, code: 'FAN_OUT', layer: 'guardrail', message: 'x' },
  execution: ok ? { ok: true, durationMs: 1, rowCount: 1, truncated: false } : null,
  ...extra,
});
const rep = (status, attempts, extra = {}) => ({
  status,
  warnings: [],
  retrieved_tables: ['Customer'],
  attempts,
  attempt_count: attempts.length,
  llm_usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
  llm_cost: { totalCost: 0.0002 },
  timings: { totalMs: 2500 },
  ...extra,
});

async function sampleReport({ mode = 'run', comparisonWith = null } = {}) {
  const runs = [
    { entry: { testCase: testCase('case_pass', 'How many customers?', { tags: ['count'], difficulty: 'easy' }), datasets: ['core'] }, repetitions: [rep('pass', [attempt(true)]), rep('pass', [attempt(true)])] },
    {
      entry: { testCase: testCase('case_pipe', 'Revenue | by brand, a very long question that keeps going and going past the cut-off', { failure_class: 'grain_confusion' }), datasets: ['edge'] },
      repetitions: [rep('result_mismatch', [attempt(true)]), rep('pass', [attempt(true)])],
    },
    {
      entry: { testCase: testCase('case_guard', 'Products sold in Feb but not March?'), datasets: ['core'] },
      repetitions: [
        rep('validation_error', [attempt(false, { guardrailCheck: { verdict: 'false_rejection', matchedGold: 'expected_sql' } })]),
        rep('validation_error', [attempt(false, { guardrailCheck: { verdict: 'false_rejection', matchedGold: 'expected_sql' } })]),
      ],
    },
    { entry: { testCase: testCase('case_skip', 'Skipped?'), datasets: ['core'] }, repetitions: [rep('skipped_budget', [], { llm_cost: null, llm_usage: null }), rep('skipped_budget', [], { llm_cost: null, llm_usage: null })] },
  ];
  const caseRecords = await attributeCaseRuns(runs, { checkGuardrails: false });
  const candidate = { results: caseRecords, model: 'gpt-4o-mini', generatedAt: '2026-10-05T10:00:00.000Z', mode };
  const comparison = comparisonWith ? compareReports(comparisonWith, candidate, { baselineLabel: 'eval/baselines/gpt-4o-mini.json', resamples: 200 }) : null;
  return buildReport({
    mode,
    generatedAt: '2026-10-05T10:00:00.000Z',
    runTimestamp: '2026-10-05T10-00-00.000Z',
    model: 'gpt-4o-mini',
    schemaPath: 'generated/schema.json',
    suite: { name: 'all', datasets: [{ name: 'core', path: 'datasets/core.json' }, { name: 'edge', path: 'datasets/edge.json' }], totalCaseCount: 5, uniqueCaseCount: 4, selectedCaseCount: 4, duplicates: [], filters: { split: 'all', caseIds: [], tags: [], intents: [] } },
    oracle: { fixtures: [{ name: 'seed', database: 'demo_retail', status: 'current', action: 'checked' }], maxRetries: 1, statementTimeoutMs: 8000, goldTimeoutMs: 30000 },
    runner: { repeat: 2, concurrency: 4, caseTimeoutMs: 120000, budgetUsd: 0.001, maxRetries: 1, statementTimeoutMs: 8000 },
    provenance: {
      git: { sha: '0123456789abcdef0123', dirty: true },
      promptVersion: 'a'.repeat(64),
      semanticLayerVersion: 'b'.repeat(64),
      schemaVersion: 'c'.repeat(64),
      fixtures: [{ name: 'seed', contentHash: 'd'.repeat(64) }],
      datasets: [{ name: 'core', sha256: 'e'.repeat(64) }],
      controls: [],
      model: 'gpt-4o-mini',
      llmEndpoint: { host: 'api.openai.com' },
      node: 'v24.0.0',
      platform: 'linux-x64',
    },
    verification: { skipped: false, cases: 4, problems: [], gateFailures: [], datasets: [] },
    budget: { limitUsd: 0.001, spentUsd: 0.0012, exhausted: true, skippedCases: ['case_skip'] },
    caseRecords,
    comparison,
    rescoredFrom: mode === 'rescore' ? { path: 'eval/baselines/gpt-4o-mini.json', sha256: 'f'.repeat(64), generatedAt: '2026-10-01T00:00:00.000Z', gitSha: 'abc' } : null,
    traceFile: null,
    statsOptions: { resamples: 200 },
  });
}

test('report.md has the headline, attribution, confusion matrix, cases, costs and provenance', async () => {
  const report = await sampleReport();
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /^# Evaluation report: all · gpt-4o-mini\n/);
  assert.match(markdown, /\*\*Strict accuracy 50\.0%\*\* \(95% CI [\d.]+%–[\d.]+%, case bootstrap\) · 3 cases · 3 intents · 2 repetitions · gpt-4o-mini · 2026-10-05 10:00:00 UTC/);
  assert.match(markdown, /Majority-pass cases 1\/3 \(Wilson 95% /);
  assert.match(markdown, /1 of 4 selected case\(s\) had no counted repetition/);
  for (const heading of ['## Attribution', '## Guardrail confusion matrix', '## Cases', '## By failure class, difficulty and tag', '## Cost, latency, retries, tokens', '## Verification', '## Provenance', '## Legacy pooled reliability']) {
    assert.ok(markdown.includes(`\n${heading}\n`), heading);
  }
  assert.match(markdown, /\| system errors \(guardrail false rejections, retrieval misses\) \| 2 \| 1 \|/);
  assert.match(markdown, /\| skipped_budget \| skipped \| 2 \| 1 \| excluded \|/);
  assert.match(markdown, /\| Rejected by a guardrail \| 2 \(false rejection\) \| 0 \(caught\) \|/);
  assert.match(markdown, /\| case_guard \| Products sold in Feb but not March\? \| 0\/2 \| guardrail_false_rejection \| system \|/);
  assert.match(markdown, /\| case_skip \| Skipped\? \| excluded \| skipped_budget \| skipped \|/);
  // Pipes in a question are escaped and long questions are cut.
  assert.match(markdown, /\| case_pipe \| Revenue \\\| by brand, a very long question that keeps going a… \| 1\/2 \|/);
  assert.match(markdown, /\| failure_class \| grain_confusion \| 1 \| 50\.0% \| 0\/1 \|/);
  assert.match(markdown, /\| Total LLM cost \| \$0\.0012 \|/);
  assert.match(markdown, /\| Budget \| \$0\.0012 of \$0\.0010; 1 case\(s\) skipped: case_skip \|/);
  assert.match(markdown, /\| Runner \| suite all; repeat 2; concurrency 4; case timeout 120\.00 s; budget \$0\.0010; retries 1; statement timeout 8\.00 s \|/);
  assert.match(markdown, /\| Git \| 0123456789ab \(dirty working tree\) \|/);
  assert.match(markdown, /\| Prompt version \| aaaaaaaaaaaa \|/);
  assert.match(markdown, /\| Model \/ endpoint \| gpt-4o-mini @ api\.openai\.com \|/);
  assert.doesNotMatch(markdown, /## Comparison with the baseline/);
  assert.ok(markdown.endsWith('\n'));
});

test('a comparison section lists flips and the McNemar verdict; a rescore says where it came from', async () => {
  const baseline = await sampleReport();
  // The baseline had case_guard passing every time.
  baseline.results = baseline.results.map((record) =>
    record.id === 'case_guard' ? { ...record, summary: { ...record.summary, passes: 2, passRate: 1, majorityPass: true, outcome: 'pass' } } : record
  );
  const report = await sampleReport({ mode: 'rescore', comparisonWith: baseline });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /^# Evaluation report: all · gpt-4o-mini \(rescore\)/);
  assert.match(markdown, /Rescored with zero LLM calls from `eval\/baselines\/gpt-4o-mini\.json`/);
  assert.match(markdown, /\n## Comparison with the baseline\n/);
  assert.match(markdown, /### Regressions \(baseline majority pass → candidate fail\)\n\n\| Case \| Question \| Baseline \| Candidate \|/);
  assert.match(markdown, /\| case_guard \| Products sold in Feb but not March\? \| 100% \(pass\) \| 0% \(guardrail_false_rejection\) \|/);
  assert.match(markdown, /1 regression\(s\), 0 improvement\(s\); exact McNemar p = 1\.000 → no significant difference from the baseline/);
  assert.match(markdown, /Excluded from the paired test \(not counted, or a timeout\/infrastructure majority, in one report\): case_skip/);

  // The paired 2x2 table of majority verdicts.
  assert.match(markdown, /\| Baseline pass \| 1 \| 1 \(regressions\) \|\n\| Baseline fail \| 0 \(improvements\) \| 1 \|/);

  const headline = renderHeadline(report);
  // Four summary lines, then the paired comparison block.
  assert.match(headline.split('\n')[4], /^Paired comparison with eval\/baselines\/gpt-4o-mini\.json: 3 paired case\(s\)$/);
  assert.match(headline, /\n {17}candidate pass {2}candidate fail\n {2}baseline pass {15}1 {15}1\n {2}baseline fail {15}0 {15}1\n/);
  assert.match(headline, /exact McNemar p = 1\.000 \(1 regression\(s\), 0 improvement\(s\)\) → no significant difference from the baseline/);
  assert.match(headline, /regressions: case_guard \(pass → guardrail_false_rejection\)\n {2}improvements: none\n {2}not paired: 1 not counted or timed out in one report/);
  assert.match(headline, /^Strict accuracy 50\.0% \(95% CI .*\) over 3 cases \/ 3 intents, 2 repetition\(s\), gpt-4o-mini \[rescore, no LLM calls\]/);
  assert.match(headline, /system 2 \(guardrail false rejections 2, retrieval misses 0\)/);
});

test('cell escaping and truncation', () => {
  assert.equal(cell('a|b\nc'), 'a\\|b c');
  assert.equal(cell(null), '');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('  a   b  ', 10), 'a b');
});

test('the outcome table splits an outcome whose repetitions moved buckets, and names unknown attempts', async () => {
  const report = await sampleReport();
  report.attribution.byOutcomeBucket.wrong_result = { model: 1, system: 1 };
  report.attribution.system.guardrailFalseRejectionsElsewhere = 1;
  report.attribution.system.guardrailUnverified = 2;
  report.attribution.guardrailConfusion.unknown = 3;
  report.attribution.guardrailConfusion.unknownBy = { unsafe: 1, checkFailed: 2, unchecked: 0, infra: 0, notFinal: 0 };
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /\| wrong_result \| model 1 \/ system 1 \| 1 \| 1 \| counted \|/);
  assert.match(markdown, /\| pass \| pass \| 3 \|/);
  assert.match(markdown, /1 more repetition\(s\) had a guardrail false rejection but ended in another outcome/);
  assert.match(markdown, /2 repetition\(s\) with a guardrail rejection that could not be re-checked/);
  assert.match(markdown, /unknown 3 \(rejected SQL fails the safety layer now, not run 1, re-check failed 2\)/);
});

test('the Verification section counts undecided, invalid and unscored controls per dataset', async () => {
  const report = await sampleReport();
  const group = (killed, total, extra = {}) => ({ total, killed, rate: total ? killed / total : null, seedOnlyKilled: killed, seedOnlyRate: null, survivors: [], undecided: [], invalid: [], unscored: [], executionErrors: 0, ...extra });
  report.verification = {
    skipped: false,
    cases: 2,
    problems: [{ id: 'c1', datasets: ['core'], problems: ['negative control m2 is invalid: it fails to execute'] }],
    gateFailures: [],
    controlStatus: { undecided: ['c1/m3'], invalid: ['c1/m2'], unscored: ['c2/h1'] },
    datasets: [
      {
        name: 'core',
        cases: 2,
        failures: 1,
        controls: {
          design: group(1, 3, { undecided: ['c1/m3 (cancel)'], invalid: ['c1/m2 (v2: ER_BAD_FIELD_ERROR)'] }),
          heldout: group(0, 1, { unscored: ['c2/h1 (seed: ECONNRESET)'] }),
          positive: { total: 1, matched: 1, validatorAccepted: 1 },
        },
      },
      // A summary from before the statuses existed shows n/a, not 0.
      { name: 'legacy', cases: 1, failures: 0, controls: { design: { total: 1, killed: 1, rate: 1, seedOnlyKilled: 1 }, heldout: { total: 0, killed: 0, rate: null }, positive: { total: 0, matched: 0, validatorAccepted: 0 } } },
    ],
  };
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /\| Dataset \| Design kill rate \| Held-out kill rate \| Killed on seed alone \| Undecided \| Invalid \| Unscored \| Positive controls \|/);
  assert.match(markdown, /\| core \| 1\/3 \(33\.3%\) \| 0\/1 \(0\.0%\) \| 1\/3 \| 1 \| 1 \| 1 \| 1\/1 match, 1 accepted \|/);
  assert.match(markdown, /\| legacy \| 1\/1 \(100\.0%\) \| 0\/0 \(n\/a\) \| 1\/1 \| n\/a \| n\/a \| n\/a \|/);
  assert.match(markdown, /Invalid controls \(fail to execute; a problem, not a kill\): c1\/m2\./);
  assert.match(markdown, /Unscored controls \(infrastructure error; a problem, not a kill\): c2\/h1\./);
  assert.match(markdown, /Undecided controls \(mapping search cut off; counted as not killed\): c1\/m3\./);
});
