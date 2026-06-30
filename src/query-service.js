import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  buildOptimizedPrompt,
  buildSemanticPlan,
  createMariaDbPool,
  createOpenAiClient,
  executeReadOnlySql,
  generateOptimizedResponse,
  loadNarrowSchema,
  validateReadOnlySql,
} from './pipeline.js';
import { resolveMasterDataCandidates } from './master-data-resolver.js';
import { mergeCosts, mergeUsage } from './pricing.js';
import { createTimer, serializeError } from './trace.js';
import { createResultInsights, inferColumns, normalizeRows, suggestVisualizations } from './result-intelligence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_MODELS_DIR = path.resolve(REPO_ROOT, 'models');
export const DEFAULT_SCHEMA_PATH = path.resolve(REPO_ROOT, 'generated/schema.json');

export function createNoopTraceLogger() {
  return {
    enabled: false,
    events: [],
    async emit() {},
  };
}

export function createBufferedTraceLogger({ enabled = true, pipeline = 'optimized', metadata = {} } = {}) {
  const events = [];
  const runId = randomUUID();

  return {
    enabled,
    events,
    pipeline,
    runId,
    filePath: null,
    async emit(event, payload = {}) {
      if (!enabled) {
        return;
      }

      events.push({
        timestamp: new Date().toISOString(),
        pipeline,
        runId,
        event,
        ...metadata,
        ...payload,
      });
    },
  };
}

function createEmptyResult({ question, questionIndex, error, response = null, sql = '', llmCalls = [], llmUsage = null, llmCost = null, promptTables = [], masterDataCandidates = [], attemptCount = 0 }) {
  return {
    success: false,
    question,
    questionIndex,
    sql,
    rows: [],
    columns: [],
    visualizations: [],
    insights: [],
    response,
    error,
    serializedError: serializeError(error),
    llmCalls,
    llmUsage,
    llmCost,
    promptTables,
    masterDataCandidates,
    attemptCount,
    rowCount: 0,
    totalRowCount: 0,
    truncated: false,
  };
}

function createSuccessResult({ question, questionIndex, sql, rawRows, response, llmCalls, llmUsage, llmCost, promptTables, masterDataCandidates, attemptCount, rowLimit, includeInsights }) {
  const totalRowCount = Array.isArray(rawRows) ? rawRows.length : 0;
  const hasRowLimit = Number.isFinite(rowLimit) && rowLimit >= 0;
  const rows = normalizeRows(rawRows, { limit: hasRowLimit ? rowLimit : null });
  const columns = inferColumns(rows);
  const visualizations = suggestVisualizations(rows, columns);
  const insights = includeInsights
    ? createResultInsights({ question, rows, columns, rowLimit })
    : [];

  return {
    success: true,
    question,
    questionIndex,
    sql,
    rows,
    columns,
    visualizations,
    insights,
    response,
    llmCalls,
    llmUsage,
    llmCost,
    promptTables,
    masterDataCandidates,
    attemptCount,
    rowCount: rows.length,
    totalRowCount,
    truncated: hasRowLimit && totalRowCount > rows.length,
  };
}

export async function loadOptimizedQueryRuntime({
  refreshSchema = false,
  modelsDir = DEFAULT_MODELS_DIR,
  schemaPath = DEFAULT_SCHEMA_PATH,
  trace = createNoopTraceLogger(),
  connectionLimit = Number(process.env.WEB_DB_CONNECTION_LIMIT || 5),
} = {}) {
  const model = process.env.MODEL_NAME || 'gpt-4o-mini';

  const schemaTimer = createTimer();
  const schema = await loadNarrowSchema({
    modelsDir,
    schemaPath,
    refreshSchema,
  });
  await trace.emit('schema.loaded', {
    ...schemaTimer.stop(),
    schemaPath,
    tableCount: schema.tables.length,
  });

  const client = createOpenAiClient();
  await trace.emit('openai.client_ready', {
    model,
    openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
  });

  const connectionTimer = createTimer();
  const connection = createMariaDbPool({ connectionLimit });
  await trace.emit('database.pool_ready', {
    ...connectionTimer.stop(),
    connectionLimit,
  });

  return {
    model,
    schema,
    client,
    connection,
    modelsDir,
    schemaPath,
    async close() {
      await connection.end();
    },
  };
}

function createAbortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error('Request aborted before completion.');
  error.name = 'AbortError';
  return error;
}

