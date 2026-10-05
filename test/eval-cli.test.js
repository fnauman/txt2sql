import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { composeEnvProblems, ensureFixtures, HarnessError, preflightDatabase } from '../src/eval/setup.js';
import { verifySuite } from '../src/eval/verify.js';
import { computeExitCode, defaultBaselinePath, parseEvalArgs } from '../scripts/eval.js';

test('eval defaults: everything on, the whole suite, 4 workers, 120 s deadline', () => {
  const options = parseEvalArgs([], { env: {} });
  assert.equal(options.profile, 'eval');
  assert.deepEqual([options.docker, options.seed, options.verify, options.checkControls], [true, true, true, true]);
  assert.deepEqual([options.datasetNames, options.datasetFiles, options.split], [[], [], 'all']);
  assert.deepEqual([options.repeat, options.concurrency, options.caseTimeoutMs, options.budgetUsd], [1, 4, 120000, null]);
  assert.equal(options.model, 'gpt-4o-mini');
  assert.equal(options.minKillRate, 0.95);
  assert.equal(options.failOnAnyFailure, false);
  assert.equal(parseEvalArgs([], { env: { MODEL_NAME: 'gpt-5.4-mini' } }).model, 'gpt-5.4-mini');
  assert.equal(parseEvalArgs(['--model', 'gpt-5.4'], { env: { MODEL_NAME: 'gpt-5.4-mini' } }).model, 'gpt-5.4');
  assert.match(defaultBaselinePath('gpt-4o-mini'), /eval\/baselines\/gpt-4o-mini\.json$/);
});

test('flags parse lists and numbers; the benchmark profile keeps the old behaviour', () => {
  const options = parseEvalArgs(
    ['--dataset', 'core-public,edge-cases-public', '--tag', 'a,b', '--case-id=x', '--intent', 'i', '--split', 'holdout', '--repeat', '3', '--concurrency', '2', '--case-timeout-ms', '0', '--budget-usd', '0.5', '--no-docker', '--skip-verify', '--gate', '--min-accuracy', '0.6'],
    { env: {} }
  );
  assert.deepEqual(options.datasetNames, ['core-public', 'edge-cases-public']);
  assert.deepEqual([options.tags, options.caseIds, options.intents, options.split], [['a', 'b'], ['x'], ['i'], 'holdout']);
  assert.deepEqual([options.repeat, options.concurrency, options.caseTimeoutMs, options.budgetUsd], [3, 2, 0, 0.5]);
  assert.deepEqual([options.docker, options.seed, options.verify, options.gate, options.minAccuracy], [false, true, false, true, 0.6]);

  for (const argv of [[], ['--profile', 'benchmark']]) {
    const benchmark = parseEvalArgs(argv, { profile: argv.length ? 'eval' : 'benchmark', env: {} });
    assert.equal(benchmark.profile, 'benchmark');
    assert.deepEqual(benchmark.datasetNames, ['core-public']);
    assert.deepEqual([benchmark.docker, benchmark.seed, benchmark.verify, benchmark.failOnAnyFailure], [false, false, false, true]);
  }
  assert.deepEqual(parseEvalArgs(['--dataset-file', 'x.json'], { profile: 'benchmark', env: {} }).datasetNames, []);
});

test('bad usage is a harness error (exit 2)', () => {
  for (const argv of [
    ['--repeat', '0'],
    ['--concurrency', '1.5'],
    ['--split', 'test'],
    ['--budget-usd', '0'],
    ['--budget-usd', 'abc'],
    ['--min-accuracy', '0.5'],
    ['--gate', '--min-accuracy', '2'],
    ['--profile', 'nope'],
    ['--offline', '--write-baseline'],
  ]) {
    assert.throws(() => parseEvalArgs(argv, { env: {} }), (error) => error instanceof HarnessError && error.exitCode === 2, argv.join(' '));
  }
});

function fakeReport({ byOutcome = { pass: 3 }, strict = 0.75, comparison = null, repeat = 1, results = [] } = {}) {
  return { attribution: { repetitions: { byOutcome } }, stats: { strictAccuracy: { value: strict }, repeat }, comparison, results };
}

