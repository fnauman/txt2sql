// Environment setup for `npm run eval`: make the database reachable (starting
// the docker-compose MariaDB when it is local and down) and make every fixture
// database hold exactly the generated content (seeding with the admin role).
// Every failure here is a harness failure (exit code 2) with a message that
// says what to set or run.

import { spawn } from 'node:child_process';

import { checkFixtureContent, seedFixture } from './fixture-seeder.js';
import { describeFixtureContent } from './fixtures.js';
import { createMariaDbConnection, describeMariaDbConnectionTarget, resolveMariaDbCredentials } from '../pipeline.js';
import { errorCodeOf } from '../query-service.js';

/** A failure of the harness, dataset or infrastructure (never the model's). */
export class HarnessError extends Error {
  constructor(message, { code = 'HARNESS_ERROR', cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HarnessError';
    this.code = code;
    this.exitCode = 2;
  }
}

// Errors that mean "nothing is listening (yet)", as opposed to a server that
// answered and refused us.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOENT',
  'PROTOCOL_CONNECTION_LOST',
  'ER_SERVER_SHUTDOWN',
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function nonBlank(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function describeTarget(env) {
  const target = describeMariaDbConnectionTarget({ includeDatabase: false, role: 'query', env });
  return target.socketPath ? `socket ${target.socketPath}` : `${target.host}:${target.port}`;
}

/** Connects as the query user and runs SELECT 1. */
export async function probeDatabase({ env = process.env, connect = createMariaDbConnection } = {}) {
  let connection = null;
  try {
    connection = await connect({ includeDatabase: false, role: 'query', env, warn: () => {} });
    await connection.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, error, code: errorCodeOf(error) };
  } finally {
    await connection?.end?.().catch(() => {});
  }
}

/**
 * What docker-compose.yml needs from the environment to create a usable
 * database (it refuses to start without a read-only user password), as
 * human-readable problems (empty when fine).
 */
export function composeEnvProblems(env = process.env) {
  const problems = [];
  if (!nonBlank(env.DB_PASSWORD) && !nonBlank(env.DB_READONLY_PASSWORD)) {
    problems.push(
      'DB_PASSWORD is not set: docker-compose.yml creates the read-only query user (demo_readonly) with it, and the evaluation connects with it'
    );
  } else if (!nonBlank(env.DB_PASSWORD)) {
    problems.push('DB_PASSWORD is not set: the evaluation connects as the query user with DB_PASSWORD (set it to DB_READONLY_PASSWORD)');
  } else if (nonBlank(env.DB_READONLY_PASSWORD) && env.DB_READONLY_PASSWORD !== env.DB_PASSWORD) {
    problems.push('DB_READONLY_PASSWORD differs from DB_PASSWORD: compose would create the query user with a password the evaluation does not use');
  }
  if (nonBlank(env.DB_USER) && env.DB_USER !== (env.DB_READONLY_USER || 'demo_readonly')) {
    problems.push(`DB_USER is "${env.DB_USER}", but compose provisions the query user "${env.DB_READONLY_USER || 'demo_readonly'}"`);
  }
  return problems;
}

/** Runs a command with its output on stderr (or discarded when quiet); resolves { code }. */
export function runCommand(command, args, { cwd, env, quiet = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: quiet ? 'ignore' : ['ignore', 2, 2] });
    } catch (error) {
      resolve({ code: null, error });
      return;
    }
    child.on('error', (error) => resolve({ code: null, error }));
    child.on('close', (code) => resolve({ code }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Makes sure MariaDB answers as the query user. When it does not answer at a
 * local address and Docker is allowed and available, runs
 * `docker compose up -d --wait mariadb` (the repo's docker-compose.yml) and
 * waits until it answers (bounded). Returns { status: 'reachable' | 'started' }.
 */
export async function preflightDatabase({
  env = process.env,
  allowDocker = true,
  repoRoot = process.cwd(),
  log = () => {},
  connect = createMariaDbConnection,
  run = runCommand,
  waitTimeoutMs = 120_000,
  pollMs = 2_000,
  wait = sleep,
} = {}) {
  const first = await probeDatabase({ env, connect });
  if (first.ok) {
    return { status: 'reachable' };
  }
  const target = describeTarget(env);
  if (first.code === 'DB_NOT_CONFIGURED') {
    throw new HarnessError(first.error.message, { code: 'DB_NOT_CONFIGURED', cause: first.error });
  }
  if (!UNREACHABLE_CODES.has(first.code)) {
    throw new HarnessError(`MariaDB at ${target} answered but the query user cannot run queries: ${first.error.message}`, {
      code: first.code || 'DB_UNUSABLE',
      cause: first.error,
    });
  }
  const hint = 'Start it with "docker compose up -d --wait mariadb", or point DB_HOST / DB_PORT at a running server.';
  if (!allowDocker) {
    throw new HarnessError(`MariaDB is not reachable at ${target} (${first.code}). ${hint}`, { code: 'DB_UNREACHABLE', cause: first.error });
  }
  if (nonBlank(env.DB_SOCKET) || !LOCAL_HOSTS.has(String(env.DB_HOST || '127.0.0.1').trim())) {
    throw new HarnessError(
      `MariaDB is not reachable at ${target} (${first.code}); it is not local, so it is not started with Docker. ${hint}`,
      { code: 'DB_UNREACHABLE', cause: first.error }
    );
  }
  const version = await run('docker', ['compose', 'version'], { cwd: repoRoot, env, quiet: true });
  if (version.code !== 0) {
    throw new HarnessError(
      `MariaDB is not reachable at ${target} (${first.code}) and "docker compose" is not available to start it. ` +
        'Install Docker (with the compose plugin) or start MariaDB yourself.',
      { code: 'DB_UNREACHABLE', cause: first.error }
    );
  }
  const problems = composeEnvProblems(env);
  if (problems.length > 0) {
    throw new HarnessError(
      `MariaDB is not reachable at ${target}, and the docker-compose database cannot be started as configured: ${problems.join('; ')}. ` +
        'Set them in .env (see .env.example) or export them, then re-run.',
      { code: 'DB_ENV_MISSING', cause: first.error }
    );
  }

  log(`MariaDB is not reachable at ${target}; starting it: docker compose up -d --wait mariadb`);
  const up = await run('docker', ['compose', 'up', '-d', '--wait', 'mariadb'], { cwd: repoRoot, env });
  if (up.code !== 0) {
    throw new HarnessError(
      `"docker compose up -d --wait mariadb" failed (exit ${up.code ?? up.error?.message}). ` +
        'If a data volume from an earlier setup has other passwords, recreate it with "docker compose down -v".',
      { code: 'DB_START_FAILED' }
    );
  }

  const deadline = Date.now() + waitTimeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await probeDatabase({ env, connect });
    if (last.ok) {
      log(`MariaDB is up at ${target}.`);
      return { status: 'started' };
    }
    if (!UNREACHABLE_CODES.has(last.code)) {
      throw new HarnessError(
        `MariaDB started at ${target} but the query user cannot connect: ${last.error.message} ` +
          '(a data volume created earlier keeps its old users and passwords; "docker compose down -v" recreates it).',
        { code: last.code || 'DB_UNUSABLE', cause: last.error }
      );
    }
    await wait(pollMs);
  }
  throw new HarnessError(`MariaDB did not become reachable at ${target} within ${Math.round(waitTimeoutMs / 1000)} s (${last?.code}).`, {
    code: 'DB_UNREACHABLE',
  });
}

const MISSING_DATABASE_CODES = new Set(['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR']);

/** Deep content check of one fixture as the query user; a missing database is status 'missing'. */
export async function describeFixture(connection, fixture, { check = checkFixtureContent } = {}) {
  try {
    const result = await check(connection, fixture);
    return {
      name: fixture.name,
      database: fixture.database,
      status: result.status,
      contentHash: result.contentHash,
      metaContentHash: result.meta?.contentHash || null,
      expectedContentHash: result.expected.contentHash,
      masterDataMatches: result.masterDataMatches,
    };
  } catch (error) {
    if (MISSING_DATABASE_CODES.has(error?.code)) {
      return {
        name: fixture.name,
        database: fixture.database,
        status: 'missing',
        contentHash: null,
        metaContentHash: null,
        expectedContentHash: describeFixtureContent(fixture.name).contentHash,
        masterDataMatches: null,
      };
    }
    throw error;
  }
}

function needsSeeding(status) {
  return status.status !== 'current' || status.masterDataMatches !== true;
}

// What is wrong with a fixture: its content status, else its master data.
function describeProblem(status) {
  return status.status !== 'current' ? status.status : 'master data differs';
}

/**
 * Checks every fixture (rows re-hashed) and seeds the ones that are missing,
 * stale, drifted or carry other master data, with the admin role. Returns the
 * fixture statuses ({ name, database, status, contentHash, ..., action }).
 * - allowSeed false: no writes; with `strict` any fixture that is not current
 *   is an error, otherwise only missing ones and master-data mismatches are
 *   (the benchmark profile warns about stale/drifted content, as before).
 */
export async function ensureFixtures({
  fixtures,
  schema,
  env = process.env,
  allowSeed = true,
  strict = true,
  log = () => {},
  connect = createMariaDbConnection,
  check = checkFixtureContent,
  seed = seedFixture,
} = {}) {
  const query = await connect({ includeDatabase: false, role: 'query', env, warn: () => {} });
  let statuses;
  try {
    statuses = [];
    for (const fixture of fixtures) {
      statuses.push(await describeFixture(query, fixture, { check }));
    }
  } finally {
    await query.end?.().catch(() => {});
  }

  const pending = statuses.filter(needsSeeding);
  if (pending.length === 0) {
    return statuses.map((status) => ({ ...status, action: 'checked' }));
  }
  const list = pending.map((status) => `${status.name} (${status.database}: ${describeProblem(status)})`).join(', ');

  if (!allowSeed) {
    const blocking = strict ? pending : pending.filter((status) => status.status === 'missing' || status.masterDataMatches === false);
    if (blocking.length > 0) {
      throw new HarnessError(
        `Fixture database(s) not usable: ${list}. Run "npm run seed-fixtures" (admin credentials), or let the evaluation seed them (drop --no-seed).`,
        { code: 'FIXTURES_NOT_CURRENT' }
      );
    }
    return statuses.map((status) => ({ ...status, action: needsSeeding(status) ? 'stale-not-seeded' : 'checked' }));
  }

  const credentials = resolveMariaDbCredentials({ role: 'admin', env });
  if (credentials.fallback || !nonBlank(credentials.password)) {
    throw new HarnessError(
      `Fixture database(s) need seeding: ${list}. Seeding creates databases and writes rows, which needs the admin role: ` +
        'set DB_ADMIN_PASSWORD (and DB_ADMIN_USER if it is not root), or MARIADB_ROOT_PASSWORD, in .env or the shell, then re-run ' +
        '(or run "npm run seed-fixtures" with those credentials). For the docker-compose database the root password is the first ' +
        'of DB_ADMIN_PASSWORD, MARIADB_ROOT_PASSWORD and DB_PASSWORD that was set when its volume was created.',
      { code: 'ADMIN_CREDENTIALS_MISSING' }
    );
  }

  let admin;
  try {
    admin = await connect({ includeDatabase: false, role: 'admin', env, warn: () => {} });
  } catch (error) {
    throw new HarnessError(
      `Fixture database(s) need seeding (${list}), but the admin connection failed: ${error.message} ` +
        'For the docker-compose database the root password is the first of DB_ADMIN_PASSWORD, MARIADB_ROOT_PASSWORD and DB_PASSWORD ' +
        'that was set when its volume was created ("docker compose down -v" recreates it).',
      { code: errorCodeOf(error) || 'ADMIN_CONNECT_FAILED', cause: error }
    );
  }
  const actions = new Map();
  try {
    for (const status of pending) {
      const fixture = fixtures.find((entry) => entry.name === status.name);
      const result = await seed(admin, fixture, { schema });
      actions.set(fixture.name, result.action);
      log(`Fixture ${fixture.name} (${fixture.database}) was ${describeProblem(status)}: ${result.action}.`);
    }
  } catch (error) {
    throw new HarnessError(`Seeding the fixtures failed: ${error.message}`, { code: errorCodeOf(error) || 'SEED_FAILED', cause: error });
  } finally {
    await admin.end?.().catch(() => {});
  }

  const recheck = await connect({ includeDatabase: false, role: 'query', env, warn: () => {} });
  try {
    const final = [];
    for (const fixture of fixtures) {
      const status = actions.has(fixture.name) ? await describeFixture(recheck, fixture, { check }) : statuses.find((entry) => entry.name === fixture.name);
      if (needsSeeding(status)) {
        throw new HarnessError(`Fixture ${fixture.name} is still ${status.status} after seeding; check the admin user's privileges.`, {
          code: 'FIXTURES_NOT_CURRENT',
        });
      }
      final.push({ ...status, action: actions.has(fixture.name) ? 'seeded' : 'checked' });
    }
    return final;
  } finally {
    await recheck.end?.().catch(() => {});
  }
}
