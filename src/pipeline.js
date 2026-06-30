import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import mysql from 'mysql2/promise';

import {
  BUSINESS_RULES,
  DEFAULT_INCLUDED_TABLES,
  FEW_SHOT_EXAMPLES,
  TABLE_ALIASES,
} from './constants.js';
import { calculateCost } from './pricing.js';
import { ensureCompiledSchema, filterSchema } from './schema-compiler.js';
import { loadSemanticLayerSync } from './semantic-layer.js';
import { validateSqlGuardrails } from './sql-guardrails.js';
import { escapeRegExp, uniqueStrings } from './utils.js';

function splitWords(value) {
  return String(value || '')
    .replace(/\b([A-Z]{2,})s\b/g, (match) => match.toLowerCase())
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'show',
  'list',
  'give',
  'get',
  'tell',
  'me',
  'we',
  'us',
  'our',
  'your',
  'their',
  'them',
  'this',
  'that',
  'these',
  'those',
  'by',
  'for',
  'to',
  'from',
  'in',
  'on',
  'at',
  'of',
  'with',
  'without',
]);

function singularTokenVariant(token) {
  if (token.length <= 3) {
    return token;
  }

  if (token.endsWith('ies') && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (
    token.endsWith('ches') ||
    token.endsWith('shes') ||
    token.endsWith('sses') ||
    token.endsWith('xes') ||
    token.endsWith('zes')
  ) {
    return token.slice(0, -2);
  }

  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) {
    return token.slice(0, -1);
  }

  return token;
}

// Expand a token into a small set of morphological variants so lexical matching
// generalizes across inflections (plurals, -ing/-ed/-er) without a heavyweight
// stemmer or embeddings. Both "ate -> e" restorations are included because
// suffix stripping alone turns "moved" into "mov" rather than "move".
export function tokenVariants(token) {
  const variants = new Set();
  // The original token and its singular form are kept even when short (real
  // words like "buy" or "tax"). Suffix-stripped stems, however, must be at
  // least 4 chars: stripping "-ing"/"-ed" from short words yields spurious
  // fragments (e.g. "bring" -> "bre") that could match unrelated tokens.
  const addExact = (value) => {
    if (value && value.length >= 3) {
      variants.add(value);
    }
  };
  const addStem = (value) => {
    if (value && value.length >= 4) {
      variants.add(value);
    }
  };

  addExact(token);
  addExact(singularTokenVariant(token));

  for (const base of [...variants]) {
    if (base.length > 4 && base.endsWith('ing')) {
      addStem(base.slice(0, -3));
      addStem(`${base.slice(0, -3)}e`);
    }
    if (base.length > 4 && base.endsWith('ed')) {
      addStem(base.slice(0, -2));
      addStem(base.slice(0, -1));
    }
    if (base.length > 4 && base.endsWith('ers')) {
      addStem(base.slice(0, -3));
      addStem(base.slice(0, -2));
    } else if (base.length > 4 && base.endsWith('er')) {
      addStem(base.slice(0, -2));
      addStem(base.slice(0, -1));
    }
  }

  return variants;
}

function buildVariantSet(tokens) {
  const variantSet = new Set();
  for (const token of tokens) {
    for (const variant of tokenVariants(token)) {
      variantSet.add(variant);
    }
  }
  return variantSet;
}

export function normalizeTokens(text) {
  const tokens = [];

  for (const token of splitWords(text)) {
    if (token.length <= 1 || STOPWORDS.has(token)) {
      continue;
    }

    tokens.push(token);
    const singular = singularTokenVariant(token);
    if (singular !== token && singular.length > 1 && !STOPWORDS.has(singular)) {
      tokens.push(singular);
    }
  }

  return [...new Set(tokens)];
}

const MONTHS = [
  ['january', 1, ['jan']],
  ['february', 2, ['feb']],
  ['march', 3, ['mar']],
  ['april', 4, ['apr']],
  ['may', 5, []],
  ['june', 6, ['jun']],
  ['july', 7, ['jul']],
  ['august', 8, ['aug']],
  ['september', 9, ['sep', 'sept']],
  ['october', 10, ['oct']],
  ['november', 11, ['nov']],
  ['december', 12, ['dec']],
];

const MONTH_TOKEN_TO_INFO = new Map(
  MONTHS.flatMap(([name, month, aliases]) => [[name, { name, month }], ...aliases.map((alias) => [alias, { name, month }])])
);

const MONTH_PATTERN = new RegExp(
  `\\b(${[...MONTH_TOKEN_TO_INFO.keys()]
    .sort((left, right) => right.length - left.length)
    .join('|')})\\.?(\\s*,\\s*|\\s+)(\\d{2,4})\\b`,
  'gi'
);

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function normalizeYearToken(yearToken, separator = '') {
  const numericYear = Number(yearToken);
  if (!Number.isInteger(numericYear)) {
    return null;
  }

  if (yearToken.length === 4) {
    return numericYear;
  }

  if (yearToken.length === 2) {
    if (!separator.includes(',')) {
      return null;
    }

    return numericYear <= 69 ? 2000 + numericYear : 1900 + numericYear;
  }

  return null;
}

function buildMonthRange(year, month) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return {
    startDate: `${year}-${padNumber(month)}-01`,
    endExclusive: `${nextYear}-${padNumber(nextMonth)}-01`,
  };
}

export function extractTemporalReferences(question) {
  const temporalReferences = [];
  const text = String(question || '');

  for (const match of text.matchAll(MONTH_PATTERN)) {
    const monthToken = String(match[1] || '').toLowerCase();
    const separator = String(match[2] || '');
    const monthInfo = MONTH_TOKEN_TO_INFO.get(monthToken);
    const year = normalizeYearToken(String(match[3] || ''), separator);

    if (!monthInfo || !year) {
      continue;
    }

    const { startDate, endExclusive } = buildMonthRange(year, monthInfo.month);
    temporalReferences.push({
      kind: 'month',
      originalText: match[0],
      normalizedText: `${monthInfo.name[0].toUpperCase()}${monthInfo.name.slice(1)} ${year}`,
      month: monthInfo.month,
      monthName: `${monthInfo.name[0].toUpperCase()}${monthInfo.name.slice(1)}`,
      year,
      startDate,
      endExclusive,
      startIndex: match.index ?? null,
    });
  }

  return temporalReferences;
}

function normalizeQuestionTemporalText(question, temporalReferences) {
  if (!Array.isArray(temporalReferences) || temporalReferences.length === 0) {
    return String(question || '');
  }

  let normalized = String(question || '');
  for (const reference of temporalReferences) {
    normalized = normalized.replaceAll(reference.originalText, reference.normalizedText);
  }

  return normalized;
}

export function buildQuestionContext(question) {
  const originalQuestion = String(question || '');
  const temporalReferences = extractTemporalReferences(originalQuestion);
  const normalizedQuestion = normalizeQuestionTemporalText(originalQuestion, temporalReferences);

  return {
    originalQuestion,
    normalizedQuestion,
    questionTokens: normalizeTokens(normalizedQuestion),
    temporalReferences,
  };
}

