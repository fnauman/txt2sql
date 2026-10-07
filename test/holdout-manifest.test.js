import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main as holdoutManifestCli } from '../scripts/holdout-manifest.js';
import { DEFAULT_DATASETS_DIR, HOLDOUT_MANIFEST_FILE, isDatasetFileName, normalizeBenchmarkCase } from '../src/benchmark.js';
import {
  buildHoldoutManifest,
  compareHoldoutManifest,
  computeHoldoutEntries,
  DEFAULT_HOLDOUT_MANIFEST_PATH,
  readHoldoutManifest,
  serializeHoldoutManifest,
} from '../src/eval/holdout.js';
import { listDatasetNames, loadSuiteDatasets } from '../src/eval/suite.js';

// The holdout freeze (measurement hygiene): datasets/holdout-manifest.json
// lists every holdout case with its question, gold, scoring and measurement
// fingerprints.
// Adding, removing or changing a holdout case without rewriting the manifest
// (npm run holdout-manifest -- --write --note "...") fails here.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the committed holdout manifest matches the holdout of every dataset (and carries a note for it)', async () => {
  assert.equal(DEFAULT_HOLDOUT_MANIFEST_PATH, path.join(REPO_ROOT, 'datasets', HOLDOUT_MANIFEST_FILE));
  const manifest = await readHoldoutManifest();
  const entries = computeHoldoutEntries(await loadSuiteDatasets());
  const comparison = compareHoldoutManifest(manifest, entries);
  assert.deepEqual(
    comparison.problems,
    [],
    'the holdout changed: review it, then run npm run holdout-manifest -- --write --note "<what changed and why>"'
  );
  // Rewriting an unchanged holdout reproduces the file byte for byte.
  const rebuilt = buildHoldoutManifest(entries, { previous: manifest });
  assert.equal(serializeHoldoutManifest(rebuilt), await fs.readFile(DEFAULT_HOLDOUT_MANIFEST_PATH, 'utf8'));
  assert.ok(manifest.history.length >= 1 && manifest.history.every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && entry.note.length > 20));
});

test('the manifest is not a dataset: the suite, verify-dataset and the hygiene tests skip it', async () => {
  assert.equal(isDatasetFileName(HOLDOUT_MANIFEST_FILE), false);
  assert.equal(isDatasetFileName('templated-public.json'), true);
  assert.equal(isDatasetFileName('notes.md'), false);
  const names = await listDatasetNames(DEFAULT_DATASETS_DIR);
  assert.ok(!names.includes('holdout-manifest'));
  assert.deepEqual(names, ['core-public', 'edge-cases-public', 'hard-cases-public', 'holdout-public', 'paraphrase-public', 'templated-public']);
});

const raw = (id, overrides = {}) => ({
  id,
  intentId: `intent_${id}`,
  question: `Question ${id}?`,
  expected_sql: `SELECT '${id}' AS x`,
  comparison: { mode: 'rowset' },
  split: 'holdout',
  ...overrides,
});
const datasetsOf = (cases, name = 'set') => [{ name, cases: cases.map(normalizeBenchmarkCase) }];

