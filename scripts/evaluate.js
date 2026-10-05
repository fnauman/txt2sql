import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import {
  classifyBenchmarkStatus,
  collectBenchmarkWarnings,
  createBenchmarkRunPaths,
  DEFAULT_DATASET_NAME,
  DEFAULT_DATASETS_DIR,
  DEFAULT_RUNS_DIR,
  listGoldVariants,
  loadBenchmarkDataset,
  summarizeBenchmarkResults,
} from '../src/benchmark.js';
import { createCaseTraceLogger, extractAttempts } from '../src/eval/case-trace.js';
import { checkFixtureContent } from '../src/eval/fixture-seeder.js';
import { FIXTURES, PRIMARY_FIXTURE, resolveFixtures } from '../src/eval/fixtures.js';
import {
  closeFixtureConnections,
  createGoldCache,
  executeGoldSql,
  GOLD_STATEMENT_TIMEOUT_MS,
  openFixtureConnections,
  scoreAgainstGold,
} from '../src/eval/oracle.js';
import { resolveGitSha } from '../src/git.js';
import {
  createOpenAiClient,
  describeMariaDbConnectionTarget,
  describeSchema,
  loadNarrowSchema,
  resolveStatementTimeoutMs,
  writeJsonFile,
} from '../src/pipeline.js';
import { resolveMaxRetries, runOptimizedQuestion } from '../src/query-service.js';
import { createCliOutput, createTimer, createTraceLogger, resolveTraceOptions, serializeError } from '../src/trace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

// The product loop fetches at most this many rows (plus one, to detect
// truncation); the oracle re-runs the final SQL on every fixture anyway.
export const EVAL_ROW_LIMIT = 1000;

// runOptimizedQuestion's errorStage -> benchmark status.
const STAGE_STATUS = {
  llm: 'llm_error',
  validation: 'validation_error',
  execution: 'execution_error',
  infra: 'infra_error',
  aborted: 'aborted',
};

export function applyEvaluationFailureExitCode(failed, processLike = process) {
  if (failed > 0) {
    processLike.exitCode = 1;
  }
}

function sumDurations(attempts, step) {
  return Number(attempts.reduce((total, attempt) => total + (attempt[step]?.durationMs || 0), 0).toFixed(3));
}

/**
 * Benchmarks one case through the PRODUCT loop: runOptimizedQuestion does
 * master-data resolution, prompt building, generation, validation, execution
 * and retries exactly as the web app and the optimized CLI do (same prompt,
 * same retry message, same retry budget, same statement timeout). The
 * benchmark only adds the oracle: the final SQL is scored against the gold on
 * every fixture (src/eval/oracle.js).
 *
 * - `connections`: fixture connections from openFixtureConnections(); the
 *   first one (the primary fixture) is where the product loop runs, so its
 *   master data is what the model sees. A lone `connection` is treated as a
 *   single-fixture run.
 * - Per-attempt data (generated SQL, validation code/layer, execution outcome,
 *   usage/cost, timings) is rebuilt from a buffered trace that also forwards
 *   every event, tagged with the case, to `trace`.
 * - Gold runs first (with its own timeout), so a broken gold costs no LLM call
 *   and is reported as 'expected_sql_error', never as a model failure.
 * - `dependencies.runQuestion` / `dependencies.scorePrediction` replace the
 *   product loop / oracle in tests.
 */
