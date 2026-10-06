// Evaluation suite: which cases one run evaluates.
//
// The default suite is every dataset in datasets/ (the controls directory is
// not a dataset), de-duplicated:
// - by case id: the edge suite reuses the 9 core cases verbatim, so each is
//   evaluated once (the first dataset in name order keeps it);
// - by identical (question, normalized gold SQL), when the case is also
//   scored the same way (same alternatives and comparison spec): the same
//   question with the same answer under another id is one measurement, not
//   two. The same question and gold scored differently stays a separate case.
// --case-id resolves a dropped duplicate to the case kept in its place.
// Only the kept definition is run (verifySuite verifies every distinct
// definition, but the run scores one), so a dropped one must not differ in
// anything that would make the result depend on dataset order. Dataset conflicts (they must be fixed; the run stops):
// - a case id that appears in two datasets with definitions that are not
//   identical: a different question, gold, alternatives or comparison spec
//   (comparisons align cases by id), and equally a different split, known
//   validator rejection, row-count pins (the legacy single pin counts as the
//   primary fixture's), signal checks, intent, tags,
//   expected / disallowed columns or tables, canonical question, difficulty or
//   failure class (caseDefinitionDifferences). Whitespace in the question and
//   SQL and the order of the top-level list fields (tags, expected /
//   disallowed columns, expected tables) are not differences; list order
//   inside signal_checks or the comparison spec is. Free-text `notes` is not
//   compared: nothing runs, verifies, scores, selects or reports on it.
//   Rejecting the second definition, rather than verifying both and running
//   the first, is the conservative choice: no definition is silently unused;
// - a question duplicate under another id that would be merged into the kept
//   case but has a different split or known validator rejection: the split
//   decides which split's accuracy counts the measurement, the flag how its
//   verification treats a validator rejection. (Its other fields are verified
//   under its own id, and the kept case's are reported.)
// The id of a dropped duplicate is registered too, with the definition it was
// dropped with, so a later dataset cannot reuse it for another question.
//
// Filters: --split dev|holdout|all (a case without `split` counts as dev),
// --case-id, --tag (any of), --intent (any of); list values are comma-separated.

import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_DATASETS_DIR, loadBenchmarkDataset } from '../benchmark.js';
import { goldFingerprint, normalizeSqlText } from './controls.js';
import { PRIMARY_FIXTURE } from './fixtures.js';
import { sha256Hex, stableStringify } from './provenance.js';

export const SPLITS = Object.freeze(['dev', 'holdout', 'all']);

export function caseSplit(testCase) {
  const split = String(testCase?.split || '').trim().toLowerCase();
  return split || 'dev';
}

export function parseList(value) {
  if (value == null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * Scoring fingerprint: everything the oracle compares against (gold,
 * accepted alternatives, comparison spec) and, for an abstain or clarify case,
 * the expected behavior. A change means old verdicts no longer answer the same
 * question. (An answer case leaves the behavior out, so fingerprints recorded
 * before behavior cases existed still match.)
 */
export function scoringFingerprint(testCase) {
  const behavior = testCase.expected_behavior && testCase.expected_behavior !== 'answer' ? { behavior: testCase.expected_behavior } : {};
  return sha256Hex(
    stableStringify({
      gold: normalizeSqlText(testCase.expected_sql),
      alternatives: [...(testCase.alternative_expected_sql || [])].map(normalizeSqlText).sort(),
      comparison: testCase.comparison ?? null,
      ...behavior,
    })
  ).slice(0, 16);
}

// Question + everything the oracle scores against (the scoring fingerprint
// covers the normalized gold, the alternatives and the comparison spec).
function questionKey(testCase) {
  return `${normalizeSqlText(testCase.question).toLowerCase()}\u0000${scoringFingerprint(testCase)}`;
}

// The row-count pins of a case per fixture. The legacy single
// `expected_row_count` is the pin of the primary fixture and is ignored next to
// the per-fixture map (resolveExpectedRowCount), so `expected_row_count: 4` and
// `expected_row_counts: { seed: 4 }` are the same pins.
function rowCountPins(testCase) {
  if (testCase.expected_row_counts) {
    return testCase.expected_row_counts;
  }
  return Number.isInteger(testCase.expected_row_count) ? { [PRIMARY_FIXTURE.name]: testCase.expected_row_count } : null;
}

const sortedStrings = (values) => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)))].sort();

