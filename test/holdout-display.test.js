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
// cases only. report.json keeps everything. The headline's intervals,
// majority-pass cases, intent-clustered accuracy and the pooled rate cover
// dev cases too: runs that differ only in holdout outcomes, with the same
// holdout accuracy, render byte for byte the same.

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
  // The holdout's split row is its accuracy and case count; the headline's
  // intervals, majority passes and intent-clustered accuracy cover dev cases.
  assert.match(markdown, /\| split \| holdout \| 1 \| 0\.0% \| not shown \|/);
  assert.match(markdown, /\| split \| dev \| 2 \| 50\.0% \| 1\/2 \|/);
  assert.match(markdown, /\*\*Strict accuracy 33\.3%\*\* \(every split; no interval while the holdout is hidden\) · 3 cases · 1 repetition · /);
  assert.match(markdown, /\nDev cases: strict accuracy 50\.0% \(95% CI [^)]+, case bootstrap\) over 2 cases · majority-pass cases 1\/2 \(Wilson 95% [^)]+\) · intent-clustered accuracy 50\.0% \(95% CI [^)]+, 2 intents\)\n/);
  assert.doesNotMatch(markdown, /Majority-pass cases [0-9]+\/3|3 intents/);
  assert.match(markdown, /Holdout: 2 case\(s\), shown in aggregate only \(accuracy by split\)/);
  assert.match(markdown, /Failure class, difficulty and tag rows cover the dev cases only/);
  assert.match(markdown, /\| tag \| shared \| 2 \| 50\.0% \| 1\/2 \|/);
  // Cases, behaviour cases and flips list dev cases and count the holdout ones.
  assert.match(markdown, /\| dev_flip \| Question dev_flip\? \|/);
  assert.match(markdown, /\n2 holdout case\(s\) not listed: holdout results are shown in aggregate only/);
  assert.match(markdown, /1 holdout behaviour case\(s\) not listed/);
  // The comparison covers the paired dev cases; its holdout cases are
  // counted once (how many there are), never their flips.
  assert.match(markdown, /\nvs baseline \(dev cases\): Δ −50\.0 pts \(95% CI [^)]+\) on 2 paired dev case\(s\); 1 regression\(s\), 0 improvement\(s\); exact McNemar p = 1\.000 → no significant difference from the baseline \(the comparison's 1 holdout case\(s\) are not shown; --gate tests every paired case\)\n/);
  assert.match(markdown, /## Comparison with the baseline\n\nDev cases only: the comparison's 1 holdout case\(s\) are left out of these figures and lists/);
  assert.match(markdown, /\| Majority passes \(paired dev cases\) \| 2\/2 \| 1\/2 \|/);
  assert.match(markdown, /\| Baseline pass \| 1 \| 1 \(regressions\) \|/);
  assert.doesNotMatch(markdown, /Holdout cases in the comparison|holdout case\(s\) \(not listed\)|2 regression|on 3 paired/);
  assert.match(markdown, /### Regressions \(baseline majority pass → candidate fail\)\n\n\| Case \| Question \| Baseline \| Candidate \|\n\| --- \| --- \| --- \| --- \|\n\| dev_flip \|[^\n]*\n\n/);

  const revealed = renderReportMarkdown(report, { revealHoldout: true });
  assert.match(revealed, /\*\*Strict accuracy 33\.3%\*\* \(95% CI [^)]+, case bootstrap\) · 3 cases · 3 intents · /);
  assert.match(revealed, /\nMajority-pass cases 1\/3 \(Wilson 95% /);
  assert.match(revealed, /\| split \| holdout \| 1 \| 0\.0% \| 0\/1 \|/);
  assert.match(revealed, /\| secret_holdout_case \| Question secret_holdout_case\? \|/);
  assert.match(revealed, /\| secret_holdout_abstain \| Weather\? \|/);
  assert.match(revealed, /\| tag \| holdout_only_tag \| 1 \|/);
  assert.doesNotMatch(revealed, /shown in aggregate only|not listed/);
  assert.equal((revealed.match(/\| secret_holdout_case \|/g) || []).length, 2, 'the cases table and the regressions table');
  assert.match(revealed, /\nvs baseline: Δ −66\.7 pts \(95% CI [^)]+\) on 3 paired case\(s\); 2 regression\(s\), 0 improvement\(s\);/);
});