export async function evaluateQuestion({
  client,
  connection = null,
  connections = null,
  schema,
  model,
  testCase,
  caseIndex,
  datasetName = null,
  trace,
  goldCache = createGoldCache(),
  maxRetries = undefined,
  statementTimeoutMs = null,
  goldTimeoutMs = GOLD_STATEMENT_TIMEOUT_MS,
  dependencies = {},
}) {
  const { runQuestion = runOptimizedQuestion, scorePrediction = scoreAgainstGold } = dependencies;
  const fixtureConnections =
    Array.isArray(connections) && connections.length > 0
      ? connections
      : [{ name: PRIMARY_FIXTURE.name, database: null, connection }];
  const primaryConnection = connection || fixtureConnections[0].connection;
  const caseContext = {
    caseIndex,
    datasetName,
    caseId: testCase.id,
    intentId: testCase.intentId || null,
    question: testCase.question,
  };
  const caseTimer = createTimer();

  await trace.emit('case.started', { ...caseContext, fixtures: fixtureConnections.map((entry) => entry.name) });

  // Gold first: every variant on every fixture (cached for the oracle).
  const goldTimer = createTimer();
  try {
    for (const variant of listGoldVariants(testCase)) {
      for (const fixtureConnection of fixtureConnections) {
        const rows = await executeGoldSql(fixtureConnection, variant.sql, { goldCache, timeoutMs: goldTimeoutMs, label: variant.label });
        await trace.emit('expected_sql.executed', {
          ...caseContext,
          fixture: fixtureConnection.name,
          gold: variant.label,
          sql: variant.sql,
          rowCount: rows.length,
        });
      }
    }
  } catch (error) {
    await trace.emit('expected_sql.failed', {
      ...caseContext,
      ...goldTimer.stop(),
      fixture: error.fixture ?? null,
      gold: error.label ?? null,
      error: serializeError(error.cause || error),
    });
    const result = {
      status: 'expected_sql_error',
      warnings: [],
      error: error.message,
      error_stage: 'gold',
      error_code: error.cause?.code || error.code || null,
      attempts: [],
      attempt_count: 0,
      llm_usage: null,
      llm_cost: null,
    };
    await trace.emit('case.completed', {
      ...caseContext,
      success: false,
      status: result.status,
      error: serializeError(error.cause || error),
      attempts: 0,
    });
    return result;
  }

  const caseTrace = createCaseTraceLogger({ forwardTo: trace, context: caseContext });
  const run = await runQuestion({
    client,
    connection: primaryConnection,
    schema,
    model,
    question: testCase.question,
    questionIndex: caseIndex,
    trace: caseTrace,
    maxRetries,
    rowLimit: EVAL_ROW_LIMIT,
    includeInsights: false,
    statementTimeoutMs,
  });
  const attempts = extractAttempts(caseTrace.events);
  const promptEvent = caseTrace.events.find((entry) => entry.event === 'prompt.built');
  const retrievedTables = Array.isArray(run.promptTables) ? run.promptTables : [];
  if (promptEvent?.context?.retrieval) {
    await trace.emit('retrieval.completed', { ...caseContext, retrieval: promptEvent.context.retrieval });
  }

  let status;
  let score = null;
  const oracleTimer = createTimer();
  if (run.success) {
    score = await scorePrediction({
      testCase,
      predictedSql: run.sql,
      connections: fixtureConnections,
      goldCache,
      timeoutMs: statementTimeoutMs,
      goldTimeoutMs,
      schema,
    });
    status = score.match
      ? 'pass'
      : score.infraError
        ? 'infra_error'
        : classifyBenchmarkStatus({ rowsMatch: false, expectedTables: testCase.expected_tables, retrievedTables });

    await trace.emit('result.compared', {
      ...caseContext,
      ...oracleTimer.stop(),
      matched: score.match,
      matchedGold: score.matchedGold,
      reason: score.reason,
      perFixture: score.perFixture,
      assignment: score.assignment,
      expectedTables: testCase.expected_tables,
      retrievedTables,
    });
    await trace.emit('result.signal_checked', {
      ...caseContext,
      signalChecks: testCase.signal_checks || null,
      signalWarnings: score.signalWarnings,
      disallowedColumnsUsed: score.disallowedWarnings,
    });
  } else {
    status = STAGE_STATUS[run.errorStage] || 'execution_error';
  }

  const signalWarnings = score?.signalWarnings || [];
  const disallowedWarnings = score?.disallowedWarnings || [];
  const warnings = collectBenchmarkWarnings({ rowsMatch: status === 'pass', signalWarnings, disallowedColumnsUsed: disallowedWarnings });
  const timings = {
    totalMs: caseTimer.stop().durationMs,
    llmMs: sumDurations(attempts, 'llm'),
    validationMs: sumDurations(attempts, 'validation'),
    executionMs: sumDurations(attempts, 'execution'),
  };
  const response = run.response || null;

  const result = {
    status,
    warnings,
    generated_sql: run.sql || '',
    explanation: response?.explanation || '',
    assumptions: response?.assumptions || [],
    tables_used: response?.tables_used || [],
    retrieved_tables: retrievedTables,
    master_data_candidates: run.masterDataCandidates || [],
    attempts,
    attempt_count: run.attemptCount ?? attempts.length,
    ...(run.success
      ? {}
      : {
          error: run.error?.message || 'Unknown error',
          error_stage: run.errorStage || null,
          error_code: run.errorCode || null,
        }),
    oracle: score
      ? {
          matched_gold: score.matchedGold,
          reason: score.reason,
          per_fixture: score.perFixture,
          killed_on: score.killedOn,
          assignment: score.assignment,
        }
      : null,
    signal_warnings: signalWarnings,
    disallowed_column_warnings: disallowedWarnings,
    expected_rows_preview: score?.preview?.gold || [],
    actual_rows_preview: score?.preview?.actual || [],
    llm_usage: run.llmUsage || null,
    llm_cost: run.llmCost || null,
    timings,
  };

  await trace.emit('case.completed', {
    ...caseContext,
    success: status === 'pass',
    status,
    warnings,
    generatedSql: result.generated_sql || null,
    attempts: result.attempt_count,
    perFixture: score?.perFixture || null,
    llmUsage: result.llm_usage,
    llmCost: result.llm_cost,
    ...(run.success ? {} : { errorStage: result.error_stage, error: serializeError(run.error) }),
  });

  return result;
}

