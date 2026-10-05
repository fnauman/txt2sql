import assert from 'node:assert/strict';
import test from 'node:test';

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

  // Completed rows are still returned to the caller, who checks the signal.
  assert.deepEqual(await running, [{ late: true }]);
  assert.equal(pool.connection.destroyed, true);
  assert.equal(pool.connection.released, false);
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