test('exit codes: 2 for harness/infra, 1 for a failed gate, else 0', () => {
  assert.deepEqual(computeExitCode(fakeReport()), { code: 0, reasons: [] });
  for (const outcome of ['infra_error', 'llm_outage', 'expected_sql_error', 'harness_error']) {
    const result = computeExitCode(fakeReport({ byOutcome: { pass: 2, [outcome]: 1 } }), { gate: true });
    assert.equal(result.code, 2, outcome);
    assert.match(result.reasons[0], new RegExp(outcome));
  }
  assert.equal(computeExitCode(fakeReport({ byOutcome: { skipped_budget: 2 }, strict: null })).code, 2);
  // Model failures are measurements, not harness failures.
  assert.equal(computeExitCode(fakeReport({ byOutcome: { pass: 1, wrong_result: 1, guardrail_false_rejection: 1 } })).code, 0);
  // A deadline is counted as a failure, but the run is not a trustworthy
  // measurement: exit 2 with or without --gate, never a "significantly worse" 1.
  const worseByTimeouts = { verdict: 'worse', mcnemar: { regressions: 7, improvements: 0, p: 0.0156 } };
  for (const gate of [false, true]) {
    const timedOut = computeExitCode(fakeReport({ byOutcome: { timeout: 6 }, strict: 0, comparison: worseByTimeouts }), { gate });
    assert.equal(timedOut.code, 2);
    assert.match(timedOut.reasons[0], /6 repetition\(s\): hit the case deadline; raise --case-timeout-ms or check the provider \(timeout\)/);
  }

  const worse = { verdict: 'worse', mcnemar: { regressions: 6, improvements: 0, p: 0.03125 } };
  assert.equal(computeExitCode(fakeReport({ comparison: worse })).code, 0, 'no gate, no failure');
  const gated = computeExitCode(fakeReport({ comparison: worse }), { gate: true });
  assert.equal(gated.code, 1);
  assert.match(gated.reasons[0], /significantly worse than the baseline: 6 regression\(s\) vs 0 improvement\(s\), exact McNemar p = 0\.03125/);
  assert.equal(computeExitCode(fakeReport({ comparison: { verdict: 'no_significant_difference' } }), { gate: true }).code, 0);
  assert.equal(computeExitCode(fakeReport({ strict: 0.5 }), { gate: true, minAccuracy: 0.6 }).code, 1);
  assert.equal(computeExitCode(fakeReport({ strict: 0.6 }), { gate: true, minAccuracy: 0.6 }).code, 0);

  // A rescore does not fail on outcomes it inherited from the recording.
  const rescored = {
    ...fakeReport({ byOutcome: { pass: 1, llm_outage: 1 } }),
    results: [
      {
        summary: { counted: 1, passes: 1 },
        repetitions: [
          { outcome: 'pass', rescore: { replayed: true, inherited: false } },
          { outcome: 'llm_outage', rescore: { replayed: true, inherited: true } },
        ],
      },
    ],
  };
  assert.equal(computeExitCode(rescored).code, 0);
  rescored.results[0].repetitions[1].rescore.inherited = false;
  assert.equal(computeExitCode(rescored).code, 2);

  // Benchmark profile: any failed case in a single-repetition run.
  const results = [{ summary: { counted: 1, passes: 1 } }, { summary: { counted: 1, passes: 0 } }];
  assert.equal(computeExitCode(fakeReport({ results }), { failOnAnyFailure: true }).code, 1);
  assert.equal(computeExitCode(fakeReport({ results, repeat: 3 }), { failOnAnyFailure: true }).code, 0);
});

const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
const fakeConnection = () => ({ query: async () => [[{ 1: 1 }]], end: async () => {} });
const LOCAL_ENV = { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'demo_readonly', DB_PASSWORD: 'pw', DB_ADMIN_PASSWORD: 'root' };