function buildResultRecord(testCase, extra) {
  return {
    id: testCase.id,
    intentId: testCase.intentId,
    question: testCase.question,
    canonicalQuestion: testCase.canonicalQuestion,
    expected_sql: testCase.expected_sql,
    alternative_expected_sql: testCase.alternative_expected_sql,
    expected_tables: testCase.expected_tables,
    expected_columns: testCase.expected_columns,
    disallowed_columns: testCase.disallowed_columns,
    signal_checks: testCase.signal_checks,
    difficulty: testCase.difficulty,
    tags: testCase.tags,
    failure_class: testCase.failure_class,
    ...extra,
  };
}

async function runDatasetOnce({ cli, datasetInfo, repetition, repeat, ...shared }) {
  const results = [];

  for (const [index, testCase] of datasetInfo.cases.entries()) {
    if (repeat > 1) {
      cli.write(`(rep ${repetition}/${repeat}) `);
    }
    cli.write(`#${testCase.id} ${testCase.question} `);

    try {
      const result = await evaluateQuestion({
        ...shared,
        testCase,
        caseIndex: index + 1,
        datasetName: datasetInfo.datasetName,
      });

      results.push(buildResultRecord(testCase, result));
      const warningNote = result.warnings?.length ? ` (warnings: ${result.warnings.join(', ')})` : '';
      cli.write(result.status === 'pass' ? `✅${warningNote}\n` : `❌ ${result.status}${warningNote}\n`);
    } catch (error) {
      results.push(buildResultRecord(testCase, { status: 'evaluation_error', error: error.message }));
      cli.write('❌ evaluation_error\n');
    }
  }

  return results;
}

// Lower bound of the Wilson score interval for a binomial proportion. Reported
// alongside raw pass-rate so a small, noisy sample is not mistaken for proof of
// reliability (e.g. 6/6 has a 95% lower bound near 0.6, not 1.0).
export function wilsonLowerBound(passes, attempts, z = 1.96) {
  if (attempts <= 0) {
    return 0;
  }

  const phat = passes / attempts;
  const z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const center = phat + z2 / (2 * attempts);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * attempts)) / attempts);
  return Number(Math.max(0, (center - margin) / denominator).toFixed(4));
}

