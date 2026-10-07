import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main as holdoutManifestCli } from '../scripts/holdout-manifest.js';
import { DEFAULT_DATASETS_DIR, HOLDOUT_MANIFEST_FILE, isDatasetFileName, normalizeBenchmarkCase } from '../src/benchmark.js';
import { loadControlsIndex, resolveCaseControls } from '../src/eval/controls.js';
import {
  buildHoldoutManifest,
  compareHoldoutManifest,
  computeHoldoutEntries,
  DEFAULT_HOLDOUT_MANIFEST_PATH,
  DEFINITION_FIELDS,
  definitionFingerprint,
  EDITORIAL_FIELDS,
  freezeSqlText,
  holdoutEntriesFingerprint,
  isHoldoutCase,
  loadFreezeControls,
  MANIFEST_VERSION,
  readHoldoutManifest,
  serializeHoldoutManifest,
} from '../src/eval/holdout.js';
import { listDatasetNames, loadSuiteDatasets } from '../src/eval/suite.js';

// The holdout freeze (measurement hygiene): datasets/holdout-manifest.json
// lists every holdout case with its question, gold, scoring, measurement,
// definition (the whole case definition) and controls (the oracle controls
// that apply to it) fingerprints.
// Adding, removing or changing a holdout case without rewriting the manifest
// (npm run holdout-manifest -- --write --note "...") fails here.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the committed holdout manifest matches the holdout of every dataset (and carries a note for it)', async () => {
  assert.equal(DEFAULT_HOLDOUT_MANIFEST_PATH, path.join(REPO_ROOT, 'datasets', HOLDOUT_MANIFEST_FILE));
  const manifest = await readHoldoutManifest();
  const entries = computeHoldoutEntries(await loadSuiteDatasets(), { controls: await loadFreezeControls() });
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
  assert.deepEqual(check([raw('h1', { question: 'Reworded?' }), base[1], base[2]]).changed, [{ id: 'h1', fields: ['question_fingerprint', 'definition_fingerprint'] }]);
  assert.deepEqual(check([raw('h1', { expected_sql: "SELECT 'other' AS x" }), base[1], base[2]]).changed, [
    { id: 'h1', fields: ['gold_fingerprint', 'scoring_fingerprint', 'definition_fingerprint'] },
  ]);
  assert.deepEqual(check([raw('h1', { alternative_expected_sql: ["SELECT 'alt' AS x"] }), base[1], base[2]]).changed, [
    { id: 'h1', fields: ['scoring_fingerprint', 'definition_fingerprint'] },
  ]);
  assert.deepEqual(check([raw('h1', { comparison: { mode: 'scalar' } }), base[1], base[2]]).changed, [{ id: 'h1', fields: ['scoring_fingerprint', 'definition_fingerprint'] }]);
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
  assert.match(compareHoldoutManifest(null, entries).problems.join('\n'), /missing or not a version 2 holdout manifest/);
  // A manifest of an older fingerprint scheme is rewritten, with a note.
  assert.match(compareHoldoutManifest({ ...manifest, manifestVersion: 1 }, entries).problems.join('\n'), /fingerprint scheme 1, this checkout 2: rewrite it/);
  // A change appends to the history.
  const grown = computeHoldoutEntries(datasetsOf([raw('h1'), raw('h2')]));
  const next = buildHoldoutManifest(grown, { previous: manifest, note: 'second case added', date: '2026-10-07' });
  assert.deepEqual(next.history.map((entry) => [entry.date, entry.cases]), [['2026-10-06', 1], ['2026-10-07', 2]]);
});