test('preflight: a reachable database needs nothing; unreachable without Docker is an actionable error', async () => {
  const commands = [];
  const run = async (command, args) => {
    commands.push([command, ...args].join(' '));
    return { code: 0 };
  };
  assert.deepEqual(await preflightDatabase({ env: LOCAL_ENV, connect: async () => fakeConnection(), run }), { status: 'reachable' });
  assert.deepEqual(commands, []);

  await assert.rejects(
    preflightDatabase({ env: LOCAL_ENV, allowDocker: false, connect: async () => Promise.reject(refused()), run }),
    (error) => error.code === 'DB_UNREACHABLE' && /not reachable at 127\.0\.0\.1:3306 \(ECONNREFUSED\)\. Start it with "docker compose up -d --wait mariadb"/.test(error.message)
  );
  await assert.rejects(
    preflightDatabase({ env: { ...LOCAL_ENV, DB_HOST: 'db.internal' }, connect: async () => Promise.reject(refused()), run }),
    (error) => /it is not local, so it is not started with Docker/.test(error.message)
  );
  const denied = Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' });
  await assert.rejects(
    preflightDatabase({ env: LOCAL_ENV, connect: async () => Promise.reject(denied), run }),
    (error) => error.exitCode === 2 && /answered but the query user cannot run queries/.test(error.message)
  );
  assert.deepEqual(commands, [], 'never starts Docker for those');

  await assert.rejects(
    preflightDatabase({ env: LOCAL_ENV, connect: async () => Promise.reject(refused()), run: async () => ({ code: 1 }) }),
    (error) => /"docker compose" is not available/.test(error.message)
  );
});

test('preflight: a local database that is down is started with docker compose and awaited', async () => {
  const commands = [];
  let probes = 0;
  const connect = async () => {
    probes += 1;
    if (probes <= 2) {
      throw refused();
    }
    return fakeConnection();
  };
  const run = async (command, args) => {
    commands.push([command, ...args].join(' '));
    return { code: 0 };
  };
  const logs = [];
  const result = await preflightDatabase({ env: LOCAL_ENV, connect, run, wait: async () => {}, log: (line) => logs.push(line) });
  assert.deepEqual(result, { status: 'started' });
  assert.deepEqual(commands, ['docker compose version', 'docker compose up -d --wait mariadb']);
  assert.equal(probes, 3);
  assert.match(logs[0], /starting it: docker compose up -d --wait mariadb/);

  // Missing compose settings are named before anything starts.
  const started = [];
  await assert.rejects(
    preflightDatabase({
      env: { DB_HOST: '127.0.0.1' },
      connect: async () => Promise.reject(refused()),
      run: async (command, args) => {
        started.push(args.join(' '));
        return { code: 0 };
      },
    }),
    (error) => error.code === 'DB_ENV_MISSING' && /DB_PASSWORD is not set/.test(error.message)
  );
  assert.deepEqual(started, ['compose version']);
  assert.deepEqual(composeEnvProblems(LOCAL_ENV), []);
  assert.match(composeEnvProblems({ DB_PASSWORD: 'a', DB_READONLY_PASSWORD: 'b' })[0], /differs from DB_PASSWORD/);

  // A database that never comes up is a bounded wait.
  await assert.rejects(
    preflightDatabase({ env: LOCAL_ENV, connect: async () => Promise.reject(refused()), run: async () => ({ code: 0 }), wait: async () => {}, waitTimeoutMs: 0 }),
    (error) => /did not become reachable/.test(error.message)
  );
});

const FIXTURES = [
  { name: 'seed', database: 'demo_retail' },
  { name: 'v2', database: 'demo_retail_v2' },
];
const checkResult = (status, masterDataMatches = true) => ({ status, masterDataMatches, contentHash: status === 'current' ? 'h' : 'x', meta: null, expected: { contentHash: 'h' } });