export function summarizeReliability(perRepetition, repeat) {
  const accuracies = perRepetition.map((entry) => entry.accuracy);
  const perCase = new Map();

  for (const entry of perRepetition) {
    for (const caseResult of entry.results) {
      const current = perCase.get(caseResult.id) || {
        id: caseResult.id,
        intentId: caseResult.intentId,
        question: caseResult.question,
        attempts: 0,
        passes: 0,
        statuses: {},
      };
      current.attempts += 1;
      if (caseResult.status === 'pass') {
        current.passes += 1;
      }
      current.statuses[caseResult.status] = (current.statuses[caseResult.status] || 0) + 1;
      perCase.set(caseResult.id, current);
    }
  }

  const totalAttempts = perRepetition.reduce((sum, entry) => sum + entry.total, 0);
  const totalPasses = perRepetition.reduce((sum, entry) => sum + entry.passed, 0);
  const fullPassReps = perRepetition.filter((entry) => entry.total > 0 && entry.passed === entry.total).length;

  return {
    repeat,
    perRepetition: perRepetition.map((entry) => ({
      repetition: entry.repetition,
      total: entry.total,
      passed: entry.passed,
      failed: entry.failed,
      accuracy: entry.accuracy,
      statusCounts: entry.statusCounts,
    })),
    meanAccuracy: accuracies.length ? Number((accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length).toFixed(4)) : 0,
    minAccuracy: accuracies.length ? Math.min(...accuracies) : 0,
    maxAccuracy: accuracies.length ? Math.max(...accuracies) : 0,
    allCasesPassedRate: perRepetition.length ? Number((fullPassReps / perRepetition.length).toFixed(4)) : 0,
    totalAttempts,
    totalPasses,
    passRate: totalAttempts ? Number((totalPasses / totalAttempts).toFixed(4)) : 0,
    wilsonLower95: wilsonLowerBound(totalPasses, totalAttempts),
    perCase: [...perCase.values()].map((entry) => ({
      ...entry,
      passRate: entry.attempts ? Number((entry.passes / entry.attempts).toFixed(4)) : 0,
    })),
  };
}


// Deep fixture check (checkFixtureContent re-hashes every row): status
// 'current' | 'drifted' | 'stale' | 'missing' (or 'unknown' when the check
// itself failed) and whether the master data is the shared MASTER_DATA.
export async function describeFixtureStatus(fixtureConnections, { check = checkFixtureContent } = {}) {
  const statuses = [];
  for (const fixtureConnection of fixtureConnections) {
    try {
      const result = await check(fixtureConnection.connection, fixtureConnection);
      statuses.push({
        name: fixtureConnection.name,
        database: fixtureConnection.database,
        status: result.status,
        contentHash: result.contentHash,
        metaContentHash: result.meta?.contentHash || null,
        expectedContentHash: result.expected.contentHash,
        masterDataMatches: result.masterDataMatches,
      });
    } catch (error) {
      statuses.push({ name: fixtureConnection.name, database: fixtureConnection.database, status: 'unknown', masterDataMatches: null, error: error.message });
    }
  }
  return statuses;
}

/**
 * The benchmark refuses to run when a fixture's master data is not the shared
 * MASTER_DATA: the model's prompt context comes from the primary fixture's
 * master data, so a fixture with other dimension rows would score a different
 * question than the one the model was asked. Drifted facts only warn.
 */
export function assertSharedMasterData(fixtureStatus) {
  const differing = fixtureStatus.filter((entry) => entry.masterDataMatches === false);
  if (differing.length > 0) {
    throw new Error(
      `Fixture master data differs from the shared master data on ${differing.map((entry) => `${entry.name} (${entry.database})`).join(', ')}. ` +
        'Every fixture must carry identical dimension rows; run "npm run seed-fixtures" (admin credentials) to rebuild them.'
    );
  }
}

