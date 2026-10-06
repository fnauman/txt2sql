import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { compareReports } from '../src/eval/compare.js';
import { renderComparisonConsole, renderHeadline, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { attributeCaseRuns, buildReport } from '../src/eval/runner.js';

// Holdout display policy (measurement hygiene): report.md and the console
// show holdout results in aggregate only (accuracy by split) unless
// --reveal-holdout: no per-case holdout rows, no holdout flip lists, no
// holdout ids in the comparison's lists, and the finer breakdowns cover dev
// cases only. report.json keeps everything.

const attempt = { attempt: 1, retry: false, generatedSql: 'SELECT 1', llm: { ok: true, durationMs: 1000 }, validation: { ok: true, durationMs: 1 }, execution: { ok: true, durationMs: 1, rowCount: 1 } };
const rep = (status) => ({ status, warnings: [], retrieved_tables: ['Customer'], attempts: [attempt], attempt_count: 1, timings: { totalMs: 1000 } });
const testCase = (id, extra = {}) =>
  normalizeBenchmarkCase({ id, intentId: id, question: `Question ${id}?`, expected_sql: `SELECT '${id}'`, expected_tables: ['Customer'], ...extra });

async function reportWith(outcomes, { comparisonWith = null } = {}) {
  const definitions = {
    dev_pass: testCase('dev_pass', { tags: ['shared'] }),
    dev_flip: testCase('dev_flip', { tags: ['shared'], failure_class: 'grain_confusion' }),
    secret_holdout_case: testCase('secret_holdout_case', { split: 'holdout', tags: ['shared', 'holdout_only_tag'], failure_class: 'holdout_only_class' }),
    secret_holdout_abstain: normalizeBenchmarkCase({ id: 'secret_holdout_abstain', question: 'Weather?', split: 'holdout', expected_behavior: 'abstain' }),
  };
  const caseRecords = await attributeCaseRuns(
    Object.entries(outcomes).map(([id, statuses]) => ({ entry: { testCase: definitions[id], datasets: ['d'] }, repetitions: statuses.map(rep) })),
    { checkGuardrails: false }
  );
  const candidate = { results: caseRecords, model: 'm', generatedAt: '2026-10-06T00:00:00.000Z', mode: 'run' };
  return buildReport({
    mode: 'run',
    generatedAt: '2026-10-06T00:00:00.000Z',
    runTimestamp: 't',
    model: 'm',
    schemaPath: 'generated/schema.json',
    suite: { name: 'all', datasets: [], filters: { split: 'all', caseIds: [], tags: [], intents: [] } },
    oracle: { fixtures: [], maxRetries: 1 },
    runner: { repeat: 1 },
    provenance: {},
    verification: null,
    budget: null,
    caseRecords,
    comparison: comparisonWith ? compareReports(comparisonWith, candidate, { baselineLabel: 'baseline.json', resamples: 50 }) : null,
    traceFile: null,
    statsOptions: { resamples: 50 },
  });
}

const BASELINE_OUTCOMES = { dev_pass: ['pass'], dev_flip: ['pass'], secret_holdout_case: ['pass'], secret_holdout_abstain: ['answered'] };
const CANDIDATE_OUTCOMES = { dev_pass: ['pass'], dev_flip: ['result_mismatch'], secret_holdout_case: ['result_mismatch'], secret_holdout_abstain: ['answered'] };

test('report.md shows the holdout in aggregate only by default, and every case with revealHoldout', async () => {
  const baseline = await reportWith(BASELINE_OUTCOMES);
  const report = await reportWith(CANDIDATE_OUTCOMES, { comparisonWith: baseline });
  assert.deepEqual(report.comparison.holdoutCases, ['secret_holdout_case']);
  assert.deepEqual(report.comparison.flips.regressions.map((entry) => [entry.id, entry.split]), [['dev_flip', 'dev'], ['secret_holdout_case', 'holdout']]);

  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /secret_holdout/, 'no holdout id anywhere');
  assert.doesNotMatch(markdown, /Question secret_holdout_case|Weather\?/, 'no holdout question anywhere');
  assert.doesNotMatch(markdown, /holdout_only_(tag|class)/, 'the finer breakdowns cover dev cases only');
  // Aggregates stay: the split line and rows, the headline note.
  assert.match(markdown, /By split: dev 50\.0% \(2 cases\) · holdout 0\.0% \(1 case\)\./);
  assert.match(markdown, /\| split \| holdout \| 1 \| 0\.0% \| 0\/1 \|/);
  assert.match(markdown, /Holdout: 2 case\(s\), shown in aggregate only \(accuracy by split\)/);
  assert.match(markdown, /Failure class, difficulty and tag rows cover the dev cases only/);
  assert.match(markdown, /\| tag \| shared \| 2 \| 50\.0% \| 1\/2 \|/);
  // Cases, behaviour cases and flips list dev cases and count the holdout ones.
  assert.match(markdown, /\| dev_flip \| Question dev_flip\? \|/);
  assert.match(markdown, /\n2 holdout case\(s\) not listed: holdout results are shown in aggregate only/);
  assert.match(markdown, /1 holdout behaviour case\(s\) not listed/);
  assert.match(markdown, /Holdout cases in the comparison \(aggregate only, not listed below\): 1 regression\(s\)\./);
  assert.match(markdown, /### Regressions \(baseline majority pass → candidate fail\)\n\n\| Case \| Question \| Baseline \| Candidate \|\n\| --- \| --- \| --- \| --- \|\n\| dev_flip \|[^\n]*\n\n/);

  const revealed = renderReportMarkdown(report, { revealHoldout: true });
  assert.match(revealed, /\| secret_holdout_case \| Question secret_holdout_case\? \|/);
  assert.match(revealed, /\| secret_holdout_abstain \| Weather\? \|/);
  assert.match(revealed, /\| tag \| holdout_only_tag \| 1 \|/);
  assert.doesNotMatch(revealed, /shown in aggregate only|not listed/);
  assert.equal((revealed.match(/\| secret_holdout_case \|/g) || []).length, 2, 'the cases table and the regressions table');
});

test('the console lists dev flips and counts holdout flips; revealHoldout lists them', async () => {
  const baseline = await reportWith(BASELINE_OUTCOMES);
  const report = await reportWith(CANDIDATE_OUTCOMES, { comparisonWith: baseline });
  const console = renderHeadline(report);
  assert.doesNotMatch(console, /secret_holdout/);
  assert.match(console, /regressions: dev_flip \(pass → wrong_result\); 1 holdout case\(s\) \(not listed\)/);
  assert.match(console, /improvements: none/);
  assert.match(console, /By split: dev 50\.0% \(2\) · holdout 0\.0% \(1\)/);
  assert.match(renderHeadline(report, { revealHoldout: true }), /regressions: dev_flip \(pass → wrong_result\), secret_holdout_case \(pass → wrong_result\)\n/);
  // Only holdout flips: counted, never named.
  const onlyHoldout = { ...report.comparison, flips: { regressions: report.comparison.flips.regressions.slice(1), improvements: [] } };
  assert.match(renderComparisonConsole(onlyHoldout), /regressions: 1 holdout case\(s\) \(not listed\)\n/);
});

test('without holdout cases nothing is hidden and the breakdowns are the run\'s own', async () => {
  const report = await reportWith({ dev_pass: ['pass'], dev_flip: ['result_mismatch'] });
  const markdown = renderReportMarkdown(report);
  assert.equal(markdown, renderReportMarkdown(report, { revealHoldout: true }));
  assert.doesNotMatch(markdown, /aggregate only|not listed|cover the dev cases only/);
});
