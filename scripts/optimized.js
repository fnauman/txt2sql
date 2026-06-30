import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_OPTIMIZED_QUESTIONS } from '../src/constants.js';
import { getPositionalArgs, hasOptionFlag, loadEnvironment } from '../src/env.js';
import {
  createMariaDbConnection,
  createOpenAiClient,
  describeMariaDbConnectionTarget,
  describeSchema,
  loadNarrowSchema,
  printRows,
} from '../src/pipeline.js';
import { formatUsageAndCost, mergeCosts, mergeUsage } from '../src/pricing.js';
import { createCliOutput, createTimer, createTraceLogger, resolveTraceOptions, serializeError } from '../src/trace.js';
import { runOptimizedQuestion } from '../src/query-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

async function main() {
  const argv = process.argv.slice(2);
  const envInfo = await loadEnvironment(argv);
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
  const positional = getPositionalArgs(argv, ['--env-file', '--env-dir', '--trace-file']);
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

  cli.log(`Model: ${model}`);
  cli.log(`Schema file: ${SCHEMA_PATH}`);
  cli.log(`Environment: ${envInfo.path || 'not found'}`);

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
      cli.log(`Retrieved tables: ${result.promptTables.join(', ')}`);
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
        cli.log(`Error: ${result.error.message}`);
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
