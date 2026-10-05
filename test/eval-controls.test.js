import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadBenchmarkDataset } from '../src/benchmark.js';
import { DEFAULT_INCLUDED_TABLES } from '../src/constants.js';
import { goldFingerprint, loadControlsIndex, normalizeSqlText, resolveCaseControls } from '../src/eval/controls.js';
import { controlsCoverageFailure, createValidatorProbe, summarizeControls } from '../src/eval/verify.js';
import { compileSchemaFromModelsDir, filterSchema } from '../src/schema-compiler.js';
import { writeRowCountPins } from '../scripts/verify-dataset.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');

async function tempControls(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-controls-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

const GOLD = 'SELECT COUNT(*) AS n FROM Customer';

test('controls resolve by case id, then by intent with the same gold, and flag stale ones', async () => {
  const controlsDir = await tempControls({
    'core.json': {
      c1: {
        intentId: 'count_customers',
        gold_fingerprint: goldFingerprint(GOLD),
        negative: [{ id: 'm1', type: 'filter', sql: 'SELECT 1', note: 'x' }, { id: 'h1', type: 'logic', sql: 'SELECT 2', heldout: true }],
        positive: [{ id: 'a1', sql: 'SELECT COUNT(1) AS n FROM Customer', note: 'alias' }],
      },
    },
  });
  const index = await loadControlsIndex({ controlsDir });

  const direct = resolveCaseControls({ id: 'c1', intentId: 'count_customers', expected_sql: GOLD }, index);
  assert.equal(direct.matchedBy, 'id');
  assert.equal(direct.stale, false);
  assert.deepEqual(direct.negative.map((control) => [control.id, control.heldout]), [['m1', false], ['h1', true]]);
  assert.equal(direct.positive[0].note, 'alias');

  // A paraphrase: different id, same intent, same gold (whitespace-insensitive).
  const paraphrase = resolveCaseControls({ id: 'p1', intentId: 'count_customers', expected_sql: `  ${GOLD.replace(/ /g, '\n  ')} ` }, index);
  assert.equal(paraphrase.matchedBy, 'intent');
  assert.equal(paraphrase.negative.length, 2);

  // Same intent but a different gold: the controls do not apply.
  assert.equal(resolveCaseControls({ id: 'p2', intentId: 'count_customers', expected_sql: 'SELECT 7 AS n' }, index).matchedBy, null);

  // Same id, edited gold: stale (needs review), no controls run.
  const stale = resolveCaseControls({ id: 'c1', intentId: 'count_customers', expected_sql: 'SELECT 8 AS n' }, index);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.negative, []);

  assert.equal(normalizeSqlText(' SELECT\n 1 '), 'SELECT 1');
});

test('controls files are validated', async () => {
  await assert.rejects(
    loadControlsIndex({ controlsDir: await tempControls({ 'a.json': { c1: { negative: [] } }, 'b.json': { c1: { negative: [] } } }) }),
    /defined twice/
  );
  await assert.rejects(
    loadControlsIndex({ controlsDir: await tempControls({ 'a.json': { c1: { negative: [{ id: 'm1' }] } } }) }),
    /missing id or sql/
  );
  await assert.rejects(loadControlsIndex({ controlsDir: await tempControls({ 'a.json': [] }) }), /keyed by case id/);
});

test('a missing or empty controls directory is an error, never an empty index', async () => {
  const missing = path.join(os.tmpdir(), 'txt2sql-no-such-controls-dir');
  await assert.rejects(loadControlsIndex({ controlsDir: missing }), (error) => {
    assert.equal(error.code, 'CONTROLS_NOT_FOUND');
    assert.match(error.message, /^Controls directory .*txt2sql-no-such-controls-dir does not exist\./);
    assert.match(error.message, /--skip-controls/);
    return true;
  });
  // A directory holding no *.json controls file (e.g. a typo for a sibling).
  const empty = await tempControls({ 'README.txt': 'not controls' });
  await assert.rejects(loadControlsIndex({ controlsDir: empty }), (error) => {
    assert.equal(error.code, 'CONTROLS_NOT_FOUND');
    assert.match(error.message, /has no controls files \(\*\.json\)/);
    return true;
  });
});

