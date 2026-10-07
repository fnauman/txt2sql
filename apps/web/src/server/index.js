import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { checkQueryUserPrivileges, describeMariaDbConnectionTarget, describeSchema, untilAborted } from '../../../../src/pipeline.js';
import { createResultInsights, inferColumns } from '../../../../src/result-intelligence.js';
import {
  createBufferedTraceLogger,
  errorCodeOf,
  isLlmUnavailableCode,
  loadOptimizedQueryRuntime,
  runOptimizedQuestion,
} from '../../../../src/query-service.js';
import { serializeError } from '../../../../src/trace.js';
import { buildLayoutSpec } from '../../../../src/result-layout.js';
import {
  createHostGuard,
  createOriginGuard,
  createRateLimiter,
  isAuthorized,
  isOriginAllowed,
  securityHeaders,
  toClientError,
} from './security.js';
import { ResultCache } from './result-cache.js';
import { resolveDataResidency } from './data-residency.js';
import { createRuntimeManager } from './runtime-manager.js';

// The HTTP app. Nothing here reads process.env: everything comes from the
// config object built by loadWebConfig() AFTER the .env file is loaded (see
// main.js), and the runtime factory / question runner / cache are injectable so
// the routes can be tested without MariaDB or OpenAI.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '../..');
export const DEFAULT_DIST_DIR = path.resolve(appRoot, 'dist');

const JSON_BODY_LIMIT = '2mb';

export function createDefaultRuntimeFactory(config) {
  return ({ refreshSchema = false } = {}) =>
    loadOptimizedQueryRuntime({
      refreshSchema,
      connectionLimit: config.dbConnectionLimit,
      clientOptions: { timeoutMs: config.openAi.timeoutMs, maxRetries: config.openAi.maxRetries },
      schemaScope: config.schemaScope,
      hintsVersion: config.hintsVersion ?? undefined,
      // MODEL_NAME, REASONING_EFFORT & co. as the config read them.
      model: config.model,
      reasoningEffort: config.reasoningEffort ?? null,
      completionSettings: config.completionSettings ?? undefined,
      trace: createBufferedTraceLogger({ enabled: false, pipeline: 'web-runtime' }),
    });
}

function isDemoSource(config) {
  return config.database.name === 'demo_retail' && config.database.user === 'demo_readonly';
}

function abortReason(code, message) {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = code;
  return error;
}

// HTTP status for a failed question, by the stage it failed in. A question the
// pipeline could not answer (guardrail block, SQL error, truncated or refused
// completion) is 422; an unavailable dependency is a gateway/availability
// error: the LLM provider timing out (504), unreachable or failing (502), or
// rejecting the server's key / rate-limiting it (503).
function statusForFailure(stage, code) {
  if (stage === 'infra') {
    return 503;
  }
  if (stage === 'aborted') {
    return code === 'REQUEST_TIMEOUT' ? 504 : 503;
  }
  if (stage === 'llm' && isLlmUnavailableCode(code)) {
    if (code === 'LLM_TIMEOUT') {
      return 504;
    }
    if (code === 'LLM_CONNECTION_ERROR' || /^HTTP_5\d\d$/.test(code)) {
      return 502;
    }
    return 503;
  }
  return 422;
}

function requestError(status, code, message) {
  return { status, body: { success: false, error: { name: status === 413 ? 'PayloadTooLarge' : 'BadRequest', message, code } } };
}

// Validates a /api/query(/stream) body. `refreshSchema` is intentionally not
// read: a schema refresh replaces the shared runtime, so it is the
// token-protected POST /api/admin/refresh-schema, never a per-question flag.
function parseQuestionRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: requestError(400, 'INVALID_REQUEST', 'The request body must be a JSON object.') };
  }

  if (body.question !== undefined && body.question !== null && typeof body.question !== 'string') {
    return { error: requestError(400, 'INVALID_REQUEST', 'question must be a string.') };
  }

  const question = String(body.question || '').trim();
  if (!question) {
    return { error: requestError(400, 'QUESTION_REQUIRED', 'Question is required.') };
  }

  if (question.length > config.maxQuestionLength) {
    return {
      error: requestError(413, 'QUESTION_TOO_LONG', `Question must be ${config.maxQuestionLength} characters or fewer.`),
    };
  }

  return {
    question,
    // A client debug flag is honored only when the server allows debug output.
    includeDebug: config.allowDebug && Boolean(body.debug),
    includeInsights: body.includeInsights !== false,
  };
}

