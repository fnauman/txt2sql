import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { buildBoundedStatement, executeReadOnlySql, resolveStatementTimeoutMs } from '../src/pipeline.js';

// executeReadOnlySql wraps model-authored SQL in `SET STATEMENT max_statement_time`
// — the only tail-bound that stops a pathological generated query from pinning the
// MariaDB instance, which may also host sensitive non-demo databases. These tests
// pin that wrapper (and its ms->s conversion) so it cannot silently regress.
function createRecordingConnection() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(params === undefined ? sql : { sql, params });
      return [[{ ok: 1 }]];
    },
  };
}

function withEnv(overrides, fn) {
  const original = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of original) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test('executeReadOnlySql wraps SQL with a SET STATEMENT timeout when timeoutMs > 0', async () => {
  const connection = createRecordingConnection();
  const rows = await executeReadOnlySql(connection, 'SELECT 1', { timeoutMs: 8000 });

  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.equal(connection.calls[0], 'SET STATEMENT max_statement_time=8.000 FOR SELECT 1');
});

test('executeReadOnlySql converts fractional milliseconds to seconds', async () => {
  const connection = createRecordingConnection();
  await executeReadOnlySql(connection, 'SELECT 2', { timeoutMs: 500 });

  assert.equal(connection.calls[0], 'SET STATEMENT max_statement_time=0.500 FOR SELECT 2');
});

// Behavior change (SAFE-11 / WEB-5): an omitted timeout used to mean "unbounded",
// so the CLI, benchmark and master-data paths ran model SQL with no limit. It now
// means QUERY_STATEMENT_TIMEOUT_MS (default 8000); only an explicit 0 disables.
test('executeReadOnlySql bounds SQL by default and runs it raw only when the timeout is 0', async () => {
  await withEnv({ QUERY_STATEMENT_TIMEOUT_MS: null }, async () => {
    const zeroTimeout = createRecordingConnection();
    await executeReadOnlySql(zeroTimeout, 'SELECT 3', { timeoutMs: 0 });
    assert.equal(zeroTimeout.calls[0], 'SELECT 3');

    const omitted = createRecordingConnection();
    await executeReadOnlySql(omitted, 'SELECT 4', {});
    assert.equal(omitted.calls[0], 'SET STATEMENT max_statement_time=8.000 FOR SELECT 4');

    const noOptions = createRecordingConnection();
    await executeReadOnlySql(noOptions, 'SELECT 5');
    assert.equal(noOptions.calls[0], 'SET STATEMENT max_statement_time=8.000 FOR SELECT 5');
  });
});

test('QUERY_STATEMENT_TIMEOUT_MS sets the default; 0 disables; invalid values fail loudly', async () => {
  await withEnv({ QUERY_STATEMENT_TIMEOUT_MS: '2500' }, async () => {
    const connection = createRecordingConnection();
    await executeReadOnlySql(connection, 'SELECT 6');
    assert.equal(connection.calls[0], 'SET STATEMENT max_statement_time=2.500 FOR SELECT 6');
  });

  await withEnv({ QUERY_STATEMENT_TIMEOUT_MS: '0' }, async () => {
    const connection = createRecordingConnection();
    await executeReadOnlySql(connection, 'SELECT 7');
    assert.equal(connection.calls[0], 'SELECT 7');
  });

  for (const bad of ['abc', '-1', '1.5', '0x50', '8e3']) {
    assert.throws(
      () => resolveStatementTimeoutMs({ QUERY_STATEMENT_TIMEOUT_MS: bad }),
      (error) => error.code === 'INVALID_CONFIG' && /QUERY_STATEMENT_TIMEOUT_MS/.test(error.message)
    );
  }
  assert.equal(resolveStatementTimeoutMs({}), 8000);
});

test('maxRows caps the outermost result server-side with sql_select_limit', async () => {
  const connection = createRecordingConnection();
  await executeReadOnlySql(connection, 'SELECT * FROM Customer ORDER BY CustomerId', { timeoutMs: 8000, maxRows: 1001 });
  assert.equal(
    connection.calls[0],
    'SET STATEMENT max_statement_time=8.000, sql_select_limit=1001 FOR SELECT * FROM Customer ORDER BY CustomerId'
  );

  const rowsOnly = createRecordingConnection();
  await executeReadOnlySql(rowsOnly, 'SELECT 1', { timeoutMs: 0, maxRows: 5 });
  assert.equal(rowsOnly.calls[0], 'SET STATEMENT sql_select_limit=5 FOR SELECT 1');
});

