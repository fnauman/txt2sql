// Reproduce Experiment 04. Credentials and database settings come from the
// usual environment loader; no key is printed, persisted, or passed in argv.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getOptionValue, loadEnvironment } from '../src/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
await loadEnvironment(args);
const phase = getOptionValue(args, '--phase') || 'pilot';
if (!['pilot', 'full'].includes(phase)) throw new Error('--phase must be pilot or full.');
const output = path.resolve(getOptionValue(args, '--output-dir') || path.join(root, 'generated/provider-benchmark-2026-10-14'));
const pilotSection = fs.readFileSync(path.join(root, 'docs/experiments/03-models.md'), 'utf8').split('### Procedure')[1].split('For example')[0];
const pilotIds = [...pilotSection.matchAll(/`((?:core_|edge_|hard_|tpl_)[^`]+)`/g)].map(match => match[1]);
if (pilotIds.length !== 24) throw new Error('The pre-registered pilot must contain exactly 24 development cases.');
const availableModels = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash'];
const models = getOptionValue(args, '--models')?.split(',') || availableModels;
if (models.some(model => !availableModels.includes(model))) throw new Error('--models must select models from Experiment 04.');
if (new Set(models).size !== models.length) throw new Error('--models must not contain duplicates.');
const efforts = getOptionValue(args, '--efforts')?.split(',') || ['low', 'high'];
if (efforts.some(effort => !['low', 'high'].includes(effort))) throw new Error('--efforts must select low and/or high.');
if (new Set(efforts).size !== efforts.length) throw new Error('--efforts must not contain duplicates.');
const arms = models.flatMap(model =>
  efforts.map(effort => ({ model, effort, label: `${model.replaceAll('/', '__')}.${effort}` }))
);
fs.mkdirSync(path.join(output, phase), { recursive: true });
for (const arm of arms) {
  const report = path.join(output, phase, `${arm.label}.json`);
  if (fs.existsSync(report)) throw new Error(`Refusing to overwrite ${report}; choose a new output directory.`);
  const cli = ['scripts/eval.js', '--model', arm.model, '--reasoning-effort', arm.effort, '--repeat', phase === 'pilot' ? '1' : '3', '--concurrency', '4', '--no-docker', '--no-seed', '--compare', 'eval/baselines/gpt-6-luna.low.json', '--results-file', report, '--trace-file', path.join(output, phase, `${arm.label}.trace.jsonl`), '--output-dir', path.join(output, phase, 'runs')];
  let budgetUsd = 0.75;
  if (phase === 'pilot') cli.push('--split', 'dev', '--case-id', pilotIds.join(','));
  else {
    const pilot = JSON.parse(fs.readFileSync(path.join(output, 'pilot', `${arm.label}.json`), 'utf8'));
    const infrastructureFailure = pilot.results.some(record => record.repetitions.some(rep =>
      ['infra', 'harness'].includes(rep.bucket) || ['timeout', 'llm_unavailable'].includes(rep.outcome) || rep.counted === false
    ));
    if (pilot.stopped || pilot.stats.cases.counted !== 24 || infrastructureFailure ||
        pilot.stats.cost.questionsWithoutCost > 0 || !(pilot.stats.cost.perQuestion > 0)) {
      throw new Error(`Incomplete, infrastructure-failed, or unpriced pilot: ${arm.label}`);
    }
    budgetUsd = Math.max(1, Math.ceil(pilot.stats.cost.perQuestion * 1212 * 1.8 * 100) / 100);
    cli.push('--holdout-summary');
  }
  cli.push('--budget-usd', String(budgetUsd));
  const env = { ...process.env, MODEL_NAME: arm.model, REASONING_EFFORT: '' };
  // Empty values also prevent a subsequently loaded .env from overriding the
  // selected endpoint or sending an OpenAI key to OpenRouter.
  const onOpenRouter = /^(?:google|deepseek)\//.test(arm.model);
  env.OPENAI_BASE_URL = onOpenRouter ? 'https://openrouter.ai/api/v1' : '';
  if (onOpenRouter) env.OPENAI_API_KEY = '';
  console.log(`Starting ${phase}: ${arm.label}, budget $${budgetUsd}`);
  const fd = fs.openSync(path.join(output, phase, `${arm.label}.log`), 'wx');
  const child = spawn(process.execPath, cli, { cwd: root, env, stdio: ['ignore', fd, fd] });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  fs.closeSync(fd);
  if (code !== 0) { process.exitCode = code || 1; break; }
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  console.log(JSON.stringify({ arm: arm.label, phase, answerCases: result.stats.cases.counted, strictAccuracy: result.stats.strictAccuracy.value, spentUsd: result.budget.spentUsd, stopped: result.stopped }));
  if (result.stopped || result.stats.cases.counted !== (phase === 'pilot' ? 24 : 392)) { process.exitCode = 1; break; }
}
