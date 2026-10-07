// The holdout freeze and the holdout display policy.
//
// Freeze: datasets/holdout-manifest.json lists every holdout case of every
// dataset (split 'holdout') with the fingerprints of what it asks and how it
// is scored, verified and reported: the question, the gold SQL
// (controls.goldFingerprint), the scoring fingerprint (gold + alternatives +
// comparison spec, suite.js; what a comparison pairs cases on), the
// measurement fingerprint (the case-definition fields that move a failure
// between attribution buckets or report breakdowns: split, expected
// behaviour, known_validator_rejection, expected tables, failure class,
// difficulty and tags), the definition fingerprint (the whole case
// definition, below) and the controls fingerprint (the oracle controls
// verify-dataset applies to the case), with its intent and datasets. A
// hygiene test (test/holdout-manifest.test.js) fails when a holdout case is
// added, removed or changed without the manifest being rewritten, and the
// manifest must carry a dated note for its current state (`history`), so a
// change to the holdout is always an explicit, reviewable diff:
//
//   npm run holdout-manifest                         # check (exit 1 on a difference)
//   npm run holdout-manifest -- --write --note "..."  # record the current holdout
//
// Display: report.md and the console show holdout results in aggregate only
// (accuracy by split) unless `--reveal-holdout` is passed: no per-case
// holdout rows, and every other figure (the headline's intervals, the
// comparison with a baseline, attribution, cost) covers the dev cases, so
// error analysis and experiment design look at dev failures only and no
// figure says more about holdout outcomes than the split accuracy
// (src/eval/report-markdown.js). report.json keeps every case (rescore,
// compare and the gate need them); reading it is revealing the holdout.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_DATASETS_DIR, HOLDOUT_MANIFEST_FILE } from '../benchmark.js';
import { DEFAULT_CONTROLS_DIR, goldFingerprint, loadControlsIndex, normalizeSqlText, resolveCaseControls } from './controls.js';
import { sha256Hex, stableStringify } from './provenance.js';
import { caseDefinitionFingerprint, caseSplit, scoringFingerprint } from './suite.js';

// The fingerprint scheme. 1: question, gold, scoring and measurement
// fingerprints; 2: plus the definition and controls fingerprints. A manifest
// of another version fails the check until it is rewritten (with a note).
export const MANIFEST_VERSION = 2;
export const DEFAULT_HOLDOUT_MANIFEST_PATH = path.join(DEFAULT_DATASETS_DIR, HOLDOUT_MANIFEST_FILE);

export const HOLDOUT_POLICY =
  'Error analysis and experiment design use dev failures only; holdout results are read in aggregate (report.md and the console ' +
  'show them by split, never per case, unless --reveal-holdout). Any change to the holdout (a case added, removed or changed) ' +
  'requires rewriting this manifest with a dated note (npm run holdout-manifest -- --write --note "...").';

const sha16 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

/** True for a case (or a report record) in the holdout split. */
export function isHoldoutCase(testCase) {
  return caseSplit(testCase) === 'holdout';
}

const sortedStrings = (values) => [...new Set((values || []).map(String))].sort();

/**
 * Fingerprint of the case-definition fields that change how a holdout case is
 * measured without changing how it is scored (the scoring fingerprint, which
 * a comparison pairs cases on, stays as it is): a known_validator_rejection
 * flag or expected tables move its failures between the model and system
 * buckets, the split and expected behaviour decide whether and how it counts,
 * and failure class, difficulty and tags drive the report's breakdowns.
 */
export function measurementFingerprint(testCase) {
  return sha256Hex(
    stableStringify({
      split: caseSplit(testCase),
      expected_behavior: testCase.expected_behavior || 'answer',
      known_validator_rejection: testCase.known_validator_rejection || null,
      expected_tables: sortedStrings(testCase.expected_tables),
      failure_class: testCase.failure_class || null,
      difficulty: testCase.difficulty || null,
      tags: sortedStrings(testCase.tags),
    })
  ).slice(0, 16);
}

/**
 * SQL text as the freeze compares it: a whitespace run outside quoted strings
 * and quoted identifiers is one space (formatting is not a change), and the
 * text inside quotes is kept as written: 'A  B' and 'A B' are different
 * values, which normalizeSqlText (the gold and scoring fingerprints) equates.
 * A backslash escapes the next character inside a string; an unterminated
 * quote keeps the rest as written, so the comparison only gets stricter.
 */
export function freezeSqlText(sql) {
  const text = String(sql || '');
  let output = '';
  let quote = null;
  let space = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      output += char;
      if (char === '\\' && quote !== '`' && index + 1 < text.length) {
        index += 1;
        output += text[index];
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (/\s/.test(char)) {
      space = true;
      continue;
    }
    output += space && output ? ` ${char}` : char;
    space = false;
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    }
  }
  return output;
}