test('a changed intent or dataset membership needs a note, and --write accepts it', () => {
  const base = [raw('h1'), raw('h2')];
  const manifest = buildHoldoutManifest(computeHoldoutEntries(datasetsOf(base)), { note: 'two holdout cases authored blind', date: '2026-10-06' });
  for (const [label, datasets, fields] of [
    ['intent', datasetsOf([raw('h1', { intentId: 'another_intent' }), base[1]]), ['definition_fingerprint', 'intentId']],
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
    assert.deepEqual(compareHoldoutManifest(manifest, changed).changed, [{ id: 'h1', fields: ['measurement_fingerprint', 'definition_fingerprint'] }], label);
    assert.throws(() => buildHoldoutManifest(changed, { previous: manifest }), /pass --note/, label);
    const next = buildHoldoutManifest(changed, { previous: manifest, note: `${label} changed`, date: '2026-10-07' });
    assert.deepEqual(compareHoldoutManifest(next, changed).problems, [], label);
  }
  // Order of tags and expected tables is not a change.
  const reordered = computeHoldoutEntries(datasetsOf([{ ...base[0], tags: ['b', 'a'], expected_tables: ['SalesDocument', 'Customer'] }, base[1]]));
  assert.deepEqual(compareHoldoutManifest(manifest, reordered).problems, []);
});

test('every verification-relevant field is frozen: row-count pins, signal checks, disallowed columns and the rest of the definition', () => {
  const base = [
    raw('h1', {
      canonicalQuestion: 'Canonical h1?',
      expected_row_counts: { seed: 3, v2: 3, v3: 4 },
      signal_checks: { min_row_count: 3, require_nonnull_columns: ['x'] },
      disallowed_columns: ['NetPayableAmount'],
      expected_columns: ['x'],
      notes: 'Why the gold reads it this way.',
    }),
    raw('h2'),
  ];
  const entries = computeHoldoutEntries(datasetsOf(base));
  const manifest = buildHoldoutManifest(entries, { note: 'two holdout cases authored blind', date: '2026-10-06' });
  for (const [label, overrides] of [
    ['expected_row_counts', { expected_row_counts: { seed: 3, v2: 3, v3: 5 } }],
    ['signal_checks', { signal_checks: { min_row_count: 2, require_nonnull_columns: ['x'] } }],
    ['disallowed_columns', { disallowed_columns: ['NetPayableAmount', 'BillTotalAmount'] }],
    ['expected_columns', { expected_columns: ['x', 'y'] }],
    ['canonicalQuestion', { canonicalQuestion: 'Another canonical question?' }],
  ]) {
    const changed = computeHoldoutEntries(datasetsOf([{ ...base[0], ...overrides }, base[1]]));
    assert.deepEqual(compareHoldoutManifest(manifest, changed).changed, [{ id: 'h1', fields: ['definition_fingerprint'] }], label);
    assert.throws(() => buildHoldoutManifest(changed, { previous: manifest }), /pass --note/, label);
    const next = buildHoldoutManifest(changed, { previous: manifest, note: `${label} changed`, date: '2026-10-07' });
    assert.deepEqual(compareHoldoutManifest(next, changed).problems, [], label);
  }
  // Editorial notes and the order of top-level lists are not changes.
  const editorial = computeHoldoutEntries(datasetsOf([{ ...base[0], notes: 'Reworded note.', disallowed_columns: ['NetPayableAmount'] }, base[1]]));
  assert.deepEqual(compareHoldoutManifest(manifest, editorial).problems, []);
});

test('whitespace inside a quoted SQL literal is part of the definition; formatting elsewhere is not', () => {
  assert.equal(freezeSqlText("  SELECT  'a  b' ,\n \"c  d\", `e  f`\tFROM  x  "), "SELECT 'a  b' , \"c  d\", `e  f` FROM x");
  assert.equal(freezeSqlText("SELECT 'it''s  ok',  'x\\'  y'   z"), "SELECT 'it''s  ok', 'x\\'  y' z", 'doubled and escaped quotes stay inside the literal');
  assert.equal(freezeSqlText("SELECT 'open  "), "SELECT 'open  ", 'an unterminated quote keeps the rest as written');
  const base = [raw('h1', { expected_sql: "SELECT x FROM t WHERE n = 'A B'", alternative_expected_sql: ["SELECT x FROM t WHERE n LIKE 'A B%'"] }), raw('h2')];
  const entries = computeHoldoutEntries(datasetsOf(base));
  const manifest = buildHoldoutManifest(entries, { note: 'two holdout cases authored blind', date: '2026-10-06' });
  const check = (overrides) => compareHoldoutManifest(manifest, computeHoldoutEntries(datasetsOf([{ ...base[0], ...overrides }, base[1]])));
  // The gold and scoring fingerprints collapse every whitespace run, so only
  // the definition fingerprint sees these.
  assert.deepEqual(check({ expected_sql: "SELECT x FROM t WHERE n = 'A  B'" }).changed, [{ id: 'h1', fields: ['definition_fingerprint'] }]);
  assert.deepEqual(check({ alternative_expected_sql: ["SELECT x FROM t WHERE n LIKE 'A  B%'"] }).changed, [{ id: 'h1', fields: ['definition_fingerprint'] }]);
  assert.deepEqual(check({ expected_sql: "SELECT  x\n  FROM t\n WHERE n = 'A B'  " }).problems, []);
});

// A controls index read from files, as verify-dataset reads datasets/controls.
async function controlsIndexOf(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holdout-controls-'));
  try {
    await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify(entries));
    return await loadControlsIndex({ controlsDir: dir });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('the oracle controls of a holdout case are frozen: editing, adding or removing one needs a note; their notes do not', async () => {
  const base = [raw('h1'), raw('h2'), raw('h3', { intentId: 'intent_h1', expected_sql: "SELECT 'h1' AS x" }), raw('d1', { split: 'dev' })];
  const cases = datasetsOf(base);
  const goldOf = (id) => cases[0].cases.find((testCase) => testCase.id === id).expected_sql;
  const controlsOf = (overrides = {}) => ({
    h1: {
      intentId: 'intent_h1',
      gold_fingerprint: computeHoldoutEntries(datasetsOf([raw('h1')]))[0].gold_fingerprint,
      negative: [
        { id: 'n1', type: 'filter', sql: "SELECT 'h1 ' AS x", note: 'trailing space' },
        { id: 'n2', type: 'other', sql: "SELECT 'H1' AS x", note: 'case', heldout: true },
      ],
      positive: [{ id: 'p1', sql: "SELECT  'h1'  AS  x", note: 'formatting' }],
      ...overrides,
    },
    d1: { negative: [{ id: 'n1', type: 'other', sql: "SELECT 'x' AS x" }] },
  });
  const entries = computeHoldoutEntries(cases, { controls: await controlsIndexOf(controlsOf()) });
  assert.equal(goldOf('h3'), goldOf('h1'));
  // h1 by id, h3 by its intent (same gold); h2 has none.
  assert.deepEqual(entries.map((entry) => [entry.id, typeof entry.controls_fingerprint]), [['h1', 'string'], ['h2', 'object'], ['h3', 'string']]);
  assert.equal(entries[1].controls_fingerprint, null);
  assert.notEqual(entries[0].controls_fingerprint, entries[2].controls_fingerprint, 'matched by id vs by intent');
  // Without a controls index every controls fingerprint is null.
  assert.deepEqual(computeHoldoutEntries(cases).map((entry) => entry.controls_fingerprint), [null, null, null]);
  const manifest = buildHoldoutManifest(entries, { note: 'three holdout cases authored blind', date: '2026-10-06' });
  const entriesWith = async (controls) => computeHoldoutEntries(cases, { controls: await controlsIndexOf(controls) });
  const check = async (controls) => compareHoldoutManifest(manifest, await entriesWith(controls));
  const [n1, n2] = controlsOf().h1.negative;
  const p1 = controlsOf().h1.positive[0];
  for (const [label, overrides] of [
    ['negative SQL', { negative: [{ ...n1, sql: "SELECT 'h1  ' AS x" }, n2] }],
    ['negative removed', { negative: [n1], positive: [p1] }],
    ['negative added', { negative: [n1, n2, { id: 'n3', type: 'other', sql: 'SELECT 1 AS x' }] }],
    ['held-out flag', { negative: [n1, { ...n2, heldout: false }] }],
    ['type', { negative: [{ ...n1, type: 'other' }, n2] }],
    ['positive removed', { positive: [] }],
    ['validator flag', { positive: [{ ...p1, validator_known_false_rejection: true }] }],
  ]) {
    const changed = await entriesWith(controlsOf(overrides));
    assert.deepEqual(compareHoldoutManifest(manifest, changed).changed, [{ id: 'h1', fields: ['controls_fingerprint'] }, { id: 'h3', fields: ['controls_fingerprint'] }], label);
    assert.throws(() => buildHoldoutManifest(changed, { previous: manifest }), /pass --note/, label);
    const next = buildHoldoutManifest(changed, { previous: manifest, note: `${label} changed`, date: '2026-10-07' });
    assert.deepEqual(compareHoldoutManifest(next, changed).problems, [], label);
  }
  // A deleted entry, or one written for another gold (stale), changes both.
  const { h1: _h1, ...withoutH1 } = controlsOf();
  assert.deepEqual((await check(withoutH1)).changed.map((entry) => [entry.id, entry.fields]), [['h1', ['controls_fingerprint']], ['h3', ['controls_fingerprint']]]);
  assert.deepEqual((await check(controlsOf({ gold_fingerprint: '0000000000000000' }))).changed.map((entry) => entry.id), ['h1', 'h3']);
  // Notes, SQL formatting and dev cases' controls are not changes.
  const editorial = controlsOf({ negative: [{ ...n1, note: 'reworded' }, { ...n2, sql: "SELECT  'H1'\n AS x" }], positive: [{ ...p1, note: undefined }] });
  assert.deepEqual((await check({ ...editorial, d1: { negative: [{ id: 'n9', type: 'other', sql: 'SELECT 2 AS x' }] } })).problems, []);
});

test('the definition fingerprint covers every field a dataset case carries, except id and editorial notes', async () => {
  // Each listed field changes the fingerprint (so the list is not a promise
  // the fingerprint does not keep)...
  const answer = {
    id: 'h1',
    intentId: 'intent_h1',
    question: 'Question h1?',
    canonicalQuestion: 'Canonical h1?',
    expected_sql: "SELECT 'h1' AS x",
    alternative_expected_sql: [],
    comparison: { mode: 'rowset' },
    split: 'holdout',
    expected_row_counts: { seed: 3 },
    signal_checks: { min_row_count: 3 },
    tags: ['a'],
    expected_tables: ['Customer'],
    expected_columns: ['x'],
    disallowed_columns: ['NetPayableAmount'],
    difficulty: 'easy',
    failure_class: 'join',
    notes: 'A note.',
  };
  const changes = {
    question: [answer, { question: 'Another question?' }],
    canonicalQuestion: [answer, { canonicalQuestion: 'Another canonical question?' }],
    expected_sql: [answer, { expected_sql: "SELECT 'other' AS x" }],
    alternative_expected_sql: [answer, { alternative_expected_sql: ["SELECT 'alt' AS x"] }],
    comparison: [answer, { comparison: { mode: 'scalar' } }],
    expected_behavior: [{ id: 'h1', question: 'Weather?', split: 'holdout', expected_behavior: 'abstain' }, { expected_behavior: 'clarify' }],
    split: [answer, { split: 'dev' }],
    known_validator_rejection: [answer, { known_validator_rejection: 'METRIC_COLUMN' }],
    expected_row_counts: [answer, { expected_row_counts: { seed: 4 } }],
    expected_row_count: [{ ...answer, expected_row_counts: undefined, expected_row_count: 3 }, { expected_row_count: 4 }],
    signal_checks: [answer, { signal_checks: { min_row_count: 4 } }],
    intentId: [answer, { intentId: 'another_intent' }],
    tags: [answer, { tags: ['b'] }],
    expected_tables: [answer, { expected_tables: ['Store'] }],
    expected_columns: [answer, { expected_columns: ['y'] }],
    disallowed_columns: [answer, { disallowed_columns: ['BillTotalAmount'] }],
    difficulty: [answer, { difficulty: 'hard' }],
    failure_class: [answer, { failure_class: 'grain' }],
  };
  assert.deepEqual(Object.keys(changes).sort(), [...DEFINITION_FIELDS].sort());
  for (const [field, [before, overrides]] of Object.entries(changes)) {
    const fingerprint = (testCase) => definitionFingerprint(normalizeBenchmarkCase(testCase));
    assert.notEqual(fingerprint({ ...before, ...overrides }), fingerprint(before), field);
  }
  assert.equal(definitionFingerprint(normalizeBenchmarkCase({ ...answer, notes: 'Another note.' })), definitionFingerprint(normalizeBenchmarkCase(answer)));
  // ...and every field of every committed dataset case is listed, so a new
  // field cannot be left out of the freeze unnoticed.
  const covered = new Set(['id', ...DEFINITION_FIELDS, ...EDITORIAL_FIELDS]);
  for (const name of await listDatasetNames(DEFAULT_DATASETS_DIR)) {
    const cases = JSON.parse(await fs.readFile(path.join(DEFAULT_DATASETS_DIR, `${name}.json`), 'utf8'));
    const unlisted = [...new Set(cases.flatMap((testCase) => Object.keys(testCase)))].filter((field) => !covered.has(field));
    assert.deepEqual(unlisted, [], `${name}: add the field to DEFINITION_FIELDS (and definitionFingerprint) or EDITORIAL_FIELDS in src/eval/holdout.js`);
  }
});

// The fingerprint scheme 2 note records a scheme change only: while that
// note is the manifest's current state, every holdout case definition, and
// the controls that apply to it, is byte-identical to SCHEME_2_BASE's (the
// commit the note was written on). The sha256 of both at that commit is
// pinned below, so the check needs no git history (CI clones shallowly);
// where the history is available, a second test recomputes the pins and the
// note's fingerprint from that commit.
const SCHEME_2_BASE = 'e8403d0';
const SCHEME_2_BASE_HOLDOUT = Object.freeze({
  cases: 149,
  definitionsSha256: '2f7569048926eeea51945bf699f3b4632f36c9c7c8a24aa6ae1cf535587c92fe',
  controlsSha256: 'b4f073b3061785e7f8adfe39351857fa4c4dbe616939db8d1f64e7a97c0970dd',
});

// Every holdout case object of a datasets directory as written, notes
// included, and the oracle controls that apply to each (from its controls/).
async function holdoutDefinitions(datasetsDir) {
  const definitions = [];
  for (const name of await listDatasetNames(datasetsDir)) {
    const cases = JSON.parse(await fs.readFile(path.join(datasetsDir, `${name}.json`), 'utf8'));
    definitions.push(...cases.filter((testCase) => testCase.split === 'holdout').map((testCase) => `${name}\u0000${JSON.stringify(testCase)}`));
  }
  return definitions.sort();
}
async function holdoutControls(datasetsDir) {
  const index = await loadControlsIndex({ controlsDir: path.join(datasetsDir, 'controls') });
  const controls = [];
  for (const dataset of await loadSuiteDatasets({ datasetsDir })) {
    controls.push(...dataset.cases.filter(isHoldoutCase).map((testCase) => `${testCase.id}\u0000${JSON.stringify(resolveCaseControls(testCase, index))}`));
  }
  return [...new Set(controls)].sort();
}
const sha256Of = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');

// The scheme 2 note, or null (the test skips) once a later note records a
// later holdout state; that change has its own note.
async function currentScheme2Note(t) {
  const manifest = await readHoldoutManifest();
  assert.equal(manifest.manifestVersion, MANIFEST_VERSION);
  const note = manifest.history.find((entry) => entry.note.includes('fingerprint scheme extended; no case definition changed'));
  assert.ok(note, 'the manifest records the scheme change with its note');
  if (manifest.fingerprint !== note.fingerprint) {
    t.skip('a later note records a later holdout state');
    return null;
  }
  return note;
}

test('the fingerprint scheme 2 note changed no holdout case: the definitions and their controls are byte-identical to e8403d0', async (t) => {
  if (!(await currentScheme2Note(t))) {
    return;
  }
  const definitions = await holdoutDefinitions(DEFAULT_DATASETS_DIR);
  assert.equal(definitions.length, SCHEME_2_BASE_HOLDOUT.cases);
  assert.equal(sha256Of(definitions), SCHEME_2_BASE_HOLDOUT.definitionsSha256, `a holdout case definition differs from ${SCHEME_2_BASE}'s`);
  assert.equal(sha256Of(await holdoutControls(DEFAULT_DATASETS_DIR)), SCHEME_2_BASE_HOLDOUT.controlsSha256, `a holdout case's controls differ from ${SCHEME_2_BASE}'s`);
});

test('the e8403d0 pins and the scheme 2 note fingerprint are that commit\'s holdout (with the git history)', async (t) => {
  const note = await currentScheme2Note(t);
  if (!note) {
    return;
  }
  const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  let files;
  let controlsFiles;
  try {
    files = git('ls-tree', '--name-only', `${SCHEME_2_BASE}:datasets`).split('\n').filter(isDatasetFileName);
    controlsFiles = git('ls-tree', '--name-only', `${SCHEME_2_BASE}:datasets/controls`).split('\n').filter((name) => name.endsWith('.json'));
  } catch {
    t.skip(`the git history of ${SCHEME_2_BASE} is not available (the pinned hashes are checked without it)`);
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holdout-scheme-'));
  try {
    await fs.mkdir(path.join(dir, 'controls'));
    for (const file of files) {
      await fs.writeFile(path.join(dir, file), git('show', `${SCHEME_2_BASE}:datasets/${file}`));
    }
    for (const file of controlsFiles) {
      await fs.writeFile(path.join(dir, 'controls', file), git('show', `${SCHEME_2_BASE}:datasets/controls/${file}`));
    }
    const definitions = await holdoutDefinitions(dir);
    assert.equal(definitions.length, SCHEME_2_BASE_HOLDOUT.cases);
    assert.equal(sha256Of(definitions), SCHEME_2_BASE_HOLDOUT.definitionsSha256);
    assert.equal(sha256Of(await holdoutControls(dir)), SCHEME_2_BASE_HOLDOUT.controlsSha256);
    const before = computeHoldoutEntries(await loadSuiteDatasets({ datasetsDir: dir }), { controls: await loadFreezeControls(path.join(dir, 'controls')) });
    assert.equal(holdoutEntriesFingerprint(before), note.fingerprint);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
    assert.match(lines.join('\n'), /holdout case h1 changed \(gold_fingerprint, scoring_fingerprint, definition_fingerprint\)/);
    // A changed intent: refused without a note, recorded with one.
    await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify([raw('h1', { intentId: 'another_intent' })]));
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 1);
    assert.match(lines.join('\n'), /holdout case h1 changed \(definition_fingerprint, intentId\)/);
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

test('npm run holdout-manifest reads the controls of <datasets-dir>/controls (or --controls-dir) and reports a changed control', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holdout-manifest-controls-'));
  const lines = [];
  const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const controls = (sql) => ({ h1: { negative: [{ id: 'n1', type: 'other', sql, note: 'a mutant' }] } });
  try {
    await fs.mkdir(path.join(dir, 'controls'));
    await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify([raw('h1'), raw('h2')]));
    await fs.writeFile(path.join(dir, 'controls', 'set.json'), JSON.stringify(controls("SELECT 'H1' AS x")));
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--write', '--note', 'two holdout cases'], { output, date: '2026-10-06' }), 0);
    const written = await readHoldoutManifest(path.join(dir, HOLDOUT_MANIFEST_FILE));
    assert.deepEqual(written.entries.map((entry) => [entry.id, typeof entry.controls_fingerprint]), [['h1', 'string'], ['h2', 'object']]);
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 0);
    await fs.writeFile(path.join(dir, 'controls', 'set.json'), JSON.stringify(controls("SELECT 'h1' AS x")));
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir], { output }), 1);
    assert.match(lines.join('\n'), /holdout case h1 changed \(controls_fingerprint\)/);
    // --controls-dir: an empty or missing directory means no controls, which
    // a manifest that lists some reports as a change too.
    lines.length = 0;
    assert.equal(await holdoutManifestCli(['--datasets-dir', dir, '--controls-dir', path.join(dir, 'none')], { output }), 1);
    assert.match(lines.join('\n'), /holdout case h1 changed \(controls_fingerprint\)/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
