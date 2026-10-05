import { loadEnvironment } from '../src/env.js';
import { writeFixtureMeta, writeFixtureRows } from '../src/eval/fixture-seeder.js';
import { buildFixtureRows, describeFixtureContent } from '../src/eval/fixtures.js';
import { createMariaDbConnection } from '../src/pipeline.js';

// The demo data (master data + the original facts) lives in
// src/eval/fixture-data.js, shared with the evaluation fixtures: this is the
// "seed" fixture, and `npm run seed-fixtures` writes the same rows to
// demo_retail plus two more fixture databases.
async function seedDemoDatabase(connection) {
  const rows = buildFixtureRows('seed');
  await writeFixtureRows(connection, rows);
  await writeFixtureMeta(connection, describeFixtureContent('seed', rows));
}

async function main() {
  const argv = process.argv.slice(2);
  const envInfo = await loadEnvironment(argv);
  // Seeding writes rows, so it uses the admin role (DB_ADMIN_USER /
  // DB_ADMIN_PASSWORD, default root / MARIADB_ROOT_PASSWORD), never the
  // SELECT-only query user.
  const connection = await createMariaDbConnection({ role: 'admin' });
  try {
    await seedDemoDatabase(connection);
  } finally {
    await connection.end();
  }
  console.log('Seeded public demo database from ' + (envInfo.path || 'environment variables') + '.');
}

main().catch((error) => {
  console.error('Demo seed failed: ' + error.message);
  process.exitCode = 1;
});
