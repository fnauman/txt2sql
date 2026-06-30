import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOptionValue, getPositionalArgs, hasOptionFlag } from '../src/env.js';
import { caseMatchesId, DEFAULT_DATASET_NAME, DEFAULT_DATASETS_DIR, loadBenchmarkDataset } from '../src/benchmark.js';
import {
  extractTablesFromSql,
  loadNarrowSchema,
  normalizeTokens,
  retrieveRelevantExamples,
  retrieveRelevantTables,
  scoreTableDetailed,
} from '../src/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.resolve(__dirname, '../models');
const SCHEMA_PATH = path.resolve(__dirname, '../generated/schema.json');

function tableNameLookup(schema) {
  return new Map(schema.tables.map((table) => [table.name, table.tableName]));
}

function printDivider() {
  console.log('━'.repeat(78));
}

async function resolveQuestion(argv) {
  const caseId = getOptionValue(argv, '--case-id');
  const tag = getOptionValue(argv, '--tag');
  const datasetPath = getOptionValue(argv, '--dataset-file') || getOptionValue(argv, '--dev-set');
  const datasetName = getOptionValue(argv, '--dataset') || (datasetPath ? null : DEFAULT_DATASET_NAME);
  const datasetsDir = path.resolve(getOptionValue(argv, '--datasets-dir') || DEFAULT_DATASETS_DIR);
  const positional = getPositionalArgs(argv, [
    '--case-id',
    '--tag',
    '--dataset',
    '--dataset-file',
    '--datasets-dir',
    '--dev-set',
    '--expected-sql',
  ]);
  const inlineQuestion = positional.join(' ').trim();

  if (inlineQuestion) {
    return {
      question: inlineQuestion,
      expectedSql: getOptionValue(argv, '--expected-sql') || null,
      source: 'cli',
      datasetPath: null,
      datasetName: null,
      caseId: null,
    };
  }

  const datasetInfo = await loadBenchmarkDataset({
    datasetName,
    datasetPath,
    datasetsDir,
    tag,
  });

  if (caseId) {
    const match = datasetInfo.cases.find((entry) => caseMatchesId(entry, caseId));
    if (!match) {
      throw new Error(`No benchmark case found for id ${caseId}.`);
    }

    return {
      question: match.question,
      expectedSql: match.expected_sql,
      source: 'dataset',
      datasetPath: datasetInfo.datasetPath,
      datasetName: datasetInfo.datasetName,
      caseId: match.id,
    };
  }

  const firstCase = datasetInfo.cases[0];
  if (!firstCase) {
    throw new Error(`Dataset at ${datasetInfo.datasetPath} is empty.`);
  }

  return {
    question: firstCase.question,
    expectedSql: firstCase.expected_sql,
    source: 'dataset-default',
    datasetPath: datasetInfo.datasetPath,
    datasetName: datasetInfo.datasetName,
    caseId: firstCase.id,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const refreshSchema = hasOptionFlag(argv, '--refresh-schema');
  const questionInfo = await resolveQuestion(argv);
  const schema = await loadNarrowSchema({
    modelsDir: MODELS_DIR,
    schemaPath: SCHEMA_PATH,
    refreshSchema,
  });

  const retrieval = retrieveRelevantTables(schema, questionInfo.question);
  const examples = retrieveRelevantExamples(questionInfo.question, {
    maxExamples: 3,
    minScore: 1,
  });
  const nameToTableName = tableNameLookup(schema);
  const baseTableNames = retrieval.initialTableNames.map((name) => nameToTableName.get(name) || name);
  const expectedTables = questionInfo.expectedSql ? extractTablesFromSql(questionInfo.expectedSql) : [];
  const missingExpected = expectedTables.filter((tableName) => !retrieval.expandedTableNames.includes(tableName));
  const unexpectedExpanded = retrieval.expandedTableNames.filter((tableName) => !expectedTables.includes(tableName));

  printDivider();
  console.log(`Question: ${questionInfo.question}`);
  console.log(`Source: ${questionInfo.source}${questionInfo.caseId ? ` (case ${questionInfo.caseId})` : ''}`);
  if (questionInfo.datasetName) {
    console.log(`Dataset: ${questionInfo.datasetName}`);
  }
  console.log(`Normalized question: ${retrieval.normalizedQuestion}`);
  console.log(`Question tokens: ${normalizeTokens(questionInfo.question).join(', ') || '(none)'}`);
  printDivider();

  console.log('Resolved temporal references:');
  if (retrieval.temporalReferences.length === 0) {
    console.log('  (none)');
  } else {
    for (const reference of retrieval.temporalReferences) {
      console.log(`- ${reference.originalText} => ${reference.normalizedText} [${reference.startDate}, ${reference.endExclusive})`);
    }
  }
  printDivider();

  console.log('Selected tables before FK expansion:');
  console.log(baseTableNames.map((name) => `- ${name}`).join('\n') || '  (none)');
  console.log('\nExpanded prompt table set:');
  console.log(retrieval.expandedTableNames.map((name) => `- ${name}`).join('\n') || '  (none)');
  console.log(`\nConnector tables added for join paths: ${retrieval.connectorTableNames.length === 0 ? 'none' : retrieval.connectorTableNames.join(', ')}`);

  printDivider();
  console.log('Semantic retrieval matches:');
  const semanticPlan = retrieval.semanticPlan || {};
  const semanticLines = [
    ...(semanticPlan.entities || []).map(
      (entry) => `- entity ${entry.name}: ${entry.matchedSynonyms.join(', ')} -> ${entry.preferredTables.join(', ')}`
    ),
    ...(semanticPlan.metrics || []).map(
      (entry) => `- metric ${entry.name}: ${entry.matchedSynonyms.join(', ')} -> ${entry.preferredTables.join(', ')}`
    ),
    ...(semanticPlan.filterHints || []).map(
      (entry) => `- filter ${entry.name}: ${entry.matchedValues.join(', ')} -> ${entry.targetColumns.join(', ')}`
    ),
  ];
  console.log(semanticLines.join('\n') || '  (none)');

  if (expectedTables.length > 0) {
    printDivider();
    console.log('Expected tables from expected_sql:');
    console.log(expectedTables.map((name) => `- ${name}`).join('\n'));
    console.log(`Missing expected tables after expansion: ${missingExpected.length === 0 ? 'none' : missingExpected.join(', ')}`);
    console.log(`Extra expanded tables beyond expected_sql: ${unexpectedExpanded.length === 0 ? 'none' : unexpectedExpanded.join(', ')}`);
  }

  printDivider();
  console.log('Top table scores:');
  for (const entry of retrieval.tableScores.slice(0, 8)) {
    const table = schema.tables.find((candidate) => candidate.name === entry.name);
    const detail = scoreTableDetailed(table, retrieval.questionTokens);
    const reasons = detail.matches
      .map((match) => `${match.token} (+${match.score}: ${match.reasons.join(', ')})`)
      .join('; ');
    const semanticReasons = (entry.semanticMatches || [])
      .map((match) => `${match.sourceName} (+${match.score}: ${match.reason})`)
      .join('; ');
    console.log(
      `- ${entry.tableName}: ${entry.score} (lexical ${entry.lexicalScore || 0}, semantic ${entry.semanticScore || 0})${
        reasons || semanticReasons ? ` -> ${[reasons, semanticReasons].filter(Boolean).join('; ')}` : ''
      }`
    );
  }

  printDivider();
  console.log('Retrieved examples:');
  if (examples.length === 0) {
    console.log('  (no examples selected)');
  } else {
    for (const example of examples) {
      console.log(`- score ${example.score} | tokens [${example.matchedTokens.join(', ')}] | tables [${example.tables.join(', ')}]`);
      console.log(`  Q: ${example.question}`);
    }
  }

  if (questionInfo.expectedSql) {
    printDivider();
    console.log('Expected SQL:');
    console.log(questionInfo.expectedSql);
  }

  printDivider();
}

main().catch((error) => {
  console.error(`Retrieval debug failed: ${error.message}`);
  process.exitCode = 1;
});
