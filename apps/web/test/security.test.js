import assert from 'node:assert/strict';
import test from 'node:test';

import { createRateLimiter, extractBearerToken, isAuthorized, toClientError } from '../src/server/security.js';

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