// The fields of a case definition, each with the normalized value two
// definitions are compared on. The question, gold and scoring come first.
// A field that defaults from another one is reported only when that one is
// the same (DERIVED_FIELDS): the scoring fingerprint covers the gold, the
// expected tables default to the gold's, the canonical question to the
// question.
const DEFINITION_FIELDS = Object.freeze([
  ['question', (testCase) => normalizeSqlText(testCase.question)],
  ['gold SQL', (testCase) => goldFingerprint(testCase.expected_sql)],
  ['alternatives or comparison spec', scoringFingerprint],
  ['split', caseSplit],
  ['known_validator_rejection', (testCase) => testCase.known_validator_rejection || null],
  ['expected_row_counts', rowCountPins],
  ['signal_checks', (testCase) => testCase.signal_checks ?? null],
  ['intentId', (testCase) => String(testCase.intentId || testCase.id)],
  ['tags', (testCase) => sortedStrings(testCase.tags)],
  ['expected_tables', (testCase) => sortedStrings(testCase.expected_tables)],
  ['expected_columns', (testCase) => sortedStrings(testCase.expected_columns)],
  ['disallowed_columns', (testCase) => sortedStrings(testCase.disallowed_columns)],
  ['canonicalQuestion', (testCase) => normalizeSqlText(testCase.canonicalQuestion || testCase.question)],
  ['difficulty', (testCase) => testCase.difficulty || null],
  ['failure_class', (testCase) => testCase.failure_class || null],
]);

const DERIVED_FIELDS = Object.freeze({
  'alternatives or comparison spec': 'gold SQL',
  expected_tables: 'gold SQL',
  canonicalQuestion: 'question',
});

const definitionValues = (testCase) => DEFINITION_FIELDS.map(([label, valueOf]) => [label, stableStringify(valueOf(testCase) ?? null)]);

/**
 * Which fields two definitions of a case disagree on (labels, in
 * DEFINITION_FIELDS order; empty when they are the same case). Whitespace in
 * the question and SQL, the order of the top-level list fields (tags,
 * expected / disallowed columns, expected tables) and a missing split (dev)
 * are not differences; list order inside signal_checks or the comparison spec
 * is. Free-text notes are not compared.
 */
export function caseDefinitionDifferences(left, right) {
  const rightValues = new Map(definitionValues(right));
  const differs = definitionValues(left)
    .filter(([label, value]) => rightValues.get(label) !== value)
    .map(([label]) => label);
  return differs.filter((label) => !differs.includes(DERIVED_FIELDS[label]));
}

/**
 * Fingerprint of a whole case definition (every field caseDefinitionDifferences
 * compares): equal exactly when the two definitions have no difference.
 */
export function caseDefinitionFingerprint(testCase) {
  return sha256Hex(stableStringify(definitionValues(testCase))).slice(0, 16);
}

// A question duplicate under another id is merged into the kept case only when
// these agree (see the file comment).
const QUESTION_DUPLICATE_FIELDS = Object.freeze(['split', 'known_validator_rejection']);

function describeDifferences(differs) {
  return differs.length <= 2 ? differs.join(' and ') : `${differs.slice(0, -1).join(', ')} and ${differs[differs.length - 1]}`;
}

/** Dataset names (files *.json) in a datasets directory, sorted. */
export async function listDatasetNames(datasetsDir = DEFAULT_DATASETS_DIR) {
  const entries = await fs.readdir(datasetsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.basename(entry.name, '.json'))
    .sort();
}

