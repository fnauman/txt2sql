import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOptionValue, hasOptionFlag } from '../src/env.js';
import { DEFAULT_DATASET_NAME, DEFAULT_DATASETS_DIR, loadBenchmarkDataset } from '../src/benchmark.js';
import { extractTablesFromSql, loadNarrowSchema, retrieveRelevantTables, writeJsonFile } from '../src/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');
const DEFAULT_RESULTS_FILE = path.resolve(__dirname, '../generated/retrieval-evaluation.json');

function average(values) {
  if (!values || values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(hitCount, totalCount) {
  if (totalCount === 0) {
    return 1;
  }
  return hitCount / totalCount;
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
  const nameToTableName = new Map(schema.tables.map((table) => [table.name, table.tableName]));

  const cases = datasetInfo.cases.map((testCase) => {
    const retrieval = retrieveRelevantTables(schema, testCase.question);
    const expectedTables = testCase.expected_tables?.length > 0 ? testCase.expected_tables : extractTablesFromSql(testCase.expected_sql);
    const baseTables = retrieval.initialTableNames.map((name) => nameToTableName.get(name) || name);
    const expandedTables = retrieval.expandedTableNames;
    const baseHits = expectedTables.filter((tableName) => baseTables.includes(tableName));
    const expandedHits = expectedTables.filter((tableName) => expandedTables.includes(tableName));

    return {
      id: testCase.id,
      intentId: testCase.intentId,
      question: testCase.question,
      expected_tables: expectedTables,
      base_tables: baseTables,
      expanded_tables: expandedTables,
      base_recall: ratio(baseHits.length, expectedTables.length),
      expanded_recall: ratio(expandedHits.length, expectedTables.length),
      base_full_recall: baseHits.length === expectedTables.length,
      expanded_full_recall: expandedHits.length === expectedTables.length,
      base_extra_tables: baseTables.filter((tableName) => !expectedTables.includes(tableName)),
      expanded_extra_tables: expandedTables.filter((tableName) => !expectedTables.includes(tableName)),
      score_head: retrieval.tableScores.slice(0, 6),
      semantic_plan: retrieval.semanticPlan,
    };
  });

  const summary = {
    case_count: cases.length,
    base_full_recall_count: cases.filter((entry) => entry.base_full_recall).length,
    expanded_full_recall_count: cases.filter((entry) => entry.expanded_full_recall).length,
    average_base_recall: average(cases.map((entry) => entry.base_recall)),
    average_expanded_recall: average(cases.map((entry) => entry.expanded_recall)),
    average_base_table_count: average(cases.map((entry) => entry.base_tables.length)),
    average_expanded_table_count: average(cases.map((entry) => entry.expanded_tables.length)),
    average_expanded_extra_tables: average(cases.map((entry) => entry.expanded_extra_tables.length)),
    widest_case: cases.reduce((best, entry) => {
      if (!best || entry.expanded_tables.length > best.expanded_tables.length) {
        return {
          id: entry.id,
          question: entry.question,
          expanded_table_count: entry.expanded_tables.length,
          expanded_tables: entry.expanded_tables,
        };
      }
      return best;
    }, null),
  };

  const report = {
    generated_at: new Date().toISOString(),
    schema_table_count: schema.tables.length,
    dataset: {
      name: datasetInfo.datasetName,
      path: datasetInfo.datasetPath,
      selected_case_count: datasetInfo.cases.length,
      total_case_count: datasetInfo.totalCases,
      filters: datasetInfo.filters,
    },
    summary,
    cases,
  };

  await writeJsonFile(resultsPath, report);

  console.log(`Retrieval evaluation written to ${resultsPath}`);
  console.log(`Dataset: ${datasetInfo.datasetName}`);
  console.log(`Cases: ${summary.case_count}`);
  console.log(`Base full recall: ${summary.base_full_recall_count}/${summary.case_count}`);
  console.log(`Expanded full recall: ${summary.expanded_full_recall_count}/${summary.case_count}`);
  console.log(`Average expanded table count: ${summary.average_expanded_table_count.toFixed(2)}`);
  console.log(`Average extra expanded tables: ${summary.average_expanded_extra_tables.toFixed(2)}`);
}

main().catch((error) => {
  console.error(`Retrieval evaluation failed: ${error.message}`);
  process.exitCode = 1;
});
