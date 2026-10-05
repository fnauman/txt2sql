// One-command evaluation: `npm run eval`.
//
//  1. Preflight: MariaDB answers as the query user; a local database that is
//     down is started with `docker compose up -d --wait mariadb` (unless
//     --no-docker).
//  2. Fixtures: every fixture database is re-hashed; missing, stale or drifted
//     ones are seeded with the admin role (unless --no-seed).
//  3. Verify: every gold query and the oracle controls, in process, with the
//     verify-dataset gates (--min-kill-rate); a failure aborts with exit 2
//     (unless --skip-verify). No LLM call happens before this passes.
//  4. Run the suite (default: every dataset in datasets/, de-duplicated)
//     through the product loop with a concurrency pool, a per-case deadline,
//     --repeat and an optional --budget-usd; or, with --rescore / --offline,
//     re-judge a recorded report with zero LLM calls.
//  5. Attribute every failure, compute case-level statistics, compare with
//     the baseline (--compare, default eval/baselines/<model>.json) and write
//     generated/runs/<timestamp>/<suite>/<model>/{report.json,report.md,trace.jsonl}.
//
// Exit codes: 0 success; 2 harness/dataset/infrastructure failure (database,
// fixtures, verification gates, gold errors, infra errors or provider outages
// during the run); with --gate also 1 when the candidate is significantly
// worse than the baseline (exact McNemar p < 0.05 with more regressions than
// improvements) or strict accuracy is below --min-accuracy.
//
// `npm run benchmark` / `npm run evaluate` run this with --profile benchmark:
// one dataset (default core-public), no Docker start, no seeding (stale
// fixtures only warn), no verification, and the old exit rule (1 when any case
// fails in a single-repetition run). Run with --help for every flag.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_USAGE, getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import { createBenchmarkRunPaths, DEFAULT_DATASETS_DIR, DEFAULT_RUNS_DIR } from '../src/benchmark.js';
import { DEFAULT_CONTROLS_DIR, loadControlsIndex } from '../src/eval/controls.js';
import { compareReports } from '../src/eval/compare.js';
import { PRIMARY_FIXTURE, resolveFixtures } from '../src/eval/fixtures.js';
import { closeFixtureConnections, createGoldCache, GOLD_STATEMENT_TIMEOUT_MS, openFixtureConnections } from '../src/eval/oracle.js';
import { DEFAULT_CASE_TIMEOUT_MS, DEFAULT_CONCURRENCY, runCaseRepetitions } from '../src/eval/pool.js';
import { collectProvenance, hashFile, repoRelative, traceMetadataFromProvenance } from '../src/eval/provenance.js';
import { renderHeadline, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { rescoreReportCases } from '../src/eval/rescore.js';
import { attributeCaseRuns, buildReport, describeSuite } from '../src/eval/runner.js';
import { ensureFixtures, HarnessError, preflightDatabase } from '../src/eval/setup.js';
import { describeFilters, parseList, selectSuite, SPLITS } from '../src/eval/suite.js';
import { createValidatorProbe, verifySuite } from '../src/eval/verify.js';
import { createOpenAiClient, loadNarrowSchema, resolveStatementTimeoutMs, writeJsonFile } from '../src/pipeline.js';
import { calculateCost } from '../src/pricing.js';
import { resolveMaxRetries } from '../src/query-service.js';
import { createCliOutput, createTraceLogger, serializeError } from '../src/trace.js';
import { evaluateQuestion } from './evaluate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.resolve(REPO_ROOT, 'models');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'generated/schema.json');
export const DEFAULT_BASELINES_DIR = path.resolve(REPO_ROOT, 'eval/baselines');
export const DEFAULT_MIN_KILL_RATE = 0.95;
const PROFILES = ['eval', 'benchmark'];

export const USAGE = `Usage: npm run eval -- [options]

One command: database preflight (starts the docker-compose MariaDB if needed),
fixture seeding, gold + controls verification, the evaluation run, attribution,
statistics, baseline comparison, and report.json + report.md + trace.jsonl under
generated/runs/<timestamp>/<suite>/<model>/.

Suite (default: every dataset in datasets/, de-duplicated by case id and by
identical question + gold):
  --dataset <name[,name]>     datasets/<name>.json only
  --dataset-file <path>       an explicit dataset file
  --datasets-dir <dir>        where datasets live (default datasets/)
  --split dev|holdout|all     cases without a split count as dev (default all)
  --case-id <id[,id]>  --tag <tag[,tag]>  --intent <intentId[,intentId]>
Run:
  --model <name>              default MODEL_NAME, else gpt-4o-mini
  --repeat N                  repetitions per case, all kept (default 1)
  --concurrency N             cases in flight (default ${DEFAULT_CONCURRENCY})
  --case-timeout-ms N         per-case deadline, 0 disables (default ${DEFAULT_CASE_TIMEOUT_MS})
  --budget-usd X              stop starting new cases once LLM cost reaches X
  --fixtures seed,v2,v3       fixtures to score on (must include seed)
Setup:
  --no-docker                 never start MariaDB with docker compose
  --no-seed                   never seed fixtures (fail when one is not current)
  --skip-verify               skip the gold + controls verification gate
  --skip-controls             verify gold only (no kill-rate gate)
  --controls-dir <dir>        default datasets/controls
  --min-kill-rate 0.95        design kill-rate floor per dataset
  --min-heldout-kill-rate 0   held-out kill-rate floor per dataset
  --refresh-schema            recompile generated/schema.json from models/
Compare and gate:
  --compare <report.json>     baseline to compare with (default eval/baselines/<model>.json when present)
  --no-baseline               do not compare with the default baseline
  --gate                      exit 1 when significantly worse than the baseline (McNemar p < 0.05)
  --min-accuracy X            with --gate: exit 1 when strict accuracy < X
  --write-baseline            also save report.json as eval/baselines/<model>.json
No LLM calls:
  --rescore <report.json>     re-validate, re-execute and re-score a recorded report
  --offline                   preflight + fixtures + verify, then rescore the default baseline if present
Output:
  --output-dir <dir>          default generated/runs
  --results-file <path>       report.json path (report.md is written next to it)
  --trace-file <path>  --trace-dir <dir>  --trace (JSONL trace on stdout)
Profiles:
  --profile benchmark         what npm run benchmark / evaluate use: one dataset
                              (default core-public), no Docker, no seeding, no
                              verification, exit 1 when any case fails in a
                              single-repetition run
Exit codes: 0 ok; 1 gate failed (--gate) or, in the benchmark profile, a failed
case; 2 harness, dataset or infrastructure failure.
${ENV_USAGE}`;

function usageError(message) {
  return new HarnessError(`${message}\nRun with --help for usage.`, { code: 'USAGE' });
}

function parseInteger(argv, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = getOptionValue(argv, name);
  if (raw === null) {
    return fallback;
  }
  const value = /^\d+$/.test(String(raw).trim()) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError(`${name} must be an integer between ${min} and ${max}; got "${raw}".`);
  }
  return value;
}