test('the console shows the comparison over the paired dev cases; revealHoldout shows every case', async () => {
  const baseline = await reportWith(BASELINE_OUTCOMES);
  const report = await reportWith(CANDIDATE_OUTCOMES, { comparisonWith: baseline });
  const console = renderHeadline(report);
  assert.doesNotMatch(console, /secret_holdout/);
  assert.match(console, /\nPaired comparison with baseline\.json: 2 paired dev case\(s\) \(the comparison's 1 holdout case\(s\) are not shown; --gate tests every paired case, its verdict is the exit code\)\n/);
  assert.match(console, /\n {2}baseline pass +1 +1\n/);
  assert.match(console, /strict accuracy \(paired dev cases\) 100\.0% → 50\.0%: Δ −50\.0 pts/);
  assert.match(console, /exact McNemar p = 1\.000 \(1 regression\(s\), 0 improvement\(s\)\)/);
  assert.match(console, /regressions: dev_flip \(pass → wrong_result\)\n/);
  assert.match(console, /improvements: none/);
  assert.doesNotMatch(console, /not listed|2 regression/);
  assert.match(console, /By split: dev 50\.0% \(2\) · holdout 0\.0% \(1\)/);
  assert.match(renderHeadline(report, { revealHoldout: true }), /regressions: dev_flip \(pass → wrong_result\), secret_holdout_case \(pass → wrong_result\)\n/);
  assert.match(renderHeadline(report, { revealHoldout: true }), /exact McNemar p = 0\.500 \(2 regression\(s\), 0 improvement\(s\)\)/);
  // Only holdout flips: neither named nor counted.
  const onlyHoldout = { ...report.comparison, pairedCases: report.comparison.pairedCases.filter((entry) => entry.id !== 'dev_flip') };
  assert.match(renderComparisonConsole(onlyHoldout), /: 1 paired dev case\(s\) [^\n]*\n[\s\S]*regressions: none\n {2}improvements: none/);
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
  // The headline's dev line and the pooled rate have no dev case to cover.
  assert.match(markdown, /\nDev cases: no counted dev answer case in this run \(the holdout is shown in aggregate, by split\)\.\n/);
  assert.match(markdown, /## Legacy pooled reliability\n\nNo dev answer case in this run \(the holdout is shown in aggregate, by split\)\.\n$/);
  assert.doesNotMatch(markdown, /Pooled pass rate|Majority-pass cases/);
  const console = renderHeadline(report);
  assert.match(console, /\nDev cases: no counted dev answer case in this run \(the holdout is shown in aggregate, by split\)\n/);
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

// A three-repetition run of three dev cases over two intents, a dev abstain
// case, three holdout cases over two intents and a holdout abstain case;
// `holdout` gives the holdout cases' repetitions.
const DEV_REPETITIONS = {
  dev_a1: ['pass', 'pass', 'result_mismatch'],
  dev_a2: ['result_mismatch', 'result_mismatch', 'result_mismatch'],
  dev_b1: ['pass', 'pass', 'pass'],
  dev_abstain: ['answered', 'answered', 'answered'],
};
const skipped = () => ({ status: 'skipped_budget', warnings: [], attempts: [], attempt_count: 0 });
const outage = () => ({ ...providerRefusal(), error_code: 'HTTP_503' });
const harnessFailure = () => ({ status: 'evaluation_error', warnings: [], attempts: [], attempt_count: 0, timings: { totalMs: 5 } });
const infraFailure = () => ({ ...rep('infra_error'), error_code: 'ECONNRESET' });
// A repetition a stopped run did not finish (src/eval/pool.js).
const cancelled = () => ({ status: 'cancelled', warnings: [], error: 'Not finished: SIGINT received.', error_code: 'RUN_CANCELLED', attempts: [], attempt_count: 0 });

// `stopped`: the reason of a run stopped early; its cancelled cases are the
// cases with a cancelled repetition, as the pool records them.
async function suiteReport(holdout, { baseline = null, dev = DEV_REPETITIONS, stopped = null } = {}) {
  const definitions = {
    dev_a1: testCase('dev_a1', { intentId: 'dev_a' }),
    dev_a2: testCase('dev_a2', { intentId: 'dev_a' }),
    dev_b1: testCase('dev_b1', { intentId: 'dev_b' }),
    dev_abstain: normalizeBenchmarkCase({ id: 'dev_abstain', question: 'Mood?', expected_behavior: 'abstain' }),
    ho_x1: testCase('ho_x1', { intentId: 'ho_x', split: 'holdout' }),
    ho_x2: testCase('ho_x2', { intentId: 'ho_x', split: 'holdout' }),
    ho_y1: testCase('ho_y1', { intentId: 'ho_y', split: 'holdout' }),
    ho_abstain: normalizeBenchmarkCase({ id: 'ho_abstain', question: 'Weather?', split: 'holdout', expected_behavior: 'abstain' }),
  };
  const caseRecords = await attributeCaseRuns(
    Object.entries({ ...dev, ...holdout }).map(([id, statuses]) => ({
      entry: { testCase: definitions[id], datasets: ['d'] },
      repetitions: statuses.map((status) => (typeof status === 'string' ? rep(status) : status())),
    })),
    { checkGuardrails: false }
  );
  const generatedAt = '2026-10-07T00:00:00.000Z';
  return buildReport({
    mode: 'run',
    generatedAt,
    runTimestamp: 't',
    model: 'm',
    schemaPath: 'generated/schema.json',
    suite: { name: 'all', datasets: [], filters: { split: 'all', caseIds: [], tags: [], intents: [] } },
    oracle: { fixtures: [], maxRetries: 1 },
    runner: { repeat: 3 },
    provenance: {},
    verification: null,
    budget: null,
    stopped: stopped
      ? {
          reason: stopped,
          signal: 'SIGINT',
          cancelledCases: Object.entries({ ...dev, ...holdout })
            .filter(([, statuses]) => statuses.includes(cancelled))
            .map(([id]) => id),
        }
      : null,
    caseRecords,
    comparison: baseline ? compareReports(baseline, { results: caseRecords, model: 'm', generatedAt, mode: 'run' }, { baselineLabel: 'baseline.json', resamples: 200 }) : null,
    traceFile: null,
    statsOptions: { resamples: 200 },
  });
}

const P = 'pass';
const F = 'result_mismatch';
// Runs that differ only in the holdout cases' outcomes, with the holdout's
// accuracy by split held at 50.0% over 3 cases (pass rates summing to 1.5; a
// half needs one repetition left out of the count): how those pass rates
// spread over cases and intents, how many cases pass by majority, and
// excluded or skipped repetitions all change.
const HOLDOUT_VARIANTS = {
  spread: { ho_x1: [P, P, P], ho_x2: [F, F, F], ho_y1: [P, F, skipped], ho_abstain: ['answered', 'answered', 'answered'] },
  // The same pass rates permuted across the intents.
  permuted: { ho_x1: [F, F, F], ho_x2: [P, F, skipped], ho_y1: [P, P, P], ho_abstain: [declined, declined, declined] },
  // No majority pass instead of one.
  majority: { ho_x1: [P, F, skipped], ho_x2: [F, P, infraFailure], ho_y1: [P, outage, F], ho_abstain: ['answered', declined, 'answered'] },
  // Other excluded (infrastructure, outage, harness) and skipped repetitions.
  excluded: { ho_x1: [P, infraFailure, P], ho_x2: [F, harnessFailure, outage], ho_y1: [infraFailure, P, F], ho_abstain: [skipped, 'answered', 'answered'] },
  // A timeout majority (counted as a failure; never paired in a comparison).
  timeouts: { ho_x1: [P, P, P], ho_x2: [F, F, F], ho_y1: [deadline, P, skipped], ho_abstain: [deadline, 'answered', 'answered'] },
};

test('with the holdout hidden, report.md and the console are byte-identical for runs that differ only in holdout outcomes', async () => {
  const reports = {};
  for (const [name, holdout] of Object.entries(HOLDOUT_VARIANTS)) {
    reports[name] = await suiteReport(holdout);
  }
  const all = Object.values(reports);
  // The holdout's aggregate is the same in every run...
  for (const report of all) {
    assert.deepEqual(
      report.stats.bySplit.map((entry) => [entry.key, entry.cases, entry.accuracy]),
      [['dev', 3, 0.5556], ['holdout', 3, 0.5]]
    );
    assert.equal(report.stats.strictAccuracy.value, 0.5278);
  }
  // ...and what report.json says about every case is not.
  assert.notEqual(reports.spread.stats.intentClustered.value, reports.permuted.stats.intentClustered.value);
  assert.notDeepEqual(reports.spread.stats.intentClustered.ci95, reports.permuted.stats.intentClustered.ci95);
  assert.notDeepEqual(reports.spread.stats.strictAccuracy.ci95, reports.permuted.stats.strictAccuracy.ci95);
  assert.deepEqual(all.map((report) => report.stats.majority.passes), [3, 3, 2, 3, 3]);
  assert.deepEqual(
    [reports.spread, reports.majority, reports.excluded].map((report) => [report.reliability.passRate, report.reliability.totalAttempts]),
    [[0.5294, 17], [0.4706, 17], [0.4444, 18]]
  );
  assert.deepEqual(Object.keys(reports.excluded.stats.repetitions.excludedByOutcome).sort(), ['harness_error', 'infra_error', 'llm_outage']);
  const distinct = (values) => new Set(values).size;
  assert.equal(distinct(all.map((report) => renderReportMarkdown(report, { revealHoldout: true }))), all.length);
  assert.equal(distinct(all.map((report) => renderHeadline(report, { revealHoldout: true }))), all.length);

  const markdown = renderReportMarkdown(reports.spread);
  const consoleText = renderHeadline(reports.spread);
  for (const [name, report] of Object.entries(reports)) {
    assert.equal(renderReportMarkdown(report), markdown, name);
    assert.equal(renderHeadline(report), consoleText, name);
  }

  // What is shown: every case's strict accuracy as a point estimate, the
  // dev cases' statistics, the holdout's accuracy by split.
  assert.match(markdown, /\*\*Strict accuracy 52\.8%\*\* \(every split; no interval while the holdout is hidden\) · 6 cases · 3 repetitions · /);
  assert.match(markdown, /\nDev cases: strict accuracy 55\.6% \(95% CI [^)]+, case bootstrap\) over 3 cases · majority-pass cases 2\/3 \(Wilson 95% [^)]+\) · intent-clustered accuracy 66\.7% \(95% CI [^)]+, 2 intents\)\n/);
  assert.match(markdown, /By split: dev 55\.6% \(3 cases\) · holdout 50\.0% \(3 cases\)\./);
  assert.match(markdown, /\| split \| holdout \| 3 \| 50\.0% \| not shown \|/);
  assert.match(markdown, /## Legacy pooled reliability\n\nDev cases only \(the holdout is shown in aggregate, by split\): pooled pass rate 55\.6% over 9 repetition\(s\)/);
  assert.match(consoleText, /^Strict accuracy 52\.8% over 6 cases \(every split; no interval while the holdout is hidden\), 3 repetition\(s\), m\n/);
  assert.match(consoleText, /\nDev cases: strict accuracy 55\.6% \(95% CI [^)]+\) over 3 cases \/ 2 intents; majority-pass 2\/3 \(Wilson 95% [^)]+\); intent-clustered 66\.7%\n/);
  assert.doesNotMatch(`${markdown}\n${consoleText}`, /ho_|Weather\?|4 intents|\/6\b|over 1[78] repetition/);

  // --reveal-holdout keeps every case's figures.
  const revealed = renderReportMarkdown(reports.spread, { revealHoldout: true });
  assert.match(revealed, /\*\*Strict accuracy 52\.8%\*\* \(95% CI 24\.9%–83\.3%, case bootstrap\) · 6 cases · 4 intents · 3 repetitions · /);
  assert.match(revealed, /\nMajority-pass cases 3\/6 \(Wilson 95% [^)]+\) · intent-clustered accuracy 58\.3% /);
  assert.match(revealed, /\| split \| holdout \| 3 \| 50\.0% \| 1\/3 \|/);
  assert.match(revealed, /\nPooled pass rate 52\.9% over 17 repetition\(s\)/);
});

