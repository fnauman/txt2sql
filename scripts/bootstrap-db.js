import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasOptionFlag, loadEnvironment } from '../src/env.js';
import { buildBootstrapPlan } from '../src/mariadb-bootstrap.js';
import { createMariaDbConnection, loadNarrowSchema } from '../src/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

async function main() {
  const argv = process.argv.slice(2);
  const envInfo = await loadEnvironment(argv);
  const refreshSchema = hasOptionFlag(argv, '--refresh-schema');
  const dropExisting = hasOptionFlag(argv, '--drop-existing');
  const printSql = hasOptionFlag(argv, '--print-sql');

  if (!process.env.DB_NAME) {
    throw new Error('DB_NAME is required to bootstrap the MariaDB schema.');
  }

  const schema = await loadNarrowSchema({
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    refreshSchema,
  });

  const bootstrapPlan = buildBootstrapPlan(schema, process.env.DB_NAME, { dropExisting });

  console.log(`Environment: ${envInfo.path || 'not found'}`);
  console.log(`Target database: ${process.env.DB_NAME}`);
  console.log(`Tables: ${schema.tables.map((table) => table.tableName).join(', ')}`);
  if (bootstrapPlan.adjustments.length > 0) {
    console.log(`Wide-table adjustments: ${bootstrapPlan.adjustments.length} table(s) had oversized VARCHAR columns downgraded to TEXT for MariaDB compatibility.`);
  }

  if (printSql) {
    console.log('\n' + bootstrapPlan.statements.join('\n\n'));
    return;
  }

  const connection = await createMariaDbConnection({ includeDatabase: false });
  try {
    for (const statement of bootstrapPlan.statements) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }

  console.log('\nBootstrap complete.');
  console.log(`Created or verified ${schema.tables.length} tables in ${process.env.DB_NAME}.`);
}

main().catch((error) => {
  console.error(`Bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});