test('a holdout case added, removed or changed (question, gold, scoring) fails the check; dev cases do not matter', () => {
  const base = [raw('h1'), raw('h2'), raw('d1', { split: 'dev' })];
  const entries = computeHoldoutEntries(datasetsOf(base));
  assert.deepEqual(entries.map((entry) => entry.id), ['h1', 'h2']);
  const manifest = buildHoldoutManifest(entries, { note: 'two holdout cases authored blind', date: '2026-10-06' });
  assert.deepEqual(compareHoldoutManifest(manifest, entries).problems, []);

  const check = (cases) => compareHoldoutManifest(manifest, computeHoldoutEntries(datasetsOf(cases)));
  const added = check([...base, raw('h3')]);
  assert.deepEqual([added.ok, added.added], [false, ['h3']]);
  assert.match(added.problems.join('\n'), /holdout case\(s\) not in the manifest: h3/);
  const removed = check([base[0], base[2]]);
  assert.deepEqual(removed.removed, ['h2']);
  // A case moved to dev leaves the holdout too.
  assert.deepEqual(check([base[0], { ...base[1], split: 'dev' }, base[2]]).removed, ['h2']);
  assert.deepEqual(check([raw('h1', { question: 'Reworded?' }), base[1], base[2]]).changed, [{ id: 'h1', fields: ['question_fingerprint'] }]);
  assert.deepEqual(check([raw('h1', { expected_sql: "SELECT 'other' AS x" }), base[1], base[2]]).changed, [{ id: 'h1', fields: ['gold_fingerprint', 'scoring_fingerprint'] }]);
  assert.deepEqual(check([raw('h1', { alternative_expected_sql: ["SELECT 'alt' AS x"] }), base[1], base[2]]).changed, [{ id: 'h1', fields: ['scoring_fingerprint'] }]);
  assert.deepEqual(check([raw('h1', { comparison: { mode: 'scalar' } }), base[1], base[2]]).changed, [{ id: 'h1', fields: ['scoring_fingerprint'] }]);
  // Dev cases are free to change.
  assert.equal(check([base[0], base[1], raw('d1', { split: 'dev', question: 'Anything?' }), raw('d2', { split: 'dev' })]).ok, true);
});

test('the manifest must be rewritten, not hand-edited, and every change needs a note', () => {
  const entries = computeHoldoutEntries(datasetsOf([raw('h1')]));
  assert.throws(() => buildHoldoutManifest(entries), /pass --note/);
  const manifest = buildHoldoutManifest(entries, { note: 'first holdout case', date: '2026-10-06' });
  assert.deepEqual(manifest.history, [{ date: '2026-10-06', fingerprint: manifest.fingerprint, cases: 1, note: 'first holdout case' }]);
  // Unchanged: the history is kept as it is, and a note has nothing to record.
  assert.deepEqual(buildHoldoutManifest(entries, { previous: manifest }), manifest);
  assert.throws(() => buildHoldoutManifest(entries, { previous: manifest, note: 'again' }), /did not change/);
  // A hand-edited entry list, or a missing note for the current entries.
  const handEdited = { ...manifest, entries: [] };
  assert.match(compareHoldoutManifest(handEdited, []).problems.join('\n'), /fingerprint does not match its entries/);
  const noNote = { ...manifest, history: [] };
  assert.match(compareHoldoutManifest(noNote, entries).problems.join('\n'), /no history note for its current entries/);
  assert.match(compareHoldoutManifest(null, entries).problems.join('\n'), /missing or not a version 1 holdout manifest/);
  // A change appends to the history.
  const grown = computeHoldoutEntries(datasetsOf([raw('h1'), raw('h2')]));
  const next = buildHoldoutManifest(grown, { previous: manifest, note: 'second case added', date: '2026-10-07' });
  assert.deepEqual(next.history.map((entry) => [entry.date, entry.cases]), [['2026-10-06', 1], ['2026-10-07', 2]]);
});

test('a changed intent or dataset membership needs a note, and --write accepts it', () => {
  const base = [raw('h1'), raw('h2')];
  const manifest = buildHoldoutManifest(computeHoldoutEntries(datasetsOf(base)), { note: 'two holdout cases authored blind', date: '2026-10-06' });
  for (const [label, datasets, fields] of [
    ['intent', datasetsOf([raw('h1', { intentId: 'another_intent' }), base[1]]), ['intentId']],
    ['dataset membership', [...datasetsOf(base), ...datasetsOf([base[0]], 'other')], ['datasets']],
  ]) {
    const entries = computeHoldoutEntries(datasets);
    assert.deepEqual(compareHoldoutManifest(manifest, entries).changed, [{ id: 'h1', fields }], label);
    // Never rewritten silently: the change needs a note, and the note is accepted.
    assert.throws(() => buildHoldoutManifest(entries, { previous: manifest }), /pass --note/, label);
    const next = buildHoldoutManifest(entries, { previous: manifest, note: `${label} changed`, date: '2026-10-07' });
    assert.notEqual(next.fingerprint, manifest.fingerprint, label);
    assert.deepEqual(next.history.map((entry) => entry.note), ['two holdout cases authored blind', `${label} changed`], label);
    assert.deepEqual(compareHoldoutManifest(next, entries).problems, [], label);
  }
});