function findMatchedSynonyms(entry, questionContext) {
  const normalizedQuestionText = splitWords(questionContext.normalizedQuestion).join(' ');
  const questionTokenSet = new Set(questionContext.questionTokens);
  const questionVariantSet = buildVariantSet(questionContext.questionTokens);
  const synonyms = uniqueStrings([entry.name, ...(entry.synonyms || [])]);
  const matched = [];

  for (const synonym of synonyms) {
    const synonymTokens = normalizeTokens(synonym);
    if (synonymTokens.length === 0) {
      continue;
    }

    const normalizedSynonymText = splitWords(synonym).join(' ');
    const phraseMatched =
      normalizedSynonymText.length > 0 &&
      new RegExp(`(^|\\s)${escapeRegExp(normalizedSynonymText)}(\\s|$)`, 'i').test(normalizedQuestionText);
    const tokenMatched = synonymTokens.every((token) => questionTokenSet.has(token));
    // Morphological fallback: every synonym token must share a stem/inflection
    // variant with some question token. This only ever adds matches the exact
    // and singularized passes missed (e.g. "biggest buyers" -> "buyer").
    const stemMatched =
      !tokenMatched &&
      synonymTokens.every((token) => {
        for (const variant of tokenVariants(token)) {
          if (questionVariantSet.has(variant)) {
            return true;
          }
        }
        return false;
      });

    if (phraseMatched || tokenMatched || stemMatched) {
      matched.push(synonym);
    }
  }

  return matched;
}

function semanticMatchScore(matchedSynonyms) {
  return matchedSynonyms.reduce((score, synonym) => score + Math.max(1, normalizeTokens(synonym).length), 0);
}

function summarizeSemanticEntry(entry, matchedSynonyms) {
  return {
    name: entry.name,
    matchedSynonyms,
    preferredTables: entry.preferred_tables || [],
    displayColumns: entry.display_columns || [],
    preferredColumns: entry.preferred_columns || [],
    preferredExpression: entry.preferred_expression || null,
    defaultFilters: entry.default_filters || [],
    notes: entry.notes || [],
    score: semanticMatchScore(matchedSynonyms),
  };
}

function summarizeFilterHint(filterHint, matchedSynonyms) {
  return {
    name: filterHint.name,
    matchedValues: matchedSynonyms,
    targetTable: filterHint.target_table || null,
    targetColumns: filterHint.target_columns || [],
    operator: filterHint.operator || null,
    notes: filterHint.notes || [],
    score: semanticMatchScore(matchedSynonyms),
  };
}

function buildFilterHintMatchEntry(filterHint, semanticLayer) {
  const baseSynonyms = uniqueStrings(filterHint.synonyms || []);
  const baseSynonymSet = new Set(baseSynonyms.map((value) => splitWords(value).join(' ')));
  const filterColumns = new Set(filterHint.target_columns || []);
  const aliasValues = (semanticLayer.value_aliases || [])
    .filter((alias) => {
      if (filterHint.target_table === 'Product' && alias.entity === 'product') {
        return true;
      }

      return (alias.target_columns || []).some((column) => filterColumns.has(column));
    })
    .flatMap((alias) => [alias.canonical_value, ...(alias.aliases || [])]);
  const aliasOnlyValues = aliasValues.filter((value) => !baseSynonymSet.has(splitWords(value).join(' ')));

  return {
    ...filterHint,
    synonyms: uniqueStrings([...baseSynonyms, ...aliasValues]),
    aliasOnlyValues: uniqueStrings(aliasOnlyValues),
  };
}

function removeSubsumedAliasMatches(matchedSynonyms, aliasOnlyValues) {
  const aliasOnlySet = new Set((aliasOnlyValues || []).map((value) => splitWords(value).join(' ')));
  const matchedTokenSets = matchedSynonyms.map((value) => ({
    value,
    normalized: splitWords(value).join(' '),
    tokens: splitWords(value),
  }));

  return matchedTokenSets
    .filter((entry) => {
      if (!aliasOnlySet.has(entry.normalized)) {
        return true;
      }

      return !matchedTokenSets.some(
        (other) =>
          other.normalized !== entry.normalized &&
          other.tokens.length > entry.tokens.length &&
          entry.tokens.every((token) => other.tokens.includes(token))
      );
    })
    .map((entry) => entry.value);
}

const PRODUCT_CONTEXT_ENTITY_NAMES = new Set(['product', 'brand', 'product_category', 'campaign']);
const PRODUCT_CONTEXT_FILTER_TABLES = new Set(['Product', 'Brand', 'ProductBrand', 'ProductCategory', 'Campaign']);

function addDerivedMetrics(metrics, semanticLayer) {
  const derivedMetrics = [...metrics];
  const metricNames = new Set(derivedMetrics.map((metric) => metric.name));
  const hasGeneralSalesMetric = metricNames.has('net_sales');

  if (hasGeneralSalesMetric && !metricNames.has('line_net_sales')) {
    const lineMetric = (semanticLayer.metrics || []).find((metric) => metric.name === 'line_net_sales');
    if (lineMetric) {
      derivedMetrics.push(
        summarizeSemanticEntry(lineMetric, ['sales with product filter context'])
      );
    }
  }

  return derivedMetrics;
}

function findSemanticJoinHints(joinPaths, requiredTables) {
  const required = new Set(requiredTables);

  return (Array.isArray(joinPaths) ? joinPaths : [])
    .filter((joinPath) => joinPath.tables.every((tableName) => required.has(tableName)))
    .map((joinPath) => ({
      name: joinPath.name,
      tables: joinPath.tables,
      joinSql: joinPath.join_sql,
    }));
}

function findMatchedClarificationRules(clarificationRules, questionContext) {
  return (Array.isArray(clarificationRules) ? clarificationRules : [])
    .map((rule) => ({
      trigger: String(rule?.trigger || '').trim(),
      questions: uniqueStrings(rule?.questions),
    }))
    .filter((rule) => rule.trigger && rule.questions.length > 0)
    .map((rule) => ({
      ...rule,
      matchedTriggers: findMatchedSynonyms({ name: rule.trigger, synonyms: [rule.trigger] }, questionContext),
    }))
    .filter((rule) => rule.matchedTriggers.length > 0);
}