test('buildBoundedStatement validates its bounds and never rounds a tiny timeout to "disabled"', () => {
  assert.equal(buildBoundedStatement('SELECT 1', { timeoutMs: 0.2 }), 'SET STATEMENT max_statement_time=0.001 FOR SELECT 1');
  assert.equal(buildBoundedStatement('SELECT 1'), 'SELECT 1');
  assert.throws(() => buildBoundedStatement('SELECT 1', { timeoutMs: -1 }), TypeError);
  assert.throws(() => buildBoundedStatement('SELECT 1', { timeoutMs: Number.NaN }), TypeError);
  assert.throws(() => buildBoundedStatement('SELECT 1', { maxRows: 0 }), TypeError);
  assert.throws(() => buildBoundedStatement('SELECT 1', { maxRows: 2.5 }), TypeError);
});

test('executeReadOnlySql passes parameters through for parameterized lookups', async () => {
  const connection = createRecordingConnection();
  await executeReadOnlySql(connection, 'SELECT * FROM Product WHERE ProductName LIKE ? LIMIT ?', {
    timeoutMs: 1000,
    params: ['%water%', 20],
  });
  assert.deepEqual(connection.calls[0], {
    sql: 'SET STATEMENT max_statement_time=1.000 FOR SELECT * FROM Product WHERE ProductName LIKE ? LIMIT ?',
    params: ['%water%', 20],
  });
});