export async function runOptimizedQuestion({
  client,
  connection,
  schema,
  model = process.env.MODEL_NAME || 'gpt-4o-mini',
  question,
  questionIndex = 1,
  trace = createNoopTraceLogger(),
  maxRetries = Number(process.env.WEB_QUERY_MAX_RETRIES || 1),
  rowLimit = null,
  includeInsights = true,
  statementTimeoutMs = null,
  signal = null,
} = {}) {
  const normalizedQuestion = String(question || '').trim();
  if (!normalizedQuestion) {
    throw new Error('Question is required.');
  }

  if (!client) {
    throw new Error('OpenAI client is required.');
  }

  if (!connection) {
    throw new Error('MariaDB connection or pool is required.');
  }

  if (!schema || !Array.isArray(schema.tables)) {
    throw new Error('Compiled schema is required.');
  }

  const questionContext = {
    questionIndex,
    question: normalizedQuestion,
  };

  await trace.emit('question.started', questionContext);

  // If the client already went away (e.g. the SSE stream closed during runtime
  // or schema setup), bail before the pre-LLM master-data lookup so we never
  // spend database capacity resolving candidates for a result no one can read.
  if (signal?.aborted) {
    await trace.emit('question.aborted', { ...questionContext });
    return createEmptyResult({
      question: normalizedQuestion,
      questionIndex,
      error: createAbortError(signal),
    });
  }

  const semanticPlan = buildSemanticPlan(normalizedQuestion);
  const masterDataTimer = createTimer();
  let masterDataCandidates = [];

  try {
    masterDataCandidates = await resolveMasterDataCandidates({
      connection,
      semanticPlan,
    });
    await trace.emit('master_data.resolved', {
      ...questionContext,
      ...masterDataTimer.stop(),
      totalCandidateCount: masterDataCandidates.reduce(
        (count, group) => count + (group.totalCandidateCount || 0),
        0
      ),
      candidates: masterDataCandidates,
    });
  } catch (error) {
    await trace.emit('master_data.failed', {
      ...questionContext,
      ...masterDataTimer.stop(),
      error: serializeError(error),
    });
  }

  const promptTimer = createTimer();
  const prompt = buildOptimizedPrompt(schema, normalizedQuestion, { masterDataCandidates, semanticPlan });
  await trace.emit('prompt.built', {
    ...questionContext,
    ...promptTimer.stop(),
    prompt: {
      system: prompt.system,
      user: prompt.user,
    },
    context: prompt.context,
  });

  const allowedTables = (prompt.tables || schema.tables).map((table) => table.tableName);
  let attempt = 0;
  let lastResponse = null;
  let lastError = null;
  let lastErrorStage = null;
  const llmUsages = [];
  const llmCosts = [];
  const llmCalls = [];

  const getLlmUsage = () => mergeUsage(llmUsages);
  const getLlmCost = () => mergeCosts(llmCosts);

  while (attempt <= maxRetries) {
    const retryContext =
      attempt === 0
        ? null
        : {
            sql: lastResponse?.sql || '',
            error: lastError?.message || String(lastError || 'Unknown error'),
            stage: lastErrorStage,
            tablesUsed: lastResponse?.tables_used || [],
            assumptions: lastResponse?.assumptions || [],
          };
    const attemptContext = {
      ...questionContext,
      attempt: attempt + 1,
      retry: attempt > 0,
    };
    const llmTimer = createTimer();
    let response;

    try {
      response = await generateOptimizedResponse({
        client,
        model,
        prompt,
        retryContext,
        signal,
      });
    } catch (error) {
      lastError = error;
      lastErrorStage = 'llm';

      // If the client went away (SSE closed -> AbortController fired), stop here:
      // do not retry (which would start a fresh, equally-doomed LLM call) and do
      // not keep working on a result no one will read.
      if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'APIUserAbortError') {
        await trace.emit('question.aborted', { ...questionContext, ...attemptContext });
        return createEmptyResult({
          question: normalizedQuestion,
          questionIndex,
          sql: lastResponse?.sql || '',
          error,
          response: lastResponse,
          llmCalls,
          llmUsage: getLlmUsage(),
          llmCost: getLlmCost(),
          promptTables: prompt.tables.map((table) => table.tableName),
          masterDataCandidates,
          attemptCount: attempt + 1,
        });
      }

      await trace.emit('llm.failed', {
        ...attemptContext,
        ...llmTimer.stop(),
        retryContext,
        error: serializeError(error),
      });

      attempt += 1;
      if (attempt > maxRetries) {
        const result = createEmptyResult({
          question: normalizedQuestion,
          questionIndex,
          sql: lastResponse?.sql || '',
          error,
          response: lastResponse,
          llmCalls,
          llmUsage: getLlmUsage(),
          llmCost: getLlmCost(),
          promptTables: prompt.tables.map((table) => table.tableName),
          masterDataCandidates,
          attemptCount: attempt,
        });

        await trace.emit('question.completed', {
          ...questionContext,
          success: false,
          attempts: attempt,
          sql: result.sql || null,
          llmUsage: result.llmUsage,
          llmCost: result.llmCost,
          error: serializeError(error),
        });

        return result;
      }

      continue;
    }

    lastResponse = response;
    if (response.usage) {
      llmUsages.push(response.usage);
    }
    if (response.cost) {
      llmCosts.push(response.cost);
    }
    llmCalls.push({
      attempt: attempt + 1,
      usage: response.usage,
      cost: response.cost,
      model: response.responseModel,
    });

    await trace.emit('llm.completed', {
      ...attemptContext,
      ...llmTimer.stop(),
      retryContext,
      request: response.request,
      response: {
        id: response.responseId,
        model: response.responseModel,
        finishReason: response.finishReason,
        usage: response.usage,
        cost: response.cost,
        rawText: response.rawText,
        cleanedSql: response.sql,
        explanation: response.explanation,
        tablesUsed: response.tables_used,
        assumptions: response.assumptions,
      },
    });

    const validationTimer = createTimer();
    let validated;
    try {
      validated = validateReadOnlySql(response.sql, allowedTables, {
        promptContext: prompt.context,
        response,
      });
    } catch (error) {
      lastError = error;
      lastErrorStage = 'validation';
      await trace.emit('sql.validation_failed', {
        ...attemptContext,
        ...validationTimer.stop(),
        candidateSql: response.sql,
        allowedTables,
        error: serializeError(error),
      });

      attempt += 1;
      if (attempt > maxRetries) {
        const result = createEmptyResult({
          question: normalizedQuestion,
          questionIndex,
          sql: response.sql,
          error,
          response,
          llmCalls,
          llmUsage: getLlmUsage(),
          llmCost: getLlmCost(),
          promptTables: prompt.tables.map((table) => table.tableName),
          masterDataCandidates,
          attemptCount: attempt,
        });

        await trace.emit('question.completed', {
          ...questionContext,
          success: false,
          attempts: attempt,
          sql: result.sql || null,
          llmUsage: result.llmUsage,
          llmCost: result.llmCost,
          error: serializeError(error),
        });

        return result;
      }

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

    // The LLM call has completed; if the client disconnected in the gap before
    // we reach the database, skip execution rather than run a query whose rows
    // can no longer be delivered.
    if (signal?.aborted) {
      await trace.emit('question.aborted', { ...questionContext, ...attemptContext });
      return createEmptyResult({
        question: normalizedQuestion,
        questionIndex,
        sql: validated.sql,
        error: createAbortError(signal),
        response,
        llmCalls,
        llmUsage: getLlmUsage(),
        llmCost: getLlmCost(),
        promptTables: prompt.tables.map((table) => table.tableName),
        masterDataCandidates,
        attemptCount: attempt + 1,
      });
    }

    const executionTimer = createTimer();
    try {
      const rawRows = await executeReadOnlySql(connection, validated.sql, { timeoutMs: statementTimeoutMs });
      const result = createSuccessResult({
        question: normalizedQuestion,
        questionIndex,
        sql: validated.sql,
        rawRows,
        response,
        llmCalls,
        llmUsage: getLlmUsage(),
        llmCost: getLlmCost(),
        promptTables: prompt.tables.map((table) => table.tableName),
        masterDataCandidates,
        attemptCount: attempt + 1,
        rowLimit,
        includeInsights,
      });

      await trace.emit('sql.executed', {
        ...attemptContext,
        ...executionTimer.stop(),
        sql: validated.sql,
        rowCount: result.totalRowCount,
        displayedRowCount: result.rowCount,
        truncated: result.truncated,
      });

      await trace.emit('question.completed', {
        ...questionContext,
        success: true,
        attempts: attempt + 1,
        tablesUsed: validated.tablesUsed,
        rowCount: result.totalRowCount,
        displayedRowCount: result.rowCount,
        llmUsage: result.llmUsage,
        llmCost: result.llmCost,
      });

      return result;
    } catch (error) {
      lastError = error;
      lastErrorStage = 'execution';
      await trace.emit('sql.execution_failed', {
        ...attemptContext,
        ...executionTimer.stop(),
        sql: validated.sql,
        error: serializeError(error),
      });

      attempt += 1;
      if (attempt > maxRetries) {
        const result = createEmptyResult({
          question: normalizedQuestion,
          questionIndex,
          sql: response.sql,
          error,
          response,
          llmCalls,
          llmUsage: getLlmUsage(),
          llmCost: getLlmCost(),
          promptTables: prompt.tables.map((table) => table.tableName),
          masterDataCandidates,
          attemptCount: attempt,
        });

        await trace.emit('question.completed', {
          ...questionContext,
          success: false,
          attempts: attempt,
          sql: result.sql || null,
          llmUsage: result.llmUsage,
          llmCost: result.llmCost,
          error: serializeError(error),
        });

        return result;
      }
    }
  }

  const result = createEmptyResult({
    question: normalizedQuestion,
    questionIndex,
    sql: lastResponse?.sql || '',
    error: lastError || new Error('Unknown optimized execution failure.'),
    response: lastResponse,
    llmCalls,
    llmUsage: getLlmUsage(),
    llmCost: getLlmCost(),
    promptTables: prompt.tables.map((table) => table.tableName),
    masterDataCandidates,
    attemptCount: attempt,
  });

  await trace.emit('question.completed', {
    ...questionContext,
    success: false,
    attempts: attempt,
    sql: result.sql || null,
    llmUsage: result.llmUsage,
    llmCost: result.llmCost,
    error: serializeError(result.error),
  });

  return result;
}
