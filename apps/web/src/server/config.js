// Web server configuration, read from an env object AFTER the .env file has been
// loaded (see main.js). Nothing in the server reads process.env at import time:
// ESM evaluates static imports before an entrypoint's `await loadEnvironment()`,
// so module-level reads silently ignored every setting that lived only in .env
// (including WEB_API_TOKEN, which left auth off).
//
// loadWebConfig is pure: it validates every value, reports ALL problems in one
// startup error, and returns a deeply frozen object.

import { isLoopbackHost, normalizeHostname } from './security.js';

export class WebConfigError extends Error {
  constructor(problems) {
    super(`Invalid web server configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'WebConfigError';
    this.code = 'INVALID_CONFIG';
    this.problems = problems;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function createReader(env, problems) {
  return {
    integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
      const raw = env[name];
      if (isBlank(raw)) {
        return fallback;
      }
      // Plain decimal digits only: Number() would also accept "0x50", "8e3",
      // "0b1" and "  " forms that nobody means as a port or a limit.
      const text = String(raw).trim();
      const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
      if (!Number.isInteger(value) || value < min || value > max) {
        problems.push(`${name} must be an integer between ${min} and ${max}; got "${raw}".`);
        return fallback;
      }
      return value;
    },
    boolean(name, fallback) {
      const raw = env[name];
      if (isBlank(raw)) {
        return fallback;
      }
      const normalized = String(raw).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
      problems.push(`${name} must be a boolean (1/0, true/false, yes/no, on/off); got "${raw}".`);
      return fallback;
    },
    string(name, fallback = '') {
      const raw = env[name];
      return isBlank(raw) ? fallback : String(raw).trim();
    },
    list(name) {
      return String(env[name] || '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
  };
}

function normalizeOrigin(value, problems) {
  try {
    const url = new URL(value);
    const hasExtras = (url.pathname && url.pathname !== '/') || url.search || url.hash || url.username || url.password;
    if (!['http:', 'https:'].includes(url.protocol) || hasExtras) {
      throw new Error('not an origin');
    }
    // Normalized the way browsers send Origin (lowercase host, no default port).
    return url.origin;
  } catch {
    problems.push(`WEB_ALLOWED_ORIGINS entries must be origins like http://localhost:5173 (scheme://host[:port], no path); got "${value}".`);
    return null;
  }
}

function defaultOrigins(ports) {
  const origins = [];
  for (const port of ports) {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      origins.push(`http://${hostname}:${port}`);
    }
  }
  return origins;
}

export const DEFAULT_WEB_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  frontendPort: 5173,
  maxQuestionLength: 2000,
  rowLimit: 1000,
  statementTimeoutMs: 8000,
  maxRetries: 1,
  requestTimeoutMs: 120_000,
  dbConnectionLimit: 5,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 30,
  resultCacheSize: 200,
  resultCacheTtlMs: 15 * 60 * 1000,
  shutdownTimeoutMs: 10_000,
  openAiTimeoutMs: 60_000,
  openAiMaxRetries: 1,
  model: 'gpt-4o-mini',
});

