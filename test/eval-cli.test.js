import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { adminCredentialsHint, composeEnvProblems, ensureFixtures, HarnessError, preflightDatabase } from '../src/eval/setup.js';
import { verifySuite } from '../src/eval/verify.js';
import { baselineRefusal, computeExitCode, createRunStopper, defaultBaselinePath, describeRunnerFlags, parseEvalArgs, runEval, verificationRefusal } from '../scripts/eval.js';

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
    // misspelled, valueless or empty flags never fall back to a default
    ['--budget', '0.0001'],
    ['--concurency', '9'],
    ['--repeats', '3'],
    ['--budget-usd'],
    ['--budget-usd', ''],
    ['--budget-usd='],
    ['--repeat'],
    ['--compare'],
    ['--rescore'],
    ['--rescore', '--offline'],
    ['--output-dir', '--gate'],
    ['--gate=true'],
    ['report.json'],
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
  assert.deepEqual(commands, ['docker compose version', 'docker compose ps --status running -q mariadb', 'docker compose up -d --wait --no-recreate mariadb']);
  assert.equal(probes, 3);
  assert.match(logs[0], /starting it: docker compose up -d --wait --no-recreate mariadb/);

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

test('the in-process verify gate: invalid and unscored controls are problems (exit 2), undecided ones only lower the kill rate', async () => {
  const testCase = normalizeBenchmarkCase({ id: 'c1', question: 'Q?', expected_sql: 'SELECT 1' });
  const killed = (id) => ({ id, type: 'join_path', heldout: false, status: 'killed', killed: true, killedOn: ['v2'] });
  const negativeWith = (extra) => async () => ({
    id: 'c1',
    // verifyCase reports invalid/unscored controls as problems; a verifier
    // that only sets the status must still fail the gate.
    problems: [],
    notes: [],
    goldRowCounts: {},
    controls: { source: 'x', matchedBy: 'id', positive: [], negative: [...Array.from({ length: 30 }, (_, index) => killed(`m${index}`)), extra] },
  });
  const run = (extra) =>
    verifySuite({ datasets: [{ name: 'core', cases: [testCase] }], connections: [{ name: 'seed' }, { name: 'v2' }], verify: negativeWith(extra), minKillRate: 0.95 });

  const invalid = await run({ id: 'mx', type: 'cancel', heldout: false, status: 'invalid', killed: false, killedOn: [], errors: [{ fixture: 'v2', code: 'ER_BAD_FIELD_ERROR', infra: false }] });
  assert.deepEqual(invalid.controlStatus, { undecided: [], invalid: ['c1/mx'], unscored: [] });
  assert.deepEqual(invalid.gateFailures, [], '30/31 is above the floor; the invalid control alone must fail the gate');
  assert.match(verificationRefusal(invalid), /1 invalid and 0 unscored negative control\(s\) \(c1\/mx\)/);

  const unscored = await run({ id: 'hx', type: 'cancel', heldout: true, status: 'unscored', killed: false, killedOn: [], errors: [{ fixture: 'seed', code: 'ECONNRESET', infra: true }] });
  assert.deepEqual(unscored.controlStatus, { undecided: [], invalid: [], unscored: ['c1/hx'] });
  assert.match(verificationRefusal(unscored), /0 invalid and 1 unscored negative control\(s\) \(c1\/hx\).*the database failed while scoring/);

  const undecided = await run({ id: 'my', type: 'cancel', heldout: false, status: 'undecided', killed: false, killedOn: [] });
  assert.deepEqual(undecided.controlStatus, { undecided: ['c1/my'], invalid: [], unscored: [] });
  assert.equal(verificationRefusal(undecided), null, 'undecided counts as not killed, like a survivor');
  assert.equal(undecided.datasets[0].controls.design.killed, 30);
  assert.equal(undecided.datasets[0].controls.design.total, 31);

  // Gold problems and gate failures still fail it.
  assert.match(verificationRefusal({ problems: [{ id: 'c1' }], gateFailures: ['core: design kill rate 50.0% < 95.0%'], controlStatus: { undecided: [], invalid: [], unscored: [] } }), /1 case\(s\) with problems, 1 gate failure\(s\)/);
  // A pre-status verification result (no controlStatus) is read as none.
  assert.equal(verificationRefusal({ problems: [], gateFailures: [] }), null);
});

