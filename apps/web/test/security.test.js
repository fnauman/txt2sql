import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SECURITY_HEADERS,
  createHostGuard,
  createOriginGuard,
  createRateLimiter,
  extractBearerToken,
  isAuthorized,
  isHostAllowed,
  isLoopbackHost,
  isOriginAllowed,
  normalizeHostname,
  securityHeaders,
  toClientError,
} from '../src/server/security.js';

test('toClientError strips stack traces and internal detail', () => {
  assert.equal(toClientError(null), null);
  const sanitized = toClientError({ name: 'DbError', message: 'boom', code: 'ER_X', stack: 'secret stack' });
  assert.deepEqual(sanitized, { name: 'DbError', message: 'boom', code: 'ER_X' });
  assert.ok(!('stack' in sanitized));
});

test('toClientError fills safe defaults for empty errors', () => {
  const sanitized = toClientError({});
  assert.equal(sanitized.name, 'Error');
  assert.ok(sanitized.message.length > 0);
  assert.equal(sanitized.code, null);
});

test('createRateLimiter allows up to max then blocks within the window', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.check('ip-a', 0).allowed, true);
  assert.equal(limiter.check('ip-a', 100).allowed, true);
  const blocked = limiter.check('ip-a', 200);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
});

test('createRateLimiter resets after the window and isolates keys', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('ip-a', 0).allowed, true);
  assert.equal(limiter.check('ip-a', 500).allowed, false);
  assert.equal(limiter.check('ip-a', 1000).allowed, true); // window rolled over
  assert.equal(limiter.check('ip-b', 500).allowed, true); // independent key
});

test('createRateLimiter with max <= 0 disables limiting', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 0 });
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.check('ip-a', i).allowed, true);
  }
});

test('createRateLimiter prunes expired entries so memory stays bounded', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 5, maxKeys: 3 });
  // Three single-use keys fill the map to the cap.
  limiter.check('a', 0);
  limiter.check('b', 0);
  limiter.check('c', 0);
  assert.equal(limiter.size(), 3);
  // A new distinct key after the window expires triggers a sweep of a/b/c.
  limiter.check('d', 2000);
  assert.equal(limiter.size(), 1);
});

test('extractBearerToken parses only well-formed Authorization headers', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('Basic abc123'), null);
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('isAuthorized is open when no token is configured', () => {
  assert.equal(isAuthorized({ headers: {} }, ''), true);
});

test('isAuthorized enforces a configured token via bearer or x-api-token', () => {
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer secret' } }, 'secret'), true);
  assert.equal(isAuthorized({ headers: { 'x-api-token': 'secret' } }, 'secret'), true);
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer wrong' } }, 'secret'), false);
  assert.equal(isAuthorized({ headers: {} }, 'secret'), false);
});

test('toClientError adds the failure stage only when one is known', () => {
  assert.deepEqual(toClientError({ name: 'Error', message: 'x', code: 'LLM_TRUNCATED' }, { stage: 'llm' }), {
    name: 'Error',
    message: 'x',
    code: 'LLM_TRUNCATED',
    stage: 'llm',
  });
  assert.ok(!('stage' in toClientError({ message: 'x' })));
});

test('toClientError keeps a known validation layer and drops anything else', () => {
  assert.deepEqual(
    toClientError({ name: 'SqlValidationError', message: 'x', code: 'FAN_OUT', layer: 'guardrail', stack: 's' }, { stage: 'validation' }),
    { name: 'SqlValidationError', message: 'x', code: 'FAN_OUT', stage: 'validation', layer: 'guardrail' }
  );
  assert.equal(toClientError({ message: 'x', layer: 'safety' }).layer, 'safety');
  assert.ok(!('layer' in toClientError({ message: 'x', layer: 'internal' })));
  assert.ok(!('layer' in toClientError({ message: 'x' })));
});