export function loadWebConfig(env = process.env) {
  const problems = [];
  const read = createReader(env, problems);
  const defaults = DEFAULT_WEB_CONFIG;

  const host = read.string('WEB_API_HOST', defaults.host);
  // 0 asks the OS for a free port (tests); the bound port is logged at startup.
  const port = read.integer('WEB_API_PORT', defaults.port, { min: 0, max: 65535 });
  const frontendPort = isBlank(env.WEB_FRONTEND_PORT)
    ? read.integer('VITE_PORT', defaults.frontendPort, { min: 1, max: 65535 })
    : read.integer('WEB_FRONTEND_PORT', defaults.frontendPort, { min: 1, max: 65535 });
  const loopback = isLoopbackHost(host);

  // Optional bearer-token auth. Empty (the default) leaves the API open for local use.
  const apiToken = String(env.WEB_API_TOKEN || '');

  const configuredOrigins = read.list('WEB_ALLOWED_ORIGINS').map((origin) => normalizeOrigin(origin, problems)).filter(Boolean);
  const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : defaultOrigins([frontendPort, port || defaults.port]);

  // Host-header allowlist (DNS-rebinding protection). Loopback names are always
  // accepted; WEB_ALLOWED_HOSTS adds hostnames (ports are ignored; a leading
  // dot, e.g. ".example.test", also matches subdomains).
  const allowedHosts = [];
  for (const entry of read.list('WEB_ALLOWED_HOSTS')) {
    const normalized = entry.startsWith('.') ? `.${normalizeHostname(entry.slice(1)) || ''}` : normalizeHostname(entry);
    if (!normalized || normalized === '.') {
      problems.push(`WEB_ALLOWED_HOSTS entries must be hostnames; got "${entry}".`);
      continue;
    }
    allowedHosts.push(normalized);
  }
  // Enforced whenever the server is bound to loopback (the default) or an
  // allowlist is configured. A non-loopback bind without WEB_ALLOWED_HOSTS
  // cannot know its public names, so it is not checked (main.js warns).
  const hostCheck = loopback || allowedHosts.length > 0;

  // Debug payloads (prompts, raw model output, stack traces) are opt-in per
  // request, but only honored when the server allows them: by default only on a
  // loopback bind.
  const allowDebug = read.boolean('WEB_ALLOW_DEBUG', loopback);

  const maxQuestionLength = read.integer('WEB_MAX_QUESTION_LENGTH', defaults.maxQuestionLength, { min: 1, max: 100_000 });
  const rowLimit = read.integer('WEB_QUERY_ROW_LIMIT', defaults.rowLimit, { min: 1, max: 100_000 });
  // Statement timeout for model-authored SQL (ms; 0 disables). The web-specific
  // value wins; otherwise the shared QUERY_STATEMENT_TIMEOUT_MS used by the CLI.
  const statementTimeoutMs = isBlank(env.WEB_QUERY_STATEMENT_TIMEOUT_MS)
    ? read.integer('QUERY_STATEMENT_TIMEOUT_MS', defaults.statementTimeoutMs, { min: 0 })
    : read.integer('WEB_QUERY_STATEMENT_TIMEOUT_MS', defaults.statementTimeoutMs, { min: 0 });
  const maxRetries = read.integer('WEB_QUERY_MAX_RETRIES', defaults.maxRetries, { min: 0, max: 5 });
  // Per-request deadline (ms; 0 disables): aborts the LLM call and kills the
  // running query when exceeded.
  const requestTimeoutMs = read.integer('WEB_REQUEST_TIMEOUT_MS', defaults.requestTimeoutMs, { min: 0 });
  const dbConnectionLimit = read.integer('WEB_DB_CONNECTION_LIMIT', defaults.dbConnectionLimit, { min: 1, max: 100 });

  const rateLimitWindowMs = read.integer('WEB_RATE_LIMIT_WINDOW_MS', defaults.rateLimitWindowMs, { min: 1 });
  // 0 disables rate limiting.
  const rateLimitMax = read.integer('WEB_RATE_LIMIT_MAX', defaults.rateLimitMax, { min: 0 });

  const resultCacheEnabled = read.boolean('WEB_RESULT_CACHE', true);
  // 0 entries or a 0 ms TTL disables the cache, like WEB_RESULT_CACHE=0.
  const resultCacheSize = read.integer('WEB_RESULT_CACHE_SIZE', defaults.resultCacheSize, { min: 0 });
  const resultCacheTtlMs = read.integer('WEB_RESULT_CACHE_TTL_MS', defaults.resultCacheTtlMs, { min: 0 });

  const shutdownTimeoutMs = read.integer('WEB_SHUTDOWN_TIMEOUT_MS', defaults.shutdownTimeoutMs, { min: 0 });
  const openAiTimeoutMs = read.integer('OPENAI_TIMEOUT_MS', defaults.openAiTimeoutMs, { min: 1, max: 600_000 });
  const openAiMaxRetries = read.integer('OPENAI_MAX_RETRIES', defaults.openAiMaxRetries, { min: 0, max: 10 });

  if (problems.length > 0) {
    throw new WebConfigError(problems);
  }

  // A retired runtime (after an admin schema refresh) is closed once its last
  // request finishes, or after this grace period, which outlasts the request
  // deadline so a slow request is never cut off by a refresh. Without a
  // deadline (WEB_REQUEST_TIMEOUT_MS=0) a request may legitimately run for as
  // long as it needs, so there is no forced close (null): the old runtime waits
  // for its last request. Shutdown still closes it after the
  // WEB_SHUTDOWN_TIMEOUT_MS drain.
  const runtimeRetireGraceMs = requestTimeoutMs > 0 ? requestTimeoutMs + 30_000 : null;

  return deepFreeze({
    host,
    port,
    frontendPort,
    loopback,
    apiToken,
    authEnabled: apiToken.length > 0,
    allowedOrigins,
    allowedHosts,
    hostCheck,
    allowDebug,
    maxQuestionLength,
    rowLimit,
    statementTimeoutMs,
    maxRetries,
    requestTimeoutMs,
    dbConnectionLimit,
    rateLimit: { windowMs: rateLimitWindowMs, max: rateLimitMax },
    resultCache: {
      enabled: resultCacheEnabled && resultCacheSize > 0 && resultCacheTtlMs > 0,
      maxEntries: resultCacheSize,
      ttlMs: resultCacheTtlMs,
    },
    shutdownTimeoutMs,
    runtimeRetireGraceMs,
    openAi: {
      configured: Boolean(env.OPENAI_API_KEY),
      timeoutMs: openAiTimeoutMs,
      maxRetries: openAiMaxRetries,
    },
    model: read.string('MODEL_NAME', defaults.model),
    database: {
      name: read.string('DB_NAME', '') || null,
      // The query paths connect as DB_USER, defaulting to demo_readonly.
      user: read.string('DB_USER', '') || 'demo_readonly',
      configured: !isBlank(env.DB_NAME),
    },
  });
}

// One redacted line for the startup log: what is actually in effect.
export function describeWebConfig(config) {
  const origins = config.allowedOrigins.join(',');
  const hosts = config.hostCheck ? ['localhost', '127.0.0.1', '[::1]', ...config.allowedHosts].join(',') : 'unchecked';
  return [
    `auth=${config.authEnabled ? 'on' : 'off'}`,
    `debug=${config.allowDebug ? 'allowed' : 'denied'}`,
    `hosts=${hosts}`,
    `origins=${origins}`,
    `rateLimit=${config.rateLimit.max > 0 ? `${config.rateLimit.max}/${config.rateLimit.windowMs}ms` : 'off'}`,
    `stmtTimeout=${config.statementTimeoutMs}ms`,
    `requestTimeout=${config.requestTimeoutMs}ms`,
    `rowLimit=${config.rowLimit}`,
    `maxQuestionLength=${config.maxQuestionLength}`,
    `cache=${config.resultCache.enabled ? 'on' : 'off'}`,
  ].join(' ');
}