// A fake mysql2 promise pool: getConnection() hands out a dedicated connection
// whose query blocks until KILL QUERY <its threadId> arrives on the pool.
function createKillablePool({ killBehavior = 'kill' } = {}) {
  const events = [];
  let pending = null;
  const connection = {
    threadId: 42,
    released: false,
    destroyed: false,
    query(sql) {
      events.push(['query', sql]);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    release() {
      connection.released = true;
      events.push(['release']);
    },
    destroy() {
      connection.destroyed = true;
      events.push(['destroy']);
    },
  };
  const pool = {
    connection,
    events,
    async getConnection() {
      return connection;
    },
    query(sql) {
      events.push(['pool.query', sql]);
      if (killBehavior === 'hang') {
        return new Promise(() => {});
      }
      const error = Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED', errno: 1317 });
      pending?.reject(error);
      return Promise.resolve([{ affectedRows: 0 }]);
    },
    finish(rows) {
      pending?.resolve([rows]);
    },
  };
  return pool;
}

test('aborting the signal kills the running query via a separate pool connection', async () => {
  const pool = createKillablePool();
  const controller = new AbortController();
  const running = executeReadOnlySql(pool, 'SELECT SLEEP(10)', { timeoutMs: 8000, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort(Object.assign(new Error('deadline'), { code: 'REQUEST_TIMEOUT' }));

  await assert.rejects(running, (error) => error.name === 'AbortError' && error.code === 'REQUEST_TIMEOUT');
  // The caller is answered at once; the thread goes back once the KILL landed.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    pool.events.map(([kind]) => kind),
    ['query', 'pool.query', 'release']
  );
  assert.equal(pool.events[1][1], 'KILL QUERY 42');
  // The KILL landed before the connection went back to the pool.
  assert.equal(pool.connection.released, true);
  assert.equal(pool.connection.destroyed, false);
});

test('a KILL that does not settle never hands the thread back to the pool', async () => {
  const pool = createKillablePool({ killBehavior: 'hang' });
  const controller = new AbortController();
  const running = executeReadOnlySql(pool, 'SELECT SLEEP(10)', {
    timeoutMs: 8000,
    signal: controller.signal,
    killSettleTimeoutMs: 20,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  // The statement itself still finishes (e.g. at max_statement_time).
  pool.finish([{ late: true }]);

  // Rows that arrive after the abort are never returned as a result.
  await assert.rejects(running, { name: 'AbortError' });
  await delay(60);
  assert.equal(pool.connection.destroyed, true);
  assert.equal(pool.connection.released, false);
});

// A cancelled request settles at once; nothing it acquired is leaked.
function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const deadline = () => Object.assign(new Error('deadline'), { name: 'AbortError', code: 'REQUEST_TIMEOUT' });
const isDeadlineAbort = (error) => error.name === 'AbortError' && error.code === 'REQUEST_TIMEOUT';

test('the signal bounds the wait for a pool slot; a connection handed out after the abort is released unused', async () => {
  const events = [];
  const late = {
    threadId: 5,
    query() {
      events.push('query');
      return new Promise(() => {});
    },
    release() {
      events.push('release');
    },
    destroy() {
      events.push('destroy');
    },
  };
  let freeSlot;
  const pool = {
    getConnection() {
      events.push('getConnection');
      // Every slot is busy: the connection only arrives when one frees up.
      return new Promise((resolve) => {
        freeSlot = () => resolve(late);
      });
    },
    async query() {
      assert.fail('no pooled query');
    },
  };
  const controller = new AbortController();
  const running = executeReadOnlySql(pool, 'SELECT 1', { timeoutMs: 0, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(deadline());

  await assert.rejects(settlesWithin(running, 500), isDeadlineAbort);
  freeSlot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['getConnection', 'release'], 'the late connection goes straight back, unused');
});

test('a failed KILL does not hold the cancelled request open; the still-busy thread is dropped', async () => {
  const pool = createKillablePool({ killBehavior: 'hang' });
  // The dedicated KILL connection cannot be opened.
  pool.killQuery = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  };
  const controller = new AbortController();
  // No statement timeout: without the signal the read would wait forever.
  const running = executeReadOnlySql(pool, 'SELECT SLEEP(600)', { timeoutMs: 0, signal: controller.signal, killSettleTimeoutMs: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(deadline());

  await assert.rejects(settlesWithin(running, 500), isDeadlineAbort);
  await delay(60);
  // The statement is still running on that thread: never handed back.
  assert.equal(pool.connection.destroyed, true);
  assert.equal(pool.connection.released, false);
  pool.finish([{ late: true }]);
});

test('a read that throws synchronously still releases its pool connection', async () => {
  const events = [];
  const connection = {
    threadId: 8,
    query() {
      throw Object.assign(new Error('Can\'t add new command when connection is in closed state'), { code: 'PROTOCOL_ENQUEUE_AFTER_QUIT' });
    },
    release() {
      events.push('release');
    },
    destroy() {
      events.push('destroy');
    },
  };
  const pool = {
    async getConnection() {
      return connection;
    },
  };
  const controller = new AbortController();
  await assert.rejects(executeReadOnlySql(pool, 'SELECT 1', { timeoutMs: 0, signal: controller.signal }), {
    code: 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  });
  assert.deepEqual(events, ['release']);
});

test('a single connection read is bounded by the signal too', async () => {
  const connection = {
    query() {
      return new Promise(() => {});
    },
  };
  const controller = new AbortController();
  const running = executeReadOnlySql(connection, 'SELECT SLEEP(600)', { timeoutMs: 0, signal: controller.signal });
  controller.abort(deadline());
  await assert.rejects(settlesWithin(running, 500), isDeadlineAbort);
});

test('a completed query on a pool releases its connection without any KILL', async () => {
  const pool = createKillablePool();
  const controller = new AbortController();
  const running = executeReadOnlySql(pool, 'SELECT 1', { timeoutMs: 0, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  pool.finish([{ one: 1 }]);

  assert.deepEqual(await running, [{ one: 1 }]);
  assert.deepEqual(pool.events.map(([kind]) => kind), ['query', 'release']);
});

test('an already-aborted signal never reaches the database', async () => {
  const connection = createRecordingConnection();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeReadOnlySql(connection, 'SELECT 1', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(connection.calls.length, 0);
});

// --- Row cap while reading (explicit LIMIT overrides sql_select_limit) -------

// Minimal mysql2 core connection: query() returns an emitter that streams
// `total` rows one per tick (like MariaDB does when an explicit LIMIT in the
// SQL outranks sql_select_limit), or fails after `failAfter` rows.
function createStreamingCore({ total, failAfter = null }) {
  const core = { statements: [], emitted: 0, finished: false };
  core.query = (sql, params) => {
    core.statements.push(params === undefined ? sql : { sql, params });
    const query = new EventEmitter();
    let index = 0;
    const next = () => {
      if (failAfter !== null && index === failAfter) {
        core.finished = true;
        query.emit('error', Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' }));
        return;
      }
      if (index === total) {
        core.finished = true;
        query.emit('end');
        return;
      }
      index += 1;
      core.emitted = index;
      query.emit('result', { n: index });
      setImmediate(next);
    };
    setImmediate(next);
    return query;
  };
  return core;
}

function createStreamingPool(core) {
  const events = [];
  const connection = {
    threadId: 9,
    connection: core,
    release() {
      events.push('release');
    },
    destroy() {
      events.push('destroy');
    },
  };
  return {
    events,
    async getConnection() {
      events.push('getConnection');
      return connection;
    },
    async query() {
      throw new Error('a capped read must not use pool.query()');
    },
    async killQuery(threadId) {
      events.push(`kill ${threadId}`);
    },
  };
}

test('maxRows stops reading after maxRows rows even when the server sends more', async () => {
  const core = createStreamingCore({ total: 50 });
  const rows = await executeReadOnlySql({ connection: core, query: () => assert.fail('must stream') }, 'SELECT n FROM r LIMIT 50', {
    timeoutMs: 0,
    maxRows: 5,
  });
  assert.deepEqual(rows.map((row) => row.n), [1, 2, 3, 4, 5]);
  assert.equal(core.emitted, 6, 'resolved as soon as row maxRows + 1 arrived');
  assert.equal(core.statements[0], 'SET STATEMENT sql_select_limit=5 FOR SELECT n FROM r LIMIT 50');

  // A single connection drains the rest in the background, keeping none of it.
  while (!core.finished) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(rows.length, 5);
});

test('a pool drops the connection that overflowed the cap and releases one that did not', async () => {
  const overflowing = createStreamingPool(createStreamingCore({ total: 1000 }));
  const capped = await executeReadOnlySql(overflowing, 'SELECT n FROM r LIMIT 1000', { timeoutMs: 1000, maxRows: 3 });
  assert.equal(capped.length, 3);
  await new Promise((resolve) => setImmediate(resolve));
  // destroy() only half-closes the socket, so the statement is killed as well.
  assert.deepEqual(overflowing.events, ['getConnection', 'destroy', 'kill 9']);

  const fitting = createStreamingPool(createStreamingCore({ total: 2 }));
  assert.deepEqual(await executeReadOnlySql(fitting, 'SELECT n FROM r', { timeoutMs: 1000, maxRows: 3 }), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(fitting.events, ['getConnection', 'release']);
});

test('a streamed read rejects on a statement error before the cap and ignores one after it', async () => {
  const failing = createStreamingPool(createStreamingCore({ total: 10, failAfter: 2 }));
  await assert.rejects(executeReadOnlySql(failing, 'SELECT n FROM r', { timeoutMs: 1000, maxRows: 5 }), { code: 'ER_QUERY_INTERRUPTED' });
  assert.deepEqual(failing.events, ['getConnection', 'release']);

  // The error after the cap (e.g. the socket being dropped) is swallowed.
  const core = createStreamingCore({ total: 10, failAfter: 4 });
  const rows = await executeReadOnlySql({ connection: core, query: () => assert.fail('must stream') }, 'SELECT n FROM r', {
    timeoutMs: 0,
    maxRows: 2,
  });
  assert.equal(rows.length, 2);
  while (!core.finished) {
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('a buffered connection without the core API is still sliced to maxRows', async () => {
  const connection = {
    async query() {
      return [[{ n: 1 }, { n: 2 }, { n: 3 }]];
    },
  };
  assert.deepEqual(await executeReadOnlySql(connection, 'SELECT n FROM r LIMIT 3', { timeoutMs: 0, maxRows: 2 }), [{ n: 1 }, { n: 2 }]);
});

test('KILL QUERY uses the pool\'s dedicated killQuery() so a saturated pool cannot block it', async () => {
  const pool = createKillablePool({ killBehavior: 'hang' }); // every pool slot is busy
  const killed = [];
  pool.killQuery = async (threadId) => {
    killed.push(threadId);
    // The dedicated connection interrupts the running statement.
    pool.connection.interrupt();
  };
  pool.connection.query = (sql) => {
    pool.events.push(['query', sql]);
    return new Promise((_resolve, reject) => {
      pool.connection.interrupt = () =>
        reject(Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED', errno: 1317 }));
    });
  };
  const controller = new AbortController();
  const running = executeReadOnlySql(pool, 'SELECT SLEEP(10)', { timeoutMs: 8000, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, { name: 'AbortError' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(killed, [42]);
  assert.ok(!pool.events.some(([kind]) => kind === 'pool.query'), 'no pooled KILL');
  assert.equal(pool.connection.released, true);
});

test('a cancelled read that overflows the cap after a failed KILL is dropped, never handed back to the pool', async () => {
  // The statement keeps streaming after the abort (the KILL failed), and row
  // maxRows + 1 arrives well inside the KILL settle window.
  const core = { finished: false, stopped: false };
  core.query = () => {
    const query = new EventEmitter();
    let index = 0;
    const next = () => {
      if (core.stopped) {
        return;
      }
      if (index === 300) {
        core.finished = true;
        query.emit('end');
        return;
      }
      index += 1;
      query.emit('result', { n: index });
      setTimeout(next, 1);
    };
    setImmediate(next);
    return query;
  };
  const events = [];
  const connection = {
    threadId: 9,
    connection: core,
    release: () => events.push('release'),
    destroy: () => {
      events.push('destroy');
      core.stopped = true;
    },
  };
  const pool = {
    async getConnection() {
      return connection;
    },
    async killQuery() {
      throw Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR' });
    },
  };
  const controller = new AbortController();
  const running = executeReadOnlySql(pool, 'SELECT n FROM r LIMIT 5000', { timeoutMs: 0, maxRows: 6, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(deadline());

  await assert.rejects(settlesWithin(running, 500), isDeadlineAbort);
  await delay(60);
  assert.equal(core.finished, false, 'the statement is still streaming rows');
  assert.deepEqual(events, ['destroy'], 'a still-streaming thread must not go back to the pool');
  core.stopped = true;
});

// mysql2 reports a fatal error of a callback-less command (the server killed or
// dropped the connection) on the core connection, not on the query; a capped
// read must settle on it instead of hanging until the event loop drains.
function createDroppingCore({ rowsBeforeDrop = 1, how = 'error' } = {}) {
  const core = new EventEmitter();
  core.statements = [];
  core.query = (sql) => {
    core.statements.push(sql);
    const query = new EventEmitter();
    let index = 0;
    const next = () => {
      if (index === rowsBeforeDrop) {
        if (how === 'error') {
          core.emit('error', Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true }));
        } else {
          core.emit('end');
        }
        return; // the query itself never emits 'error' or 'end'
      }
      index += 1;
      query.emit('result', { n: index });
      setImmediate(next);
    };
    setImmediate(next);
    return query;
  };
  return core;
}

test('a capped read rejects when the connection is lost mid-read (error or end on the core connection)', async () => {
  for (const how of ['error', 'end']) {
    const core = createDroppingCore({ how });
    await assert.rejects(
      settlesWithin(executeReadOnlySql({ connection: core, query: () => assert.fail('must stream') }, 'SELECT SLEEP(3)', { timeoutMs: 0, maxRows: 5 }), 1000),
      { code: 'PROTOCOL_CONNECTION_LOST' },
      how
    );
    assert.equal(core.listenerCount('error'), 0, `${how}: connection listeners removed`);
    assert.equal(core.listenerCount('end'), 0);

    // On a pool connection too, and the connection is not handed back.
    const pool = createStreamingPool(createDroppingCore({ how }));
    await assert.rejects(settlesWithin(executeReadOnlySql(pool, 'SELECT SLEEP(3)', { timeoutMs: 0, maxRows: 5 }), 1000), { code: 'PROTOCOL_CONNECTION_LOST' }, how);
  }
});

test('a capped read on a connection that is already dead rejects at once, without sending the statement', async () => {
  const fatal = Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
  for (const [label, state, code] of [
    ['fatal error', { _fatalError: fatal }, 'PROTOCOL_CONNECTION_LOST'],
    ['protocol error', { _protocolError: fatal }, 'PROTOCOL_CONNECTION_LOST'],
    ['closing', { _closing: true }, 'PROTOCOL_CONNECTION_LOST'],
    ['socket destroyed', { stream: { destroyed: true } }, 'PROTOCOL_CONNECTION_LOST'],
  ]) {
    const core = Object.assign(createDroppingCore(), state);
    await assert.rejects(
      settlesWithin(executeReadOnlySql({ connection: core, query: () => assert.fail('must stream') }, 'SELECT 1', { timeoutMs: 0, maxRows: 5 }), 1000),
      { code },
      label
    );
    assert.deepEqual(core.statements, [], `${label}: nothing sent`);
  }

  // A core query() that throws synchronously rejects too.
  const throwing = new EventEmitter();
  throwing.query = () => {
    throw Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true });
  };
  await assert.rejects(settlesWithin(executeReadOnlySql({ connection: throwing }, 'SELECT 1', { timeoutMs: 0, maxRows: 5 }), 1000), /closed state/);
  assert.equal(throwing.listenerCount('error'), 0);
});

test('a completed capped read leaves no listener on the connection', async () => {
  const core = Object.assign(new EventEmitter(), createStreamingCore({ total: 2 }));
  for (let index = 0; index < 20; index += 1) {
    const local = createStreamingCore({ total: 2 });
    core.query = local.query;
    assert.equal((await executeReadOnlySql({ connection: core }, 'SELECT n FROM r', { timeoutMs: 0, maxRows: 5 })).length, 2);
  }
  assert.equal(core.listenerCount('error'), 0);
  assert.equal(core.listenerCount('end'), 0);
});
