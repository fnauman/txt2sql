import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadBenchmarkDataset } from '../src/benchmark.js';
import { loadControlsIndex } from '../src/eval/controls.js';
import { FACT_TABLES, MASTER_TABLES } from '../src/eval/fixture-data.js';
import { checkFixtureMeta, hashFixtureDatabase, readFixtureTables, seedFixture } from '../src/eval/fixture-seeder.js';
import { FIXTURES, describeFixtureContent } from '../src/eval/fixtures.js';
import { closeFixtureConnections, createGoldCache, openFixtureConnections } from '../src/eval/oracle.js';
import { createValidatorProbe, summarizeControls, verifyCase } from '../src/eval/verify.js';
import { createMariaDbConnection } from '../src/pipeline.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';

// Opt-in checks of the evaluation fixtures against a real MariaDB (skipped by
// default). They WRITE: the three fixture databases (demo_retail,
// demo_retail_v2, demo_retail_v3) are created/re-seeded exactly as
// `npm run seed-fixtures` does, so point them at a throwaway server, e.g. the
// docker-compose database:
//
//   TEST_MARIADB_PORT=3306 TEST_MARIADB_PASSWORD=<DB_PASSWORD> \
//   TEST_MARIADB_ADMIN_PASSWORD=<root password> \
//     node --test test/eval-fixtures.integration.test.js
//
// Optional: TEST_MARIADB_HOST (127.0.0.1), TEST_MARIADB_USER (demo_readonly),
// TEST_MARIADB_ADMIN_USER (root). The query user must be the docker init
// script's SELECT-only user (it reads every demo_retail* database).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configured = Boolean(process.env.TEST_MARIADB_PORT && process.env.TEST_MARIADB_ADMIN_PASSWORD);
const skip = configured
  ? false
  : 'set TEST_MARIADB_PORT, TEST_MARIADB_PASSWORD and TEST_MARIADB_ADMIN_PASSWORD to seed and verify the fixtures on a real MariaDB';

const env = {
  DB_HOST: process.env.TEST_MARIADB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_MARIADB_PORT,
  DB_USER: process.env.TEST_MARIADB_USER || 'demo_readonly',
  DB_PASSWORD: process.env.TEST_MARIADB_PASSWORD,
  DB_ADMIN_USER: process.env.TEST_MARIADB_ADMIN_USER || 'root',
  DB_ADMIN_PASSWORD: process.env.TEST_MARIADB_ADMIN_PASSWORD,
  DB_NAME: 'demo_retail',
};
// Child scripts must not pick up a developer .env.
const scriptEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...env,
  ENV_FILE: path.join(os.tmpdir(), 'txt2sql-no-such-env-file.env'),
};
const execFileAsync = promisify(execFile);

let schema;
before(async () => {
  schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
});

test('seed-fixtures is idempotent and writes exactly the generated content', { skip }, async () => {
  const admin = await createMariaDbConnection({ includeDatabase: false, role: 'admin', env });
  try {
    for (const fixture of FIXTURES) {
      await seedFixture(admin, fixture, { schema });
    }
    for (const fixture of FIXTURES) {
      const again = await seedFixture(admin, fixture, { schema });
      assert.equal(again.action, 'unchanged', `${fixture.name} is not re-seeded when current`);
      assert.equal(await hashFixtureDatabase(admin, fixture.database), describeFixtureContent(fixture.name).contentHash);
    }
    const forced = await seedFixture(admin, FIXTURES[2], { schema, force: true });
    assert.equal(forced.action, 'seeded');
    assert.equal(await hashFixtureDatabase(admin, FIXTURES[2].database), forced.contentHash);
  } finally {
    await admin.end();
  }
});

test('every fixture database holds identical master data and different facts', { skip }, async () => {
  const admin = await createMariaDbConnection({ includeDatabase: false, role: 'admin', env });
  try {
    const tables = {};
    for (const fixture of FIXTURES) {
      tables[fixture.name] = await readFixtureTables(admin, fixture.database);
    }
    for (const table of MASTER_TABLES) {
      assert.ok(tables.seed[table].length > 0, `${table} is seeded`);
      assert.deepEqual(tables.v2[table], tables.seed[table], `${table}: v2 differs from seed`);
      assert.deepEqual(tables.v3[table], tables.seed[table], `${table}: v3 differs from seed`);
    }
    for (const table of FACT_TABLES) {
      assert.notDeepEqual(tables.v2[table], tables.seed[table]);
      assert.notDeepEqual(tables.v3[table], tables.v2[table]);
    }
  } finally {
    await admin.end();
  }
});

