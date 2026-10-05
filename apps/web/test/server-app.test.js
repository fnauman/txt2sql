import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { APIUserAbortError } from 'openai';

import { validateReadOnlySql } from '../../../src/pipeline.js';
import { serializeError } from '../../../src/trace.js';

import {
  READONLY_GRANTS,
  createFakeRuntime,
  createRuntimeFactory,
  deferred,
  failureResult,
  parseSse,
  startApp,
  successResult,
  testConfig,
} from './helpers/server-harness.js';

const TOKEN = 'test-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };

function recordingRunner(resultFor = (args) => successResult(args.question)) {
  const calls = [];
  const runQuestion = async (args) => {
    calls.push(args);
    return resultFor(args);
  };
  return { runQuestion, calls };
}

async function withApp(options, fn) {
  const app = await startApp(options);
  try {
    return await fn(app);
  } finally {
    await app.stop();
  }
}

// --- Auth, limits and input validation ------------------------------------

test('a configured token is required for query routes; bearer and x-api-token both work', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion } = recordingRunner();
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: factory, runQuestion }, async (app) => {
    const anonymous = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');
    assert.equal(anonymous.headers['www-authenticate'], 'Bearer');

    const wrong = await app.request({ method: 'POST', path: '/api/query', headers: { authorization: 'Bearer nope' }, body: { question: 'q' } });
    assert.equal(wrong.status, 401);

    const bearer = await app.request({ method: 'POST', path: '/api/query', headers: auth, body: { question: 'top customers' } });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.json.success, true);

    const header = await app.request({ method: 'POST', path: '/api/query', headers: { 'x-api-token': TOKEN }, body: { question: 'q2' } });
    assert.equal(header.status, 200);
  });
});

