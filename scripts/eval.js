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
//     the baseline (--compare, default eval/baselines/<model>[.<effort>].json,
//     `/` in the model id as `__`, a hash added for an id that is not plain:
//     modelFileLabel) and write
//     generated/runs/<timestamp>/<suite>/<model>[.<effort>]/{report.json,report.md,trace.jsonl}.
//
// Exit codes: 0 success; 2 harness/dataset/infrastructure failure (database,
// fixtures, verification gates, gold errors, infra errors, provider outages or
// case deadlines during the run); with --gate also 1 when the candidate is significantly
// worse than the baseline (exact McNemar p < 0.05 with more regressions than
// improvements) or strict accuracy is below --min-accuracy (a selection of only
// abstain / clarify cases has no strict accuracy, so --min-accuracy is refused
// for it with exit 2).
//
// `npm run benchmark` / `npm run evaluate` run this with --profile benchmark:
// one dataset (default core-public), no Docker start, no seeding (stale
// fixtures only warn), no verification, and the old exit rule (1 when any case
// fails in a single-repetition run; an abstain / clarify case fails when it is
// not declined: the model answers it, or its call fails without SQL). Run with
// --help for every flag.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_USAGE, getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import { createBenchmarkRunPaths, DEFAULT_DATASETS_DIR, DEFAULT_RUNS_DIR, isBehaviorCase } from '../src/benchmark.js';
import { classifyRepetition } from '../src/eval/attribution.js';
import { compactReportProblem, isCompactReport, writeCompactReport } from '../src/eval/compact-report.js';
import { DEFAULT_CONTROLS_DIR, loadControlsIndex } from '../src/eval/controls.js';
import { isEvalInfraError } from '../src/eval/infra-errors.js';
import { compareReports } from '../src/eval/compare.js';
import { FIXTURES, PRIMARY_FIXTURE, resolveFixtures } from '../src/eval/fixtures.js';
import { isHoldoutCase } from '../src/eval/holdout.js';
import { closeFixtureConnections, createGoldCache, GOLD_STATEMENT_TIMEOUT_MS, openFixtureConnections } from '../src/eval/oracle.js';
import { DEFAULT_CASE_TIMEOUT_MS, DEFAULT_CONCURRENCY, runCaseRepetitions } from '../src/eval/pool.js';
import { collectProvenance, hashFile, repoRelative, traceMetadataFromProvenance } from '../src/eval/provenance.js';
import { behaviorPassText, renderHeadline, renderReportMarkdown } from '../src/eval/report-markdown.js';
import { rescoreReportCases, testCaseFromRecord } from '../src/eval/rescore.js';
import { attributeCaseRuns, buildReport, describeSuite, REPORT_VERSION } from '../src/eval/runner.js';
import { runScriptMain } from '../src/eval/script-exit.js';
import { ensureFixtures, HarnessError, preflightDatabase } from '../src/eval/setup.js';
import { describeFilters, filterSuiteEntries, parseList, resolveCaseIdAliases, scoringFingerprint, selectSuite, SPLITS } from '../src/eval/suite.js';
import { controlsCoverageFailure, createValidatorProbe, verifySuite } from '../src/eval/verify.js';
import { createOpenAiClient, loadNarrowSchema, resolveEffectiveSchemaScope, resolveStatementTimeoutMs, writeJsonFile } from '../src/pipeline.js';
import { describeHintsVersion, resolveHintsVersion, sameHintsVersion } from '../src/hints-version.js';
import { describeSchemaScope, resolveSchemaScopeConfig, sameSchemaScopeBehaviour } from '../src/schema-scope.js';
import { hasModelPrice } from '../src/pricing.js';
import {
  completionSettingsOf,
  DEFAULT_MODEL,
  describeModelConfig,
  describeModelNotices,
  describeReasoningEffort,
  modelFileLabel,
  modelLabel,
  REASONING_EFFORTS,
  resolveModelConfig,
} from '../src/model-config.js';
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
generated/runs/<timestamp>/<suite>/<model>[.<effort>]/.

Suite (default: every dataset in datasets/, de-duplicated by case id and by
identical question + gold):
  --dataset <name[,name]>     datasets/<name>.json only
  --dataset-file <path>       an explicit dataset file
  --datasets-dir <dir>        where datasets live (default datasets/)
  --split dev|holdout|all     cases without a split count as dev (default all)
  --case-id <id[,id]>  --tag <tag[,tag]>  --intent <intentId[,intentId]>
Run:
  --model <name>              default MODEL_NAME, else ${DEFAULT_MODEL}
  --reasoning-effort <v>      ${REASONING_EFFORTS.join('|')}, checked per model family (default
                              REASONING_EFFORT; unset: the family's default, e.g. medium for
                              gpt-6*, or none sent)
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
  --compare <report.json>     baseline to compare with (default eval/baselines/<model>[.<effort>].json
                              when present; a "/" in the model id is written "__"; an id that is not
                              plain (lower-case letters and digits, single "." or "-" between them, no
                              trailing .<effort>) is sanitized and gets "_" plus a hash of the id)
  --no-baseline               do not compare with the default baseline
  --gate                      exit 1 when significantly worse than the baseline (McNemar p < 0.05)
  --min-accuracy X            with --gate: exit 1 when strict accuracy < X (exit 2 when
                              only abstain / clarify cases are selected: no accuracy)
  --write-baseline            also save a compact copy of report.json (what rescore, compare and gate
                              read) as eval/baselines/<model>[.<effort>].json (only from a clean run of the
                              whole default suite on every fixture)
  --baseline-file <path>      with --write-baseline: save there instead (allows a filtered subset;
                              never inside eval/baselines/, which holds only full default baselines)
No LLM calls:
  --rescore <report.json>     re-validate, re-execute and re-score a recorded report
  --offline                   preflight + fixtures + verify, then rescore the default baseline if present
Output:
  --reveal-holdout            list holdout cases one by one in report.md and the console (by default
                              holdout results are shown in aggregate only: accuracy by split)
  --holdout-summary           add one line for the comparison's paired holdout cases in aggregate
                              (their number, improvements, regressions, exact McNemar p, accuracy
                              change with its CI; no ids): only to conclude a pre-registered
                              experiment, never while designing a change
  --output-dir <dir>          default generated/runs
  --results-file <path>       report.json path (report.md is written next to it)
  --trace-file <path>  --trace-dir <dir>  --trace (JSONL trace on stdout)
Profiles:
  --profile benchmark         what npm run benchmark / evaluate use: one dataset
                              (default core-public), no Docker, no seeding, no
                              verification, exit 1 when any case fails in a
                              single-repetition run (an abstain / clarify case
                              fails when it is not declined: answered, or an
                              LLM error without SQL)
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
  '--reasoning-effort',
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
  '--baseline-file',
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
  '--reveal-holdout',
  '--holdout-summary',
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
/**
 * The rescore's console note when the recording ran another schema scope or,
 * in the retrieved scope, another widen-on-demand setting (the same test as
 * report.md's "Recorded schema scope" row); null when they behave the same.
 * recordedScope null = a report from before SCHEMA_SCOPE (retrieved, no
 * widening).
 */
