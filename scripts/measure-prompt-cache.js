#!/usr/bin/env node

// Offline prompt-size and prompt-cache measurement (no database, no LLM): builds
// the optimized prompt for every question of a dataset (or the whole eval
// suite) and reports characters, estimated tokens (characters / 4), the
// cacheable prefix and how many distinct prefixes the questions produce.
//
//   npm run measure-prompt-cache                           # core-public, configured scope
//   npm run measure-prompt-cache -- --suite --schema-scope all
//   options: --dataset <name> | --dataset-file <path> | --suite  [--datasets-dir <dir>]
//            [--case-id <id>] [--tag <tag>] [--schema-scope retrieved|full|auto|all]
//            [--results-file <path>] [--refresh-schema]
//            with --suite (selected like npm run eval): [--dataset <names>]
//            [--dataset-file <paths>] [--split dev|holdout|all] [--intent <ids>],
//            and --case-id / --tag / --dataset / --dataset-file / --intent take
//            comma-separated lists
//
// Unknown flags are rejected, like npm run eval: a misspelled filter must not
// silently measure the whole suite.
//
// --schema-scope defaults to the configured SCHEMA_SCOPE (default auto); `all`
// measures retrieved, full and auto side by side. Master-data candidates are
// not resolved (no database), so prompts that would list candidates are a few
// lines shorter than in production.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DATASET_NAME, DEFAULT_DATASETS_DIR, loadBenchmarkDataset } from '../src/benchmark.js';
import { DOTENV_FLAG, getOptionValue, hasOptionFlag, loadEnvironment } from '../src/env.js';
import { describeFilters, parseList, selectSuite, SPLITS } from '../src/eval/suite.js';
import { buildOptimizedPrompt, loadNarrowSchema, rankedTableNames, resolveEffectiveSchemaScope, writeJsonFile } from '../src/pipeline.js';
import { describeHintsVersion, normalizeHintsVersion, resolveHintsVersion } from '../src/hints-version.js';
import { SCHEMA_SCOPES, describeSchemaScope, resolveSchemaScopeConfig } from '../src/schema-scope.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');
const DEFAULT_RESULTS_FILE = path.resolve(__dirname, '../generated/prompt-cache-measurement.json');

// Every flag this script (and its env loader) understands.
const VALUE_FLAGS = new Set([
  '--dataset',
  '--dataset-file',
  '--dev-set',
  '--datasets-dir',
  '--split',
  '--case-id',
  '--tag',
  '--intent',
  '--schema-scope',
  '--results-file',
  DOTENV_FLAG,
  '--env-dir',
]);
const BOOLEAN_FLAGS = new Set(['--help', '--suite', '--refresh-schema', '--use-home-env']);
const USAGE = `Usage: npm run measure-prompt-cache -- [options]
  --dataset <name> | --dataset-file <path> | --suite   what to measure (default core-public)
  --datasets-dir <dir>
  --case-id <ids> --tag <tags>                        narrow the selection
  --split dev|holdout|all --intent <ids>              (with --suite) narrow the suite like npm run eval
  --schema-scope retrieved|full|auto|all              default: the configured SCHEMA_SCOPE
  --results-file <path> --refresh-schema
  --dotenv <path> | --env-dir <dir> | --use-home-env`;

function closestFlag(name) {
  const known = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];
  const bare = (flag) => flag.replace(/[^a-z]/g, '');
  return known.find((flag) => bare(flag) === bare(name)) || known.find((flag) => flag.startsWith(name)) || null;
}

/**
 * Rejects unknown flags, stray arguments, value flags without a value (or
 * whose value is empty or another flag) and boolean flags given a value.
 */
export function validateMeasureArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}" (every option is a --flag).`);
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (VALUE_FLAGS.has(name)) {
      const value = equals === -1 ? argv[index + 1] : arg.slice(equals + 1);
      if (value === undefined || String(value).trim() === '' || (equals === -1 && value.startsWith('--'))) {
        throw new Error(`${name} needs a value.`);
      }
      if (equals === -1) {
        index += 1;
      }
    } else if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) {
        throw new Error(`${name} takes no value; got "${arg}".`);
      }
    } else {
      const suggestion = closestFlag(name);
      throw new Error(`Unknown option "${name}".${suggestion ? ` Did you mean ${suggestion}?` : ''}`);
    }
  }
}

