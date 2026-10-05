// One-command evaluation: `npm run eval`.
//
//  1. Preflight: MariaDB answers as the query user; a local database that is
//     down is started with `docker compose up -d --wait --no-recreate mariadb`
//     (unless --no-docker; a compose service that is running but unreachable
//     is never touched).
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
// fixtures, verification gates, gold errors, infra errors, provider outages or
// case deadlines during the run); with --gate also 1 when the candidate is significantly
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
import { isEvalInfraError } from '../src/eval/infra-errors.js';
import { compareReports } from '../src/eval/compare.js';
import { PRIMARY_FIXTURE, resolveFixtures } from '../src/eval/fixtures.js';
import { closeFixtureConnections, createGoldCache, GOLD_STATEMENT_TIMEOUT_MS, openFixtureConnections } from '../src/eval/oracle.js';
import { DEFAULT_CASE_TIMEOUT_MS, DEFAULT_CONCURRENCY, runCaseRepetitions } from '../src/eval/pool.js';
import { collectProvenance, hashFile, repoRelative, traceMetadataFromProvenance } from '../src/eval/provenance.js';
import { renderHeadline, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { rescoreReportCases, testCaseFromRecord } from '../src/eval/rescore.js';
import { attributeCaseRuns, buildReport, describeSuite } from '../src/eval/runner.js';
import { ensureFixtures, HarnessError, preflightDatabase } from '../src/eval/setup.js';
import { describeFilters, filterSuiteEntries, parseList, selectSuite, SPLITS } from '../src/eval/suite.js';
import { createValidatorProbe, verifySuite } from '../src/eval/verify.js';
import { createOpenAiClient, loadNarrowSchema, resolveStatementTimeoutMs, writeJsonFile } from '../src/pipeline.js';
import { calculateCost } from '../src/pricing.js';
import { errorCodeOf, resolveMaxRetries } from '../src/query-service.js';
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

// Every flag the runner (and its env loader) understands. Anything else is a
// usage error: a misspelled flag must not silently change what runs (e.g.
// `--rescore` without its file would start a paid live run).
const VALUE_FLAGS = new Set([
  '--profile',
  '--dataset',
  '--dataset-file',
  '--dev-set',
  '--datasets-dir',
  '--split',
  '--case-id',
  '--tag',
  '--intent',
  '--model',
  '--repeat',
  '--concurrency',
  '--case-timeout-ms',
  '--budget-usd',
  '--fixtures',
  '--controls-dir',
  '--min-kill-rate',
  '--min-heldout-kill-rate',
  '--compare',
  '--min-accuracy',
  '--rescore',
  '--output-dir',
  '--results-file',
  '--trace-file',
  '--trace-dir',
  '--dotenv',
  '--env-dir',
]);
const BOOLEAN_FLAGS = new Set([
  '--help',
  '--trace',
  '--no-docker',
  '--no-seed',
  '--skip-verify',
  '--skip-controls',
  '--refresh-schema',
  '--no-baseline',
  '--gate',
  '--write-baseline',
  '--offline',
  '--use-home-env',
]);

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function suggestFlag(name) {
  let best = null;
  for (const flag of [...VALUE_FLAGS, ...BOOLEAN_FLAGS]) {
    const distance = flag.startsWith(name) ? 1 : editDistance(name, flag);
    if (distance <= 3 && (!best || distance < best.distance)) {
      best = { flag, distance };
    }
  }
  return best ? ` Did you mean ${best.flag}?` : '';
}

/**
 * Rejects unknown flags, stray arguments, value flags without a value (or
 * whose value is empty or another flag) and boolean flags given a value.
 */
export function validateEvalArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw usageError(`Unexpected argument "${arg}" (every option is a --flag).`);
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (VALUE_FLAGS.has(name)) {
      const value = equals === -1 ? argv[index + 1] : arg.slice(equals + 1);
      if (value === undefined || String(value).trim() === '' || (equals === -1 && value.startsWith('--'))) {
        throw usageError(`${name} needs a value.`);
      }
      if (equals === -1) {
        index += 1;
      }
    } else if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) {
        throw usageError(`${name} takes no value; got "${arg}".`);
      }
    } else {
      throw usageError(`Unknown option "${name}".${suggestFlag(name)}`);
    }
  }
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
  validateEvalArgv(argv);
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
    argv: [...argv],
  };
  if (options.writeBaseline && (options.rescore || options.offline)) {
    throw usageError('--write-baseline only applies to a live run.');
  }
  return options;
}

/**
 * Every parsed option, as recorded in the report's runner block (none is a
 * secret; absolute paths are made repo-relative).
 */
