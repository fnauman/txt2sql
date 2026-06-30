import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { loadEnvironment } from '../../../../src/env.js';
import { describeMariaDbConnectionTarget, describeSchema } from '../../../../src/pipeline.js';
import { createResultInsights, inferColumns } from '../../../../src/result-intelligence.js';
import {
  createBufferedTraceLogger,
  loadOptimizedQueryRuntime,
  runOptimizedQuestion,
} from '../../../../src/query-service.js';
import { serializeError } from '../../../../src/trace.js';
import { buildLayoutSpec } from '../../../../src/result-layout.js';
import { createRateLimiter, isAuthorized, toClientError } from './security.js';
import { resultCache } from './result-cache.js';
import { resolveDataResidency } from './data-residency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(appRoot, '../..');
const distDir = path.resolve(appRoot, 'dist');
const indexPath = path.resolve(distDir, 'index.html');

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const port = parsePositiveInteger(process.env.WEB_API_PORT, 8787);
const host = process.env.WEB_API_HOST || '127.0.0.1';
const frontendPort = parsePositiveInteger(process.env.WEB_FRONTEND_PORT || process.env.VITE_PORT, 5173);
const maxQuestionLength = parsePositiveInteger(process.env.WEB_MAX_QUESTION_LENGTH, 2000);
const rowLimit = parsePositiveInteger(process.env.WEB_QUERY_ROW_LIMIT, 1000);
// Statement timeout for model-authored SQL (ms). Defaults to 8s; set to 0 to
// disable. Bounds the tail so a pathological generated query cannot pin the
// MariaDB instance, which may also host sensitive non-demo databases.
const statementTimeoutMs = Number.isFinite(Number(process.env.WEB_QUERY_STATEMENT_TIMEOUT_MS))
  ? Math.max(0, Number(process.env.WEB_QUERY_STATEMENT_TIMEOUT_MS))
  : 8000;
const rateLimitWindowMs = parsePositiveInteger(process.env.WEB_RATE_LIMIT_WINDOW_MS, 60_000);
// 0 (or a non-positive value) disables rate limiting.
const rateLimitMax = Number.isFinite(Number(process.env.WEB_RATE_LIMIT_MAX))
  ? Math.max(0, Math.trunc(Number(process.env.WEB_RATE_LIMIT_MAX)))
  : 30;
// Optional bearer-token auth. Empty (the default) leaves the API open for local use.
const apiToken = process.env.WEB_API_TOKEN || '';

const queryRateLimiter = createRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax });

function requireApiToken(req, res, next) {
  if (isAuthorized(req, apiToken)) {
    next();
    return;
  }
  res.status(401).json({ error: { message: 'Unauthorized: a valid API token is required.' } });
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
    error: { message: `Too many requests. Please wait ${retryAfterSeconds}s and try again.` },
  });
}

function parseAllowedOrigins(value, fallback) {
  const origins = String(value || '')
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set(origins.length > 0 ? origins : fallback);
}