// The case fields the definition fingerprint covers, and the ones it leaves
// out. It is the suite's own notion of one case definition
// (caseDefinitionFingerprint in suite.js: two definitions of an id that
// differ in any of these are a dataset conflict), so the freeze and the
// suite agree on what "the same case" is: every field anything runs,
// verifies, scores, selects or reports on, the row-count pins, signal checks
// and disallowed columns that verification and the warnings read included.
// On top of it the gold and alternative SQL are compared as freezeSqlText
// keeps them, so whitespace inside a quoted literal is a change. Other
// whitespace in the question and SQL and the order of the top-level lists are
// not changes, as in the other fingerprints. Free-text `notes` is editorial:
// nothing reads it (test/holdout-manifest.test.js checks that every field a
// dataset case carries is in one of these lists, so a new field is never
// silently left out of the freeze).
export const DEFINITION_FIELDS = Object.freeze([
  'question',
  'canonicalQuestion',
  'expected_sql',
  'alternative_expected_sql',
  'comparison',
  'expected_behavior',
  'split',
  'known_validator_rejection',
  'expected_row_counts',
  'expected_row_count',
  'signal_checks',
  'intentId',
  'tags',
  'expected_tables',
  'expected_columns',
  'disallowed_columns',
  'difficulty',
  'failure_class',
]);
export const EDITORIAL_FIELDS = Object.freeze(['notes']);

/** Fingerprint of the whole case definition (DEFINITION_FIELDS, the SQL inside quotes as written). */
export function definitionFingerprint(testCase) {
  return sha256Hex(
    stableStringify({
      definition: caseDefinitionFingerprint(testCase),
      expected_sql: freezeSqlText(testCase.expected_sql),
      alternative_expected_sql: [...(testCase.alternative_expected_sql || [])].map(freezeSqlText).sort(),
    })
  ).slice(0, 16);
}

/**
 * Fingerprint of the oracle controls that apply to a case
 * (resolveCaseControls: its own id's, else a same-intent entry written for
 * the same gold), or null when none does or no controls index is given.
 * verify-dataset measures the oracle with them (the kill-rate gate and the
 * positive controls), so they are verification inputs like the row-count
 * pins. Each control's id, type, held-out and validator flags and SQL
 * (freezeSqlText) count, and how it was found (by id or intent, or stale:
 * written for another gold); its free-text note is editorial, as a case's
 * notes are.
 */
export function controlsFingerprint(testCase, controlsIndex) {
  const resolved = controlsIndex ? resolveCaseControls(testCase, controlsIndex) : null;
  if (!resolved?.source) {
    return null;
  }
  const control = ({ note: _note, sql, ...rest }) => ({ ...rest, sql: freezeSqlText(sql) });
  return sha256Hex(
    stableStringify({
      matchedBy: resolved.matchedBy,
      stale: resolved.stale,
      negative: resolved.negative.map(control),
      positive: resolved.positive.map(control),
    })
  ).slice(0, 16);
}

/**
 * The controls index of the freeze: every controls file of `controlsDir`
 * (loadControlsIndex), or null when there is none, so every controls
 * fingerprint is null (a manifest that lists controls then reports each of
 * those cases as changed).
 */