test('bad input is a 4xx with a clean message, never a 500', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion, calls } = recordingRunner();
  await withApp({ config: testConfig({ WEB_MAX_QUESTION_LENGTH: '10' }), runtimeFactory: factory, runQuestion }, async (app) => {
    const cases = [
      [{ body: '{"question":', headers: {} }, 400, 'INVALID_JSON'],
      [{ body: { question: 42 } }, 400, 'INVALID_REQUEST'],
      [{ body: ['top customers'] }, 400, 'INVALID_REQUEST'],
      [{ body: { question: '   ' } }, 400, 'QUESTION_REQUIRED'],
      [{ body: {} }, 400, 'QUESTION_REQUIRED'],
      [{ body: { question: 'way too long question' } }, 413, 'QUESTION_TOO_LONG'],
      [{ body: JSON.stringify({ question: 'x'.repeat(3 * 1024 * 1024) }) }, 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [options, status, code] of cases) {
      for (const route of ['/api/query', '/api/query/stream']) {
        const response = await app.request({ method: 'POST', path: route, ...options });
        assert.equal(response.status, status, `${route} ${JSON.stringify(options.body).slice(0, 40)}`);
        assert.equal(response.json.error.code, code);
        assert.ok(response.json.error.message.length > 0);
        assert.ok(!('stack' in response.json.error));
      }
    }

    const unknown = await app.request({ path: '/api/nope' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'NOT_FOUND');

    const insightCases = [
      { rows: [1, 2] },
      { rows: 'x' },
      { rows: { a: 1 } },
      { rows: [{ a: 1 }], columns: [null, 5, { x: 1 }] },
      { rows: [{ a: 1 }], columns: 'a' },
      { rows: [{ a: 1 }], columns: [{ key: 5 }] },
      { rows: [{ a: 1 }], question: { q: 1 } },
      ['not', 'an', 'object'],
    ];
    for (const body of insightCases) {
      const response = await app.request({ method: 'POST', path: '/api/insights', body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.json.error.code, 'INVALID_REQUEST');
      assert.ok(!('stack' in response.json.error));
    }
    const insights = await app.request({ method: 'POST', path: '/api/insights', body: { rows: [{ a: 1 }], columns: [{ key: 'a', type: 'number' }] } });
    assert.equal(insights.status, 200);
    assert.ok(Array.isArray(insights.json.insights));
  });
  assert.equal(calls.length, 0, 'no rejected request reached the pipeline');
});

test('the rate limit applies per client', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion } = recordingRunner();
  await withApp({ config: testConfig({ WEB_RATE_LIMIT_MAX: '2' }), runtimeFactory: factory, runQuestion }, async (app) => {
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await app.request({ method: 'POST', path: '/api/query', body: { question: `q${index}` } })).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

// --- Host / Origin / headers (WEB-9) ----------------------------------------

test('loopback binds reject foreign Host headers (DNS rebinding) but accept loopback names', async () => {
  const { factory } = createRuntimeFactory();
  await withApp({ config: testConfig(), runtimeFactory: factory }, async (app) => {
    const rebinding = await app.request({ path: '/api/health', headers: { host: `attacker.example:${app.port}` } });
    assert.equal(rebinding.status, 403);
    assert.equal(rebinding.json.error.code, 'HOST_NOT_ALLOWED');

    for (const host of [`localhost:${app.port}`, `127.0.0.1:${app.port}`, `[::1]:${app.port}`, 'localhost:1', `[::ffff:127.0.0.1]:${app.port}`]) {
      assert.equal((await app.request({ path: '/api/health', headers: { host } })).status, 200, host);
    }
    // URL parsing would read this as userinfo + "localhost"; it is refused.
    assert.equal((await app.request({ path: '/api/health', headers: { host: 'evil.com@localhost' } })).status, 403);
  });

  await withApp({ config: testConfig({ WEB_ALLOWED_HOSTS: 'demo.test' }), runtimeFactory: factory }, async (app) => {
    assert.equal((await app.request({ path: '/api/health', headers: { host: 'demo.test:8787' } })).status, 200);
    assert.equal((await app.request({ path: '/api/health', headers: { host: 'other.test' } })).status, 403);
  });
});

test('API requests from a disallowed Origin get 403; allowed and same-origin requests pass with CORS', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion } = recordingRunner();
  await withApp({ config: testConfig(), runtimeFactory: factory, runQuestion }, async (app) => {
    const evil = await app.request({
      method: 'POST',
      path: '/api/query',
      headers: { origin: 'http://evil.example' },
      body: { question: 'top customers' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'ORIGIN_NOT_ALLOWED');

    const preflight = await app.request({
      method: 'OPTIONS',
      path: '/api/query',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 403);

    const dev = await app.request({ path: '/api/health', headers: { origin: 'http://localhost:5173' } });
    assert.equal(dev.status, 200);
    assert.equal(dev.headers['access-control-allow-origin'], 'http://localhost:5173');

    const sameOrigin = await app.request({
      method: 'POST',
      path: '/api/query',
      headers: { origin: `http://127.0.0.1:${app.port}` },
      body: { question: 'top customers' },
    });
    assert.equal(sameOrigin.status, 200);
  });
});

test('without a validated Host (non-loopback bind, no WEB_ALLOWED_HOSTS) only listed origins pass', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion, calls } = recordingRunner();
  const config = testConfig({ WEB_API_HOST: '0.0.0.0', WEB_ALLOWED_ORIGINS: 'https://app.example.test', WEB_API_TOKEN: TOKEN });
  assert.equal(config.hostCheck, false);
  await withApp({ config, runtimeFactory: factory, runQuestion }, async (app) => {
    // DNS-rebinding shape: Host and Origin both carry the attacker's name.
    const rebinding = await app.request({
      method: 'POST',
      path: '/api/query',
      headers: { ...auth, host: 'evil.example:8787', origin: 'http://evil.example:8787' },
      body: { question: 'top customers' },
    });
    assert.equal(rebinding.status, 403);
    assert.equal(rebinding.json.error.code, 'ORIGIN_NOT_ALLOWED');

    const listed = await app.request({
      method: 'POST',
      path: '/api/query',
      headers: { ...auth, host: 'evil.example:8787', origin: 'https://app.example.test' },
      body: { question: 'top customers' },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers['access-control-allow-origin'], 'https://app.example.test');

    const noOrigin = await app.request({ method: 'POST', path: '/api/query', headers: auth, body: { question: 'top customers 2' } });
    assert.equal(noOrigin.status, 200, 'non-browser clients send no Origin');
  });
  assert.equal(calls.length, 2);
});

test('security headers are set on API responses and on the built SPA, which still serves', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txt2sql-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');
  const { factory } = createRuntimeFactory();
  try {
    await withApp({ config: testConfig(), runtimeFactory: factory, distDir }, async (app) => {
      const expected = {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'cross-origin-resource-policy': 'same-origin',
      };
      // Module scripts are fetched with an Origin header; static files are not
      // origin-checked.
      for (const [requestPath, headers] of [
        ['/api/health', {}],
        ['/', {}],
        ['/dashboard', {}],
        ['/assets/app.js', { origin: 'http://localhost:9999' }],
      ]) {
        const response = await app.request({ path: requestPath, headers });
        assert.equal(response.status, 200, requestPath);
        for (const [name, value] of Object.entries(expected)) {
          assert.equal(response.headers[name], value, `${requestPath} ${name}`);
        }
      }
      assert.match((await app.request({ path: '/dashboard' })).text, /id="root"/);
    });
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

// --- Debug gating (WEB-8) ---------------------------------------------------

test('the client debug flag is ignored unless the server allows debug output', async () => {
  const { factory } = createRuntimeFactory();
  const denied = recordingRunner();
  await withApp({ config: testConfig({ WEB_ALLOW_DEBUG: '0' }), runtimeFactory: factory, runQuestion: denied.runQuestion }, async (app) => {
    const response = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers', debug: true } });
    assert.equal(response.status, 200);
    assert.equal(response.json.debug, null);
    assert.equal(denied.calls[0].trace.enabled, false);

    // Denied debug requests are ordinary requests: they hit the cache.
    const again = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers', debug: true } });
    assert.equal(again.json.cacheHit, true);

    const health = await app.request({ path: '/api/health' });
    assert.equal(health.json.debugAllowed, false);
    assert.equal(health.json.cacheEnabled, true);
    assert.equal(health.json.dataResidency, 'client-ok');
  });

  const allowed = recordingRunner();
  await withApp({ config: testConfig({ WEB_ALLOW_DEBUG: '1' }), runtimeFactory: factory, runQuestion: allowed.runQuestion }, async (app) => {
    const response = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers', debug: true } });
    assert.ok(response.json.debug);
    assert.equal(response.json.debug.rawResponse, '{"raw":true}');
    assert.equal(allowed.calls[0].trace.enabled, true);
  });
});

// --- Schema refresh (WEB-2) -------------------------------------------------

test('refreshSchema in a query body is ignored', async () => {
  const { factory, calls } = createRuntimeFactory();
  const { runQuestion } = recordingRunner();
  await withApp({ config: testConfig(), runtimeFactory: factory, runQuestion }, async (app) => {
    for (const route of ['/api/query', '/api/query/stream']) {
      const response = await app.request({ method: 'POST', path: route, body: { question: `q ${route}`, refreshSchema: true } });
      assert.equal(response.status, 200);
    }
  });
  assert.deepEqual(calls, [{ refreshSchema: false }], 'one runtime, never a refresh');
});

test('admin refresh requires a configured token', async () => {
  const { factory } = createRuntimeFactory();
  await withApp({ config: testConfig(), runtimeFactory: factory }, async (app) => {
    const response = await app.request({ method: 'POST', path: '/api/admin/refresh-schema' });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, 'ADMIN_DISABLED');
    assert.match(response.json.error.message, /WEB_API_TOKEN/);
  });

  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: factory }, async (app) => {
    assert.equal((await app.request({ method: 'POST', path: '/api/admin/refresh-schema' })).status, 401);
  });
});

test('admin refresh swaps the runtime and clears the result cache', async () => {
  const { factory, calls, runtimes } = createRuntimeFactory();
  const { runQuestion, calls: runs } = recordingRunner();
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: factory, runQuestion }, async (app) => {
    const ask = () => app.request({ method: 'POST', path: '/api/query', headers: auth, body: { question: 'top customers' } });
    assert.equal((await ask()).json.cacheHit, undefined);
    assert.equal((await ask()).json.cacheHit, true);
    assert.equal(runs.length, 1);

    const refreshed = await app.request({ method: 'POST', path: '/api/admin/refresh-schema', headers: auth });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.success, true);
    assert.equal(refreshed.json.tableCount, 2);
    assert.deepEqual(calls, [{ refreshSchema: false }, { refreshSchema: true }]);

    const after = await ask();
    assert.equal(after.json.cacheHit, undefined, 'cache was cleared');
    assert.equal(runs.length, 2);
    assert.equal(runs[1].connection, runtimes[1].connection, 'new questions use the new runtime');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtimes[0].closed, 1, 'the idle old runtime was closed');
  });
});

