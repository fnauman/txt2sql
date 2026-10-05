import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeQueryUserGrants,
  checkQueryUserPrivileges,
  createMariaDbConnection,
  createMariaDbPool,
  describeMariaDbConnectionTarget,
  reportQueryUserPrivileges,
  resolveMariaDbCredentials,
} from '../src/pipeline.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('query paths connect as DB_USER / DB_PASSWORD, defaulting to demo_readonly', () => {
  assert.deepEqual(
    pick(resolveMariaDbCredentials({ env: { DB_USER: 'reader', DB_PASSWORD: 'pw', DB_ADMIN_USER: 'root' } })),
    { role: 'query', user: 'reader', password: 'pw', fallback: false }
  );
  assert.equal(resolveMariaDbCredentials({ env: {} }).user, 'demo_readonly');
});

test('admin tasks use DB_ADMIN_* (default root / MARIADB_ROOT_PASSWORD)', () => {
  assert.deepEqual(
    pick(resolveMariaDbCredentials({ role: 'admin', env: { DB_USER: 'demo_readonly', MARIADB_ROOT_PASSWORD: 'rootpw' } })),
    { role: 'admin', user: 'root', password: 'rootpw', fallback: false }
  );
  assert.deepEqual(
    pick(
      resolveMariaDbCredentials({
        role: 'admin',
        env: { DB_ADMIN_USER: 'migrator', DB_ADMIN_PASSWORD: 'adminpw', MARIADB_ROOT_PASSWORD: 'rootpw' },
      })
    ),
    { role: 'admin', user: 'migrator', password: 'adminpw', fallback: false }
  );
  assert.throws(() => resolveMariaDbCredentials({ role: 'superuser', env: {} }), TypeError);
});

// docker-compose.yml initializes root with the first non-empty of these, and
// `${VAR:-...}` treats an empty value as unset; the app must agree with it.
test('admin password precedence matches docker-compose and blank values count as unset', () => {
  const admin = (env) => pick(resolveMariaDbCredentials({ role: 'admin', env }));
  assert.deepEqual(admin({ DB_ADMIN_PASSWORD: '', MARIADB_ROOT_PASSWORD: 'rootpw' }), {
    role: 'admin',
    user: 'root',
    password: 'rootpw',
    fallback: false,
  });
  assert.equal(admin({ DB_ADMIN_PASSWORD: 'adminpw', MARIADB_ROOT_PASSWORD: 'rootpw' }).password, 'adminpw');
  // Compose falls back to DB_PASSWORD for root's password; so does the app.
  assert.deepEqual(admin({ DB_ADMIN_USER: 'root', DB_USER: 'demo_readonly', DB_PASSWORD: 'secret' }), {
    role: 'admin',
    user: 'root',
    password: 'secret',
    fallback: false,
  });
  assert.equal(admin({ DB_ADMIN_USER: '  ', MARIADB_ROOT_PASSWORD: 'rootpw' }).user, 'root');

  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /MARIADB_ROOT_PASSWORD: "\$\{DB_ADMIN_PASSWORD:-\$\{MARIADB_ROOT_PASSWORD:-\$\{DB_PASSWORD:-secret\}\}\}"/);
});

test('an old single-user .env with blank DB_ADMIN_* placeholders still falls back to DB_USER', () => {
  const env = { DB_USER: 'root', DB_PASSWORD: 'secret', DB_ADMIN_USER: '', DB_ADMIN_PASSWORD: '', MARIADB_ROOT_PASSWORD: ' ' };
  assert.deepEqual(pick(resolveMariaDbCredentials({ role: 'admin', env })), {
    role: 'admin',
    user: 'root',
    password: 'secret',
    fallback: true,
  });
});

test('without admin credentials, admin tasks fall back to DB_USER with a warning', async () => {
  const env = { DB_USER: 'root', DB_PASSWORD: 'secret', DB_NAME: 'demo_retail', DB_HOST: '127.0.0.1', DB_PORT: '3306' };
  assert.deepEqual(pick(resolveMariaDbCredentials({ role: 'admin', env })), {
    role: 'admin',
    user: 'root',
    password: 'secret',
    fallback: true,
  });

  const warnings = [];
  const connected = [];
  // The connector is injected: no socket is opened.
  const connection = await createMariaDbConnection({
    role: 'admin',
    env,
    warn: (message) => warnings.push(message),
    connect: async (options) => {
      connected.push(options);
      return { fake: true };
    },
  });
  assert.deepEqual(connection, { fake: true });
  assert.equal(connected[0].user, 'root');
  assert.equal(connected[0].password, 'secret');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No admin credentials configured.*falling back to DB_USER "root"/);
});

