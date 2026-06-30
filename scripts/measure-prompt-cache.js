#!/usr/bin/env node

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DATASET_NAME, DEFAULT_DATASETS_DIR, loadBenchmarkDataset } from '../src/benchmark.js';
import { getOptionValue, hasOptionFlag } from '../src/env.js';
import { buildOptimizedPrompt, loadNarrowSchema, writeJsonFile } from '../src/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');
const DEFAULT_RESULTS_FILE = path.resolve(__dirname, '../generated/prompt-cache-measurement.json');

function average(values) {
  if (!values || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stableHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function cacheablePrefixText(prompt) {
  const cache = prompt.context?.promptCache || {};
  const userPrefixChars = Math.max(0, (cache.cacheablePrefixChars || 0) - String(prompt.system || '').length);
  return `${prompt.system || ''}\n${String(prompt.user || '').slice(0, userPrefixChars)}`;
}

function groupByPrefix(cases) {
  const groups = new Map();

  for (const entry of cases) {
    const current = groups.get(entry.cacheable_prefix_hash) || {
      cacheable_prefix_hash: entry.cacheable_prefix_hash,
      case_count: 0,
      case_ids: [],
      expanded_tables: entry.expanded_tables,
      cacheable_prefix_estimated_tokens: entry.prompt_cache.cacheablePrefixEstimatedTokens,
    };

    current.case_count += 1;
    current.case_ids.push(entry.id);
    groups.set(entry.cacheable_prefix_hash, current);
  }

  return [...groups.values()].sort(
    (left, right) =>
      right.case_count - left.case_count ||
      right.cacheable_prefix_estimated_tokens - left.cacheable_prefix_estimated_tokens ||
      left.cacheable_prefix_hash.localeCompare(right.cacheable_prefix_hash)
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const refreshSchema = hasOptionFlag(argv, '--refresh-schema');
  const datasetPath = getOptionValue(argv, '--dataset-file') || getOptionValue(argv, '--dev-set');
  const datasetName = getOptionValue(argv, '--dataset') || (datasetPath ? null : DEFAULT_DATASET_NAME);
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const caseId = getOptionValue(argv, '--case-id');
  const tag = getOptionValue(argv, '--tag');
  const resultsPath = path.resolve(getOptionValue(argv, '--results-file') || DEFAULT_RESULTS_FILE);

  const schema = await loadNarrowSchema({
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    refreshSchema,
  });
  const datasetInfo = await loadBenchmarkDataset({
    datasetName,
    datasetPath,
    datasetsDir,
    caseId,
    tag,
  });

  const cases = datasetInfo.cases.map((testCase) => {
    const prompt = buildOptimizedPrompt(schema, testCase.question);
    const promptCache = prompt.context.promptCache;

    return {
      id: testCase.id,
      intentId: testCase.intentId || null,
      question: testCase.question,
      expanded_tables: prompt.context.retrieval.expandedTableNames,
      prompt_cache: promptCache,
      cacheable_prefix_hash: stableHash(cacheablePrefixText(prompt)),
    };
  });
  const prefixGroups = groupByPrefix(cases);
  const summary = {
    case_count: cases.length,
    unique_cacheable_prefix_count: prefixGroups.length,
    average_total_estimated_tokens: average(cases.map((entry) => entry.prompt_cache.totalEstimatedTokens)),
    average_cacheable_prefix_estimated_tokens: average(
      cases.map((entry) => entry.prompt_cache.cacheablePrefixEstimatedTokens)
    ),
    average_legacy_cacheable_prefix_estimated_tokens: average(
      cases.map((entry) => entry.prompt_cache.legacyCacheablePrefixEstimatedTokens)
    ),
    average_additional_cacheable_prefix_estimated_tokens: average(
      cases.map((entry) => entry.prompt_cache.additionalCacheablePrefixEstimatedTokens)
    ),
    average_dynamic_estimated_tokens: average(cases.map((entry) => entry.prompt_cache.dynamicEstimatedTokens)),
    largest_reuse_group: prefixGroups[0] || null,
  };
  const report = {
    generated_at: new Date().toISOString(),
    dataset: {
      name: datasetInfo.datasetName,
      path: datasetInfo.datasetPath,
      selected_case_count: datasetInfo.cases.length,
      total_case_count: datasetInfo.totalCases,
      filters: datasetInfo.filters,
    },
    summary,
    prefix_groups: prefixGroups,
    cases,
  };

  await writeJsonFile(resultsPath, report);

  console.log(`Prompt cache measurement written to ${resultsPath}`);
  console.log(`Dataset: ${datasetInfo.datasetName}`);
  console.log(`Cases: ${summary.case_count}`);
  console.log(`Unique cacheable prefixes: ${summary.unique_cacheable_prefix_count}`);
  console.log(`Average total estimated tokens: ${summary.average_total_estimated_tokens.toFixed(1)}`);
  console.log(
    `Average cacheable prefix estimated tokens: ${summary.average_cacheable_prefix_estimated_tokens.toFixed(1)}`
  );
  console.log(
    `Average legacy cacheable prefix estimated tokens: ${summary.average_legacy_cacheable_prefix_estimated_tokens.toFixed(1)}`
  );
  console.log(
    `Average additional cacheable prefix estimated tokens: ${summary.average_additional_cacheable_prefix_estimated_tokens.toFixed(1)}`
  );
}

main().catch((error) => {
  console.error(`Prompt cache measurement failed: ${error.message}`);
  process.exitCode = 1;
});
