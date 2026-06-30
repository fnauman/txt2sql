import crypto from 'node:crypto';

// Pure security helpers, kept out of index.js so they can be unit-tested without
// starting an HTTP server.

// Strip internal detail (notably stack traces) from an error before it is sent
// to the browser. Full detail still goes to the debug trace when debug is on.
export function toClientError(error) {
  if (!error) {
    return null;
  }

  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message =
    typeof error.message === 'string' && error.message ? error.message : 'The request could not be completed.';
  const code = error.code === undefined ? null : error.code;
  return { name, message, code };
}

// Fixed-window in-memory rate limiter. `now` is injected so it is deterministic
// in tests. max <= 0 disables limiting. Suitable for a single-process,
// loopback-default dev/internal server (not a distributed deployment).
//
// `maxKeys` bounds memory: keys seen exactly once (e.g. rotating spoofed source
// IPs in a probe) would otherwise accumulate forever, since a window only resets
// when the SAME key is seen again. When the map exceeds the cap we sweep expired
// entries before inserting a new one.
export function createRateLimiter({ windowMs = 60_000, max = 30, maxKeys = 10_000 } = {}) {
  const hits = new Map();

  function pruneExpired(now) {
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) {
        hits.delete(key);
      }
    }
  }

  function check(key, now) {
    if (!Number.isFinite(max) || max <= 0) {
      return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    }

    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      if (hits.size >= maxKeys) {
        pruneExpired(now);
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
    }

    if (entry.count >= max) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
    }

    entry.count += 1;
    return { allowed: true, remaining: max - entry.count, retryAfterMs: 0 };
  }

  return {
    check,
    size: () => hits.size,
    reset() {
      hits.clear();
    },
  };
}

export function extractBearerToken(authorizationHeader) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || '').trim());
  return match ? match[1].trim() : null;
}

// HMAC both sides to a fixed-length digest before comparing, so the comparison
// takes the same work regardless of input length. A plain length check + compare
// would leak the configured token's length through timing (a length oracle). The
// HMAC key is a fixed zero key — secrecy comes from the token itself, not the key.
const TIMING_SAFE_KEY = Buffer.alloc(32);

function timingSafeEqualString(left, right) {
  const leftDigest = crypto.createHmac('sha256', TIMING_SAFE_KEY).update(String(left)).digest();
  const rightDigest = crypto.createHmac('sha256', TIMING_SAFE_KEY).update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

// Auth is opt-in: with no configured token the server is open (preserving the
// local dev experience). When WEB_API_TOKEN is set, a matching bearer token (or
// x-api-token header) is required.
export function isAuthorized(req, configuredToken) {
  if (!configuredToken) {
    return true;
  }

  const provided = extractBearerToken(req?.headers?.authorization) || req?.headers?.['x-api-token'] || '';
  return provided.length > 0 && timingSafeEqualString(provided, configuredToken);
}