test('an in-flight question completes successfully across a schema refresh', async () => {
  const { factory, runtimes } = createRuntimeFactory();
  const gate = deferred();
  const started = deferred();
  const runQuestion = async (args) => {
    started.resolve(args);
    await gate.promise;
    // Uses the pool it started with; a closed pool would throw here.
    assert.equal(runtimes[0].closed, 0, 'the old pool must stay open while in use');
    await args.connection.query('SELECT 1 AS ok');
    return successResult(args.question);
  };

  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: factory, runQuestion }, async (app) => {
    const inFlight = app.request({ method: 'POST', path: '/api/query/stream', headers: auth, body: { question: 'slow question' } });
    const args = await started.promise;
    assert.equal(args.connection, runtimes[0].connection);

    const refreshed = await app.request({ method: 'POST', path: '/api/admin/refresh-schema', headers: auth });
    assert.equal(refreshed.status, 200);
    assert.equal(runtimes.length, 2);
    assert.equal(runtimes[0].closed, 0, 'retired, but not closed while a request uses it');
    assert.deepEqual(app.runtimeManager.status().retiring, [{ id: 1, inFlight: 1 }]);

    gate.resolve();
    const frames = parseSse((await inFlight).text);
    assert.deepEqual(
      frames.map((frame) => frame.event).filter((event) => event === 'error' || event === 'done'),
      ['done']
    );
    assert.equal(frames.find((frame) => frame.event === 'metrics').data.attemptCount, 1);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtimes[0].closed, 1, 'closed once the in-flight question finished');
    assert.equal(runtimes[1].closed, 0);
  });
});

