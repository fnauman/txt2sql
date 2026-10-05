// Exact-match NL->result cache.
//
// The expensive step in this pipeline is NL->SQL generation (one 1-3s LLM call),
// NOT execution (ms over <=1000 demo rows). So we cache the FULL assembled
// publicResult payload keyed on the normalized question (+ schema version, row
// limit, insights flag). Example chips and recents are replayed verbatim and
// otherwise re-pay the LLM cost every time; with this they return in ~0ms.
//
// SECURITY: the MariaDB instance may also host sensitive non-demo databases. This cache stores
// full row payloads in process memory and replays them, so it refuses to store
// anything unless the source is the synthetic demo_retail DB AND the SELECT-only
// demo_readonly user. Default-deny. It is also single-process / single-tenant —
// the key has no per-user component, which is fine only because the demo is not
// multi-user. (Add an identity component before introducing auth/multi-tenancy.)
//
// Settings come from loadWebConfig() (WEB_RESULT_CACHE, WEB_RESULT_CACHE_SIZE,
// WEB_RESULT_CACHE_TTL_MS) via the constructor; nothing is read from
// process.env at import time, so values set only in .env are honored.

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function normalizeQuestion(question) {
  return String(question || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Folds the schema-drift signal getDatabaseSchema already computes so any schema
// change invalidates every cached entry automatically. NOTE: table-presence only
// — column-level drift (added/removed/retyped columns) is not detected here and
// relies on the TTL to bound staleness.
export function schemaVersion(dbSchema) {
  const actual = dbSchema?.actualTables?.length ?? 0;
  const missing = [...(dbSchema?.missingTables ?? [])].sort().join(',');
  return `${actual}:${missing}`;
}

// Only synthetic demo data may be retained/replayed (defense in depth on top of
// the DB user/database separation, which remains the real boundary). The
// default reads the env at call time; the web app injects its loaded config.
export function isDemoSourceEnv(env = process.env) {
  return env.DB_NAME === 'demo_retail' && env.DB_USER === 'demo_readonly';
}

export class ResultCache {
  #map = new Map(); // insertion-ordered -> cheap LRU
  #enabled;
  #maxEntries;
  #ttlMs;
  #isDemoSource;
  // Bumped by clear(). A request that started before a clear (e.g. an admin
  // schema refresh) passes the generation it saw to set(), so its now-stale
  // result is not written back after the clear.
  #generation = 0;

  constructor({ enabled = true, maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS, isDemoSource = () => isDemoSourceEnv() } = {}) {
    this.#maxEntries = Number.isInteger(maxEntries) && maxEntries >= 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
    this.#ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
    this.#enabled = Boolean(enabled) && this.#maxEntries > 0;
    this.#isDemoSource = isDemoSource;
  }

  #key(question, dbSchema, rowLimit, includeInsights) {
    return `${normalizeQuestion(question)}::${schemaVersion(dbSchema)}::${rowLimit}::${includeInsights ? 1 : 0}`;
  }

  get enabled() {
    return this.#enabled;
  }

  get generation() {
    return this.#generation;
  }

  get(question, dbSchema, rowLimit, includeInsights, now = Date.now()) {
    if (!this.#enabled) {
      return null;
    }
    const key = this.#key(question, dbSchema, rowLimit, includeInsights);
    const hit = this.#map.get(key);
    if (!hit) {
      return null;
    }
    if (now - hit.at > this.#ttlMs) {
      this.#map.delete(key);
      return null;
    }
    // Bump recency (LRU).
    this.#map.delete(key);
    this.#map.set(key, hit);
    return hit.payload;
  }

  set(question, dbSchema, rowLimit, includeInsights, payload, now = Date.now(), { generation = this.#generation } = {}) {
    if (!this.#enabled) {
      return;
    }
    if (!payload || payload.success !== true) {
      return; // never cache failures
    }
    if (generation !== this.#generation) {
      return; // computed before the last clear() — stale
    }
    if (!this.#isDemoSource()) {
      return; // demo_retail + demo_readonly only — never cache real/ERP data
    }
    const key = this.#key(question, dbSchema, rowLimit, includeInsights);
    this.#map.set(key, { payload, at: now });
    while (this.#map.size > this.#maxEntries) {
      this.#map.delete(this.#map.keys().next().value);
    }
  }

  clear() {
    this.#map.clear();
    this.#generation += 1;
  }

  get size() {
    return this.#map.size;
  }
}
