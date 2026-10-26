import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, getOptionValue } from '../src/env.js';
import { DEFAULT_MODEL } from '../src/model-config.js';
import { selectSuite } from '../src/eval/suite.js';
import { loadOptimizedQueryRuntime } from '../src/query-service.js';
import { createMariaDbPool } from '../src/pipeline.js';
import { FIXTURES } from '../src/eval/fixtures.js';
import { createGoldCache } from '../src/eval/oracle.js';
import { runCaseRepetitions } from '../src/eval/pool.js';
import { attributeRepetition } from '../src/eval/attribution.js';
import { evaluateQuestion } from './evaluate.js';
import { createTraceLogger } from '../src/trace.js';
import { ROBUSTNESS_VARIANTS, excludeBudgetBlocked, perturbRequest, summarizeRobustness } from '../src/eval/prompt-robustness.js';
import { ensureFixtures } from '../src/eval/setup.js';
import { collectProvenance, finishProvenance, resolveGitState, resolveSourceVersion } from '../src/eval/provenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const output = path.resolve(getOptionValue(args, '--output-dir') || path.join(root, 'generated/prompt-robustness-2026-10-14'));
const manifestPath = path.join(output, 'manifest.json');
const hash = text => createHash('sha256').update(text).digest('hex');
const models = [DEFAULT_MODEL, 'claude-haiku-5-5', 'claude-sonnet-5-5', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash'];
const budgets = [0.20, 0.20, 1.00, 0.65, 0.20];

if (args.includes('--prepare')) {
  if (fs.existsSync(manifestPath)) throw new Error('Refusing to overwrite the frozen manifest.');
  const suite = await selectSuite({ split: 'dev' });
  const groups = [['core-public', 3], ['edge-cases-public', 3], ['hard-cases-public', 5], ['templated-public', 5]];
  const selected = [], intents = new Set();
  for (const [group, count] of groups) {
    const candidates = suite.entries.filter(entry => entry.testCase.expected_behavior === 'answer' && entry.datasets[0] === group)
      .sort((a, b) => hash('robustness-20261014:' + a.testCase.id).localeCompare(hash('robustness-20261014:' + b.testCase.id)));
    let added = 0;
    for (const entry of candidates) {
      if (intents.has(entry.testCase.intentId)) continue;
      selected.push(entry.testCase); intents.add(entry.testCase.intentId); added++;
      if (added === count) break;
    }
    if (added !== count) throw new Error(`Insufficient distinct intents for ${group}`);
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), preparedGit: await resolveGitState(root), preparedSource: await resolveSourceVersion(root), selection: 'SHA-256 ranked within source strata; distinct intents, no score-based selection', variants: ROBUSTNESS_VARIANTS, effort: 'low', arms: models.map((model, index) => ({ model, budgetUsd: budgets[index] })), cases: selected }, null, 2));
  console.log(JSON.stringify({ manifestPath, cases: selected.length, intents: intents.size, callsPerModel: selected.length * 5, models: models.length, totalBudgetUsd: budgets.reduce((a, b) => a + b, 0) }));
  process.exit(0);
}
await loadEnvironment(args);
const dbConfig = getOptionValue(args, '--db-config');
if (dbConfig) Object.assign(process.env, JSON.parse(fs.readFileSync(dbConfig, 'utf8')));
const manifest = JSON.parse(fs.readFileSync(manifestPath));
const model = getOptionValue(args, '--model');
const arm = manifest.arms.find(arm => arm.model === model);
if (!arm) throw new Error('Select a model from the frozen manifest.');
const stem = model.replaceAll('/', '__') + '.low';
const destination = path.join(output, stem + '.json');
if (fs.existsSync(destination)) throw new Error('Refusing to overwrite a completed arm.');
process.env.MODEL_NAME = model;
process.env.REASONING_EFFORT = 'low';
process.env.LLM_MAX_COMPLETION_TOKENS = '16000';
process.env.OPENAI_BASE_URL = /^(google|deepseek)\//.test(model) ? 'https://openrouter.ai/api/v1' : '';
if (process.env.OPENAI_BASE_URL) process.env.OPENAI_API_KEY = '';
const runtime = await loadOptimizedQueryRuntime({ model, reasoningEffort: 'low', schemaScope: 'full', hintsVersion: 2, clientOptions: { maxRetries: 0 }, connectionLimit: 4 });
// The evaluator's fixture check, read-only: drifted or stale fixtures would
// score the model's SQL against different rows than its prompt described.
const fixtureStatus = await ensureFixtures({ fixtures: FIXTURES, schema: runtime.schema, allowSeed: false, strict: true, log: line => console.log(line) });
const connections = FIXTURES.map(fixture => ({ name: fixture.name, database: fixture.database, connection: createMariaDbPool({ connectionLimit: 4, env: { ...process.env, DB_NAME: fixture.database } }) }));
const trace = await createTraceLogger({ enabled: true, filePath: path.join(output, stem + '.trace.jsonl'), pipeline: 'prompt-robustness', metadata: { model, reasoningEffort: 'low' } });
const provenance = await collectProvenance({ schema: runtime.schema, model, modelConfig: { model, reasoningEffort: 'low', completionSettings: runtime.completionSettings }, fixtures: fixtureStatus, datasets: [{ name: 'frozen-robustness-manifest', path: manifestPath }], schemaScope: 'full', hintsVersion: 2, experimentLabel: getOptionValue(args, '--experiment-label') || 'prompt-robustness', runner: { repeat: 5, concurrency: 2, caseTimeoutMs: 120000, sdkMaxRetries: 0, productMaxRetries: 1 } });
await trace.emit('run.provenance', { provenance });
const ledger = { spentUsd: 0, reservedUsd: 0, blockedCalls: 0, calls: 0 };
const reserveRates = model === 'claude-sonnet-5-5' ? [2.5, 10] : model.startsWith('google/') ? [0.75, 3.75] : model.startsWith('deepseek/') ? [0.10, 2] : [0.125, 0.5];
const failure = message => Object.assign(new Error(message), { code: 'ROBUSTNESS_BUDGET_LIMIT' });
const started = Date.now();
const goldCache = createGoldCache();
try {
  const run = await runCaseRepetitions({
    cases: manifest.cases, repeat: 5, concurrency: 2, caseTimeoutMs: 120000, budgetUsd: arm.budgetUsd,
    runRepetition: async ({ testCase, caseIndex, repetition, signal }) => {
      const variant = ROBUSTNESS_VARIANTS[repetition - 1];
      const wrapped = { chat: { completions: { create: async (request, options) => {
        const changed = perturbRequest(request, variant);
        const text = JSON.stringify(changed.messages);
        await trace.emit('robustness.request', { variant, originalHash: hash(JSON.stringify(request.messages)), perturbedHash: hash(text), messages: changed.messages });
        // Conservative input bound: one token per UTF-8 byte, including all
        // messages. Reserve the full output ceiling and elevated DeepSeek
        // provider rates before dispatch; no SDK transport retries.
        const reservation = (Buffer.byteLength(text) * reserveRates[0] + 16000 * reserveRates[1]) / 1e6;
        if (ledger.spentUsd + ledger.reservedUsd + reservation > arm.budgetUsd) {
          ledger.blockedCalls++; throw failure('Stopped before an API call could exceed the arm budget.');
        }
        ledger.reservedUsd += reservation;
        let settled = false;
        try {
          const response = await runtime.client.chat.completions.create(changed, options);
          // Product pricing normalizes native cache writes and provider charges.
          const { calculateCallCost } = await import('../src/pricing.js');
          const cost = calculateCallCost(response.model || model, model, response.usage);
          if (cost?.totalCost == null) throw failure('Usage price unavailable; retaining the reservation.');
          ledger.spentUsd += cost.totalCost; ledger.calls++; settled = true;
          return response;
        } finally {
          // An aborted billed request without returned usage may still charge;
          // keep its full reservation to prevent further spending that budget.
          if (settled) ledger.reservedUsd -= reservation;
        }
      } } } };
      return evaluateQuestion({ client: wrapped, connections, schema: runtime.schema, model, reasoningEffort: 'low', completionSettings: runtime.completionSettings, testCase, caseIndex: caseIndex + 1, trace: { emit: (event, payload) => trace.emit(event, { ...payload, variant }) }, goldCache, maxRetries: 1, statementTimeoutMs: 5000, signal, schemaScope: 'full', hintsVersion: 2 });
    },
    onResult: info => console.log(JSON.stringify({ model, completed: info.completed, total: manifest.cases.length * 5, variant: ROBUSTNESS_VARIANTS[info.repetition - 1], status: info.result.status, spentUsd: info.spentUsd })),
  });
  const records = manifest.cases.map((testCase, index) => ({ id: testCase.id, intentId: testCase.intentId, repetitions: run.repetitions[index].map((result, index) => ({ ...excludeBudgetBlocked(attributeRepetition(result, testCase), result), variant: ROBUSTNESS_VARIANTS[index] })) }));
  Object.assign(provenance, await finishProvenance(provenance));
  const report = { generatedAt: new Date().toISOString(), provenance, model, effort: 'low', elapsedMs: Date.now() - started, manifestHash: hash(fs.readFileSync(manifestPath)), schemaTables: runtime.schema.tables.length, fixtures: FIXTURES.map(f => f.name), budget: { limitUsd: arm.budgetUsd, ...ledger }, summary: summarizeRobustness(records), records };
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ saved: destination, ...report.summary, budget: report.budget }));
} finally {
  await Promise.allSettled([runtime.close(), ...connections.map(f => f.connection.end())]);
}