// --- Readiness (WEB-7) ------------------------------------------------------

test('a failed runtime load is not cached: the next request retries', async () => {
  const { factory, calls } = createRuntimeFactory({ fail: (callNumber) => callNumber === 1 });
  const { runQuestion } = recordingRunner();
  await withApp({ config: testConfig(), runtimeFactory: factory, runQuestion }, async (app) => {
    const first = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(first.status, 503);
    assert.equal(first.json.errorStage, 'infra');
    assert.equal(first.json.errorCode, 'OPENAI_NOT_CONFIGURED');
    assert.equal(first.json.error.stage, 'infra');

    const second = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(second.status, 200);
    assert.equal(calls.length, 2);
  });
});

test('a not-ready database schema is re-checked on the next request (no restart needed)', async () => {
  let bootstrapped = false;
  const { factory } = createRuntimeFactory({ tablesInDb: () => (bootstrapped ? ['Customer', 'Product'] : []) });
  const { runQuestion } = recordingRunner();
  await withApp({ config: testConfig(), runtimeFactory: factory, runQuestion }, async (app) => {
    const before = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(before.status, 503);
    assert.equal(before.json.errorCode, 'DB_SCHEMA_MISSING');
    assert.equal(before.json.error.name, 'DatabaseSchemaError');
    assert.match(before.json.error.message, /bootstrap-db/);

    const stream = parseSse((await app.request({ method: 'POST', path: '/api/query/stream', body: { question: 'top customers' } })).text);
    assert.deepEqual(stream.find((frame) => frame.event === 'error').data.stage, 'infra');

    bootstrapped = true; // e.g. `npm run bootstrap-db && npm run seed-demo`
    const after = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(after.status, 200);
  });
});

// --- Health (WEB-11) --------------------------------------------------------

test('deep health requires the token when one is configured; only token holders see DB topology', async () => {
  const { factory } = createRuntimeFactory();
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: factory, envInfo: { loaded: true, path: '/secret/.env', candidate: '/secret/.env' } }, async (app) => {
    const shallow = await app.request({ path: '/api/health' });
    assert.equal(shallow.status, 200);
    assert.equal(shallow.json.authRequired, true);
    assert.ok(!('database' in shallow.json) && !('env' in shallow.json));

    const anonymousDeep = await app.request({ path: '/api/health?deep=1' });
    assert.equal(anonymousDeep.status, 401);
    assert.doesNotMatch(anonymousDeep.text, /127\.0\.0\.1|3306|secret/);

    const deep = await app.request({ path: '/api/health?deep=1', headers: auth });
    assert.equal(deep.status, 200);
    assert.equal(deep.json.dbReachable, true);
    assert.equal(deep.json.dbSchemaReady, true);
    assert.equal(deep.json.env.path, '/secret/.env');
    assert.equal(deep.json.database.role, 'query');
    assert.equal(deep.json.privileges.ok, true);
    assert.equal(deep.json.schema.tableCount, 2);
  });
});

test('deep health reports dbReachable only for the database it actually tried', async () => {
  // The runtime builds the OpenAI client first: without a key the DB is never tried.
  const noKey = createRuntimeFactory({ fail: () => true });
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: noKey.factory }, async (app) => {
    const deep = await app.request({ path: '/api/health?deep=1', headers: auth });
    assert.equal(deep.status, 503);
    assert.equal(deep.json.dbReachable, null);
    assert.equal(deep.json.error.code, 'OPENAI_NOT_CONFIGURED');
  });

  const dbDown = createRuntimeFactory();
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: async (options) => {
    const runtime = await dbDown.factory(options);
    runtime.connection.query = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    return runtime;
  } }, async (app) => {
    const deep = await app.request({ path: '/api/health?deep=1', headers: auth });
    assert.equal(deep.status, 503);
    assert.equal(deep.json.dbReachable, false);
    assert.equal(deep.json.error.code, 'ECONNREFUSED');
  });
});