export function rescoreSchemaScopeNote(recordedScope, todayScope) {
  if (sameSchemaScopeBehaviour(recordedScope, todayScope)) {
    return null;
  }
  return (
    `  note: the recording ran with schema scope ${recordedScope ? describeSchemaScope(recordedScope) : 'retrieved, no widening (not recorded: before SCHEMA_SCOPE)'}; ` +
    `today's validator uses ${describeSchemaScope(todayScope)}, so recorded SQL is re-judged with today's scope.`
  );
}

/**
 * The rescore's console note when the recording ran another hints version
 * (recordedVersion null = a report from before HINTS_VERSION: version 1); null
 * when they are the same. Only the validator's decisions follow today's
 * version: the recorded SQL was generated from the recorded prompts.
 */
export function rescoreHintsVersionNote(recordedVersion, todayVersion) {
  if (sameHintsVersion(recordedVersion, todayVersion)) {
    return null;
  }
  return (
    `  note: the recording ran with hints version ${describeHintsVersion(recordedVersion)}; today's validator uses ` +
    `${describeHintsVersion(todayVersion)}, so recorded SQL is re-judged with today's semantic plan (the prompts are not regenerated: ` +
    'only validator and semantic-plan effects show).'
  );
}

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

/**
 * The default baseline of a model at a reasoning effort:
 * eval/baselines/<model>[.<effort>].json, with `/` in the model id mapped to
 * `__` (modelFileLabel): eval/baselines/gpt-4o-mini.json,
 * eval/baselines/gpt-6-luna.low.json, eval/baselines/openai__gpt-6-luna.low.json;
 * an id that is not plain gets a hash of itself (openai__gpt-6-luna-free_<hash>.json).
 */
export function defaultBaselinePath(model, reasoningEffort = null, baselinesDir = DEFAULT_BASELINES_DIR) {
  return path.resolve(baselinesDir, `${modelFileLabel(model, reasoningEffort)}.json`);
}

/**
 * The default baseline of a run configured by `env` alone (no flags), as the
 * CI db job checks for it before an offline --gate.
 */
export function defaultBaselineForEnv(env = process.env) {
  const config = resolveModelConfig({ env });
  return defaultBaselinePath(config.model, config.reasoningEffort);
}

/**
 * Parses the command line into run options (throws HarnessError on bad usage
 * or an invalid model setting). `envFile` ({ path, vars }: the env file and
 * the variables it set) only lets the header say where MODEL_NAME or
 * REASONING_EFFORT came from.
 */
export function parseEvalArgs(argv, { profile: defaultProfile = 'eval', env = process.env, envFile = null } = {}) {
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
  // --model / MODEL_NAME / DEFAULT_MODEL and --reasoning-effort /
  // REASONING_EFFORT (validated for the model), plus the endpoint settings.
  let modelConfig;
  try {
    modelConfig = resolveModelConfig({
      env,
      flags: { model: getOptionValue(argv, '--model'), reasoningEffort: getOptionValue(argv, '--reasoning-effort') },
      envFile,
    });
  } catch (error) {
    throw new HarnessError(error.message, { code: error.code || 'INVALID_CONFIG', cause: error });
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
    model: modelConfig.model,
    modelSource: modelConfig.modelSource,
    reasoningEffort: modelConfig.reasoningEffort,
    reasoningEffortSource: modelConfig.reasoningEffortSource,
    // The whole resolved configuration (endpoint settings, notices, the env
    // file a setting came from); not recorded in runner.flags.
    modelConfig,
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
    baselineFile: getOptionValue(argv, '--baseline-file') ? path.resolve(getOptionValue(argv, '--baseline-file')) : null,
    rescore: rescore ? path.resolve(rescore) : null,
    offline,
    outputDir: path.resolve(getOptionValue(argv, '--output-dir') || DEFAULT_RUNS_DIR),
    traceDir: getOptionValue(argv, '--trace-dir') ? path.resolve(getOptionValue(argv, '--trace-dir')) : null,
    resultsFile: getOptionValue(argv, '--results-file') ? path.resolve(getOptionValue(argv, '--results-file')) : null,
    traceFile: getOptionValue(argv, '--trace-file') ? path.resolve(getOptionValue(argv, '--trace-file')) : null,
    traceToStdout: hasOptionFlag(argv, '--trace'),
    revealHoldout: hasOptionFlag(argv, '--reveal-holdout'),
    holdoutSummary: hasOptionFlag(argv, '--holdout-summary'),
    failOnAnyFailure: benchmark,
    argv: [...argv],
  };
  if (options.writeBaseline && (options.rescore || options.offline)) {
    throw usageError('--write-baseline only applies to a live run.');
  }
  if (options.baselineFile && !options.writeBaseline) {
    throw usageError('--baseline-file only applies with --write-baseline.');
  }
  if (writesDefaultBaseline(options) && path.resolve(baselineTarget(options)) !== defaultBaselinePath(options.model, options.reasoningEffort)) {
    // eval/baselines/<model>[.<effort>].json is what runs of <model> at that
    // effort pair with: another name there would replace another model's
    // baseline (or invent one).
    throw usageError(
      `--baseline-file ${repoRelative(options.baselineFile)} is inside ${repoRelative(DEFAULT_BASELINES_DIR)}, which holds only each model's default baseline; ` +
        `this run's model ${modelLabel(options.model, options.reasoningEffort)} writes ${repoRelative(defaultBaselinePath(options.model, options.reasoningEffort))}. ` +
        'Save elsewhere, or run with --model (and --reasoning-effort) matching the file name.'
    );
  }
  if (writesDefaultBaseline(options)) {
    // The committed baseline is what later runs pair with: a subset would
    // hide regressions in every case it leaves out.
    const subset = [
      describeFilters({ split: options.split, caseIds: options.caseIds, tags: options.tags, intents: options.intents }),
      options.fixtureNames && resolveFixtures(options.fixtureNames).length < FIXTURES.length ? `fixtures=${options.fixtureNames}` : '',
    ].filter(Boolean);
    if (subset.length > 0) {
      throw usageError(
        `--write-baseline would replace ${repoRelative(baselineTarget(options))} with a subset run (${subset.join('; ')}); ` +
          'the default baseline covers the whole default suite on every fixture. Drop the filters, or pass --baseline-file <path> to save this subset elsewhere.'
      );
    }
  }
  return options;
}

/** Where --write-baseline writes: --baseline-file, else eval/baselines/<model>[.<effort>].json. */
export function baselineTarget(options) {
  return options.baselineFile || defaultBaselinePath(options.model, options.reasoningEffort);
}

/**
 * Whether --write-baseline targets a default baseline: any file inside
 * eval/baselines/ (every model's, not only this run's), since later runs of
 * that model pair with it.
 */
export function writesDefaultBaseline(options) {
  if (!options.writeBaseline) {
    return false;
  }
  const relative = path.relative(DEFAULT_BASELINES_DIR, path.resolve(baselineTarget(options)));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Why the selected suite must not become the default baseline (null when it
 * may): filters, or a case set (ids, and the question and scoring of each)
 * that is not exactly the default suite's (`defaultSelection`, every dataset
 * of datasets/), e.g. --dataset core-public, --dataset-file or another
 * --datasets-dir.
 */
