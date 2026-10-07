// The holdout freeze: datasets/holdout-manifest.json lists every holdout case
// of every dataset with its question, gold, scoring and measurement
// fingerprints (src/eval/holdout.js). test/holdout-manifest.test.js fails when the holdout
// and the manifest differ, so every change to the holdout is an explicit,
// reviewable manifest diff with a dated note.
//
//   npm run holdout-manifest                                  # check: exit 1 on any difference
//   npm run holdout-manifest -- --write --note "what and why"  # record today's holdout
//   options: --datasets-dir <dir>  --manifest <path>
//
// No database and no LLM: it reads the dataset files only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DATASETS_DIR, HOLDOUT_MANIFEST_FILE } from '../src/benchmark.js';
import { getOptionValue, hasOptionFlag } from '../src/env.js';
import { buildHoldoutManifest, compareHoldoutManifest, computeHoldoutEntries, readHoldoutManifest, serializeHoldoutManifest } from '../src/eval/holdout.js';
import { runScriptMain } from '../src/eval/script-exit.js';
import { loadSuiteDatasets } from '../src/eval/suite.js';

const __filename = fileURLToPath(import.meta.url);

export const USAGE = `Usage: npm run holdout-manifest -- [--write --note "<what changed and why>"] [--datasets-dir <dir>] [--manifest <path>]

Checks (default) or rewrites datasets/holdout-manifest.json, the frozen list of
holdout cases with their question, gold, scoring and measurement (attribution
and report labels: known_validator_rejection, expected tables, split, expected
behaviour, failure class, difficulty, tags) fingerprints. A change to
the holdout needs --note, recorded with the date in the manifest history.
Exit codes: 0 up to date (or written); 1 the holdout and the manifest differ; 2 bad usage.`;

export async function main(argv = process.argv.slice(2), { output = console, date } = {}) {
  if (hasOptionFlag(argv, '--help')) {
    output.log(USAGE);
    return 0;
  }
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const manifestPath = path.resolve(getOptionValue(argv, '--manifest') || path.join(datasetsDir, HOLDOUT_MANIFEST_FILE));
  const write = hasOptionFlag(argv, '--write');
  const note = getOptionValue(argv, '--note');
  if (note !== null && !write) {
    output.error('--note is only used with --write.');
    return 2;
  }
  const entries = computeHoldoutEntries(await loadSuiteDatasets({ datasetsDir }));
  const manifest = await readHoldoutManifest(manifestPath);
  const comparison = compareHoldoutManifest(manifest, entries);
  const relative = path.relative(process.cwd(), manifestPath) || manifestPath;
  if (!write) {
    if (comparison.ok) {
      output.log(`holdout-manifest: up to date (${entries.length} holdout case(s), fingerprint ${manifest.fingerprint}).`);
      return 0;
    }
    output.error(`holdout-manifest: ${relative} does not match the holdout:\n  ${comparison.problems.join('\n  ')}`);
    output.error('Review the change, then record it: npm run holdout-manifest -- --write --note "<what changed and why>".');
    return 1;
  }
  let next;
  try {
    next = buildHoldoutManifest(entries, { previous: manifest, note: note || '', ...(date ? { date } : {}) });
  } catch (error) {
    output.error(`holdout-manifest: ${error.message}`);
    return 1;
  }
  await fs.writeFile(manifestPath, serializeHoldoutManifest(next), 'utf8');
  const changes = [
    comparison.added.length ? `${comparison.added.length} added` : null,
    comparison.removed.length ? `${comparison.removed.length} removed` : null,
    comparison.changed.length ? `${comparison.changed.length} changed` : null,
  ].filter(Boolean);
  output.log(`holdout-manifest: wrote ${relative} (${entries.length} holdout case(s)${changes.length ? `; ${changes.join(', ')}` : ''}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runScriptMain(() => main(), { label: 'holdout-manifest' });
}
