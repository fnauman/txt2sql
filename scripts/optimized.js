import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_OPTIMIZED_QUESTIONS } from '../src/constants.js';
import { ENV_OPTIONS_WITH_VALUES, ENV_USAGE, getPositionalArgs, hasOptionFlag, loadEnvironment } from '../src/env.js';
import {
  createMariaDbConnection,
  createOpenAiClient,
  describeMariaDbConnectionTarget,
  describeSchema,
  loadNarrowSchema,
  printRows,
  reportQueryUserPrivileges,
  resolveEffectiveSchemaScope,
  resolveStatementTimeoutMs,
} from '../src/pipeline.js';
import { describeSchemaScope, resolveSchemaScopeConfig } from '../src/schema-scope.js';
import { formatUsageAndCost, mergeCosts, mergeUsage } from '../src/pricing.js';
import { createCliOutput, createTimer, createTraceLogger, resolveTraceOptions, serializeError } from '../src/trace.js';
import { resolveMaxRetries, runOptimizedQuestion } from '../src/query-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

const USAGE = `Usage: npm run optimized -- [question] [--refresh-schema] [--trace] [--trace-file <path>]
${ENV_USAGE}
Generated SQL runs with QUERY_STATEMENT_TIMEOUT_MS (default 8000 ms; 0 disables).
Schema scope: SCHEMA_SCOPE=auto|full|retrieved (default auto), SCHEMA_FULL_MAX_TOKENS (default 8000),
SCHEMA_WIDEN_ON_DEMAND (default: on for auto, off for an explicit retrieved).`;

async function main() {
  const argv = process.argv.slice(2);
  if (hasOptionFlag(argv, '--help')) {
    console.log(USAGE);
    return;
  }

  const envInfo = await loadEnvironment(argv);
  // Validate up front so a bad value fails the run, not every question.
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const maxRetries = resolveMaxRetries();
  const schemaScope = resolveSchemaScopeConfig();
  const refreshSchema = hasOptionFlag(argv, '--refresh-schema');
  const traceOptions = resolveTraceOptions(argv);
  const trace = await createTraceLogger({
    ...traceOptions,
    pipeline: 'optimized',
    metadata: {
      script: 'scripts/optimized.js',
    },
  });
  const cli = createCliOutput({
    traceToStdout: traceOptions.logToStdout,
  });
  const positional = getPositionalArgs(argv, [...ENV_OPTIONS_WITH_VALUES, '--trace-file']);
  const customQuestion = positional.join(' ').trim();
  const model = process.env.MODEL_NAME || 'gpt-4o-mini';
  const questions = customQuestion ? [customQuestion] : DEFAULT_OPTIMIZED_QUESTIONS;

  await trace.emit('run.started', {
    argv,
    environment: envInfo,
    model,
    questionCount: questions.length,
    refreshSchema,
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
    traceToStdout: traceOptions.logToStdout,
    traceFile: trace.filePath,
    statementTimeoutMs,
    maxRetries,
    schemaScope,
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

  const effectiveSchemaScope = resolveEffectiveSchemaScope(schema, schemaScope);
  await trace.emit('schema.loaded', {
    ...schemaTimer.stop(),
    schemaPath: SCHEMA_PATH,
    schemaScope: effectiveSchemaScope,
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
  await reportQueryUserPrivileges(connection);

  cli.log(`Model: ${model}`);
  cli.log(`Schema file: ${SCHEMA_PATH}`);
  cli.log(`Environment: ${envInfo.path || 'not found'}`);
  cli.log(`Schema scope: ${describeSchemaScope(effectiveSchemaScope)}`);

  let failureCount = 0;
  const runUsages = [];
  const runCosts = [];

  try {
    for (const [index, question] of questions.entries()) {
      const result = await runOptimizedQuestion({
        client,
        connection,
        schema,
        model,
        question,
        questionIndex: index + 1,
        trace,
        maxRetries,
        statementTimeoutMs,
        schemaScope,
      });

      if (result.llmUsage) {
        runUsages.push(result.llmUsage);
      }
      if (result.llmCost) {
        runCosts.push(result.llmCost);
      }

      cli.log('\n' + '━'.repeat(70));
      cli.log(`Q: ${question}`);
      for (const llmCall of result.llmCalls || []) {
        cli.log(`LLM attempt ${llmCall.attempt}: ${formatUsageAndCost({ usage: llmCall.usage, cost: llmCall.cost, model: llmCall.model || model })}`);
      }
      if (result.llmUsage || result.llmCost) {
        cli.log(`Total LLM: ${formatUsageAndCost({ usage: result.llmUsage, cost: result.llmCost, model })}`);
      }
      if (result.schemaScope?.effective === 'full') {
        cli.log(`Allowed tables: all ${result.promptTables.length} in-scope tables (full schema scope)`);
        cli.log(`Ranked tables (hint): ${(result.rankedTables || []).join(', ') || '(none)'}`);
      } else {
        cli.log(`Retrieved tables: ${result.promptTables.join(', ')}`);
      }
      if (result.schemaScope?.widenedTables?.length) {
        cli.log(`Widened on demand: ${result.schemaScope.widenedTables.join(', ')}`);
      }
      const masterDataCandidateCount = (result.masterDataCandidates || []).reduce(
        (count, group) => count + (group.totalCandidateCount || 0),
        0
      );
      cli.log(`Master-data candidates: ${masterDataCandidateCount}`);
      cli.log(`Explanation: ${result.response?.explanation || '(none)'}`);
      cli.log(`Assumptions: ${(result.response?.assumptions || []).join(' | ') || '(none)'}`);
      cli.log(`SQL: ${result.sql}`);

      if (!result.success) {
        failureCount += 1;
        cli.log(`Error (${result.errorStage}${result.errorCode ? `, ${result.errorCode}` : ''}): ${result.error.message}`);
        continue;
      }

      printRows(result.rows, cli);
    }
  } finally {
    const closeTimer = createTimer();
    await connection.end();
    await trace.emit('database.closed', {
      ...closeTimer.stop(),
    });
  }

  const totalUsage = mergeUsage(runUsages);
  const totalCost = mergeCosts(runCosts);

  await trace.emit('run.completed', {
    success: failureCount === 0,
    questionCount: questions.length,
    failureCount,
    llmUsage: totalUsage,
    llmCost: totalCost,
  });

  if (totalUsage || totalCost) {
    cli.log('\n' + '━'.repeat(70));
    cli.log(`Run total LLM: ${formatUsageAndCost({ usage: totalUsage, cost: totalCost, model })}`);
  }

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Optimized pipeline failed: ${error.message}`);
  process.exitCode = 1;
});