test('access denied for demo_readonly explains that the user is provisioned on first volume init', async () => {
  const denied = Object.assign(new Error("Access denied for user 'demo_readonly'@'172.17.0.1'"), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 });
  const env = { DB_NAME: 'demo_retail', DB_PASSWORD: 'x' };
  await assert.rejects(createMariaDbConnection({ env, connect: async () => Promise.reject(denied) }), (error) => {
    assert.equal(error.code, 'ER_ACCESS_DENIED_ERROR');
    assert.match(error.message, /access denied for user "demo_readonly"\. Check DB_USER and DB_PASSWORD\./);
    assert.match(error.message, /first initialized.*docker compose down -v/);
    return true;
  });
  await assert.rejects(createMariaDbConnection({ env: { ...env, DB_USER: 'reader' }, connect: async () => Promise.reject(denied) }), (error) => {
    assert.doesNotMatch(error.message, /docker compose down -v/);
    return true;
  });
});

test('missing settings fail with a typed DB_NOT_CONFIGURED error', async () => {
  await assert.rejects(createMariaDbConnection({ env: {} }), (error) => {
    assert.equal(error.code, 'DB_NOT_CONFIGURED');
    assert.match(error.message, /DB_NAME/);
    return true;
  });
  await assert.rejects(createMariaDbConnection({ role: 'admin', includeDatabase: false, env: {}, warn: () => {} }), {
    code: 'DB_NOT_CONFIGURED',
  });
  assert.throws(() => createMariaDbPool({ env: {} }), { code: 'DB_NOT_CONFIGURED' });
});

test('describeMariaDbConnectionTarget reports the role and the user it would use', () => {
  const env = { DB_USER: 'demo_readonly', DB_NAME: 'demo_retail', MARIADB_ROOT_PASSWORD: 'x', DB_HOST: 'db', DB_PORT: '3307' };
  assert.deepEqual(describeMariaDbConnectionTarget({ env }), {
    role: 'query',
    user: 'demo_readonly',
    database: 'demo_retail',
    socketPath: null,
    host: 'db',
    port: 3307,
  });
  assert.equal(describeMariaDbConnectionTarget({ env, role: 'admin', includeDatabase: false }).user, 'root');
});

// Real SHOW GRANTS output captured from the docker/mariadb/initdb user on
// MariaDB 10.6, plus typical over-privileged setups.
const READONLY_GRANTS = [
  "GRANT USAGE ON *.* TO `demo_readonly`@`%` IDENTIFIED BY PASSWORD '*455F5810F8C6DB4FA5AAF5EB8E463D9058E3FE18'",
  'GRANT SELECT ON `demo\\_retail%`.* TO `demo_readonly`@`%`',
];

test('analyzeQueryUserGrants accepts a SELECT-only user', () => {
  const report = analyzeQueryUserGrants(READONLY_GRANTS);
  assert.equal(report.ok, true);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.privileges[1], { on: '`demo\\_retail%`.*', privileges: ['SELECT'] });
});

test('analyzeQueryUserGrants warns about anything beyond SELECT/USAGE', () => {
  const root = analyzeQueryUserGrants([
    "GRANT ALL PRIVILEGES ON *.* TO `root`@`%` IDENTIFIED BY PASSWORD '*hash' WITH GRANT OPTION",
    "GRANT PROXY ON ''@'%' TO 'root'@'%' WITH GRANT OPTION",
  ]);
  assert.equal(root.ok, false);
  assert.ok(root.warnings.some((warning) => /ALL PRIVILEGES on \*\.\*/.test(warning)));
  assert.ok(root.warnings.some((warning) => /GRANT OPTION/.test(warning)));
  assert.ok(root.warnings.some((warning) => /PROXY/.test(warning)));

  const writer = analyzeQueryUserGrants([
    'GRANT FILE, SUPER ON *.* TO `app`@`%`',
    'GRANT SELECT, INSERT, UPDATE (CustomerName) ON `demo_retail`.* TO `app`@`%`',
  ]);
  assert.ok(writer.warnings.some((warning) => /FILE, SUPER on \*\.\*/.test(warning)));
  assert.ok(writer.warnings.some((warning) => /INSERT, UPDATE on `demo_retail`\.\*/.test(warning)));

  const everywhere = analyzeQueryUserGrants(['GRANT SELECT ON *.* TO `reader`@`%`']);
  assert.equal(everywhere.ok, false);
  assert.match(everywhere.warnings[0], /every database, including the mysql system schema/);

  const role = analyzeQueryUserGrants(['GRANT `analyst` TO `reader`@`%`']);
  assert.match(role.warnings[0], /Role `analyst` is granted/);
});

// Real SHOW GRANTS lines from MariaDB 10.6 for users that could read
// mysql.global_priv (password hashes) while holding "only SELECT".
test('analyzeQueryUserGrants flags SELECT that reaches system schemas through wildcards or schema/table grants', () => {
  const shapes = {
    everyDatabase: 'GRANT SELECT ON `%`.* TO `g_pct`@`%`',
    mysqlSchema: 'GRANT SELECT ON `mysql`.* TO `g_mysql`@`%`',
    mysqlTable: 'GRANT SELECT ON `mysql`.`global_priv` TO `g_tbl`@`%`',
    mysqlColumns: 'GRANT SELECT (`User`) ON `mysql`.`user` TO `g_tbl`@`%`',
    prefixWildcard: 'GRANT SELECT ON `my%`.* TO `x`@`%`',
  };
  for (const [name, grant] of Object.entries(shapes)) {
    for (const options of [{}, { database: 'demo_retail' }]) {
      const report = analyzeQueryUserGrants([READONLY_GRANTS[0], READONLY_GRANTS[1], grant], options);
      assert.equal(report.ok, false, name);
      assert.equal(report.warnings.length, 1, name);
      assert.match(report.warnings[0], /reaches the mysql system schema/, name);
    }
  }
});

