import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import { selectSuite } from '../src/eval/suite.js';

// Opt-in end-to-end check of `npm run eval` (scripts/eval.js) against a real
// MariaDB and a local stand-in for the OpenAI API (no paid call). Enabled by
// TEST_MARIADB_PORT like the other real-DB tests; it may seed the fixture
// databases, so it needs the admin password and FAILS without it:
//
//   TEST_MARIADB_PORT=3306 TEST_MARIADB_PASSWORD=<DB_PASSWORD> \
//   TEST_MARIADB_ADMIN_PASSWORD=<root password> \
//     node --test test/eval-runner.integration.test.js
//
// The stand-in answers every question with its gold SQL, except:
// - core_public_004 gets a correct SQL that the FAN_OUT guardrail rejects
//   (the known false rejection, controls rp4) -> guardrail_false_rejection;
// - core_public_007 gets SQL without the IsActive filter -> wrong_result;
// - abstain / clarify cases get `SELECT 1` (answered instead of declining),
//   except hard_abstain_competitor_prices, which gets an empty query
//   (declined: handled correctly);
// - in the "regressed" mode six paraphrase cases get `SELECT 1`;
// - in the "expensive" mode every call reports 1M prompt tokens;
// - in the "slow" mode it answers after 5 s;
// - in the "unauthorized" mode it answers HTTP 401 (a wrong API key);
// - in the "wrong_endpoint" mode a plain HTTP 404, in "unknown_model" an
//   HTTP 400 with code model_not_found.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configured = Boolean(process.env.TEST_MARIADB_PORT);
const skip = configured ? false : 'set TEST_MARIADB_PORT (with TEST_MARIADB_PASSWORD and TEST_MARIADB_ADMIN_PASSWORD) to run npm run eval end to end';

function requireAdmin() {
  if (!process.env.TEST_MARIADB_ADMIN_PASSWORD) {
    throw new Error('TEST_MARIADB_ADMIN_PASSWORD is not set: npm run eval seeds missing or drifted fixtures with the admin role.');
  }
}

const REGRESSED = ['paraphrase_public_001', 'paraphrase_public_002', 'paraphrase_public_003', 'paraphrase_public_005', 'paraphrase_public_008', 'paraphrase_public_009'];
let mode = 'base';
let llmRequests = 0;
let server;
let baseUrl;
let outputRoot;

before(async () => {
  if (!configured) {
    return;
  }
  const cases = (await selectSuite()).entries.map((entry) => entry.testCase);
  const byQuestion = [...new Map(cases.map((testCase) => [testCase.question, testCase])).values()].sort((left, right) => right.question.length - left.question.length);
  const controls = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'datasets/controls/core-public.json'), 'utf8'));
  const falselyRejected = controls.core_public_004.positive.find((control) => control.id === 'rp4').sql;

  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      llmRequests += 1;
      if (mode === 'unauthorized') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      if (mode === 'wrong_endpoint') {
        // OPENAI_BASE_URL pointing at a server that has no such path.
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('404 page not found');
        return;
      }
      if (mode === 'unknown_model') {
        // An OpenAI-compatible server that answers 400 for a model it does not serve.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'The model `nope` does not exist.', type: 'invalid_request_error', code: 'model_not_found' } }));
        return;
      }
      const payload = JSON.parse(body || '{}');
      const userText = (payload.messages || []).filter((message) => message.role === 'user').map((message) => message.content).join('\n');
      const testCase = byQuestion.find((entry) => userText.includes(entry.question));
      let sql = testCase?.expected_sql || 'SELECT 1';
      if (testCase?.id === 'hard_abstain_competitor_prices') {
        sql = '';
      } else if (testCase?.id === 'core_public_004') {
        sql = falselyRejected;
      } else if (testCase?.id === 'core_public_007') {
        sql = 'SELECT COUNT(*) AS active_customers FROM Customer';
      } else if (mode === 'regressed' && REGRESSED.includes(testCase?.id)) {
        sql = 'SELECT 1';
      }
      const content = JSON.stringify({ sql, explanation: 'stand-in', tables_used: testCase?.expected_tables || [], assumptions: [] });
      const promptTokens = mode === 'expensive' ? 1_000_000 : 2000;
      setTimeout(
        () => {
          if (response.destroyed) {
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'stand-in',
              object: 'chat.completion',
              model: payload.model,
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
              usage: { prompt_tokens: promptTokens, completion_tokens: 50, total_tokens: promptTokens + 50 },
            })
          );
        },
        mode === 'slow' ? 5000 : 0
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-eval-'));
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (outputRoot) {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

function evalEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DB_HOST: process.env.TEST_MARIADB_HOST || '127.0.0.1',
    DB_PORT: process.env.TEST_MARIADB_PORT,
    DB_USER: process.env.TEST_MARIADB_USER || 'demo_readonly',
    DB_PASSWORD: process.env.TEST_MARIADB_PASSWORD,
    DB_ADMIN_USER: process.env.TEST_MARIADB_ADMIN_USER || 'root',
    DB_ADMIN_PASSWORD: process.env.TEST_MARIADB_ADMIN_PASSWORD,
    DB_NAME: 'demo_retail',
    // Never pick up a developer .env.
    ENV_FILE: path.join(os.tmpdir(), 'txt2sql-no-such-env-file.env'),
    OPENAI_API_KEY: 'stand-in-key-not-a-secret',
    OPENAI_BASE_URL: baseUrl,
    MODEL_NAME: 'gpt-4o-mini',
  };
}