function totalRowCountOf(result) {
  if (Number.isInteger(result.totalRowCount)) {
    return result.totalRowCount;
  }
  // Truncated by the server-side row cap: there are more than rowCount rows,
  // but the exact total is unknown, so it is reported as null.
  return result.truncated ? null : result.rowCount || 0;
}

function publicResult(result, trace, includeDebug, dataResidency) {
  const response = result.response || {};
  const errorStage = result.success ? null : result.errorStage || null;
  const errorCode = result.success ? null : result.errorCode ?? null;
  const payload = {
    success: result.success,
    question: result.question,
    sql: result.sql || '',
    rows: result.rows || [],
    columns: result.columns || [],
    rowCount: result.rowCount || 0,
    totalRowCount: totalRowCountOf(result),
    truncated: Boolean(result.truncated),
    explanation: response.explanation || '',
    assumptions: response.assumptions || [],
    tablesUsed: response.tables_used || [],
    promptTables: result.promptTables || [],
    // Retrieval's ranking (empty when nothing matched): in the full scope
    // promptTables is every in-scope table, so this is the only ranking.
    rankedTables: result.rankedTables || [],
    visualizations: result.visualizations || [],
    insights: result.insights || [],
    llmUsage: result.llmUsage || null,
    llmCost: result.llmCost || null,
    attemptCount: result.attemptCount || 0,
    errorStage,
    errorCode,
    // error.code is the classified code too: the raw error often has none (an
    // OpenAI SDK timeout is LLM_TIMEOUT by class, a MariaDB statement timeout
    // is ER_STATEMENT_TIMEOUT by errno), and the SSE error frame is this object.
    error: result.success
      ? null
      : toClientError(
          { ...(result.serializedError || serializeError(result.error)), ...(errorCode ? { code: errorCode } : {}) },
          { stage: errorStage }
        ),
    debug: includeDebug
      ? {
          events: trace.events,
          llmCalls: result.llmCalls || [],
          masterDataCandidates: result.masterDataCandidates || [],
          rawResponse: response.rawText || null,
        }
      : null,
  };

  // Deterministic adaptive layout derived from the result shape (no LLM).
  payload.layout = buildLayoutSpec(payload);
  // Whether these rows may be handed to a client-side engine (demo data only).
  payload.dataResidency = dataResidency;
  return payload;
}

// A failure that happened outside the question pipeline (runtime could not
// load, database unreachable or not bootstrapped, shutting down), or the
// request was cancelled before the pipeline ran (stage 'aborted').
function infraFailurePayload(error, { includeDebug = false, trace = null, name = null, code = null, stage = 'infra' } = {}) {
  const serialized = serializeError(error);
  const errorCode = code || errorCodeOf(error);
  const clientError = toClientError({ ...serialized, ...(name ? { name } : {}), code: errorCode }, { stage });
  return {
    success: false,
    errorStage: stage,
    errorCode,
    error: clientError,
    rows: [],
    columns: [],
    rowCount: 0,
    totalRowCount: 0,
    truncated: false,
    visualizations: [],
    insights: [],
    debug: includeDebug ? { events: trace?.events || [], error: serialized } : null,
  };
}

function schemaMissingError(config, dbSchema) {
  const missing = dbSchema.missingTables;
  const error = new Error(
    `Database "${config.database.name}" is missing expected demo tables. Missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}. Run npm run bootstrap-db for an empty local schema or load the demo seed data.`
  );
  error.name = 'DatabaseSchemaError';
  error.code = 'DB_SCHEMA_MISSING';
  return error;
}

