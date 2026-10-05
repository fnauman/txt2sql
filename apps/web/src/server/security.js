import crypto from 'node:crypto';

// Pure security helpers, kept out of index.js so they can be unit-tested without
// starting an HTTP server.

// Strip internal detail (notably stack traces) from an error before it is sent
// to the browser. Full detail still goes to the debug trace when debug is on.
// `stage` (optional) says where a query failed: 'llm' | 'validation' |
// 'execution' | 'aborted' | 'infra'. It is added only when known, so plain
// HTTP-level errors keep the { name, message, code } shape.
export function toClientError(error, { stage = null } = {}) {
  if (!error) {
    return null;
  }

  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message =
    typeof error.message === 'string' && error.message ? error.message : 'The request could not be completed.';
  const code = error.code === undefined ? null : error.code;
  const clientError = stage ? { name, message, code, stage } : { name, message, code };
  // Which validator layer rejected the SQL ('safety' or 'guardrail'); the
  // client classifies its message on this instead of on the message text.
  if (error.layer === 'safety' || error.layer === 'guardrail') {
    clientError.layer = error.layer;
  }
  return clientError;
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

// --- Host / Origin checks ---------------------------------------------------
// DNS rebinding: a malicious page re-points its own hostname at 127.0.0.1, so
// the browser treats requests to this server as same-origin (CORS does not
// apply). Only the Host header gives it away. When the server is bound to
// loopback, any Host other than localhost / 127.0.0.1 / [::1] (or an explicitly
// allowed name) is rejected.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1']);

// Characters that never appear in a real host[:port] but change how a URL
// parser reads it: `evil.com@localhost` would otherwise parse as userinfo +
// "localhost", and percent-escapes are decoded inside the hostname.
const NON_HOST_CHARACTERS = /[@/\\?#%\s]/;

// Lowercase hostname without port or IPv6 brackets; null when unparseable.
export function normalizeHostname(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || NON_HOST_CHARACTERS.test(raw)) {
    return null;
  }

  try {
    const hostname = new URL(`http://${raw}`).hostname;
    return hostname.replace(/^\[(.*)\]$/, '$1') || null;
  } catch {
    // A bare IPv6 address (no brackets, no port) is not a valid URL authority;
    // bracket it so it is normalized the same way (e.g. ::ffff:127.0.0.1).
    if (!/^[0-9a-f:.]+$/.test(raw) || !raw.includes(':')) {
      return null;
    }
    try {
      return new URL(`http://[${raw}]`).hostname.replace(/^\[(.*)\]$/, '$1') || null;
    } catch {
      return null;
    }
  }
}

export function isLoopbackHost(host) {
  const hostname = normalizeHostname(host);
  if (!hostname) {
    return false;
  }
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    // IPv4-mapped loopback: the URL parser normalizes [::ffff:127.0.0.1] to
    // ::ffff:7f00:1 (any 127.x.y.z maps to ::ffff:7fxx:xxxx).
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(hostname)
  );
}

export function isHostAllowed(hostHeader, allowedHosts = []) {
  const hostname = normalizeHostname(hostHeader);
  if (!hostname) {
    return false;
  }
  if (isLoopbackHost(hostname)) {
    return true;
  }
  return allowedHosts.some((allowed) =>
    allowed.startsWith('.') ? hostname === allowed.slice(1) || hostname.endsWith(allowed) : hostname === allowed
  );
}

// An Origin is accepted when it is listed, or when it is this server's own
// origin (browsers send Origin on same-origin POSTs). The same-origin case is
// only safe when the Host header itself has been validated (`trustHostHeader`):
// otherwise a DNS-rebinding page sends a matching Host and Origin for its own
// name, and the comparison would wave it through.
export function isOriginAllowed(origin, { allowedOrigins, hostHeader, trustHostHeader = true }) {
  if (!origin) {
    return true;
  }

  const allowed = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);
  if (allowed.has(origin)) {
    return true;
  }

  if (!trustHostHeader) {
    return false;
  }

  try {
    const url = new URL(origin);
    return Boolean(hostHeader) && ['http:', 'https:'].includes(url.protocol) && url.host === String(hostHeader).trim().toLowerCase();
  } catch {
    return false; // includes the opaque "null" origin
  }
}

function sendForbidden(res, code, message) {
  res.status(403).json({ error: { name: 'Forbidden', message, code } });
}

export function createHostGuard({ enabled, allowedHosts = [] }) {
  return function hostGuard(req, res, next) {
    if (!enabled || isHostAllowed(req.headers.host, allowedHosts)) {
      next();
      return;
    }
    sendForbidden(
      res,
      'HOST_NOT_ALLOWED',
      'Forbidden: this server only answers requests addressed to localhost. Add the hostname to WEB_ALLOWED_HOSTS to allow it.'
    );
  };
}

// Applied to /api routes: a cross-origin browser request from an origin that is
// not allowed is rejected outright instead of merely missing CORS headers.
// `sameOriginAllowed` must only be true when the host guard is enforced.
export function createOriginGuard({ allowedOrigins, sameOriginAllowed = true }) {
  const allowed = new Set(allowedOrigins);
  return function originGuard(req, res, next) {
    if (
      isOriginAllowed(req.headers.origin, {
        allowedOrigins: allowed,
        hostHeader: req.headers.host,
        trustHostHeader: sameOriginAllowed,
      })
    ) {
      next();
      return;
    }
    sendForbidden(res, 'ORIGIN_NOT_ALLOWED', 'Forbidden: requests from this origin are not allowed. Add it to WEB_ALLOWED_ORIGINS.');
  };
}

// Baseline response hardening for both the API and the built SPA. No CSP here:
// the SPA's charts set inline styles, and these headers alone already block
// MIME sniffing, framing (clickjacking), referrer leaks and cross-origin
// embedding of API responses.
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

export function securityHeaders(_req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}
