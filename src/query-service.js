import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

import {
  buildOptimizedPrompt,
  buildSemanticPlan,
  createMariaDbPool,
  createOpenAiClient,
  executeReadOnlySql,
  generateOptimizedResponse,
  loadNarrowSchema,
  rankedTableNames,
  resolveEffectiveSchemaScope,
  tablesToWidenFor,
  validateReadOnlySql,
} from './pipeline.js';
import { normalizeHintsVersion, resolveHintsVersion } from './hints-version.js';
import { normalizeSchemaScopeConfig, resolveSchemaScopeConfig } from './schema-scope.js';
import { resolveMasterDataCandidates } from './master-data-resolver.js';
import { assertModelSupported, defaultReasoningEffort, normalizeReasoningEffort, resolveCompletionSettings, resolveModelName } from './model-config.js';
import { mergeCosts, mergeUsage } from './pricing.js';
import { clearSemanticLayerCache } from './semantic-layer.js';
import { createTimer, serializeError } from './trace.js';
import { createResultInsights, inferColumns, normalizeRows, suggestVisualizations } from './result-intelligence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_MODELS_DIR = path.resolve(REPO_ROOT, 'models');
export const DEFAULT_SCHEMA_PATH = path.resolve(REPO_ROOT, 'generated/schema.json');

// Where a failed question stopped (defined in constants.js so trace.js can use
// it without an import cycle).
export { ERROR_STAGES } from './constants.js';

export const DEFAULT_MAX_RETRIES = 1;
const MAX_RETRIES_LIMIT = 5;

export function resolveMaxRetries(env = process.env) {
  const raw = env.WEB_QUERY_MAX_RETRIES;
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_MAX_RETRIES;
  }

  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || value > MAX_RETRIES_LIMIT) {
    const error = new Error(`WEB_QUERY_MAX_RETRIES must be an integer between 0 and ${MAX_RETRIES_LIMIT}; got "${raw}".`);
    error.code = 'INVALID_CONFIG';
    throw error;
  }

  return value;
}

export function resolveDbConnectionLimit(env = process.env) {
  const raw = env.WEB_DB_CONNECTION_LIMIT;
  if (raw === undefined || String(raw).trim() === '') {
    return 5;
  }

  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    const error = new Error(`WEB_DB_CONNECTION_LIMIT must be an integer between 1 and 100; got "${raw}".`);
    error.code = 'INVALID_CONFIG';
    throw error;
  }

  return value;
}

// The OpenAI SDK's transport errors set neither `code` nor `name` (both stay
// the generic Error defaults), so they are recognized by class. The constructor
// name check covers an error thrown by a second copy of the SDK.
function isSdkError(error, ErrorClass) {
  return error instanceof ErrorClass || error?.constructor?.name === ErrorClass.name;
}

// Stable machine-readable code for an error: error.code when the source set
// one (mysql2 ER_* / E* codes, LLM_TRUNCATED, ...), otherwise a few known
// shapes that arrive without a code. OpenAI SDK errors map to LLM_TIMEOUT /
// LLM_CONNECTION_ERROR / LLM_ABORTED, and provider HTTP errors to
// HTTP_<status> (the provider's own body code, e.g. invalid_api_key, stays in
// the message), except an unknown model or deployment (body code
// model_not_found / DeploymentNotFound, which OpenAI sends with 404 and some
// OpenAI-compatible servers with 400): LLM_MODEL_NOT_FOUND, so a wrong
// MODEL_NAME is never mistaken for a bad request about the question.
const MODEL_NOT_FOUND_BODY_CODES = new Set(['modelnotfound', 'deploymentnotfound']);

