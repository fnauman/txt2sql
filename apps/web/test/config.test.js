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

test('without a request deadline a retired runtime is never force-closed under a running request', () => {
  // WEB_REQUEST_TIMEOUT_MS=0: requests may run as long as they need, so a
  // schema refresh waits for the old runtime's leases (no grace-period close).
  assert.equal(loadWebConfig({ WEB_REQUEST_TIMEOUT_MS: '0' }).runtimeRetireGraceMs, null);
  assert.equal(loadWebConfig({ WEB_REQUEST_TIMEOUT_MS: '1000' }).runtimeRetireGraceMs, 31_000);
});

test('a zero-size result cache is disabled', () => {
  assert.equal(loadWebConfig({ WEB_RESULT_CACHE_SIZE: '0' }).resultCache.enabled, false);
});

test('a zero result-cache TTL disables the cache', () => {
  const config = loadWebConfig({ WEB_RESULT_CACHE_TTL_MS: '0' });
  assert.equal(config.resultCache.enabled, false);
  assert.match(describeWebConfig(config), /cache=off/);
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

test('loadWebConfig reads HINTS_VERSION with the shared resolver and reports a bad value with the rest', () => {
  assert.equal(loadWebConfig({}).hintsVersion, 2);
  assert.equal(loadWebConfig({ HINTS_VERSION: '1' }).hintsVersion, 1);
  assert.match(describeWebConfig(loadWebConfig({ HINTS_VERSION: '1' })), / hintsVersion=1$/);
  assert.throws(
    () => loadWebConfig({ HINTS_VERSION: 'v2', SCHEMA_SCOPE: 'tiny' }),
    (error) =>
      error instanceof WebConfigError &&
      error.problems.length === 2 &&
      error.problems.some((problem) => problem === 'HINTS_VERSION must be one of 1, 2; got "v2".')
  );
});

test('loadWebConfig reads the schema scope with the shared resolver and reports bad values with the rest', () => {
  assert.deepEqual({ ...loadWebConfig({}).schemaScope }, { schemaScope: 'auto', fullSchemaMaxTokens: 8000, widenOnDemand: true });
  const retrieved = loadWebConfig({ SCHEMA_SCOPE: 'retrieved', SCHEMA_FULL_MAX_TOKENS: '3000', SCHEMA_WIDEN_ON_DEMAND: '0' });
  assert.deepEqual({ ...retrieved.schemaScope }, { schemaScope: 'retrieved', fullSchemaMaxTokens: 3000, widenOnDemand: false });
  assert.ok(Object.isFrozen(retrieved.schemaScope));
  // An explicit retrieved scope does not widen unless asked for (the old behaviour).
  assert.equal(loadWebConfig({ SCHEMA_SCOPE: 'retrieved' }).schemaScope.widenOnDemand, false);
  assert.equal(loadWebConfig({ SCHEMA_SCOPE: 'retrieved', SCHEMA_WIDEN_ON_DEMAND: 'on' }).schemaScope.widenOnDemand, true);
  assert.match(describeWebConfig(retrieved), /schemaScope=retrieved\(fullMaxTokens=3000,widen=off\)/);
  assert.match(describeWebConfig(loadWebConfig({ SCHEMA_SCOPE: 'full' })), / schemaScope=full hintsVersion=2$/);

  assert.throws(
    () => loadWebConfig({ SCHEMA_SCOPE: 'tiny', SCHEMA_FULL_MAX_TOKENS: 'lots', WEB_API_PORT: 'x' }),
    (error) =>
      error instanceof WebConfigError &&
      error.problems.length === 3 &&
      error.problems.some((problem) => /SCHEMA_SCOPE must be one of retrieved, full, auto; got "tiny"/.test(problem)) &&
      error.problems.some((problem) => /SCHEMA_FULL_MAX_TOKENS must be an integer/.test(problem))
  );
});

test('loadWebConfig reads the model, its reasoning effort and the endpoint with the shared resolver; the startup line shows them', () => {
  const defaults = loadWebConfig({});
  assert.deepEqual([defaults.model, defaults.modelSource, defaults.reasoningEffort, defaults.reasoningEffortSource], ['gpt-4o-mini', 'default', null, 'default']);
  assert.deepEqual({ ...defaults.completionSettings }, { baseUrlHost: 'api.openai.com', isOpenRouter: false, requireParameters: true, maxCompletionTokens: 16000 });
  assert.match(describeWebConfig(defaults), /^model=gpt-4o-mini\(default\) reasoningEffort=unset\(default\) endpoint=api\.openai\.com auth=off /);

  const luna = loadWebConfig({ MODEL_NAME: 'gpt-6-luna', REASONING_EFFORT: 'low', LLM_MAX_COMPLETION_TOKENS: '20000' });
  assert.deepEqual([luna.model, luna.modelSource, luna.reasoningEffort, luna.reasoningEffortSource], ['gpt-6-luna', 'MODEL_NAME', 'low', 'REASONING_EFFORT']);
  assert.equal(luna.completionSettings.maxCompletionTokens, 20000);
  assert.ok(Object.isFrozen(luna.completionSettings));
  assert.match(describeWebConfig(luna), /^model=gpt-6-luna\(MODEL_NAME\) reasoningEffort=low\(REASONING_EFFORT\) endpoint=api\.openai\.com /);
  assert.match(describeWebConfig(loadWebConfig({ MODEL_NAME: 'gpt-6-luna' })), /reasoningEffort=provider-default\(default\)/);

  const openRouter = loadWebConfig({ MODEL_NAME: 'openai/gpt-6-luna', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENROUTER_REQUIRE_PARAMETERS: '0' });
  assert.equal(openRouter.completionSettings.isOpenRouter, true);
  assert.match(describeWebConfig(openRouter), / endpoint=openrouter\.ai\(openrouter,requireParameters=off\) /);

  // A bad effort is one more startup problem, reported with the rest.
  assert.throws(
    () => loadWebConfig({ MODEL_NAME: 'gpt-4o-mini', REASONING_EFFORT: 'low', HINTS_VERSION: 'v2' }),
    (error) =>
      error instanceof WebConfigError &&
      error.problems.length === 2 &&
      error.problems.some((problem) => /REASONING_EFFORT "low" does not apply to gpt-4o-mini/.test(problem))
  );
});