/**
 * Loads the datasets of a suite: named datasets, explicit files, or every
 * dataset of `datasetsDir`. Returns [{ name, path, cases }] (normalized cases).
 */
export async function loadSuiteDatasets({ datasetsDir = DEFAULT_DATASETS_DIR, datasetNames = [], datasetFiles = [] } = {}) {
  const targets = [];
  for (const file of datasetFiles) {
    targets.push({ datasetPath: path.resolve(file), datasetName: path.basename(file, '.json') });
  }
  for (const name of datasetNames) {
    targets.push({ datasetName: name, datasetsDir });
  }
  if (targets.length === 0) {
    for (const name of await listDatasetNames(datasetsDir)) {
      targets.push({ datasetName: name, datasetsDir });
    }
  }
  const datasets = [];
  for (const target of targets) {
    const info = await loadBenchmarkDataset(target);
    datasets.push({ name: info.datasetName, path: info.datasetPath, cases: info.cases });
  }
  return datasets;
}

/**
 * De-duplicates the cases of several datasets. Returns
 * { entries: [{ testCase, datasets: [names] }], duplicates: [{ id, dataset,
 * keptAs, keptFrom, reason }], conflicts: [{ id, datasets, reason }] }.
 */
export function dedupeSuiteCases(datasets) {
  // id -> { testCase: its first definition, firstDataset, keptEntry: the entry
  // that runs for it (itself, or the case it duplicates) }.
  const byId = new Map();
  const byQuestion = new Map();
  const entries = [];
  const duplicates = [];
  const conflicts = [];

  for (const dataset of datasets) {
    for (const testCase of dataset.cases) {
      const sameId = byId.get(testCase.id);
      if (sameId) {
        const differs = caseDefinitionDifferences(sameId.testCase, testCase);
        if (differs.length > 0) {
          conflicts.push({ id: testCase.id, datasets: [sameId.firstDataset, dataset.name], reason: `different ${describeDifferences(differs)}` });
        } else {
          const target = sameId.keptEntry;
          target.datasets.push(dataset.name);
          duplicates.push({
            id: testCase.id,
            dataset: dataset.name,
            keptAs: target.testCase.id,
            keptFrom: target.datasets[0],
            reason: target.testCase.id === testCase.id ? 'same case id' : 'same question and gold SQL',
          });
        }
        continue;
      }
      const sameQuestion = byQuestion.get(questionKey(testCase));
      if (sameQuestion) {
        const differs = caseDefinitionDifferences(sameQuestion.testCase, testCase).filter((label) => QUESTION_DUPLICATE_FIELDS.includes(label));
        if (differs.length > 0) {
          conflicts.push({
            id: testCase.id,
            datasets: [sameQuestion.datasets[0], dataset.name],
            reason: `different ${describeDifferences(differs)} than ${sameQuestion.testCase.id} (same question and gold SQL)`,
          });
          // Registered, not merged: a later copy of this id is checked
          // against this definition.
          byId.set(testCase.id, { testCase, firstDataset: dataset.name, keptEntry: sameQuestion });
          continue;
        }
        sameQuestion.datasets.push(dataset.name);
        duplicates.push({
          id: testCase.id,
          dataset: dataset.name,
          keptAs: sameQuestion.testCase.id,
          keptFrom: sameQuestion.datasets[0],
          reason: 'same question and gold SQL',
        });
        // The dropped id keeps its definition: reusing it later for another
        // question or gold is a conflict, like any other id.
        byId.set(testCase.id, { testCase, firstDataset: dataset.name, keptEntry: sameQuestion });
        continue;
      }
      const entry = { testCase, datasets: [dataset.name] };
      byId.set(testCase.id, { testCase, firstDataset: dataset.name, keptEntry: entry });
      byQuestion.set(questionKey(testCase), entry);
      entries.push(entry);
    }
  }
  return { entries, duplicates, conflicts };
}

