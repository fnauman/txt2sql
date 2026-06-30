import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BASIC_QUESTIONS } from '../src/constants.js';
import { getPositionalArgs, hasOptionFlag, loadEnvironment } from '../src/env.js';
import {
  buildBasicPrompt,
  createMariaDbConnection,
  createOpenAiClient,
  describeMariaDbConnectionTarget,
  describeSchema,
  executeReadOnlySql,
  generateBasicSql,
  loadNarrowSchema,
  printRows,
  validateReadOnlySql,
} from '../src/pipeline.js';
import { formatUsageAndCost, mergeCosts, mergeUsage } from '../src/pricing.js';
import { createCliOutput, createTimer, createTraceLogger, resolveTraceOptions, serializeError } from '../src/trace.js';

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
    pipeline: 'basic',
    metadata: {
      script: 'scripts/basic.js',
    },
  });
  const cli = createCliOutput({
    traceToStdout: traceOptions.logToStdout,
  });
  const positional = getPositionalArgs(argv, ['--env-file', '--env-dir', '--trace-file']);
  const customQuestion = positional.join(' ').trim();
  const model = process.env.MODEL_NAME || 'gpt-4o-mini';
  const questions = customQuestion ? [customQuestion] : DEFAULT_BASIC_QUESTIONS;

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

  const allowedTables = schema.tables.map((table) => table.tableName);

  cli.log(`Model: ${model}`);
  cli.log(`Schema file: ${SCHEMA_PATH}`);
  cli.log(`In-scope tables: ${allowedTables.join(', ')}`);
  cli.log(`Environment: ${envInfo.path || 'not found'}`);

  let failureCount = 0;
  const runUsages = [];
  const runCosts = [];

  try {
    for (const [index, question] of questions.entries()) {
      const questionContext = {
        questionIndex: index + 1,
        question,
      };

      await trace.emit('question.started', questionContext);

      let prompt = null;
      let generated = null;
      let validated = null;
      let rows = null;

      try {
        const promptTimer = createTimer();
        prompt = buildBasicPrompt(schema, question);

        await trace.emit('prompt.built', {
          ...questionContext,
          ...promptTimer.stop(),
          prompt: {
            system: prompt.system,
            user: prompt.user,
          },
          context: prompt.context,
        });

        const llmTimer = createTimer();
        try {
          generated = await generateBasicSql({ client, model, prompt });
        } catch (error) {
          await trace.emit('llm.failed', {
            ...questionContext,
            ...llmTimer.stop(),
            error: serializeError(error),
          });
          throw error;
        }

        await trace.emit('llm.completed', {
          ...questionContext,
          ...llmTimer.stop(),
          request: generated.request,
          response: {
            id: generated.responseId,
            model: generated.responseModel,
            finishReason: generated.finishReason,
            usage: generated.usage,
            cost: generated.cost,
            rawText: generated.rawText,
            cleanedSql: generated.sql,
          },
        });

        if (generated.usage) {
          runUsages.push(generated.usage);
        }
        if (generated.cost) {
          runCosts.push(generated.cost);
        }

        const validationTimer = createTimer();
        try {
          validated = validateReadOnlySql(generated.sql, allowedTables);
        } catch (error) {
          await trace.emit('sql.validation_failed', {
            ...questionContext,
            ...validationTimer.stop(),
            candidateSql: generated.sql,
            allowedTables,
            error: serializeError(error),
          });
          throw error;
        }

        await trace.emit('sql.validated', {
          ...questionContext,
          ...validationTimer.stop(),
          validation: {
            success: true,
            sql: validated.sql,
            firstKeyword: validated.firstKeyword,
            statementCount: validated.statementCount,
            tablesUsed: validated.tablesUsed,
          },
        });

        const executionTimer = createTimer();
        try {
          rows = await executeReadOnlySql(connection, validated.sql);
        } catch (error) {
          await trace.emit('sql.execution_failed', {
            ...questionContext,
            ...executionTimer.stop(),
            sql: validated.sql,
            error: serializeError(error),
          });
          throw error;
        }

        await trace.emit('sql.executed', {
          ...questionContext,
          ...executionTimer.stop(),
          sql: validated.sql,
          rowCount: Array.isArray(rows) ? rows.length : null,
        });

        await trace.emit('question.completed', {
          ...questionContext,
          success: true,
          tablesUsed: validated.tablesUsed,
          rowCount: Array.isArray(rows) ? rows.length : null,
          llmUsage: generated.usage,
          llmCost: generated.cost,
        });

        cli.log('\n' + '━'.repeat(70));
        cli.log(`Q: ${question}`);
        cli.log(`LLM: ${formatUsageAndCost({ usage: generated.usage, cost: generated.cost, model: generated.responseModel })}`);
        cli.log(`SQL: ${validated.sql}`);
        printRows(rows, cli);
      } catch (error) {
        failureCount += 1;

        await trace.emit('question.completed', {
          ...questionContext,
          success: false,
          sql: validated?.sql || generated?.sql || null,
          llmUsage: generated?.usage || null,
          llmCost: generated?.cost || null,
          error: serializeError(error),
        });

        cli.log('\n' + '━'.repeat(70));
        cli.log(`Q: ${question}`);
        if (generated?.usage || generated?.cost) {
          cli.log(`LLM: ${formatUsageAndCost({ usage: generated?.usage, cost: generated?.cost, model: generated?.responseModel || model })}`);
        }
        if (validated?.sql || generated?.sql) {
          cli.log(`SQL: ${validated?.sql || generated?.sql}`);
        }
        cli.log(`Error: ${error.message}`);
      }
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
    cli.log(`Total LLM: ${formatUsageAndCost({ usage: totalUsage, cost: totalCost, model })}`);
  }

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Basic pipeline failed: ${error.message}`);
  process.exitCode = 1;
});
