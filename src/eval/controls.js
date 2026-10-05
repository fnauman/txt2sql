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

/** Reads every controls file of a directory into one index. */
export async function loadControlsIndex({ controlsDir = DEFAULT_CONTROLS_DIR } = {}) {
  let names = [];
  try {
    names = (await fs.readdir(controlsDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { byCaseId: new Map(), byIntentId: new Map(), files: [] };
    }
    throw error;
  }

  const byCaseId = new Map();
  const byIntentId = new Map();
  for (const name of names) {
    const file = path.join(controlsDir, name);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${file} must be an object keyed by case id.`);
    }
    for (const [caseId, entry] of Object.entries(raw)) {
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
      if (normalized.intentId) {
        if (!byIntentId.has(normalized.intentId)) {
          byIntentId.set(normalized.intentId, []);
        }
        byIntentId.get(normalized.intentId).push(normalized);
      }
    }
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