export function errorCodeOf(error) {
  if (!error) {
    return null;
  }

  // Subclass before superclass: a timeout is also an APIConnectionError, and
  // both are APIErrors.
  if (isSdkError(error, APIConnectionTimeoutError)) {
    return 'LLM_TIMEOUT';
  }
  if (isSdkError(error, APIUserAbortError)) {
    return 'LLM_ABORTED';
  }
  if (isSdkError(error, APIConnectionError)) {
    return 'LLM_CONNECTION_ERROR';
  }
  if (isSdkError(error, APIError) && Number.isInteger(error.status)) {
    if (typeof error.code === 'string' && MODEL_NOT_FOUND_BODY_CODES.has(error.code.toLowerCase().replace(/[^a-z]/g, ''))) {
      return 'LLM_MODEL_NOT_FOUND';
    }
    return `HTTP_${error.status}`;
  }

  if (typeof error.code === 'string' && error.code) {
    return error.code;
  }

  if (error.errno === 1969) {
    return 'ER_STATEMENT_TIMEOUT';
  }

  const message = String(error.message || '');
  if (/^Pool is closed/i.test(message)) {
    return 'POOL_CLOSED';
  }
  if (/Queue limit reached/i.test(message)) {
    return 'POOL_QUEUE_LIMIT';
  }

  if (Number.isInteger(error.status)) {
    return `HTTP_${error.status}`;
  }

  return null;
}

// Provider-side LLM failures that say nothing about the prompt: the provider
// timed out, was unreachable, rejected the key, does not serve the model or
// the endpoint path (404, LLM_MODEL_NOT_FOUND: a wrong MODEL_NAME or
// OPENAI_BASE_URL), rate-limited us or failed (5xx). The SDK has already
// retried the transient ones at the transport level (OPENAI_MAX_RETRIES), so
// they fail fast instead of paying for another app attempt, and the web API
// answers them as gateway errors (502/503/504), not as an unprocessable
// question (422).
const LLM_UNAVAILABLE_CODES = new Set(['LLM_TIMEOUT', 'LLM_CONNECTION_ERROR', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'LLM_MODEL_NOT_FOUND', 'HTTP_429']);

export function isLlmUnavailableCode(code) {
  return LLM_UNAVAILABLE_CODES.has(code) || /^HTTP_5\d\d$/.test(String(code || ''));
}

export function isLlmUnavailableError(error) {
  return isLlmUnavailableCode(errorCodeOf(error));
}

// Connection-, pool- and auth-level failures say nothing about the SQL, so
// sending them back to the model as a "database error" only buys a paid retry
// of a query that was fine. They fail fast as 'infra' instead.
const INFRA_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ER_ACCESS_DENIED_ERROR',
  'ER_CON_COUNT_ERROR',
  'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_SERVER_SHUTDOWN',
  'POOL_CLOSED',
  'POOL_QUEUE_LIMIT',
  'DB_NOT_CONFIGURED',
]);

export function isInfraError(error) {
  if (!error) {
    return false;
  }

  return INFRA_ERROR_CODES.has(errorCodeOf(error)) || error.fatal === true;
}

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

function createEmptyResult({ question, questionIndex, error, stage, response = null, sql = '', llmCalls = [], llmUsage = null, llmCost = null, promptTables = [], rankedTables = [], schemaScope = null, masterDataCandidates = [], attemptCount = 0 }) {
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
    errorStage: stage,
    errorCode: errorCodeOf(error),
    serializedError: serializeError(error),
    llmCalls,
    llmUsage,
    llmCost,
    promptTables,
    rankedTables,
    schemaScope,
    masterDataCandidates,
    attemptCount,
    rowCount: 0,
    totalRowCount: 0,
    truncated: false,
  };
}

function createSuccessResult({ question, questionIndex, sql, rawRows, response, llmCalls, llmUsage, llmCost, promptTables, rankedTables = [], schemaScope = null, masterDataCandidates, attemptCount, rowLimit, includeInsights }) {
  const fetchedRowCount = Array.isArray(rawRows) ? rawRows.length : 0;
  const hasRowLimit = Number.isInteger(rowLimit) && rowLimit >= 0;
  const rows = normalizeRows(rawRows, { limit: hasRowLimit ? rowLimit : null });
  const truncated = hasRowLimit && fetchedRowCount > rows.length;
  // The read is capped at maxRows (= rowLimit + 1) rows, server-side and while
  // streaming (an explicit LIMIT in the SQL cannot lift it), so a truncated
  // result only proves there are MORE than rowLimit rows: the exact total is
  // unknown and is reported as null rather than a misleading number.
  const totalRowCount = truncated ? null : fetchedRowCount;
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
    errorStage: null,
    errorCode: null,
    llmCalls,
    llmUsage,
    llmCost,
    promptTables,
    rankedTables,
    schemaScope,
    masterDataCandidates,
    attemptCount,
    rowCount: rows.length,
    totalRowCount,
    truncated,
  };
}

