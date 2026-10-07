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
// A repetition that made one priced LLM call (as a live run records it).
const rep = (status) => ({
  status,
  warnings: [],
  retrieved_tables: ['Customer'],
  attempts: [attempt],
  attempt_count: 1,
  llm_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  llm_cost: { totalCost: 0.0001 },
  timings: { totalMs: 1000, questionMs: 900 },
});
const testCase = (id, extra = {}) =>
  normalizeBenchmarkCase({ id, intentId: id, question: `Question ${id}?`, expected_sql: `SELECT '${id}'`, expected_tables: ['Customer'], ...extra });

async function reportWith(outcomes, { comparisonWith = null } = {}) {
  const definitions = {
    dev_pass: testCase('dev_pass', { tags: ['shared'] }),
    dev_flip: testCase('dev_flip', { tags: ['shared'], failure_class: 'grain_confusion' }),
    secret_holdout_case: testCase('secret_holdout_case', { split: 'holdout', tags: ['shared', 'holdout_only_tag'], failure_class: 'holdout_only_class' }),
    secret_holdout_abstain: normalizeBenchmarkCase({ id: 'secret_holdout_abstain', question: 'Weather?', split: 'holdout', expected_behavior: 'abstain' }),
    dev_abstain: normalizeBenchmarkCase({ id: 'dev_abstain', question: 'Mood?', expected_behavior: 'abstain' }),
  };
  const caseRecords = await attributeCaseRuns(
    Object.entries(outcomes).map(([id, statuses]) => ({
      entry: { testCase: definitions[id], datasets: ['d'] },
      repetitions: statuses.map((status) => (typeof status === 'string' ? rep(status) : status)),
    })),
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

test('the budget row counts skipped holdout cases without naming them; revealHoldout names them', async () => {
  const report = await reportWith(CANDIDATE_OUTCOMES);
  report.budget = { limitUsd: 1, spentUsd: 1, exhausted: true, skippedCases: ['dev_flip', 'secret_holdout_case'] };
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /\| Budget \| \$1\.0000 of \$1\.00; 2 case\(s\) skipped: dev_flip, 1 holdout case\(s\) \|/);
  assert.doesNotMatch(markdown, /secret_holdout_case/);
  assert.match(renderReportMarkdown(report, { revealHoldout: true }), /2 case\(s\) skipped: dev_flip, secret_holdout_case \|/);
});

// A repetition that returned no SQL on purpose (EMPTY_SQL): an abstain case's
// decline; the same LLM call, timings and attempt count as rep().
const declined = () => ({
  ...rep('validation_error'),
  error_code: 'EMPTY_SQL',
  attempts: [{ attempt: 1, retry: false, generatedSql: '', llm: { ok: true, durationMs: 1000 }, validation: { ok: false, durationMs: 1, layer: 'safety', code: 'EMPTY_SQL' } }],
});
// A wrong result whose expected table was not retrieved: a system error.
const retrievalMiss = () => ({ ...rep('result_mismatch'), retrieved_tables: ['Store'] });
// The provider refused the call (HTTP 400: not an outage, so the run goes
// on): no SQL, no usage, no cost, a short LLM call.
const providerRefusal = () => ({
  status: 'llm_error',
  error_code: 'HTTP_400',
  warnings: [],
  retrieved_tables: ['Customer'],
  attempts: [{ attempt: 1, retry: false, generatedSql: '', llm: { ok: false, durationMs: 50, code: 'HTTP_400' } }],
  attempt_count: 1,
  timings: { totalMs: 60, questionMs: 55 },
});
// The case deadline hit before any LLM call completed.
const deadline = () => ({ status: 'aborted', timed_out: true, warnings: [], retrieved_tables: [], attempts: [], attempt_count: 0, timings: { totalMs: 60000 } });

test('nothing about hidden holdout outcomes can be derived from report.md or the console by subtraction', async () => {
  // Runs that differ ONLY in the holdout cases' outcomes, with the holdout's
  // aggregate (accuracy by split) unchanged: a model failure, a different model
  // failure, a system failure, a provider refusal (no LLM usage); an abstain
  // case answered, declined, refused by the provider or cut by the deadline.
  // Every visible dev result is the same, so any difference in what report.md
  // or the console shows would be a hidden holdout outcome (combined totals,
  // the cost, latency, retry and token rows included, minus the listed dev
  // rows).
  const dev = { dev_pass: ['pass'], dev_flip: ['result_mismatch'], dev_abstain: ['answered'] };
  const variants = [
    { ...dev, secret_holdout_case: ['result_mismatch'], secret_holdout_abstain: ['answered'] },
    { ...dev, secret_holdout_case: ['execution_error'], secret_holdout_abstain: [declined()] },
    { ...dev, secret_holdout_case: [retrievalMiss()], secret_holdout_abstain: [declined()] },
    { ...dev, secret_holdout_case: [providerRefusal()], secret_holdout_abstain: [providerRefusal()] },
    { ...dev, secret_holdout_case: ['result_mismatch'], secret_holdout_abstain: [deadline()] },
  ];
  const reports = [];
  for (const outcomes of variants) {
    reports.push(await reportWith(outcomes));
  }
  // The variants really differ (in report.json, and with --reveal-holdout).
  assert.notDeepEqual(reports[0].behavior, reports[1].behavior);
  assert.notDeepEqual(reports[0].attribution, reports[1].attribution);
  assert.notDeepEqual(reports[1].attribution, reports[2].attribution);
  assert.notEqual(renderReportMarkdown(reports[0], { revealHoldout: true }), renderReportMarkdown(reports[1], { revealHoldout: true }));
  assert.notEqual(renderHeadline(reports[1], { revealHoldout: true }), renderHeadline(reports[2], { revealHoldout: true }));
  assert.equal(reports[0].stats.cost.questionsWithoutLlmCall, 0);
  assert.equal(reports[3].stats.cost.questionsWithoutLlmCall, 2);
  assert.equal(reports[4].stats.cost.questionsWithoutLlmCall, 1);
  assert.notEqual(renderReportMarkdown(reports[0], { revealHoldout: true }), renderReportMarkdown(reports[3], { revealHoldout: true }));
  assert.notEqual(renderReportMarkdown(reports[0], { revealHoldout: true }), renderReportMarkdown(reports[4], { revealHoldout: true }));

  const markdown = renderReportMarkdown(reports[0]);
  for (const report of reports.slice(1)) {
    assert.equal(renderReportMarkdown(report), markdown);
    assert.equal(renderHeadline(report), renderHeadline(reports[0]));
  }

  // The behaviour summary covers the listed dev case; the holdout one is
  // counted, without its outcome.
  assert.match(markdown, /Behaviour cases: abstain\/clarify — 1 case, 0 handled correctly/);
  assert.match(markdown, /\| abstain \| 1 \| 0\/1 \| answered_instead_of_abstain 1 \|/);
  assert.match(markdown, /1 holdout behaviour case\(s\) not listed/);
  assert.doesNotMatch(markdown, /declined [0-9]/);
  // Attribution and the guardrail matrix cover the dev answer cases.
  assert.match(markdown, /\| wrong_result \| model \| 1 \| 1 \| counted \|/);
  assert.match(markdown, /Accepted \| 1 \| 1 \(missed\) \|/);
  assert.match(renderHeadline(reports[0]), /Attribution \(repetitions, dev cases\): pass 1 · model 1 · system 0 /);
  // Cost, latency, retries and tokens cover the dev cases (3 repetitions).
  assert.match(markdown, /Cost, latency, retries and tokens cover the dev cases only/);
  assert.match(markdown, /\| Total LLM cost \| \$0\.0003 \|/);
  assert.match(markdown, /\(n=3\)/);
  assert.match(markdown, /\| Tokens \| prompt 300 /);
  assert.match(renderHeadline(reports[0]), /Cost \(dev cases\) \$0\.0003 /);
});

test('holdout behaviour cases alone are counted without their outcomes', async () => {
  const answered = await reportWith({ dev_pass: ['pass'], secret_holdout_abstain: ['answered'] });
  const declinedRun = await reportWith({ dev_pass: ['pass'], secret_holdout_abstain: [declined()] });
  const markdown = renderReportMarkdown(answered);
  assert.equal(renderReportMarkdown(declinedRun), markdown);
  assert.equal(renderHeadline(declinedRun), renderHeadline(answered));
  assert.match(markdown, /Behaviour cases: 1 holdout abstain\/clarify case\(s\), outcomes not shown\./);
  assert.doesNotMatch(markdown, /handled correctly|answered_instead_of_abstain [0-9]|declined [0-9]|\| Expected behaviour \|/);
  assert.doesNotMatch(markdown, /\n\n\n/, 'no empty summary table');
  assert.match(renderReportMarkdown(answered, { revealHoldout: true }), /0 handled correctly/);
});

test('a run of holdout cases only prints no empty attribution, guardrail or cost tables', async () => {
  const report = await reportWith({ secret_holdout_case: ['result_mismatch'], secret_holdout_abstain: ['answered'] });
  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /\n\n\n/, 'no empty table leaves stacked blank lines');
  assert.match(markdown, /## Attribution\n\nNo dev answer case in this run: the 1 holdout answer case\(s\) are shown in aggregate \(accuracy by split\)\.\n\nExcluded from accuracy: 1 holdout abstain\/clarify case\(s\) \(not listed\)\.\n/);
  assert.match(markdown, /## Guardrail confusion matrix\n\nNo dev answer case in this run \(the holdout is shown in aggregate, by split\)\.\n/);
  assert.match(markdown, /## Cost, latency, retries, tokens\n\nNo dev case in this run: cost, latency, retries and tokens cover the dev cases only/);
  assert.doesNotMatch(markdown, /\| Bucket \||attempts 0|\| Total LLM cost \|/);
  const console = renderHeadline(report);
  assert.match(console, /\nAttribution: no dev answer case in this run \(the holdout is shown in aggregate, by split\)\n/);
  assert.match(console, /\nCost: no dev case in this run \(cost, latency and retries cover dev cases only while the holdout is hidden\)/);
  assert.doesNotMatch(console, /pass 0 · model 0|\$0\.0000/);
  // A budget still shows the whole run's spend.
  report.budget = { limitUsd: 1, spentUsd: 0.0002, exhausted: false, skippedCases: [] };
  assert.match(renderReportMarkdown(report), /tokens cover the dev cases only[^\n]*\n\n\| Metric \| Value \|\n\| --- \| --- \|\n\| Budget \| \$0\.0002 of \$1\.00 \|\n/);
  // revealHoldout shows every table as usual.
  const revealed = renderReportMarkdown(report, { revealHoldout: true });
  assert.match(revealed, /\| Bucket \| Repetitions \| Cases \(majority\) \|/);
  assert.match(revealed, /\| Total LLM cost \| \$0\.0002 \|/);
});