export function buildSemanticPlan(question, { questionContext = null, semanticLayer = loadSemanticLayerSync() } = {}) {
  const context = questionContext || buildQuestionContext(question);
  const entities = (semanticLayer.entities || [])
    .map((entry) => [entry, findMatchedSynonyms(entry, context)])
    .filter(([, matchedSynonyms]) => matchedSynonyms.length > 0)
    .map(([entry, matchedSynonyms]) => summarizeSemanticEntry(entry, matchedSynonyms));
  let metrics = (semanticLayer.metrics || [])
    .map((entry) => [entry, findMatchedSynonyms(entry, context)])
    .filter(([, matchedSynonyms]) => matchedSynonyms.length > 0)
    .map(([entry, matchedSynonyms]) => summarizeSemanticEntry(entry, matchedSynonyms));
  const filterHints = (semanticLayer.filter_hints || [])
    .map((entry) => {
      const matchEntry = buildFilterHintMatchEntry(entry, semanticLayer);
      return [entry, removeSubsumedAliasMatches(findMatchedSynonyms(matchEntry, context), matchEntry.aliasOnlyValues)];
    })
    .filter(([, matchedSynonyms]) => matchedSynonyms.length > 0)
    .map(([entry, matchedSynonyms]) => summarizeFilterHint(entry, matchedSynonyms));
  const hasProductContext =
    entities.some((entry) => PRODUCT_CONTEXT_ENTITY_NAMES.has(entry.name)) ||
    filterHints.some((entry) => PRODUCT_CONTEXT_FILTER_TABLES.has(entry.targetTable));
  if (hasProductContext) {
    metrics = addDerivedMetrics(metrics, semanticLayer);
  }

  const requiredTables = uniqueStrings([
    ...entities.flatMap((entry) => entry.preferredTables),
    ...metrics.flatMap((entry) => entry.preferredTables),
    ...filterHints.map((entry) => entry.targetTable).filter(Boolean),
  ]);
  const preferredColumns = uniqueStrings([
    ...entities.flatMap((entry) => entry.displayColumns),
    ...metrics.flatMap((entry) => entry.preferredColumns),
    ...filterHints.flatMap((entry) => entry.targetColumns),
  ]);
  const defaultFilters = uniqueStrings([
    ...entities.flatMap((entry) => entry.defaultFilters),
  ]);

  return {
    version: semanticLayer.version ?? null,
    entities,
    metrics,
    filterHints,
    requiredTables,
    preferredColumns,
    defaultFilters,
    clarificationRules: findMatchedClarificationRules(semanticLayer.clarification_rules || [], context),
    joinHints: findSemanticJoinHints(semanticLayer.join_paths || [], requiredTables),
  };
}

function buildSemanticTableBoosts(semanticPlan) {
  const boosts = new Map();
  const addBoost = (tableName, score, reason, sourceName) => {
    if (!tableName) {
      return;
    }

    const current = boosts.get(tableName) || { score: 0, matches: [] };
    current.score += score;
    current.matches.push({ reason, sourceName, score });
    boosts.set(tableName, current);
  };

  for (const entity of semanticPlan.entities || []) {
    for (const tableName of entity.preferredTables || []) {
      addBoost(tableName, 60 + entity.score * 4, 'semantic_entity', entity.name);
    }
  }

  for (const metric of semanticPlan.metrics || []) {
    for (const tableName of metric.preferredTables || []) {
      addBoost(tableName, 80 + metric.score * 5, 'semantic_metric', metric.name);
    }
  }

  for (const filterHint of semanticPlan.filterHints || []) {
    addBoost(filterHint.targetTable, 70 + filterHint.score * 5, 'semantic_filter_hint', filterHint.name);
  }

  for (const joinHint of semanticPlan.joinHints || []) {
    for (const tableName of joinHint.tables || []) {
      addBoost(tableName, 20, 'semantic_join_hint', joinHint.name);
    }
  }

  return boosts;
}

function scoreColumn(column, questionTokens) {
  let score = 0;
  const nameTokens = normalizeTokens(column.name);
  const commentTokens = normalizeTokens(column.comment || '');

  if (column.primaryKey) {
    score += 100;
  }

  if (column.references) {
    score += 80;
  }

  if (/(date|time|name|code|type|status|qty|quantity|price|amount|total|net|paid|balance|tax|gst|discount|credit|debit|location|customer|item|account|address|email|phone|active|cancel)/i.test(column.name)) {
    score += 25;
  }

  for (const token of questionTokens) {
    if (nameTokens.includes(token)) {
      score += 35;
    }
    if (commentTokens.includes(token)) {
      score += 20;
    }
  }

  return score;
}

function buildTableIndex(table) {
  return {
    nameTokens: normalizeTokens(table.name),
    descriptionTokens: normalizeTokens(table.description || ''),
    aliasTokens: normalizeTokens((TABLE_ALIASES[table.name] || []).join(' ')),
    columnNameTokens: normalizeTokens(table.columns.map((column) => column.name).join(' ')),
    columnCommentTokens: normalizeTokens(table.columns.map((column) => column.comment || '').join(' ')),
  };
}

export function scoreTableDetailed(table, questionTokens) {
  const index = buildTableIndex(table);
  let score = 0;
  const matches = [];

  for (const token of questionTokens) {
    let tokenScore = 0;
    const reasons = [];

    if (index.nameTokens.includes(token)) {
      tokenScore += 30;
      reasons.push('table_name');
    }
    if (index.aliasTokens.includes(token)) {
      tokenScore += 28;
      reasons.push('table_alias');
    }
    if (index.descriptionTokens.includes(token)) {
      tokenScore += 18;
      reasons.push('table_description');
    }
    if (index.columnNameTokens.includes(token)) {
      tokenScore += 10;
      reasons.push('column_name');
    }
    if (index.columnCommentTokens.includes(token)) {
      tokenScore += 6;
      reasons.push('column_comment');
    }

    if (tokenScore > 0) {
      matches.push({
        token,
        score: tokenScore,
        reasons,
      });
      score += tokenScore;
    }
  }

  return {
    score,
    matches,
  };
}

function scoreTable(table, questionTokens) {
  return scoreTableDetailed(table, questionTokens).score;
}

function getImportantColumns(table, questionTokens, limit = 24) {
  const scored = table.columns
    .map((column) => ({
      column,
      score: scoreColumn(column, questionTokens),
    }))
    .sort((left, right) => right.score - left.score || left.column.name.localeCompare(right.column.name));

  const selected = [];
  const seen = new Set();

  for (const entry of scored) {
    if (selected.length >= limit) {
      break;
    }

    if (entry.score <= 0 && selected.length >= 12) {
      break;
    }

    if (!seen.has(entry.column.name)) {
      selected.push(entry.column);
      seen.add(entry.column.name);
    }
  }

  for (const column of table.columns) {
    if (selected.length >= limit) {
      break;
    }

    if (!seen.has(column.name) && (column.primaryKey || column.references)) {
      selected.push(column);
      seen.add(column.name);
    }
  }

  return selected;
}

function formatColumn(column) {
  const parts = [column.name, column.type].filter(Boolean);

  if (column.primaryKey) {
    parts.push('PK');
  }
  if (column.references) {
    parts.push(`FK -> ${column.references.model}.${column.references.key}`);
  }
  if (column.allowNull === false) {
    parts.push('NOT NULL');
  }
  if (column.comment) {
    parts.push(`comment: ${column.comment}`);
  }

  return `- ${parts.join(' | ')}`;
}

function formatColumnNameChunks(columns, chunkSize = 12) {
  const lines = [];

  for (let index = 0; index < columns.length; index += chunkSize) {
    lines.push(`- ${columns.slice(index, index + chunkSize).map((column) => column.name).join(', ')}`);
  }

  return lines;
}

function summarizeColumn(column) {
  return {
    name: column.name,
    type: column.type || null,
    primaryKey: Boolean(column.primaryKey),
    allowNull: column.allowNull ?? null,
    comment: column.comment || null,
    references: column.references
      ? {
          model: column.references.model,
          key: column.references.key,
        }
      : null,
  };
}

