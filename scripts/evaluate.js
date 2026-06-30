import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import {
  classifyBenchmarkStatus,
  compareResults,
  createBenchmarkRunPaths,
  DEFAULT_DATASET_NAME,
  DEFAULT_DATASETS_DIR,
  DEFAULT_RUNS_DIR,
  findDisallowedColumnsUsed,
  loadBenchmarkDataset,
  runSignalChecks,
  summarizeBenchmarkResults,
} from '../src/benchmark.js';
import { resolveGitSha } from '../src/git.js';
import {
  buildOptimizedPrompt,
  buildSemanticPlan,
  createMariaDbConnection,
  createOpenAiClient,
  describeMariaDbConnectionTarget,
  describeSchema,
  executeReadOnlySql,
  generateOptimizedResponse,
  loadNarrowSchema,
  validateReadOnlySql,
  writeJsonFile,
} from '../src/pipeline.js';
import { resolveMasterDataCandidates } from '../src/master-data-resolver.js';
import { mergeCosts, mergeUsage } from '../src/pricing.js';
import { createCliOutput, createTimer, createTraceLogger, resolveTraceOptions, serializeError } from '../src/trace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

export function applyEvaluationFailureExitCode(failed, processLike = process) {
  if (failed > 0) {
    processLike.exitCode = 1;
  }
}