const allowedOrigins = parseAllowedOrigins(process.env.WEB_ALLOWED_ORIGINS, [
  `http://localhost:${frontendPort}`,
  `http://127.0.0.1:${frontendPort}`,
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

function corsOrigin(origin, callback) {
  callback(null, !origin || allowedOrigins.has(origin));
}

function defaultEnvArgs() {
  if (process.env.ENV_FILE || process.env.ENV_DIR || process.env.USE_HOME_ENV === '1') {
    return [];
  }

  return ['--env-file', path.resolve(repoRoot, '.env')];
}

const envInfo = await loadEnvironment(defaultEnvArgs());
let runtimePromise = null;
let refreshRuntimePromise = null;
let dbSchemaPromise = null;
let dbSchemaRuntime = null;

function createRuntimePromise({ refreshSchema = false, previousRuntimePromise = null } = {}) {
  const trace = createBufferedTraceLogger({ enabled: false, pipeline: 'web-runtime' });
  let nextRuntimePromise;

  nextRuntimePromise = loadOptimizedQueryRuntime({ refreshSchema, trace })
    .then(async (runtime) => {
      if (previousRuntimePromise) {
        const previousRuntime = await previousRuntimePromise.catch(() => null);
        if (previousRuntime && previousRuntime !== runtime) {
          await previousRuntime.close();
        }
      }
      return runtime;
    })
    .catch((error) => {
      if (runtimePromise === nextRuntimePromise) {
        runtimePromise = previousRuntimePromise;
      }
      throw error;
    })
    .finally(() => {
      if (refreshRuntimePromise === nextRuntimePromise) {
        refreshRuntimePromise = null;
      }
    });

  runtimePromise = nextRuntimePromise;
  dbSchemaPromise = null;
  dbSchemaRuntime = null;
  return nextRuntimePromise;
}

async function getRuntime({ refreshSchema = false } = {}) {
  if (refreshSchema) {
    if (!refreshRuntimePromise) {
      refreshRuntimePromise = createRuntimePromise({ refreshSchema: true, previousRuntimePromise: runtimePromise });
    }
    return refreshRuntimePromise;
  }

  if (!runtimePromise) {
    runtimePromise = createRuntimePromise();
  }

  return runtimePromise;
}

function publicResult(result, trace, includeDebug) {
  const response = result.response || {};
  const payload = {
    success: result.success,
    question: result.question,
    sql: result.sql || '',
    rows: result.rows || [],
    columns: result.columns || [],
    rowCount: result.rowCount || 0,
    totalRowCount: result.totalRowCount || result.rowCount || 0,
    truncated: Boolean(result.truncated),
    explanation: response.explanation || '',
    assumptions: response.assumptions || [],
    tablesUsed: response.tables_used || [],
    promptTables: result.promptTables || [],
    visualizations: result.visualizations || [],
    insights: result.insights || [],
    llmUsage: result.llmUsage || null,
    llmCost: result.llmCost || null,
    attemptCount: result.attemptCount || 0,
    error: result.success ? null : toClientError(result.serializedError || serializeError(result.error)),
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
  payload.dataResidency = resolveDataResidency();
  return payload;
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
      attempt: payload.attemptCount,
      final: true,
      cacheHit,
    });
  }
  sseFrame(res, 'columns', { columns: payload.columns, totalRowCount: payload.totalRowCount, truncated: payload.truncated });
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

async function inspectDatabaseSchema(runtime) {
  const expectedTables = runtime.schema.tables.map((table) => table.tableName);
  const [rows] = await runtime.connection.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [process.env.DB_NAME]
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

function getDatabaseSchema(runtime, { refresh = false } = {}) {
  if (refresh || dbSchemaRuntime !== runtime || !dbSchemaPromise) {
    let nextSchemaPromise;
    nextSchemaPromise = inspectDatabaseSchema(runtime).catch((error) => {
      if (dbSchemaPromise === nextSchemaPromise) {
        dbSchemaPromise = null;
        dbSchemaRuntime = null;
      }
      throw error;
    });
    dbSchemaPromise = nextSchemaPromise;
    dbSchemaRuntime = runtime;
  }

  return dbSchemaPromise;
}

function readiness({ includeDiagnostics = false } = {}) {
  const base = {
    openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
    dbConfigured: Boolean(process.env.DB_USER && process.env.DB_NAME),
    model: process.env.MODEL_NAME || 'gpt-4o-mini',
  };

  if (!includeDiagnostics) {
    return base;
  }

  // The .env filesystem paths and the DB host/user/schema are useful
  // reconnaissance for a server whose MariaDB instance may also host sensitive non-demo data,
  // so only expose them to an authorized caller. When no token is configured
  // (local dev), isAuthorized is open and this stays fully visible as before.
  return {
    ...base,
    env: {
      loaded: envInfo.loaded,
      path: envInfo.path,
      candidate: envInfo.candidate,
    },
    database: describeMariaDbConnectionTarget(),
  };
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res) => {
  // /api/health is unauthenticated (the browser status bar polls it without a
  // token). Gate the sensitive diagnostics on authorization so a configured
  // token actually hides DB topology / env paths / full schema from anonymous
  // callers, while leaving the open-by-default local-dev behavior intact.
  const includeDiagnostics = isAuthorized(req, apiToken);
  const payload = {
    ok: true,
    runtimeReady: Boolean(runtimePromise),
    ...readiness({ includeDiagnostics }),
  };

  if (req.query.deep !== '1') {
    res.json(payload);
    return;
  }

  try {
    const runtime = await getRuntime();
    const [rows] = await runtime.connection.query('SELECT 1 AS ok');
    const dbSchema = await getDatabaseSchema(runtime, { refresh: true });
    res.json({
      ...payload,
      runtimeReady: true,
      dbReachable: rows?.[0]?.ok === 1,
      dbSchemaReady: dbSchema.dbSchemaReady,
      missingTables: dbSchema.missingTables,
      actualTableCount: dbSchema.actualTables.length,
      ...(includeDiagnostics ? { schema: describeSchema(runtime.schema) } : {}),
    });
  } catch (error) {
    // Sanitize like every other route: serializeError keeps the stack, which
    // must not leak from this unauthenticated endpoint.
    res.status(503).json({
      ...payload,
      ok: false,
      dbReachable: false,
      error: toClientError(serializeError(error)),
    });
  }
});

app.post('/api/query', requireApiToken, rateLimit, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const includeDebug = Boolean(req.body?.debug);
  const includeInsights = req.body?.includeInsights !== false;
  const refreshSchema = Boolean(req.body?.refreshSchema);

  if (!question) {
    res.status(400).json({ error: { message: 'Question is required.' } });
    return;
  }

  if (question.length > maxQuestionLength) {
    res.status(413).json({ error: { message: `Question must be ${maxQuestionLength} characters or fewer.` } });
    return;
  }

  // Abort in-flight work when the client disconnects. Bound to the response,
  // not req: once express.json() has drained the request body, req's 'close'
  // no longer tracks the waiting client, so a mid-LLM disconnect would be
  // missed. Mirrors /api/query/stream, and is created before getRuntime so a
  // disconnect during runtime/schema setup is seen by runOptimizedQuestion.
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  const trace = createBufferedTraceLogger({ enabled: includeDebug, pipeline: 'web-query' });

  try {
    const runtime = await getRuntime({ refreshSchema });
    const dbSchema = await getDatabaseSchema(runtime);
    if (!dbSchema.dbSchemaReady) {
      res.status(503).json({
        success: false,
        error: {
          name: 'DatabaseSchemaError',
          message: `Database "${process.env.DB_NAME}" is missing expected demo tables. Missing: ${dbSchema.missingTables.slice(0, 8).join(', ')}${dbSchema.missingTables.length > 8 ? ', ...' : ''}. Run npm run bootstrap-db for an empty local schema or load the demo seed data.`,
        },
        rows: [],
        columns: [],
        rowCount: 0,
        totalRowCount: 0,
        truncated: false,
        visualizations: [],
        insights: [],
        debug: includeDebug
          ? {
              events: trace.events,
              database: dbSchema,
            }
          : null,
      });
      return;
    }

    const cacheable = !includeDebug;
    const cached = cacheable ? resultCache.get(question, dbSchema, rowLimit, includeInsights) : null;
    if (cached) {
      res.status(200).json({ ...cached, cacheHit: true });
      return;
    }

    const result = await runOptimizedQuestion({
      client: runtime.client,
      connection: runtime.connection,
      schema: runtime.schema,
      model: runtime.model,
      question,
      trace,
      includeInsights,
      rowLimit,
      statementTimeoutMs,
      signal: abortController.signal,
    });

    const payload = publicResult(result, trace, includeDebug);
    if (cacheable) {
      resultCache.set(question, dbSchema, rowLimit, includeInsights, payload);
    }
    res.status(result.success ? 200 : 422).json(payload);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: toClientError(serializeError(error)),
      debug: includeDebug ? { events: trace.events, error: serializeError(error) } : null,
    });
  }
});