export async function loadFreezeControls(controlsDir = DEFAULT_CONTROLS_DIR) {
  try {
    return await loadControlsIndex({ controlsDir });
  } catch (error) {
    if (error?.code === 'CONTROLS_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/** The manifest entry of one holdout case (`controlsIndex`: loadFreezeControls). */
export function holdoutManifestEntry(testCase, datasetNames = [], controlsIndex = null) {
  return {
    id: testCase.id,
    datasets: [...new Set(datasetNames)].sort(),
    intentId: testCase.intentId || testCase.id,
    question_fingerprint: sha16(normalizeSqlText(testCase.question)),
    gold_fingerprint: goldFingerprint(testCase.expected_sql),
    scoring_fingerprint: scoringFingerprint(testCase),
    measurement_fingerprint: measurementFingerprint(testCase),
    // The complete definition (DEFINITION_FIELDS); the fingerprints above say
    // which part of it changed.
    definition_fingerprint: definitionFingerprint(testCase),
    controls_fingerprint: controlsFingerprint(testCase, controlsIndex),
  };
}

/**
 * Manifest entries for every holdout case of `datasets` ([{ name, cases }],
 * normalized cases), one per id (a case repeated in several datasets lists
 * them all), sorted by id. `controls` is the controls index
 * (loadFreezeControls); without it every controls fingerprint is null.
 */
export function computeHoldoutEntries(datasets, { controls = null } = {}) {
  const byId = new Map();
  for (const dataset of datasets || []) {
    for (const testCase of dataset.cases || []) {
      if (!isHoldoutCase(testCase)) {
        continue;
      }
      const previous = byId.get(testCase.id);
      byId.set(testCase.id, holdoutManifestEntry(testCase, [...(previous?.datasets || []), dataset.name], controls));
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

// Every field of an entry the check compares; the manifest fingerprint covers
// all of them, so any change the check reports changes the fingerprint too
// and needs a note (a field compared but not hashed could be rewritten
// silently by --write, and could never get its note).
const COMPARED_FIELDS = [
  'question_fingerprint',
  'gold_fingerprint',
  'scoring_fingerprint',
  'measurement_fingerprint',
  'definition_fingerprint',
  'controls_fingerprint',
  'intentId',
  'datasets',
];

/** Fingerprint of a set of entries (what the history notes are written for): every compared field. */
export function holdoutEntriesFingerprint(entries) {
  return sha16(JSON.stringify((entries || []).map((entry) => [entry.id, ...COMPARED_FIELDS.map((field) => entry[field] ?? null)])));
}

/**
 * Differences between a manifest and the holdout of today's datasets:
 * { ok, added, removed, changed: [{ id, fields }], problems: [string] }.
 * `problems` also covers a manifest that is not internally consistent: a
 * stale fingerprint, or no history note for its current state.
 */
export function compareHoldoutManifest(manifest, entries) {
  const listed = new Map((manifest?.entries || []).map((entry) => [entry.id, entry]));
  const current = new Map((entries || []).map((entry) => [entry.id, entry]));
  const added = [...current.keys()].filter((id) => !listed.has(id)).sort();
  const removed = [...listed.keys()].filter((id) => !current.has(id)).sort();
  const changed = [];
  for (const [id, entry] of current) {
    const before = listed.get(id);
    if (!before) {
      continue;
    }
    const fields = COMPARED_FIELDS.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(entry[field] ?? null));
    if (fields.length > 0) {
      changed.push({ id, fields });
    }
  }
  const problems = [];
  if (manifest && Number.isInteger(manifest.manifestVersion) && manifest.manifestVersion !== MANIFEST_VERSION) {
    problems.push(
      `the manifest uses fingerprint scheme ${manifest.manifestVersion}, this checkout ${MANIFEST_VERSION}: rewrite it ` +
        '(npm run holdout-manifest -- --write --note "...") after checking that no holdout case changed'
    );
  } else if (!manifest || manifest.manifestVersion !== MANIFEST_VERSION || !Array.isArray(manifest.entries) || !Array.isArray(manifest.history)) {
    problems.push(`the manifest is missing or not a version ${MANIFEST_VERSION} holdout manifest`);
  } else {
    if (manifest.fingerprint !== holdoutEntriesFingerprint(manifest.entries)) {
      problems.push('the manifest fingerprint does not match its entries (edit it with npm run holdout-manifest -- --write, not by hand)');
    }
    const last = manifest.history.at(-1);
    if (!last || last.fingerprint !== manifest.fingerprint || !String(last.note || '').trim()) {
      problems.push('the manifest has no history note for its current entries');
    }
  }
  if (added.length) {
    problems.push(`holdout case(s) not in the manifest: ${added.join(', ')}`);
  }
  if (removed.length) {
    problems.push(`manifest case(s) no longer in the holdout: ${removed.join(', ')}`);
  }
  for (const entry of changed) {
    problems.push(`holdout case ${entry.id} changed (${entry.fields.join(', ')})`);
  }
  return { ok: problems.length === 0, added, removed, changed, problems };
}

/**
 * The manifest for `entries`. A change from `previous` (or a first manifest)
 * needs a `note`, appended to the history with the date; an unchanged holdout
 * keeps the previous history.
 */
export function buildHoldoutManifest(entries, { previous = null, note = '', date = new Date().toISOString().slice(0, 10) } = {}) {
  const fingerprint = holdoutEntriesFingerprint(entries);
  const history = Array.isArray(previous?.history) ? [...previous.history] : [];
  const unchanged = history.at(-1)?.fingerprint === fingerprint;
  if (!unchanged) {
    if (!String(note || '').trim()) {
      throw new Error('The holdout changed: pass --note "<what changed and why>" to record it in the manifest history.');
    }
    history.push({ date, fingerprint, cases: entries.length, note: String(note).trim() });
  } else if (String(note || '').trim()) {
    throw new Error('The holdout did not change since the last manifest note; there is nothing to record.');
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    policy: HOLDOUT_POLICY,
    fingerprint,
    entries,
    history,
  };
}

export async function readHoldoutManifest(manifestPath = DEFAULT_HOLDOUT_MANIFEST_PATH) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function serializeHoldoutManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// --- display ------------------------------------------------------------------

/** Ids of the holdout cases among report records. */
export function holdoutRecordIds(records) {
  return new Set((records || []).filter(isHoldoutCase).map((record) => record.id));
}

/** "N holdout case(s) not listed ..." for a hidden group, or null when none was hidden. */
export function hiddenHoldoutNote(count, what = 'case(s)') {
  return count > 0
    ? `${count} holdout ${what} not listed: holdout results are shown in aggregate only (by split); pass --reveal-holdout to list them.`
    : null;
}