test('deep health surfaces over-privileged query users to authorized callers', async () => {
  const { factory } = createRuntimeFactory({ grants: ["GRANT ALL PRIVILEGES ON *.* TO `root`@`%` IDENTIFIED BY PASSWORD '*x'"] });
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: factory }, async (app) => {
    const deep = await app.request({ path: '/api/health?deep=1', headers: auth });
    assert.equal(deep.json.privileges.ok, false);
    assert.match(deep.json.privileges.warnings[0], /ALL PRIVILEGES/);
    assert.doesNotMatch(JSON.stringify(deep.json.privileges.grants), /'\*x'/);
  });

  // SELECT-only, but on another database than the configured DB_NAME.
  const elsewhere = createRuntimeFactory({ grants: [...READONLY_GRANTS, 'GRANT SELECT ON `hr`.* TO `demo_readonly`@`%`'] });
  await withApp({ config: testConfig({ WEB_API_TOKEN: TOKEN }), runtimeFactory: elsewhere.factory }, async (app) => {
    const deep = await app.request({ path: '/api/health?deep=1', headers: auth });
    assert.equal(deep.json.privileges.ok, false);
    assert.match(deep.json.privileges.warnings[0], /`hr`\.\* is a database other than DB_NAME \(demo_retail\)/);
  });
});

test('without a token, a failing deep health check never leaks the DB host or port', async () => {
  const error = Object.assign(new Error('Unable to connect to MariaDB at 10.9.8.7:3999. Start MariaDB locally.'), { code: 'ECONNREFUSED' });
  const { factory } = createRuntimeFactory({ fail: () => true, error });
  await withApp({ config: testConfig(), runtimeFactory: factory }, async (app) => {
    const deep = await app.request({ path: '/api/health?deep=1' });
    assert.equal(deep.status, 503);
    assert.equal(deep.json.ok, false);
    assert.equal(deep.json.error.code, 'ECONNREFUSED');
    assert.doesNotMatch(deep.text, /10\.9\.8\.7|3999/);
    assert.ok(!('database' in deep.json));
  });
});

// --- Failure stages and truncation over the wire (EVAL-ENG-13, WEB-5) ---------

test('failed questions expose errorStage/errorCode in JSON and SSE error payloads', async () => {
  const { factory } = createRuntimeFactory();
  const byQuestion = {
    blocked: { stage: 'validation', code: null, message: 'SQL references table "Secret" which is outside the allowed table set.', status: 422 },
    cut: { stage: 'llm', code: 'LLM_TRUNCATED', message: 'cut off', status: 422 },
    refused: { stage: 'llm', code: 'LLM_REFUSED', message: 'declined', status: 422 },
    // Provider outages are gateway errors, not an unprocessable question.
    llmSlow: { stage: 'llm', code: 'LLM_TIMEOUT', message: 'Request timed out.', status: 504 },
    llmDown: { stage: 'llm', code: 'LLM_CONNECTION_ERROR', message: 'Connection error.', status: 502 },
    llm5xx: { stage: 'llm', code: 'HTTP_503', message: 'overloaded', status: 502 },
    llmLimited: { stage: 'llm', code: 'HTTP_429', message: 'rate limited', status: 503 },
    llmKey: { stage: 'llm', code: 'HTTP_401', message: 'bad key', status: 503 },
    llmBadRequest: { stage: 'llm', code: 'HTTP_400', message: 'context too long', status: 422 },
    db: { stage: 'execution', code: 'ER_BAD_FIELD_ERROR', message: 'Unknown column', status: 422 },
    down: { stage: 'infra', code: 'ECONNREFUSED', message: 'refused', status: 503 },
    slow: { stage: 'aborted', code: 'REQUEST_TIMEOUT', message: 'deadline', status: 504 },
  };
  const { runQuestion } = recordingRunner((args) => failureResult(args.question, byQuestion[args.question]));
  await withApp({ config: testConfig({ WEB_ALLOW_DEBUG: '1' }), runtimeFactory: factory, runQuestion }, async (app) => {
    for (const [question, expected] of Object.entries(byQuestion)) {
      const json = await app.request({ method: 'POST', path: '/api/query', body: { question } });
      assert.equal(json.status, expected.status, question);
      assert.equal(json.json.errorStage, expected.stage);
      assert.equal(json.json.errorCode, expected.code);
      assert.equal(json.json.error.stage, expected.stage);
      assert.equal(json.json.error.code, expected.code);
      assert.ok(!('stack' in json.json.error));

      const frames = parseSse((await app.request({ method: 'POST', path: '/api/query/stream', body: { question } })).text);
      const errorFrame = frames.find((frame) => frame.event === 'error');
      assert.deepEqual(errorFrame.data, { name: 'Error', message: expected.message, code: expected.code, stage: expected.stage });
      assert.equal(frames.at(-1).event, 'done');
    }
  });
});