test('unknown flags name the closest known one', () => {
  const messageOf = (argv) => {
    try {
      parseEvalArgs(argv, { env: {} });
    } catch (error) {
      return error.message;
    }
    return null;
  };
  assert.match(messageOf(['--concurency', '9']), /Unknown option "--concurency"\. Did you mean --concurrency\?/);
  assert.match(messageOf(['--budget', '1']), /Did you mean --budget-usd\?/);
  assert.match(messageOf(['--rescore']), /--rescore needs a value\./);
  assert.match(messageOf(['--xyzzy-flag']), /^Unknown option "--xyzzy-flag"\.\n/);
  // Inline values and every env-source flag are accepted.
  const options = parseEvalArgs(['--repeat=2', '--dotenv', 'x.env', '--use-home-env', '--trace'], { env: {} });
  assert.equal(options.repeat, 2);
  assert.deepEqual(options.argv, ['--repeat=2', '--dotenv', 'x.env', '--use-home-env', '--trace']);
});

test('the runner block records every parsed flag, paths repo-relative', () => {
  const options = parseEvalArgs(['--gate', '--min-accuracy', '0.5', '--skip-controls', '--min-kill-rate', '0.9', '--no-seed', '--compare', 'eval/baselines/x.json'], { env: {} });
  const flags = describeRunnerFlags(options);
  assert.equal('argv' in flags, false);
  assert.deepEqual([flags.gate, flags.minAccuracy, flags.checkControls, flags.minKillRate, flags.seed], [true, 0.5, false, 0.9, false]);
  assert.equal(flags.compare, 'eval/baselines/x.json');
  assert.equal(flags.outputDir, 'generated/runs');
});

test('--write-baseline only replaces the baseline with a clean, complete run', () => {
  const report = { budget: { skippedCases: [] } };
  assert.equal(baselineRefusal(report, { code: 0, reasons: [] }), null);
  assert.match(baselineRefusal(report, { code: 2, reasons: ['9 repetition(s): LLM provider outage errors (llm_outage)'] }), /exited 2 \(9 repetition/);
  assert.match(baselineRefusal(report, { code: 1, reasons: ['significantly worse'] }), /exited 1/);
  assert.match(baselineRefusal({ budget: { skippedCases: ['a', 'b'] } }, { code: 0, reasons: [] }), /2 case\(s\) were skipped by the budget/);
});

test('configuration problems fail before any setup: --gate without a baseline, a live run without a key', async () => {
  const lines = [];
  const cli = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const base = parseEvalArgs(['--model', 'no-such-model-baseline', '--gate'], { env: {} });
  await assert.rejects(runEval(base, { cli, env: {} }), (error) => error.code === 'NO_BASELINE' && /--gate needs a baseline to compare with, and there is none at eval\/baselines\/no-such-model-baseline\.json/.test(error.message));
  await assert.rejects(runEval({ ...base, noBaseline: true }, { cli, env: {} }), (error) => error.code === 'NO_BASELINE' && /--no-baseline/.test(error.message));

  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    // With --min-accuracy the gate still means something: a warning, then the key check fails first.
    await assert.rejects(
      runEval({ ...base, minAccuracy: 0.5 }, { cli, env: {} }),
      (error) => error.code === 'OPENAI_NOT_CONFIGURED' && /OPENAI_API_KEY is required for a live run/.test(error.message)
    );
    assert.ok(lines.some((line) => /warning: --gate has no baseline to compare with .*only --min-accuracy 0\.5 is checked/.test(line)), lines.join('\n'));
  } finally {
    if (saved !== undefined) {
      process.env.OPENAI_API_KEY = saved;
    }
  }
});

test('Ctrl-C stops the run once; a repeat within a second (npm forwards it) is ignored, a later one exits', () => {
  const handlers = new Map();
  const signals = { on: (name, handler) => handlers.set(name, handler), off: (name) => handlers.delete(name) };
  const logs = [];
  const exits = [];
  let clock = 1000;
  const stopper = createRunStopper({ cli: { log: (line) => logs.push(line), error: (line) => logs.push(line) }, signals, exit: (code) => exits.push(code), now: () => clock });
  assert.equal(stopper.signal.aborted, false);
  handlers.get('SIGINT')();
  assert.equal(stopper.signal.aborted, true);
  assert.equal(stopper.interruptedBy, 'SIGINT');
  assert.match(logs[0], /^Stopping: SIGINT received; in-flight cases are aborted and a partial report is written/);
  clock += 5;
  handlers.get('SIGINT')();
  assert.deepEqual(exits, [], 'the forwarded copy of the same keypress');
  clock += 2000;
  handlers.get('SIGTERM')();
  assert.deepEqual(exits, [130]);
  stopper.dispose();
  assert.equal(handlers.size, 0);

  // A provider rejection stops it without a signal.
  const other = createRunStopper({ cli: { log: () => {} }, signals: { on: () => {}, off: () => {} } });
  other.stop('the LLM provider rejected the request (HTTP_401)');
  assert.equal(other.signal.reason.message, 'the LLM provider rejected the request (HTTP_401)');
  assert.equal(other.interruptedBy, null);
});

