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
// A case id that appears with a different question or gold in two datasets is
// a dataset conflict: comparisons align cases by id, so it must be fixed.
//
// Filters: --split dev|holdout|all (a case without `split` counts as dev),
// --case-id, --tag (any of), --intent (any of); list values are comma-separated.

import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_DATASETS_DIR, loadBenchmarkDataset } from '../benchmark.js';
import { goldFingerprint, normalizeSqlText } from './controls.js';
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
 * accepted alternatives, comparison spec). A change means old verdicts no
 * longer answer the same question.
 */
export function scoringFingerprint(testCase) {
  return sha256Hex(
    stableStringify({
      gold: normalizeSqlText(testCase.expected_sql),
      alternatives: [...(testCase.alternative_expected_sql || [])].map(normalizeSqlText).sort(),
      comparison: testCase.comparison ?? null,
    })
  ).slice(0, 16);
}

// Question + everything the oracle scores against (the scoring fingerprint
// covers the normalized gold, the alternatives and the comparison spec).
function questionKey(testCase) {
  return `${normalizeSqlText(testCase.question).toLowerCase()}\u0000${scoringFingerprint(testCase)}`;
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
  const byId = new Map();
  const byQuestion = new Map();
  const entries = [];
  const duplicates = [];
  const conflicts = [];

  for (const dataset of datasets) {
    for (const testCase of dataset.cases) {
      const sameId = byId.get(testCase.id);
      if (sameId) {
        const kept = sameId.testCase;
        const differs = [];
        if (normalizeSqlText(kept.question) !== normalizeSqlText(testCase.question)) {
          differs.push('question');
        }
        if (goldFingerprint(kept.expected_sql) !== goldFingerprint(testCase.expected_sql)) {
          differs.push('gold SQL');
        }
        if (scoringFingerprint(kept) !== scoringFingerprint(testCase) && !differs.includes('gold SQL')) {
          differs.push('alternatives or comparison spec');
        }
        if (differs.length > 0) {
          conflicts.push({ id: testCase.id, datasets: [sameId.datasets[0], dataset.name], reason: `different ${differs.join(' and ')}` });
        } else {
          sameId.datasets.push(dataset.name);
          duplicates.push({ id: testCase.id, dataset: dataset.name, keptAs: kept.id, keptFrom: sameId.datasets[0], reason: 'same case id' });
        }
        continue;
      }
      const sameQuestion = byQuestion.get(questionKey(testCase));
      if (sameQuestion) {
        sameQuestion.datasets.push(dataset.name);
        duplicates.push({
          id: testCase.id,
          dataset: dataset.name,
          keptAs: sameQuestion.testCase.id,
          keptFrom: sameQuestion.datasets[0],
          reason: 'same question and gold SQL',
        });
        continue;
      }
      const entry = { testCase, datasets: [dataset.name] };
      byId.set(testCase.id, entry);
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
  // A dropped duplicate's id selects the case kept in its place.
  const keptAs = new Map(duplicates.filter((duplicate) => duplicate.id !== duplicate.keptAs).map((duplicate) => [duplicate.id, duplicate.keptAs]));
  const aliasedCaseIds = caseIds.filter((id) => keptAs.has(id)).map((id) => ({ id, keptAs: keptAs.get(id) }));
  const selected = filterSuiteEntries(entries, { ...filters, caseIds: [...new Set(caseIds.map((id) => keptAs.get(id) || id))] });
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