test('a rejected query reports the validator layer in JSON and SSE error payloads', async () => {
  const { factory } = createRuntimeFactory();
  let rejection;
  try {
    validateReadOnlySql('SELECT 1 -- hidden', []);
  } catch (error) {
    rejection = error;
  }
  const { runQuestion } = recordingRunner((args) => ({
    ...failureResult(args.question, { stage: 'validation', code: rejection.code, message: rejection.message, name: rejection.name }),
    serializedError: serializeError(rejection),
  }));
  await withApp({ config: testConfig(), runtimeFactory: factory, runQuestion }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', body: { question: 'q' } });
    assert.equal(json.status, 422);
    assert.equal(json.json.errorCode, 'SQL_COMMENT');
    assert.equal(json.json.error.layer, 'safety');
    assert.ok(!('stack' in json.json.error));

    const frames = parseSse((await app.request({ method: 'POST', path: '/api/query/stream', body: { question: 'q' } })).text);
    const errorFrame = frames.find((frame) => frame.event === 'error');
    assert.equal(errorFrame.data.layer, 'safety');
    assert.equal(errorFrame.data.stage, 'validation');
  });
});

test('infra failures never show raw driver messages (DB host:port) to callers that may not see internals', async () => {
  const { factory } = createRuntimeFactory();
  const raw = 'connect ECONNREFUSED 10.9.8.7:3306';
  const { runQuestion } = recordingRunner((args) => failureResult(args.question, { stage: 'infra', code: 'ECONNREFUSED', message: raw }));

  // Debug not allowed and no token: a message keyed by the code, never the raw one.
  await withApp({ config: testConfig({ WEB_ALLOW_DEBUG: '0' }), runtimeFactory: factory, runQuestion }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(json.status, 503);
    assert.equal(json.json.errorStage, 'infra');
    assert.equal(json.json.errorCode, 'ECONNREFUSED');
    assert.deepEqual(json.json.error, {
      name: 'Error',
      code: 'ECONNREFUSED',
      message: 'The query runtime or database is not reachable.',
      stage: 'infra',
    });
    assert.doesNotMatch(json.text, /10\.9\.8\.7|3306/);

    const stream = await app.request({ method: 'POST', path: '/api/query/stream', body: { question: 'top customers' } });
    assert.doesNotMatch(stream.text, /10\.9\.8\.7|3306/);
    assert.equal(parseSse(stream.text).find((frame) => frame.event === 'error').data.code, 'ECONNREFUSED');
  });

  // A thrown runtime-load failure takes the same path.
  const failing = createRuntimeFactory({ fail: () => true, error: Object.assign(new Error(raw), { code: 'ECONNREFUSED' }) });
  await withApp({ config: testConfig({ WEB_ALLOW_DEBUG: '0' }), runtimeFactory: failing.factory }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(json.status, 503);
    assert.doesNotMatch(json.text, /10\.9\.8\.7|3306/);
  });

  // Token holders and loopback/debug setups keep the actionable raw message.
  await withApp({ config: testConfig({ WEB_ALLOW_DEBUG: '0', WEB_API_TOKEN: TOKEN }), runtimeFactory: factory, runQuestion }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', headers: auth, body: { question: 'top customers' } });
    assert.equal(json.json.error.message, raw);
  });
  await withApp({ config: testConfig(), runtimeFactory: factory, runQuestion }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(json.json.error.message, raw);
  });
});

test('a truncated result reports an unknown total (null) in JSON and in the SSE columns frame', async () => {
  const { factory } = createRuntimeFactory();
  const rows = Array.from({ length: 3 }, (_value, index) => ({ CustomerId: index + 1 }));
  const { runQuestion, calls } = recordingRunner((args) =>
    successResult(args.question, rows, { totalRowCount: null, truncated: true, rowCount: 3 })
  );
  await withApp({ config: testConfig({ WEB_QUERY_ROW_LIMIT: '3' }), runtimeFactory: factory, runQuestion }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', body: { question: 'all customers' } });
    assert.equal(json.json.truncated, true);
    assert.equal(json.json.totalRowCount, null);
    assert.equal(json.json.rowCount, 3);
    assert.equal(calls[0].rowLimit, 3, 'the configured row limit reaches the pipeline');
    assert.equal(calls[0].statementTimeoutMs, 8000);
    assert.equal(calls[0].maxRetries, 1);
    assert.ok(calls[0].signal instanceof AbortSignal);

    const frames = parseSse((await app.request({ method: 'POST', path: '/api/query/stream', body: { question: 'all customers 2' } })).text);
    assert.deepEqual(frames.find((frame) => frame.event === 'columns').data.totalRowCount, null);
    assert.equal(frames.find((frame) => frame.event === 'columns').data.rowCount, 3);
  });
});