// --- SSE streaming helpers --------------------------------------------------
// The streaming route is a second serializer over the SAME pipeline as the
// blocking POST /api/query — there is one pipeline, two output formats.
function sseFrame(res, event, data) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Maps the stage events runOptimizedQuestion already emits onto the coarse
// stages the client progress stepper renders.
const STREAM_STAGE_BY_EVENT = {
  'question.started': 'planning',
  'master_data.resolved': 'resolving_entities',
  'master_data.failed': 'resolving_entities',
  'prompt.built': 'generating_sql',
  'sql.validated': 'validating',
  'sql.executed': 'executing',
  'question.completed': 'shaping',
};

// A trace logger with the same { enabled, events, emit } shape the pipeline
// expects, but emit() ALSO writes SSE frames. Stage frames drive the stepper;
// the `sql` frame fires the instant the LLM returns (on `llm.completed`) — the
// keystone perceived-latency win, surfaced before validation + execution.
function createStreamingTraceLogger(res, { enabled = false, pipeline = 'web-stream' } = {}) {
  const events = [];
  return {
    enabled,
    events,
    pipeline,
    async emit(event, payload = {}) {
      if (enabled) {
        events.push({ timestamp: new Date().toISOString(), pipeline, event, ...payload });
      }

      const stage = STREAM_STAGE_BY_EVENT[event];
      if (stage) {
        sseFrame(res, 'stage', {
          stage,
          event,
          durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : null,
        });
      }

      if (event === 'llm.completed' && payload.response && payload.response.cleanedSql) {
        sseFrame(res, 'sql', {
          sql: payload.response.cleanedSql,
          explanation: payload.response.explanation || '',
          tablesUsed: payload.response.tablesUsed || [],
          assumptions: payload.response.assumptions || [],
          attempt: payload.attempt || 1,
          final: false,
        });
      }
    },
  };
}

// Drain an assembled publicResult payload into the ordered SSE frames the client
// reducer consumes. Used for both fresh runs and cache replays (identical client
// path); `cacheHit` rides on the sql + metrics frames to drive the cached badge.
function streamResultFrames(res, payload, includeDebug, cacheHit) {
  if (payload.sql) {
    sseFrame(res, 'sql', {
      sql: payload.sql,
      explanation: payload.explanation,
      tablesUsed: payload.tablesUsed,
      assumptions: payload.assumptions,
      promptTables: payload.promptTables,
      rankedTables: payload.rankedTables,
      attempt: payload.attemptCount,
      final: true,
      cacheHit,
    });
  }
  sseFrame(res, 'columns', {
    columns: payload.columns,
    rowCount: payload.rowCount,
    totalRowCount: payload.totalRowCount,
    truncated: payload.truncated,
  });
  if (payload.dataResidency) {
    sseFrame(res, 'residency', { dataResidency: payload.dataResidency });
  }
  sseFrame(res, 'rows', { rows: payload.rows });
  sseFrame(res, 'viz', { visualizations: payload.visualizations });
  sseFrame(res, 'insights', { insights: payload.insights });
  if (payload.layout) {
    sseFrame(res, 'layout', { layout: payload.layout });
  }
  sseFrame(res, 'metrics', { attemptCount: payload.attemptCount, llmCost: payload.llmCost, llmUsage: payload.llmUsage, cacheHit });
  if (includeDebug && payload.debug) {
    sseFrame(res, 'debug', payload.debug);
  }
  if (!payload.success && payload.error) {
    sseFrame(res, 'error', payload.error);
  }
}

// Messages for infra failures shown to callers that may not see internals
// (anonymous deep health; query routes when debug is not allowed and no token
// was presented): say WHAT is wrong (by code) without the host:port, paths or
// driver detail that raw messages carry. The raw message goes to the server log.
const ANONYMOUS_INFRA_MESSAGES = {
  OPENAI_NOT_CONFIGURED: 'OPENAI_API_KEY (or OPENROUTER_API_KEY with an openrouter.ai OPENAI_BASE_URL) is not configured on the server.',
  DB_NOT_CONFIGURED: 'The database settings are incomplete on the server.',
  DB_SCHEMA_MISSING: 'The database is missing the expected demo tables.',
  ER_ACCESS_DENIED_ERROR: 'The database rejected the configured credentials.',
  ER_BAD_DB_ERROR: 'The configured database does not exist.',
  ER_DBACCESS_DENIED_ERROR: 'The query user may not access the configured database.',
  INVALID_CONFIG: 'The server configuration is invalid.',
  SHUTTING_DOWN: 'The server is shutting down.',
};