// The first tests run the three original datasets (26 cases, 17 intents), so
// their numbers do not move when datasets are added; the last one runs the
// whole default suite.
const LEGACY = ['--dataset', 'core-public,paraphrase-public,edge-cases-public'];

function evalArgs(args, outputDir) {
  return [path.join(REPO_ROOT, 'scripts/eval.js'), '--no-docker', '--no-baseline', '--output-dir', outputDir, ...args];
}

function runEval(args, label) {
  const env = evalEnv();
  const outputDir = path.join(outputRoot, label);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      evalArgs(args, outputDir),
      { env, cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, outputDir })
    );
  });
}

async function findReport(outputDir) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === 'report.json') {
        found.push(full);
      }
    }
  };
  await walk(outputDir);
  assert.equal(found.length, 1, `one report.json under ${outputDir}`);
  return { reportPath: found[0], report: JSON.parse(await fs.readFile(found[0], 'utf8')) };
}

const outcomesOf = (report) => Object.fromEntries(report.results.map((record) => [record.id, record.repetitions.map((rep) => rep.outcome)]));

let first;

test('npm run eval: fixtures, verification, a concurrent repeated run, attribution, report files', { skip }, async () => {
  requireAdmin();
  mode = 'base';
  const run = await runEval([...LEGACY, '--concurrency', '2', '--repeat', '2'], 'run');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Verify: 26 unique case\(s\) on 3 fixture\(s\), 0 with problems\./);
  assert.match(run.stdout, /Strict accuracy 92\.3% \(95% CI [\d.]+%–100\.0%\) over 26 cases \/ 17 intents, 2 repetition\(s\), gpt-4o-mini/);
  const { reportPath, report } = await findReport(run.outputDir);
  first = { reportPath, report };
  assert.match(reportPath, /[/\\]core-public-paraphrase-public-edge-cases-public[/\\]gpt-4o-mini[/\\]report\.json$/);

  assert.equal(report.reportVersion, 2);
  assert.equal(report.mode, 'run');
  assert.equal(report.verification.skipped, false);
  assert.deepEqual(report.verification.problems, []);
  assert.deepEqual(report.oracle.fixtures.map((fixture) => [fixture.name, fixture.status]), [['seed', 'current'], ['v2', 'current'], ['v3', 'current']]);
  assert.equal(report.stats.cases.counted, 26);
  assert.equal(report.stats.cases.intents, 17);
  assert.equal(report.stats.repeat, 2);
  assert.ok(report.results.every((record) => record.repetitions.length === 2));

  const byId = Object.fromEntries(report.results.map((record) => [record.id, record]));
  const guarded = byId.core_public_004;
  assert.deepEqual([guarded.summary.outcome, guarded.summary.bucket, guarded.summary.passes], ['guardrail_false_rejection', 'system', 0]);
  for (const rep of guarded.repetitions) {
    assert.deepEqual(rep.attempts.map((attempt) => [attempt.validation.code, attempt.validation.layer, attempt.guardrailCheck.verdict]), [
      ['FAN_OUT', 'guardrail', 'false_rejection'],
      ['FAN_OUT', 'guardrail', 'false_rejection'],
    ]);
  }
  assert.deepEqual([byId.core_public_007.summary.outcome, byId.core_public_007.summary.bucket], ['wrong_result', 'model']);
  assert.equal(report.results.filter((record) => record.summary.outcome === 'pass').length, 24);
  assert.deepEqual(report.attribution.repetitions.byBucket, { pass: 48, model: 2, system: 2 });
  assert.equal(report.attribution.system.guardrailFalseRejections, 2);
  const matrix = report.attribution.guardrailConfusion;
  assert.deepEqual([matrix.tp, matrix.fp, matrix.fn, matrix.tn], [0, 4, 2, 48]);

  // Provenance: versions recorded, endpoint host only, no key anywhere.
  assert.match(report.provenance.promptVersion, /^[0-9a-f]{64}$/);
  assert.match(report.provenance.semanticLayerVersion, /^[0-9a-f]{64}$/);
  assert.equal(report.provenance.llmEndpoint.host, new URL(baseUrl).host);
  assert.equal(report.provenance.datasets.length, 3);
  assert.doesNotMatch(await fs.readFile(reportPath, 'utf8'), /stand-in-key-not-a-secret/);

  const markdown = await fs.readFile(reportPath.replace(/report\.json$/, 'report.md'), 'utf8');
  for (const heading of ['## Attribution', '## Guardrail confusion matrix', '## Cases', '## Provenance']) {
    assert.ok(markdown.includes(heading), heading);
  }
  assert.match(markdown, /\| core_public_004 \| How many products were sold in February 2026 but not in Mar… \| 0\/2 \| guardrail_false_rejection \| system \|/);

  const trace = (await fs.readFile(report.traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const started = trace.find((entry) => entry.event === 'run.started');
  assert.equal(started.promptVersion, report.provenance.promptVersion.slice(0, 12));
  assert.equal(started.semanticLayerVersion, report.provenance.semanticLayerVersion.slice(0, 12));
  assert.ok(trace.some((entry) => entry.event === 'llm.completed' && entry.caseId === 'core_public_001'));
  assert.ok(trace.some((entry) => entry.event === 'run.completed'));
});

test('--rescore reproduces every outcome with zero LLM calls', { skip }, async () => {
  assert.ok(first, 'needs the first run');
  mode = 'regressed'; // would change answers if any LLM call were made
  const run = await runEval(['--rescore', first.reportPath], 'rescore');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { report } = await findReport(run.outputDir);
  assert.equal(report.mode, 'rescore');
  assert.equal(report.rescoredFrom.sha256.length, 64);
  assert.deepEqual(outcomesOf(report), outcomesOf(first.report));
  assert.deepEqual(report.attribution.guardrailConfusion, first.report.attribution.guardrailConfusion);
  assert.equal(report.comparison.paired, 26);
  assert.deepEqual([report.comparison.mcnemar.regressions, report.comparison.mcnemar.improvements, report.comparison.mcnemar.p], [0, 0, 1]);
  assert.match(run.stdout, /\[rescore, no LLM calls\]/);
});

test('--compare prints a paired table with McNemar p; --gate fails a significant regression', { skip }, async () => {
  assert.ok(first, 'needs the first run');
  mode = 'regressed';
  const run = await runEval([...LEGACY, '--compare', first.reportPath, '--gate'], 'compare');
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
  // The console prints the paired 2x2 table, the McNemar p and the flipped cases.
  assert.match(run.stdout, /Paired comparison with .*report\.json: 26 paired case\(s\)\n {17}candidate pass {2}candidate fail\n {2}baseline pass {14}18 {15}6\n {2}baseline fail {15}0 {15}2\n/);
  assert.match(run.stdout, /strict accuracy \(paired cases\) 92\.3% → 69\.2%: Δ −23\.1 pts \(95% CI .*\)/);
  assert.match(run.stdout, /exact McNemar p = 0\.031 \(6 regression\(s\), 0 improvement\(s\)\) → significantly WORSE than the baseline/);
  assert.match(run.stdout, /regressions: paraphrase_public_001 \(pass → (wrong_result|guardrail_true_rejection)\), /);
  assert.match(run.stdout, /GATE: significantly worse than the baseline/);
  const { report } = await findReport(run.outputDir);
  assert.equal(report.comparison.verdict, 'worse');
  assert.deepEqual(report.comparison.flips.regressions.map((entry) => entry.id), [...REGRESSED].sort());
  const markdown = await fs.readFile(path.join(path.dirname(report.traceFile), 'report.md'), 'utf8');
  assert.match(markdown, /### Regressions \(baseline majority pass → candidate fail\)/);
  // `SELECT 1` is either rejected by a guardrail (its tables_used do not match) or runs and mismatches.
  assert.match(markdown, /\| paraphrase_public_001 \| Who are our biggest buyers in March 2026\? \| 100% \(pass\) \| 0% \((wrong_result|guardrail_true_rejection)\) \|/);
});

test('--write-baseline writes a compact baseline that rescores, compares and gates like the full report', { skip }, async () => {
  requireAdmin();
  mode = 'base';
  const baselineFile = path.join(outputRoot, 'compact-baseline', 'subset.json');
  const run = await runEval([...LEGACY, '--repeat', '2', '--write-baseline', '--baseline-file', baselineFile], 'compact-baseline');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Baseline written: \S+subset\.json \(compact, [\d.]+ MB; the full report is \S+report\.json\)/);
  const { reportPath, report } = await findReport(run.outputDir);
  const compact = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
  assert.deepEqual([compact.compact, compact.compactVersion, compact.reportVersion], [true, 1, 2]);
  assert.ok((await fs.stat(baselineFile)).size * 3 < (await fs.stat(reportPath)).size, 'the compact baseline is a fraction of report.json');
  assert.deepEqual(outcomesOf(compact), outcomesOf(report));

  // Rescored with zero LLM calls, the compact baseline gives the full report's outcomes and statistics.
  const [fromFull, fromCompact] = await Promise.all([
    runEval(['--rescore', reportPath, '--skip-verify', ...LEGACY], 'compact-rescore-full'),
    runEval(['--rescore', baselineFile, '--skip-verify', ...LEGACY], 'compact-rescore-compact'),
  ]);
  assert.equal(fromFull.code, 0, fromFull.stdout + fromFull.stderr);
  assert.equal(fromCompact.code, 0, fromCompact.stdout + fromCompact.stderr);
  const full = (await findReport(fromFull.outputDir)).report;
  const rescored = (await findReport(fromCompact.outputDir)).report;
  assert.deepEqual(outcomesOf(rescored), outcomesOf(full));
  assert.deepEqual(
    rescored.results.map((record) => record.summary),
    full.results.map((record) => record.summary)
  );
  for (const block of ['attribution', 'behavior']) {
    assert.deepEqual(rescored[block], full[block], block);
  }
  const { cost, tokens, retries, strictAccuracy, cases } = full.stats;
  assert.deepEqual(
    { cost, tokens, retries, strictAccuracy, cases },
    { cost: rescored.stats.cost, tokens: rescored.stats.tokens, retries: rescored.stats.retries, strictAccuracy: rescored.stats.strictAccuracy, cases: rescored.stats.cases }
  );
  assert.equal(rescored.rescoredFrom.compact, true);
  assert.equal(full.rescoredFrom.compact, false);

  // --compare / --gate against it: a rescore of the full report pairs every case, a regressed live run fails the gate.
  const gated = await runEval(['--rescore', reportPath, '--compare', baselineFile, '--gate', '--skip-verify', ...LEGACY], 'compact-gate-rescore');
  assert.equal(gated.code, 0, gated.stdout + gated.stderr);
  const gatedReport = (await findReport(gated.outputDir)).report;
  assert.deepEqual([gatedReport.comparison.paired, gatedReport.comparison.mcnemar.regressions, gatedReport.comparison.mcnemar.improvements], [26, 0, 0]);
  mode = 'regressed';
  try {
    const regressed = await runEval([...LEGACY, '--compare', baselineFile, '--gate'], 'compact-gate-live');
    assert.equal(regressed.code, 1, regressed.stdout + regressed.stderr);
    assert.match(regressed.stdout, /exact McNemar p = 0\.031 \(6 regression\(s\), 0 improvement\(s\)\) → significantly WORSE than the baseline/);
  } finally {
    mode = 'base';
  }
});

test('the whole default suite: splits, behaviour cases and known validator rejections end to end', { skip }, async () => {
  requireAdmin();
  mode = 'base';
  const selection = await selectSuite();
  const cases = selection.entries.map((entry) => entry.testCase);
  const behavior = cases.filter((testCase) => testCase.expected_behavior !== 'answer');
  const answer = cases.filter((testCase) => testCase.expected_behavior === 'answer');
  const flagged = answer.filter((testCase) => testCase.known_validator_rejection);
  const run = await runEval(['--concurrency', '4'], 'full');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { reportPath, report } = await findReport(run.outputDir);
  assert.match(reportPath, /[/\\]all[/\\]gpt-4o-mini[/\\]report\.json$/);
  assert.equal(report.results.length, cases.length);
  assert.equal(report.verification.datasets.length, 5);
  assert.ok(report.verification.datasets.every((dataset) => !dataset.controls || dataset.controls.design.rate >= 0.95));

  // Behaviour cases: never in accuracy, reported on their own.
  assert.equal(report.stats.cases.behavior, behavior.length);
  assert.equal(report.stats.cases.counted, answer.length);
  assert.equal(report.behavior.cases, behavior.length);
  assert.equal(report.behavior.handled, 1);
  const byId = Object.fromEntries(report.results.map((record) => [record.id, record]));
  assert.equal(byId.hard_abstain_competitor_prices.summary.outcome, 'declined');
  for (const testCase of behavior.filter((entry) => entry.id !== 'hard_abstain_competitor_prices')) {
    assert.equal(byId[testCase.id].summary.outcome, `answered_instead_of_${testCase.expected_behavior}`, testCase.id);
    assert.equal(byId[testCase.id].summary.counted, 0, testCase.id);
  }

  // A known validator rejection of the gold itself is a system failure (a
  // guardrail false rejection, or a retrieval miss: the table was not
  // allowed); a case whose flag concerns an alternative reading passes with
  // the gold. Everything else passes but the two scripted cases.
  let systemFailures = 0;
  for (const testCase of flagged) {
    const record = byId[testCase.id];
    if (record.summary.outcome === 'pass') {
      assert.ok(testCase.alternative_expected_sql.length > 0, `${testCase.id} passed although its gold is flagged`);
      continue;
    }
    systemFailures += 1;
    assert.equal(record.summary.bucket, 'system', `${testCase.id}: ${record.summary.outcome} ${record.summary.tags.join(',')}`);
    assert.ok(
      record.summary.outcome === 'guardrail_false_rejection' || record.summary.tags.includes('retrieval_miss'),
      `${testCase.id}: ${record.summary.outcome} ${record.summary.tags.join(',')}`
    );
  }
  assert.ok(systemFailures >= flagged.length - 1, `${systemFailures} of ${flagged.length}`);
  const passes = report.results.filter((record) => record.summary.outcome === 'pass').length;
  assert.equal(passes, answer.length - systemFailures - 2);
  assert.equal(report.stats.strictAccuracy.value, Number((passes / answer.length).toFixed(4)));
  assert.deepEqual(report.stats.bySplit.map((entry) => entry.key), ['dev', 'holdout']);
  assert.equal(report.stats.bySplit.reduce((sum, entry) => sum + entry.cases, 0), answer.length);

  const markdown = await fs.readFile(reportPath.replace(/report\.json$/, 'report.md'), 'utf8');
  assert.match(markdown, new RegExp(`Behaviour cases: abstain/clarify — ${behavior.length} cases, 1 handled correctly\\.`));
  assert.match(markdown, /By split: dev [\d.]+% \(\d+ cases\) · holdout [\d.]+% \(\d+ cases\)\./);
  assert.match(markdown, /## Behaviour cases \(abstain \/ clarify\)/);
  assert.match(run.stdout, /ok   hard_abstain_competitor_prices: declined \(expects abstain\)/);

  // --split holdout runs only holdout cases.
  const holdout = await runEval(['--split', 'holdout', '--concurrency', '4', '--skip-verify'], 'holdout');
  assert.equal(holdout.code, 0, `${holdout.stdout}\n${holdout.stderr}`);
  const { report: holdoutReport } = await findReport(holdout.outputDir);
  assert.ok(holdoutReport.results.length > 0 && holdoutReport.results.every((record) => record.split === 'holdout'));
  assert.equal(holdoutReport.suite.filters.split, 'holdout');
});

test('behaviour-only selections: the benchmark profile fails an answered case; --min-accuracy is refused before any LLM call', { skip }, async () => {
  mode = 'base';
  // The stand-in answers every abstain case with SQL except
  // hard_abstain_competitor_prices, which it declines.
  const unanswerable = ['--dataset', 'hard-cases-public', '--tag', 'unanswerable'];
  const answered = await runEval(['--profile', 'benchmark', ...unanswerable], 'benchmark-behaviour');
  assert.equal(answered.code, 1, `${answered.stdout}\n${answered.stderr}`);
  assert.match(answered.stdout, /FAIL: 4 case\(s\) failed \(benchmark profile, single run; 4 abstain\/clarify case\(s\) answered instead of declining\)/);
  const declined = await runEval(['--profile', 'benchmark', '--dataset', 'hard-cases-public', '--case-id', 'hard_abstain_competitor_prices'], 'benchmark-declined');
  assert.equal(declined.code, 0, `${declined.stdout}\n${declined.stderr}`);

  const before = llmRequests;
  const gated = await runEval([...unanswerable, '--skip-verify', '--gate', '--min-accuracy', '0.8'], 'min-accuracy-behaviour');
  assert.equal(gated.code, 2, `${gated.stdout}\n${gated.stderr}`);
  assert.match(`${gated.stdout}${gated.stderr}`, /--min-accuracy 0\.8 cannot be checked: no answer case was selected \(only 5 abstain \/ clarify case\(s\)/);
  assert.equal(llmRequests, before, 'refused before any LLM call');
});

test('--budget-usd stops starting cases once the spend reaches the budget', { skip }, async () => {
  mode = 'expensive';
  const run = await runEval(['--dataset', 'core-public', '--concurrency', '1', '--budget-usd', '0.2', '--skip-verify'], 'budget');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { report } = await findReport(run.outputDir);
  // $0.15 per call: case 1 spends 0.15 (< 0.2), case 2 starts and reaches 0.30; the other 7 are skipped.
  assert.equal(report.budget.exhausted, true);
  assert.equal(report.budget.skippedCases.length, 7);
  assert.ok(report.budget.spentUsd >= 0.3 && report.budget.spentUsd < 0.31, String(report.budget.spentUsd));
  assert.equal(report.attribution.excluded.skipped_budget, 7);
  assert.equal(report.stats.cases.counted, 2);
});

test('--case-timeout-ms aborts a slow case and records a timeout (a harness failure for the exit code)', { skip }, async () => {
  mode = 'slow';
  const started = Date.now();
  const run = await runEval(['--case-id', 'core_public_003', '--case-timeout-ms', '1500', '--skip-verify'], 'deadline');
  assert.equal(run.code, 2, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /HARNESS: 1 repetition\(s\): hit the case deadline/);
  const { report } = await findReport(run.outputDir);
  const [rep] = report.results[0].repetitions;
  assert.deepEqual([rep.status, rep.outcome, rep.counted, rep.error_code], ['aborted', 'timeout', true, 'CASE_TIMEOUT']);
  assert.ok(Date.now() - started < 30_000);
  mode = 'base';
});

test('a rejected API key stops the run after the first answer instead of attempting every case', { skip }, async () => {
  mode = 'unauthorized';
  const run = await runEval(['--dataset', 'core-public', '--concurrency', '1', '--skip-verify'], 'unauthorized');
  mode = 'base';
  assert.equal(run.code, 2, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Stopping: the LLM provider rejected the request \(HTTP_401: check OPENAI_API_KEY, OPENAI_BASE_URL and the model\)/);
  const { report } = await findReport(run.outputDir);
  assert.deepEqual(report.attribution.repetitions.byOutcome, { llm_outage: 1, cancelled: 8 });
  assert.equal(report.stopped.cancelledCases.length, 8);
  assert.match(run.stdout, /HARNESS: the run was stopped early: the LLM provider rejected the request/);
});

test('a wrong endpoint or an unknown model stops the run as a provider outage, not as model failures', { skip }, async () => {
  for (const [label, code] of [
    ['wrong_endpoint', 'HTTP_404'],
    ['unknown_model', 'LLM_MODEL_NOT_FOUND'],
  ]) {
    mode = label;
    const run = await runEval(['--dataset', 'core-public', '--concurrency', '1', '--skip-verify'], label);
    mode = 'base';
    assert.equal(run.code, 2, `${label}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, new RegExp(`Stopping: the LLM provider rejected the request \\(${code}: check OPENAI_API_KEY, OPENAI_BASE_URL and the model\\)`));
    const { report } = await findReport(run.outputDir);
    // One repetition is an outage (excluded from accuracy), the rest never ran.
    assert.deepEqual(report.attribution.repetitions.byOutcome, { llm_outage: 1, cancelled: 8 }, label);
    assert.equal(report.stats.strictAccuracy.value, null, 'no fabricated 0% model score');
    assert.match(run.stdout, /HARNESS: /);
  }
});

test('Ctrl-C (SIGINT) aborts in-flight cases and still writes a partial report (exit 130)', { skip }, async () => {
  mode = 'slow';
  const outputDir = path.join(outputRoot, 'sigint');
  const child = spawn(process.execPath, evalArgs(['--dataset', 'core-public', '--concurrency', '2', '--skip-verify'], outputDir), { env: evalEnv(), cwd: REPO_ROOT });
  let stdout = '';
  let signalled = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!signalled && /Running 9 case/.test(stdout)) {
      signalled = true;
      setTimeout(() => child.kill('SIGINT'), 1000);
    }
  });
  child.stderr.on('data', (chunk) => {
    stdout += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', (exitCode) => resolve(exitCode)));
  mode = 'base';
  assert.equal(code, 130, stdout);
  assert.match(stdout, /Stopping: SIGINT received; in-flight cases are aborted and a partial report is written/);
  assert.match(stdout, /INTERRUPTED: interrupted by SIGINT; the report is partial/);
  const { report } = await findReport(outputDir);
  assert.equal(report.stopped.signal, 'SIGINT');
  assert.deepEqual(report.attribution.repetitions.byOutcome, { cancelled: 9 });
  assert.ok(report.results.filter((record) => record.repetitions[0].cancelled_in_flight).length === 2, 'the two in-flight cases were aborted');
});

test('npm run eval: a missing controls directory, or controls for other cases, stop the run before any LLM call (exit 2)', { skip }, async () => {
  requireAdmin();
  const missing = await runEval(['--offline', '--controls-dir', path.join(outputRoot, 'no-such-controls')], 'controls-missing');
  assert.equal(missing.code, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /Cannot load the oracle controls: Controls directory .*no-such-controls does not exist/);

  const otherDir = path.join(outputRoot, 'other-controls');
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, 'other.json'), JSON.stringify({ not_a_case_here: { negative: [{ id: 'm1', type: 'join_path', sql: 'SELECT 1' }] } }));
  const uncovered = await runEval(['--offline', '--dataset', 'core-public', '--controls-dir', otherDir], 'controls-uncovered');
  assert.equal(uncovered.code, 2, uncovered.stdout + uncovered.stderr);
  assert.match(uncovered.stdout + uncovered.stderr, /No oracle controls in .*other-controls apply to core-public/);
  assert.doesNotMatch(uncovered.stdout, /^Verify:/m, 'stopped before verification');
});

test('npm run eval --write-baseline: a run of one dataset never replaces the default baseline', { skip }, async () => {
  requireAdmin();
  // A model name of its own, so the default baseline path is not a real one.
  const model = `subset-guard-${process.pid}`;
  const target = path.join(REPO_ROOT, 'eval/baselines', `${model}.json`);
  try {
    const run = await runEval(['--dataset', 'core-public', '--model', model, '--write-baseline', '--skip-verify'], 'baseline-subset');
    assert.equal(run.code, 2, run.stdout + run.stderr);
    const suiteSize = (await selectSuite()).entries.length;
    assert.match(run.stdout + run.stderr, new RegExp(`--write-baseline refused before the run: the run selects 9 of the default suite's ${suiteSize} case\\(s\\)`));
    assert.doesNotMatch(run.stdout, /^Running /m, 'nothing ran');
    await assert.rejects(fs.access(target), 'no baseline written');
  } finally {
    await fs.rm(target, { force: true });
  }
});

test('--gate exits 2 when the baseline is not a report, or pairs no case with the run', { skip }, async () => {
  assert.ok(first, 'needs the first run');
  const empty = path.join(outputRoot, 'empty-baseline.json');
  await fs.writeFile(empty, '{}');
  const invalid = await runEval(['--rescore', first.reportPath, '--compare', empty, '--gate'], 'gate-invalid');
  assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout + invalid.stderr, /empty-baseline\.json is not an evaluation report \(no results\[\]\)/);

  // Every case id renamed: a valid report, but nothing to pair.
  const renamed = path.join(outputRoot, 'renamed-baseline.json');
  await fs.writeFile(renamed, JSON.stringify({ ...first.report, results: first.report.results.map((record) => ({ ...record, id: `renamed_${record.id}` })) }));
  const unpaired = await runEval(['--rescore', first.reportPath, '--compare', renamed, '--gate'], 'gate-unpaired');
  assert.equal(unpaired.code, 2, unpaired.stdout + unpaired.stderr);
  assert.match(unpaired.stdout, /HARNESS: --gate compared no case with the baseline \S*renamed-baseline\.json: 0 of this run's 26 case\(s\) paired \(26 not in the baseline\)/);
});

// Kills every connection of the query user once one of them runs a statement
// containing `marker` (a deliberately slow SLEEP), like a database restart or
// a network drop in the middle of a read. Resolves with how many it killed.
async function killQueryConnectionsDuring(marker, { timeoutMs = 60_000 } = {}) {
  const admin = await mysql.createConnection({
    host: process.env.TEST_MARIADB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_MARIADB_PORT),
    user: process.env.TEST_MARIADB_ADMIN_USER || 'root',
    password: process.env.TEST_MARIADB_ADMIN_PASSWORD,
  });
  try {
    const user = process.env.TEST_MARIADB_USER || 'demo_readonly';
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const [rows] = await admin.query('SELECT ID, INFO FROM information_schema.PROCESSLIST WHERE USER = ?', [user]);
      if (rows.some((row) => String(row.INFO || '').includes(marker))) {
        for (const row of rows) {
          await admin.query(`KILL CONNECTION ${Number(row.ID)}`).catch(() => null);
        }
        return rows.length;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return 0;
  } finally {
    await admin.end();
  }
}

function runScript(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO_ROOT, script), ...args], { env: evalEnv(), cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr })
    );
  });
}