function parseNumber(argv, name, fallback, { min = 0, max = Number.POSITIVE_INFINITY, exclusiveMin = false } = {}) {
  const raw = getOptionValue(argv, name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (exclusiveMin && value === min)) {
    throw usageError(`${name} must be a number ${exclusiveMin ? 'above' : 'of at least'} ${min}${Number.isFinite(max) ? ` and at most ${max}` : ''}; got "${raw}".`);
  }
  return value;
}

function sanitizeSegment(value) {
  return String(value || 'unknown').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function defaultBaselinePath(model, baselinesDir = DEFAULT_BASELINES_DIR) {
  return path.resolve(baselinesDir, `${sanitizeSegment(model)}.json`);
}

/** Parses the command line into run options (throws HarnessError on bad usage). */
export function parseEvalArgs(argv, { profile: defaultProfile = 'eval', env = process.env } = {}) {
  const profile = getOptionValue(argv, '--profile') || defaultProfile;
  if (!PROFILES.includes(profile)) {
    throw usageError(`--profile must be one of ${PROFILES.join(', ')}; got "${profile}".`);
  }
  const benchmark = profile === 'benchmark';
  const datasetFiles = parseList(getOptionValue(argv, '--dataset-file') || getOptionValue(argv, '--dev-set'));
  let datasetNames = parseList(getOptionValue(argv, '--dataset'));
  if (benchmark && datasetNames.length === 0 && datasetFiles.length === 0) {
    datasetNames = ['core-public'];
  }
  const split = getOptionValue(argv, '--split') || 'all';
  if (!SPLITS.includes(split)) {
    throw usageError(`--split must be one of ${SPLITS.join(', ')}; got "${split}".`);
  }
  const rescore = getOptionValue(argv, '--rescore');
  const offline = hasOptionFlag(argv, '--offline');
  const compare = getOptionValue(argv, '--compare');
  const gate = hasOptionFlag(argv, '--gate');
  const minAccuracy = parseNumber(argv, '--min-accuracy', null, { min: 0, max: 1 });
  if (minAccuracy !== null && !gate) {
    throw usageError('--min-accuracy only applies with --gate.');
  }
  const options = {
    profile,
    datasetsDir: path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR),
    datasetNames,
    datasetFiles,
    split,
    caseIds: parseList(getOptionValue(argv, '--case-id')),
    tags: parseList(getOptionValue(argv, '--tag')),
    intents: parseList(getOptionValue(argv, '--intent')),
    model: getOptionValue(argv, '--model') || env.MODEL_NAME || 'gpt-4o-mini',
    repeat: parseInteger(argv, '--repeat', 1, { min: 1, max: 100 }),
    concurrency: parseInteger(argv, '--concurrency', DEFAULT_CONCURRENCY, { min: 1, max: 64 }),
    caseTimeoutMs: parseInteger(argv, '--case-timeout-ms', DEFAULT_CASE_TIMEOUT_MS, { min: 0 }),
    budgetUsd: parseNumber(argv, '--budget-usd', null, { min: 0, exclusiveMin: true }),
    fixtureNames: getOptionValue(argv, '--fixtures'),
    docker: !benchmark && !hasOptionFlag(argv, '--no-docker'),
    seed: !benchmark && !hasOptionFlag(argv, '--no-seed'),
    verify: !benchmark && !hasOptionFlag(argv, '--skip-verify'),
    checkControls: !hasOptionFlag(argv, '--skip-controls'),
    controlsDir: path.resolve(getOptionValue(argv, '--controls-dir') || DEFAULT_CONTROLS_DIR),
    minKillRate: parseNumber(argv, '--min-kill-rate', DEFAULT_MIN_KILL_RATE, { min: 0, max: 1 }),
    minHeldoutKillRate: parseNumber(argv, '--min-heldout-kill-rate', 0, { min: 0, max: 1 }),
    refreshSchema: hasOptionFlag(argv, '--refresh-schema'),
    compare: compare ? path.resolve(compare) : null,
    noBaseline: hasOptionFlag(argv, '--no-baseline'),
    gate,
    minAccuracy,
    writeBaseline: hasOptionFlag(argv, '--write-baseline'),
    rescore: rescore ? path.resolve(rescore) : null,
    offline,
    outputDir: path.resolve(getOptionValue(argv, '--output-dir') || DEFAULT_RUNS_DIR),
    traceDir: getOptionValue(argv, '--trace-dir') ? path.resolve(getOptionValue(argv, '--trace-dir')) : null,
    resultsFile: getOptionValue(argv, '--results-file') ? path.resolve(getOptionValue(argv, '--results-file')) : null,
    traceFile: getOptionValue(argv, '--trace-file') ? path.resolve(getOptionValue(argv, '--trace-file')) : null,
    traceToStdout: hasOptionFlag(argv, '--trace'),
    failOnAnyFailure: benchmark,
  };
  if (options.writeBaseline && (options.rescore || options.offline)) {
    throw usageError('--write-baseline only applies to a live run.');
  }
  return options;
}