app.post('/api/query/stream', requireApiToken, rateLimit, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const includeDebug = Boolean(req.body?.debug);
  const includeInsights = req.body?.includeInsights !== false;
  const refreshSchema = Boolean(req.body?.refreshSchema);

  if (!question) {
    res.status(400).json({ error: { message: 'Question is required.' } });
    return;
  }

  if (question.length > maxQuestionLength) {
    res.status(413).json({ error: { message: `Question must be ${maxQuestionLength} characters or fewer.` } });
    return;
  }

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

  // When the client goes away, abort the in-flight work: the signal stops the
  // OpenAI generation (no wasted tokens) and runOptimizedQuestion bails without
  // retrying. The DB query is additionally bounded by the statement timeout.
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  const trace = createStreamingTraceLogger(res, { enabled: includeDebug });

  try {
    const runtime = await getRuntime({ refreshSchema });
    const dbSchema = await getDatabaseSchema(runtime);
    if (!dbSchema.dbSchemaReady) {
      sseFrame(res, 'error', {
        name: 'DatabaseSchemaError',
        message: `Database "${process.env.DB_NAME}" is missing expected demo tables. Missing: ${dbSchema.missingTables.slice(0, 8).join(', ')}${dbSchema.missingTables.length > 8 ? ', ...' : ''}. Run npm run bootstrap-db for an empty local schema or load the demo seed data.`,
      });
      sseFrame(res, 'done', {});
      res.end();
      return;
    }

    // Debug runs always execute fresh (they want a live trace); everything else
    // can be served from the exact-match cache.
    const cacheable = !includeDebug;
    const cached = cacheable ? resultCache.get(question, dbSchema, rowLimit, includeInsights) : null;

    let payload;
    if (cached) {
      payload = cached;
    } else {
      const result = await runOptimizedQuestion({
        client: runtime.client,
        connection: runtime.connection,
        schema: runtime.schema,
        model: runtime.model,
        question,
        trace,
        includeInsights,
        rowLimit,
        statementTimeoutMs,
        signal: abortController.signal,
      });
      payload = publicResult(result, trace, includeDebug);
      if (cacheable) {
        resultCache.set(question, dbSchema, rowLimit, includeInsights, payload);
      }
    }

    // Same serializer as the blocking route. On a cache hit no stage/early-sql
    // frames were emitted (the pipeline never ran) — the result simply lands.
    streamResultFrames(res, payload, includeDebug, Boolean(cached));
  } catch (error) {
    sseFrame(res, 'error', toClientError(serializeError(error)));
  } finally {
    sseFrame(res, 'done', {});
    res.end();
  }
});