/** Applies the run filters to de-duplicated entries. */
export function filterSuiteEntries(entries, { split = 'all', caseIds = [], tags = [], intents = [] } = {}) {
  if (!SPLITS.includes(split)) {
    throw new Error(`--split must be one of ${SPLITS.join(', ')}; got "${split}".`);
  }
  const idSet = new Set(caseIds);
  const tagSet = new Set(tags);
  const intentSet = new Set(intents);
  return entries.filter(({ testCase }) => {
    if (split !== 'all' && caseSplit(testCase) !== split) {
      return false;
    }
    if (idSet.size > 0 && !idSet.has(testCase.id)) {
      return false;
    }
    if (tagSet.size > 0 && !(testCase.tags || []).some((tag) => tagSet.has(tag))) {
      return false;
    }
    if (intentSet.size > 0 && !intentSet.has(testCase.intentId)) {
      return false;
    }
    return true;
  });
}

/** Suite name used in the run path: 'all', the dataset name(s) joined by '+', or a file's basename. */
export function suiteName({ datasetNames = [], datasetFiles = [] } = {}) {
  const names = [...datasetFiles.map((file) => path.basename(file, '.json')), ...datasetNames];
  return names.length === 0 ? 'all' : names.join('+');
}

/**
 * A dropped duplicate's id selects the case kept in its place (live runs and
 * rescores alike). Returns { caseIds (resolved, de-duplicated),
 * aliasedCaseIds: [{ id, keptAs }] }.
 */
export function resolveCaseIdAliases(caseIds = [], duplicates = []) {
  const keptAs = new Map(duplicates.filter((duplicate) => duplicate.id !== duplicate.keptAs).map((duplicate) => [duplicate.id, duplicate.keptAs]));
  return {
    caseIds: [...new Set(caseIds.map((id) => keptAs.get(id) || id))],
    aliasedCaseIds: caseIds.filter((id) => keptAs.has(id)).map((id) => ({ id, keptAs: keptAs.get(id) })),
  };
}

/**
 * Loads, de-duplicates and filters a suite. Throws on dataset conflicts and on
 * an empty selection (both are dataset/harness failures).
 */
export async function selectSuite({ datasetsDir = DEFAULT_DATASETS_DIR, datasetNames = [], datasetFiles = [], split = 'all', caseIds = [], tags = [], intents = [] } = {}) {
  const datasets = await loadSuiteDatasets({ datasetsDir, datasetNames, datasetFiles });
  const { entries, duplicates, conflicts } = dedupeSuiteCases(datasets);
  if (conflicts.length > 0) {
    const error = new Error(
      `Dataset conflict: ${conflicts.map((conflict) => `${conflict.id} has a ${conflict.reason} in ${conflict.datasets.join(' and ')}`).join('; ')}. ` +
        'Case ids must be unique across datasets unless the cases are identical.'
    );
    error.code = 'DATASET_CONFLICT';
    throw error;
  }
  const filters = { split, caseIds, tags, intents };
  const { caseIds: resolvedCaseIds, aliasedCaseIds } = resolveCaseIdAliases(caseIds, duplicates);
  const selected = filterSuiteEntries(entries, { ...filters, caseIds: resolvedCaseIds });
  if (selected.length === 0) {
    const error = new Error(`No cases matched the selection (${describeFilters(filters) || 'no filters'}).`);
    error.code = 'EMPTY_SELECTION';
    throw error;
  }
  return {
    name: suiteName({ datasetNames, datasetFiles }),
    datasets,
    entries: selected,
    uniqueCaseCount: entries.length,
    totalCaseCount: datasets.reduce((sum, dataset) => sum + dataset.cases.length, 0),
    duplicates,
    aliasedCaseIds,
    filters,
  };
}

export function describeFilters({ split = 'all', caseIds = [], tags = [], intents = [] } = {}) {
  return [
    split && split !== 'all' ? `split=${split}` : null,
    caseIds.length ? `case-id=${caseIds.join(',')}` : null,
    tags.length ? `tag=${tags.join(',')}` : null,
    intents.length ? `intent=${intents.join(',')}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