export async function main() {
  const argv = process.argv.slice(2);
  const envInfo = await loadEnvironment(argv);
  const refreshSchema = hasOptionFlag(argv, '--refresh-schema');
  const traceOptions = resolveTraceOptions(argv);
  const datasetPathOption = getOptionValue(argv, '--dataset-file') || getOptionValue(argv, '--dev-set');
  const datasetName = getOptionValue(argv, '--dataset') || (datasetPathOption ? null : DEFAULT_DATASET_NAME);
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const caseId = getOptionValue(argv, '--case-id');
  const tag = getOptionValue(argv, '--tag');
  const repeat = Math.max(1, Math.trunc(Number(getOptionValue(argv, '--repeat')) || 1));
  const model = process.env.MODEL_NAME || 'gpt-4o-mini';
  // One retry budget and one statement timeout for every entry point: the
  // benchmark reads the same settings as the web app and the optimized CLI
  // (WEB_QUERY_MAX_RETRIES, default 1 retry = 2 attempts;
  // QUERY_STATEMENT_TIMEOUT_MS, default 8000). Validated up front.
  const maxRetries = resolveMaxRetries();
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const fixtures = resolveFixtures(getOptionValue(argv, '--fixtures'));
  if (fixtures[0]?.name !== PRIMARY_FIXTURE.name) {
    throw new Error(
      `--fixtures must include the primary fixture "${PRIMARY_FIXTURE.name}": the product loop runs there, so the model's master-data context comes from it.`
    );
  }

  const datasetTimer = createTimer();
  let datasetInfo;
  try {
    datasetInfo = await loadBenchmarkDataset({
      datasetName,
      datasetPath: datasetPathOption,
      datasetsDir,
      caseId,
      tag,
    });
  } catch (error) {
    throw new Error(`Failed to load benchmark dataset: ${error.message}`);
  }

  const outputDir = path.resolve(getOptionValue(argv, '--output-dir') || DEFAULT_RUNS_DIR);
  const traceDir = path.resolve(getOptionValue(argv, '--trace-dir') || outputDir);
  const runPaths = createBenchmarkRunPaths({
    datasetName: datasetInfo.datasetName,
    model,
    outputDir,
    traceDir,
  });
  const resultsPath = path.resolve(getOptionValue(argv, '--results-file') || runPaths.reportPath);
  const traceFilePath = path.resolve(getOptionValue(argv, '--trace-file') || runPaths.tracePath);
  const gitSha = await resolveGitSha(path.resolve(__dirname, '..'));
  const trace = await createTraceLogger({
    enabled: true,
    logToStdout: traceOptions.logToStdout,
    filePath: traceFilePath,
    pipeline: 'evaluate',
    metadata: {
      script: 'scripts/evaluate.js',
      datasetName: datasetInfo.datasetName,
      promptVersion: null,
      semanticLayerVersion: null,
      dbProfileVersion: null,
      gitSha,
    },
  });
  const cli = createCliOutput({
    traceToStdout: traceOptions.logToStdout,
  });

  await trace.emit('run.started', {
    argv,
    environment: envInfo,
    model,
    refreshSchema,
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    datasetPath: datasetInfo.datasetPath,
    datasetCaseCount: datasetInfo.cases.length,
    totalDatasetCases: datasetInfo.totalCases,
    filters: datasetInfo.filters,
    resultsPath,
    outputDir,
    traceDir,
    runTimestamp: runPaths.timestamp,
    openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
    traceToStdout: traceOptions.logToStdout,
    traceFile: trace.filePath,
    maxRetries,
    statementTimeoutMs,
    goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS,
    fixtures: fixtures.map(({ name, database }) => ({ name, database })),
  });

  await trace.emit('benchmark_dataset.loaded', {
    ...datasetTimer.stop(),
    datasetPath: datasetInfo.datasetPath,
    datasetCaseCount: datasetInfo.cases.length,
    totalDatasetCases: datasetInfo.totalCases,
    filters: datasetInfo.filters,
  });

  let schema;
  const schemaTimer = createTimer();
  try {
    schema = await loadNarrowSchema({
      modelsDir: MODELS_DIR,
      schemaPath: SCHEMA_PATH,
      refreshSchema,
    });
  } catch (error) {
    await trace.emit('schema.load_failed', {
      ...schemaTimer.stop(),
      schemaPath: SCHEMA_PATH,
      error: serializeError(error),
    });
    throw error;
  }

  await trace.emit('schema.loaded', {
    ...schemaTimer.stop(),
    schemaPath: SCHEMA_PATH,
    schema: describeSchema(schema),
  });

  let client;
  try {
    client = createOpenAiClient();
  } catch (error) {
    await trace.emit('openai.client_failed', {
      model,
      openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
      error: serializeError(error),
    });
    throw error;
  }

  await trace.emit('openai.client_ready', {
    model,
    openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
  });

  const connectionTimer = createTimer();
  let fixtureConnections;
  try {
    fixtureConnections = await openFixtureConnections({ fixtures });
  } catch (error) {
    await trace.emit('database.connection_failed', {
      ...connectionTimer.stop(),
      target: describeMariaDbConnectionTarget({ includeDatabase: false }),
      fixtures: fixtures.map(({ name, database }) => ({ name, database })),
      error: serializeError(error),
    });
    throw error;
  }

  const fixtureStatus = await describeFixtureStatus(fixtureConnections);
  await trace.emit('database.connected', {
    ...connectionTimer.stop(),
    target: describeMariaDbConnectionTarget({ includeDatabase: false }),
    fixtures: fixtureStatus,
  });
  try {
    assertSharedMasterData(fixtureStatus);
  } catch (error) {
    await trace.emit('fixtures.master_data_mismatch', { fixtures: fixtureStatus, error: serializeError(error) });
    await closeFixtureConnections(fixtureConnections);
    throw error;
  }

  const perRepetition = [];

  cli.log(`Model: ${model}`);
  cli.log(`Schema file: ${SCHEMA_PATH}`);
  cli.log(`Dataset: ${datasetInfo.datasetName}`);
  cli.log(`Dataset file: ${datasetInfo.datasetPath}`);
  cli.log(`Environment: ${envInfo.path || 'not found'}`);
  cli.log(`Cases: ${datasetInfo.cases.length}/${datasetInfo.totalCases}`);
  cli.log(`Retry budget: ${maxRetries} (WEB_QUERY_MAX_RETRIES); statement timeout: ${statementTimeoutMs} ms; gold timeout: ${GOLD_STATEMENT_TIMEOUT_MS} ms`);
  cli.log(`Fixtures: ${fixtureStatus.map((entry) => `${entry.name}=${entry.database} (${entry.status})`).join(', ')}`);
  for (const entry of fixtureStatus.filter((status) => status.status !== 'current')) {
    cli.log(`  warning: fixture ${entry.name} is ${entry.status}; run "npm run seed-fixtures" so its content matches the pins.`);
  }
  if (process.env.DB_NAME && !FIXTURES.some((fixture) => fixture.database === process.env.DB_NAME)) {
    cli.log(
      `  note: DB_NAME is ${process.env.DB_NAME}; the benchmark runs the product loop on ${PRIMARY_FIXTURE.database} ` +
        `and scores on ${fixtureStatus.map((entry) => entry.database).join(', ')}, not on DB_NAME.`
    );
  }
  if (repeat > 1) {
    cli.log(`Repetitions: ${repeat} (reliability mode)`);
  }
  if (datasetInfo.filters.caseId || datasetInfo.filters.tag) {
    cli.log(
      `Filters: ${[
        datasetInfo.filters.caseId ? `case-id=${datasetInfo.filters.caseId}` : null,
        datasetInfo.filters.tag ? `tag=${datasetInfo.filters.tag}` : null,
      ]
        .filter(Boolean)
        .join(', ')}`
    );
  }
  cli.log(`Report file: ${resultsPath}`);
  cli.log(`Trace file: ${trace.filePath}\n`);

  const goldCache = createGoldCache();
  try {
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      const repetitionResults = await runDatasetOnce({
        client,
        connections: fixtureConnections,
        schema,
        model,
        trace,
        goldCache,
        maxRetries,
        statementTimeoutMs,
        cli,
        datasetInfo,
        repetition,
        repeat,
      });
      const repetitionSummary = summarizeBenchmarkResults(repetitionResults);
      perRepetition.push({
        repetition,
        results: repetitionResults,
        total: repetitionSummary.total,
        passed: repetitionSummary.passed,
        failed: repetitionSummary.failed,
        statusCounts: repetitionSummary.statusCounts,
        accuracy: repetitionSummary.total === 0 ? 0 : Number((repetitionSummary.passed / repetitionSummary.total).toFixed(4)),
      });
    }
  } finally {
    const closeTimer = createTimer();
    await closeFixtureConnections(fixtureConnections);
    await trace.emit('database.closed', {
      ...closeTimer.stop(),
    });
  }

  // The representative per-case detail comes from the first repetition so the
  // report's `results` shape is unchanged; `reliability` carries the full
  // multi-run picture so a single lucky run is never reported as "accuracy 1.0".
  const results = perRepetition[0]?.results || [];
  const summary = summarizeBenchmarkResults(results);
  const reliability = summarizeReliability(perRepetition, repeat);
  const warningCounts = results.reduce((counts, result) => {
    for (const warning of result.warnings || []) {
      counts[warning] = (counts[warning] || 0) + 1;
    }
    return counts;
  }, {});
  await writeJsonFile(resultsPath, {
    generatedAt: new Date().toISOString(),
    runTimestamp: runPaths.timestamp,
    model,
    gitSha,
    schemaPath: SCHEMA_PATH,
    dataset: {
      name: datasetInfo.datasetName,
      path: datasetInfo.datasetPath,
      selectedCaseCount: datasetInfo.cases.length,
      totalCaseCount: datasetInfo.totalCases,
      filters: datasetInfo.filters,
    },
    oracle: {
      fixtures: fixtureStatus,
      maxRetries,
      statementTimeoutMs,
      goldTimeoutMs: GOLD_STATEMENT_TIMEOUT_MS,
    },
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    accuracy: summary.total === 0 ? 0 : Number((summary.passed / summary.total).toFixed(4)),
    // Tells machine consumers what the top-level total/passed/failed/accuracy
    // describe: a single run, or just the first of several repetitions. When
    // repeat > 1 the aggregate across all runs lives in `reliability.passRate`.
    accuracyScope: repeat > 1 ? 'first-repetition' : 'single-run',
    aggregateAccuracy: repeat > 1 ? reliability.passRate : null,
    statusCounts: summary.statusCounts,
    warningCounts,
    reliability,
    traceFile: trace.filePath,
    results,
  });

  cli.log('\nSummary');
  cli.log(`Passed: ${summary.passed}/${summary.total} (first repetition; a pass must match the gold on ${fixtureStatus.length} fixture(s))`);
  cli.log(`Failed: ${summary.failed}`);
  cli.log(`Status counts: ${JSON.stringify(summary.statusCounts)}`);
  if (Object.keys(warningCounts).length > 0) {
    cli.log(`Warnings (not failures): ${JSON.stringify(warningCounts)}`);
  }
  if (repeat > 1) {
    cli.log(
      `Reliability over ${repeat} runs: pass-rate ${reliability.passRate} ` +
        `(mean acc ${reliability.meanAccuracy}, range ${reliability.minAccuracy}-${reliability.maxAccuracy}, ` +
        `Wilson 95% lower ${reliability.wilsonLower95}, all-pass runs ${reliability.allCasesPassedRate})`
    );
  }

  await trace.emit('run.completed', {
    success: summary.failed === 0,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    statusCounts: summary.statusCounts,
    warningCounts,
    reliability,
    resultsPath,
  });

  // Single-run mode keeps the original pass/fail exit semantics. Reliability
  // mode (repeat > 1) is a measurement, not a gate, so it does not fail the
  // process on expected run-to-run variance.
  applyEvaluationFailureExitCode(repeat > 1 ? 0 : summary.failed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`Evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