test('a measurement-relevant field (known_validator_rejection, expected tables, breakdown labels) is frozen without touching the scoring fingerprint', () => {
  const base = [raw('h1', { tags: ['a', 'b'], difficulty: 'medium', failure_class: 'join', expected_tables: ['Customer', 'SalesDocument'] }), raw('h2')];
  const entries = computeHoldoutEntries(datasetsOf(base));
  const manifest = buildHoldoutManifest(entries, { note: 'two holdout cases authored blind', date: '2026-10-06' });
  for (const [label, overrides] of [
    ['known_validator_rejection', { known_validator_rejection: 'METRIC_COLUMN' }],
    ['expected tables', { expected_tables: ['Customer'] }],
    ['failure class', { failure_class: 'grain' }],
    ['difficulty', { difficulty: 'hard' }],
    ['tags', { tags: ['a'] }],
  ]) {
    const changed = computeHoldoutEntries(datasetsOf([{ ...base[0], ...overrides }, base[1]]));
    // Pairing with earlier reports is untouched: same scoring fingerprint.
    assert.equal(changed[0].scoring_fingerprint, entries[0].scoring_fingerprint, label);
    assert.deepEqual(compareHoldoutManifest(manifest, changed).changed, [{ id: 'h1', fields: ['measurement_fingerprint'] }], label);
    assert.throws(() => buildHoldoutManifest(changed, { previous: manifest }), /pass --note/, label);
    const next = buildHoldoutManifest(changed, { previous: manifest, note: `${label} changed`, date: '2026-10-07' });
    assert.deepEqual(compareHoldoutManifest(next, changed).problems, [], label);
  }
  // Order of tags and expected tables is not a change.
  const reordered = computeHoldoutEntries(datasetsOf([{ ...base[0], tags: ['b', 'a'], expected_tables: ['SalesDocument', 'Customer'] }, base[1]]));
  assert.deepEqual(compareHoldoutManifest(manifest, reordered).problems, []);
});

test('an empty holdout has a valid manifest too', () => {
  const entries = computeHoldoutEntries(datasetsOf([raw('d1', { split: 'dev' })]));
  assert.deepEqual(entries, []);
  const manifest = buildHoldoutManifest(entries, { note: 'no holdout yet', date: '2026-10-06' });
  assert.deepEqual(compareHoldoutManifest(manifest, entries), { ok: true, added: [], removed: [], changed: [], problems: [] });
});

test('npm run holdout-manifest checks, and writes only with a note', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holdout-manifest-'));
  const lines = [];
  const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  try {
    await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify([raw('h1'), raw('d1', { split: 'dev' })]));
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 1, 'no manifest yet');
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--write'], { output }), 1, 'a change without --note');
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--note', 'x'], { output }), 2, '--note without --write');
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--write', '--note', 'one holdout case'], { output, date: '2026-10-06' }), 0);
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 0);
    // The manifest in the directory is not read as a dataset.
    assert.deepEqual(await listDatasetNames(dir), ['set']);
    await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify([raw('h1', { expected_sql: "SELECT 'changed' AS x" })]));
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 1);
    assert.match(lines.join('\n'), /holdout case h1 changed \(gold_fingerprint, scoring_fingerprint\)/);
    // A changed intent: refused without a note, recorded with one.
    await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify([raw('h1', { intentId: 'another_intent' })]));
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 1);
    assert.match(lines.join('\n'), /holdout case h1 changed \(intentId\)/);
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--write'], { output }), 1, 'an intent change without --note');
    assert.match(lines.at(-1), /The holdout changed: pass --note/);
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--write', '--note', 'intent renamed'], { output, date: '2026-10-07' }), 0);
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 0);
    const written = await readHoldoutManifest(path.join(dir, HOLDOUT_MANIFEST_FILE));
    assert.deepEqual(written.history.map((entry) => entry.note), ['one holdout case', 'intent renamed']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