test('normalizeHostname strips ports and IPv6 brackets', () => {
  assert.equal(normalizeHostname('LocalHost:8787'), 'localhost');
  assert.equal(normalizeHostname('[::1]:8787'), '::1');
  assert.equal(normalizeHostname('::1'), '::1');
  assert.equal(normalizeHostname('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeHostname(''), null);
  assert.equal(normalizeHostname('bad host:1'), null);
});

test('normalizeHostname rejects userinfo, paths and escapes that a URL parser would reinterpret', () => {
  // `new URL()` reads "evil.com@localhost" as userinfo + localhost; browsers
  // never send such a Host, so it is refused rather than normalized.
  for (const host of ['evil.com@localhost', 'evil.com@localhost:8787', 'local%68ost', 'localhost/x', 'localhost#x', 'localhost?x', 'local\\host']) {
    assert.equal(normalizeHostname(host), null, host);
    assert.equal(isHostAllowed(host), false, host);
  }
});

test('isLoopbackHost recognizes localhost, 127.0.0.0/8 and ::1 only', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]:8787', '[::ffff:7f00:1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.test', 'localhost.example.test', '', '[::ffff:10.0.0.1]', 'evil.com@localhost']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('isHostAllowed blocks rebinding hostnames but keeps loopback and allowlisted names', () => {
  assert.equal(isHostAllowed('localhost:5173'), true);
  assert.equal(isHostAllowed('127.0.0.1:8787'), true);
  assert.equal(isHostAllowed('[::1]:8787'), true);
  assert.equal(isHostAllowed('attacker.example:8787'), false);
  assert.equal(isHostAllowed(undefined), false);
  assert.equal(isHostAllowed('demo.test:8787', ['demo.test']), true);
  assert.equal(isHostAllowed('a.internal.test', ['.internal.test']), true);
  assert.equal(isHostAllowed('internal.test', ['.internal.test']), true);
  assert.equal(isHostAllowed('evilinternal.test', ['.internal.test']), false);
});

test('isOriginAllowed accepts listed origins and the server\'s own origin only', () => {
  const allowedOrigins = new Set(['http://localhost:5173']);
  assert.equal(isOriginAllowed(undefined, { allowedOrigins, hostHeader: 'x' }), true, 'non-browser clients send no Origin');
  assert.equal(isOriginAllowed('http://localhost:5173', { allowedOrigins, hostHeader: '127.0.0.1:8787' }), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:8787', { allowedOrigins, hostHeader: '127.0.0.1:8787' }), true, 'same-origin');
  assert.equal(isOriginAllowed('http://evil.example', { allowedOrigins, hostHeader: '127.0.0.1:8787' }), false);
  assert.equal(isOriginAllowed('null', { allowedOrigins, hostHeader: '127.0.0.1:8787' }), false);
});

test('isOriginAllowed drops the same-origin exemption when the Host header is not validated', () => {
  const allowedOrigins = new Set(['https://app.example.test']);
  // DNS-rebinding shape: the attacker controls both names, so they match.
  const rebinding = { allowedOrigins, hostHeader: 'evil.example:8787', trustHostHeader: false };
  assert.equal(isOriginAllowed('http://evil.example:8787', rebinding), false);
  assert.equal(isOriginAllowed('https://app.example.test', rebinding), true, 'listed origins still pass');
  assert.equal(isOriginAllowed(undefined, rebinding), true, 'non-browser clients send no Origin');
});

function fakeResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(body) {
      response.body = body;
      return response;
    },
    set(headers) {
      Object.assign(response.headers, headers);
      return response;
    },
  };
  return response;
}

test('createHostGuard rejects foreign Host headers with 403 when enabled', () => {
  const guard = createHostGuard({ enabled: true, allowedHosts: [] });
  const blocked = fakeResponse();
  let nextCalled = false;
  guard({ headers: { host: 'attacker.example:8787' } }, blocked, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.error.code, 'HOST_NOT_ALLOWED');

  let passed = false;
  createHostGuard({ enabled: false })({ headers: { host: 'attacker.example' } }, fakeResponse(), () => {
    passed = true;
  });
  assert.equal(passed, true, 'disabled guard lets everything through');
});

test('createOriginGuard rejects disallowed origins with 403 instead of omitting CORS headers', () => {
  const guard = createOriginGuard({ allowedOrigins: ['http://localhost:5173'] });
  const blocked = fakeResponse();
  guard({ headers: { host: '127.0.0.1:8787', origin: 'http://evil.example' } }, blocked, () => assert.fail('must not pass'));
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.error.code, 'ORIGIN_NOT_ALLOWED');

  const untrustedHost = createOriginGuard({ allowedOrigins: ['http://localhost:5173'], sameOriginAllowed: false });
  const sameNames = fakeResponse();
  untrustedHost({ headers: { host: 'evil.example:8787', origin: 'http://evil.example:8787' } }, sameNames, () =>
    assert.fail('a matching Host/Origin pair must not pass when the Host is unchecked')
  );
  assert.equal(sameNames.statusCode, 403);
});

test('securityHeaders sets the baseline hardening headers', () => {
  const response = fakeResponse();
  securityHeaders({}, response, () => {});
  assert.deepEqual(response.headers, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  assert.ok(Object.isFrozen(SECURITY_HEADERS));
});
