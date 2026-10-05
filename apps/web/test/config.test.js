import assert from 'node:assert/strict';
import test from 'node:test';

import { WebConfigError, describeWebConfig, loadWebConfig } from '../src/server/config.js';

test('loadWebConfig returns validated defaults for an empty environment', () => {
  const config = loadWebConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.frontendPort, 5173);
  assert.equal(config.loopback, true);
  assert.equal(config.apiToken, '');
  assert.equal(config.authEnabled, false);
  assert.equal(config.maxQuestionLength, 2000);
  assert.equal(config.rowLimit, 1000);
  assert.equal(config.statementTimeoutMs, 8000);
  assert.equal(config.maxRetries, 1);
  assert.equal(config.requestTimeoutMs, 120_000);
  assert.deepEqual(config.rateLimit, { windowMs: 60_000, max: 30 });
  assert.deepEqual(config.resultCache, { enabled: true, maxEntries: 200, ttlMs: 15 * 60 * 1000 });
  assert.equal(config.hostCheck, true);
  assert.equal(config.allowDebug, true, 'debug is allowed by default on a loopback bind');
  assert.deepEqual(config.openAi, { configured: false, timeoutMs: 60_000, maxRetries: 1 });
  assert.equal(config.database.user, 'demo_readonly');
  assert.equal(config.database.configured, false);
  assert.ok(config.allowedOrigins.includes('http://localhost:5173'));
  assert.ok(config.allowedOrigins.includes('http://127.0.0.1:8787'));
  assert.ok(config.allowedOrigins.includes('http://[::1]:8787'));
  assert.ok(config.runtimeRetireGraceMs > config.requestTimeoutMs);
});

test('loadWebConfig reads every WEB_* setting from the env object it is given', () => {
  const config = loadWebConfig({
    WEB_API_HOST: '0.0.0.0',
    WEB_API_PORT: '9100',
    WEB_FRONTEND_PORT: '5200',
    WEB_API_TOKEN: 'secret-token',
    WEB_ALLOWED_ORIGINS: 'https://app.example.test, http://localhost:5200',
    WEB_ALLOWED_HOSTS: 'app.example.test,.internal.test:9100',
    WEB_ALLOW_DEBUG: 'yes',
    WEB_MAX_QUESTION_LENGTH: '10',
    WEB_QUERY_ROW_LIMIT: '50',
    WEB_QUERY_STATEMENT_TIMEOUT_MS: '0',
    QUERY_STATEMENT_TIMEOUT_MS: '3000',
    WEB_QUERY_MAX_RETRIES: '2',
    WEB_REQUEST_TIMEOUT_MS: '5000',
    WEB_DB_CONNECTION_LIMIT: '9',
    WEB_RATE_LIMIT_WINDOW_MS: '1000',
    WEB_RATE_LIMIT_MAX: '1',
    WEB_RESULT_CACHE: '0',
    WEB_RESULT_CACHE_SIZE: '5',
    WEB_RESULT_CACHE_TTL_MS: '100',
    WEB_SHUTDOWN_TIMEOUT_MS: '2500',
    OPENAI_API_KEY: 'sk-x',
    OPENAI_TIMEOUT_MS: '30000',
    OPENAI_MAX_RETRIES: '0',
    MODEL_NAME: 'gpt-test',
    DB_NAME: 'demo_retail',
    DB_USER: 'reader',
  });

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9100);
  assert.equal(config.frontendPort, 5200);
  assert.equal(config.loopback, false);
  assert.equal(config.authEnabled, true);
  assert.deepEqual(config.allowedOrigins, ['https://app.example.test', 'http://localhost:5200']);
  assert.deepEqual(config.allowedHosts, ['app.example.test', '.internal.test']);
  assert.equal(config.hostCheck, true);
  assert.equal(config.allowDebug, true);
  assert.equal(config.maxQuestionLength, 10);
  assert.equal(config.rowLimit, 50);
  assert.equal(config.statementTimeoutMs, 0, 'the WEB_ value wins, and 0 disables');
  assert.equal(config.maxRetries, 2);
  assert.equal(config.requestTimeoutMs, 5000);
  assert.equal(config.runtimeRetireGraceMs, 35_000);
  assert.equal(config.dbConnectionLimit, 9);
  assert.deepEqual(config.rateLimit, { windowMs: 1000, max: 1 });
  assert.deepEqual(config.resultCache, { enabled: false, maxEntries: 5, ttlMs: 100 });
  assert.equal(config.shutdownTimeoutMs, 2500);
  assert.deepEqual(config.openAi, { configured: true, timeoutMs: 30_000, maxRetries: 0 });
  assert.equal(config.model, 'gpt-test');
  assert.deepEqual(config.database, { name: 'demo_retail', user: 'reader', configured: true });
});