export async function evaluateQuestion({
  client,
  connection,
  schema,
  model,
  testCase,
  caseIndex,
  datasetName = null,
  trace,
  dependencies = {},
}) {
  const {
    buildPrompt = buildOptimizedPrompt,
    classifyStatus = classifyBenchmarkStatus,
    executeSql = executeReadOnlySql,
    evaluateSignals = runSignalChecks,
    findUsedDisallowedColumns = findDisallowedColumnsUsed,
    generateResponse = generateOptimizedResponse,
    resolveMasterData = resolveMasterDataCandidates,
    validateSql = validateReadOnlySql,
    rowsMatch = compareResults,
  } = dependencies;
  const caseContext = {
    caseIndex,
    datasetName,
    caseId: testCase.id,
    intentId: testCase.intentId || null,
    question: testCase.question,
    signalChecks: testCase.signal_checks || null,
  };

  await trace.emit('case.started', caseContext);
  const semanticPlan = buildSemanticPlan(testCase.question);
  const masterDataTimer = createTimer();
  let masterDataCandidates = [];
  try {
    masterDataCandidates = await resolveMasterData({
      connection,
      semanticPlan,
    });
    await trace.emit('master_data.resolved', {
      ...caseContext,
      ...masterDataTimer.stop(),
      totalCandidateCount: masterDataCandidates.reduce(
        (count, group) => count + (group.totalCandidateCount || 0),
        0
      ),
      candidates: masterDataCandidates,
    });
  } catch (error) {
    await trace.emit('master_data.failed', {
      ...caseContext,
      ...masterDataTimer.stop(),
      error: serializeError(error),
    });
  }

  const promptTimer = createTimer();
  const prompt = buildPrompt(schema, testCase.question, { masterDataCandidates, semanticPlan });
  await trace.emit('prompt.built', {
    ...caseContext,
    ...promptTimer.stop(),
    prompt: {
      system: prompt.system,
      user: prompt.user,
    },
    context: prompt.context,
  });

  if (prompt.context?.retrieval) {
    await trace.emit('retrieval.completed', {
      ...caseContext,
      retrieval: prompt.context.retrieval,
    });
  }

  const retrievedTables = (prompt.tables || schema.tables).map((table) => table.tableName);
  const allowedTables = retrievedTables;

  let expectedRows;
  const expectedTimer = createTimer();
  try {
    expectedRows = await executeSql(connection, testCase.expected_sql);
  } catch (error) {
    await trace.emit('expected_sql.failed', {
      ...caseContext,
      ...expectedTimer.stop(),
      sql: testCase.expected_sql,
      error: serializeError(error),
    });
    await trace.emit('case.completed', {
      ...caseContext,
      success: false,
      status: 'expected_sql_error',
      error: serializeError(error),
      attempts: 0,
    });
    throw error;
  }

  await trace.emit('expected_sql.executed', {
    ...caseContext,
    ...expectedTimer.stop(),
    sql: testCase.expected_sql,
    rowCount: Array.isArray(expectedRows) ? expectedRows.length : null,
  });

  let generated = null;
  let executionError = null;
  let finalFailureStatus = 'execution_error';
  let actualRows = [];
  const llmUsages = [];
  const llmCosts = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryContext =
      attempt === 0
        ? null
        : {
            sql: generated?.sql || '',
            error: executionError?.message || String(executionError || 'Unknown error'),
            tablesUsed: generated?.tables_used || [],
            assumptions: generated?.assumptions || [],
          };
    const attemptContext = {
      ...caseContext,
      attempt: attempt + 1,
      retry: attempt > 0,
    };
    const llmTimer = createTimer();

    try {
      generated = await generateResponse({
        client,
        model,
        prompt,
        retryContext,
      });
    } catch (error) {
      executionError = error;
      finalFailureStatus = 'llm_error';

      await trace.emit('llm.failed', {
        ...attemptContext,
        ...llmTimer.stop(),
        retryContext,
        error: serializeError(error),
      });

      continue;
    }

    if (generated.usage) {
      llmUsages.push(generated.usage);
    }
    if (generated.cost) {
      llmCosts.push(generated.cost);
    }

    await trace.emit('llm.completed', {
      ...attemptContext,
      ...llmTimer.stop(),
      retryContext,
      request: generated.request,
      response: {
        id: generated.responseId,
        model: generated.responseModel,
        finishReason: generated.finishReason,
        usage: generated.usage,
        cost: generated.cost,
        rawText: generated.rawText,
        cleanedSql: generated.sql,
        explanation: generated.explanation,
        tablesUsed: generated.tables_used,
        assumptions: generated.assumptions,
      },
    });

    const validationTimer = createTimer();
    let validated;
    try {
      validated = validateSql(generated.sql, allowedTables, {
        promptContext: prompt.context,
        response: generated,
      });
    } catch (error) {
      executionError = error;
      finalFailureStatus = 'validation_error';

      await trace.emit('sql.validation_failed', {
        ...attemptContext,
        ...validationTimer.stop(),
        candidateSql: generated.sql,
        allowedTables,
        error: serializeError(error),
      });

      continue;
    }

    await trace.emit('sql.validated', {
      ...attemptContext,
      ...validationTimer.stop(),
      validation: {
        success: true,
        sql: validated.sql,
        firstKeyword: validated.firstKeyword,
        statementCount: validated.statementCount,
        tablesUsed: validated.tablesUsed,
        guardrails: validated.guardrails,
      },
    });

    const executionTimer = createTimer();
    try {
      actualRows = await executeSql(connection, validated.sql);
    } catch (error) {
      executionError = error;
      finalFailureStatus = 'execution_error';

      await trace.emit('sql.execution_failed', {
        ...attemptContext,
        ...executionTimer.stop(),
        sql: validated.sql,
        error: serializeError(error),
      });

      continue;
    }

    await trace.emit('sql.executed', {
      ...attemptContext,
      ...executionTimer.stop(),
      sql: validated.sql,
      rowCount: Array.isArray(actualRows) ? actualRows.length : null,
    });

    const signalCheckResult = evaluateSignals(actualRows, testCase.signal_checks);
    const disallowedColumnsUsed = findUsedDisallowedColumns(validated.sql, testCase.disallowed_columns);
    const didRowsMatch = rowsMatch(expectedRows, actualRows, testCase.comparison);
    const status = classifyStatus({
      rowsMatch: didRowsMatch,
      signalCheckResult,
      expectedTables: testCase.expected_tables,
      retrievedTables,
      disallowedColumnsUsed,
    });

    await trace.emit('result.compared', {
      ...attemptContext,
      expectedRowCount: Array.isArray(expectedRows) ? expectedRows.length : null,
      actualRowCount: Array.isArray(actualRows) ? actualRows.length : null,
      matched: didRowsMatch,
      expectedTables: testCase.expected_tables,
      retrievedTables,
    });

    await trace.emit('result.signal_checked', {
      ...attemptContext,
      signalChecks: testCase.signal_checks || null,
      signalCheckResult,
      disallowedColumnsUsed,
    });

    await trace.emit('case.completed', {
      ...caseContext,
      success: status === 'pass',
      status,
      generatedSql: validated.sql,
      expectedRowCount: Array.isArray(expectedRows) ? expectedRows.length : null,
      actualRowCount: Array.isArray(actualRows) ? actualRows.length : null,
      attempts: attempt + 1,
      llmUsage: mergeUsage(llmUsages),
      llmCost: mergeCosts(llmCosts),
      signalCheckResult,
      disallowedColumnsUsed,
    });

    return {
      status,
      generated_sql: validated.sql,
      explanation: generated.explanation,
      assumptions: generated.assumptions,
      tables_used: generated.tables_used,
      retrieved_tables: retrievedTables,
      master_data_candidates: masterDataCandidates,
      signal_check_result: signalCheckResult,
      disallowed_columns_used: disallowedColumnsUsed,
      expected_rows_preview: expectedRows.slice(0, 5),
      actual_rows_preview: actualRows.slice(0, 5),
      llm_usage: mergeUsage(llmUsages),
      llm_cost: mergeCosts(llmCosts),
    };
  }

  const result = {
    status: finalFailureStatus,
    generated_sql: generated?.sql || '',
    explanation: generated?.explanation || '',
    assumptions: generated?.assumptions || [],
    tables_used: generated?.tables_used || [],
    retrieved_tables: retrievedTables,
    master_data_candidates: masterDataCandidates,
    error: executionError?.message || 'Unknown execution error',
    llm_usage: mergeUsage(llmUsages),
    llm_cost: mergeCosts(llmCosts),
  };

  await trace.emit('case.completed', {
    ...caseContext,
    success: false,
    status: result.status,
    generatedSql: result.generated_sql || null,
    error: serializeError(executionError),
    attempts: 2,
    llmUsage: result.llm_usage,
    llmCost: result.llm_cost,
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
    expected_tables: testCase.expected_tables,
    expected_columns: testCase.expected_columns,
    disallowed_columns: testCase.disallowed_columns,
    signal_checks: testCase.signal_checks,
    difficulty: testCase.difficulty,
    tags: testCase.tags,
    ...extra,
  };
}