function buildRelationshipSummary(tables) {
  const relationships = [];

  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      relationships.push({
        fromTable: table.tableName,
        fromColumn: foreignKey.column,
        toTable: foreignKey.references.model,
        toColumn: foreignKey.references.key,
      });
    }
  }

  return relationships;
}

function formatRelationships(relationships) {
  return relationships.length > 0
    ? relationships
        .map((relationship) => `- ${relationship.fromTable}.${relationship.fromColumn} -> ${relationship.toTable}.${relationship.toColumn}`)
        .join('\n')
    : '- No in-scope foreign keys';
}

function buildTableContextSummary(table, questionTokens) {
  const columns = getImportantColumns(table, questionTokens);
  const selectedNames = new Set(columns.map((column) => column.name));
  const omittedColumns = table.columns.filter((column) => !selectedNames.has(column.name));
  const lines = [
    `Table ${table.tableName}`,
    table.description ? `Description: ${table.description}` : null,
    'Columns:',
    ...columns.map(formatColumn),
    omittedColumns.length > 0 ? 'Other available columns (names only):' : null,
    ...formatColumnNameChunks(omittedColumns),
  ].filter(Boolean);

  return {
    name: table.name,
    tableName: table.tableName,
    file: table.file || null,
    description: table.description || null,
    totalColumnCount: table.columns.length,
    includedColumns: columns.map(summarizeColumn),
    omittedColumnNames: omittedColumns.map((column) => column.name),
    text: lines.join('\n'),
  };
}

function buildPromptContext(tables, questionTokens) {
  const tableContexts = tables.map((table) => buildTableContextSummary(table, questionTokens));
  const relationships = buildRelationshipSummary(tables);

  return {
    questionTokens,
    allowedTables: tables.map((table) => table.tableName),
    relationships,
    relationshipText: formatRelationships(relationships),
    tables: tableContexts.map(({ text, ...tableContext }) => tableContext),
    tableBlocks: tableContexts.map((tableContext) => tableContext.text).join('\n\n'),
  };
}

function buildForeignKeyGraph(tables) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const adjacency = new Map(tables.map((table) => [table.name, new Set()]));

  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      const targetName = foreignKey.references.model;
      if (!byName.has(targetName)) {
        continue;
      }

      adjacency.get(table.name).add(targetName);
      adjacency.get(targetName).add(table.name);
    }
  }

  return {
    byName,
    adjacency,
  };
}

function findShortestJoinPath(adjacency, start, goal, maxDepth = 3) {
  if (start === goal) {
    return [start];
  }

  const queue = [{ name: start, path: [start], depth: 0 }];
  const visited = new Set([start]);

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = [...(adjacency.get(current.name) || [])].sort();

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        continue;
      }

      const nextPath = [...current.path, neighbor];
      if (neighbor === goal) {
        return nextPath;
      }

      if (current.depth + 1 < maxDepth) {
        visited.add(neighbor);
        queue.push({
          name: neighbor,
          path: nextPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  return null;
}

function expandTablesForJoinPaths(tables, selectedNames, maxJoinPathHops = 3) {
  if (!Array.isArray(selectedNames) || selectedNames.length <= 1) {
    return {
      tables: tables.filter((table) => selectedNames.includes(table.name)),
      connectorTableNames: [],
    };
  }

  const { adjacency } = buildForeignKeyGraph(tables);
  const selectedSet = new Set(selectedNames);
  const expanded = new Set(selectedNames);
  const connectorTableNames = new Set();

  for (let leftIndex = 0; leftIndex < selectedNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectedNames.length; rightIndex += 1) {
      const path = findShortestJoinPath(
        adjacency,
        selectedNames[leftIndex],
        selectedNames[rightIndex],
        maxJoinPathHops
      );
      if (!path) {
        continue;
      }

      for (const pathTableName of path) {
        expanded.add(pathTableName);
        if (!selectedSet.has(pathTableName)) {
          connectorTableNames.add(pathTableName);
        }
      }
    }
  }

  return {
    tables: tables.filter((table) => expanded.has(table.name)),
    connectorTableNames: [...connectorTableNames].map((name) => tables.find((table) => table.name === name)?.tableName || name),
  };
}

export function retrieveRelevantTables(
  schema,
  question,
  { maxTables = 4, maxJoinPathHops = 3, questionContext = null, semanticPlan = null } = {}
) {
  const resolvedQuestionContext = questionContext || buildQuestionContext(question);
  const { questionTokens } = resolvedQuestionContext;
  const resolvedSemanticPlan = semanticPlan || buildSemanticPlan(question, { questionContext: resolvedQuestionContext });
  const semanticBoosts = buildSemanticTableBoosts(resolvedSemanticPlan);
  const scored = schema.tables
    .map((table) => {
      const lexicalScore = scoreTable(table, questionTokens);
      const semanticBoost = semanticBoosts.get(table.tableName) || semanticBoosts.get(table.name) || { score: 0, matches: [] };

      return {
        table,
        lexicalScore,
        semanticScore: semanticBoost.score,
        semanticMatches: semanticBoost.matches,
        score: lexicalScore + semanticBoost.score,
      };
    })
    .sort((left, right) => right.score - left.score || left.table.name.localeCompare(right.table.name));

  const topSelected = scored
    .filter((entry) => entry.score > 0)
    .slice(0, maxTables)
    .map((entry) => entry.table.name);

  // Tables a matched entity/metric/filter explicitly requires (e.g. SalesDocumentLine
  // for line_net_sales) must survive the score cap, otherwise a strong entity like
  // "brand" can crowd out the line-level table the metric actually needs and the SQL
  // gets rejected as out-of-scope. Appended in score order after the top-N.
  const requiredTableNames = new Set(resolvedSemanticPlan.requiredTables || []);
  const requiredSelected = scored
    .filter((entry) => requiredTableNames.has(entry.table.name) && !topSelected.includes(entry.table.name))
    .map((entry) => entry.table.name);
  const selected = uniqueStrings([...topSelected, ...requiredSelected]);

  const baseSelected =
    selected.length > 0
      ? selected
      : schema.tables.slice(0, Math.min(maxTables, schema.tables.length)).map((table) => table.name);

  const expanded = expandTablesForJoinPaths(schema.tables, baseSelected, maxJoinPathHops);
  const tables = expanded.tables;

  return {
    normalizedQuestion: resolvedQuestionContext.normalizedQuestion,
    questionTokens,
    temporalReferences: resolvedQuestionContext.temporalReferences,
    tables,
    initialTableNames: baseSelected,
    expandedTableNames: tables.map((table) => table.tableName),
    connectorTableNames: expanded.connectorTableNames,
    fallbackToDefaultSelection: selected.length === 0,
    semanticPlan: resolvedSemanticPlan,
    tableScores: scored.map((entry) => ({
      name: entry.table.name,
      tableName: entry.table.tableName,
      score: entry.score,
      lexicalScore: entry.lexicalScore,
      semanticScore: entry.semanticScore,
      semanticMatches: entry.semanticMatches,
    })),
  };
}

// Keywords that end a FROM table-list. A JOIN/STRAIGHT_JOIN starts a fresh table
// reference (captured by the keyword regex below); the rest close the FROM clause.
const FROM_LIST_TERMINATOR =
  /^(?:WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|WINDOW|FOR|INTO|ON|USING|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|STRAIGHT_JOIN)$/i;

// Tables in a comma-separated FROM list (`FROM a, b, c`). The keyword regex only
// sees the table immediately after FROM/JOIN, so without this a comma-joined
// table would slip the allowed-table check entirely (a real, if grant-contained,
// guardrail bypass). Walk each FROM clause depth-aware — so subquery and
// SELECT-list commas are ignored — and take the leading identifier of every
// top-level comma segment. Erring toward over-extraction is safe: an extra
// candidate that is not in the allow-set just triggers a fail-closed rejection.
function extractFromListTables(sql) {
  const tables = [];
  const isWord = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);
  const pushLeading = (start, end) => {
    const match = sql.slice(start, end).match(/^\s*`?([A-Za-z][A-Za-z0-9_]*)`?/);
    if (match) {
      tables.push(match[1]);
    }
  };

  const fromRegex = /\bFROM\b/gi;
  let from;
  while ((from = fromRegex.exec(sql)) !== null) {
    let depth = 0;
    let segmentStart = fromRegex.lastIndex;
    let i = segmentStart;

    while (i < sql.length) {
      const char = sql[i];
      if (char === '(') {
        depth += 1;
        i += 1;
        continue;
      }
      if (char === ')') {
        if (depth === 0) {
          break; // closing paren of an enclosing subquery — FROM list ends here
        }
        depth -= 1;
        i += 1;
        continue;
      }
      if (depth === 0 && char === ',') {
        pushLeading(segmentStart, i);
        segmentStart = i + 1;
        i += 1;
        continue;
      }
      if (depth === 0 && /[A-Za-z_]/.test(char) && !isWord(sql[i - 1])) {
        let end = i + 1;
        while (end < sql.length && isWord(sql[end])) {
          end += 1;
        }
        if (FROM_LIST_TERMINATOR.test(sql.slice(i, end))) {
          break;
        }
        i = end; // skip the rest of this identifier (a table name or alias)
        continue;
      }
      i += 1;
    }

    pushLeading(segmentStart, i);
  }

  return tables;
}

