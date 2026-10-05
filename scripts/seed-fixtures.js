// Create, bootstrap and seed every evaluation fixture database from code:
// demo_retail (seed), demo_retail_v2 and demo_retail_v3 (src/eval/fixtures.js).
// All three share the same master data and differ only in the fact tables.
// Idempotent: a database whose rows already hash to the content the code
// generates (and whose _fixture_meta row records it) is left alone; any other
// database, including one whose rows were edited after seeding, is rewritten
// (pass --force to rewrite it anyway).
//
// Uses the admin role (DB_ADMIN_USER / DB_ADMIN_PASSWORD, default root /
// MARIADB_ROOT_PASSWORD); the SELECT-only query user can read every fixture
// through its `demo\_retail%` grant.
//
// Usage:
//   npm run seed-fixtures
//   npm run seed-fixtures -- --fixtures v2,v3 --force
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_USAGE, getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import { seedFixture } from '../src/eval/fixture-seeder.js';
import { resolveFixtures } from '../src/eval/fixtures.js';
import { createMariaDbConnection, describeMariaDbConnectionTarget, loadNarrowSchema } from '../src/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

const USAGE = `Usage: npm run seed-fixtures -- [--fixtures seed,v2,v3] [--force] [--refresh-schema]
${ENV_USAGE}`;

export async function main(argv = process.argv.slice(2)) {
  if (hasOptionFlag(argv, '--help')) {
    console.log(USAGE);
    return;
  }

  const envInfo = await loadEnvironment(argv);
  const fixtures = resolveFixtures(getOptionValue(argv, '--fixtures'));
  const force = hasOptionFlag(argv, '--force');
  const schema = await loadNarrowSchema({
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    refreshSchema: hasOptionFlag(argv, '--refresh-schema'),
  });

  const target = describeMariaDbConnectionTarget({ includeDatabase: false, role: 'admin' });
  console.log(`Environment: ${envInfo.path || 'environment variables'}`);
  console.log(`Admin user: ${target.user || '(unset)'} at ${target.socketPath || `${target.host}:${target.port}`}`);

  const connection = await createMariaDbConnection({ includeDatabase: false, role: 'admin' });
  try {
    for (const fixture of fixtures) {
      const result = await seedFixture(connection, fixture, { schema, force });
      const counts = result.rowCounts;
      console.log(
        `  ${result.action === 'seeded' ? 'seeded   ' : 'unchanged'} ${fixture.name.padEnd(4)} ${fixture.database.padEnd(15)} ` +
          `docs=${counts.SalesDocument} lines=${counts.SalesDocumentLine} postings=${counts.AccountingPosting} ` +
          `hash=${result.contentHash.slice(0, 12)}`
      );
    }
  } finally {
    await connection.end();
  }

  if (process.env.DB_NAME && !fixtures.some((fixture) => fixture.database === process.env.DB_NAME)) {
    console.log(
      `\nNote: DB_NAME is ${process.env.DB_NAME}; the evaluation oracle reads the fixture databases above, ` +
        'and the product loop runs on the primary fixture (demo_retail).'
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`Fixture seeding failed: ${error.message}`);
    process.exitCode = 1;
  });
}