function markdownPathFor(reportPath) {
  return reportPath.endsWith('.json') ? `${reportPath.slice(0, -'.json'.length)}.md` : `${reportPath}.md`;
}

/**
 * Exit code of a finished run: { code, reasons }. 2 for harness, dataset or
 * infrastructure failures; 1 for a failed --gate (or, in the benchmark
 * profile, any failed case in a single-repetition run); else 0.
 */
export function computeExitCode(report, { gate = false, minAccuracy = null, failOnAnyFailure = false } = {}) {
  // A rescore keeps outcomes it could not re-check (a recorded outage or a
  // run cut short); only what happened today counts as a harness failure.
  const repetitions = (report.results || []).flatMap((record) => record.repetitions || []);
  const byOutcome = {};
  if (repetitions.length > 0) {
    for (const repetition of repetitions.filter((entry) => !entry.rescore?.inherited)) {
      byOutcome[repetition.outcome] = (byOutcome[repetition.outcome] || 0) + 1;
    }
  } else {
    Object.assign(byOutcome, report.attribution?.repetitions?.byOutcome || {});
  }
  const harness = [];
  for (const [outcome, label] of [
    ['expected_sql_error', 'gold SQL failed'],
    ['harness_error', 'the runner failed'],
    ['infra_error', 'database infrastructure errors'],
    ['llm_outage', 'LLM provider outage errors'],
  ]) {
    if (byOutcome[outcome]) {
      harness.push(`${byOutcome[outcome]} repetition(s): ${label} (${outcome})`);
    }
  }
  if (report.stats?.strictAccuracy?.value == null) {
    harness.push('no case was counted, so there is no accuracy to report');
  }
  if (harness.length > 0) {
    return { code: 2, reasons: harness };
  }
  const failures = [];
  if (gate) {
    if (report.comparison?.verdict === 'worse') {
      failures.push(
        `significantly worse than the baseline: ${report.comparison.mcnemar.regressions} regression(s) vs ${report.comparison.mcnemar.improvements} improvement(s), exact McNemar p = ${report.comparison.mcnemar.p}`
      );
    }
    if (minAccuracy != null && report.stats.strictAccuracy.value < minAccuracy) {
      failures.push(`strict accuracy ${report.stats.strictAccuracy.value} < --min-accuracy ${minAccuracy}`);
    }
  }
  if (failOnAnyFailure && report.stats.repeat <= 1) {
    const failed = (report.results || []).filter((record) => record.summary.counted > 0 && record.summary.passes < record.summary.counted).length;
    if (failed > 0) {
      failures.push(`${failed} case(s) failed (benchmark profile, single run)`);
    }
  }
  return failures.length > 0 ? { code: 1, reasons: failures } : { code: 0, reasons: [] };
}

