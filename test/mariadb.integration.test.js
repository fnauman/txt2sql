import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkQueryUserPrivileges,
  createMariaDbConnection,
  createMariaDbPool,
  executeReadOnlySql,
} from '../src/pipeline.js';

// Opt-in checks against a real MariaDB (skipped by default). Point them at the
// docker-compose database after `docker compose up -d mariadb`:
//
//   TEST_MARIADB_PORT=3306 TEST_MARIADB_PASSWORD=<DB_PASSWORD> \
//     node --test test/mariadb.integration.test.js
//
// Optional: TEST_MARIADB_HOST (127.0.0.1), TEST_MARIADB_USER (demo_readonly),
// TEST_MARIADB_DATABASE (demo_retail). Only read-only statements are run; the
// row sets come from recursive CTEs, so no fixture data is needed.

const configured = Boolean(process.env.TEST_MARIADB_PORT);
const skip = configured ? false : 'set TEST_MARIADB_PORT (and TEST_MARIADB_PASSWORD) to run against a real MariaDB';

const env = {
  DB_HOST: process.env.TEST_MARIADB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_MARIADB_PORT,
  DB_USER: process.env.TEST_MARIADB_USER || 'demo_readonly',
  DB_PASSWORD: process.env.TEST_MARIADB_PASSWORD,
  DB_NAME: process.env.TEST_MARIADB_DATABASE || 'demo_retail',
};

const numbers = (count) => `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ${count}) `;

test('sql_select_limit caps only the outermost result and keeps ORDER BY', { skip }, async () => {
  const connection = await createMariaDbConnection({ env });
  try {
    const capped = await executeReadOnlySql(connection, `${numbers(50)}SELECT n FROM r ORDER BY n DESC`, { maxRows: 5 });
    assert.deepEqual(capped.map((row) => row.n), [50, 49, 48, 47, 46]);

    // Inner query blocks still see every row.
    const counted = await executeReadOnlySql(connection, `${numbers(50)}SELECT COUNT(*) AS c FROM (SELECT n FROM r) AS x`, { maxRows: 5 });
    assert.equal(Number(counted[0].c), 50);
    const scalar = await executeReadOnlySql(connection, `${numbers(50)}SELECT (SELECT COUNT(*) FROM r) AS c`, { maxRows: 5 });
    assert.equal(Number(scalar[0].c), 50);

    // An explicit LIMIT in the query takes precedence over the cap.
    const explicit = await executeReadOnlySql(connection, `${numbers(50)}SELECT n FROM r LIMIT 20`, { maxRows: 5 });
    assert.equal(explicit.length, 20);

    // The cap does not leak into the next statement on the same connection.
    const after = await executeReadOnlySql(connection, `${numbers(50)}SELECT n FROM r`, { timeoutMs: 0 });
    assert.equal(after.length, 50);
  } finally {
    await connection.end();
  }
});

test('the statement timeout and KILL-on-abort stop a long query', { skip }, async () => {
  const pool = createMariaDbPool({ env, connectionLimit: 2 });
  // max_recursive_iterations caps a single CTE (1000 by default on 10.6), so
  // the long-running statement is a cross join (1000^4 rows).
  const endless = `${numbers(1000)}SELECT COUNT(*) AS c FROM r a, r b, r c, r d`;
  try {
    const started = Date.now();
    await assert.rejects(executeReadOnlySql(pool, endless, { timeoutMs: 300 }), (error) => error.errno === 1969);
    assert.ok(Date.now() - started < 5000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(Object.assign(new Error('deadline'), { code: 'REQUEST_TIMEOUT' })), 200);
    await assert.rejects(
      executeReadOnlySql(pool, endless, { timeoutMs: 60_000, signal: controller.signal }),
      (error) => error.code === 'REQUEST_TIMEOUT' && error.cause?.code === 'ER_QUERY_INTERRUPTED'
    );
    assert.deepEqual(await executeReadOnlySql(pool, 'SELECT 1 AS ok'), [{ ok: 1 }], 'the pool stays usable');
  } finally {
    await pool.end();
  }
});

test('the query user is least-privilege', { skip }, async () => {
  const connection = await createMariaDbConnection({ env });
  try {
    const report = await checkQueryUserPrivileges(connection);
    assert.deepEqual(report.warnings, [], report.grants.join('\n'));
    const [rows] = await connection.query("SELECT LOAD_FILE('/etc/passwd') AS f");
    assert.equal(rows[0].f, null, 'no FILE privilege');
    await assert.rejects(connection.query('CREATE TABLE txt2sql_should_not_exist (id INT)'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await assert.rejects(connection.query('SELECT User FROM mysql.user'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
  } finally {
    await connection.end();
  }
});