test('with DB_NAME given, SELECT on other databases is flagged; the demo_retail family is not', () => {
  const check = (grant, database = 'demo_retail') => analyzeQueryUserGrants([READONLY_GRANTS[0], grant], { database }).warnings;
  assert.match(check('GRANT SELECT ON `other_db`.* TO `x`@`%`')[0], /`other_db`\.\* is a database other than DB_NAME \(demo_retail\)/);
  assert.match(check('GRANT SELECT ON `demo%`.* TO `x`@`%`')[0], /matches databases beyond DB_NAME/);
  assert.match(check('GRANT SELECT ON `hr`.`salaries` TO `x`@`%`')[0], /database other than DB_NAME/);
  for (const grant of [
    'GRANT SELECT ON `demo\\_retail%`.* TO `x`@`%`',
    'GRANT SELECT ON `demo_retail`.* TO `x`@`%`',
    'GRANT SELECT ON `demo_retail_v2`.* TO `x`@`%`',
    'GRANT SELECT ON `demo_retail`.`Customer` TO `x`@`%`',
  ]) {
    assert.deepEqual(check(grant), [], grant);
  }
  // A non-demo deployment reading its own database is fine.
  assert.deepEqual(check('GRANT SELECT ON `erp`.* TO `x`@`%`', 'erp'), []);
  assert.deepEqual(check('GRANT SELECT ON `ERP`.`Orders` TO `x`@`%`', 'erp'), []);
  // DB_NAME is compared as a whole name, not a prefix.
  assert.match(check('GRANT SELECT ON `erpbackup`.* TO `x`@`%`', 'erp')[0], /is a database other than DB_NAME \(erp\)/);
  assert.match(check('GRANT SELECT ON `erp%`.* TO `x`@`%`', 'erp')[0], /matches databases beyond DB_NAME \(erp\)/);
  // Without DB_NAME only the system-schema and *.* checks apply.
  assert.deepEqual(analyzeQueryUserGrants([READONLY_GRANTS[0], 'GRANT SELECT ON `other_db`.* TO `x`@`%`']).warnings, []);
});

test('checkQueryUserPrivileges runs SHOW GRANTS and redacts password hashes', async () => {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(sql);
      return [READONLY_GRANTS.map((grant) => ({ 'Grants for demo_readonly@%': grant }))];
    },
  };
  const report = await checkQueryUserPrivileges(connection, { database: 'demo_retail' });
  assert.deepEqual(calls, ['SHOW GRANTS']);
  assert.equal(report.ok, true);
  assert.match(report.grants[0], /IDENTIFIED BY PASSWORD '<redacted>'/);
  assert.doesNotMatch(report.grants.join('\n'), /455F5810/);
});

test('reportQueryUserPrivileges prints warnings to the given log and never throws', async () => {
  const lines = [];
  await reportQueryUserPrivileges(
    { async query() { return [[{ g: 'GRANT ALL PRIVILEGES ON *.* TO `root`@`%`' }]]; } },
    { log: (line) => lines.push(line) }
  );
  assert.match(lines[0], /^\[db\] warning: ALL PRIVILEGES/);

  const failing = [];
  const report = await reportQueryUserPrivileges(
    { async query() { throw new Error('denied'); } },
    { log: (line) => failing.push(line) }
  );
  assert.equal(report, null);
  assert.match(failing[0], /could not check/);
});

// The init script is the provisioning half of the DB boundary; keep its grant
// and its compose wiring from drifting.
test('docker init script grants only SELECT on demo_retail* and compose mounts it read-only', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'docker/mariadb/initdb/01-readonly-user.sh'), 'utf8');
  assert.match(script, /GRANT SELECT ON \\`demo\\\\_retail%\\`\.\* TO/);
  assert.doesNotMatch(script, /GRANT\s+(ALL|FILE|INSERT|UPDATE|DELETE|CREATE|DROP|SUPER)/i);
  assert.match(script, /DB_READONLY_PASSWORD is required/);

  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /\.\/docker\/mariadb\/initdb:\/docker-entrypoint-initdb\.d:ro/);
  assert.match(compose, /DB_READONLY_USER: "\$\{DB_READONLY_USER:-demo_readonly\}"/);
  // Compose refuses to start without a query-user password (a failed init
  // would leave a half-initialized volume that later starts without the user).
  // Pure interpolation only: no literal text in a password-named value.
  assert.match(compose, /DB_READONLY_PASSWORD: "\$\{DB_READONLY_PASSWORD:-\$\{DB_PASSWORD:\?\}\}"/);
});

function pick(credentials) {
  return { role: credentials.role, user: credentials.user, password: credentials.password, fallback: credentials.fallback };
}
