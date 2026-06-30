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

const MAX_ENTRIES = Number(process.env.WEB_RESULT_CACHE_SIZE) || 200;
const TTL_MS = Number.isFinite(Number(process.env.WEB_RESULT_CACHE_TTL_MS))
  ? Number(process.env.WEB_RESULT_CACHE_TTL_MS)
  : 15 * 60 * 1000;
const ENABLED = process.env.WEB_RESULT_CACHE !== '0';

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
// the DB user/database separation, which remains the real boundary).
function isDemoSource() {
  return process.env.DB_NAME === 'demo_retail' && process.env.DB_USER === 'demo_readonly';
}

export class ResultCache {
  #map = new Map(); // insertion-ordered -> cheap LRU

  #key(question, dbSchema, rowLimit, includeInsights) {
    return `${normalizeQuestion(question)}::${schemaVersion(dbSchema)}::${rowLimit}::${includeInsights ? 1 : 0}`;
  }

  get(question, dbSchema, rowLimit, includeInsights, now = Date.now()) {
    if (!ENABLED) {
      return null;
    }
    const key = this.#key(question, dbSchema, rowLimit, includeInsights);
    const hit = this.#map.get(key);
    if (!hit) {
      return null;
    }
    if (now - hit.at > TTL_MS) {
      this.#map.delete(key);
      return null;
    }
    // Bump recency (LRU).
    this.#map.delete(key);
    this.#map.set(key, hit);
    return hit.payload;
  }

  set(question, dbSchema, rowLimit, includeInsights, payload, now = Date.now()) {
    if (!ENABLED) {
      return;
    }
    if (!payload || payload.success !== true) {
      return; // never cache failures
    }
    if (!isDemoSource()) {
      return; // demo_retail + demo_readonly only — never cache real/ERP data
    }
    const key = this.#key(question, dbSchema, rowLimit, includeInsights);
    this.#map.set(key, { payload, at: now });
    while (this.#map.size > MAX_ENTRIES) {
      this.#map.delete(this.#map.keys().next().value);
    }
  }

  clear() {
    this.#map.clear();
  }

  get size() {
    return this.#map.size;
  }
}

export const resultCache = new ResultCache();