test('the shared QUERY_STATEMENT_TIMEOUT_MS applies when no web-specific value is set', () => {
  assert.equal(loadWebConfig({ QUERY_STATEMENT_TIMEOUT_MS: '3000' }).statementTimeoutMs, 3000);
  assert.equal(loadWebConfig({ VITE_PORT: '5300' }).frontendPort, 5300);
});

test('debug defaults to denied on a non-loopback bind, and WEB_ALLOW_DEBUG overrides either way', () => {
  assert.equal(loadWebConfig({ WEB_API_HOST: '0.0.0.0' }).allowDebug, false);
  assert.equal(loadWebConfig({ WEB_API_HOST: '0.0.0.0', WEB_ALLOW_DEBUG: '1' }).allowDebug, true);
  assert.equal(loadWebConfig({ WEB_ALLOW_DEBUG: 'false' }).allowDebug, false);
  assert.equal(loadWebConfig({ WEB_API_HOST: '127.0.0.2' }).allowDebug, true, '127.0.0.0/8 is loopback');
});

test('the Host check is on for loopback binds or an explicit allowlist, off otherwise', () => {
  assert.equal(loadWebConfig({ WEB_API_HOST: 'localhost' }).hostCheck, true);
  assert.equal(loadWebConfig({ WEB_API_HOST: '::1' }).hostCheck, true);
  assert.equal(loadWebConfig({ WEB_API_HOST: '0.0.0.0' }).hostCheck, false);
  assert.equal(loadWebConfig({ WEB_API_HOST: '0.0.0.0', WEB_ALLOWED_HOSTS: 'demo.test' }).hostCheck, true);
});

test('a zero-size result cache is disabled', () => {
  assert.equal(loadWebConfig({ WEB_RESULT_CACHE_SIZE: '0' }).resultCache.enabled, false);
});

test('loadWebConfig reports every invalid value in one startup error', () => {
  assert.throws(
    () =>
      loadWebConfig({
        WEB_API_PORT: 'eighty',
        WEB_RATE_LIMIT_MAX: '-1',
        WEB_MAX_QUESTION_LENGTH: '0',
        WEB_QUERY_MAX_RETRIES: 'abc',
        WEB_ALLOW_DEBUG: 'maybe',
        WEB_ALLOWED_ORIGINS: 'http://ok.test,http://bad.test/path',
        OPENAI_TIMEOUT_MS: '0',
      }),
    (error) => {
      assert.ok(error instanceof WebConfigError);
      assert.equal(error.code, 'INVALID_CONFIG');
      assert.equal(error.problems.length, 7);
      for (const name of ['WEB_API_PORT', 'WEB_RATE_LIMIT_MAX', 'WEB_MAX_QUESTION_LENGTH', 'WEB_QUERY_MAX_RETRIES', 'WEB_ALLOW_DEBUG', 'WEB_ALLOWED_ORIGINS', 'OPENAI_TIMEOUT_MS']) {
        assert.match(error.message, new RegExp(name));
      }
      return true;
    }
  );
});

test('integer settings accept plain decimal digits only', () => {
  // Number() would read these as 80, 8000, 1 and 5.
  for (const [name, raw] of [
    ['WEB_API_PORT', '0x50'],
    ['WEB_REQUEST_TIMEOUT_MS', '8e3'],
    ['WEB_RATE_LIMIT_MAX', '0b1'],
    ['WEB_QUERY_ROW_LIMIT', '5.0'],
    ['WEB_MAX_QUESTION_LENGTH', '+5'],
  ]) {
    assert.throws(() => loadWebConfig({ [name]: raw }), (error) => error.code === 'INVALID_CONFIG' && error.message.includes(name), `${name}=${raw}`);
  }
  assert.equal(loadWebConfig({ WEB_API_PORT: ' 8080 ' }).port, 8080);
});

test('origins are normalized the way browsers send them', () => {
  const config = loadWebConfig({ WEB_ALLOWED_ORIGINS: 'HTTP://Example.TEST:80/ https://example.test:443' });
  assert.deepEqual(config.allowedOrigins, ['http://example.test', 'https://example.test']);
});

test('the config object is deeply frozen', () => {
  const config = loadWebConfig({});
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.rateLimit));
  assert.ok(Object.isFrozen(config.allowedOrigins));
  assert.throws(() => {
    'use strict';
    config.apiToken = 'x';
  }, TypeError);
});

test('describeWebConfig summarizes the effective settings without the token', () => {
  const summary = describeWebConfig(loadWebConfig({ WEB_API_TOKEN: 'super-secret-value', WEB_RATE_LIMIT_MAX: '0' }));
  assert.match(summary, /auth=on/);
  assert.match(summary, /rateLimit=off/);
  assert.doesNotMatch(summary, /super-secret-value/);
});