async function runDatasetOnce({ client, connection, schema, model, datasetInfo, trace, cli, repetition, repeat }) {
  const results = [];

  for (const [index, testCase] of datasetInfo.cases.entries()) {
    if (repeat > 1) {
      cli.write(`(rep ${repetition}/${repeat}) `);
    }
    cli.write(`#${testCase.id} ${testCase.question} `);

    try {
      const result = await evaluateQuestion({
        client,
        connection,
        schema,
        model,
        testCase,
        caseIndex: index + 1,
        datasetName: datasetInfo.datasetName,
        trace,
      });

      results.push(buildResultRecord(testCase, result));
      cli.write(result.status === 'pass' ? '✅\n' : `❌ ${result.status}\n`);
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
  let connection;
  try {
    connection = await createMariaDbConnection();
  } catch (error) {
    await trace.emit('database.connection_failed', {
      ...connectionTimer.stop(),
      target: describeMariaDbConnectionTarget(),
      error: serializeError(error),
    });
    throw error;
  }

  await trace.emit('database.connected', {
    ...connectionTimer.stop(),
    target: describeMariaDbConnectionTarget(),
  });

  const perRepetition = [];

  cli.log(`Model: ${model}`);
  cli.log(`Schema file: ${SCHEMA_PATH}`);
  cli.log(`Dataset: ${datasetInfo.datasetName}`);
  cli.log(`Dataset file: ${datasetInfo.datasetPath}`);
  cli.log(`Environment: ${envInfo.path || 'not found'}`);
  cli.log(`Cases: ${datasetInfo.cases.length}/${datasetInfo.totalCases}`);
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

  try {
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      const repetitionResults = await runDatasetOnce({
        client,
        connection,
        schema,
        model,
        datasetInfo,
        trace,
        cli,
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
    await connection.end();
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
    reliability,
    traceFile: trace.filePath,
    results,
  });

  cli.log('\nSummary');
  cli.log(`Passed: ${summary.passed}/${summary.total} (first repetition)`);
  cli.log(`Failed: ${summary.failed}`);
  cli.log(`Status counts: ${JSON.stringify(summary.statusCounts)}`);
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