test('a connection dropped during verification, verify-dataset or a rescore exits 2 (never 0 with no verdict)', { skip }, async () => {
  requireAdmin();
  assert.ok(first, 'needs the first run');
  // A control that sleeps, so the connection can be killed while it is read.
  const controlsDir = path.join(outputRoot, 'sleepy-controls');
  await fs.cp(path.join(REPO_ROOT, 'datasets/controls'), controlsDir, { recursive: true });
  const controlsFile = path.join(controlsDir, 'core-public.json');
  const controls = JSON.parse(await fs.readFile(controlsFile, 'utf8'));
  controls.core_public_001.negative[0].sql = 'SELECT SLEEP(4) AS CustomerName, 1 AS total_net_amount';
  await fs.writeFile(controlsFile, JSON.stringify(controls));

  const [killedInVerify, verify] = await Promise.all([killQueryConnectionsDuring('SLEEP(4)'), runEval(['--offline', '--controls-dir', controlsDir], 'dropped-verify')]);
  assert.ok(killedInVerify > 0, verify.stdout + verify.stderr);
  assert.equal(verify.code, 2, verify.stdout + verify.stderr);
  assert.match(verify.stderr + verify.stdout, /The database failed during verification/);

  const [killedInDatasetCheck, dataset] = await Promise.all([
    killQueryConnectionsDuring('SLEEP(4)'),
    runScript('scripts/verify-dataset.js', ['--dataset', 'core-public', '--controls-dir', controlsDir]),
  ]);
  assert.ok(killedInDatasetCheck > 0, dataset.stdout + dataset.stderr);
  // A verdict, and it is a failure: the controls the drop interrupted are unscored.
  assert.equal(dataset.code, 1, dataset.stdout + dataset.stderr);
  assert.match(dataset.stdout, /^Verified 9 cases across 1 dataset\(s\) on 3 fixture\(s\); [1-9]\d* failure\(s\)\.$/m);
  assert.match(dataset.stdout, /negative control m1 could not be scored: infrastructure error/);

  // A gold that sleeps, read while rescoring a recorded report.
  const datasetsDir = path.join(outputRoot, 'sleepy-datasets');
  await fs.mkdir(datasetsDir, { recursive: true });
  for (const name of ['core-public', 'paraphrase-public', 'edge-cases-public']) {
    const cases = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'datasets', `${name}.json`), 'utf8'));
    for (const testCase of cases) {
      if (testCase.id === 'core_public_001') {
        testCase.expected_sql = 'SELECT SLEEP(4) AS s';
        delete testCase.expected_row_counts;
      }
    }
    await fs.writeFile(path.join(datasetsDir, `${name}.json`), JSON.stringify(cases));
  }
  const [killedInRescore, rescore] = await Promise.all([
    killQueryConnectionsDuring('SLEEP(4)'),
    runEval(['--rescore', first.reportPath, '--skip-verify', '--datasets-dir', datasetsDir], 'dropped-rescore'),
  ]);
  assert.ok(killedInRescore > 0, rescore.stdout + rescore.stderr);
  assert.equal(rescore.code, 2, rescore.stdout + rescore.stderr);
  assert.match(rescore.stdout, /HARNESS: \d+ repetition\(s\): database infrastructure errors \(infra_error\)/);
});

