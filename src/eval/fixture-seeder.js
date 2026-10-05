// Writes evaluation fixtures (src/eval/fixtures.js) into MariaDB. Needs the
// admin role: it creates databases and tables and replaces rows. The query
// user only reads them (SELECT on `demo\_retail%` covers every fixture).

import { buildBootstrapPlan } from '../mariadb-bootstrap.js';
import { PRIMARY_KEYS, SEEDED_TABLES, TABLE_COLUMNS } from './fixture-data.js';
import {
  FIXTURE_GENERATOR_VERSION,
  FIXTURE_META_TABLE,
  buildFixtureRows,
  describeFixtureContent,
  fixtureContentHash,
} from './fixtures.js';

const INSERT_BATCH_SIZE = 200;

export function quoteIdentifier(value) {
  return '`' + String(value).replace(/`/g, '``') + '`';
}

async function insertRows(connection, table, columns, rows) {
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
    const columnSql = columns.map(quoteIdentifier).join(', ');
    const placeholders = batch.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
    const params = batch.flatMap((row) => columns.map((column) => row[column] ?? null));
    await connection.query(`INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES ${placeholders}`, params);
  }
}

/**
 * Replaces every seeded table's rows in the connection's current database with
 * `rows` (one transaction; FK checks off while the tables are swapped).
 */
export async function writeFixtureRows(connection, rows) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await connection.query('START TRANSACTION');
    try {
      for (const table of [...SEEDED_TABLES].reverse()) {
        await connection.query(`DELETE FROM ${quoteIdentifier(table)}`);
      }
      for (const table of SEEDED_TABLES) {
        await insertRows(connection, table, TABLE_COLUMNS[table], rows[table] || []);
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/** Records which content a database holds (one row, replaced on every seed). */
export async function writeFixtureMeta(connection, description) {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(FIXTURE_META_TABLE)} (
  \`name\` VARCHAR(32) NOT NULL,
  \`content_hash\` CHAR(64) NOT NULL,
  \`generator_version\` VARCHAR(32) NOT NULL,
  \`prng_seed\` BIGINT NULL,
  \`row_counts\` TEXT NOT NULL,
  \`created_at\` DATETIME NOT NULL,
  PRIMARY KEY (\`name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await connection.query(`DELETE FROM ${quoteIdentifier(FIXTURE_META_TABLE)}`);
  await connection.query(
    `INSERT INTO ${quoteIdentifier(FIXTURE_META_TABLE)} (\`name\`, \`content_hash\`, \`generator_version\`, \`prng_seed\`, \`row_counts\`, \`created_at\`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [description.name, description.contentHash, description.generatorVersion, description.prngSeed, JSON.stringify(description.rowCounts)]
  );
}

/**
 * The meta row of `database` (or of the connection's current database), or
 * null when the database has no meta table (e.g. seeded by an older script).
 */
export async function readFixtureMeta(connection, database = null) {
  const table = database ? `${quoteIdentifier(database)}.${quoteIdentifier(FIXTURE_META_TABLE)}` : quoteIdentifier(FIXTURE_META_TABLE);
  try {
    const [rows] = await connection.query(
      `SELECT \`name\`, \`content_hash\`, \`generator_version\`, \`prng_seed\`, \`row_counts\`, \`created_at\` FROM ${table}`
    );
    const [row] = rows;
    if (!row) {
      return null;
    }
    return {
      name: row.name,
      contentHash: row.content_hash,
      generatorVersion: row.generator_version,
      prngSeed: row.prng_seed == null ? null : Number(row.prng_seed),
      rowCounts: JSON.parse(row.row_counts || '{}'),
      createdAt: row.created_at,
    };
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }
}

/** Every seeded table of `database`, read back in primary-key order. */
export async function readFixtureTables(connection, database) {
  const tables = {};
  for (const table of SEEDED_TABLES) {
    const columns = TABLE_COLUMNS[table].map(quoteIdentifier).join(', ');
    const [rows] = await connection.query(
      `SELECT ${columns} FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(PRIMARY_KEYS[table])}`
    );
    tables[table] = rows;
  }
  return tables;
}

/**
 * Compares a fixture database's meta row with the content the code would
 * generate today. Returns { status: 'current' | 'stale' | 'missing', ... }.
 */
export async function checkFixtureMeta(connection, fixture, { expected = describeFixtureContent(fixture.name) } = {}) {
  const meta = await readFixtureMeta(connection, fixture.database);
  if (!meta) {
    return { status: 'missing', expected, meta: null };
  }
  const current = meta.name === fixture.name && meta.contentHash === expected.contentHash;
  return { status: current ? 'current' : 'stale', expected, meta };
}

/**
 * Idempotently creates, bootstraps and seeds one fixture database: CREATE
 * DATABASE / TABLE IF NOT EXISTS from the compiled schema, then (unless the
 * meta row already records this exact content and `force` is off) replaces
 * the rows and the meta row. `connection` must be an admin connection; the
 * schema comes from loadNarrowSchema. Returns what happened.
 */
export async function seedFixture(connection, fixture, { schema, force = false } = {}) {
  if (!schema || !Array.isArray(schema.tables)) {
    throw new Error('seedFixture needs the compiled schema (loadNarrowSchema).');
  }

  for (const statement of buildBootstrapPlan(schema, fixture.database).statements) {
    await connection.query(statement);
  }

  const rows = buildFixtureRows(fixture.name);
  const description = describeFixtureContent(fixture.name, rows);
  if (!force) {
    const meta = await readFixtureMeta(connection, fixture.database);
    const counts = meta ? await countSeededRows(connection, fixture.database) : null;
    if (
      meta &&
      meta.name === fixture.name &&
      meta.contentHash === description.contentHash &&
      meta.generatorVersion === FIXTURE_GENERATOR_VERSION &&
      SEEDED_TABLES.every((table) => counts[table] === description.rowCounts[table])
    ) {
      return { fixture: fixture.name, database: fixture.database, action: 'unchanged', ...description };
    }
  }

  await connection.query(`USE ${quoteIdentifier(fixture.database)}`);
  await writeFixtureRows(connection, rows);
  await writeFixtureMeta(connection, description);
  return { fixture: fixture.name, database: fixture.database, action: 'seeded', ...description };
}

async function countSeededRows(connection, database) {
  const counts = {};
  for (const table of SEEDED_TABLES) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)}`);
    counts[table] = Number(row.n);
  }
  return counts;
}

/** Hash of what a database actually holds (deep check, reads every row). */
export async function hashFixtureDatabase(connection, database) {
  return fixtureContentHash(await readFixtureTables(connection, database));
}