test('with the holdout hidden, the comparison is byte-identical too for runs that differ only in holdout outcomes', async () => {
  // One baseline; against it the variants flip different holdout cases (or
  // leave one unpaired by a timeout majority), and dev_a2 regresses in all.
  const baseline = await suiteReport(
    { ho_x1: [P, P, P], ho_x2: [P, P, P], ho_y1: [F, F, F], ho_abstain: ['answered', 'answered', 'answered'] },
    { dev: { ...DEV_REPETITIONS, dev_a2: [P, P, P] } }
  );
  const reports = {};
  for (const [name, holdout] of Object.entries(HOLDOUT_VARIANTS)) {
    reports[name] = await suiteReport(holdout, { baseline });
  }
  const all = Object.values(reports);
  // Every case's comparison differs from run to run (report.json)...
  assert.deepEqual(
    all.map((report) => [report.comparison.paired, report.comparison.mcnemar.regressions, report.comparison.mcnemar.improvements, report.comparison.rateChanges.length]),
    [[6, 2, 0, 1], [6, 3, 1, 0], [6, 3, 0, 1], [6, 2, 0, 1], [5, 2, 0, 0]]
  );
  assert.notEqual(reports.timeouts.comparison.accuracy.delta, reports.spread.comparison.accuracy.delta);
  assert.deepEqual(reports.timeouts.comparison.excluded.notCounted.map((entry) => entry.id), ['ho_y1']);
  const distinct = (values) => new Set(values).size;
  assert.equal(distinct(all.map((report) => renderReportMarkdown(report, { revealHoldout: true }))), all.length);
  assert.equal(distinct(all.map((report) => renderHeadline(report, { revealHoldout: true }))), all.length);

  // ...but report.md and the console show the same paired dev cases.
  const markdown = renderReportMarkdown(reports.spread);
  const consoleText = renderHeadline(reports.spread);
  for (const [name, report] of Object.entries(reports)) {
    assert.equal(renderReportMarkdown(report), markdown, name);
    assert.equal(renderHeadline(report), consoleText, name);
  }
  assert.match(markdown, /\nvs baseline \(dev cases\): Δ −33\.3 pts \(95% CI [^)]+\) on 3 paired dev case\(s\); 1 regression\(s\), 0 improvement\(s\); /);
  assert.match(markdown, /### Regressions \(baseline majority pass → candidate fail\)\n\n\| Case \| Question \| Baseline \| Candidate \|\n\| --- \| --- \| --- \| --- \|\n\| dev_a2 \|[^\n]*\n\n/);
  assert.match(consoleText, /\nPaired comparison with baseline\.json: 3 paired dev case\(s\) \(the comparison's 3 holdout case\(s\) are not shown;/);
  assert.match(consoleText, /\n {2}regressions: dev_a2 \(pass → wrong_result\)\n {2}improvements: none$/);
  assert.doesNotMatch(`${markdown}\n${consoleText}`, /ho_|not counted or timed out|Excluded from the paired test|on [56] paired|[23] regression\(s\)|1 improvement/);
});

test('with the holdout hidden, a stopped run counts the dev cases that did not finish, never the holdout ones', async () => {
  // The same holdout accuracy (50.0% over 3 cases) with no, one or every
  // holdout case cut off by the stop (cancelled repetitions are excluded, so
  // a case cut off after passing keeps its pass rate).
  const dev = { ...DEV_REPETITIONS, dev_b1: [P, P, cancelled] };
  const variants = {
    none: { ho_x1: [P, P, P], ho_x2: [F, F, F], ho_y1: [P, F, skipped], ho_abstain: ['answered', 'answered', 'answered'] },
    one: { ho_x1: [P, P, P], ho_x2: [F, F, F], ho_y1: [P, F, cancelled], ho_abstain: ['answered', 'answered', 'answered'] },
    every: { ho_x1: [P, P, cancelled], ho_x2: [F, cancelled, F], ho_y1: [cancelled, P, F], ho_abstain: [cancelled, 'answered', 'answered'] },
  };
  const reports = {};
  for (const [name, holdout] of Object.entries(variants)) {
    reports[name] = await suiteReport(holdout, { dev, stopped: 'SIGINT received' });
  }
  const all = Object.values(reports);
  for (const report of all) {
    assert.deepEqual(
      report.stats.bySplit.map((entry) => [entry.key, entry.cases, entry.accuracy]),
      [['dev', 3, 0.5556], ['holdout', 3, 0.5]]
    );
  }
  assert.deepEqual(all.map((report) => report.stopped.cancelledCases.length), [1, 2, 5]);
  const distinct = (values) => new Set(values).size;
  assert.equal(distinct(all.map((report) => renderReportMarkdown(report, { revealHoldout: true }))), all.length);
  assert.equal(distinct(all.map((report) => renderHeadline(report, { revealHoldout: true }))), all.length);

  const markdown = renderReportMarkdown(reports.none);
  const consoleText = renderHeadline(reports.none);
  for (const [name, report] of Object.entries(reports)) {
    assert.equal(renderReportMarkdown(report), markdown, name);
    assert.equal(renderHeadline(report), consoleText, name);
  }
  assert.match(
    markdown,
    /\n\*\*The run was stopped early\*\*: SIGINT received\. 1 dev case\(s\) did not finish \(outcome `cancelled`, excluded; holdout cases are not counted here\); the numbers cover only what finished\.\n/
  );
  assert.match(consoleText, /\nStopped early: SIGINT received; 1 dev case\(s\) did not finish \(holdout cases not counted; partial report\)\.$/);
  // --reveal-holdout counts every case, as before.
  assert.match(renderReportMarkdown(reports.every, { revealHoldout: true }), /stopped early\*\*: SIGINT received\. 5 case\(s\) did not finish \(outcome `cancelled`, excluded\); the numbers/);
  assert.match(renderHeadline(reports.every, { revealHoldout: true }), /\nStopped early: SIGINT received; 5 case\(s\) did not finish \(partial report\)\.$/);
});

test('with the holdout hidden and only holdout cases paired, the verdict does not claim that no case was paired', async () => {
  const baseline = await suiteReport(
    { ho_x1: [P, P, P], ho_x2: [P, P, P], ho_y1: [F, F, F], ho_abstain: ['answered', 'answered', 'answered'] },
    { dev: {} }
  );
  const report = await suiteReport(HOLDOUT_VARIANTS.spread, { baseline });
  assert.equal(report.comparison.paired, 3, 'report.json pairs the holdout cases (--gate decides on them)');
  const markdown = renderReportMarkdown(report);
  const consoleText = renderHeadline(report);
  for (const text of [markdown, consoleText]) {
    assert.match(text, /on 0 paired dev case\(s\)|: 0 paired dev case\(s\)/);
    assert.match(text, /→ no dev case is paired with the baseline \(its holdout cases are not shown\)/);
    assert.doesNotMatch(text, /no case could be paired/);
  }
  // A comparison that really paired nothing keeps its wording.
  const unpaired = await suiteReport(HOLDOUT_VARIANTS.spread, { baseline: { ...baseline, results: [] } });
  assert.match(renderHeadline(unpaired, { revealHoldout: true }), /→ no case could be paired with the baseline/);
});

test('with the holdout hidden, the headline counts the dev answer cases left out of accuracy, never the holdout ones', async () => {
  // Fifth review: the "N of M answer case(s) had no counted repetition" line
  // counted every case while the holdout was hidden, so a holdout answer case
  // with no counted repetition changed it although the holdout's accuracy by
  // split stayed 50.0%. dev_b1 has no counted repetition in every run.
  const dev = { ...DEV_REPETITIONS, dev_b1: [skipped, skipped, skipped] };
  const variants = {
    counted: { ho_x1: [P, P, P], ho_x2: [F, F, F], ho_y1: [P, F, skipped], ho_abstain: ['answered', 'answered', 'answered'] },
    excluded: { ho_x1: [P, P, P], ho_x2: [F, F, F], ho_y1: [skipped, infraFailure, skipped], ho_abstain: ['answered', 'answered', 'answered'] },
  };
  const reports = {};
  for (const [name, holdout] of Object.entries(variants)) {
    reports[name] = await suiteReport(holdout, { dev });
  }
  assert.deepEqual(
    Object.values(reports).map((report) => [report.stats.cases.excluded, report.stats.bySplit.find((entry) => entry.key === 'holdout').accuracy]),
    [[1, 0.5], [2, 0.5]]
  );
  const line =
    '\n1 of 3 dev answer case(s) had no counted repetition and are left out of accuracy (see Attribution; holdout cases are not counted here); ' +
    'the 1 dev abstain/clarify case(s) are scored apart.\n';
  for (const [name, report] of Object.entries(reports)) {
    const markdown = renderReportMarkdown(report);
    assert.ok(markdown.includes(line), name);
    assert.doesNotMatch(markdown, /of 6 answer case|the 2 abstain/, name);
  }
  // --reveal-holdout counts every case, as before.
  assert.match(
    renderReportMarkdown(reports.excluded, { revealHoldout: true }),
    /\n2 of 6 answer case\(s\) had no counted repetition and are left out of accuracy \(see Attribution\); the 2 abstain\/clarify case\(s\) are scored apart\.\n/
  );
  // No dev case left out: no line while the holdout is hidden, whatever the
  // holdout's cases did.
  const devCounted = await suiteReport(variants.excluded);
  assert.doesNotMatch(renderReportMarkdown(devCounted), /had no counted repetition/);
  assert.match(renderReportMarkdown(devCounted, { revealHoldout: true }), /\n1 of 6 answer case\(s\) had no counted repetition/);
  // Without a dev behaviour case the line counts the selected dev cases.
  const { dev_abstain: _devAbstain, ...devAnswers } = dev;
  const answersOnly = await suiteReport(variants.excluded, { dev: devAnswers });
  assert.match(
    renderReportMarkdown(answersOnly),
    /\n1 of 3 selected dev case\(s\) had no counted repetition and are left out of accuracy \(see Attribution; holdout cases are not counted here\)\.\n/
  );
});

test('a recorded comparison without its paired cases shows its own figures only when no holdout case is paired, else says the dev comparison cannot be reconstructed', async () => {
  // Fifth review: without pairedCases (an older shape), with holdout cases in
  // the comparison, report.md and the console replaced the recorded figures
  // with a summary of no pair and claimed that no dev case was paired.
  const withoutPairs = (report) => {
    const comparison = { ...report.comparison };
    delete comparison.pairedCases;
    return { ...report, comparison };
  };
  // Every holdout case of the comparison is listed as unpaired (new to the
  // baseline, or not counted in one report): the recorded figures are the
  // dev comparison's own, shown as if the pairs were there.
  for (const baselineOutcomes of [
    { dev_pass: ['pass'], dev_flip: ['pass'] },
    { dev_pass: ['pass'], dev_flip: ['pass'], secret_holdout_case: ['infra_error'] },
  ]) {
    const baseline = await reportWith(baselineOutcomes);
    const report = await reportWith(CANDIDATE_OUTCOMES, { comparisonWith: baseline });
    assert.deepEqual(report.comparison.holdoutCases, ['secret_holdout_case']);
    assert.ok(!report.comparison.pairedCases.some((entry) => entry.id === 'secret_holdout_case'));
    const legacy = withoutPairs(report);
    assert.equal(renderReportMarkdown(legacy), renderReportMarkdown(report));
    assert.equal(renderHeadline(legacy), renderHeadline(report));
    assert.match(renderHeadline(legacy), /\nPaired comparison with baseline\.json: 2 paired dev case\(s\) /);
    assert.match(renderReportMarkdown(legacy), /\nvs baseline \(dev cases\): Δ −50\.0 pts \(95% CI [^)]+\) on 2 paired dev case\(s\); 1 regression\(s\), 0 improvement\(s\);/);
    assert.doesNotMatch(`${renderReportMarkdown(legacy)}\n${renderHeadline(legacy)}`, /secret_holdout|no dev case is paired|0 paired/);
  }
  // A holdout case is (or may be) paired: no figure is shown, none invented.
  const baseline = await reportWith(BASELINE_OUTCOMES);
  const legacy = withoutPairs(await reportWith(CANDIDATE_OUTCOMES, { comparisonWith: baseline }));
  const markdown = renderReportMarkdown(legacy);
  const consoleText = renderHeadline(legacy);
  const unavailable =
    'the dev-only comparison cannot be reconstructed from this recording: it does not store its paired cases, and its 1 holdout case(s) ' +
    'may be among them; `--reveal-holdout` shows its figures over every paired case, holdout included; --gate tests every paired case';
  assert.ok(markdown.includes(`\nvs baseline (dev cases): ${unavailable}\n`), markdown);
  assert.ok(consoleText.includes(`\nPaired comparison with baseline.json: ${unavailable}`), consoleText);
  for (const text of [markdown, consoleText]) {
    assert.doesNotMatch(text, /secret_holdout|no dev case is paired|paired dev case|regression\(s\)|improvement\(s\)|McNemar|Δ|candidate pass|Majority passes \(paired/);
  }
  assert.doesNotMatch(markdown, /### Regressions|### Improvements|Pass-rate changes/);
  assert.match(markdown, /## Comparison with the baseline\n\nDev cases only: the comparison's 1 holdout case\(s\) are left out of these figures and lists/);
  // --reveal-holdout shows the recorded comparison over every paired case.
  assert.match(renderHeadline(legacy, { revealHoldout: true }), /: 3 paired case\(s\)[\s\S]*exact McNemar p = 0\.500 \(2 regression\(s\), 0 improvement\(s\)\)/);
});