export function extractTablesFromSql(sql, { alreadyCleaned = false } = {}) {
  const normalizedSql = alreadyCleaned ? String(sql || '') : cleanModelOutput(sql);
  const tables = [];

  // FROM / JOIN / STRAIGHT_JOIN each introduce a table. STRAIGHT_JOIN must be
  // matched explicitly: `\bJOIN` does not match inside STRAIGHT_JOIN because the
  // preceding underscore is a word character, so there is no word boundary.
  const keywordRegex = /\b(?:FROM|STRAIGHT_JOIN|JOIN)\s+`?([A-Za-z][A-Za-z0-9_]*)`?/gi;
  let match;
  while ((match = keywordRegex.exec(normalizedSql)) !== null) {
    tables.push(match[1]);
  }

  // Add the 2nd+ tables of any comma-separated FROM list.
  for (const table of extractFromListTables(normalizedSql)) {
    tables.push(table);
  }

  return [...new Set(tables)];
}

function scoreExample(example, questionTokens) {
  const exampleTokens = normalizeTokens(example.question);
  const matchedTokens = questionTokens.filter((token) => exampleTokens.includes(token));
  return {
    score: matchedTokens.length,
    matchedTokens,
  };
}

export function retrieveRelevantExamples(question, { maxExamples = 2, minScore = 1 } = {}) {
  const questionTokens = buildQuestionContext(question).questionTokens;

  return FEW_SHOT_EXAMPLES.map((example) => {
    const scored = scoreExample(example, questionTokens);
    return {
      ...example,
      tables: Array.isArray(example.tables) ? example.tables : extractTablesFromSql(example.sql),
      score: scored.score,
      matchedTokens: scored.matchedTokens,
    };
  })
    .filter((example) => example.score >= minScore)
    .sort((left, right) => right.score - left.score || left.question.localeCompare(right.question))
    .slice(0, maxExamples);
}

function formatExamples(examples) {
  if (!examples || examples.length === 0) {
    return 'No closely matched examples were selected for this question.';
  }

  return examples
    .map(
      (example, index) =>
        `Example ${index + 1}:\nQ: ${example.question}\nTables: ${example.tables.join(', ')}\nSQL:\n${example.sql}`
    )
    .join('\n\n');
}

function formatTemporalReferences(temporalReferences) {
  if (!Array.isArray(temporalReferences) || temporalReferences.length === 0) {
    return '- No explicit temporal references were resolved.';
  }

  return temporalReferences
    .map(
      (reference) =>
        `- "${reference.originalText}" => ${reference.normalizedText}; if the query needs a date filter, use the appropriate in-scope date column with a half-open range like date_col >= '${reference.startDate}' AND date_col < '${reference.endExclusive}'`
    )
    .join('\n');
}

function formatSemanticHints(semanticPlan) {
  if (
    !semanticPlan ||
    ((semanticPlan.entities || []).length === 0 &&
      (semanticPlan.metrics || []).length === 0 &&
      (semanticPlan.filterHints || []).length === 0)
  ) {
    return '- No semantic hints matched this question.';
  }

  const lines = [];

  for (const entity of semanticPlan.entities || []) {
    lines.push(
      `- Entity "${entity.name}" matched ${entity.matchedSynonyms.join(', ')}; prefer tables ${entity.preferredTables.join(', ') || 'none'}${
        entity.displayColumns.length > 0 ? ` and display columns ${entity.displayColumns.join(', ')}` : ''
      }${
        entity.defaultFilters.length > 0 ? `; apply default filters ${entity.defaultFilters.join(' AND ')}` : ''
      }.`
    );
  }

  for (const metric of semanticPlan.metrics || []) {
    lines.push(
      `- Metric "${metric.name}" matched ${metric.matchedSynonyms.join(', ')}; prefer ${metric.preferredExpression || 'the most direct matching expression'}${
        metric.preferredTables.length > 0 ? ` using tables ${metric.preferredTables.join(', ')}` : ''
      }.`
    );
  }

  for (const filterHint of semanticPlan.filterHints || []) {
    lines.push(
      `- Filter hint "${filterHint.name}" matched ${filterHint.matchedValues.join(', ')}; apply these as alternatives with ${
        filterHint.operator || 'OR'
      } against ${filterHint.targetColumns.join(', ') || filterHint.targetTable}.`
    );
  }

  for (const joinHint of semanticPlan.joinHints || []) {
    lines.push(`- Semantic join "${joinHint.name}": ${joinHint.joinSql}.`);
  }

  for (const rule of semanticPlan.clarificationRules || []) {
    lines.push(
      `- Clarification rule "${rule.trigger}" matched ${rule.matchedTriggers.join(', ')}; if the request remains ambiguous, ask: ${rule.questions.join(' / ')}`
    );
  }

  return lines.join('\n');
}

