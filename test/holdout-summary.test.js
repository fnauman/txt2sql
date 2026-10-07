import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { compareReports, summarizePairs } from '../src/eval/compare.js';
import { holdoutPairSummary, renderComparisonConsole, renderHeadline, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { attributeCaseRuns, buildReport } from '../src/eval/runner.js';
import { mcnemarExact } from '../src/eval/stats.js';
import { writeReport } from '../scripts/eval.js';

// --holdout-summary (holdoutSummary): with a comparison that pairs at least
// one holdout case, report.md's comparison section and the console add ONE
// line for the paired holdout cases in aggregate (their number, improvements,
// regressions, exact McNemar p and verdict, strict accuracy baseline →
// candidate and the change with its paired bootstrap CI): the pre-registered
// out-of-sample evidence an experiment concludes with. Nothing else about the
// holdout is shown, and without the flag nothing changes
// (test/holdout-display.test.js). Synthetic reports only.

const attempt = { attempt: 1, retry: false, generatedSql: 'SELECT 1', llm: { ok: true, durationMs: 1000 }, validation: { ok: true, durationMs: 1 }, execution: { ok: true, durationMs: 1, rowCount: 1 } };
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
// The case deadline hit before any LLM call completed (never paired).
const deadline = () => ({ status: 'aborted', timed_out: true, warnings: [], retrieved_tables: [], attempts: [], attempt_count: 0, timings: { totalMs: 60000 } });
// Ids starting with ho_ are holdout cases.
const testCase = (id) =>
  normalizeBenchmarkCase({ id, intentId: id, question: `Question ${id}?`, expected_sql: `SELECT '${id}'`, expected_tables: ['Customer'], ...(id.startsWith('ho_') ? { split: 'holdout' } : {}) });

async function run(outcomes, { baseline = null, repeat = 1 } = {}) {
  const caseRecords = await attributeCaseRuns(
    Object.entries(outcomes).map(([id, statuses]) => ({
      entry: { testCase: testCase(id), datasets: ['d'] },
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
    runner: { repeat },
    provenance: {},
    verification: null,
    budget: null,
    caseRecords,
    comparison: baseline ? compareReports(baseline, { results: caseRecords, model: 'm', generatedAt, mode: 'run' }, { baselineLabel: 'baseline.json', resamples: 200 }) : null,
    traceFile: null,
    statsOptions: { resamples: 200 },
  });
}

const P = 'pass';
const F = 'result_mismatch';
const ho = (index) => `ho_${String(index).padStart(3, '0')}`;
const range = (from, to) => Array.from({ length: to - from }, (_, offset) => from + offset);
// 147 holdout cases, one repetition each; `passing` = the indices that pass.
const holdoutOutcomes = (passing) => Object.fromEntries(range(0, 147).map((index) => [ho(index), [passing.has(index) ? P : F]]));
const BASELINE_PASSING = new Set(range(0, 61));
const flipped = (regressions, improvements) => new Set([...[...BASELINE_PASSING].filter((index) => !regressions.includes(index)), ...improvements]);
const DEV_BASELINE = { dev_a: [P], dev_b: [P], dev_c: [F] };
const DEV_CANDIDATE = { dev_a: [P], dev_b: [F], dev_c: [F] };

// Shaped like Experiment 2's holdout: 147 paired holdout cases, 17
// improvements and 6 regressions (exact McNemar p = 0.035). Candidates A and B
// flip different holdout cases, the same number each way.
async function experimentReports() {
  const baseline = await run({ ...DEV_BASELINE, ...holdoutOutcomes(BASELINE_PASSING) });
  const a = await run({ ...DEV_CANDIDATE, ...holdoutOutcomes(flipped(range(0, 6), range(61, 78))) }, { baseline });
  const b = await run({ ...DEV_CANDIDATE, ...holdoutOutcomes(flipped(range(55, 61), range(130, 147))) }, { baseline });
  return { baseline, a, b };
}

const EXPECTED_LINE =
  '147 paired holdout case(s); 17 improvement(s), 6 regression(s); exact McNemar p = 0.035 → significantly better than the baseline; ' +
  'strict accuracy 41.5% → 49.0%, Δ +7.5 pts (95% CI +2.0 pts to +14.3 pts)';
const MARKDOWN_LINE = `\n\nHoldout in aggregate (\`--holdout-summary\`): ${EXPECTED_LINE}.`;
const CONSOLE_LINE = `\n  holdout in aggregate (--holdout-summary): ${EXPECTED_LINE}`;

const flagged = { holdoutSummary: true };
const outputsOf = (report, options = {}) => ({
  markdown: renderReportMarkdown(report, options),
  console: renderHeadline(report, options),
});

test('--holdout-summary adds one exact line for the paired holdout cases to report.md and the console', async () => {
  const { a } = await experimentReports();
  const plain = outputsOf(a);
  const withLine = outputsOf(a, flagged);

  // report.md: right after the (dev) comparison line, before the dev flip
  // tables; the console: after the dev flip lists. Removing the line gives
  // the default output back, byte for byte: nothing else changes.
  assert.ok(withLine.markdown.includes(`on 3 paired dev case(s); 1 regression(s), 0 improvement(s); exact McNemar p = 1.000 → no significant difference from the baseline (the comparison's 147 holdout case(s) are not shown; --gate tests every paired case)${MARKDOWN_LINE}\n\n### Regressions`));
  assert.equal(withLine.markdown.split(MARKDOWN_LINE).length, 2, 'one line');
  assert.equal(withLine.markdown.replace(MARKDOWN_LINE, ''), plain.markdown);
  assert.ok(withLine.console.includes(`\n  regressions: dev_b (pass → wrong_result)\n  improvements: none${CONSOLE_LINE}`));
  assert.equal(withLine.console.split(CONSOLE_LINE).length, 2, 'one line');
  assert.equal(withLine.console.replace(CONSOLE_LINE, ''), plain.console);
  assert.equal(renderComparisonConsole(a.comparison, flagged).replace(CONSOLE_LINE, ''), renderComparisonConsole(a.comparison));

  // The numbers are the holdout subset of the full comparison that
  // --reveal-holdout prints (report.json's), from summarizePairs with the
  // comparison's alpha and bootstrap settings.
  const holdoutPairs = a.comparison.pairedCases.filter((entry) => entry.split === 'holdout');
  const holdoutFlips = (entries) => entries.filter((entry) => entry.split === 'holdout').length;
  assert.equal(holdoutPairs.length, 147);
  assert.equal(holdoutFlips(a.comparison.flips.improvements), 17);
  assert.equal(holdoutFlips(a.comparison.flips.regressions), 6);
  const bySubset = summarizePairs(holdoutPairs, { alpha: a.comparison.alpha, resamples: 200 });
  const summary = holdoutPairSummary(a.comparison);
  assert.deepEqual([summary.paired, summary.mcnemar, summary.verdict], [bySubset.paired, bySubset.mcnemar, bySubset.verdict]);
  assert.deepEqual([summary.accuracy.baseline, summary.accuracy.candidate, summary.accuracy.delta], [0.415, 0.4898, 0.0748]);
  assert.deepEqual([summary.accuracy.baseline, summary.accuracy.candidate, summary.accuracy.delta], [bySubset.accuracy.baseline, bySubset.accuracy.candidate, bySubset.accuracy.delta]);
  assert.equal(summary.mcnemar.p, Number(mcnemarExact(6, 17).toFixed(6)));
  assert.deepEqual([summary.accuracy.deltaCi95.resamples, summary.accuracy.deltaCi95.seed], [a.comparison.accuracy.deltaCi95.resamples, a.comparison.accuracy.deltaCi95.seed]);
  // --reveal-holdout's lists hold exactly those holdout flips.
  const revealed = renderHeadline(a, { revealHoldout: true });
  const listed = (label) => (new RegExp(`\\n {2}${label}: ([^\\n]*)`).exec(revealed)[1].match(/ho_\d+/g) || []).length;
  assert.deepEqual([listed('regressions'), listed('improvements')], [6, 12], 'the console lists 12 of the 17 improvements, then "… 5 more"');
  assert.match(revealed, / … 5 more \(report\.md\)/);

  // With --reveal-holdout the line is printed too, unchanged (reveal lists
  // every case; the line is the holdout subset's own test).
  const both = outputsOf(a, { revealHoldout: true, holdoutSummary: true });
  const revealedPlain = outputsOf(a, { revealHoldout: true });
  assert.equal(both.markdown.replace(MARKDOWN_LINE, ''), revealedPlain.markdown);
  assert.notEqual(both.markdown, revealedPlain.markdown);
  assert.equal(both.console.replace(CONSOLE_LINE, ''), revealedPlain.console);
  assert.notEqual(both.console, revealedPlain.console);
});

test('--holdout-summary: candidates that differ only in which holdout cases flipped print byte-identical output', async () => {
  const { a, b } = await experimentReports();
  // The two runs really differ (report.json, --reveal-holdout)...
  const ids = (report, kind) => report.comparison.flips[kind].filter((entry) => entry.split === 'holdout').map((entry) => entry.id);
  assert.notDeepEqual(ids(a, 'improvements'), ids(b, 'improvements'));
  assert.notDeepEqual(ids(a, 'regressions'), ids(b, 'regressions'));
  assert.notEqual(renderReportMarkdown(a, { revealHoldout: true }), renderReportMarkdown(b, { revealHoldout: true }));
  // ...and a bootstrap over the holdout pairs in id order would tell them
  // apart: it draws cases by position.
  const idOrdered = (report) => summarizePairs(report.comparison.pairedCases.filter((entry) => entry.split === 'holdout'), { resamples: 200 }).accuracy.deltaCi95;
  assert.notDeepEqual(idOrdered(a), idOrdered(b));

  const flaggedA = outputsOf(a, flagged);
  assert.deepEqual(outputsOf(b, flagged), flaggedA);
  assert.ok(flaggedA.markdown.includes(MARKDOWN_LINE) && flaggedA.console.includes(CONSOLE_LINE));

  // The same with three repetitions, pass rates other than 0 and 1, and a
  // baseline-only holdout case.
  const baseline = await run(
    { dev_a: [P, P, P], dev_b: [P, P, F], ho_x1: [P, P, P], ho_x2: [P, P, P], ho_y1: [F, F, F], ho_y2: [F, F, F], ho_gone: [P, P, P] },
    { repeat: 3 }
  );
  // Paired outcomes (baseline → candidate pass rate): 1 → 1/3 (a regression),
  // 1 → 2/3, 0 → 2/3 (an improvement) and 0 → 0, on other cases in each run.
  const permutations = [
    { ho_x1: [P, F, F], ho_x2: [P, P, F], ho_y1: [P, F, P], ho_y2: [F, F, F] },
    { ho_x1: [P, P, F], ho_x2: [F, F, P], ho_y1: [F, F, F], ho_y2: [F, P, P] },
  ];
  const reports = [];
  for (const holdout of permutations) {
    reports.push(await run({ dev_a: [P, P, P], dev_b: [P, F, F], ...holdout }, { baseline, repeat: 3 }));
  }
  assert.notDeepEqual(reports[0].comparison.pairedCases, reports[1].comparison.pairedCases);
  assert.deepEqual(outputsOf(reports[1], flagged), outputsOf(reports[0], flagged));
  assert.doesNotMatch(JSON.stringify(outputsOf(reports[0], flagged)), /ho_/);
  assert.match(
    renderReportMarkdown(reports[0], flagged),
    /\nHoldout in aggregate \(`--holdout-summary`\): 4 paired holdout case\(s\); 1 improvement\(s\), 1 regression\(s\); exact McNemar p = 1\.000 → no significant difference from the baseline; strict accuracy 50\.0% → 41\.7%, Δ −8\.3 pts \(95% CI [^)]+\)\.\n/
  );
});

test('--holdout-summary never prints a holdout id, question or per-case figure', async () => {
  const { a, b } = await experimentReports();
  for (const report of [a, b]) {
    const { markdown, console: consoleText } = outputsOf(report, flagged);
    assert.doesNotMatch(`${markdown}\n${consoleText}`, /ho_\d|Question ho_/);
    assert.doesNotMatch(renderComparisonConsole(report.comparison, flagged), /ho_\d/);
  }
  // The summary itself carries no id or question: only outcomes.
  const summary = holdoutPairSummary(a.comparison);
  assert.doesNotMatch(JSON.stringify(summary), /ho_\d|Question|wrong_result|"pass"/);
  // With --reveal-holdout the ids are there (reveal lists them), but not in the line.
  const line = renderReportMarkdown(a, { revealHoldout: true, holdoutSummary: true }).split('\n').find((text) => text.startsWith('Holdout in aggregate'));
  assert.equal(line, MARKDOWN_LINE.trim());
});

test('--holdout-summary prints nothing extra without a comparison or without a paired holdout case', async () => {
  const same = (report, label) => {
    assert.deepEqual(outputsOf(report, flagged), outputsOf(report), label);
    assert.deepEqual(outputsOf(report, { ...flagged, revealHoldout: true }), outputsOf(report, { revealHoldout: true }), label);
    if (report.comparison) {
      assert.equal(renderComparisonConsole(report.comparison, flagged), renderComparisonConsole(report.comparison), label);
    }
    assert.equal(holdoutPairSummary(report.comparison), null, label);
  };
  const devBaseline = await run({ dev_a: [P], dev_b: [P] });
  // No comparison.
  same(await run({ dev_a: [P], ho_x1: [F] }), 'no comparison');
  // No holdout case at all.
  same(await run({ dev_a: [P], dev_b: [F] }, { baseline: devBaseline }), 'no holdout case');
  // Holdout cases the baseline does not have (new cases, not paired).
  const newHoldout = await run({ dev_a: [P], dev_b: [F], ho_x1: [F], ho_x2: [P] }, { baseline: devBaseline });
  assert.deepEqual(newHoldout.comparison.holdoutCases, ['ho_x1', 'ho_x2']);
  same(newHoldout, 'holdout cases new to the baseline');
  // Holdout cases left unpaired: a timeout majority, or a changed gold.
  const withHoldout = await run({ dev_a: [P], dev_b: [P], ho_x1: [P], ho_x2: [P] });
  const timedOut = await run({ dev_a: [P], dev_b: [F], ho_x1: [deadline], ho_x2: [deadline] }, { baseline: withHoldout });
  assert.deepEqual(timedOut.comparison.excluded.notCounted.map((entry) => entry.id), ['ho_x1', 'ho_x2']);
  same(timedOut, 'holdout cases not counted');
  const goldChanged = structuredClone(withHoldout);
  for (const record of goldChanged.results) {
    if (record.id.startsWith('ho_')) {
      record.gold_fingerprint = 'another gold';
    }
  }
  const regolded = await run({ dev_a: [P], dev_b: [F], ho_x1: [F], ho_x2: [F] }, { baseline: goldChanged });
  assert.equal(regolded.comparison.excluded.goldChanged.length, 2);
  same(regolded, 'holdout gold changed');
  // A comparison recorded before its pairs were stored.
  const paired = await run({ dev_a: [P], dev_b: [F], ho_x1: [F], ho_x2: [P] }, { baseline: withHoldout });
  assert.notEqual(renderReportMarkdown(paired, flagged), renderReportMarkdown(paired));
  const legacy = { ...paired, comparison: { ...paired.comparison } };
  delete legacy.comparison.pairedCases;
  same(legacy, 'comparison without pairedCases');
});

test('npm run eval -- --holdout-summary writes the line to report.md and prints it on the console', async (t) => {
  const { a } = await experimentReports();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-holdout-summary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = async (name, options) => {
    const lines = [];
    const cli = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
    const reportPath = path.join(dir, name, 'report.json');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await writeReport(a, { reportPath, cli, ...options });
    return { markdown: await fs.readFile(path.join(dir, name, 'report.md'), 'utf8'), console: lines.join('\n'), json: await fs.readFile(reportPath, 'utf8') };
  };
  const plain = await write('plain', { revealHoldout: false, holdoutSummary: false });
  const withLine = await write('flagged', { revealHoldout: false, holdoutSummary: true });
  assert.equal(withLine.markdown, renderReportMarkdown(a, flagged));
  assert.ok(withLine.console.includes(CONSOLE_LINE));
  assert.equal(withLine.markdown.replace(MARKDOWN_LINE, ''), plain.markdown);
  assert.equal(withLine.console.replace(CONSOLE_LINE, '').replace(/flagged/g, 'plain'), plain.console);
  assert.equal(withLine.json, plain.json, 'report.json is the same: it keeps every case either way');
  assert.equal(plain.markdown, renderReportMarkdown(a));
  assert.doesNotMatch(`${withLine.markdown}\n${withLine.console}`, /ho_\d/);
});