app.post('/api/insights', requireApiToken, rateLimit, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  // Bound the synchronous insight computation to the same row cap as the query
  // pipeline, so a large posted body (up to the 2mb JSON limit) cannot pin the
  // event loop with tens of thousands of rows of work per request.
  if (rows.length > rowLimit) {
    res.status(413).json({
      success: false,
      error: { name: 'PayloadTooLarge', message: `rows exceeds the ${rowLimit} row limit.` },
    });
    return;
  }
  const columns = Array.isArray(req.body?.columns) && req.body.columns.length > 0 ? req.body.columns : inferColumns(rows);
  res.json({
    insights: createResultInsights({
      question: String(req.body?.question || ''),
      rows,
      columns,
    }),
  });
});

if (fs.existsSync(indexPath)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }

    res.sendFile(indexPath);
  });
}

app.use((error, _req, res, _next) => {
  res.status(500).json({
    success: false,
    error: toClientError(serializeError(error)),
  });
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const server = app.listen(port, host, () => {
  console.log(`Text-to-SQL API listening on http://${host}:${port}`);
  // A non-loopback bind with no token silently exposes /api/query (LLM spend +
  // demo DB access) to the network. The default host is loopback, so this only
  // fires on an explicit, genuinely risky WEB_API_HOST.
  if (!apiToken && !LOOPBACK_HOSTS.has(host)) {
    console.warn(
      `[security] WEB_API_HOST is "${host}" (non-loopback) but WEB_API_TOKEN is unset: ` +
        '/api/query (LLM cost + demo DB access) is exposed with NO authentication. ' +
        'Set WEB_API_TOKEN before exposing this server on a shared network.'
    );
  }
});

async function shutdown() {
  server.close();
  if (runtimePromise) {
    try {
      const runtime = await runtimePromise;
      await runtime.close();
    } catch {
      // Runtime may have failed during startup; nothing to close.
    }
  }
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});