function formatMasterDataCandidates(masterDataCandidates) {
  const groups = Array.isArray(masterDataCandidates) ? masterDataCandidates : [];
  if (groups.length === 0) {
    return '- No master-data candidates were resolved for this question.';
  }

  const lines = [
    '- Use resolved master-data IDs for filters when the candidates clearly match the user request.',
    '- Do not invent IDs or names beyond the candidate lists below.',
  ];

  for (const group of groups) {
    lines.push(`- Entity "${group.entity}" searched columns: ${(group.searchColumns || []).join(', ') || 'unknown'}.`);
    for (const term of group.terms || []) {
      lines.push(
        `  - Term "${term.term}" expanded to ${term.expandedTerms.join(', ') || term.term}; top candidates:`
      );
      if (!term.candidates || term.candidates.length === 0) {
        lines.push('    - none');
        continue;
      }

      for (const candidate of term.candidates.slice(0, 8)) {
        lines.push(
          `    - ProductId ${candidate.ProductId}; ProductCode ${candidate.ProductCode || 'null'}; ProductName ${candidate.ProductName || 'null'}; score ${candidate.score}; matched ${candidate.matchedValue || 'n/a'} (${candidate.matchType || 'n/a'})`
        );
      }
    }
  }

  return lines.join('\n');
}

const EXACT_SCHEMA_GUARD =
  'IMPORTANT: Use only exact table and column names that appear in the schema context below. Detailed column entries are a ranked subset; you may use another column only when its exact name appears in an "Other available columns" list. Do NOT invent or infer names that are not shown.';

function estimatePromptTokens(text) {
  const length = String(text || '').length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

export function buildBasicPrompt(schema, question) {
  const questionContext = buildQuestionContext(question);
  const context = buildPromptContext(schema.tables, questionContext.questionTokens);

  return {
    system: `You are a senior SQL analyst writing MariaDB 10.6 SQL.

Write one read-only SQL query that answers the user's question.
Return ONLY the SQL query.
${EXACT_SCHEMA_GUARD}

Resolved temporal references:
${formatTemporalReferences(questionContext.temporalReferences)}

Allowed tables:
${context.allowedTables.map((tableName) => `- ${tableName}`).join('\n')}

Relationships:
${context.relationshipText}

Schema context:
${context.tableBlocks}`,
    user: question,
    context: {
      ...context,
      normalizedQuestion: questionContext.normalizedQuestion,
      temporalReferences: questionContext.temporalReferences,
    },
  };
}

function buildOptimizedSystemPrompt() {
  const rules = BUSINESS_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');

  return `You are a senior SQL analyst writing MariaDB 10.6 SQL for a retail/distribution demo system.

Write one read-only SQL query using only the provided schema context.
Use only in-scope foreign keys and in-scope tables.
${EXACT_SCHEMA_GUARD}

The user message is arranged for prompt caching:
1. In-scope schema context comes first and may be reused across questions with the same retrieved tables.
2. Question-specific context comes after the schema context.
3. The final answer must still answer only the user's current question.

Business rules:
${rules}

Return ONLY a JSON object with this shape:
{
  "sql": "SELECT ...",
  "explanation": "short explanation",
  "tables_used": ["TableA", "TableB"],
  "assumptions": ["any explicit assumption"]
}`;
}

function buildOptimizedSchemaContext(context) {
  return `In-scope schema context:

Allowed tables:
${context.allowedTables.map((tableName) => `- ${tableName}`).join('\n')}

In-scope relationships:
${context.relationshipText}

In-scope schema:
${context.tableBlocks}`;
}

function buildOptimizedQuestionContext({ question, retrieval, rankedContext, masterDataCandidates, examples }) {
  return `Question-specific context:

Question:
${question}

Resolved temporal references:
${formatTemporalReferences(retrieval.temporalReferences)}

Semantic retrieval hints:
${formatSemanticHints(retrieval.semanticPlan)}

Resolved master-data candidates:
${formatMasterDataCandidates(masterDataCandidates)}

Question-ranked schema details:
${rankedContext.tableBlocks}

Few-shot examples:
${examples}`;
}

function buildLegacyOptimizedCacheablePrefix() {
  return `You are a senior SQL analyst writing MariaDB 10.6 SQL for a retail/distribution demo system.

Write one read-only SQL query using only the provided schema context.
Use only in-scope foreign keys and in-scope tables.
${EXACT_SCHEMA_GUARD}

`;
}

function summarizePromptCacheLayout({ system, schemaContext, questionContext }) {
  const staticSystemChars = system.length;
  const schemaPrefixChars = system.length + schemaContext.length;
  const dynamicChars = questionContext.length;
  const totalChars = system.length + schemaContext.length + questionContext.length;
  const legacyCacheablePrefix = buildLegacyOptimizedCacheablePrefix();
  const legacyCacheablePrefixChars = legacyCacheablePrefix.length;
  const systemEstimatedTokens = estimatePromptTokens(system);
  const schemaEstimatedTokens = estimatePromptTokens(schemaContext);
  const questionEstimatedTokens = estimatePromptTokens(questionContext);
  const legacyCacheablePrefixEstimatedTokens = estimatePromptTokens(legacyCacheablePrefix);

  return {
    strategy: 'static-system-and-schema-prefix',
    messageLayout: [
      { role: 'system', cacheBehavior: 'globally_stable_instructions' },
      { role: 'user', cacheBehavior: 'table_stable_schema_prefix_then_question_context' },
    ],
    staticSystemChars,
    staticSystemEstimatedTokens: systemEstimatedTokens,
    cacheablePrefixChars: schemaPrefixChars,
    cacheablePrefixEstimatedTokens: systemEstimatedTokens + schemaEstimatedTokens,
    dynamicChars,
    dynamicEstimatedTokens: questionEstimatedTokens,
    totalChars,
    totalEstimatedTokens: systemEstimatedTokens + schemaEstimatedTokens + questionEstimatedTokens,
    legacyCacheablePrefixChars,
    legacyCacheablePrefixEstimatedTokens,
    additionalCacheablePrefixEstimatedTokens:
      systemEstimatedTokens + schemaEstimatedTokens - legacyCacheablePrefixEstimatedTokens,
  };
}

export function buildOptimizedPrompt(schema, question, { masterDataCandidates = [], semanticPlan = null } = {}) {
  const retrieval = retrieveRelevantTables(schema, question, { semanticPlan });
  const context = buildPromptContext(retrieval.tables, retrieval.questionTokens);
  const stableContext = buildPromptContext(retrieval.tables, []);
  const relevantExamples = retrieveRelevantExamples(question, {
    maxExamples: 2,
    minScore: 1,
  });
  const examples = formatExamples(relevantExamples);
  const system = buildOptimizedSystemPrompt();
  const schemaContext = buildOptimizedSchemaContext(stableContext);
  const questionContext = buildOptimizedQuestionContext({
    question,
    retrieval,
    rankedContext: context,
    masterDataCandidates,
    examples,
  });
  const promptCache = summarizePromptCacheLayout({
    system,
    schemaContext,
    questionContext,
  });

  return {
    system,
    user: `${schemaContext}\n\n${questionContext}`,
    tables: retrieval.tables,
    context: {
      ...context,
      normalizedQuestion: retrieval.normalizedQuestion,
      temporalReferences: retrieval.temporalReferences,
      retrieval: {
        initialTableNames: retrieval.initialTableNames,
        expandedTableNames: retrieval.expandedTableNames,
        connectorTableNames: retrieval.connectorTableNames,
        fallbackToDefaultSelection: retrieval.fallbackToDefaultSelection,
        tableScores: retrieval.tableScores,
      },
      semanticPlan: retrieval.semanticPlan,
      masterDataCandidates,
      promptCache,
      examples: relevantExamples.map((example) => ({
        question: example.question,
        tables: example.tables,
        score: example.score,
        matchedTokens: example.matchedTokens,
      })),
    },
  };
}

export function cleanModelOutput(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json|sql)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        return part?.text || '';
      })
      .join('');
  }

  return '';
}

