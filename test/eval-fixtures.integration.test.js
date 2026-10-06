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
import { checkFixtureContent, checkFixtureMeta, hashFixtureDatabase, readFixtureTables, seedFixture } from '../src/eval/fixture-seeder.js';
import { FIXTURES, describeFixtureContent } from '../src/eval/fixtures.js';
import { closeFixtureConnections, createGoldCache, openFixtureConnections, scoreAgainstGold } from '../src/eval/oracle.js';
import { createValidatorProbe, summarizeControls, verifyCase } from '../src/eval/verify.js';
import { createMariaDbConnection } from '../src/pipeline.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';

// Opt-in checks of the evaluation fixtures against a real MariaDB, enabled by
// TEST_MARIADB_PORT like test/mariadb.integration.test.js (skipped without
// it). They WRITE: the three fixture databases (demo_retail, demo_retail_v2,
// demo_retail_v3) are created/re-seeded exactly as `npm run seed-fixtures`
// does, so point them at a throwaway server, e.g. the docker-compose database:
//
//   TEST_MARIADB_PORT=3306 TEST_MARIADB_PASSWORD=<DB_PASSWORD> \
//   TEST_MARIADB_ADMIN_PASSWORD=<root password> \
//     node --test test/eval-fixtures.integration.test.js
//
// Seeding needs the admin role: with TEST_MARIADB_PORT set but
// TEST_MARIADB_ADMIN_PASSWORD missing, the seeding tests FAIL with that
// message (never a silent skip); the read-only tests then need fixtures
// already seeded by `npm run seed-fixtures`.
// Optional: TEST_MARIADB_HOST (127.0.0.1), TEST_MARIADB_USER (demo_readonly),
// TEST_MARIADB_ADMIN_USER (root). The query user must be the docker init
// script's SELECT-only user (it reads every demo_retail* database).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configured = Boolean(process.env.TEST_MARIADB_PORT);
const skip = configured
  ? false
  : 'set TEST_MARIADB_PORT (with TEST_MARIADB_PASSWORD, and TEST_MARIADB_ADMIN_PASSWORD to seed) to check the fixtures on a real MariaDB';

function requireAdmin() {
  if (!process.env.TEST_MARIADB_ADMIN_PASSWORD) {
    throw new Error(
      'TEST_MARIADB_ADMIN_PASSWORD is not set: this test seeds demo_retail, demo_retail_v2 and demo_retail_v3 with the admin role. ' +
        'Set it to the admin (root) password of a throwaway server, e.g. the docker-compose MARIADB_ROOT_PASSWORD.'
    );
  }
}

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
  requireAdmin();
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
  // Read as the SELECT-only query user, the way the oracle reads them.
  const connections = await openFixtureConnections({ env });
  try {
    const tables = {};
    for (const entry of connections) {
      tables[entry.name] = await readFixtureTables(entry.connection, entry.database);
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
    await closeFixtureConnections(connections);
  }
});

test('drift: edited fact and master rows are detected (deep check) and repaired by seeding', { skip }, async () => {
  requireAdmin();
  const admin = await createMariaDbConnection({ includeDatabase: false, role: 'admin', env });
  const connections = await openFixtureConnections({ env });
  const byName = Object.fromEntries(connections.map((entry) => [entry.name, entry]));
  try {
    await admin.query('UPDATE demo_retail_v2.SalesDocument SET NetAmount = NetAmount + 1 WHERE SalesDocumentId = 1');
    await admin.query('UPDATE demo_retail_v3.Customer SET IsActive = 0 WHERE CustomerId = 3');
    const v2 = await checkFixtureContent(byName.v2.connection, byName.v2);
    assert.deepEqual([v2.status, v2.masterDataMatches], ['drifted', true]);
    const v3 = await checkFixtureContent(byName.v3.connection, byName.v3);
    assert.deepEqual([v3.status, v3.masterDataMatches], ['drifted', false]);
    // The meta row alone still claims the generated content.
    assert.equal((await checkFixtureMeta(byName.v3.connection, byName.v3)).status, 'current');

    // --write-pins refuses to record counts from drifted fixtures and leaves
    // the dataset file untouched (its v2 pin is deliberately wrong here, so
    // any write would change it)...
    const pinsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-pins-'));
    const pinsFile = path.join(pinsDir, 'pins.json');
    const dataset = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'datasets/core-public.json'), 'utf8')).slice(0, 1);
    dataset[0].expected_row_counts = { ...dataset[0].expected_row_counts, v2: 999 };
    const pinsBefore = `${JSON.stringify(dataset, null, 2)}\n`;
    await fs.writeFile(pinsFile, pinsBefore);
    await assert.rejects(
      execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-dataset.js'), '--dataset-file', pinsFile, '--skip-controls', '--write-pins'], {
        env: scriptEnv,
        cwd: REPO_ROOT,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--write-pins refused, no pins written: fixture v2 is drifted; fixture v3 is drifted; fixture v3 has master data/);
        assert.match(error.stderr, /npm run seed-fixtures/);
        assert.doesNotMatch(error.stdout, /pins: wrote/);
        return true;
      }
    );
    assert.equal(await fs.readFile(pinsFile, 'utf8'), pinsBefore);
    await fs.rm(pinsDir, { recursive: true, force: true });

    // verify-dataset fails on it...
    await assert.rejects(
      execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-dataset.js'), '--dataset', 'core-public', '--skip-controls'], { env: scriptEnv, cwd: REPO_ROOT }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /FAIL: fixture v3: master data differs from the shared MASTER_DATA/);
        assert.match(error.stdout, /FAIL: fixture v2: content is drifted/);
        return true;
      }
    );
    // ...and seeding repairs it.
    for (const fixture of FIXTURES) {
      const result = await seedFixture(admin, fixture, { schema });
      assert.equal(result.action, fixture.name === 'seed' ? 'unchanged' : 'seeded', fixture.name);
    }
    for (const entry of connections) {
      const check = await checkFixtureContent(entry.connection, entry);
      assert.deepEqual([entry.name, check.status, check.masterDataMatches], [entry.name, 'current', true]);
    }
  } finally {
    await closeFixtureConnections(connections);
    await admin.end();
  }
});