test('a directory whose JSON defines no controls is an error, never an empty index', async () => {
  // A file holding `{}`, or entries with empty lists only: no controls at all.
  for (const files of [{ 'a.json': {} }, { 'a.json': { c1: { negative: [], positive: [] } } }]) {
    await assert.rejects(loadControlsIndex({ controlsDir: await tempControls(files) }), (error) => {
      assert.equal(error.code, 'CONTROLS_NOT_FOUND');
      assert.match(error.message, /defines no controls \(a\.json\)\. .*--skip-controls/);
      return true;
    });
  }
  // Other JSON (a package.json) is not a controls file.
  const packageLike = { name: '@text-to-sql/web', private: true, scripts: { build: 'vite build' } };
  await assert.rejects(loadControlsIndex({ controlsDir: await tempControls({ 'package.json': packageLike }) }), (error) => {
    assert.equal(error.code, 'CONTROLS_INVALID');
    assert.match(error.message, /package\.json: name is not a controls entry/);
    return true;
  });
  await assert.rejects(loadControlsIndex({ controlsDir: await tempControls({ 'a.json': { scripts: { build: 'x' } } }) }), /scripts is not a controls entry/);
  await assert.rejects(loadControlsIndex({ controlsDir: await tempControls({ 'a.json': { c1: { negative: {} } } }) }), /c1 is not a controls entry/);
});

test('controlsCoverageFailure: controls that apply to none of the verified cases stop the run', async () => {
  const controlsDir = await tempControls({
    'core.json': { c1: { intentId: 'count_customers', gold_fingerprint: goldFingerprint(GOLD), negative: [{ id: 'm1', sql: 'SELECT 1' }] } },
  });
  const index = await loadControlsIndex({ controlsDir });
  const covered = { datasetName: 'core', cases: [{ id: 'c1', intentId: 'count_customers', expected_sql: GOLD }] };
  const other = { datasetName: 'other', cases: [{ id: 'x1', intentId: 'other_intent', expected_sql: 'SELECT 2 AS n' }] };
  assert.equal(controlsCoverageFailure([covered, other], index, { controlsDir }), null);
  assert.equal(controlsCoverageFailure([other], null, { controlsDir }), null, '--skip-controls: no index, no gate');
  const failure = controlsCoverageFailure([other], index, { controlsDir });
  assert.match(failure, /^No oracle controls in .* apply to other, so no kill-rate gate would run\. .*--skip-controls/);
});

test('verify-dataset stops on a mistyped --controls-dir before touching any database', async () => {
  // No database settings at all: the run must fail on the controls directory
  // itself (before this fix it went on, and with a database it would have
  // skipped the kill-rate gate).
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: path.join(os.tmpdir(), 'txt2sql-no-such-env-file.env') };
  const run = (controlsDir) =>
    promisify(execFile)(process.execPath, [path.join(REPO_ROOT, 'scripts/verify-dataset.js'), '--dataset', 'core-public', '--controls-dir', controlsDir], {
      env,
      cwd: REPO_ROOT,
    });
  await assert.rejects(run(path.join(DATASETS_DIR, 'contrls')), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Dataset verification failed: Controls directory .*contrls does not exist\. .*--skip-controls/);
    return true;
  });
  await assert.rejects(run(await tempControls({})), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /has no controls files/);
    return true;
  });
  // A sibling directory that holds JSON but no controls (apps/web has
  // package.json and tsconfig.json).
  await assert.rejects(run(path.join(REPO_ROOT, 'apps/web')), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Dataset verification failed: .*is not a controls entry/);
    return true;
  });
  // Real controls, but for cases outside the dataset being verified.
  const unrelated = await tempControls({ 'x.json': { not_a_core_case: { negative: [{ id: 'm1', sql: 'SELECT 1' }] } } });
  await assert.rejects(run(unrelated), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Dataset verification failed: No oracle controls in .* apply to core-public/);
    return true;
  });
});

// --- the committed controls -------------------------------------------------

const committed = await loadControlsIndex();
const datasets = Object.fromEntries(
  await Promise.all(
    ['core-public', 'paraphrase-public', 'edge-cases-public'].map(async (name) => [name, (await loadBenchmarkDataset({ datasetName: name })).cases])
  )
);