export function baselineSuiteRefusal(selection, defaultSelection) {
  const filters = describeFilters(selection.filters || {});
  if (filters) {
    return `the run uses filters ${filters}`;
  }
  const identity = (testCase) => `${String(testCase.question || '').trim().toLowerCase()}\u0000${scoringFingerprint(testCase)}`;
  const mine = new Map(selection.entries.map((entry) => [entry.testCase.id, identity(entry.testCase)]));
  const full = new Map(defaultSelection.entries.map((entry) => [entry.testCase.id, identity(entry.testCase)]));
  const list = (ids) => (ids.length > 10 ? `${ids.slice(0, 10).join(', ')}, and ${ids.length - 10} more` : ids.join(', '));
  const missing = [...full.keys()].filter((id) => !mine.has(id));
  const extra = [...mine.keys()].filter((id) => !full.has(id));
  const changed = [...mine.keys()].filter((id) => full.has(id) && full.get(id) !== mine.get(id));
  const problems = [];
  if (missing.length > 0) {
    problems.push(`the run selects ${full.size - missing.length} of the default suite's ${full.size} case(s) (missing: ${list(missing)})`);
  }
  if (extra.length > 0) {
    problems.push(`the run has cases that are not in the default suite (${list(extra)})`);
  }
  if (changed.length > 0) {
    problems.push(`the run has cases scored differently from the default suite (${list(changed)})`);
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

// A rescore runs the recording's model settings (provenance.product): the
// configured ones only pick the default baseline to rescore, so its runner
// block records them under names that do not read as the run's model.
const RESCORE_MODEL_FLAG_NAMES = Object.freeze({
  model: 'configuredModel',
  modelSource: 'configuredModelSource',
  reasoningEffort: 'configuredReasoningEffort',
  reasoningEffortSource: 'configuredReasoningEffortSource',
});

/**
 * Every parsed option, as recorded in the report's runner block (none is a
 * secret; absolute paths are made repo-relative). The resolved model
 * configuration is left out: its model and effort (with their sources) are
 * options of their own, and the product block of the provenance records the
 * request options. `rescore`: the model options are renamed configured*.
 */
export function describeRunnerFlags(options, { rescore = false } = {}) {
  const relative = (value) => (typeof value === 'string' && path.isAbsolute(value) ? repoRelative(value) : value);
  return Object.fromEntries(
    Object.entries(options)
      .filter(([key]) => key !== 'argv' && key !== 'modelConfig')
      .map(([key, value]) => [(rescore && RESCORE_MODEL_FLAG_NAMES[key]) || key, Array.isArray(value) ? value.map(relative) : relative(value)])
  );
}

function markdownPathFor(reportPath) {
  return reportPath.endsWith('.json') ? `${reportPath.slice(0, -'.json'.length)}.md` : `${reportPath}.md`;
}

/**
 * With --gate, the paired comparison must cover at least this fraction of the
 * run's cases. Below it (and always when no case pairs: an unrelated or empty
 * baseline, renamed ids, or changed gold for every shared case) the
 * regression gate has not tested the run, so the run exits 2 instead of
 * passing. Half is the floor: a baseline that cannot pair most of the suite is
 * stale and must be refreshed (npm run eval -- --write-baseline).
 */
export const MIN_GATE_PAIRED_FRACTION = 0.5;

/** Why --gate cannot trust this comparison (null when it can). */
export function gatePairingFailure(comparison, { minFraction = MIN_GATE_PAIRED_FRACTION } = {}) {
  const goldChanged = comparison.excluded?.goldChanged?.length || 0;
  const notCounted = comparison.excluded?.notCounted?.length || 0;
  const newCases = comparison.newCases?.length || 0;
  const paired = comparison.paired || 0;
  const total = comparison.candidateCases ?? paired + goldChanged + notCounted + newCases;
  const why = [
    goldChanged ? `${goldChanged} with changed gold or scoring` : null,
    notCounted ? `${notCounted} not counted or timed out in one report` : null,
    newCases ? `${newCases} not in the baseline` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const label = comparison.baseline?.label ? ` ${comparison.baseline.label}` : '';
  const advice = 'refresh the baseline (npm run eval -- --write-baseline) or pass --compare <report.json> with a baseline of this suite';
  if (paired === 0 || comparison.verdict === 'no_paired_cases') {
    return `--gate compared no case with the baseline${label}: 0 of this run's ${total} case(s) paired${why ? ` (${why})` : ''}; ${advice}`;
  }
  if (paired < minFraction * total) {
    return (
      `--gate compared only ${paired} of this run's ${total} case(s) with the baseline${label} (below ${Math.round(minFraction * 100)}%)` +
      `${why ? `: ${why}` : ''}; ${advice}`
    );
  }
  return null;
}

/**
 * How much of today's suite (its answer cases: abstain / clarify cases are
 * never compared) a rescore's comparison covers: { suiteCases,
 * paired, notInReport, goldChanged, notCounted, notInBaseline } (id lists).
 * A rescore re-judges the RECORDED cases: one whose id is no longer in the
 * suite (renamed) is rescored from its recorded definition and pairs with its
 * own recording, and a suite case the recorded report lacks is never looked
 * at. The rescore's own pairing (comparison.paired against
 * comparison.candidateCases) therefore says nothing about today's suite; only
 * suite cases among the paired ones (same id, same gold and scoring, counted
 * in both) were actually checked.
 */
export function describeSuiteCoverage(suiteEntries, comparison) {
  const idsOf = (list) => new Set((list || []).map((entry) => (typeof entry === 'string' ? entry : entry.id)));
  const paired = idsOf(comparison.pairedCases);
  const goldChanged = idsOf(comparison.excluded?.goldChanged);
  const notCounted = idsOf(comparison.excluded?.notCounted);
  const notInBaseline = idsOf(comparison.newCases);
  // Abstain / clarify cases are never compared (not in strict accuracy), so
  // they are not part of what the gate must have checked.
  const suiteIds = [...new Set(suiteEntries.filter((entry) => !isBehaviorCase(entry.testCase)).map((entry) => entry.testCase.id))].sort();
  const pick = (set) => suiteIds.filter((id) => set.has(id));
  return {
    suiteCases: suiteIds.length,
    paired: pick(paired).length,
    notInReport: suiteIds.filter((id) => !paired.has(id) && !goldChanged.has(id) && !notCounted.has(id) && !notInBaseline.has(id)),
    goldChanged: pick(goldChanged),
    notCounted: pick(notCounted),
    notInBaseline: pick(notInBaseline),
  };
}

/** Why --gate on a rescore has not checked enough of today's suite (null when it has). */
export function gateSuiteCoverageFailure(coverage, { minFraction = MIN_GATE_PAIRED_FRACTION, label = '' } = {}) {
  if (!coverage || !(coverage.suiteCases > 0)) {
    return null;
  }
  const { suiteCases, paired } = coverage;
  if (paired > 0 && paired >= minFraction * suiteCases) {
    return null;
  }
  const why = [
    coverage.notInReport.length ? `${coverage.notInReport.length} not in the rescored report` : null,
    coverage.goldChanged.length ? `${coverage.goldChanged.length} with changed gold or scoring` : null,
    coverage.notCounted.length ? `${coverage.notCounted.length} not counted or timed out in one report` : null,
    coverage.notInBaseline.length ? `${coverage.notInBaseline.length} not in the baseline` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const scope = paired === 0 ? `none of today's ${suiteCases} suite case(s)` : `only ${paired} of today's ${suiteCases} suite case(s) (below ${Math.round(minFraction * 100)}%)`;
  return (
    `--gate checked ${scope} against the baseline${label ? ` ${label}` : ''}${why ? `: ${why}` : ''}; ` +
    'the recorded report no longer covers the suite, so refresh the baseline (npm run eval -- --write-baseline)'
  );
}

function minAccuracyWithoutAnswerCases(minAccuracy, behaviorCases) {
  return (
    `--min-accuracy ${minAccuracy} cannot be checked: no answer case was selected ` +
    `(only ${behaviorCases} abstain / clarify case(s), which are scored apart from strict accuracy), so there is no accuracy to compare; ` +
    'select answer cases or drop --min-accuracy'
  );
}

/**
 * Why --gate --min-accuracy cannot run on these (selected, normalized) cases,
 * or null: with only abstain / clarify cases selected there is no strict
 * accuracy, so the threshold would compare nothing. Checked before any LLM
 * call (and again by computeExitCode); exit 2.
 */
export function minAccuracyRefusal({ gate = false, minAccuracy = null } = {}, testCases = []) {
  if (!gate || minAccuracy == null || testCases.length === 0 || testCases.some((testCase) => !isBehaviorCase(testCase))) {
    return null;
  }
  return minAccuracyWithoutAnswerCases(minAccuracy, testCases.length);
}

/**
 * Exit code of a finished run: { code, reasons }. 2 for harness, dataset or
 * infrastructure failures, and for a --gate whose baseline pairs too few cases
 * (gatePairingFailure); 1 for a failed --gate (or, in the benchmark profile,
 * any failed case in a single-repetition run: an answer case that did not
 * pass, or an abstain / clarify case the model answered); else 0.
 */
export function computeExitCode(report, { gate = false, minAccuracy = null, failOnAnyFailure = false, revealHoldout = false, holdoutSummary = false } = {}) {
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
  // A selection of only abstain / clarify cases has no accuracy by design,
  // so an accuracy threshold has nothing to compare with.
  const answerCases = (report.stats?.cases?.selected ?? 0) - (report.stats?.cases?.behavior ?? 0);
  if (report.stats?.strictAccuracy?.value == null) {
    if (answerCases > 0 || !(report.behavior?.cases > 0)) {
      harness.push('no case was counted, so there is no accuracy to report');
    } else if (gate && minAccuracy != null) {
      harness.push(minAccuracyWithoutAnswerCases(minAccuracy, report.behavior.cases));
    }
  }
  if (gate && report.comparison) {
    const pairing = gatePairingFailure(report.comparison);
    if (pairing) {
      harness.push(pairing);
    }
    // A rescore: the pairing must also cover today's suite (describeSuiteCoverage).
    const coverage = gateSuiteCoverageFailure(report.comparison.suiteCoverage, { label: report.comparison.baseline?.label || '' });
    if (coverage) {
      harness.push(coverage);
    }
  }
  if (harness.length > 0) {
    return { code: 2, reasons: harness };
  }
  const failures = [];
  if (gate) {
    // The gate tests every paired case, holdout included. Unless
    // revealHoldout, report.md and the console show the comparison over the
    // dev cases only, so when a holdout case is paired the reason gives no
    // counts: every case's counts minus the dev ones would be the holdout's
    // flips. With no holdout case paired (a baseline-only holdout case, say)
    // the counts are the dev comparison's own. A comparison without its
    // pairs is treated as pairing its holdout cases. holdoutSummary
    // (--holdout-summary) changes neither the code nor the counts withheld,
    // only where the reason points: the paired holdout cases' aggregate line
    // (when the comparison has its pairs, as that line needs).
    const holdoutIds = new Set(report.comparison?.holdoutCases || []);
    const pairs = report.comparison?.pairedCases;
    const holdoutPaired = Array.isArray(pairs) ? pairs.some((entry) => holdoutIds.has(entry.id)) : holdoutIds.size > 0;
    const holdoutHidden = !revealHoldout && holdoutPaired;
    if (report.comparison?.verdict === 'worse' && holdoutHidden) {
      const shown =
        holdoutSummary && Array.isArray(pairs)
          ? 'report.md shows the dev cases and, in one line (--holdout-summary), the paired holdout cases in aggregate; --reveal-holdout every case'
          : 'report.md shows the dev cases, --reveal-holdout every case';
      failures.push(
        'significantly worse than the baseline (exact McNemar test over every paired case, holdout included; its counts are not shown while ' +
          `the holdout is hidden: ${shown})`
      );
    } else if (report.comparison?.verdict === 'worse') {
      failures.push(
        `significantly worse than the baseline: ${report.comparison.mcnemar.regressions} regression(s) vs ${report.comparison.mcnemar.improvements} improvement(s), exact McNemar p = ${report.comparison.mcnemar.p}`
      );
    }
    if (minAccuracy != null && report.stats.strictAccuracy.value < minAccuracy) {
      failures.push(`strict accuracy ${report.stats.strictAccuracy.value} < --min-accuracy ${minAccuracy}`);
    }
  }
  if (failOnAnyFailure && report.stats.repeat <= 1) {
    // An answer case fails when a counted repetition did not pass; an abstain
    // / clarify case (never counted in accuracy) when a repetition scored for
    // its behaviour did not decline: the model answered, or (outcome
    // llm_error) its call failed without SQL and without a decline code.
    //
    // The reason is printed: unless revealHoldout it counts the dev cases
    // only (holdout display policy), since counts over every case minus the
    // listed dev rows would give hidden holdout outcomes away. A failed
    // holdout case still fails the run.
    const all = report.results || [];
    const answerFailedOf = (record) => record.summary.counted > 0 && record.summary.passes < record.summary.counted;
    const behaviorFailedOf = (record) => record.summary.behavior?.counted > 0 && record.summary.behavior.handled < record.summary.behavior.counted;
    const hiddenRecords = revealHoldout ? [] : all.filter(isHoldoutCase);
    const records = revealHoldout ? all : all.filter((record) => !isHoldoutCase(record));
    const answerFailed = records.filter(answerFailedOf).length;
    const behaviorFailedRecords = records.filter(behaviorFailedOf);
    const behaviorFailed = behaviorFailedRecords.length;
    const holdoutNote = 'holdout results are read in aggregate only, --reveal-holdout counts them';
    if (answerFailed + behaviorFailed === 0 && hiddenRecords.some((record) => answerFailedOf(record) || behaviorFailedOf(record))) {
      failures.push(`holdout case(s) failed (benchmark profile, single run; not itemized: ${holdoutNote})`);
    } else if (answerFailed + behaviorFailed > 0) {
      const answered = behaviorFailedRecords.filter((record) =>
        (record.repetitions || []).some((repetition) => repetition.behavior_counted && String(repetition.outcome).startsWith('answered_instead_of_'))
      ).length;
      const parts = [answered > 0 ? `${answered} answered` : '', behaviorFailed - answered > 0 ? `${behaviorFailed - answered} errored` : ''].filter(Boolean);
      const behavior = behaviorFailed > 0 ? `; ${behaviorFailed} abstain/clarify case(s) not declined: ${parts.join(', ')}` : '';
      const hidden = hiddenRecords.length > 0 ? `; holdout cases are not counted here: ${holdoutNote}` : '';
      failures.push(`${answerFailed + behaviorFailed} case(s) failed (benchmark profile, single run${behavior}${hidden})`);
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

/**
 * Throws REPORT_INVALID unless `report` reads as an evaluation report.json:
 * an object with a non-empty results[] whose entries carry a case id and a
 * summary (report version 2) or a status (a pre-runner report), and no
 * report version newer than this runner's. `{}`, another JSON file or an
 * empty report would otherwise compare as "no paired cases".
 */
export function validateBaselineReport(report, filePath) {
  const fail = (message) => new HarnessError(message, { code: 'REPORT_INVALID' });
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.results)) {
    throw fail(`${filePath} is not an evaluation report (no results[]); pass a report.json written by npm run eval.`);
  }
  if ('reportVersion' in report && !(Number.isInteger(report.reportVersion) && report.reportVersion >= 1 && report.reportVersion <= REPORT_VERSION)) {
    const version = typeof report.reportVersion === 'number' ? report.reportVersion : JSON.stringify(report.reportVersion);
    throw fail(`${filePath} has report version ${version} (unknown: this runner reads up to ${REPORT_VERSION}).`);
  }
  // A compact baseline (--write-baseline) is a report too, of a known compact version.
  const compactProblem = compactReportProblem(report);
  if (compactProblem) {
    throw fail(`${filePath} ${compactProblem}.`);
  }
  if (report.results.length === 0) {
    throw fail(`${filePath} has no cases (results[] is empty).`);
  }
  for (const [index, result] of report.results.entries()) {
    if (!result || typeof result.id !== 'string' || result.id === '') {
      throw fail(`${filePath}: results[${index}] has no case id; is it an evaluation report.json?`);
    }
    if (!result.summary && typeof result.status !== 'string') {
      throw fail(`${filePath}: results[${index}] (${result.id}) has neither a summary nor a status; is it an evaluation report.json?`);
    }
  }
  return report;
}

async function readBaselineReport(filePath) {
  return validateBaselineReport(await readJson(filePath, 'baseline report'), filePath);
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

/**
 * One console progress line for a finished repetition (exported for tests).
 * A holdout case shows neither its id nor its verdict unless revealHoldout
 * (holdout results are read in aggregate only).
 */
export function formatProgress({ testCase, repetition, result, completed, total, repeat, revealHoldout = false }) {
  const width = String(total).length;
  if (!revealHoldout && isHoldoutCase(testCase)) {
    const rep = repeat > 1 ? ` rep ${repetition}/${repeat}` : '';
    return `[${String(completed).padStart(width)}/${total}] done a holdout case${rep} (result hidden: aggregate only)`;
  }
  let status =
    result.status === 'aborted' && result.timed_out
      ? `timeout${result.late_status ? ` (finished late: ${result.late_status})` : ''}`
      : result.status === 'expected_sql_error' && result.error_infra
        ? 'expected_sql_error (the database failed)'
        : result.status;
  let passed = status === 'pass';
  if (isBehaviorCase(testCase)) {
    // An abstain / clarify case passes when the product returned no SQL. A
    // repetition that is not judged on that (a timeout, an outage, a budget
    // skip) keeps its usual label.
    const judged = classifyRepetition(result, testCase);
    if (judged.behavior_counted) {
      passed = judged.outcome === 'declined';
      status = `${judged.outcome} (expects ${testCase.expected_behavior})`;
    }
  }
  const label = passed ? 'ok  ' : status === 'skipped_budget' || status === 'cancelled' ? 'skip' : 'FAIL';
  const totalMs = result.timings?.totalMs;
  const seconds = Number.isFinite(totalMs) ? (totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${Math.round(totalMs)}ms`) : '';
  const cost = Number.isFinite(result.llm_cost?.totalCost) ? `$${result.llm_cost.totalCost.toFixed(5)}` : '';
  const rep = repeat > 1 ? ` rep ${repetition}/${repeat}` : '';
  const warnings = result.warnings?.length ? ` (warnings: ${result.warnings.join(', ')})` : '';
  return `[${String(completed).padStart(width)}/${total}] ${label} ${testCase.id}${rep}: ${status}${warnings} ${seconds} ${cost}`.trimEnd();
}

function printVerification(cli, verification) {
  for (const dataset of verification.datasets) {
    const { design, heldout, positive } = dataset.controls || {};
    const count = (key) => (design?.[key]?.length || 0) + (heldout?.[key]?.length || 0);
    const controls = dataset.controls
      ? `; design kill rate ${design.killed}/${design.total}, held-out ${heldout.killed}/${heldout.total}, ` +
        `positive ${positive.matched}/${positive.total}; undecided ${count('undecided')}, invalid ${count('invalid')}, unscored ${count('unscored')}`
      : '';
    cli.log(`  ${dataset.name}: ${dataset.cases} case(s), ${dataset.failures} with problems${controls}`);
  }
  for (const problem of verification.problems) {
    cli.log(`  ✗ ${problem.id} (${problem.datasets.join(', ')}): ${problem.problems.join('; ')}`);
  }
  for (const id of verification.controlStatus?.undecided || []) {
    cli.log(`  undecided (mapping search cut off, counted as not killed): ${id}`);
  }
  for (const warning of verification.warnings || []) {
    cli.log(`  warning: ${warning} (npm run verify-dataset fails on this)`);
  }
  for (const failure of verification.gateFailures) {
    cli.log(`  FAIL: ${failure}`);
  }
}

/**
 * Why the in-process verify gate stops the run before any LLM call (null when
 * it passes): a case problem (a failing gold, a positive control that does not
 * match, ...), a kill-rate gate failure, or a negative control that is not a
 * verdict. An invalid control (an SQL error on some fixture) or an unscored
 * one (an infrastructure error) is a problem, never a kill, as in
 * verify-dataset; an undecided control (mapping search cut off) only counts
 * as not killed, so it can fail the kill-rate gate but is not a problem itself.
 */
export function verificationRefusal(verification) {
  const invalid = verification.controlStatus?.invalid || [];
  const unscored = verification.controlStatus?.unscored || [];
  const problems = verification.problems?.length || 0;
  const gateFailures = verification.gateFailures?.length || 0;
  if (problems === 0 && gateFailures === 0 && invalid.length === 0 && unscored.length === 0) {
    return null;
  }
  const parts = [`${problems} case(s) with problems, ${gateFailures} gate failure(s)`];
  if (invalid.length + unscored.length > 0) {
    parts.push(
      `${invalid.length} invalid and ${unscored.length} unscored negative control(s) (${[...invalid, ...unscored].join(', ')}): ` +
        `a control that does not execute is a problem, not a kill${unscored.length > 0 ? '; the database failed while scoring some, rerun once it is healthy' : ''}`
    );
  }
  return `Verification failed (${parts.join('; ')}); no LLM call was made. Fix the dataset, controls or fixtures, or pass --skip-verify to run anyway.`;
}

/**
 * Writes report.json and report.md and prints the console headline. What they
 * show of the holdout follows --reveal-holdout (revealHoldout) and
 * --holdout-summary (holdoutSummary: one aggregate line for the comparison's
 * paired holdout cases).
 */
export async function writeReport(report, { reportPath, cli, revealHoldout = false, holdoutSummary = false }) {
  const markdownPath = markdownPathFor(reportPath);
  await writeJsonFile(reportPath, report);
  await fs.writeFile(markdownPath, renderReportMarkdown(report, { revealHoldout, holdoutSummary }), 'utf8');
  cli.log('');
  cli.log(renderHeadline(report, { revealHoldout, holdoutSummary }));
  cli.log('');
  cli.log(`Report: ${markdownPath}`);
  cli.log(`JSON:   ${reportPath}`);
  if (report.traceFile) {
    cli.log(`Trace:  ${path.resolve(REPO_ROOT, report.traceFile)}`);
  }
  return markdownPath;
}

async function loadBaseline(options, model, cli, reasoningEffort = options.reasoningEffort ?? null) {
  let baselinePath = options.compare;
  if (!baselinePath && !options.noBaseline) {
    const candidate = defaultBaselinePath(model, reasoningEffort);
    if (await fileExists(candidate)) {
      baselinePath = candidate;
    }
  }
  if (!baselinePath) {
    return null;
  }
  const report = await readBaselineReport(baselinePath);
  cli.log(`Baseline: ${baselinePath}`);
  const note = baselineModelNote(report, model, reasoningEffort);
  if (note) {
    cli.log(note);
  }
  return { path: baselinePath, report };
}

/**
 * The console note when a baseline ran another model or reasoning effort
 * than this run (a report from before REASONING_EFFORT sent none); null when
 * both match.
 */
export function baselineModelNote(report, model, reasoningEffort = null) {
  const baselineEffort = report?.provenance?.product?.reasoningEffort ?? null;
  if ((!report?.model || report.model === model) && baselineEffort === (reasoningEffort ?? null)) {
    return null;
  }
  return (
    `  note: the baseline was run with ${modelLabel(report?.model || 'an unrecorded model', baselineEffort)}, this run uses ${modelLabel(model, reasoningEffort)}: ` +
    'the comparison measures the model change too.'
  );
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
  const candidate = defaultBaselinePath(options.model, options.reasoningEffort);
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
// further call would fail the same way. They are LLM outages in attribution
// (isLlmUnavailableCode: excluded from accuracy, exit 2), and the first one
// stops the run.
const CONFIG_REJECTION_CODES = new Set(['HTTP_401', 'HTTP_403', 'HTTP_404', 'LLM_MODEL_NOT_FOUND']);

/** Why a repetition's result must stop the run (a provider configuration rejection), or null. */
export function providerConfigRejection(result) {
  if (result?.status !== 'llm_error' || !CONFIG_REJECTION_CODES.has(result.error_code)) {
    return null;
  }
  return `the LLM provider rejected the request (${result.error_code}: check OPENAI_API_KEY, OPENAI_BASE_URL and the model); no further case is started`;
}

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
        ? 'OPENAI_API_KEY is required for a live run (set it in .env or the shell; OPENROUTER_API_KEY also works with an https://openrouter.ai OPENAI_BASE_URL). ' +
          'Use --offline or --rescore <report.json> to evaluate without LLM calls.'
        : `Cannot create the OpenAI client: ${error.message}`,
      { code: error.code || 'OPENAI_NOT_CONFIGURED', cause: error }
    );
  }
  const pricingRefusal = budgetPricingRefusal(options);
  if (pricingRefusal) {
    throw new HarnessError(pricingRefusal, { code: 'NO_PRICING' });
  }
  return client;
}

/**
 * Why a live run with --budget-usd must not start (null when it may): the
 * model has no price (a row in src/pricing.js, found without a vendor prefix,
 * or a MODEL_PRICING_OVERRIDES entry), so its spend, and the budget, cannot
 * be tracked. A provider-reported cost only arrives after a call.
 */
export function budgetPricingRefusal(options) {
  if (options.budgetUsd == null || hasModelPrice(options.model)) {
    return null;
  }
  return (
    `--budget-usd needs a price for model "${options.model}" (src/pricing.js, or MODEL_PRICING_OVERRIDES with inputPerMillion and outputPerMillion); ` +
    'without it the budget cannot be enforced, so the run does not start.'
  );
}

async function runLive({ options, cli, schema, schemaScope, hintsVersion, modelConfig, selection, connections, fixtureStatus, controlsIndex, verification, client, signals = process }) {
  const model = modelConfig.model;
  const { reasoningEffort } = modelConfig;
  const completionSettings = completionSettingsOf(modelConfig);
  const maxRetries = resolveMaxRetries();
  const statementTimeoutMs = resolveStatementTimeoutMs();
  // generated/runs/<timestamp>/<suite>/<model>[.<effort>]/
  const runPaths = createBenchmarkRunPaths({ datasetName: selection.name, model: modelFileLabel(model, reasoningEffort), outputDir: options.outputDir, traceDir: options.traceDir });
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
    modelConfig: {
      model,
      modelSource: modelConfig.modelSource,
      reasoningEffort,
      reasoningEffortSource: modelConfig.reasoningEffortSource,
      completionSettings,
    },
    runner,
    schemaScope,
    hintsVersion,
  });
  const suite = describeSuite(selection, { repoRelative });
  // Read the baseline before spending anything: a broken file fails fast.
  const baseline = await loadBaseline(options, model, cli, reasoningEffort);
  const trace = await createTraceLogger({
    enabled: true,
    logToStdout: options.traceToStdout,
    filePath: tracePath,
    pipeline: 'evaluate',
    metadata: { script: 'scripts/eval.js', datasetName: selection.name, ...traceMetadataFromProvenance(provenance) },
  });
  await trace.emit('run.started', {
    model,
    reasoningEffort,
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
    `\nRunning ${entries.length} case(s) × ${options.repeat} repetition(s) with ${model} (reasoning effort ${describeReasoningEffort(reasoningEffort)}) ` +
      `on ${options.concurrency} worker(s); ` +
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
          reasoningEffort,
          completionSettings,
          testCase,
          caseIndex: caseIndex + 1,
          datasetName: entries[caseIndex].datasets[0],
          // Every trace line of this case carries its repetition number.
          trace: { enabled: true, emit: (event, payload = {}) => trace.emit(event, { ...payload, repetition }) },
          goldCache,
          maxRetries,
          statementTimeoutMs,
          signal,
          schemaScope,
          hintsVersion,
        }),
      onResult: async (info) => {
        cli.log(formatProgress({ ...info, repeat: options.repeat, revealHoldout: options.revealHoldout }));
        // A rejected key, a wrong endpoint or an unknown model fails every
        // call the same way: stop instead of attempting every case.
        const rejection = providerConfigRejection(info.result);
        if (rejection) {
          stop.stop(rejection);
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
    await writeReport(report, { reportPath, cli, revealHoldout: options.revealHoldout, holdoutSummary: options.holdoutSummary });
    const exit = stop.interruptedBy
      ? { code: 130, reasons: [`interrupted by ${stop.interruptedBy}; ${run.stopped ? 'the report is partial' : 'the run had finished, the report is complete'}`] }
      : computeExitCode(report, options);
    if (options.writeBaseline) {
      const target = baselineTarget(options);
      const refusal = baselineRefusal(report, exit);
      if (refusal) {
        cli.log(`Baseline NOT written: ${refusal}; ${repoRelative(target)} is left as it was.`);
      } else {
        // Compact: what --offline/--rescore, --compare/--gate and the
        // summaries need (src/eval/compact-report.js); report.json stays full.
        const bytes = await writeCompactReport(target, report); // printed in MB of 10^6 bytes
        cli.log(`Baseline written: ${target} (compact, ${(bytes / 1e6).toFixed(2)} MB; the full report is ${reportPath})`);
        if (!writesDefaultBaseline(options) && (describeFilters(selection.filters) || options.datasetNames.length || options.datasetFiles.length)) {
          cli.log('  note: this run used a subset of the default suite; compare with it explicitly (--compare), it is not the default baseline.');
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

/**
 * The console note of a rescore whose recording ran other model settings
 * than the configured ones (a rescore keeps the recording's; the configured
 * ones only picked the default baseline to rescore); null when they match.
 */
export function rescoreModelNote(recorded, configured) {
  if (recorded.model === configured.model && (recorded.reasoningEffort ?? null) === (configured.reasoningEffort ?? null)) {
    return null;
  }
  return (
    `  note: the recording ran ${modelLabel(recorded.model, recorded.reasoningEffort ?? null)}, and a rescore keeps its model settings; ` +
    `the configured ${modelLabel(configured.model, configured.reasoningEffort ?? null)} is not used.`
  );
}

async function runRescore({ options, cli, schema, schemaScope, hintsVersion, modelConfig, selection, connections, fixtureStatus, controlsIndex, verification }) {
  let sourcePath = options.rescore;
  if (!sourcePath) {
    const candidate = defaultBaselinePath(options.model, options.reasoningEffort);
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
  const compactProblem = compactReportProblem(recorded);
  if (compactProblem) {
    throw new HarnessError(`${sourcePath} ${compactProblem}.`, { code: 'REPORT_INVALID' });
  }
  const model = recorded.model || options.model;
  // A rescore makes no LLM call: the model settings are the recording's
  // (null effort for a report from before REASONING_EFFORT).
  const recordedProduct = recorded.provenance?.product || {};
  const recordedModelConfig = {
    model,
    modelSource: 'recorded',
    reasoningEffort: recordedProduct.reasoningEffort ?? null,
    reasoningEffortSource: 'recorded',
    requestOptions: recordedProduct.requestOptions ?? null,
  };
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const currentCases = new Map(selection.entries.map((entry) => [entry.testCase.id, entry.testCase]));
  // The selection filters pick which recorded cases are rescored (judged on
  // today's case definition when there is one). As in a live run, a dropped
  // duplicate's id selects the case kept in its place.
  const { caseIds, aliasedCaseIds } = resolveCaseIdAliases(options.caseIds, selection.duplicates);
  for (const alias of aliasedCaseIds) {
    cli.log(`  note: --case-id ${alias.id} is a duplicate of ${alias.keptAs} (same question and gold), which is rescored in its place.`);
  }
  const filters = { split: options.split, caseIds, tags: options.tags, intents: options.intents };
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
  const thresholdRefusal = minAccuracyRefusal(options, source.results.map((record) => currentCases.get(record.id) || testCaseFromRecord(record)));
  if (thresholdRefusal) {
    throw new HarnessError(thresholdRefusal, { code: 'NO_ANSWER_CASES' });
  }
  const primary = connections.find((entry) => entry.name === PRIMARY_FIXTURE.name) || connections[0];
  const validate = createValidatorProbe({ schema, connection: primary.connection, statementTimeoutMs, schemaScope, hintsVersion });
  const goldCache = createGoldCache();
  const recordedScope = source.provenance?.product?.schemaScope || null;
  const recordedHintsVersion = source.provenance?.product?.hintsVersion ?? null;
  cli.log(`\nRescoring ${source.results.length} case(s) from ${sourcePath} with zero LLM calls...`);
  const modelNote = rescoreModelNote(recordedModelConfig, modelConfig);
  if (modelNote) {
    cli.log(modelNote);
  }
  const scopeNote = rescoreSchemaScopeNote(recordedScope, validate.schemaScope);
  if (scopeNote) {
    cli.log(scopeNote);
  }
  const hintsNote = rescoreHintsVersionNote(recordedHintsVersion, validate.hintsVersion);
  if (hintsNote) {
    cli.log(hintsNote);
  }
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
  let hiddenHoldout = 0;
  for (const record of caseRecords) {
    if (!options.revealHoldout && isHoldoutCase(record)) {
      hiddenHoldout += 1;
      continue;
    }
    const before = source.results.find((entry) => entry.id === record.id);
    // Behaviour cases count declined repetitions, not passes (as in report.md).
    const behavior = isBehaviorCase(record);
    const passText = (summary) => (behavior ? behaviorPassText(summary) : `${summary.passes}/${summary.counted}`);
    const was = before?.summary ? passText(before.summary) : before?.status;
    cli.log(`  ${record.id}: ${passText(record.summary)} ${record.summary.outcome} (recorded: ${was})`);
  }
  if (hiddenHoldout > 0) {
    cli.log(`  ${hiddenHoldout} holdout case(s) rescored; results shown in aggregate only (--reveal-holdout lists them).`);
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
    flags: describeRunnerFlags(options, { rescore: true }),
  };
  const provenance = await collectProvenance({
    schema,
    schemaPath: SCHEMA_PATH,
    fixtures: fixtureStatus,
    datasets: selection.datasets,
    controlsFiles: (controlsIndex?.files || []).map((name) => path.join(options.controlsDir, name)),
    model,
    modelConfig: recordedModelConfig,
    runner,
    schemaScope,
    hintsVersion,
  });
  const generatedAt = new Date().toISOString();
  const baseline = options.compare
    ? { path: options.compare, report: await readBaselineReport(options.compare) }
    : { path: sourcePath, report: source };
  const comparison = compareReports(
    baseline.report,
    { results: caseRecords, model, generatedAt, provenance, mode: 'rescore' },
    { baselineLabel: repoRelative(baseline.path), candidateLabel: 'rescore' }
  );
  // Today's suite (with the same filters): what the gate must have checked.
  comparison.suiteCoverage = describeSuiteCoverage(describeFilters(filters) ? filterSuiteEntries(selection.entries, filters) : selection.entries, comparison);
  const runPaths = createBenchmarkRunPaths({ datasetName: `${suite.name}-rescore`, model: modelFileLabel(model, recordedModelConfig.reasoningEffort), outputDir: options.outputDir });
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
      schemaScope: recordedScope,
      hintsVersion: recordedHintsVersion,
      reasoningEffort: recordedModelConfig.reasoningEffort,
      reportVersion: source.reportVersion || 1,
      compact: isCompactReport(source),
    },
    traceFile: null,
  });
  await writeReport(report, { reportPath, cli, revealHoldout: options.revealHoldout, holdoutSummary: options.holdoutSummary });
  return finish(computeExitCode(report, options), options, cli);
}

/**
 * The run's resolved model configuration: parseEvalArgs's, or (options built
 * another way) resolved from the options' model and effort and the env.
 */
function runModelConfig(options, env = process.env) {
  if (options.modelConfig) {
    return options.modelConfig;
  }
  try {
    return resolveModelConfig({ env, flags: { model: options.model, reasoningEffort: options.reasoningEffort } });
  } catch (error) {
    throw new HarnessError(error.message, { code: error.code || 'INVALID_CONFIG', cause: error });
  }
}

/** Runs the evaluation for parsed options; returns the exit code. */
export async function runEval(options, { cli = createCliOutput({ traceToStdout: options.traceToStdout }), env = process.env } = {}) {
  const fixtures = resolveFixtures(options.fixtureNames);
  if (fixtures[0]?.name !== PRIMARY_FIXTURE.name) {
    throw usageError(`--fixtures must include the primary fixture "${PRIMARY_FIXTURE.name}" (the product loop runs there).`);
  }
  const rescoreMode = Boolean(options.rescore || options.offline);
  const modelConfig = runModelConfig(options, env);
  // The model and the effort with where each came from, and the endpoint:
  // a MODEL_NAME pinned by an env file is never used silently. A rescore
  // runs the recording's model settings (it says so when they differ): the
  // configured ones only pick the default baseline.
  cli.log(
    `txt2sql eval (${options.profile} profile${rescoreMode ? ', no LLM calls' : ''}): ${rescoreMode ? 'configured ' : ''}${describeModelConfig(modelConfig)}; ` +
      `fixtures ${fixtures.map((fixture) => fixture.name).join(', ')}`
  );
  for (const line of describeModelNotices(modelConfig)) {
    cli.log(line);
  }
  // Configuration problems fail before anything is started, seeded or spent.
  await checkGateBaseline(options, cli);
  let schemaScope;
  let hintsVersion;
  try {
    // The product settings (SCHEMA_SCOPE, SCHEMA_FULL_MAX_TOKENS,
    // SCHEMA_WIDEN_ON_DEMAND, HINTS_VERSION), read like the web server and
    // the CLI read them; a live run, a rescore and the verification all use
    // them.
    schemaScope = resolveSchemaScopeConfig(env);
    hintsVersion = resolveHintsVersion(env);
  } catch (error) {
    throw new HarnessError(error.message, { code: error.code || 'INVALID_CONFIG', cause: error });
  }
  const client = rescoreMode ? null : createLiveClient(options);

  const schema = await loadNarrowSchema({ modelsDir: MODELS_DIR, schemaPath: SCHEMA_PATH, refreshSchema: options.refreshSchema });
  cli.log(`Schema scope: ${describeSchemaScope(resolveEffectiveSchemaScope(schema, schemaScope))}`);
  cli.log(`Hints version: ${describeHintsVersion(hintsVersion)}`);

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
  // A rescore applies the filters to the recorded cases (runRescore checks there).
  const thresholdRefusal = rescoreMode ? null : minAccuracyRefusal(options, selection.entries.map((entry) => entry.testCase));
  if (thresholdRefusal) {
    throw new HarnessError(thresholdRefusal, { code: 'NO_ANSWER_CASES' });
  }
  if (writesDefaultBaseline(options)) {
    // Checked before any verification or spend: the default baseline is
    // replaced only by a run of the whole default suite.
    const defaultSelection = await selectSuite({ datasetsDir: DEFAULT_DATASETS_DIR });
    const refusal = baselineSuiteRefusal(selection, defaultSelection);
    if (refusal) {
      throw new HarnessError(
        `--write-baseline refused before the run: ${refusal}. ${repoRelative(baselineTarget(options))} would no longer cover the default suite; ` +
          'run without --dataset/--dataset-file/--datasets-dir, or pass --baseline-file <path> to save this subset elsewhere.',
        { code: 'BASELINE_SUBSET' }
      );
    }
  }

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
          // CONTROLS_NOT_FOUND (a missing or empty directory) or
          // CONTROLS_INVALID: never an empty index that skips the gate.
          throw new HarnessError(`Cannot load the oracle controls: ${error.message}`, { code: error.code === 'CONTROLS_NOT_FOUND' ? error.code : 'CONTROLS_INVALID', cause: error });
        }
        cli.log(`  warning: oracle controls not loaded (${error.message}).`);
      }
      // Controls that load but apply to none of these datasets would skip
      // every kill-rate gate, as in verify-dataset.
      const coverageFailure = options.verify
        ? controlsCoverageFailure(
            selection.datasets.map((dataset) => ({ datasetName: dataset.name, cases: dataset.cases })),
            controlsIndex,
            { controlsDir: repoRelative(options.controlsDir) }
          )
        : null;
      if (coverageFailure) {
        throw new HarnessError(coverageFailure, { code: 'CONTROLS_NOT_FOUND' });
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
          validate: createValidatorProbe({ schema, connection: primary.connection, statementTimeoutMs: resolveStatementTimeoutMs(), schemaScope, hintsVersion }),
          controlsIndex,
          checkControls: options.checkControls,
          minKillRate: options.minKillRate,
          minHeldoutKillRate: options.minHeldoutKillRate,
          // A stale flag means the product now accepts a gold it used to
          // reject: worth a warning, never a reason not to measure it.
          staleKnownRejection: 'warning',
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
      const refusal = verificationRefusal(result);
      if (refusal) {
        throw new HarnessError(refusal, { code: 'VERIFY_FAILED' });
      }
    } else {
      cli.log('Verify: skipped.');
    }

    const context = { options, cli, schema, schemaScope, hintsVersion, modelConfig, selection, connections, fixtureStatus, controlsIndex, verification, client };
    return rescoreMode ? await runRescore(context) : await runLive(context);
  } finally {
    await closeFixtureConnections(connections);
  }
}

const MODEL_ENV_VARS = ['MODEL_NAME', 'REASONING_EFFORT'];

export async function main(argv = process.argv.slice(2), { profile = 'eval' } = {}) {
  if (hasOptionFlag(argv, '--help')) {
    console.log(USAGE);
    return 0;
  }
  let cli = createCliOutput({ traceToStdout: hasOptionFlag(argv, '--trace') });
  try {
    // Which model settings the env file (not the shell) supplied, so the
    // header can say so (the file never overrides a variable already set).
    const before = Object.fromEntries(MODEL_ENV_VARS.map((name) => [name, process.env[name]]));
    const envInfo = await loadEnvironment(argv);
    const fromFile = envInfo.loaded ? MODEL_ENV_VARS.filter((name) => before[name] === undefined && process.env[name] !== undefined) : [];
    const options = parseEvalArgs(argv, { profile, env: process.env, envFile: fromFile.length > 0 ? { path: envInfo.path, vars: fromFile } : null });
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
  // Exit 2 until main() settles: a run that never settles never passes.
  runScriptMain(() => main(), { label: 'eval' });
}
