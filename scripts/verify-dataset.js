// Verify benchmark datasets against every evaluation fixture WITHOUT calling
// the LLM, and measure the oracle with its controls.
//
// Per case (src/eval/verify.js): the gold SQL and every
// alternative_expected_sql execute on each fixture (demo_retail,
// demo_retail_v2, demo_retail_v3), match the per-fixture pins in
// `expected_row_counts`, are self-consistent under the comparison spec, pass
// their own signal checks, and pass the production validator in the real
// prompt context. Then the case's controls (datasets/controls) run through the
// multi-fixture oracle: every positive control must match on every fixture and
// pass the validator; negative controls must be killed. The kill rate of the
// non-held-out negatives must reach --min-kill-rate (default 0.95).
//
// Schema/data drift that would silently break a gold query is caught here
// instead of being misread as a model failure during evaluation: every
// fixture database is re-hashed and must hold exactly the generated content,
// with master data identical to the shared MASTER_DATA. The fixture databases
// are always demo_retail, demo_retail_v2 and demo_retail_v3; DB_NAME is not
// used. The validator check follows the product configuration
// (SCHEMA_SCOPE / SCHEMA_FULL_MAX_TOKENS, src/schema-scope.js); the datasets'
// known_validator_rejection flags describe the default configuration.
//
// Usage:
//   npm run verify-dataset                           # all datasets in datasets/
//   npm run verify-dataset -- --dataset edge-cases-public
//   npm run verify-dataset -- --dataset-file path/to/custom.json --fixtures seed
//   npm run verify-dataset -- --write-pins          # rewrite expected_row_counts
//     (refused unless every fixture is current: run npm run seed-fixtures first)
//   options: --fixtures seed,v2,v3  --controls-dir <dir>  --skip-controls
//            --min-kill-rate 0.95  --min-heldout-kill-rate 0  --report-file <path>
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_USAGE, getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import { CASE_SPLITS, DEFAULT_DATASETS_DIR, findInvalidSplits, loadBenchmarkDataset } from '../src/benchmark.js';
import { DEFAULT_CONTROLS_DIR, loadControlsIndex } from '../src/eval/controls.js';
import { checkFixtureContent } from '../src/eval/fixture-seeder.js';
import { FIXTURES, PRIMARY_FIXTURE, resolveFixtures } from '../src/eval/fixtures.js';
import { closeFixtureConnections, createGoldCache, openFixtureConnections } from '../src/eval/oracle.js';
import {
  controlsCoverageFailure,
  createValidatorProbe,
  fixtureGateFailures,
  killRateGateFailures,
  pinWriteRefusal,
  summarizeControls,
  verifyCase,
} from '../src/eval/verify.js';
import { loadNarrowSchema, resolveEffectiveSchemaScope, writeJsonFile } from '../src/pipeline.js';
import { describeSchemaScope, resolveSchemaScopeConfig } from '../src/schema-scope.js';
import { runScriptMain } from '../src/eval/script-exit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

export const DEFAULT_MIN_KILL_RATE = 0.95;

const USAGE = `Usage: npm run verify-dataset -- [--dataset <name> | --dataset-file <path>] [--datasets-dir <dir>]
  [--fixtures seed,v2,v3] [--controls-dir <dir>] [--skip-controls] [--write-pins]
  [--min-kill-rate 0.95] [--min-heldout-kill-rate 0] [--report-file <path>]
${ENV_USAGE}`;

async function resolveDatasetTargets(argv) {
  const datasetFile = getOptionValue(argv, '--dataset-file');
  if (datasetFile) {
    return [{ datasetPath: path.resolve(datasetFile), datasetName: path.basename(datasetFile, '.json') }];
  }
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const datasetName = getOptionValue(argv, '--dataset');
  if (datasetName) {
    return [{ datasetName, datasetsDir }];
  }
  const entries = await fs.readdir(datasetsDir);
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ datasetName: path.basename(name, '.json'), datasetsDir }));
}