test('a stopped run exits 2 and says why; cancelled repetitions are excluded', () => {
  const result = computeExitCode({
    ...fakeReport({ byOutcome: { pass: 1, llm_outage: 1, cancelled: 4 } }),
    stopped: { reason: 'the LLM provider rejected the request (HTTP_401)', cancelledCases: ['b', 'c'] },
  });
  assert.equal(result.code, 2);
  assert.deepEqual(result.reasons, [
    '1 repetition(s): LLM provider outage errors (llm_outage)',
    '4 repetition(s): did not finish because the run was stopped (cancelled)',
    'the run was stopped early: the LLM provider rejected the request (HTTP_401)',
  ]);
});

test('preflight never starts or recreates a compose database that is already running but unreachable', async () => {
  const commands = [];
  const run = async (command, args) => {
    commands.push(args.join(' '));
    return args[1] === 'ps' ? { code: 0, stdout: '3f2a9c1d0b7e\n' } : { code: 0 };
  };
  await assert.rejects(
    preflightDatabase({ env: { ...LOCAL_ENV, DB_PORT: '3307' }, connect: async () => Promise.reject(refused()), run }),
    (error) =>
      error.code === 'DB_UNREACHABLE' &&
      /not reachable at 127\.0\.0\.1:3307 \(ECONNREFUSED\), but the docker-compose mariadb service is already running/.test(error.message) &&
      /Check DB_HOST \/ DB_PORT/.test(error.message)
  );
  assert.deepEqual(commands, ['compose version', 'compose ps --status running -q mariadb'], 'no up, no recreate');

  // A failing "up" names the usual causes, not only the volume.
  await assert.rejects(
    preflightDatabase({
      env: LOCAL_ENV,
      connect: async () => Promise.reject(refused()),
      run: async (command, args) => (args[1] === 'up' ? { code: 1 } : { code: 0, stdout: '' }),
    }),
    (error) => error.code === 'DB_START_FAILED' && /Docker daemon is not running/.test(error.message) && /container name/.test(error.message)
  );
});

test('preflight warns before starting a database that it cannot seed (no admin credentials)', async () => {
  assert.equal(adminCredentialsHint(LOCAL_ENV), null);
  assert.match(adminCredentialsHint({ DB_PASSWORD: 'pw' }), /no admin credentials are set .* set DB_ADMIN_PASSWORD to it/);
  const logs = [];
  let probes = 0;
  const env = { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'demo_readonly', DB_PASSWORD: 'pw' };
  const connect = async () => {
    probes += 1;
    if (probes === 1) {
      throw refused();
    }
    return fakeConnection();
  };
  await preflightDatabase({ env, connect, run: async () => ({ code: 0, stdout: '' }), wait: async () => {}, log: (line) => logs.push(line) });
  assert.match(logs[0], /^warning: no admin credentials are set/);
  assert.match(logs[1], /starting it/);
  // Not when seeding is off.
  probes = 0;
  logs.length = 0;
  await preflightDatabase({ env, allowSeed: false, connect, run: async () => ({ code: 0, stdout: '' }), wait: async () => {}, log: (line) => logs.push(line) });
  assert.ok(!logs.some((line) => line.startsWith('warning')));
});

test('a fixture that cannot be seeded gives advice that fits the profile', async () => {
  const connect = async () => ({ end: async () => {} });
  const stale = async () => checkResult('missing');
  await assert.rejects(
    ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, allowSeed: false, noSeedReason: 'profile', strict: false, connect, check: stale }),
    (error) => /use "npm run eval", which seeds them/.test(error.message) && !/--no-seed/.test(error.message)
  );
  await assert.rejects(
    ensureFixtures({ fixtures: FIXTURES, schema: {}, env: LOCAL_ENV, allowSeed: false, connect, check: stale }),
    (error) => /drop --no-seed/.test(error.message)
  );
});