test('every committed case gets current (non-stale) controls', () => {
  for (const [name, cases] of Object.entries(datasets)) {
    for (const testCase of cases) {
      const resolved = resolveCaseControls(testCase, committed);
      assert.equal(resolved.stale, false, `${name}/${testCase.id} controls are stale`);
      assert.ok(resolved.negative.length >= 5, `${name}/${testCase.id} has negative controls`);
      assert.ok(resolved.positive.length >= 1, `${name}/${testCase.id} has positive controls`);
      assert.equal(resolved.matchedBy, name === 'paraphrase-public' ? 'intent' : 'id');
    }
  }
});

test('the edge suite carries the ported mutation workstream (108 design + 28 held-out) and the review controls', () => {
  const resolved = datasets['edge-cases-public'].map((testCase) => resolveCaseControls(testCase, committed));
  const negatives = resolved.flatMap((entry) => entry.negative);
  const audit = negatives.filter((control) => /^[mh]\d+$/.test(control.id));
  assert.equal(audit.filter((control) => !control.heldout).length, 108);
  assert.equal(audit.filter((control) => control.heldout).length, 28);
  // Families the PR review found surviving (MONTH() without YEAR(),
  // SUM(DISTINCT), invented IsActive filters, hedged columns, ...), added as
  // design controls once the fixtures covered them.
  const review = negatives.filter((control) => /^r\d+$/.test(control.id));
  assert.equal(review.length, 44);
  assert.ok(review.every((control) => !control.heldout && control.note.startsWith('review: ')));
  assert.equal(negatives.length, audit.length + review.length);
  for (const type of ['date_filter', 'sum_distinct', 'filter', 'hedge']) {
    assert.ok(review.filter((control) => control.type === type).length >= 6, `review ${type} controls`);
  }
  assert.equal(resolved.flatMap((entry) => entry.positive).length, 71);
  // Model output never contains comments (the validator rejects them), so no
  // positive control may either.
  for (const control of resolved.flatMap((entry) => entry.positive)) {
    assert.doesNotMatch(control.sql, /--\s|\/\*|#/, control.id);
  }
});

// Offline twin of the verify-dataset check: every positive control passes the
// production validator in the real prompt context (no master-data candidates
// without a database; none of the controls filters on product IDs), except
// the ones flagged validator_known_false_rejection, which must still be
// rejected (so the flag is removed once the guardrail is fixed).
test('every positive control passes the production validator', async () => {
  const schema = filterSchema(await compileSchemaFromModelsDir(path.join(REPO_ROOT, 'models')), DEFAULT_INCLUDED_TABLES);
  const validate = createValidatorProbe({ schema });
  let knownFalseRejections = 0;
  for (const testCase of datasets['edge-cases-public']) {
    for (const control of resolveCaseControls(testCase, committed).positive) {
      const rejection = await validate(testCase.question, control.sql);
      if (control.validator_known_false_rejection) {
        knownFalseRejections += 1;
        assert.ok(rejection, `${testCase.id}/${control.id} is flagged as a known false rejection but passes now`);
        continue;
      }
      assert.equal(rejection, null, `${testCase.id}/${control.id}: ${rejection?.code} ${rejection?.message}`);
    }
  }
  assert.equal(knownFalseRejections, 1);
});

test('summarizeControls reports design / held-out / seed-only kill rates and fixture contributions', () => {
  const results = [
    {
      id: 'c1',
      controls: {
        negative: [
          { id: 'm1', type: 'cancel', heldout: false, killed: true, killedOn: ['seed', 'v2'] },
          { id: 'm2', type: 'cancel', heldout: false, killed: true, killedOn: ['v2'] },
          { id: 'm3', type: 'metric', heldout: false, killed: false, killedOn: [], note: 'survives' },
          { id: 'm4', type: 'metric', heldout: false, killed: true, killedOn: [] },
          { id: 'h1', type: 'metric', heldout: true, killed: true, killedOn: ['v3'] },
        ],
        positive: [
          { id: 'a1', match: true, rejection: null },
          { id: 'a2', match: false, rejection: { code: 'X' } },
        ],
      },
    },
  ];
  const summary = summarizeControls(results, { fixtureNames: ['seed', 'v2', 'v3'] });
  assert.deepEqual(
    { total: summary.design.total, killed: summary.design.killed, rate: summary.design.rate, seed: summary.design.seedOnlyKilled },
    { total: 4, killed: 3, rate: 0.75, seed: 1 }
  );
  assert.deepEqual(summary.design.survivors, ['c1/m3 (metric: survives)']);
  assert.equal(summary.heldout.rate, 1);
  assert.equal(summary.heldout.seedOnlyRate, 0);
  assert.deepEqual(summary.byType.cancel, { total: 2, killed: 2, seedOnlyKilled: 1 });
  assert.deepEqual(summary.byFixture, {
    seed: { killed: 1, onlyThisFixture: 0 },
    v2: { killed: 2, onlyThisFixture: 1 },
    v3: { killed: 1, onlyThisFixture: 1 },
  });
  assert.equal(summary.crossFixtureOnly, 1);
  assert.deepEqual(summary.positive, { total: 2, matched: 1, validatorAccepted: 1 });
});

test('writeRowCountPins replaces the legacy pin in place and keeps key order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-pins-'));
  const file = path.join(dir, 'd.json');
  await fs.writeFile(
    file,
    JSON.stringify([
      { id: 'a', question: 'q', expected_sql: 'SELECT 1', expected_row_count: 1, notes: 'n' },
      { id: 'b', question: 'q', expected_sql: 'SELECT 2', expected_row_counts: { seed: 1, v2: 9 } },
      { id: 'c', question: 'q', expected_sql: 'SELECT 3' },
    ])
  );
  const changed = await writeRowCountPins(file, new Map([['a', { seed: 1, v2: 2, v3: 3 }], ['b', { v2: 2 }]]));
  assert.equal(changed, 2);
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(written[0]), ['id', 'question', 'expected_sql', 'expected_row_counts', 'notes']);
  assert.deepEqual(written[0].expected_row_counts, { seed: 1, v2: 2, v3: 3 });
  assert.deepEqual(written[1].expected_row_counts, { seed: 1, v2: 2 }, 'pins of unverified fixtures are kept');
  assert.equal(written[2].expected_row_counts, undefined);
  assert.match(await fs.readFile(file, 'utf8'), /\n$/);
});