export const BASIC_MODEL_REQUEST_OPTIONS = {
  temperature: 0,
  max_completion_tokens: 1200,
};

export async function generateBasicSql({ client, model, prompt }) {
  const request = {
    model,
    ...BASIC_MODEL_REQUEST_OPTIONS,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };
  const tracedRequest = {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
  };

  const response = await client.chat.completions.create(request);
  const rawText = extractMessageText(response.choices[0]?.message?.content);
  const usage = response.usage || null;
  const responseModel = response.model || model;

  return {
    sql: cleanModelOutput(rawText),
    rawText,
    usage,
    cost: calculateCost(responseModel, usage),
    finishReason: response.choices[0]?.finish_reason || null,
    responseId: response.id || null,
    responseModel,
    request: tracedRequest,
  };
}

export const OPTIMIZED_MODEL_REQUEST_OPTIONS = {
  temperature: 0,
  max_completion_tokens: 3200,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'text_to_sql_response',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sql', 'explanation', 'tables_used', 'assumptions'],
        properties: {
          sql: { type: 'string' },
          explanation: { type: 'string' },
          tables_used: {
            type: 'array',
            items: { type: 'string' },
          },
          assumptions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

export async function generateOptimizedResponse({ client, model, prompt, retryContext = null, signal = null }) {
  const messages = [{ role: 'system', content: prompt.system }];

  if (!retryContext) {
    messages.push({ role: 'user', content: prompt.user });
  } else {
    messages.push({ role: 'user', content: prompt.user });
    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        sql: retryContext.sql,
        explanation: 'Previous attempt',
        tables_used: retryContext.tablesUsed || [],
        assumptions: retryContext.assumptions || [],
      }),
    });
    // Phrase the corrective hint by the stage that actually failed. A validation
    // rejection is not a "database error", and saying so misdirects the model's
    // fix. Unknown/execution stages keep the original wording.
    const failureLabel =
      retryContext.stage === 'validation'
        ? 'was rejected by SQL validation (guardrails) with this error'
        : retryContext.stage === 'llm'
          ? 'could not be generated; the previous attempt failed with this error'
          : 'failed with this database error';
    messages.push({
      role: 'user',
      content: `The SQL above ${failureLabel}:\n${retryContext.error}\n\nReturn corrected JSON only.`,
    });
  }

  const request = {
    model,
    ...OPTIMIZED_MODEL_REQUEST_OPTIONS,
    messages,
  };
  const tracedRequest = {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
  };

  // Pass the abort signal so a disconnected client (SSE closed) stops the
  // in-flight generation instead of burning the full completion's tokens.
  const response = await client.chat.completions.create(request, signal ? { signal } : undefined);
  const rawText = extractMessageText(response.choices[0]?.message?.content);
  const usage = response.usage || null;
  const responseModel = response.model || model;

  const cleaned = cleanModelOutput(rawText);

  try {
    const parsed = JSON.parse(cleaned);
    return {
      sql: cleanModelOutput(parsed.sql || ''),
      explanation: parsed.explanation || '',
      tables_used: Array.isArray(parsed.tables_used) ? parsed.tables_used : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      rawText,
      usage,
      cost: calculateCost(responseModel, usage),
      finishReason: response.choices[0]?.finish_reason || null,
      responseId: response.id || null,
      responseModel,
      request: tracedRequest,
    };
  } catch {
    return {
      sql: cleaned,
      explanation: 'Model response was not valid JSON.',
      tables_used: [],
      assumptions: ['Response parsing failed; SQL was extracted from raw output.'],
      rawText,
      usage,
      cost: calculateCost(responseModel, usage),
      finishReason: response.choices[0]?.finish_reason || null,
      responseId: response.id || null,
      responseModel,
      request: tracedRequest,
    };
  }
}

