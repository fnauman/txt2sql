// Oracle controls: SQL whose verdict is known, used to measure the oracle
// itself (verify-dataset). datasets/controls/<dataset>.json is keyed by case
// id:
//
//   {
//     "<case id>": {
//       "intentId": "...",
//       "gold_fingerprint": "<sha256 prefix of the whitespace-normalized gold SQL>",
//       "negative": [{ "id", "type", "sql", "note", "heldout"? }],
//       "positive": [{ "id", "sql", "note" }]
//     }
//   }
//
// - negative: plausible-but-wrong SQL (a "mutant"). The oracle must kill it:
//   fail to match the gold (and every alternative) on at least one fixture.
//   `heldout: true` marks mutants written after the fixtures were designed
//   (reported separately; no kill-rate floor).
// - positive: a correct alternative to the gold. It must match the gold (or an
//   alternative) on every fixture AND pass the production validator.
//
// The controls were written against one gold SQL; gold_fingerprint pins it.
// Resolution for a case: its own id in any controls file (the edge suite reuses
// the core cases verbatim), else the same intentId (paraphrases reuse the core
// gold). An id match whose fingerprint differs is reported as stale; an
// intent match only applies when the fingerprint matches.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_DATASETS_DIR } from '../benchmark.js';

export const DEFAULT_CONTROLS_DIR = path.resolve(DEFAULT_DATASETS_DIR, 'controls');

export function normalizeSqlText(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function goldFingerprint(sql) {
  return crypto.createHash('sha256').update(normalizeSqlText(sql)).digest('hex').slice(0, 16);
}

function normalizeControl(control, { kind, caseId, file }) {
  const id = String(control?.id || '').trim();
  const sql = String(control?.sql || '').trim();
  if (!id || !sql) {
    throw new Error(`${file}: a ${kind} control of ${caseId} is missing id or sql.`);
  }
  return {
    id,
    sql,
    note: control.note ? String(control.note) : '',
    ...(kind === 'negative' ? { type: String(control.type || 'other'), heldout: control.heldout === true } : {}),
    ...(control.validator_known_false_rejection === true ? { validator_known_false_rejection: true } : {}),
  };
}

// A controls entry is an object with a `negative` and/or `positive` array. Any
// other JSON (package.json, tsconfig.json, ...) is not a controls file, so a
// --controls-dir pointing at the wrong directory fails instead of loading
// entries without controls.
function checkEntryShape(entry, { caseId, file }) {
  const isObject = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
  const lists = isObject ? ['negative', 'positive'].filter((key) => entry[key] !== undefined) : [];
  if (!isObject || lists.length === 0 || lists.some((key) => !Array.isArray(entry[key]))) {
    throw Object.assign(
      new Error(`${file}: ${caseId} is not a controls entry (an object with "negative" and/or "positive" arrays); is this a controls directory?`),
      { code: 'CONTROLS_INVALID' }
    );
  }
}

function controlsNotFound(message) {
  return Object.assign(
    new Error(`${message} Pass --controls-dir <dir> with the controls files, or --skip-controls to verify without measuring the oracle.`),
    { code: 'CONTROLS_NOT_FOUND' }
  );
}

/**
 * Reads every controls file of a directory into one index. A missing
 * directory, one without any controls file, or files that define no control at
 * all are an error (code CONTROLS_NOT_FOUND), never an empty index; a JSON
 * file whose entries are not controls entries is CONTROLS_INVALID. A typo in
 * --controls-dir must not silently skip the kill-rate gate (--skip-controls is
 * the way to skip it).
 */
export async function loadControlsIndex({ controlsDir = DEFAULT_CONTROLS_DIR } = {}) {
  let names = [];
  try {
    names = (await fs.readdir(controlsDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw controlsNotFound(`Controls directory ${controlsDir} does not exist.`);
    }
    throw error;
  }
  if (names.length === 0) {
    throw controlsNotFound(`Controls directory ${controlsDir} has no controls files (*.json).`);
  }

  const byCaseId = new Map();
  const byIntentId = new Map();
  let controlCount = 0;
  for (const name of names) {
    const file = path.join(controlsDir, name);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${file} must be an object keyed by case id.`);
    }
    for (const [caseId, entry] of Object.entries(raw)) {
      checkEntryShape(entry, { caseId, file: name });
      if (byCaseId.has(caseId)) {
        throw new Error(`Controls for case ${caseId} are defined twice (${byCaseId.get(caseId).source} and ${name}).`);
      }
      const normalized = {
        caseId,
        intentId: entry.intentId ? String(entry.intentId) : null,
        goldFingerprint: entry.gold_fingerprint ? String(entry.gold_fingerprint) : null,
        negative: (entry.negative || []).map((control) => normalizeControl(control, { kind: 'negative', caseId, file: name })),
        positive: (entry.positive || []).map((control) => normalizeControl(control, { kind: 'positive', caseId, file: name })),
        source: `${name}#${caseId}`,
      };
      byCaseId.set(caseId, normalized);
      controlCount += normalized.negative.length + normalized.positive.length;
      if (normalized.intentId) {
        if (!byIntentId.has(normalized.intentId)) {
          byIntentId.set(normalized.intentId, []);
        }
        byIntentId.get(normalized.intentId).push(normalized);
      }
    }
  }
  if (controlCount === 0) {
    throw controlsNotFound(`Controls directory ${controlsDir} defines no controls (${names.join(', ')}).`);
  }
  return { byCaseId, byIntentId, files: names };
}

/**
 * The controls that apply to one (normalized) case:
 * { negative, positive, source, matchedBy: 'id' | 'intent' | null, stale }.
 * `stale` means controls exist under this case id but were written for a
 * different gold SQL (they need review before they mean anything).
 */
export function resolveCaseControls(testCase, index) {
  const fingerprint = goldFingerprint(testCase.expected_sql);
  const direct = index.byCaseId.get(testCase.id);
  if (direct) {
    if (direct.goldFingerprint && direct.goldFingerprint !== fingerprint) {
      return { negative: [], positive: [], source: direct.source, matchedBy: 'id', stale: true };
    }
    return { negative: direct.negative, positive: direct.positive, source: direct.source, matchedBy: 'id', stale: false };
  }
  const sameIntent = (index.byIntentId.get(testCase.intentId) || []).find((entry) => entry.goldFingerprint === fingerprint);
  if (sameIntent) {
    return { negative: sameIntent.negative, positive: sameIntent.positive, source: sameIntent.source, matchedBy: 'intent', stale: false };
  }
  return { negative: [], positive: [], source: null, matchedBy: null, stale: false };
}