test('the read-only query user reads every fixture; meta rows are current', { skip }, async () => {
  const connections = await openFixtureConnections({ env });
  try {
    for (const entry of connections) {
      const check = await checkFixtureMeta(entry.connection, entry);
      assert.equal(check.status, 'current', entry.name);
      await assert.rejects(entry.connection.query('DELETE FROM SalesDocument'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    }
  } finally {
    await closeFixtureConnections(connections);
  }
});

test('verify logic: every gold is healthy on every fixture and the controls hold', { skip }, async () => {
  const connections = await openFixtureConnections({ env });
  const controlsIndex = await loadControlsIndex();
  const goldCache = createGoldCache();
  const validate = createValidatorProbe({ schema, connection: connections[0].connection });
  try {
    for (const datasetName of ['core-public', 'paraphrase-public', 'edge-cases-public']) {
      const { cases } = await loadBenchmarkDataset({ datasetName });
      const results = [];
      for (const testCase of cases) {
        const result = await verifyCase(testCase, { connections, goldCache, validate, controlsIndex });
        assert.deepEqual(result.problems, [], `${datasetName}/${testCase.id}`);
        results.push(result);
      }
      const summary = summarizeControls(results, { fixtureNames: FIXTURES.map((fixture) => fixture.name) });
      assert.ok(summary.design.rate >= 0.95, `${datasetName} design kill rate ${summary.design.rate}`);
      assert.equal(summary.positive.matched, summary.positive.total);
      assert.equal(summary.positive.validatorAccepted, summary.positive.total);
      // The point of the extra fixtures: the seed alone catches far less.
      assert.ok(summary.design.seedOnlyRate < summary.design.rate);
    }
  } finally {
    await closeFixtureConnections(connections);
  }
});

test('the seed-fixtures and verify-dataset scripts succeed end to end', { skip }, async () => {
  const seeded = await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts/seed-fixtures.js')], { env: scriptEnv, cwd: REPO_ROOT });
  assert.match(seeded.stdout, /unchanged seed/);
  const verified = await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-dataset.js'), '--dataset', 'edge-cases-public'], {
    env: scriptEnv,
    cwd: REPO_ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(verified.stdout, /negative, design: {3}108\/108 killed/);
  assert.match(verified.stdout, /0 failure\(s\)\./);
  assert.doesNotMatch(verified.stdout, /FAIL:/);
});

// The benchmark CLI end to end with a local stand-in for the OpenAI API (no
// paid call): it answers every question with that case's gold SQL, so every
// case must pass on all three fixtures through the real product loop.
let fakeOpenAi;
let fakeOpenAiUrl;
before(async () => {
  if (!configured) {
    return;
  }
  const { cases } = await loadBenchmarkDataset({ datasetName: 'edge-cases-public' });
  const byQuestion = [...cases].sort((left, right) => right.question.length - left.question.length);
  fakeOpenAi = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const userText = (payload.messages || []).filter((message) => message.role === 'user').map((message) => message.content).join('\n');
      const testCase = byQuestion.find((entry) => userText.includes(entry.question));
      const content = JSON.stringify({ sql: testCase?.expected_sql || 'SELECT 1', explanation: 'fake', tables_used: testCase?.expected_tables || [], assumptions: [] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'fake',
          object: 'chat.completion',
          model: payload.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );
    });
  });
  await new Promise((resolve) => fakeOpenAi.listen(0, '127.0.0.1', resolve));
  fakeOpenAiUrl = `http://127.0.0.1:${fakeOpenAi.address().port}/v1`;
});
after(async () => {
  if (fakeOpenAi) {
    await new Promise((resolve) => fakeOpenAi.close(resolve));
  }
});

test('the benchmark CLI runs every case through the product loop and the three-fixture oracle', { skip }, async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-bench-'));
  const reportFile = path.join(outputDir, 'report.json');
  await execFileAsync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/evaluate.js'), '--dataset', 'edge-cases-public', '--results-file', reportFile, '--trace-file', path.join(outputDir, 'trace.jsonl')],
    { env: { ...scriptEnv, OPENAI_API_KEY: 'fake-key-for-a-local-stub', OPENAI_BASE_URL: fakeOpenAiUrl, MODEL_NAME: 'gpt-4o-mini' }, cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 }
  );
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  assert.equal(report.total, 17);
  assert.equal(report.passed, 17, JSON.stringify(report.statusCounts));
  assert.deepEqual(report.oracle.fixtures.map((fixture) => [fixture.name, fixture.status]), [
    ['seed', 'current'],
    ['v2', 'current'],
    ['v3', 'current'],
  ]);
  for (const result of report.results) {
    assert.equal(result.oracle.per_fixture.length, 3, result.id);
    assert.equal(result.attempts.length, 1, result.id);
    assert.equal(result.attempts[0].validation.ok, true, result.id);
  }
  await fs.rm(outputDir, { recursive: true, force: true });
});