function average(values) {
  if (!values || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
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
      prompt_tables: entry.prompt_tables,
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

/**
 * Prompt sizes of `testCases` under one schema scope (a scope name or config)
 * and hints version (default: the product default). Returns { schema_scope,
 * hints_version, summary, prefix_groups, cases }.
 */
export function measureScope(schema, testCases, schemaScope, { hintsVersion = undefined } = {}) {
  const cases = testCases.map((testCase) => {
    const prompt = buildOptimizedPrompt(schema, testCase.question, { schemaScope, hintsVersion });
    const promptCache = prompt.context.promptCache;

    return {
      id: testCase.id,
      intentId: testCase.intentId || null,
      question: testCase.question,
      prompt_tables: prompt.tables.map((table) => table.tableName),
      ranked_tables: rankedTableNames(prompt.context.retrieval),
      prompt_cache: promptCache,
      cacheable_prefix_hash: stableHash(cacheablePrefixText(prompt)),
    };
  });
  const prefixGroups = groupByPrefix(cases);
  const scope = resolveEffectiveSchemaScope(schema, schemaScope);
  const summary = {
    case_count: cases.length,
    unique_cacheable_prefix_count: prefixGroups.length,
    average_prompt_table_count: average(cases.map((entry) => entry.prompt_tables.length)),
    average_total_chars: average(cases.map((entry) => entry.prompt_cache.totalChars)),
    average_total_estimated_tokens: average(cases.map((entry) => entry.prompt_cache.totalEstimatedTokens)),
    total_estimated_tokens: sum(cases.map((entry) => entry.prompt_cache.totalEstimatedTokens)),
    average_cacheable_prefix_estimated_tokens: average(cases.map((entry) => entry.prompt_cache.cacheablePrefixEstimatedTokens)),
    average_dynamic_chars: average(cases.map((entry) => entry.prompt_cache.dynamicChars)),
    average_dynamic_estimated_tokens: average(cases.map((entry) => entry.prompt_cache.dynamicEstimatedTokens)),
    average_legacy_cacheable_prefix_estimated_tokens: average(cases.map((entry) => entry.prompt_cache.legacyCacheablePrefixEstimatedTokens)),
    average_additional_cacheable_prefix_estimated_tokens: average(
      cases.map((entry) => entry.prompt_cache.additionalCacheablePrefixEstimatedTokens)
    ),
    largest_reuse_group: prefixGroups[0] ? { ...prefixGroups[0], case_ids: prefixGroups[0].case_ids.slice(0, 20) } : null,
  };
  return { schema_scope: scope, hints_version: normalizeHintsVersion(hintsVersion), summary, prefix_groups: prefixGroups, cases };
}

/**
 * The questions to measure and how they were selected: { dataset, cases }.
 * --suite selects like npm run eval: the default suite (every dataset,
 * de-duplicated) or the --dataset / --dataset-file lists, narrowed by
 * --split / --case-id / --tag / --intent. Otherwise one dataset, narrowed by
 * --case-id / --tag (--split and --intent need --suite). dataset.filters
 * records the filters.
 */
export async function loadCases(argv) {
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const datasetFileOption = getOptionValue(argv, '--dataset-file') || getOptionValue(argv, '--dev-set');
  if (hasOptionFlag(argv, '--suite')) {
    const split = getOptionValue(argv, '--split') || 'all';
    if (!SPLITS.includes(split)) {
      throw new Error(`--split must be one of ${SPLITS.join(', ')}; got "${split}".`);
    }
    const selection = await selectSuite({
      datasetsDir,
      datasetNames: parseList(getOptionValue(argv, '--dataset')),
      datasetFiles: parseList(datasetFileOption),
      split,
      caseIds: parseList(getOptionValue(argv, '--case-id')),
      tags: parseList(getOptionValue(argv, '--tag')),
      intents: parseList(getOptionValue(argv, '--intent')),
    });
    const { filters } = selection;
    return {
      dataset: {
        name: selection.name,
        path: null,
        selected_case_count: selection.entries.length,
        total_case_count: selection.totalCaseCount,
        filters:
          describeFilters(filters) !== '' ? { split: filters.split, caseIds: filters.caseIds, tags: filters.tags, intents: filters.intents } : null,
      },
      cases: selection.entries.map((entry) => entry.testCase),
    };
  }
  if (getOptionValue(argv, '--split') !== null || getOptionValue(argv, '--intent') !== null) {
    throw new Error('--split and --intent need --suite (one dataset is selected by --case-id / --tag).');
  }
  const datasetPath = datasetFileOption;
  const datasetName = getOptionValue(argv, '--dataset') || (datasetPath ? null : DEFAULT_DATASET_NAME);
  const datasetInfo = await loadBenchmarkDataset({
    datasetName,
    datasetPath,
    datasetsDir,
    caseId: getOptionValue(argv, '--case-id'),
    tag: getOptionValue(argv, '--tag'),
  });
  return {
    dataset: {
      name: datasetInfo.datasetName,
      path: datasetInfo.datasetPath,
      selected_case_count: datasetInfo.cases.length,
      total_case_count: datasetInfo.totalCases,
      filters: datasetInfo.filters,
    },
    cases: datasetInfo.cases,
  };
}

// The filters of either selection: a suite's { split, caseIds, tags, intents }
// or a dataset's { caseId, tag }.
function describeSelectionFilters(filters) {
  if (!filters) {
    return '';
  }
  if (Array.isArray(filters.caseIds) || Array.isArray(filters.tags)) {
    return describeFilters(filters);
  }
  return [filters.caseId != null ? `case-id=${filters.caseId}` : null, filters.tag ? `tag=${filters.tag}` : null].filter(Boolean).join(', ');
}

/**
 * The schema-scope configs to measure for --schema-scope (a scope name, `all`
 * or unset for the configured SCHEMA_SCOPE). A scope chosen on the command
 * line is resolved as if SCHEMA_SCOPE were set to it, so widen-on-demand gets
 * that scope's default (off for an explicit retrieved) unless
 * SCHEMA_WIDEN_ON_DEMAND is set; SCHEMA_FULL_MAX_TOKENS still applies.
 */
export function measurementScopes(scopeOption, env = process.env) {
  if (scopeOption && scopeOption !== 'all' && !SCHEMA_SCOPES.includes(scopeOption)) {
    throw new Error(`--schema-scope must be one of ${SCHEMA_SCOPES.join(', ')} or all; got "${scopeOption}".`);
  }
  const withScope = (schemaScope) => resolveSchemaScopeConfig({ ...env, SCHEMA_SCOPE: schemaScope });
  if (scopeOption === 'all') {
    return SCHEMA_SCOPES.map(withScope);
  }
  return [scopeOption ? withScope(scopeOption) : resolveSchemaScopeConfig(env)];
}

function printSummary(result) {
  const { summary } = result;
  console.log(`\nSchema scope: ${describeSchemaScope(result.schema_scope)}; hints version ${describeHintsVersion(result.hints_version)}`);
  console.log(`  Cases: ${summary.case_count}; prompt tables per question: ${summary.average_prompt_table_count.toFixed(1)}`);
  console.log(`  Unique cacheable prefixes: ${summary.unique_cacheable_prefix_count}`);
  console.log(`  Average prompt: ${summary.average_total_chars.toFixed(0)} chars, ${summary.average_total_estimated_tokens.toFixed(1)} estimated tokens`);
  console.log(`  Average cacheable prefix: ${summary.average_cacheable_prefix_estimated_tokens.toFixed(1)} estimated tokens`);
  console.log(`  Average question part: ${summary.average_dynamic_chars.toFixed(0)} chars, ${summary.average_dynamic_estimated_tokens.toFixed(1)} estimated tokens`);
  console.log(`  Total over the selection: ${summary.total_estimated_tokens} estimated tokens`);
}

async function main() {
  const argv = process.argv.slice(2);
  validateMeasureArgv(argv);
  if (hasOptionFlag(argv, '--help')) {
    console.log(USAGE);
    return;
  }
  await loadEnvironment(argv);
  const refreshSchema = hasOptionFlag(argv, '--refresh-schema');
  const resultsPath = path.resolve(getOptionValue(argv, '--results-file') || DEFAULT_RESULTS_FILE);
  const scopes = measurementScopes(getOptionValue(argv, '--schema-scope'));
  const hintsVersion = resolveHintsVersion();

  const schema = await loadNarrowSchema({
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    refreshSchema,
  });
  const { dataset, cases } = await loadCases(argv);
  const results = scopes.map((schemaScope) => measureScope(schema, cases, schemaScope, { hintsVersion }));
  const report = {
    generated_at: new Date().toISOString(),
    dataset,
    // One entry per measured scope; with a single scope the familiar
    // top-level summary / prefix_groups / cases are kept too.
    scopes: results,
    ...(results.length === 1 ? { summary: results[0].summary, prefix_groups: results[0].prefix_groups, cases: results[0].cases } : {}),
  };

  await writeJsonFile(resultsPath, report);

  console.log(`Prompt cache measurement written to ${resultsPath}`);
  const filters = describeSelectionFilters(dataset.filters);
  console.log(`Dataset: ${dataset.name} (${dataset.selected_case_count} questions${filters ? `; ${filters}` : ''})`);
  for (const result of results) {
    printSummary(result);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`Prompt cache measurement failed: ${error.message}${/^(Unknown option|Unexpected argument)|needs a value|takes no value/.test(error.message) ? '\nRun with --help for usage.' : ''}`);
    process.exitCode = 1;
  });
}
