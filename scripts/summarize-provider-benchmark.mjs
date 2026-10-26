// Aggregate local reports without exposing individual holdout cases or keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRunStatistics } from '../src/eval/stats.js';
import { compareReports, summarizePairs } from '../src/eval/compare.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.argv[2] || path.join(root, 'generated/provider-benchmark-2026-10-14'));
const destination = path.resolve(process.argv[3] || path.join(directory, 'summary.json'));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const reportsIn = folder => fs.readdirSync(folder).filter(file => file.endsWith('.json')).sort()
  .map(file => ({ file, report: readJson(path.join(folder, file)) }));
const reference = readJson(path.join(root, 'eval/baselines/gpt-6-luna.low.json'));
const reports = reportsIn(path.join(directory, 'full'));
const pilotReports = reportsIn(path.join(directory, 'pilot'));
const bySplit = report => report.stats.bySplit.map(split => ({
  split: split.key, cases: split.cases, accuracy: split.accuracy,
}));
const numericComparison = comparison => ({
  paired: comparison.paired,
  accuracy: comparison.accuracy,
  mcnemar: comparison.mcnemar,
  verdict: comparison.verdict,
});
const outcomesOf = report => {
  const outcomes = {};
  for (const record of report.results) for (const repetition of record.repetitions) {
    outcomes[repetition.outcome] = (outcomes[repetition.outcome] || 0) + 1;
  }
  return outcomes;
};
const usd = value => Number(value.toFixed(7));

const summaries = reports.map(({ file, report }) => {
  const development = report.results.filter(record => record.split === 'dev');
  const dev = summarizeRunStatistics(development);
  const comparison = compareReports(reference, report);
  const costSources = development.flatMap(record => record.repetitions)
    .map(repetition => repetition.llm_cost?.source).filter(Boolean);
  return {
    file,
    model: report.model,
    effort: report.provenance.product.reasoningEffort,
    answerCases: report.stats.cases.counted,
    repeat: report.stats.repeat,
    strictAccuracy: report.stats.strictAccuracy.value,
    bySplit: bySplit(report),
    devAccuracyCi95: dev.strictAccuracy.ci95,
    devLatency: dev.latency.questionWallMs,
    devCost: dev.cost,
    devRetries: dev.retries,
    devTokens: {
      ...dev.tokens,
      // Native thinking is billed within completion, without a separate count.
      reasoning: report.model.startsWith('claude-') ? null : dev.tokens.reasoning,
    },
    fullSpendUsd: report.budget.spentUsd,
    excluded: report.stats.repetitions.excludedByOutcome,
    outcomes: outcomesOf(report),
    stopped: report.stopped,
    comparison: numericComparison(comparison),
    holdoutComparison: numericComparison(summarizePairs(
      comparison.pairedCases.filter(pair => pair.split === 'holdout')
    )),
    promptVersion: report.provenance.promptVersion,
    fixturesVersion: report.provenance.fixturesVersion,
    schemaVersion: report.provenance.schemaVersion,
    endpoint: report.provenance.llmEndpoint,
    git: report.provenance.git,
    sourceVersion: report.provenance.source || null,
    codeVersion: report.provenance.codeVersion || null,
    versionStatus: report.provenance.source ? 'recorded-at-run' : 'base-commit-and-dirty-flag-only',
    verification: {
      skipped: report.verification.skipped,
      cases: report.verification.cases,
      problems: report.verification.problems.length,
      gateFailures: report.verification.gateFailures.length,
    },
    reportDate: report.generatedAt,
    costSources: [...new Set(costSources)],
  };
});

const thinkingComparisons = [];
for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash']) {
  const arm = effort => reports.find(({ report }) =>
    report.model === model && report.provenance.product.reasoningEffort === effort
  );
  const low = arm('low'), high = arm('high');
  if (low && high) thinkingComparisons.push({
    model, baseline: 'low', candidate: 'high',
    ...numericComparison(compareReports(low.report, high.report)),
  });
}

const historicalReferences = ['eval/baselines/gpt-4o-mini.json', 'eval/baselines/gpt-6-luna.low.json'].map(file => {
  const report = readJson(path.join(root, file));
  const dev = summarizeRunStatistics(report.results.filter(record => record.split === 'dev'));
  return {
    model: report.model,
    effort: report.provenance?.product?.reasoningEffort ?? (report.model === reference.model ? 'low' : null),
    historical: true,
    precision: 'full recording',
    source: file,
    reportDate: report.generatedAt,
    answerCases: report.stats.cases.counted,
    repeat: report.stats.repeat,
    strictAccuracy: report.stats.strictAccuracy.value,
    bySplit: bySplit(report),
    devLatency: dev.latency.questionWallMs,
    devCost: dev.cost,
    fullSpendUsd: report.budget.spentUsd,
    promptVersion: report.provenance.promptVersion,
    fixturesVersion: report.provenance.fixturesVersion,
  };
});
// Preserve published precision; do not fabricate an unavailable full recording.
historicalReferences.push({
  model: reference.model, effort: 'medium', historical: true,
  precision: 'rounded published figures; full recording unavailable in repository',
  source: 'docs/experiments/03-models.md',
  answerCases: 392, repeat: 3, strictAccuracy: 0.896,
  bySplit: [{ split: 'dev', cases: 245, accuracy: 0.936 }, { split: 'holdout', cases: 147, accuracy: 0.830 }],
  devLatency: { n: 765, p50: 4030, p95: 6360 },
  devCost: { currency: 'USD', perQuestion: 0.00028, perCorrect: 0.00031 },
  fullSpendUsd: 0.3992,
});

const pilots = pilotReports.map(({ file, report }) => ({
  file, model: report.model, effort: report.provenance.product.reasoningEffort,
  developmentOnly: true,
  answerCases: report.stats.cases.counted,
  repeat: report.stats.repeat,
  strictAccuracy: report.stats.strictAccuracy.value,
  latency: report.stats.latency.questionWallMs,
  cost: report.stats.cost,
  outcomes: outcomesOf(report),
  stopped: report.stopped,
}));
const result = {
  generatedAt: new Date().toISOString(),
  measurementScope: {
    accuracy: '392 answer cases; mean per-case pass rate over 3 repetitions',
    latencyAndCostPerCorrect: '255 development questions including 10 behavior cases; 765 repetitions',
    historicalReferences: 'earlier runs; not same-day latency controls',
    claudeReasoningTokens: 'included in billed completion tokens; separate count unavailable',
    openRouterHighGemini: 'diagnostic pilot only; one 120-second deadline failure, projected full cost above available credit',
  },
  historicalReferences, pilots, summaries, thinkingComparisons,
  pilotSpendUsd: usd(pilotReports.reduce((sum, { report }) => sum + (report.budget.spentUsd || 0), 0)),
  fullSpendUsd: usd(summaries.reduce((sum, summary) => sum + summary.fullSpendUsd, 0)),
  probeSpendUsd: 0.00122795,
  spendingCaveat: 'Native estimates plus OpenRouter usage.cost; excludes any provider charge for aborted calls without returned usage and any unrelated account activity',
};
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  destination, fullArms: summaries.length, pilots: pilots.length,
  historicalReferences: historicalReferences.length,
  fullSpendUsd: result.fullSpendUsd, pilotSpendUsd: result.pilotSpendUsd,
}));