test('fixtures: current ones are left alone; others are seeded with the admin role, or the run stops', async () => {
  const roles = [];
  const connect = async ({ role }) => {
    roles.push(role);
    return { end: async () => {} };
  };
  const seeded = [];
  const states = { seed: 'current', v2: 'drifted' };
  const seed = async (connection, fixture) => {
    seeded.push(fixture.name);
    states[fixture.name] = 'current';
    return { action: 'seeded' };
  };
  const check = async (connection, fixture) => checkResult(states[fixture.name]);

  const allCurrent = await ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, connect, check: async () => checkResult('current'), seed });
  assert.deepEqual(allCurrent.map((status) => [status.name, status.status, status.action]), [['seed', 'current', 'checked'], ['v2', 'current', 'checked']]);
  assert.deepEqual(roles, ['query']);
  assert.deepEqual(seeded, []);

  roles.length = 0;
  const repaired = await ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, connect, check, seed });
  assert.deepEqual(seeded, ['v2']);
  assert.deepEqual(roles, ['query', 'admin', 'query']);
  assert.deepEqual(repaired.map((status) => [status.name, status.action]), [['seed', 'checked'], ['v2', 'seeded']]);

  // A missing database is detected from the driver error.
  const missing = async (connection, fixture) => {
    if (fixture.name === 'v2') {
      throw Object.assign(new Error("Table 'demo_retail_v2._fixture_meta' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    }
    return checkResult('current');
  };
  await assert.rejects(
    ensureFixtures({ fixtures: FIXTURES, schema: {}, env: { DB_USER: 'demo_readonly', DB_PASSWORD: 'pw' }, connect, check: missing, seed }),
    (error) => error.code === 'ADMIN_CREDENTIALS_MISSING' && /v2 \(demo_retail_v2: missing\)/.test(error.message) && /DB_ADMIN_PASSWORD/.test(error.message)
  );
  await assert.rejects(
    ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, allowSeed: false, connect, check: async () => checkResult('stale'), seed }),
    (error) => error.code === 'FIXTURES_NOT_CURRENT' && /npm run seed-fixtures/.test(error.message)
  );
  // The benchmark profile only warns about stale content, but never runs on a missing fixture or other master data.
  const lenient = await ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, allowSeed: false, strict: false, connect, check: async () => checkResult('stale'), seed });
  assert.deepEqual(lenient.map((status) => status.action), ['stale-not-seeded', 'stale-not-seeded']);
  await assert.rejects(
    ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, allowSeed: false, strict: false, connect, check: async () => checkResult('current', false), seed }),
    (error) => /master data differs/.test(error.message)
  );
});

test('verifySuite checks a case shared by two datasets once and applies the kill-rate gate per dataset', async () => {
  const shared = normalizeBenchmarkCase({ id: 'shared', question: 'Q?', expected_sql: 'SELECT 1' });
  const other = normalizeBenchmarkCase({ id: 'other', question: 'R?', expected_sql: 'SELECT 2' });
  const calls = [];
  const verify = async (testCase) => {
    calls.push(testCase.id);
    return {
      id: testCase.id,
      problems: testCase.id === 'other' ? ['gold fails on v2'] : [],
      notes: [],
      goldRowCounts: {},
      controls: {
        source: 'x',
        matchedBy: 'id',
        positive: [],
        negative: [
          { id: 'm1', type: 'join_path', heldout: false, killed: true, killedOn: ['v2'] },
          { id: 'm2', type: 'cancel', heldout: false, killed: testCase.id === 'shared', killedOn: testCase.id === 'shared' ? ['seed'] : [] },
        ],
      },
    };
  };
  const result = await verifySuite({
    datasets: [
      { name: 'core', cases: [shared] },
      { name: 'edge', cases: [shared, other] },
    ],
    connections: [{ name: 'seed' }, { name: 'v2' }],
    verify,
    minKillRate: 0.95,
  });
  assert.deepEqual(calls, ['shared', 'other']);
  assert.equal(result.cases, 2);
  assert.deepEqual(result.problems, [{ id: 'other', datasets: ['edge'], problems: ['gold fails on v2'] }]);
  assert.deepEqual(result.datasets.map((dataset) => [dataset.name, dataset.cases, dataset.failures, dataset.controls.design.killed, dataset.controls.design.total]), [
    ['core', 1, 0, 2, 2],
    ['edge', 2, 1, 3, 4],
  ]);
  assert.deepEqual(result.gateFailures, ['edge: design kill rate 75.0% < 95.0%']);
});
