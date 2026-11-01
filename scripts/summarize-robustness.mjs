// Summarize one robustness run into <run>/summary.json. Options:
//   --historical <dir>  add the unchanged-repeat stability of the full reports
//                       in <dir> (plus the committed GPT baselines)
//   --publish <file>    also write the summary there (e.g. the committed
//                       docs/experiments/results/05-prompt-robustness-summary.json)
import fs from 'node:fs';
import path from 'node:path';
import { getOptionValue } from '../src/env.js';
import { bootstrapInterval, wilsonInterval, summarizeRunUsage } from '../src/eval/stats.js';
const args = process.argv.slice(2);
const directory = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : 'generated/prompt-robustness-2026-10-14');
const historicalDirectory = getOptionValue(args, '--historical');
const publishPath = getOptionValue(args, '--publish');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
const read = file => JSON.parse(fs.readFileSync(file));
const summaries = manifest.arms.map(arm => {
  const report = read(path.join(directory, arm.model.replaceAll('/', '__') + '.low.json'));
  const metric = report.summary;
  const usage = summarizeRunUsage(report.records);
  const complete = report.records.filter(record => record.repetitions.every(r => r.counted && !r.timed_out && r.outcome !== 'timeout'));
  const perCaseAccuracy = complete.map(record => record.repetitions.slice(2).filter(r => r.outcome === 'pass').length / 3);
  const stableBaselineCorrect = complete.filter(record => record.repetitions.slice(0, 2).every(r => r.outcome === 'pass'));
  return {
    model: report.model, effort: report.effort, ...metric,
    changedPromptAccuracy: metric.changedPromptTrials ? metric.changedPromptCorrect / metric.changedPromptTrials : null,
    changedPromptAccuracyCi95: bootstrapInterval(perCaseAccuracy, values => values.reduce((s, v) => s + v, 0) / values.length),
    stableBaselineLostUnderAnyTweakCi95: wilsonInterval(metric.stableBaselineLostUnderAnyTweak, stableBaselineCorrect.length),
    latency: usage.latency.questionWallMs,
    returnedCostUsd: report.budget.spentUsd,
    budget: report.budget, manifestHash: report.manifestHash,
    provenance: report.provenance || null,
    versionStatus: report.provenance ? 'recorded-at-run' : 'legacy-run-without-source-capture',
  };
});
const historicalFiles = historicalDirectory
  ? fs.readdirSync(historicalDirectory).filter(f => f.endsWith('.json')).sort()
    .map(f => path.join(historicalDirectory, f))
    .concat(['eval/baselines/gpt-6-luna.low.json', 'eval/baselines/gpt-4o-mini.json'])
  : [];
const unchangedRepeatStability = historicalFiles.map(file => {
  const r = read(file);
  const records = r.results.filter(c => c.split === 'dev' && c.expected_behavior === 'answer');
  const counts = records.map(c => c.repetitions.filter(rep => rep.outcome === 'pass').length);
  let disagreements = 0, pairs = 0;
  for (const record of records) for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    pairs++; disagreements += (record.repetitions[i].outcome === 'pass') !== (record.repetitions[j].outcome === 'pass');
  }
  return { model: r.model, effort: r.provenance?.product?.reasoningEffort ?? null, source: file,
    developmentOnly: true, cases: counts.length, repeat: 3,
    allThreeCorrect: counts.filter(n => n === 3).length, allThreeWrong: counts.filter(n => n === 0).length,
    mixedCorrectnessCases: counts.filter(n => n > 0 && n < 3).length,
    disagreeingCorrectnessPairs: disagreements, pairs, pairDisagreementRate: disagreements / pairs,
    note: 'Pairs are correlated; this descriptive fraction is not an independent-trial probability.' };
});
const result = { generatedAt: new Date().toISOString(), protocol: { cases: manifest.cases.length, distinctIntents: 16, variants: manifest.variants, split: 'dev', selection: manifest.selection, scope: 'Model-boundary presentation changes; deterministic application context held fixed', confidenceUnit: 'Case / distinct intent; three tweaks are not independent trials' }, summaries, unchangedRepeatStability, totalReturnedCostUsd: summaries.reduce((s, r) => s + r.returnedCostUsd, 0), plannedTotalCapUsd: manifest.arms.reduce((s, a) => s + a.budgetUsd, 0) };
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(result, null, 2));
if (publishPath) {
  fs.mkdirSync(path.dirname(path.resolve(publishPath)), { recursive: true });
  fs.writeFileSync(publishPath, JSON.stringify(result, null, 2) + '\n');
}
for (const s of summaries) console.log(JSON.stringify(s));
console.log(JSON.stringify({ totalReturnedCostUsd: result.totalReturnedCostUsd }));