function parseRate(argv, name, fallback) {
  const raw = getOptionValue(argv, name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1; got "${raw}".`);
  }
  return value;
}

const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** Rewrites expected_row_counts (and drops the legacy expected_row_count) in a dataset file. */
export async function writeRowCountPins(datasetPath, countsByCaseId) {
  const raw = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  let changed = 0;
  for (const testCase of raw) {
    const counts = countsByCaseId.get(String(testCase.id));
    // No counts: not verified, or an abstain / clarify case (no gold to pin).
    if (!counts || Object.keys(counts).length === 0) {
      continue;
    }
    const merged = { ...(testCase.expected_row_counts || {}), ...counts };
    const before = JSON.stringify([testCase.expected_row_counts, testCase.expected_row_count]);
    // Keep key order stable: insert expected_row_counts where expected_row_count was.
    const entries = Object.entries(testCase).filter(([key]) => key !== 'expected_row_counts');
    const index = entries.findIndex(([key]) => key === 'expected_row_count');
    const pin = ['expected_row_counts', merged];
    if (index === -1) {
      entries.push(pin);
    } else {
      entries.splice(index, 1, pin);
    }
    for (const key of Object.keys(testCase)) {
      delete testCase[key];
    }
    Object.assign(testCase, Object.fromEntries(entries));
    if (JSON.stringify([testCase.expected_row_counts, testCase.expected_row_count]) !== before) {
      changed += 1;
    }
  }
  await fs.writeFile(datasetPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return changed;
}

function printControlsSummary(summary, fixtureNames) {
  const { design, heldout } = summary;
  console.log('  oracle controls:');
  console.log(
    `    negative, design:   ${design.killed}/${design.total} killed (${percent(design.rate)})` +
      `   seed only: ${design.seedOnlyKilled}/${design.total} (${percent(design.seedOnlyRate)})`
  );
  console.log(
    `    negative, held-out: ${heldout.killed}/${heldout.total} killed (${percent(heldout.rate)})` +
      `   seed only: ${heldout.seedOnlyKilled}/${heldout.total} (${percent(heldout.seedOnlyRate)})`
  );
  const types = Object.entries(summary.byType)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, counts]) => `${type} ${counts.killed}/${counts.total} (seed ${counts.seedOnlyKilled})`);
  console.log(`    by type: ${types.join(' | ')}`);
  console.log(
    `    by fixture: ${fixtureNames
      .map((name) => `${name} kills ${summary.byFixture[name].killed} (only ${name}: ${summary.byFixture[name].onlyThisFixture})`)
      .join(' | ')}${summary.crossFixtureOnly ? ` | cross-fixture rule only: ${summary.crossFixtureOnly}` : ''}`
  );
  console.log(
    `    positive: ${summary.positive.matched}/${summary.positive.total} match on every fixture, ` +
      `${summary.positive.validatorAccepted}/${summary.positive.total} pass the production validator`
  );
  for (const survivor of [...design.survivors, ...heldout.survivors.map((entry) => `${entry} [held-out]`)]) {
    console.log(`    survivor: ${survivor}`);
  }
  // Undecided controls and controls that did not execute are not kills.
  for (const entry of [...design.undecided, ...heldout.undecided.map((item) => `${item} [held-out]`)]) {
    console.log(`    undecided (mapping search cut off, counted as not killed): ${entry}`);
  }
  for (const entry of [...design.invalid, ...heldout.invalid.map((item) => `${item} [held-out]`)]) {
    console.log(`    invalid (fails to execute, counted as not killed): ${entry}`);
  }
  for (const entry of [...design.unscored, ...heldout.unscored.map((item) => `${item} [held-out]`)]) {
    console.log(`    unscored (infrastructure error, counted as not killed): ${entry}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (hasOptionFlag(argv, '--help')) {
    console.log(USAGE);
    return;
  }
  await loadEnvironment(argv);

  const fixtures = resolveFixtures(getOptionValue(argv, '--fixtures'));
  const fixtureNames = fixtures.map((fixture) => fixture.name);
  const writePins = hasOptionFlag(argv, '--write-pins');
  const checkControls = !hasOptionFlag(argv, '--skip-controls');
  const minKillRate = parseRate(argv, '--min-kill-rate', DEFAULT_MIN_KILL_RATE);
  const minHeldoutKillRate = parseRate(argv, '--min-heldout-kill-rate', 0);
  const reportFile = getOptionValue(argv, '--report-file');
  const controlsDir = path.resolve(getOptionValue(argv, '--controls-dir') || DEFAULT_CONTROLS_DIR);
  const controlsIndex = checkControls ? await loadControlsIndex({ controlsDir }) : null;
  const targets = await resolveDatasetTargets(argv);
  // Each dataset is loaded up front (the controls coverage check needs its
  // cases). Unknown split values are read from the raw cases first, so every
  // one of them is named (loading would stop at the first): such a dataset
  // is reported case by case and not verified further.
  const datasetEntries = [];
  for (const target of targets) {
    const datasetPath = target.datasetPath || path.resolve(target.datasetsDir, `${target.datasetName}.json`);
    const invalidSplits = findInvalidSplits(JSON.parse(await fs.readFile(datasetPath, 'utf8')));
    datasetEntries.push(
      invalidSplits.length > 0
        ? { invalid: { datasetName: target.datasetName, datasetPath, invalidSplits } }
        : { info: await loadBenchmarkDataset(target) }
    );
  }
  const datasetInfos = datasetEntries.filter((entry) => entry.info).map((entry) => entry.info);
  const coverageFailure = datasetInfos.length > 0 ? controlsCoverageFailure(datasetInfos, controlsIndex, { controlsDir }) : null;
  if (coverageFailure) {
    throw new Error(coverageFailure);
  }
  const schema = await loadNarrowSchema({ modelsDir: MODELS_DIR, schemaPath: SCHEMA_PATH });
  const schemaScope = resolveSchemaScopeConfig(process.env);
  console.log(`Schema scope: ${describeSchemaScope(resolveEffectiveSchemaScope(schema, schemaScope))}\n`);

  if (process.env.DB_NAME && !FIXTURES.some((fixture) => fixture.database === process.env.DB_NAME)) {
    console.log(
      `Note: DB_NAME is ${process.env.DB_NAME}; verify-dataset reads the fixture databases ` +
        `(${fixtures.map((fixture) => fixture.database).join(', ')}), not DB_NAME.\n`
    );
  }

  const connections = await openFixtureConnections({ fixtures });
  const goldCache = createGoldCache();
  const primary = connections.find((entry) => entry.name === PRIMARY_FIXTURE.name) || connections[0];
  const validate = createValidatorProbe({ schema, connection: primary.connection, schemaScope });

  let totalCases = 0;
  let totalFailures = 0;
  const gateFailures = [];
  const report = { generatedAt: new Date().toISOString(), schemaScope: validate.schemaScope, fixtures: [], minKillRate, minHeldoutKillRate, datasets: [] };

  try {
    console.log('Fixtures (content re-hashed):');
    const fixtureChecks = [];
    for (const fixtureConnection of connections) {
      const check = await checkFixtureContent(fixtureConnection.connection, fixtureConnection);
      fixtureChecks.push({ name: fixtureConnection.name, status: check.status, masterDataMatches: check.masterDataMatches });
      report.fixtures.push({
        name: fixtureConnection.name,
        database: fixtureConnection.database,
        status: check.status,
        contentHash: check.contentHash,
        metaContentHash: check.meta?.contentHash || null,
        expectedContentHash: check.expected.contentHash,
        masterDataMatches: check.masterDataMatches,
      });
      console.log(
        `  ${fixtureConnection.name.padEnd(4)} ${fixtureConnection.database.padEnd(15)} ${check.status.padEnd(8)} ` +
          `master data ${check.masterDataMatches ? 'shared' : 'DIFFERS'}`
      );
    }
    gateFailures.push(...fixtureGateFailures(fixtureChecks));
    // Pins come from the generated fixture content only: refuse before any
    // dataset file is touched.
    const refusal = writePins ? pinWriteRefusal(fixtureChecks) : null;
    if (refusal) {
      throw new Error(refusal);
    }

    for (const { info, invalid } of datasetEntries) {
      if (invalid) {
        // Unknown split values are per-case problems: every one is named and
        // the dataset is not verified further.
        console.log(`\n# ${invalid.datasetName}: ${invalid.invalidSplits.length} case(s) with an unknown split (not verified further)`);
        for (const entry of invalid.invalidSplits) {
          totalCases += 1;
          totalFailures += 1;
          console.log(`  ✗ ${entry.id}\n      -> split "${entry.split}" is not one of ${CASE_SPLITS.join(', ')}`);
        }
        report.datasets.push({ name: invalid.datasetName, path: invalid.datasetPath, cases: [], invalidSplits: invalid.invalidSplits, controls: null });
        continue;
      }
      console.log(`\n# ${info.datasetName} (${info.cases.length} cases, fixtures: ${fixtureNames.join(', ')})`);
      const caseResults = [];
      for (const testCase of info.cases) {
        totalCases += 1;
        const result = await verifyCase(testCase, { connections, goldCache, validate, controlsIndex, checkControls });
        caseResults.push(result);
        const counts = result.behavior
          ? `none (${result.behavior} case)`
          : fixtureNames.map((name) => `${name}=${result.goldRowCounts[name] ?? '?'}`).join(' ');
        const controls = result.controls
          ? ` controls: -${result.controls.negative.filter((control) => control.killed).length}/${result.controls.negative.length} +${result.controls.positive.filter((control) => control.match && !control.rejection).length}/${result.controls.positive.length}`
          : '';
        const problems = writePins ? result.problems.filter((problem) => !/: expected \d+ row\(s\) but gold returned/.test(problem)) : result.problems;
        if (problems.length === 0) {
          console.log(`  ✓ ${testCase.id}  rows ${counts}${controls}`);
        } else {
          totalFailures += 1;
          console.log(`  ✗ ${testCase.id}  rows ${counts}${controls}\n      -> ${problems.join('\n      -> ')}`);
        }
        for (const note of result.notes) {
          console.log(`      note: ${note}`);
        }
      }

      if (writePins) {
        const counts = new Map(caseResults.map((result) => [result.id, result.goldRowCounts]));
        const changed = await writeRowCountPins(info.datasetPath, counts);
        console.log(`  pins: wrote expected_row_counts for ${fixtureNames.join(', ')} to ${info.datasetPath} (${changed} case(s) changed)`);
      }

      const summary = checkControls ? summarizeControls(caseResults, { fixtureNames }) : null;
      if (summary && summary.design.total + summary.heldout.total + summary.positive.total > 0) {
        printControlsSummary(summary, fixtureNames);
        gateFailures.push(...killRateGateFailures(summary, { datasetName: info.datasetName, minKillRate, minHeldoutKillRate }));
      } else if (summary) {
        console.log(`  oracle controls: none apply to ${info.datasetName} (no kill-rate gate for it)`);
      }
      report.datasets.push({ name: info.datasetName, path: info.datasetPath, cases: caseResults, controls: summary });
    }
  } finally {
    await closeFixtureConnections(connections);
  }

  if (reportFile) {
    await writeJsonFile(path.resolve(reportFile), report);
    console.log(`\nReport: ${path.resolve(reportFile)}`);
  }

  console.log(`\nVerified ${totalCases} cases across ${targets.length} dataset(s) on ${connections.length} fixture(s); ${totalFailures} failure(s).`);
  for (const failure of gateFailures) {
    console.log(`FAIL: ${failure}`);
  }
  return totalFailures > 0 || gateFailures.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  // Exit 2 until main() settles: a verification that never settles never passes.
  runScriptMain(() => main(), {
    label: 'verify-dataset',
    onError: (error) => {
      console.error(`Dataset verification failed: ${error.message}`);
      return 1;
    },
  });
}
