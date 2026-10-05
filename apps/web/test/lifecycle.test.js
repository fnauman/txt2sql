import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { formatListenUrl, installSignalHandlers, logQueryUserPrivileges, startServer } from '../src/server/lifecycle.js';
import {
  READONLY_GRANTS,
  createRuntimeFactory,
  deferred,
  request,
  silentLogger,
  successResult,
  testConfig,
} from './helpers/server-harness.js';
import { createApp } from '../src/server/index.js';

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level}: ${message}`);
  return { lines, log: push('log'), warn: push('warn'), error: push('error') };
}

test('graceful shutdown drains an in-flight request before closing the runtimes', async () => {
  const gate = deferred();
  const started = deferred();
  const { factory, runtimes } = createRuntimeFactory();
  const config = testConfig({ WEB_SHUTDOWN_TIMEOUT_MS: '5000' });
  const { app, close } = createApp({
    config,
    logger: silentLogger,
    runtimeFactory: factory,
    runQuestion: async (args) => {
      started.resolve();
      await gate.promise;
      return successResult(args.question);
    },
  });
  let closedAt = null;
  const lifecycle = await startServer({
    app,
    config,
    logger: silentLogger,
    onClose: async () => {
      closedAt = Date.now();
      await close();
    },
  });

  const inFlight = request(lifecycle.address.port, { method: 'POST', path: '/api/query', body: { question: 'slow one' } });
  await started.promise;
  assert.equal(lifecycle.inFlight(), 1);

  const stopping = lifecycle.shutdown({ reason: 'test' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closedAt, null, 'runtimes stay open while a request is in flight');

  const finishedAt = Date.now();
  gate.resolve();
  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.equal(response.json.success, true);

  assert.deepEqual(await stopping, { forced: false });
  assert.ok(closedAt >= finishedAt);
  assert.equal(runtimes[0].closed, 1);
  assert.equal(lifecycle.shutdown(), stopping, 'idempotent');
});

test('shutdown force-closes connections that outlive the timeout', async () => {
  const { factory } = createRuntimeFactory();
  const config = testConfig({ WEB_SHUTDOWN_TIMEOUT_MS: '50' });
  const never = deferred();
  const reached = deferred();
  let aborted = false;
  const { app, close } = createApp({
    config,
    logger: silentLogger,
    runtimeFactory: factory,
    runQuestion: async (args) => {
      args.signal.addEventListener('abort', () => {
        aborted = true;
      });
      reached.resolve();
      await never.promise;
      return successResult(args.question);
    },
  });
  const logger = captureLogger();
  const lifecycle = await startServer({ app, config, logger, onClose: close });

  const inFlight = request(lifecycle.address.port, { method: 'POST', path: '/api/query', body: { question: 'stuck' } }).catch(
    (error) => error
  );
  // Wait for the request to be inside the handler (a fixed sleep raced the
  // POST under load, so shutdown sometimes found nothing in flight).
  await reached.promise;
  const result = await lifecycle.shutdown();
  assert.deepEqual(result, { forced: true });
  assert.ok((await inFlight) instanceof Error, 'the client connection was closed');
  assert.equal(aborted, true, 'closing the socket aborted the in-flight work before cleanup finished');
  assert.equal(lifecycle.inFlight(), 0);
  assert.ok(logger.lines.some((line) => /still running after 50 ms/.test(line)));
  never.resolve();
});

test('a port that is already in use fails with an actionable message', async () => {
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const { port } = blocker.address();
  try {
    const config = testConfig({ WEB_API_PORT: String(port) });
    const { app, close } = createApp({ config, logger: silentLogger, runtimeFactory: createRuntimeFactory().factory });
    await assert.rejects(startServer({ app, config, logger: silentLogger }), (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      assert.match(error.message, new RegExp(`Port ${port} .* already in use.*WEB_API_PORT`));
      return true;
    });
    await close();
  } finally {
    blocker.close();
  }
});

test('the first signal drains gracefully, a second one exits immediately', async () => {
  const target = new EventEmitter();
  const exits = [];
  const gate = deferred();
  let clock = 0;
  const uninstall = installSignalHandlers({
    shutdown: () => gate.promise,
    logger: silentLogger,
    exit: (code) => exits.push(code),
    target,
    now: () => clock,
  });
  target.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(exits, []);
  // Ctrl+C under web:dev: the group SIGINT and dev.mjs's forwarded SIGTERM
  // arrive together and must not abort the drain.
  clock = 50;
  target.emit('SIGINT', 'SIGINT');
  assert.deepEqual(exits, [], 'a duplicate within the window is ignored');
  clock = 5000;
  target.emit('SIGINT', 'SIGINT');
  assert.deepEqual(exits, [1]);
  gate.resolve({ forced: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [1, 0]);
  uninstall();
  assert.equal(target.listenerCount('SIGTERM'), 0);
});

test('startup privilege check logs OK, warnings, or why it was skipped', async () => {
  const fakeConnection = (grants) => ({
    ended: false,
    async query() {
      return [grants.map((grant) => ({ grant }))];
    },
    async end() {
      this.ended = true;
    },
  });

  const okLogger = captureLogger();
  const okConnection = fakeConnection(READONLY_GRANTS);
  const okReport = await logQueryUserPrivileges({ logger: okLogger, connect: async () => okConnection });
  assert.equal(okReport.ok, true);
  assert.match(okLogger.lines[0], /SELECT-only \(ok\)/);
  assert.equal(okConnection.ended, true);

  const rootLogger = captureLogger();
  await logQueryUserPrivileges({
    logger: rootLogger,
    connect: async () => fakeConnection(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION']),
  });
  assert.ok(rootLogger.lines.some((line) => /^warn: \[db\] warning: ALL PRIVILEGES on \*\.\*/.test(line)));

  const skippedLogger = captureLogger();
  const skipped = await logQueryUserPrivileges({
    logger: skippedLogger,
    connect: async () => {
      throw new Error('Missing required MariaDB env vars: DB_NAME.');
    },
  });
  assert.equal(skipped, null);
  assert.match(skippedLogger.lines[0], /privilege check skipped: Missing required MariaDB env vars/);
});

test('formatListenUrl brackets IPv6 addresses', () => {
  assert.equal(formatListenUrl({ address: '127.0.0.1', family: 'IPv4', port: 1 }), 'http://127.0.0.1:1');
  assert.equal(formatListenUrl({ address: '::1', family: 'IPv6', port: 2 }), 'http://[::1]:2');
});