export function describeRunnerFlags(options) {
  const relative = (value) => (typeof value === 'string' && path.isAbsolute(value) ? repoRelative(value) : value);
  return Object.fromEntries(
    Object.entries(options)
      .filter(([key]) => key !== 'argv')
      .map(([key, value]) => [key, Array.isArray(value) ? value.map(relative) : relative(value)])
  );
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
    // Counted as failures in accuracy (slow cases cannot inflate it), but a
    // deadline usually means a slow or hung provider, so the run cannot be
    // trusted, or gated, as a measurement of the model.
    ['timeout', 'hit the case deadline; raise --case-timeout-ms or check the provider'],
    ['aborted', 'were aborted before they finished'],
    ['cancelled', 'did not finish because the run was stopped'],
  ]) {
    if (byOutcome[outcome]) {
      harness.push(`${byOutcome[outcome]} repetition(s): ${label} (${outcome})`);
    }
  }
  if (report.stopped?.reason) {
    harness.push(`the run was stopped early: ${report.stopped.reason}`);
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
  const status =
    result.status === 'aborted' && result.timed_out
      ? 'timeout'
      : result.status === 'expected_sql_error' && result.error_infra
        ? 'expected_sql_error (the database failed)'
        : result.status;
  const label = status === 'pass' ? 'ok  ' : status === 'skipped_budget' || status === 'cancelled' ? 'skip' : 'FAIL';
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

async function loadBaseline(options, model, cli) {
  let baselinePath = options.compare;
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

function finish(result, options, cli) {
  const { code, reasons } = result;
  // 1 is a failed --gate, or (benchmark profile) a failed case.
  const label = code === 130 ? 'INTERRUPTED' : code === 2 ? 'HARNESS' : options.gate ? 'GATE' : 'FAIL';
  for (const reason of reasons) {
    cli.log(`${label}: ${reason}`);
  }
  if (code !== 0) {
    cli.log(`Exit code ${code}.`);
  }
  return code;
}

/**
 * Why a run must not become the committed baseline (null when it may): only
 * a clean, complete run (exit 0, no case skipped) replaces it.
 */
export function baselineRefusal(report, exit) {
  if (exit.code !== 0) {
    return `the run exited ${exit.code} (${exit.reasons.join('; ')})`;
  }
  const skipped = report.budget?.skippedCases?.length || 0;
  if (skipped > 0) {
    return `${skipped} case(s) were skipped by the budget`;
  }
  return null;
}

/**
 * Fails fast (before any setup or spend) when --gate has nothing to compare
 * with: no --compare and no default baseline. With --min-accuracy the gate
 * still has a meaning, so it only warns.
 */
async function checkGateBaseline(options, cli) {
  if (!options.gate || options.compare || options.rescore) {
    return;
  }
  const candidate = defaultBaselinePath(options.model);
  if (!options.noBaseline && (await fileExists(candidate))) {
    return;
  }
  const where = options.noBaseline ? 'and --no-baseline turns off the default baseline' : `and there is none at ${repoRelative(candidate)}`;
  if (options.minAccuracy != null) {
    cli.log(`warning: --gate has no baseline to compare with (${where.replace(/^and /, '')}); only --min-accuracy ${options.minAccuracy} is checked.`);
    return;
  }
  throw new HarnessError(
    `--gate needs a baseline to compare with, ${where}. Pass --compare <report.json>, commit a baseline ` +
      '(npm run eval -- --write-baseline), or add --min-accuracy X to gate on accuracy alone.',
    { code: 'NO_BASELINE' }
  );
}

// Provider answers that mean the key, endpoint or model is wrong: every
// further call would fail the same way.
const CONFIG_REJECTION_CODES = new Set(['HTTP_401', 'HTTP_403']);

// Under `npm run eval` one Ctrl-C arrives twice (the terminal signals the
// process group and npm forwards it to the script), so a repeat within this
// window is the same keypress.
const REPEAT_SIGNAL_WINDOW_MS = 1000;

/**
 * Stops a live run early: `stop(reason)` aborts the pool's stopSignal (no
 * new task starts, in-flight ones are aborted and recorded as cancelled).
 * SIGINT / SIGTERM stop it the same way, so a partial report is still
 * written (exit 130); a second signal (after REPEAT_SIGNAL_WINDOW_MS) exits
 * at once.
 */
export function createRunStopper({ cli, signals = process, exit = (code) => process.exit(code), now = Date.now } = {}) {
  const controller = new AbortController();
  let interruptedBy = null;
  let firstSignalAt = null;
  const stop = (reason) => {
    if (!controller.signal.aborted) {
      cli.log(`Stopping: ${reason}.`);
      controller.abort(new Error(reason));
    }
  };
  const onSignal = (name) => {
    if (firstSignalAt !== null) {
      if (now() - firstSignalAt >= REPEAT_SIGNAL_WINDOW_MS) {
        cli.error(`${name} again: exiting without a report.`);
        exit(130);
      }
      return;
    }
    firstSignalAt = now();
    interruptedBy = name;
    stop(`${name} received; in-flight cases are aborted and a partial report is written (send it again to exit at once)`);
  };
  const handlers = ['SIGINT', 'SIGTERM'].map((name) => [name, () => onSignal(name)]);
  for (const [name, handler] of handlers) {
    signals.on(name, handler);
  }
  return {
    signal: controller.signal,
    stop,
    get interruptedBy() {
      return interruptedBy;
    },
    dispose() {
      for (const [name, handler] of handlers) {
        signals.off(name, handler);
      }
    },
  };
}

/** The OpenAI client for a live run, checked before anything is set up or spent. */
function createLiveClient(options) {
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
  if (options.budgetUsd != null && calculateCost(options.model, { prompt_tokens: 1, completion_tokens: 1 }) === null) {
    throw new HarnessError(
      `--budget-usd needs a price for model "${options.model}" (src/pricing.js or MODEL_PRICING_OVERRIDES); without it the cost cannot be tracked.`,
      { code: 'NO_PRICING' }
    );
  }
  return client;
}

async function runLive({ options, cli, schema, selection, connections, fixtureStatus, controlsIndex, verification, client, signals = process }) {
  const model = options.model;
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
    flags: describeRunnerFlags(options),
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
  // Read the baseline before spending anything: a broken file fails fast.
  const baseline = await loadBaseline(options, model, cli);
  const trace = await createTraceLogger({
    enabled: true,
    logToStdout: options.traceToStdout,
    filePath: tracePath,
    pipeline: 'evaluate',
    metadata: { script: 'scripts/eval.js', datasetName: selection.name, ...traceMetadataFromProvenance(provenance) },
  });
  await trace.emit('run.started', {
    model,
    argv: options.argv || [],
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
  const stop = createRunStopper({ cli, signals });
  try {
    const run = await runCaseRepetitions({
      cases: entries.map((entry) => entry.testCase),
      repeat: options.repeat,
      concurrency: options.concurrency,
      caseTimeoutMs: options.caseTimeoutMs,
      budgetUsd: options.budgetUsd,
      stopSignal: stop.signal,
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
        // A rejected key or endpoint fails every call the same way: stop
        // instead of attempting every case.
        if (info.result.status === 'llm_error' && CONFIG_REJECTION_CODES.has(info.result.error_code)) {
          stop.stop(
            `the LLM provider rejected the request (${info.result.error_code}: check OPENAI_API_KEY, OPENAI_BASE_URL and the model); no further case is started`
          );
        }
        if (['evaluation_error', 'skipped_budget', 'cancelled'].includes(info.result.status) || info.result.timed_out) {
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
      stopped: run.stopped ? { reason: run.stopped, signal: stop.interruptedBy, cancelledCases: run.cancelledCaseIds } : null,
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
    const exit = stop.interruptedBy
      ? { code: 130, reasons: [`interrupted by ${stop.interruptedBy}; ${run.stopped ? 'the report is partial' : 'the run had finished, the report is complete'}`] }
      : computeExitCode(report, options);
    if (options.writeBaseline) {
      const target = defaultBaselinePath(model);
      const refusal = baselineRefusal(report, exit);
      if (refusal) {
        cli.log(`Baseline NOT written: ${refusal}; ${repoRelative(target)} is left as it was.`);
      } else {
        await writeJsonFile(target, report);
        cli.log(`Baseline written: ${target}`);
        if (describeFilters(selection.filters) || options.datasetNames.length || options.datasetFiles.length) {
          cli.log('  note: this run used a subset of the default suite; a committed baseline should cover the whole suite.');
        }
        if (report.provenance?.git?.dirty) {
          cli.log('  note: the working tree is dirty; commit first so the baseline records a reproducible git sha.');
        }
      }
    }
    return finish(exit, options, cli);
  } finally {
    stop.dispose();
  }
}

async function runRescore({ options, cli, schema, selection, connections, fixtureStatus, controlsIndex, verification }) {
  let sourcePath = options.rescore;
  if (!sourcePath) {
    const candidate = defaultBaselinePath(options.model);
    if (!(await fileExists(candidate))) {
      if (options.gate) {
        throw new HarnessError(`--offline --gate needs a baseline to rescore, and there is none at ${repoRelative(candidate)}.`, { code: 'NO_BASELINE' });
      }
      const message = `No baseline to rescore at ${repoRelative(candidate)}; preflight, fixtures and verification passed, nothing else to do offline.`;
      cli.log(isGithubActions() ? `::notice title=eval --offline::${message}` : `\n${message}`);
      return 0;
    }
    sourcePath = candidate;
  }
  const recorded = await readJson(sourcePath, 'report to rescore');
  if (!Array.isArray(recorded.results)) {
    throw new HarnessError(`${sourcePath} has no results[]; is it an evaluation report.json?`, { code: 'REPORT_INVALID' });
  }
  const model = recorded.model || options.model;
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const currentCases = new Map(selection.entries.map((entry) => [entry.testCase.id, entry.testCase]));
  // The selection filters pick which recorded cases are rescored (judged on
  // today's case definition when there is one).
  const filters = { split: options.split, caseIds: options.caseIds, tags: options.tags, intents: options.intents };
  let source = recorded;
  if (describeFilters(filters)) {
    const kept = new Set(
      filterSuiteEntries(
        recorded.results.map((record) => ({ testCase: currentCases.get(record.id) || testCaseFromRecord(record) })),
        filters
      ).map((entry) => entry.testCase.id)
    );
    if (kept.size === 0) {
      throw new HarnessError(`No recorded case of ${repoRelative(sourcePath)} matched the selection (${describeFilters(filters)}).`, { code: 'EMPTY_SELECTION' });
    }
    source = { ...recorded, results: recorded.results.filter((record) => kept.has(record.id)) };
    cli.log(`Rescoring ${source.results.length} of ${recorded.results.length} recorded case(s) (${describeFilters(filters)}).`);
  }
  const primary = connections.find((entry) => entry.name === PRIMARY_FIXTURE.name) || connections[0];
  const validate = createValidatorProbe({ schema, connection: primary.connection, statementTimeoutMs });
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
  const suite = { ...sourceSuite, selectedCaseCount: caseRecords.length, ...(describeFilters(filters) ? { filters } : {}) };
  const runner = {
    ...(source.runner || { repeat: source.reliability?.repeat ?? 1 }),
    rescore: true,
    maxRetries: source.oracle?.maxRetries ?? source.runner?.maxRetries ?? null,
    statementTimeoutMs,
    goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS,
    fixtures: connections.map((entry) => entry.name),
    verify: options.verify,
    flags: describeRunnerFlags(options),
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
  return finish(computeExitCode(report, options), options, cli);
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
  // Configuration problems fail before anything is started, seeded or spent.
  await checkGateBaseline(options, cli);
  const client = rescoreMode ? null : createLiveClient(options);

  const schema = await loadNarrowSchema({ modelsDir: MODELS_DIR, schemaPath: SCHEMA_PATH, refreshSchema: options.refreshSchema });

  const database = await preflightDatabase({ env, allowDocker: options.docker, allowSeed: options.seed, repoRoot: REPO_ROOT, log: (line) => cli.log(line) });
  cli.log(`Database: ${database.status === 'started' ? 'started with docker compose' : 'reachable'}.`);

  const fixtureStatus = await ensureFixtures({
    fixtures,
    schema,
    env,
    allowSeed: options.seed,
    noSeedReason: options.profile === 'benchmark' ? 'profile' : 'flag',
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
  for (const alias of selection.aliasedCaseIds || []) {
    cli.log(`  note: --case-id ${alias.id} is a duplicate of ${alias.keptAs} (same question and gold), which runs in its place.`);
  }
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
      let result;
      try {
        result = await verifySuite({
          datasets: selection.datasets,
          connections,
          goldCache: createGoldCache(),
          validate: createValidatorProbe({ schema, connection: primary.connection, statementTimeoutMs: resolveStatementTimeoutMs() }),
          controlsIndex,
          checkControls: options.checkControls,
          minKillRate: options.minKillRate,
          minHeldoutKillRate: options.minHeldoutKillRate,
        });
      } catch (error) {
        if (isEvalInfraError(error) || isEvalInfraError(error?.cause)) {
          throw new HarnessError(`The database failed during verification: ${error.message}`, { code: errorCodeOf(error) || 'DB_FAILED', cause: error });
        }
        throw error;
      }
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

    const context = { options, cli, schema, selection, connections, fixtureStatus, controlsIndex, verification, client };
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
    // Known failures (a HarnessError, or any error with a code, e.g. an env
    // file that does not exist) print their message; only a bug gets a stack.
    if (error instanceof HarnessError || error?.exitCode === 2 || (typeof error?.code === 'string' && error.code !== '')) {
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