test('the read-only query user reads every fixture; meta rows and content are current', { skip }, async () => {
  const connections = await openFixtureConnections({ env });
  try {
    for (const entry of connections) {
      assert.equal((await checkFixtureMeta(entry.connection, entry)).status, 'current', entry.name);
      const check = await checkFixtureContent(entry.connection, entry);
      assert.equal(check.status, 'current', entry.name);
      assert.equal(check.masterDataMatches, true, entry.name);
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
    for (const datasetName of ['core-public', 'paraphrase-public', 'edge-cases-public', 'templated-public', 'hard-cases-public']) {
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
      // Every positive passes the validator except the flagged known false
      // rejections and those of a question whose gold the validator rejects
      // too (known_validator_rejection: a measured product gap).
      const flagged = results.flatMap((result) => result.notes.filter((note) => /^positive control .*known validator (false )?rejection/.test(note)));
      assert.equal(summary.positive.validatorAccepted + flagged.length, summary.positive.total);
      // The point of the extra fixtures: the seed alone catches far less.
      assert.ok(summary.design.seedOnlyRate < summary.design.rate);
    }
  } finally {
    await closeFixtureConnections(connections);
  }
});

test('ties at the cut-off: the live baseline\'s tie-blind top 5 passes whichever tied product MariaDB returns', { skip }, async () => {
  // tpl_product_qty_top5_feb_2026_8a9dc1 on v3: 'Herbal Tea Variety Pack' and
  // 'Spring Water 24 Pack' both moved 34 units, at position 5. The recorded
  // gpt-4o-mini SQL orders by the quantity alone, so the plan picks the fifth
  // product (it scored wrong_result live and pass on a rescore); the tails
  // force each of the two legal answers.
  const { cases } = await loadBenchmarkDataset({ datasetName: 'templated-public', caseId: 'tpl_product_qty_top5_feb_2026_8a9dc1' });
  const [testCase] = cases;
  const tieBlind =
    'SELECT p.ProductName, ROUND(SUM(sdl.Quantity), 3) AS total_qty FROM SalesDocument sd ' +
    'JOIN SalesDocumentLine sdl ON sd.SalesDocumentId = sdl.SalesDocumentId JOIN Product p ON sdl.ProductId = p.ProductId ' +
    "WHERE IFNULL(sd.IsCanceled, 0) = 0 AND sd.DocumentDate >= '2026-02-01' AND sd.DocumentDate < '2026-03-01' " +
    'GROUP BY p.ProductId, p.ProductName ORDER BY SUM(sdl.Quantity) DESC';
  const connections = await openFixtureConnections({ env });
  try {
    const v3 = connections.find((entry) => entry.name === 'v3');
    const fifth = {};
    for (const [label, tail] of [['as written', ''], ['name ASC', ', p.ProductName ASC'], ['name DESC', ', p.ProductName DESC']]) {
      const sql = `${tieBlind}${tail} LIMIT 5`;
      const [rows] = await v3.connection.query(sql);
      fifth[label] = rows[4].ProductName;
      const score = await scoreAgainstGold({ testCase, predictedSql: sql, connections });
      assert.equal(score.match, true, `${label}: ${score.reason} (killed on ${score.killedOn.join(', ')})`);
    }
    // The fixture still holds the tie this test is about.
    assert.deepEqual([fifth['name ASC'], fifth['name DESC']], ['Herbal Tea Variety Pack', 'Spring Water 24 Pack']);
    // Another product at the cut-off with another quantity is still wrong.
    const wrong = await scoreAgainstGold({ testCase, predictedSql: `${tieBlind.replace(">= '2026-02-01'", "> '2026-02-01'")} LIMIT 5`, connections });
    assert.equal(wrong.match, false);
  } finally {
    await closeFixtureConnections(connections);
  }
});

test('the seed-fixtures and verify-dataset scripts succeed end to end', { skip }, async () => {
  requireAdmin();
  const seeded = await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts/seed-fixtures.js')], { env: scriptEnv, cwd: REPO_ROOT });
  assert.match(seeded.stdout, /unchanged seed/);
  const verified = await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-dataset.js'), '--dataset', 'edge-cases-public'], {
    env: scriptEnv,
    cwd: REPO_ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
  const design = /negative, design: +(\d+)\/(\d+) killed/.exec(verified.stdout);
  assert.ok(design && Number(design[2]) >= 108 && design[1] === design[2], `every design control is killed: ${design?.[0]}`);
  assert.match(verified.stdout, /negative, held-out: +28\/28 killed/);
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