test('the request deadline aborts the real pipeline and answers 504 REQUEST_TIMEOUT', async () => {
  // Real runOptimizedQuestion; the fake LLM only returns when it is aborted.
  const runtime = createFakeRuntime();
  let llmCalls = 0;
  runtime.client = {
    chat: {
      completions: {
        create(_request, options) {
          llmCalls += 1;
          return new Promise((_resolve, reject) => {
            // What the real SDK throws when its request signal aborts.
            options.signal.addEventListener('abort', () => reject(new APIUserAbortError()));
          });
        },
      },
    },
  };
  await withApp({ config: testConfig({ WEB_REQUEST_TIMEOUT_MS: '50' }), runtimeFactory: async () => runtime }, async (app) => {
    const response = await app.request({ method: 'POST', path: '/api/query', body: { question: 'How many active customers do we have?' } });
    assert.equal(response.status, 504);
    assert.equal(response.json.errorStage, 'aborted');
    assert.equal(response.json.errorCode, 'REQUEST_TIMEOUT');
    assert.equal(llmCalls, 1, 'no retry after the deadline');
  });
});

// --- Every wait in the request path is bounded by the deadline ----------------

const DEADLINE_MS = 25;
// Generous: the point is that the answer does not wait for the stalled step.
const PROMPT_MS = 400;

async function timed(promise) {
  const startedAt = Date.now();
  const value = await promise;
  return { ...value, elapsedMs: Date.now() - startedAt };
}

// A step that stalls until released, or for `fallbackMs` so a regression fails
// instead of hanging the suite.
function stall(fallbackMs = 2000) {
  const gate = deferred();
  const timer = setTimeout(() => gate.resolve(), fallbackMs);
  return {
    promise: gate.promise,
    release(value) {
      clearTimeout(timer);
      gate.resolve(value);
    },
  };
}

function assertDeadlineJson(response) {
  assert.ok(response.elapsedMs < PROMPT_MS, `answered after ${response.elapsedMs} ms`);
  assert.equal(response.status, 504);
  assert.equal(response.json.errorStage, 'aborted');
  assert.equal(response.json.errorCode, 'REQUEST_TIMEOUT');
  assert.equal(response.json.error.code, 'REQUEST_TIMEOUT');
  assert.equal(response.json.error.stage, 'aborted');
  assert.ok(!('stack' in response.json.error));
}

function assertDeadlineSse(response) {
  assert.ok(response.elapsedMs < PROMPT_MS, `answered after ${response.elapsedMs} ms`);
  const frames = parseSse(response.text);
  const errorFrame = frames.find((frame) => frame.event === 'error');
  assert.equal(errorFrame.data.code, 'REQUEST_TIMEOUT');
  assert.equal(errorFrame.data.stage, 'aborted');
  assert.equal(frames.at(-1).event, 'done');
}

test('the request deadline bounds a stalled runtime load; a lease that arrives later is released', async () => {
  const load = stall();
  const runtime = createFakeRuntime();
  const { runQuestion, calls } = recordingRunner();
  const config = testConfig({ WEB_REQUEST_TIMEOUT_MS: String(DEADLINE_MS) });
  await withApp({ config, runtimeFactory: () => load.promise.then(() => runtime), runQuestion }, async (app) => {
    const ask = (route) => timed(app.request({ method: 'POST', path: route, body: { question: 'top customers' } }));
    assertDeadlineJson(await ask('/api/query'));
    assertDeadlineSse(await ask('/api/query/stream'));

    load.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.runtimeManager.status().ready, true);
    assert.equal(app.runtimeManager.status().inFlight, 0, 'both late leases were released');
    assert.equal(calls.length, 0, 'the pipeline never ran');
  });
});

test('the request deadline bounds a stalled database schema inspection', async () => {
  const inspection = stall();
  const runtime = createFakeRuntime();
  const query = runtime.connection.query;
  runtime.connection.query = async (sql, params) => {
    if (/information_schema\.TABLES/.test(sql)) {
      await inspection.promise; // e.g. waiting for a pool slot
    }
    return query(sql, params);
  };
  const { runQuestion, calls } = recordingRunner();
  const config = testConfig({ WEB_REQUEST_TIMEOUT_MS: String(DEADLINE_MS) });
  await withApp({ config, runtimeFactory: async () => runtime, runQuestion }, async (app) => {
    const ask = (route) => timed(app.request({ method: 'POST', path: route, body: { question: 'top customers' } }));
    assertDeadlineJson(await ask('/api/query'));
    assert.equal(app.runtimeManager.status().inFlight, 0, 'the lease is released with the answer');
    assertDeadlineSse(await ask('/api/query/stream'));
    assert.equal(calls.length, 0);
    inspection.release();
  });
});