test('--gate on a rescore exits 2 when the recorded report does not cover today\'s suite (renamed ids, a subset baseline)', { skip }, async () => {
  assert.ok(first, 'needs the first run');
  // Today's datasets with every case id renamed: the recorded report pairs with itself, not with them.
  const datasetsDir = path.join(outputRoot, 'renamed-datasets');
  await fs.mkdir(datasetsDir, { recursive: true });
  for (const name of ['core-public', 'paraphrase-public', 'edge-cases-public']) {
    const cases = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'datasets', `${name}.json`), 'utf8'));
    await fs.writeFile(path.join(datasetsDir, `${name}.json`), JSON.stringify(cases.map((testCase) => ({ ...testCase, id: `v2_${testCase.id}` }))));
  }
  const renamed = await runEval(['--rescore', first.reportPath, '--gate', '--skip-verify', '--datasets-dir', datasetsDir], 'gate-renamed-suite');
  assert.equal(renamed.code, 2, renamed.stdout + renamed.stderr);
  assert.match(renamed.stdout, /HARNESS: --gate checked none of today's 26 suite case\(s\) against the baseline \S+: 26 not in the rescored report/);

  // A one-case recorded report (today's suite: the three datasets it was run on).
  const oneCase = path.join(outputRoot, 'one-case-report.json');
  await fs.writeFile(oneCase, JSON.stringify({ ...first.report, results: first.report.results.slice(0, 1) }));
  const subset = await runEval(['--rescore', oneCase, '--gate', '--skip-verify', ...LEGACY], 'gate-subset-suite');
  assert.equal(subset.code, 2, subset.stdout + subset.stderr);
  assert.match(subset.stdout, /HARNESS: --gate checked only 1 of today's 26 suite case\(s\) \(below 50%\)/);

  // The full recorded report covers the suite it was run on, but not the
  // whole default suite (26 of its answer cases).
  const full = await runEval(['--rescore', first.reportPath, '--gate', '--skip-verify', ...LEGACY], 'gate-full-suite');
  assert.equal(full.code, 0, full.stdout + full.stderr);
  const answerCases = (await selectSuite()).entries.filter((entry) => !['abstain', 'clarify'].includes(entry.testCase.expected_behavior)).length;
  const wholeSuite = await runEval(['--rescore', first.reportPath, '--gate', '--skip-verify'], 'gate-whole-suite');
  assert.equal(wholeSuite.code, 2, wholeSuite.stdout + wholeSuite.stderr);
  assert.match(wholeSuite.stdout, new RegExp(`HARNESS: --gate checked only 26 of today's ${answerCases} suite case\\(s\\) \\(below 50%\\)`));
});

test('--rescore --case-id with a dropped duplicate\'s id rescores the kept case, as a live run would run it', { skip }, async () => {
  assert.ok(first, 'needs the first run');
  const datasetsDir = path.join(outputRoot, 'aliased-datasets');
  await fs.mkdir(datasetsDir, { recursive: true });
  for (const name of ['core-public', 'paraphrase-public', 'edge-cases-public']) {
    await fs.copyFile(path.join(REPO_ROOT, 'datasets', `${name}.json`), path.join(datasetsDir, `${name}.json`));
  }
  const core = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'datasets/core-public.json'), 'utf8'));
  const original = core.find((testCase) => testCase.id === 'core_public_001');
  await fs.writeFile(path.join(datasetsDir, 'zz-alias.json'), JSON.stringify([{ ...original, id: 'zz_alias_001' }]));

  const run = await runEval(['--rescore', first.reportPath, '--skip-verify', '--datasets-dir', datasetsDir, '--case-id', 'zz_alias_001'], 'rescore-alias');
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /note: --case-id zz_alias_001 is a duplicate of core_public_001 \(same question and gold\), which is rescored in its place/);
  const { report } = await findReport(run.outputDir);
  assert.deepEqual(report.results.map((record) => record.id), ['core_public_001']);
});
