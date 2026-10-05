import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBenchmarkDataset } from '../src/benchmark.js';

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
// - in the "regressed" mode six paraphrase cases get `SELECT 1`;
// - in the "expensive" mode every call reports 1M prompt tokens;
// - in the "slow" mode it answers after 5 s.

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
let server;
let baseUrl;
let outputRoot;

before(async () => {
  if (!configured) {
    return;
  }
  const cases = [];
  for (const datasetName of ['core-public', 'paraphrase-public', 'edge-cases-public']) {
    cases.push(...(await loadBenchmarkDataset({ datasetName })).cases);
  }
  const byQuestion = [...new Map(cases.map((testCase) => [testCase.question, testCase])).values()].sort((left, right) => right.question.length - left.question.length);
  const controls = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'datasets/controls/core-public.json'), 'utf8'));
  const falselyRejected = controls.core_public_004.positive.find((control) => control.id === 'rp4').sql;

  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const userText = (payload.messages || []).filter((message) => message.role === 'user').map((message) => message.content).join('\n');
      const testCase = byQuestion.find((entry) => userText.includes(entry.question));
      let sql = testCase?.expected_sql || 'SELECT 1';
      if (testCase?.id === 'core_public_004') {
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

function runEval(args, label) {
  const env = {
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
  const outputDir = path.join(outputRoot, label);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/eval.js'), '--no-docker', '--no-baseline', '--output-dir', outputDir, ...args],
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
  const run = await runEval(['--concurrency', '2', '--repeat', '2'], 'run');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Verify: 26 unique case\(s\) on 3 fixture\(s\), 0 with problems\./);
  assert.match(run.stdout, /Strict accuracy 92\.3% \(95% CI [\d.]+%–100\.0%\) over 26 cases \/ 17 intents, 2 repetition\(s\), gpt-4o-mini/);
  const { reportPath, report } = await findReport(run.outputDir);
  first = { reportPath, report };
  assert.match(reportPath, /[/\\]all[/\\]gpt-4o-mini[/\\]report\.json$/);

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
  const run = await runEval(['--compare', first.reportPath, '--gate'], 'compare');
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /vs baseline: Δ −23\.1 pts \(95% CI .*\) on 26 paired case\(s\); 6 regression\(s\), 0 improvement\(s\); exact McNemar p = 0\.031 → significantly WORSE than the baseline/);
  assert.match(run.stdout, /GATE: significantly worse than the baseline/);
  const { report } = await findReport(run.outputDir);
  assert.equal(report.comparison.verdict, 'worse');
  assert.deepEqual(report.comparison.flips.regressions.map((entry) => entry.id), [...REGRESSED].sort());
  const markdown = await fs.readFile(path.join(path.dirname(report.traceFile), 'report.md'), 'utf8');
  assert.match(markdown, /### Regressions \(baseline majority pass → candidate fail\)/);
  // `SELECT 1` is either rejected by a guardrail (its tables_used do not match) or runs and mismatches.
  assert.match(markdown, /\| paraphrase_public_001 \| Who are our biggest buyers in March 2026\? \| 100% \(pass\) \| 0% \((wrong_result|guardrail_true_rejection)\) \|/);
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

test('--case-timeout-ms aborts a slow case and records a timeout', { skip }, async () => {
  mode = 'slow';
  const started = Date.now();
  const run = await runEval(['--case-id', 'core_public_003', '--case-timeout-ms', '1500', '--skip-verify'], 'deadline');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { report } = await findReport(run.outputDir);
  const [rep] = report.results[0].repetitions;
  assert.deepEqual([rep.status, rep.outcome, rep.counted, rep.error_code], ['aborted', 'timeout', true, 'CASE_TIMEOUT']);
  assert.ok(Date.now() - started < 30_000);
  mode = 'base';
});