/**
 * The model settings of a run: the caller's, else MODEL_NAME (DEFAULT_MODEL),
 * REASONING_EFFORT and the endpoint settings (OPENAI_BASE_URL,
 * OPENROUTER_REQUIRE_PARAMETERS, LLM_MAX_COMPLETION_TOKENS) from the env.
 * `reasoningEffort` null means none set (the env is not read); either way the
 * effort is validated for the model, so a bad one fails before any work, and
 * with none set the model family's default effort applies
 * (defaultReasoningEffort: medium for gpt-6*, null for gpt-4o-mini).
 */
export function resolveRunModelSettings({ model = undefined, reasoningEffort = undefined, completionSettings = undefined } = {}, env = process.env) {
  const resolvedModel = model ?? resolveModelName(env).model;
  const modelSource = model === undefined || model === null ? resolveModelName(env).source : 'model';
  assertModelSupported(resolvedModel, { source: modelSource === 'default' ? 'the default model' : modelSource });
  const fromEnv = reasoningEffort === undefined;
  return {
    model: resolvedModel,
    reasoningEffort:
      normalizeReasoningEffort(resolvedModel, fromEnv ? env.REASONING_EFFORT : reasoningEffort, {
        source: fromEnv ? 'REASONING_EFFORT' : 'reasoningEffort',
      }) ?? defaultReasoningEffort(resolvedModel),
    completionSettings: completionSettings ?? resolveCompletionSettings(env),
  };
}

export async function loadOptimizedQueryRuntime({
  refreshSchema = false,
  modelsDir = DEFAULT_MODELS_DIR,
  schemaPath = DEFAULT_SCHEMA_PATH,
  trace = createNoopTraceLogger(),
  connectionLimit = undefined,
  clientOptions = {},
  schemaScope = undefined,
  hintsVersion = undefined,
  model: requestedModel = undefined,
  reasoningEffort: requestedReasoningEffort = undefined,
  completionSettings: requestedCompletionSettings = undefined,
} = {}) {
  // The caller's model settings (the web server's config), else MODEL_NAME,
  // REASONING_EFFORT & co. from the env; a bad effort fails here.
  const { model, reasoningEffort, completionSettings } = resolveRunModelSettings({
    model: requestedModel,
    reasoningEffort: requestedReasoningEffort,
    completionSettings: requestedCompletionSettings,
  });
  const effectiveConnectionLimit = connectionLimit ?? resolveDbConnectionLimit();
  // SCHEMA_SCOPE / SCHEMA_FULL_MAX_TOKENS / SCHEMA_WIDEN_ON_DEMAND and
  // HINTS_VERSION unless the caller (the web server's config) passes its own;
  // a bad value fails here, before anything is opened.
  const schemaScopeConfig = schemaScope === undefined ? resolveSchemaScopeConfig() : normalizeSchemaScopeConfig(schemaScope);
  const resolvedHintsVersion = hintsVersion === undefined ? resolveHintsVersion() : normalizeHintsVersion(hintsVersion);

  // The OpenAI client is cheap and fails fast on missing/invalid settings, so it
  // is created first: a misconfigured server never compiles the schema or opens
  // a pool for a runtime it cannot use.
  const client = createOpenAiClient(clientOptions);
  await trace.emit('openai.client_ready', {
    model,
    reasoningEffort,
    openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
  });

  if (refreshSchema) {
    // A refresh also re-reads metadata/semantic-layer.json.
    clearSemanticLayerCache();
  }

  const schemaTimer = createTimer();
  const schema = await loadNarrowSchema({
    modelsDir,
    schemaPath,
    refreshSchema,
  });
  const effectiveSchemaScope = resolveEffectiveSchemaScope(schema, schemaScopeConfig);
  await trace.emit('schema.loaded', {
    ...schemaTimer.stop(),
    schemaPath,
    tableCount: schema.tables.length,
    schemaScope: effectiveSchemaScope,
    hintsVersion: resolvedHintsVersion,
  });

  const connectionTimer = createTimer();
  const connection = createMariaDbPool({ connectionLimit: effectiveConnectionLimit });
  await trace.emit('database.pool_ready', {
    ...connectionTimer.stop(),
    connectionLimit: effectiveConnectionLimit,
  });

  let closePromise = null;
  return {
    model,
    // The effort and endpoint settings to pass to runOptimizedQuestion.
    reasoningEffort,
    completionSettings,
    schema,
    client,
    connection,
    modelsDir,
    schemaPath,
    // The config to pass to runOptimizedQuestion, and what it means for this
    // schema (requested / effective scope, full-schema token estimate).
    schemaScope: schemaScopeConfig,
    effectiveSchemaScope,
    // The hints version to pass to runOptimizedQuestion (src/hints-version.js).
    hintsVersion: resolvedHintsVersion,
    close() {
      closePromise ||= connection.end();
      return closePromise;
    },
  };
}