function anonymousInfraError(error, code = errorCodeOf(error)) {
  return {
    name: 'Error',
    code,
    message: ANONYMOUS_INFRA_MESSAGES[code] || 'The query runtime or database is not reachable.',
  };
}

export function createApp({
  config,
  runtimeFactory = null,
  runtimeManager = null,
  resultCache = null,
  runQuestion = runOptimizedQuestion,
  envInfo = null,
  logger = console,
  distDir = DEFAULT_DIST_DIR,
} = {}) {
  if (!config) {
    throw new TypeError('createApp requires a config object from loadWebConfig().');
  }

  const runtimes =
    runtimeManager ||
    createRuntimeManager({
      factory: runtimeFactory || createDefaultRuntimeFactory(config),
      retireGraceMs: config.runtimeRetireGraceMs,
      closeTimeoutMs: config.shutdownTimeoutMs,
      logger,
    });
  const cache =
    resultCache ||
    new ResultCache({
      enabled: config.resultCache.enabled,
      maxEntries: config.resultCache.maxEntries,
      ttlMs: config.resultCache.ttlMs,
      isDemoSource: () => isDemoSource(config),
    });
  const dataResidency = resolveDataResidency({ DB_NAME: config.database.name, DB_USER: config.database.user });
  const queryRateLimiter = createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max });
  const allowedOrigins = new Set(config.allowedOrigins);

  function requireApiToken(req, res, next) {
    if (isAuthorized(req, config.apiToken)) {
      next();
      return;
    }
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({
      success: false,
      error: { name: 'Unauthorized', message: 'Unauthorized: a valid API token is required.', code: 'UNAUTHORIZED' },
    });
  }

  // Authenticated = a token is configured AND this request presented it. Only
  // such callers see diagnostics (env path, DB host/port, schema, grants).
  function isAuthenticated(req) {
    return config.authEnabled && isAuthorized(req, config.apiToken);
  }

  // Raw infra messages (driver errors carry the DB host:port, file paths, ...)
  // are for trusted callers only: debug allowed (loopback binds by default) or
  // the API token presented. Everyone else gets a message keyed by the code.
  function canSeeInternals(req) {
    return config.allowDebug || isAuthenticated(req);
  }

  function forCaller(req, payload) {
    if (!payload || payload.success || payload.errorStage !== 'infra') {
      return payload;
    }
    // The server log keeps the raw message whatever the caller sees.
    logger.warn?.(`[api] ${req.method} ${req.originalUrl || req.url} infra failure: ${payload.error?.message} [${payload.errorCode || 'no code'}]`);
    if (canSeeInternals(req)) {
      return payload;
    }
    return { ...payload, error: { ...anonymousInfraError(null, payload.errorCode), stage: 'infra' } };
  }

  function rateLimit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const { allowed, retryAfterMs } = queryRateLimiter.check(key, Date.now());
    if (allowed) {
      next();
      return;
    }
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      success: false,
      error: {
        name: 'TooManyRequests',
        message: `Too many requests. Please wait ${retryAfterSeconds}s and try again.`,
        code: 'RATE_LIMITED',
      },
    });
  }

  // Abort in-flight work when the client disconnects or the request deadline
  // passes: the signal stops the OpenAI generation (no wasted tokens), kills the
  // running MariaDB query, and runOptimizedQuestion bails without retrying.
  // Bound to the response, not req: once express.json() has drained the body,
  // req's 'close' no longer tracks the waiting client.
  function createRequestSignal(res) {
    const controller = new AbortController();
    res.on('close', () => controller.abort(abortReason('CLIENT_CLOSED', 'The client disconnected before the answer was ready.')));
    let timer = null;
    if (config.requestTimeoutMs > 0) {
      timer = setTimeout(
        () =>
          controller.abort(
            abortReason('REQUEST_TIMEOUT', `The question was cancelled after the ${config.requestTimeoutMs} ms request deadline.`)
          ),
        config.requestTimeoutMs
      );
      timer.unref?.();
    }
    return {
      signal: controller.signal,
      dispose() {
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
  }

  async function inspectDatabaseSchema(runtime) {
    const expectedTables = runtime.schema.tables.map((table) => table.tableName);
    const [rows] = await runtime.connection.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [config.database.name]
    );
    const actualTables = rows.map((row) => row.TABLE_NAME);
    const actualSet = new Set(actualTables);
    const missingTables = expectedTables.filter((tableName) => !actualSet.has(tableName));

    return {
      expectedTables,
      actualTables,
      missingTables,
      dbSchemaReady: missingTables.length === 0,
    };
  }

  // Memoized per runtime, but only while READY: a not-ready (or failed)
  // inspection is re-run on the next request, so running bootstrap-db or
  // seed-demo after the server started takes effect without a restart.
  function getDatabaseSchema(lease, { refresh = false } = {}) {
    const memo = lease.memo;
    if (refresh || !memo.dbSchemaPromise) {
      const promise = inspectDatabaseSchema(lease.runtime);
      memo.dbSchemaPromise = promise;
      promise.then(
        (dbSchema) => {
          if (!dbSchema.dbSchemaReady && memo.dbSchemaPromise === promise) {
            memo.dbSchemaPromise = null;
          }
        },
        () => {
          if (memo.dbSchemaPromise === promise) {
            memo.dbSchemaPromise = null;
          }
        }
      );
    }
    return memo.dbSchemaPromise;
  }

  // The shared question flow behind both query routes. The runtime lease is held
  // for the whole run, so an admin refresh cannot close its pool mid-question.
  // The setup waits are bounded by the request signal like the pipeline's own:
  // a stalled runtime load or schema inspection (e.g. waiting for a pool slot)
  // ends with the abort reason instead of holding the request open, and a lease
  // that arrives after that is released at once.
  async function answerQuestion({ question, includeDebug, includeInsights, trace, signal }) {
    const cacheGeneration = cache.generation;
    const lease = await untilAborted(runtimes.acquire(), signal, { onLate: (late) => late.release() });
    try {
      const dbSchema = await untilAborted(getDatabaseSchema(lease), signal);
      if (!dbSchema.dbSchemaReady) {
        return { kind: 'schema-missing', dbSchema };
      }

      // Debug runs always execute fresh (they want a live trace); everything else
      // can be served from the exact-match cache.
      const cacheable = !includeDebug;
      const cached = cacheable ? cache.get(question, dbSchema, config.rowLimit, includeInsights) : null;
      if (cached) {
        return { kind: 'result', payload: cached, cacheHit: true };
      }

      const runtime = lease.runtime;
      const result = await runQuestion({
        client: runtime.client,
        connection: runtime.connection,
        schema: runtime.schema,
        model: runtime.model,
        // From the web config (REASONING_EFFORT & co.), never process.env.
        reasoningEffort: config.reasoningEffort ?? null,
        completionSettings: config.completionSettings ?? undefined,
        question,
        trace,
        includeInsights,
        rowLimit: config.rowLimit,
        statementTimeoutMs: config.statementTimeoutMs,
        maxRetries: config.maxRetries,
        // From the web config (SCHEMA_SCOPE & co., HINTS_VERSION), never process.env.
        schemaScope: config.schemaScope,
        hintsVersion: config.hintsVersion ?? undefined,
        signal,
      });
      if (signal.aborted && result.success) {
        // The answer arrived after the deadline (or the client left), e.g. from
        // a runner that ignored the signal: never report or cache it.
        throw signal.reason;
      }

      const payload = publicResult(result, trace, includeDebug, dataResidency);
      if (cacheable) {
        cache.set(question, dbSchema, config.rowLimit, includeInsights, payload, Date.now(), { generation: cacheGeneration });
      }
      return { kind: 'result', payload, cacheHit: false };
    } finally {
      lease.release();
    }
  }

  // Errors with a known code (missing key, DB down, ...) are expected states:
  // one line. Anything unclassified keeps its stack for debugging.
  function logServerError(req, error) {
    const code = errorCodeOf(error);
    const detail = code ? `${error?.message || error} [${code}]` : error?.stack || error?.message || error;
    logger.error?.(`[api] ${req.method} ${req.originalUrl || req.url} failed: ${detail}`);
  }

  // A question that failed before or around the pipeline. When the request was
  // cancelled (deadline or disconnect during runtime or schema setup) it is the
  // same 'aborted' stage and status the pipeline reports; otherwise infra (503).
  function setupFailure(error, signal, options = {}) {
    const stage = signal.aborted ? 'aborted' : 'infra';
    const payload = infraFailurePayload(error, { ...options, stage });
    return { status: stage === 'aborted' ? statusForFailure(stage, payload.errorCode) : 503, payload };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // DNS-rebinding protection for every route (API and SPA).
  app.use(createHostGuard({ enabled: config.hostCheck, allowedHosts: config.allowedHosts }));
  // The same-origin exemption trusts the Host header, so it only applies when
  // the host guard above validates it (loopback bind or WEB_ALLOWED_HOSTS).
  app.use('/api', createOriginGuard({ allowedOrigins: config.allowedOrigins, sameOriginAllowed: config.hostCheck }));
  app.use(
    '/api',
    cors((req, callback) => {
      const origin = req.headers.origin;
      callback(null, {
        origin:
          Boolean(origin) &&
          isOriginAllowed(origin, { allowedOrigins, hostHeader: req.headers.host, trustHostHeader: config.hostCheck }),
      });
    })
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get('/api/health', async (req, res) => {
    const deep = req.query.deep === '1';
    const authenticated = isAuthenticated(req);

    // The shallow check is unauthenticated (the browser status bar polls it
    // without a token). The deep check touches the database, so it requires the
    // token whenever one is configured.
    if (deep && config.authEnabled && !authenticated) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({
        ok: false,
        error: { name: 'Unauthorized', message: 'Unauthorized: the deep health check requires the API token.', code: 'UNAUTHORIZED' },
      });
      return;
    }

    const payload = {
      ok: true,
      runtimeReady: runtimes.status().ready,
      openAiConfigured: config.openAi.configured,
      dbConfigured: config.database.configured,
      model: config.model,
      reasoningEffort: config.reasoningEffort ?? null,
      authRequired: config.authEnabled,
      debugAllowed: config.allowDebug,
      // The result cache and client cross-filter only engage for the demo
      // database read through demo_readonly; say so instead of failing silently.
      cacheEnabled: cache.enabled && isDemoSource(config),
      dataResidency: dataResidency.engine,
      // DB host/port, env paths and the schema are reconnaissance for a server
      // whose MariaDB instance may also host sensitive non-demo data: only
      // token-authenticated callers get them.
      ...(authenticated
        ? {
            env: envInfo ? { loaded: envInfo.loaded, path: envInfo.path, candidate: envInfo.candidate } : null,
            database: describeMariaDbConnectionTarget(),
          }
        : {}),
    };

    if (!deep) {
      res.json(payload);
      return;
    }

    let lease = null;
    // null until the database is actually tried. The runtime builds the OpenAI
    // client before it opens the pool, so a runtime that fails to load (e.g.
    // OPENAI_NOT_CONFIGURED) says nothing about the database; error.code names
    // the failing dependency.
    let dbReachable = null;
    // The request deadline bounds every wait, so a stalled runtime load or a
    // saturated pool is reported as unhealthy instead of hanging the probe.
    const { signal, dispose } = createRequestSignal(res);
    try {
      lease = await untilAborted(runtimes.acquire(), signal, { onLate: (late) => late.release() });
      dbReachable = false;
      const [rows] = await untilAborted(lease.runtime.connection.query('SELECT 1 AS ok'), signal);
      dbReachable = rows?.[0]?.ok === 1;
      const dbSchema = await untilAborted(getDatabaseSchema(lease, { refresh: true }), signal);
      const privileges = authenticated
        ? await untilAborted(
            checkQueryUserPrivileges(lease.runtime.connection, { database: config.database.name }).catch((error) => ({
              error: error.message,
            })),
            signal
          )
        : null;
      res.json({
        ...payload,
        runtimeReady: true,
        dbReachable,
        dbSchemaReady: dbSchema.dbSchemaReady,
        missingTables: dbSchema.missingTables,
        actualTableCount: dbSchema.actualTables.length,
        ...(authenticated ? { schema: describeSchema(lease.runtime.schema), privileges } : {}),
      });
    } catch (error) {
      // The full detail goes to the server log; the response carries it only
      // for an authenticated caller (never a stack).
      logger.warn?.(`[health] deep check failed: ${error?.message || error}`);
      res.status(503).json({
        ...payload,
        ok: false,
        dbReachable,
        error: authenticated ? toClientError({ ...serializeError(error), code: errorCodeOf(error) }) : anonymousInfraError(error),
      });
    } finally {
      dispose();
      lease?.release();
    }
  });

  app.post('/api/query', requireApiToken, rateLimit, async (req, res) => {
    const parsed = parseQuestionRequest(req.body, config);
    if (parsed.error) {
      res.status(parsed.error.status).json(parsed.error.body);
      return;
    }

    const { question, includeDebug, includeInsights } = parsed;
    // Created before the runtime is acquired so a disconnect during runtime or
    // schema setup is seen by runOptimizedQuestion.
    const requestSignal = createRequestSignal(res);
    const trace = createBufferedTraceLogger({ enabled: includeDebug, pipeline: 'web-query' });

    try {
      const outcome = await answerQuestion({ question, includeDebug, includeInsights, trace, signal: requestSignal.signal });
      if (outcome.kind === 'schema-missing') {
        const failure = infraFailurePayload(schemaMissingError(config, outcome.dbSchema), { includeDebug, trace });
        if (failure.debug) {
          failure.debug.database = outcome.dbSchema;
        }
        res.status(503).json(forCaller(req, failure));
        return;
      }

      const { payload, cacheHit } = outcome;
      const status = payload.success ? 200 : statusForFailure(payload.errorStage, payload.errorCode);
      res.status(status).json(forCaller(req, cacheHit ? { ...payload, cacheHit: true } : payload));
    } catch (error) {
      logServerError(req, error);
      const failure = setupFailure(error, requestSignal.signal, { includeDebug, trace });
      res.status(failure.status).json(forCaller(req, failure.payload));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/query/stream', requireApiToken, rateLimit, async (req, res) => {
    const parsed = parseQuestionRequest(req.body, config);
    if (parsed.error) {
      res.status(parsed.error.status).json(parsed.error.body);
      return;
    }

    const { question, includeDebug, includeInsights } = parsed;

    // Open the event stream. No status/headers can change after this point, so all
    // further failures are reported as `error` frames rather than HTTP statuses.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // defeat nginx-style proxy buffering
    });
    res.flushHeaders();
    res.write(': keepalive\n\n'); // prime the stream past idle-proxy timeouts

    const requestSignal = createRequestSignal(res);
    const trace = createStreamingTraceLogger(res, { enabled: includeDebug });

    try {
      const outcome = await answerQuestion({ question, includeDebug, includeInsights, trace, signal: requestSignal.signal });
      if (outcome.kind === 'schema-missing') {
        sseFrame(res, 'error', forCaller(req, infraFailurePayload(schemaMissingError(config, outcome.dbSchema))).error);
        return;
      }

      // Same serializer as the blocking route. On a cache hit no stage/early-sql
      // frames were emitted (the pipeline never ran) — the result simply lands.
      streamResultFrames(res, forCaller(req, outcome.payload), includeDebug, outcome.cacheHit);
    } catch (error) {
      logServerError(req, error);
      sseFrame(res, 'error', forCaller(req, setupFailure(error, requestSignal.signal).payload).error);
    } finally {
      requestSignal.dispose();
      sseFrame(res, 'done', {});
      res.end();
    }
  });

  function badRequest(res, message) {
    res.status(400).json({ success: false, error: { name: 'BadRequest', message, code: 'INVALID_REQUEST' } });
  }

  app.post('/api/insights', requireApiToken, rateLimit, (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      badRequest(res, 'The request body must be a JSON object.');
      return;
    }
    const body = req.body;
    if (body.rows !== undefined && !Array.isArray(body.rows)) {
      badRequest(res, 'rows must be an array of objects.');
      return;
    }
    // Client-supplied column descriptors drive the insight math, so they must
    // look like inferColumns() output (objects with a string key).
    if (
      body.columns !== undefined &&
      (!Array.isArray(body.columns) ||
        !body.columns.every((column) => column && typeof column === 'object' && !Array.isArray(column) && typeof column.key === 'string'))
    ) {
      badRequest(res, 'columns must be an array of objects with a string "key".');
      return;
    }
    if (body.question !== undefined && body.question !== null && typeof body.question !== 'string') {
      badRequest(res, 'question must be a string.');
      return;
    }
    const rows = body.rows || [];
    // Bound the synchronous insight computation to the same row cap as the query
    // pipeline, so a large posted body (up to the 2mb JSON limit) cannot pin the
    // event loop with tens of thousands of rows of work per request.
    if (rows.length > config.rowLimit) {
      res.status(413).json({
        success: false,
        error: { name: 'PayloadTooLarge', message: `rows exceeds the ${config.rowLimit} row limit.`, code: 'TOO_MANY_ROWS' },
      });
      return;
    }
    if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      badRequest(res, 'rows must be an array of objects.');
      return;
    }
    const columns = Array.isArray(body.columns) && body.columns.length > 0 ? body.columns : inferColumns(rows);
    res.json({
      insights: createResultInsights({
        question: String(body.question || ''),
        rows,
        columns,
      }),
    });
  });

  // Admin: rebuild the runtime from a freshly compiled schema. Refreshing
  // replaces the shared pool, so it is never a per-question flag: it requires a
  // configured WEB_API_TOKEN. In-flight questions finish on the old runtime,
  // which is closed once they are done; the result cache is cleared.
  app.post(
    '/api/admin/refresh-schema',
    (req, res, next) => {
      if (!config.authEnabled) {
        res.status(403).json({
          success: false,
          error: {
            name: 'Forbidden',
            message: 'Admin endpoints are disabled: set WEB_API_TOKEN on the server to enable them, then send it as a bearer token.',
            code: 'ADMIN_DISABLED',
          },
        });
        return;
      }
      next();
    },
    requireApiToken,
    rateLimit,
    async (req, res) => {
      try {
        const runtime = await runtimes.refresh();
        cache.clear();
        logger.log?.(`[admin] schema refreshed: ${runtime.schema?.tables?.length ?? 0} table(s); result cache cleared.`);
        res.json({
          success: true,
          tableCount: runtime.schema?.tables?.length ?? 0,
          refreshedAt: new Date().toISOString(),
        });
      } catch (error) {
        logServerError(req, error);
        res.status(503).json(infraFailurePayload(error));
      }
    }
  );

  // Unknown API routes get a JSON 404 rather than the SPA or Express' HTML page.
  app.use('/api', (req, res) => {
    res.status(404).json({
      success: false,
      error: { name: 'NotFound', message: `No API route for ${req.method} ${req.originalUrl}.`, code: 'NOT_FOUND' },
    });
  });

  const indexPath = path.resolve(distDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      res.sendFile(indexPath);
    });
  }

  // Client mistakes (malformed JSON, oversized body, ...) are 4xx with a clean
  // message; anything else is a logged 500 without internals.
  app.use((error, req, res, _next) => {
    const status = Number(error?.status || error?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      let code = 'BAD_REQUEST';
      let message = error.expose && error.message ? error.message : 'The request could not be processed.';
      if (error.type === 'entity.parse.failed') {
        code = 'INVALID_JSON';
        message = 'The request body is not valid JSON.';
      } else if (error.type === 'entity.too.large') {
        code = 'PAYLOAD_TOO_LARGE';
        message = `The request body exceeds the ${JSON_BODY_LIMIT} limit.`;
      }
      res.status(status).json({ success: false, error: { name: status === 413 ? 'PayloadTooLarge' : 'BadRequest', message, code } });
      return;
    }

    logServerError(req, error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({
      success: false,
      error: { name: 'InternalServerError', message: 'The server hit an unexpected error.', code: 'INTERNAL_ERROR' },
    });
  });

  return {
    app,
    config,
    runtimeManager: runtimes,
    resultCache: cache,
    close: () => runtimes.close(),
  };
}