async function readJson(filePath, what) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new HarnessError(`Cannot read ${what} ${filePath}: ${error.message}`, { code: 'REPORT_NOT_FOUND', cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HarnessError(`${what} ${filePath} is not valid JSON: ${error.message}`, { code: 'REPORT_INVALID', cause: error });
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isGithubActions(env = process.env) {
  return env.GITHUB_ACTIONS === 'true';
}

function formatProgress({ testCase, repetition, result, completed, total, repeat }) {
  const width = String(total).length;
  const status = result.status === 'aborted' && result.timed_out ? 'timeout' : result.status;
  const label = status === 'pass' ? 'ok  ' : status === 'skipped_budget' ? 'skip' : 'FAIL';
  const totalMs = result.timings?.totalMs;
  const seconds = Number.isFinite(totalMs) ? (totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${Math.round(totalMs)}ms`) : '';
  const cost = Number.isFinite(result.llm_cost?.totalCost) ? `$${result.llm_cost.totalCost.toFixed(5)}` : '';
  const rep = repeat > 1 ? ` rep ${repetition}/${repeat}` : '';
  const warnings = result.warnings?.length ? ` (warnings: ${result.warnings.join(', ')})` : '';
  return `[${String(completed).padStart(width)}/${total}] ${label} ${testCase.id}${rep}: ${status}${warnings} ${seconds} ${cost}`.trimEnd();
}

function printVerification(cli, verification) {
  for (const dataset of verification.datasets) {
    const controls = dataset.controls
      ? `; design kill rate ${dataset.controls.design.killed}/${dataset.controls.design.total}, held-out ${dataset.controls.heldout.killed}/${dataset.controls.heldout.total}, ` +
        `positive ${dataset.controls.positive.matched}/${dataset.controls.positive.total}`
      : '';
    cli.log(`  ${dataset.name}: ${dataset.cases} case(s), ${dataset.failures} with problems${controls}`);
  }
  for (const problem of verification.problems) {
    cli.log(`  ✗ ${problem.id} (${problem.datasets.join(', ')}): ${problem.problems.join('; ')}`);
  }
  for (const failure of verification.gateFailures) {
    cli.log(`  FAIL: ${failure}`);
  }
}

async function writeReport(report, { reportPath, cli }) {
  const markdownPath = markdownPathFor(reportPath);
  await writeJsonFile(reportPath, report);
  await fs.writeFile(markdownPath, renderReportMarkdown(report), 'utf8');
  cli.log('');
  cli.log(renderHeadline(report));
  cli.log('');
  cli.log(`Report: ${markdownPath}`);
  cli.log(`JSON:   ${reportPath}`);
  if (report.traceFile) {
    cli.log(`Trace:  ${path.resolve(REPO_ROOT, report.traceFile)}`);
  }
  return markdownPath;
}

async function loadBaseline(options, model, cli, { fallback = null } = {}) {
  let baselinePath = options.compare;
  if (!baselinePath && fallback) {
    baselinePath = fallback;
  }
  if (!baselinePath && !options.noBaseline) {
    const candidate = defaultBaselinePath(model);
    if (await fileExists(candidate)) {
      baselinePath = candidate;
    }
  }
  if (!baselinePath) {
    return null;
  }
  const report = await readJson(baselinePath, 'baseline report');
  cli.log(`Baseline: ${baselinePath}`);
  if (report.model && report.model !== model) {
    cli.log(`  note: the baseline was run with ${report.model}, this run uses ${model}.`);
  }
  return { path: baselinePath, report };
}

function finish(report, options, cli) {
  const { code, reasons } = computeExitCode(report, options);
  for (const reason of reasons) {
    cli.log(`${code === 2 ? 'HARNESS' : 'GATE'}: ${reason}`);
  }
  if (code !== 0) {
    cli.log(`Exit code ${code}.`);
  }
  return code;
}

async function runLive({ options, cli, schema, selection, connections, fixtureStatus, controlsIndex, verification }) {
  const model = options.model;
  let client;
  try {
    client = createOpenAiClient();
  } catch (error) {
    throw new HarnessError(
      error.code === 'OPENAI_NOT_CONFIGURED'
        ? 'OPENAI_API_KEY is required for a live run (set it in .env or the shell). Use --offline or --rescore <report.json> to evaluate without LLM calls.'
        : `Cannot create the OpenAI client: ${error.message}`,
      { code: error.code || 'OPENAI_NOT_CONFIGURED', cause: error }
    );
  }
  if (options.budgetUsd != null && calculateCost(model, { prompt_tokens: 1, completion_tokens: 1 }) === null) {
    throw new HarnessError(
      `--budget-usd needs a price for model "${model}" (src/pricing.js or MODEL_PRICING_OVERRIDES); without it the cost cannot be tracked.`,
      { code: 'NO_PRICING' }
    );
  }
  const maxRetries = resolveMaxRetries();
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const runPaths = createBenchmarkRunPaths({ datasetName: selection.name, model, outputDir: options.outputDir, traceDir: options.traceDir });
  const reportPath = options.resultsFile || runPaths.reportPath;
  const tracePath = options.traceFile || runPaths.tracePath;
  const runner = {
    profile: options.profile,
    repeat: options.repeat,
    concurrency: options.concurrency,
    caseTimeoutMs: options.caseTimeoutMs,
    budgetUsd: options.budgetUsd,
    maxRetries,
    statementTimeoutMs,
    goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS,
    fixtures: connections.map((entry) => entry.name),
    verify: options.verify,
  };
  const provenance = await collectProvenance({
    schema,
    schemaPath: SCHEMA_PATH,
    fixtures: fixtureStatus,
    datasets: selection.datasets,
    controlsFiles: (controlsIndex?.files || []).map((name) => path.join(options.controlsDir, name)),
    model,
    runner,
  });
  const suite = describeSuite(selection, { repoRelative });
  const trace = await createTraceLogger({
    enabled: true,
    logToStdout: options.traceToStdout,
    filePath: tracePath,
    pipeline: 'evaluate',
    metadata: { script: 'scripts/eval.js', datasetName: selection.name, ...traceMetadataFromProvenance(provenance) },
  });
  await trace.emit('run.started', {
    model,
    suite,
    runner,
    provenance,
    fixtures: fixtureStatus,
    reportPath,
    traceFile: trace.filePath,
  });

  const entries = selection.entries;
  cli.log(
    `\nRunning ${entries.length} case(s) × ${options.repeat} repetition(s) with ${model} on ${options.concurrency} worker(s); ` +
      `case deadline ${options.caseTimeoutMs ? `${options.caseTimeoutMs} ms` : 'off'}; budget ${options.budgetUsd != null ? `$${options.budgetUsd}` : 'none'}; ` +
      `retries ${maxRetries}; statement timeout ${statementTimeoutMs} ms.`
  );
  const goldCache = createGoldCache();
  const startedAt = Date.now();
  const run = await runCaseRepetitions({
    cases: entries.map((entry) => entry.testCase),
    repeat: options.repeat,
    concurrency: options.concurrency,
    caseTimeoutMs: options.caseTimeoutMs,
    budgetUsd: options.budgetUsd,
    runRepetition: ({ testCase, caseIndex, repetition, signal }) =>
      evaluateQuestion({
        client,
        connections,
        schema,
        model,
        testCase,
        caseIndex: caseIndex + 1,
        datasetName: entries[caseIndex].datasets[0],
        // Every trace line of this case carries its repetition number.
        trace: { enabled: true, emit: (event, payload = {}) => trace.emit(event, { ...payload, repetition }) },
        goldCache,
        maxRetries,
        statementTimeoutMs,
        signal,
      }),
    onResult: async (info) => {
      cli.log(formatProgress({ ...info, repeat: options.repeat }));
      if (info.result.status === 'evaluation_error' || info.result.status === 'skipped_budget' || info.result.timed_out) {
        await trace.emit('case.runner_outcome', {
          caseId: info.testCase.id,
          repetition: info.repetition,
          status: info.result.status,
          timedOut: Boolean(info.result.timed_out),
          error: info.result.error || null,
        });
      }
    },
  });
  cli.log(`Ran in ${((Date.now() - startedAt) / 1000).toFixed(1)} s; attributing failures (re-running guardrail-rejected SQL on the fixtures)...`);

  const caseRecords = await attributeCaseRuns(
    entries.map((entry, index) => ({ entry, repetitions: run.repetitions[index] })),
    { connections, goldCache, schema, statementTimeoutMs, goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS }
  );
  const generatedAt = new Date().toISOString();
  const baseline = await loadBaseline(options, model, cli);
  const comparison = baseline
    ? compareReports(baseline.report, { results: caseRecords, model, generatedAt, provenance, mode: 'run' }, { baselineLabel: repoRelative(baseline.path) })
    : null;
  const report = buildReport({
    mode: 'run',
    generatedAt,
    runTimestamp: runPaths.timestamp,
    model,
    schemaPath: repoRelative(SCHEMA_PATH),
    suite,
    oracle: { fixtures: fixtureStatus, maxRetries, statementTimeoutMs, goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS },
    runner,
    provenance,
    verification,
    budget: { limitUsd: options.budgetUsd, spentUsd: run.spentUsd, exhausted: run.budgetExhausted, skippedCases: run.skippedCaseIds },
    caseRecords,
    comparison,
    traceFile: repoRelative(trace.filePath),
  });
  await trace.emit('run.completed', {
    stats: { strictAccuracy: report.stats.strictAccuracy, majority: report.stats.majority, cost: report.stats.cost },
    attribution: { repetitions: report.attribution.repetitions, system: report.attribution.system },
    comparison: comparison ? { verdict: comparison.verdict, mcnemar: comparison.mcnemar, delta: comparison.accuracy.delta } : null,
    reportPath,
  });
  await writeReport(report, { reportPath, cli });
  if (options.writeBaseline) {
    const target = defaultBaselinePath(model);
    await writeJsonFile(target, report);
    cli.log(`Baseline written: ${target}`);
    if (describeFilters(selection.filters) || options.datasetNames.length || options.datasetFiles.length) {
      cli.log('  note: this run used a subset of the default suite; a committed baseline should cover the whole suite.');
    }
    if (report.provenance?.git?.dirty) {
      cli.log('  note: the working tree is dirty; commit first so the baseline records a reproducible git sha.');
    }
  }
  return finish(report, options, cli);
}

async function runRescore({ options, cli, schema, selection, connections, fixtureStatus, controlsIndex, verification }) {
  let sourcePath = options.rescore;
  if (!sourcePath) {
    const candidate = defaultBaselinePath(options.model);
    if (!(await fileExists(candidate))) {
      const message = `No baseline to rescore at ${repoRelative(candidate)}; preflight, fixtures and verification passed, nothing else to do offline.`;
      cli.log(isGithubActions() ? `::notice title=eval --offline::${message}` : `\n${message}`);
      return 0;
    }
    sourcePath = candidate;
  }
  const source = await readJson(sourcePath, 'report to rescore');
  if (!Array.isArray(source.results)) {
    throw new HarnessError(`${sourcePath} has no results[]; is it an evaluation report.json?`, { code: 'REPORT_INVALID' });
  }
  const model = source.model || options.model;
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const currentCases = new Map(selection.entries.map((entry) => [entry.testCase.id, entry.testCase]));
  const primary = connections.find((entry) => entry.name === PRIMARY_FIXTURE.name) || connections[0];
  const validate = createValidatorProbe({ schema, connection: primary.connection });
  const goldCache = createGoldCache();
  cli.log(`\nRescoring ${source.results.length} case(s) from ${sourcePath} with zero LLM calls...`);
  const rescored = await rescoreReportCases(source, {
    currentCases,
    connections,
    goldCache,
    schema,
    validate,
    statementTimeoutMs,
    goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS,
  });
  const caseRecords = await attributeCaseRuns(
    rescored.map((entry) => ({ entry: entry.entry, repetitions: entry.repetitions, extra: { case_source: entry.caseSource } })),
    { connections, goldCache, schema, statementTimeoutMs, goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS }
  );
  for (const record of caseRecords) {
    const before = source.results.find((entry) => entry.id === record.id);
    const was = before?.summary ? `${before.summary.passes}/${before.summary.counted}` : before?.status;
    cli.log(`  ${record.id}: ${record.summary.passes}/${record.summary.counted} ${record.summary.outcome} (recorded: ${was})`);
  }

  const sourceSuite = source.suite || {
    name: source.dataset?.name || 'recorded',
    datasets: source.dataset?.path ? [{ name: source.dataset.name, path: source.dataset.path }] : [],
    totalCaseCount: source.dataset?.totalCaseCount ?? source.results.length,
    uniqueCaseCount: source.results.length,
    selectedCaseCount: source.results.length,
    duplicates: [],
    filters: { split: 'all', caseIds: [], tags: [], intents: [] },
  };
  const suite = { ...sourceSuite, selectedCaseCount: caseRecords.length };
  const runner = {
    ...(source.runner || { repeat: source.reliability?.repeat ?? 1 }),
    rescore: true,
    maxRetries: source.oracle?.maxRetries ?? source.runner?.maxRetries ?? null,
    statementTimeoutMs,
    goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS,
    fixtures: connections.map((entry) => entry.name),
    verify: options.verify,
  };
  const provenance = await collectProvenance({
    schema,
    schemaPath: SCHEMA_PATH,
    fixtures: fixtureStatus,
    datasets: selection.datasets,
    controlsFiles: (controlsIndex?.files || []).map((name) => path.join(options.controlsDir, name)),
    model,
    runner,
  });
  const generatedAt = new Date().toISOString();
  const baseline = options.compare
    ? { path: options.compare, report: await readJson(options.compare, 'baseline report') }
    : { path: sourcePath, report: source };
  const comparison = compareReports(
    baseline.report,
    { results: caseRecords, model, generatedAt, provenance, mode: 'rescore' },
    { baselineLabel: repoRelative(baseline.path), candidateLabel: 'rescore' }
  );
  const runPaths = createBenchmarkRunPaths({ datasetName: `${suite.name}-rescore`, model, outputDir: options.outputDir });
  const reportPath = options.resultsFile || runPaths.reportPath;
  const report = buildReport({
    mode: 'rescore',
    generatedAt,
    runTimestamp: runPaths.timestamp,
    model,
    schemaPath: repoRelative(SCHEMA_PATH),
    suite,
    oracle: { fixtures: fixtureStatus, maxRetries: runner.maxRetries, statementTimeoutMs, goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS },
    runner,
    provenance,
    verification,
    budget: source.budget || null,
    caseRecords,
    comparison,
    rescoredFrom: {
      path: repoRelative(sourcePath),
      sha256: await hashFile(sourcePath),
      generatedAt: source.generatedAt || null,
      mode: source.mode || 'run',
      gitSha: source.provenance?.git?.sha || source.gitSha || null,
      promptVersion: source.provenance?.promptVersion || null,
      reportVersion: source.reportVersion || 1,
    },
    traceFile: null,
  });
  await writeReport(report, { reportPath, cli });
  return finish(report, options, cli);
}

/** Runs the evaluation for parsed options; returns the exit code. */
export async function runEval(options, { cli = createCliOutput({ traceToStdout: options.traceToStdout }), env = process.env } = {}) {
  const fixtures = resolveFixtures(options.fixtureNames);
  if (fixtures[0]?.name !== PRIMARY_FIXTURE.name) {
    throw usageError(`--fixtures must include the primary fixture "${PRIMARY_FIXTURE.name}" (the product loop runs there).`);
  }
  const rescoreMode = Boolean(options.rescore || options.offline);
  cli.log(
    `txt2sql eval (${options.profile} profile${rescoreMode ? ', no LLM calls' : ''}): model ${options.model}; ` +
      `fixtures ${fixtures.map((fixture) => fixture.name).join(', ')}`
  );

  const schema = await loadNarrowSchema({ modelsDir: MODELS_DIR, schemaPath: SCHEMA_PATH, refreshSchema: options.refreshSchema });

  const database = await preflightDatabase({ env, allowDocker: options.docker, repoRoot: REPO_ROOT, log: (line) => cli.log(line) });
  cli.log(`Database: ${database.status === 'started' ? 'started with docker compose' : 'reachable'}.`);

  const fixtureStatus = await ensureFixtures({
    fixtures,
    schema,
    env,
    allowSeed: options.seed,
    strict: options.profile !== 'benchmark',
    log: (line) => cli.log(line),
  });
  cli.log(`Fixtures: ${fixtureStatus.map((status) => `${status.name}=${status.database} ${status.status}${status.action === 'seeded' ? ' (seeded)' : ''}`).join(', ')}`);
  for (const status of fixtureStatus.filter((entry) => entry.action === 'stale-not-seeded')) {
    cli.log(`  warning: fixture ${status.name} is ${status.status}; run "npm run seed-fixtures" so its content matches the pins.`);
  }

  let selection;
  try {
    selection = await selectSuite({
      datasetsDir: options.datasetsDir,
      datasetNames: options.datasetNames,
      datasetFiles: options.datasetFiles,
      ...(rescoreMode ? {} : { split: options.split, caseIds: options.caseIds, tags: options.tags, intents: options.intents }),
    });
  } catch (error) {
    throw new HarnessError(`Suite selection failed: ${error.message}`, { code: error.code || 'SUITE_INVALID', cause: error });
  }
  const filters = describeFilters(selection.filters);
  cli.log(
    `Suite ${selection.name}: ${selection.entries.length} case(s) selected of ${selection.uniqueCaseCount} unique ` +
      `(${selection.totalCaseCount} in ${selection.datasets.map((dataset) => dataset.name).join(', ')}; ${selection.duplicates.length} duplicate(s) dropped)` +
      (filters ? `; filters ${filters}` : '')
  );

  const connections = await openFixtureConnections({ fixtures, env });
  try {
    // Controls are needed by the verify gate; without it they are only
    // hashed into the provenance, so an unreadable directory is not fatal.
    let controlsIndex = null;
    if (options.checkControls) {
      try {
        controlsIndex = await loadControlsIndex({ controlsDir: options.controlsDir });
      } catch (error) {
        if (options.verify) {
          throw new HarnessError(`Cannot load the oracle controls: ${error.message}`, { code: 'CONTROLS_INVALID', cause: error });
        }
        cli.log(`  warning: oracle controls not loaded (${error.message}).`);
      }
    }
    let verification = { skipped: true };
    if (options.verify) {
      const primary = connections.find((entry) => entry.name === PRIMARY_FIXTURE.name) || connections[0];
      const result = await verifySuite({
        datasets: selection.datasets,
        connections,
        goldCache: createGoldCache(),
        validate: createValidatorProbe({ schema, connection: primary.connection }),
        controlsIndex,
        checkControls: options.checkControls,
        minKillRate: options.minKillRate,
        minHeldoutKillRate: options.minHeldoutKillRate,
      });
      verification = { skipped: false, ...result };
      cli.log(`Verify: ${result.cases} unique case(s) on ${connections.length} fixture(s), ${result.problems.length} with problems.`);
      printVerification(cli, result);
      if (result.problems.length > 0 || result.gateFailures.length > 0) {
        throw new HarnessError(
          `Verification failed (${result.problems.length} case(s) with gold problems, ${result.gateFailures.length} gate failure(s)); ` +
            'no LLM call was made. Fix the dataset or fixtures, or pass --skip-verify to run anyway.',
          { code: 'VERIFY_FAILED' }
        );
      }
    } else {
      cli.log('Verify: skipped.');
    }

    const context = { options, cli, schema, selection, connections, fixtureStatus, controlsIndex, verification };
    return rescoreMode ? await runRescore(context) : await runLive(context);
  } finally {
    await closeFixtureConnections(connections);
  }
}

export async function main(argv = process.argv.slice(2), { profile = 'eval' } = {}) {
  if (hasOptionFlag(argv, '--help')) {
    console.log(USAGE);
    return 0;
  }
  let cli = createCliOutput({ traceToStdout: hasOptionFlag(argv, '--trace') });
  try {
    await loadEnvironment(argv);
    const options = parseEvalArgs(argv, { profile, env: process.env });
    cli = createCliOutput({ traceToStdout: options.traceToStdout });
    return await runEval(options, { cli });
  } catch (error) {
    if (error instanceof HarnessError || error?.exitCode === 2) {
      cli.error(`eval: ${error.message}`);
      return 2;
    }
    cli.error(`eval failed: ${error?.stack || serializeError(error).message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().then((code) => {
    process.exitCode = code;
  });
}