function createAbortError(signal, cause = null) {
  const reason = signal?.reason;
  if (reason instanceof Error && typeof reason.code === 'string') {
    return reason;
  }
  const error = new Error('Request aborted before completion.');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  if (cause || reason) {
    error.cause = cause || reason;
  }
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || isSdkError(error, APIUserAbortError);
}

function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer; got ${value}.`);
  }
}

export async function runOptimizedQuestion({
  client,
  connection,
  schema,
  model = undefined,
  reasoningEffort = undefined,
  completionSettings = undefined,
  question,
  questionIndex = 1,
  trace = createNoopTraceLogger(),
  maxRetries = undefined,
  rowLimit = null,
  includeInsights = true,
  statementTimeoutMs = null,
  signal = null,
  schemaScope = undefined,
  hintsVersion = undefined,
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

  const effectiveMaxRetries = maxRetries ?? resolveMaxRetries();
  assertNonNegativeInteger('maxRetries', effectiveMaxRetries);
  // Likewise the model (MODEL_NAME, else DEFAULT_MODEL), its reasoning effort
  // (REASONING_EFFORT, validated for the model) and the endpoint settings.
  const runModel = resolveRunModelSettings({ model, reasoningEffort, completionSettings });
  const llmModelConfig = { ...runModel.completionSettings, reasoningEffort: runModel.reasoningEffort };
  // Like maxRetries: the caller's setting, else SCHEMA_SCOPE & co. from the env.
  const schemaScopeConfig = schemaScope === undefined ? resolveSchemaScopeConfig() : normalizeSchemaScopeConfig(schemaScope);
  // Likewise HINTS_VERSION (src/hints-version.js).
  const resolvedHintsVersion = hintsVersion === undefined ? resolveHintsVersion() : normalizeHintsVersion(hintsVersion);
  if (rowLimit != null) {
    assertNonNegativeInteger('rowLimit', rowLimit);
  }
  // Fetch one row beyond the display limit so truncation is detected without
  // materializing the whole result in Node (sql_select_limit, server-side).
  const maxRows = rowLimit == null ? null : rowLimit + 1;

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
      stage: 'aborted',
    });
  }

  const semanticPlan = buildSemanticPlan(normalizedQuestion, { hintsVersion: resolvedHintsVersion });
  const masterDataTimer = createTimer();
  let masterDataCandidates = [];

  try {
    masterDataCandidates = await resolveMasterDataCandidates({
      connection,
      semanticPlan,
      statementTimeoutMs,
      signal,
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

    if (signal?.aborted) {
      await trace.emit('question.aborted', { ...questionContext });
      return createEmptyResult({
        question: normalizedQuestion,
        questionIndex,
        error: createAbortError(signal, error),
        stage: 'aborted',
      });
    }

    // The database is down or rejecting us: generating SQL now would only pay
    // for an LLM call whose query cannot run. Other lookup failures (e.g. a
    // statement timeout) degrade to "no candidates" as before.
    if (isInfraError(error)) {
      const result = createEmptyResult({ question: normalizedQuestion, questionIndex, error, stage: 'infra' });
      await trace.emit('question.completed', {
        ...questionContext,
        success: false,
        attempts: 0,
        errorStage: 'infra',
        error: serializeError(error),
      });
      return result;
    }
  }

  const promptTimer = createTimer();
  const buildPrompt = (extraTables = []) =>
    buildOptimizedPrompt(schema, normalizedQuestion, {
      masterDataCandidates,
      semanticPlan,
      schemaScope: schemaScopeConfig,
      extraTables,
      hintsVersion: resolvedHintsVersion,
    });
  let prompt = buildPrompt();
  await trace.emit('prompt.built', {
    ...questionContext,
    ...promptTimer.stop(),
    schemaScope: prompt.context.schemaScope,
    prompt: {
      system: prompt.system,
      user: prompt.user,
    },
    context: prompt.context,
  });

  // The allow-list is the prompt's table set: every in-scope table in the
  // full scope, the retrieved tables (plus any widened ones) otherwise.
  let allowedTables = (prompt.tables || schema.tables).map((table) => table.tableName);
  let promptTables = prompt.tables.map((table) => table.tableName);
  const rankedTables = rankedTableNames(prompt.context.retrieval);
  let widenedTables = [];
  // Set when the prompt was widened after a TABLE_SCOPE rejection: the retry
  // is told the table was added instead of "outside the allowed table set".
  let pendingRetryNote = null;
  let attempt = 0;
  let lastResponse = null;
  let lastError = null;
  let lastErrorStage = null;
  const llmUsages = [];
  const llmCosts = [];
  const llmCalls = [];

  const getLlmUsage = () => mergeUsage(llmUsages);
  const getLlmCost = () => mergeCosts(llmCosts);

  const buildFailure = ({ error, stage, sql = lastResponse?.sql || '', response = lastResponse, attemptCount }) =>
    createEmptyResult({
      question: normalizedQuestion,
      questionIndex,
      sql,
      error,
      stage,
      response,
      llmCalls,
      llmUsage: getLlmUsage(),
      llmCost: getLlmCost(),
      promptTables,
      rankedTables,
      schemaScope: prompt.context.schemaScope,
      masterDataCandidates,
      attemptCount,
    });

  const completeWithFailure = async (failure) => {
    const result = buildFailure(failure);
    await trace.emit('question.completed', {
      ...questionContext,
      success: false,
      attempts: result.attemptCount,
      sql: result.sql || null,
      llmUsage: result.llmUsage,
      llmCost: result.llmCost,
      errorStage: result.errorStage,
      error: serializeError(result.error),
    });
    return result;
  };

  const abortWith = async (attemptContext, failure) => {
    await trace.emit('question.aborted', { ...questionContext, ...attemptContext });
    return buildFailure({ ...failure, stage: 'aborted' });
  };

  while (attempt <= effectiveMaxRetries) {
    const retryContext =
      attempt === 0
        ? null
        : {
            sql: lastResponse?.sql || '',
            error: pendingRetryNote?.error ?? (lastError?.message || String(lastError || 'Unknown error')),
            stage: pendingRetryNote?.stage ?? lastErrorStage,
            tablesUsed: lastResponse?.tables_used || [],
            assumptions: lastResponse?.assumptions || [],
          };
    pendingRetryNote = null;
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
        model: runModel.model,
        prompt,
        retryContext,
        signal,
        modelConfig: llmModelConfig,
      });
    } catch (error) {
      lastError = error;
      lastErrorStage = 'llm';
      // A truncated/refused completion was still billed; keep the totals honest.
      if (error?.usage) {
        llmUsages.push(error.usage);
      }
      if (error?.cost) {
        llmCosts.push(error.cost);
      }

      // If the client went away (SSE closed -> AbortController fired), stop here:
      // do not retry (which would start a fresh, equally-doomed LLM call) and do
      // not keep working on a result no one will read.
      if (signal?.aborted || isAbortError(error)) {
        return abortWith(attemptContext, {
          error: signal?.aborted ? createAbortError(signal, error) : error,
          attemptCount: attempt + 1,
        });
      }

      await trace.emit('llm.failed', {
        ...attemptContext,
        ...llmTimer.stop(),
        retryContext,
        errorCode: errorCodeOf(error),
        error: serializeError(error),
      });

      attempt += 1;
      // A provider outage (timeout, unreachable, bad key, rate limit, 5xx) was
      // already retried by the SDK; another app attempt would wait out the same
      // outage, so it fails fast.
      if (isLlmUnavailableError(error) || attempt > effectiveMaxRetries) {
        return completeWithFailure({ error, stage: 'llm', attemptCount: attempt });
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
      if (attempt > effectiveMaxRetries) {
        return completeWithFailure({ error, stage: 'validation', sql: response.sql, response, attemptCount: attempt });
      }

      // Widen-on-demand (retrieved scope): the SQL needs an in-scope table
      // retrieval did not pick. The retry gets a prompt with that table (and
      // its join path) in the schema context and the allow-list, within the
      // same retry budget. Tables outside the in-scope schema stay rejected.
      const schemaScopeInfo = prompt.context.schemaScope;
      const toAdd =
        schemaScopeInfo?.effective === 'retrieved' && schemaScopeInfo.widenOnDemand
          ? tablesToWidenFor(error, response.sql, { schema, allowedTables })
          : [];
      if (toAdd.length > 0) {
        const previousTables = allowedTables;
        prompt = buildPrompt([...widenedTables, ...toAdd]);
        widenedTables = prompt.context.schemaScope.widenedTables;
        allowedTables = prompt.tables.map((table) => table.tableName);
        promptTables = allowedTables;
        const addedTables = allowedTables.filter((tableName) => !previousTables.includes(tableName));
        pendingRetryNote = {
          stage: 'schema_widened',
          error:
            `Table "${error.details?.table ?? toAdd[0]}" was not in the previous schema context. It is in scope, and the schema context above now ` +
            `includes ${addedTables.join(', ')}. Use exact column names and join paths from the schema context.`,
        };
        await trace.emit('prompt.widened', {
          ...attemptContext,
          reason: error.code,
          rejectedTable: error.details?.table ?? null,
          addedTables,
          widenedTables,
          allowedTables,
          schemaScope: prompt.context.schemaScope,
          prompt: { system: prompt.system, user: prompt.user },
          context: prompt.context,
        });
        // Widening never cuts a join path to fit the budget that sent auto to
        // the retrieved scope; a widened schema block past it (long paths on
        // a large schema) is reported, not silent.
        if (prompt.context.schemaScope.widenOverBudget) {
          await trace.emit('prompt.widen_over_budget', {
            ...attemptContext,
            widenedTables,
            connectorTableCount: prompt.context.schemaScope.widenConnectorTables.length,
            allowedTableCount: allowedTables.length,
            inScopeTableCount: prompt.context.schemaScope.inScopeTableCount,
            widenedSchemaEstimatedTokens: prompt.context.schemaScope.widenedSchemaEstimatedTokens,
            fullSchemaMaxTokens: prompt.context.schemaScope.fullSchemaMaxTokens,
          });
        }
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
      return abortWith(attemptContext, {
        error: createAbortError(signal),
        sql: validated.sql,
        response,
        attemptCount: attempt + 1,
      });
    }

    const executionTimer = createTimer();
    try {
      const rawRows = await executeReadOnlySql(connection, validated.sql, {
        timeoutMs: statementTimeoutMs,
        maxRows,
        signal,
      });
      const result = createSuccessResult({
        question: normalizedQuestion,
        questionIndex,
        sql: validated.sql,
        rawRows,
        response,
        llmCalls,
        llmUsage: getLlmUsage(),
        llmCost: getLlmCost(),
        promptTables,
        rankedTables,
        schemaScope: prompt.context.schemaScope,
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

      // executeReadOnlySql never returns rows after an abort, but the request
      // can still be cancelled while they are shaped and traced: a cancelled
      // request is never reported (or cached) as a success.
      if (signal?.aborted) {
        return abortWith(attemptContext, {
          error: createAbortError(signal),
          sql: validated.sql,
          response,
          attemptCount: attempt + 1,
        });
      }

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
      if (signal?.aborted) {
        return abortWith(attemptContext, {
          error: createAbortError(signal, error),
          sql: validated.sql,
          response,
          attemptCount: attempt + 1,
        });
      }

      const stage = isInfraError(error) ? 'infra' : 'execution';
      lastError = error;
      lastErrorStage = stage;
      await trace.emit('sql.execution_failed', {
        ...attemptContext,
        ...executionTimer.stop(),
        sql: validated.sql,
        errorStage: stage,
        error: serializeError(error),
      });

      attempt += 1;
      // Infra failures fail fast: the SQL was fine, so asking the model to
      // "fix" it would only pay for another call that cannot succeed.
      if (stage === 'infra' || attempt > effectiveMaxRetries) {
        return completeWithFailure({ error, stage, sql: response.sql, response, attemptCount: attempt });
      }
    }
  }

  return completeWithFailure({
    error: lastError || new Error('Unknown optimized execution failure.'),
    stage: lastErrorStage || 'execution',
    attemptCount: attempt,
  });
}
