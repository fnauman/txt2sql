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

test('without admin credentials, admin tasks fall back to DB_USER with a warning', async () => {
  const env = { DB_USER: 'root', DB_PASSWORD: 'secret', DB_NAME: 'demo_retail', DB_HOST: '127.0.0.1', DB_PORT: '1' };
  assert.deepEqual(pick(resolveMariaDbCredentials({ role: 'admin', env })), {
    role: 'admin',
    user: 'root',
    password: 'secret',
    fallback: true,
  });

  const warnings = [];
  // Port 1 refuses the connection; the warning is printed before connecting.
  await assert.rejects(createMariaDbConnection({ role: 'admin', env, warn: (message) => warnings.push(message) }), {
    code: 'ECONNREFUSED',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No admin credentials configured.*falling back to DB_USER "root"/);
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

test('checkQueryUserPrivileges runs SHOW GRANTS and redacts password hashes', async () => {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(sql);
      return [READONLY_GRANTS.map((grant) => ({ 'Grants for demo_readonly@%': grant }))];
    },
  };
  const report = await checkQueryUserPrivileges(connection);
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
  assert.match(compose, /DB_READONLY_PASSWORD: "\$\{DB_READONLY_PASSWORD:-\$\{DB_PASSWORD:-\}\}"/);
});

function pick(credentials) {
  return { role: credentials.role, user: credentials.user, password: credentials.password, fallback: credentials.fallback };
}