test('the request deadline bounds the wait for a pool slot in the real pipeline; the late connection is released', async () => {
  // Real runOptimizedQuestion: the product term triggers a master-data lookup,
  // which needs a dedicated pool connection, and every slot is busy.
  const runtime = createFakeRuntime();
  const slot = stall();
  const events = [];
  runtime.connection.getConnection = () => {
    events.push('getConnection');
    return slot.promise.then(() => ({
      threadId: 3,
      async query() {
        events.push('query');
        return [[]];
      },
      release() {
        events.push('release');
      },
      destroy() {
        events.push('destroy');
      },
    }));
  };
  runtime.client = {
    chat: {
      completions: {
        async create() {
          assert.fail('no LLM call after the deadline');
        },
      },
    },
  };
  const config = testConfig({ WEB_REQUEST_TIMEOUT_MS: String(DEADLINE_MS), WEB_QUERY_STATEMENT_TIMEOUT_MS: '0' });
  await withApp({ config, runtimeFactory: async () => runtime }, async (app) => {
    const response = await timed(app.request({ method: 'POST', path: '/api/query', body: { question: 'sparkling water sales' } }));
    assertDeadlineJson(response);
    assert.deepEqual(events, ['getConnection']);

    slot.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['getConnection', 'release'], 'the connection that arrived late went straight back');
  });
});

test('a success that arrives after the request deadline is neither returned nor cached', async () => {
  const { factory } = createRuntimeFactory();
  // A runner that ignores the signal (e.g. a statement that finished after a
  // failed KILL) and returns rows after the deadline passed.
  const { runQuestion, calls } = recordingRunner(async (args) => {
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 3));
    assert.equal(args.signal.aborted, true);
    return successResult(args.question);
  });
  const config = testConfig({ WEB_REQUEST_TIMEOUT_MS: String(DEADLINE_MS) });
  await withApp({ config, runtimeFactory: factory, runQuestion }, async (app) => {
    const json = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(json.status, 504);
    assert.equal(json.json.success, false);
    assert.equal(json.json.errorStage, 'aborted');
    assert.equal(json.json.errorCode, 'REQUEST_TIMEOUT');
    assert.deepEqual(json.json.rows ?? [], []);

    const frames = parseSse((await app.request({ method: 'POST', path: '/api/query/stream', body: { question: 'top customers' } })).text);
    assert.equal(frames.find((frame) => frame.event === 'error').data.code, 'REQUEST_TIMEOUT');
    assert.ok(!frames.some((frame) => frame.event === 'rows'), 'no rows after the deadline');

    assert.equal(app.resultCache.size, 0, 'nothing was cached');
    assert.equal(calls.length, 2, 'the second request was not served from the cache');
  });
});

test('WEB_RESULT_CACHE=0 from config disables replay', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion, calls } = recordingRunner();
  await withApp({ config: testConfig({ WEB_RESULT_CACHE: '0' }), runtimeFactory: factory, runQuestion }, async (app) => {
    await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    const second = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(second.json.cacheHit, undefined);
    assert.equal(calls.length, 2);
  });
});

test('data residency follows the configured query user (DB_USER defaults to demo_readonly)', async () => {
  const { factory } = createRuntimeFactory();
  const { runQuestion } = recordingRunner();
  const config = testConfig({ DB_USER: '' });
  assert.equal(config.database.user, 'demo_readonly');
  await withApp({ config, runtimeFactory: factory, runQuestion }, async (app) => {
    const response = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.deepEqual(response.json.dataResidency, { engine: 'client-ok', source: 'demo_readonly@demo_retail' });
  });

  await withApp({ config: testConfig({ DB_USER: 'root' }), runtimeFactory: factory, runQuestion }, async (app) => {
    const response = await app.request({ method: 'POST', path: '/api/query', body: { question: 'top customers' } });
    assert.equal(response.json.dataResidency.engine, 'server-only');
    // Health explains why the cache / cross-filter are off for this source.
    const health = await app.request({ path: '/api/health' });
    assert.equal(health.json.cacheEnabled, false);
    assert.equal(health.json.dataResidency, 'server-only');
  });
});