// Strip string literals, quoted identifiers, and comments so the safety scan
// matches only executable SQL tokens. This avoids false positives on harmless
// literals (e.g. WHERE note = 'DELETE later') and prevents comment-obfuscated
// payloads from sneaking past the keyword/function denylist.
export function stripSqlForSafetyScan(sql) {
  return String(sql || '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// Patterns that must never appear in a read-only analytics query. The validator
// is intentionally conservative: the first keyword must already be SELECT/WITH
// and only a single statement is permitted, so this list targets the residual
// ways a SELECT can still write, exfiltrate, lock, or denial-of-service.
const READ_ONLY_DENYLIST = [
  {
    pattern:
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE|CALL|DO|HANDLER|RENAME|PREPARE|EXECUTE|DEALLOCATE|SHUTDOWN|KILL|FLUSH|INSTALL|UNINSTALL|LOAD)\b/i,
    message: 'Only read-only SQL is allowed.',
  },
  { pattern: /\bINTO\s+(OUTFILE|DUMPFILE)\b/i, message: 'Writing query output to files is not allowed.' },
  { pattern: /\bFOR\s+UPDATE\b/i, message: 'Locking reads (FOR UPDATE) are not allowed.' },
  { pattern: /\bLOCK\s+IN\s+SHARE\s+MODE\b/i, message: 'Locking reads (LOCK IN SHARE MODE) are not allowed.' },
  { pattern: /@/, message: 'User-defined and server (@/@@) variables are not allowed.' },
  {
    pattern: /\b(INFORMATION_SCHEMA|PERFORMANCE_SCHEMA|MYSQL|SYS)\s*\./i,
    message: 'Querying server metadata schemas is not allowed.',
  },
  {
    pattern:
      /\b(SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|IS_FREE_LOCK|IS_USED_LOCK|LOAD_FILE|MASTER_POS_WAIT|NAME_CONST|EXTRACTVALUE|UPDATEXML|WAIT_FOR_EXECUTED_GTID_SET)\s*\(/i,
    message: 'Use of restricted SQL functions (locking, file, timing, or XML) is not allowed.',
  },
  {
    pattern: /\b(USER|CURRENT_USER|SESSION_USER|SYSTEM_USER|VERSION|DATABASE|SCHEMA|CONNECTION_ID|CURRENT_ROLE)\s*\(/i,
    message: 'Server/session information functions are not allowed.',
  },
];

export function validateReadOnlySql(sql, allowedTables, { promptContext = null, response = null } = {}) {
  const cleaned = cleanModelOutput(sql).replace(/;+\s*$/, '');
  if (!cleaned) {
    throw new Error('Model did not return SQL.');
  }

  // Reject MySQL/MariaDB executable comments (/*! ... */) before they are
  // stripped; their payload runs on the server but hides from naive scanners.
  if (/\/\*!/.test(cleaned)) {
    throw new Error('Executable SQL comments (/*! ... */) are not allowed.');
  }

  const scanText = stripSqlForSafetyScan(cleaned);

  for (const { pattern, message } of READ_ONLY_DENYLIST) {
    if (pattern.test(scanText)) {
      throw new Error(message);
    }
  }

  const firstKeyword = scanText.match(/^\s*(WITH|SELECT)\b/i)?.[1]?.toUpperCase();
  if (!firstKeyword) {
    throw new Error('Only SELECT or WITH queries are allowed.');
  }

  const statements = scanText.split(';').map((part) => part.trim()).filter(Boolean);
  if (statements.length > 1) {
    throw new Error('Only a single SQL statement is allowed.');
  }

  const extractedTables = extractTablesFromSql(cleaned, { alreadyCleaned: true });

  const allowSet = new Set(allowedTables);
  for (const tableName of extractedTables) {
    if (!allowSet.has(tableName)) {
      throw new Error(`SQL references table "${tableName}" which is outside the allowed table set.`);
    }
  }

  const tablesUsed = [...new Set(extractedTables)];
  const guardrails = validateSqlGuardrails(cleaned, {
    allowedTables,
    promptContext,
    response,
    tablesUsed,
  });

  return {
    sql: cleaned,
    tablesUsed,
    statementCount: statements.length,
    firstKeyword,
    guardrails,
  };
}

// Bound the execution tail. The generated SQL is model-authored, so a
// pathological join could otherwise run unbounded and pin the MariaDB instance,
// which may also host sensitive non-demo databases. MariaDB's
// `SET STATEMENT max_statement_time=<seconds> FOR <stmt>` scopes the timeout to
// this single statement (seconds, fractional allowed). Pass timeoutMs<=0 (or set
// WEB_QUERY_STATEMENT_TIMEOUT_MS=0) to disable and preserve the old behavior.
export async function executeReadOnlySql(connection, sql, { timeoutMs } = {}) {
  // Opt-in tail bounding. When a positive timeout is supplied, MariaDB's
  // `SET STATEMENT max_statement_time=<seconds> FOR <stmt>` scopes it to this one
  // statement (seconds, fractional allowed). Callers that pass nothing keep the
  // original unbounded behavior — the web layer is what opts in, since it is the
  // path exposed to model-authored SQL against the shared MariaDB instance.
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const seconds = (timeoutMs / 1000).toFixed(3);
    const [rows] = await connection.query(`SET STATEMENT max_statement_time=${seconds} FOR ${sql}`);
    return rows;
  }

  const [rows] = await connection.query(sql);
  return rows;
}

export function printRows(rows, output = console) {
  if (!Array.isArray(rows) || rows.length === 0) {
    output.log('  (no rows)');
    return;
  }

  output.table(rows);
}

export function compareRows(expectedRows, actualRows) {
  if (expectedRows.length !== actualRows.length) {
    return false;
  }

  const normalizeRow = (row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key.toLowerCase()] =
        typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
    }
    return JSON.stringify(normalized);
  };

  const expected = expectedRows.map(normalizeRow).sort();
  const actual = actualRows.map(normalizeRow).sort();
  return expected.every((value, index) => value === actual[index]);
}

export function createOpenAiClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required.');
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    ...(process.env.OPENAI_BASE_URL && { baseURL: process.env.OPENAI_BASE_URL }),
  });
}

function buildMariaDbConnectionOptions({ includeDatabase = true } = {}) {
  const connectionOptions = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    decimalNumbers: true,
  };

  if (includeDatabase) {
    connectionOptions.database = process.env.DB_NAME;
  }

  if (process.env.DB_SOCKET) {
    connectionOptions.socketPath = process.env.DB_SOCKET;
  } else {
    connectionOptions.host = process.env.DB_HOST || '127.0.0.1';
    connectionOptions.port = Number(process.env.DB_PORT || 3306);
  }

  return connectionOptions;
}

export function describeMariaDbConnectionTarget({ includeDatabase = true } = {}) {
  const connectionOptions = buildMariaDbConnectionOptions({ includeDatabase });

  return {
    user: connectionOptions.user || null,
    database: includeDatabase ? connectionOptions.database || null : null,
    socketPath: connectionOptions.socketPath || null,
    host: connectionOptions.socketPath ? null : connectionOptions.host || null,
    port: connectionOptions.socketPath ? null : connectionOptions.port ?? null,
  };
}

function formatMariaDbTarget(connectionOptions) {
  if (connectionOptions.socketPath) {
    return `socket ${connectionOptions.socketPath}`;
  }

  return `${connectionOptions.host}:${connectionOptions.port}`;
}

export async function createMariaDbConnection({ includeDatabase = true } = {}) {
  const missing = ['DB_USER', includeDatabase ? 'DB_NAME' : null].filter((key) => key && !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required MariaDB env vars: ${missing.join(', ')}. Add them to the loaded .env file or export them in the shell.`
    );
  }

  const connectionOptions = buildMariaDbConnectionOptions({ includeDatabase });

  try {
    return await mysql.createConnection(connectionOptions);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error(
        `Unable to connect to MariaDB at ${formatMariaDbTarget(connectionOptions)}. Start MariaDB locally or update DB_HOST, DB_PORT, or DB_SOCKET.`
      );
    }

    if (error.code === 'ER_BAD_DB_ERROR' && includeDatabase) {
      throw new Error(
        `Database "${process.env.DB_NAME}" does not exist. Start MariaDB and run "npm run bootstrap-db" first.`
      );
    }

    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      throw new Error(
        `MariaDB access denied for user "${connectionOptions.user}". Check DB_USER and DB_PASSWORD.`
      );
    }

    throw error;
  }
}

export function createMariaDbPool({ includeDatabase = true, connectionLimit = 5 } = {}) {
  const missing = ['DB_USER', includeDatabase ? 'DB_NAME' : null].filter((key) => key && !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required MariaDB env vars: ${missing.join(', ')}. Add them to the loaded .env file or export them in the shell.`
    );
  }

  return mysql.createPool({
    ...buildMariaDbConnectionOptions({ includeDatabase }),
    waitForConnections: true,
    connectionLimit,
    queueLimit: 20,
  });
}

export async function loadNarrowSchema({
  modelsDir,
  schemaPath,
  refreshSchema = false,
  includedTables = DEFAULT_INCLUDED_TABLES,
}) {
  const compiled = await ensureCompiledSchema({
    modelsDir,
    schemaPath,
    force: refreshSchema,
  });

  return filterSchema(compiled, includedTables);
}

export function describeSchema(schema) {
  return {
    generatedAt: schema.generatedAt || null,
    tableCount: schema.tableCount,
    associationErrors: schema.associationErrors || [],
    missingReferencedModels: schema.missingReferencedModels || [],
    tables: schema.tables.map((table) => ({
      name: table.name,
      tableName: table.tableName,
      file: table.file || null,
      description: table.description || null,
      columnCount: table.columns.length,
      foreignKeys: table.foreignKeys.map((foreignKey) => ({
        column: foreignKey.column,
        references: foreignKey.references,
      })),
      ignoredForeignKeys: (table.ignoredForeignKeys || []).map((foreignKey) => ({
        column: foreignKey.column,
        references: foreignKey.references,
      })),
    })),
  };
}

export async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