test('committed datasets: per-fixture pins, alternatives only where the reading is ambiguous, tolerance only on line money', () => {
  for (const [name, cases] of Object.entries(datasets)) {
    for (const testCase of cases) {
      assert.deepEqual(Object.keys(testCase.expected_row_counts || {}), ['seed', 'v2', 'v3'], `${name}/${testCase.id} pins`);
      assert.equal(testCase.expected_row_count, undefined, `${name}/${testCase.id} still has the legacy pin`);
      const hasAlternatives = testCase.alternative_expected_sql.length > 0;
      assert.equal(
        hasAlternatives,
        ['account_debit_march_2026', 'account_credit_march_2026', 'customer_month_columns_jan_feb_2026'].includes(testCase.intentId),
        `${name}/${testCase.id} alternatives`
      );
      if (hasAlternatives) {
        assert.ok(testCase.notes && /alternative_expected_sql/.test(testCase.notes), `${name}/${testCase.id} explains its alternatives`);
      }
      const lineMoney = ['product_net_sales_march_2026', 'brand_net_sales_march_2026', 'campaign_net_sales_march_2026', 'category_line_net_sales_march_2026'];
      assert.equal(testCase.comparison.tolerance, lineMoney.includes(testCase.intentId) ? 0.01 : 0, `${name}/${testCase.id} tolerance`);
    }
  }
  const pivot = datasets['edge-cases-public'].find((testCase) => testCase.intentId === 'customer_month_columns_jan_feb_2026');
  assert.deepEqual(pivot.comparison.column_order, ['jan_net_amount', 'feb_net_amount']);
  assert.deepEqual(pivot.comparison.null_as_zero, ['jan_net_amount', 'feb_net_amount']);
  // One alternative per accepted reading: every customer (LEFT JOIN from Customer).
  assert.equal(pivot.alternative_expected_sql.length, 1);
  assert.match(pivot.alternative_expected_sql[0], /FROM Customer c LEFT JOIN SalesDocument d/);
});

test('the edge suite reuses the core cases verbatim', async () => {
  const core = JSON.parse(await fs.readFile(path.join(DATASETS_DIR, 'core-public.json'), 'utf8'));
  const edge = JSON.parse(await fs.readFile(path.join(DATASETS_DIR, 'edge-cases-public.json'), 'utf8'));
  assert.deepEqual(edge.slice(0, core.length), core);
});
