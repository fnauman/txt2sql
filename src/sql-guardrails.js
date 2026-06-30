const SQL_KEYWORDS = new Set([
  'ALL',
  'ABS',
  'AND',
  'AS',
  'ASC',
  'AVG',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'COALESCE',
  'COUNT',
  'CONCAT',
  'CURRENT_DATE',
  'DATE',
  'DATE_ADD',
  'DATE_FORMAT',
  'DATE_SUB',
  'DAY',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'FALSE',
  'FROM',
  'GROUP',
  'HAVING',
  'IF',
  'IFNULL',
  'IN',
  'INNER',
  'INTERVAL',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'LIMIT',
  'LOWER',
  'MAX',
  'MIN',
  'MONTH',
  'NOT',
  'NULLIF',
  'NULL',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'RIGHT',
  'ROUND',
  'SELECT',
  'SUM',
  'THEN',
  'TRUE',
  'WHEN',
  'WHERE',
  'WITH',
  'UPPER',
  'YEAR',
]);

const TABLE_ALIAS_STOPWORDS = new Set([
  'FULL',
  'INNER',
  'JOIN',
  'LEFT',
  'ON',
  'RIGHT',
  'WHERE',
]);

const DERIVED_TABLE_PREFIX = '__derived_table__:';

function stripSqlLiterals(sql) {
  return String(sql || '')
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeIdentifier(value) {
  return String(value || '').replace(/`/g, '').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDerivedTableName(tableName) {
  return String(tableName || '').startsWith(DERIVED_TABLE_PREFIX);
}

function derivedAliasFromTableName(tableName) {
  return isDerivedTableName(tableName) ? String(tableName).slice(DERIVED_TABLE_PREFIX.length) : null;
}

function findClosingParen(sql, openIndex) {
  let depth = 0;

  for (let index = openIndex; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitTopLevelCommaList(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const text = String(value || '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }

  return parts;
}

function isIdentifierChar(char) {
  return /[A-Za-z0-9_]/.test(char || '');
}

function findTopLevelKeyword(sql, keyword, startIndex = 0) {
  let depth = 0;
  const pattern = new RegExp('^' + escapeRegExp(keyword) + '\\b', 'i');

  for (let index = startIndex; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || isIdentifierChar(sql[index - 1])) {
      continue;
    }
    if (pattern.test(sql.slice(index))) {
      return index;
    }
  }

  return -1;
}

function parseSimpleColumnExpression(expression, localAliases, knownTables) {
  const text = String(expression || '').trim().replace(/;$/, '');
  const qualified = text.match(/^`?([A-Za-z][A-Za-z0-9_]*)`?\s*\.\s*`?([A-Za-z][A-Za-z0-9_]*)`?$/);
  if (qualified) {
    const tableName = localAliases.get(normalizeIdentifier(qualified[1]));
    const columnName = normalizeIdentifier(qualified[2]);
    if (tableName && !isDerivedTableName(tableName) && columnExists(knownTables, tableName, columnName, new Map())) {
      return { outputName: columnName, origins: [{ tableName, columnName }] };
    }
    return { outputName: columnName, origins: [] };
  }

  const unqualified = text.match(/^`?([A-Za-z][A-Za-z0-9_]*)`?$/);
  if (!unqualified) {
    return null;
  }

  const columnName = normalizeIdentifier(unqualified[1]);
  const originTables = [...new Set([...localAliases.values()])]
    .filter((tableName) => !isDerivedTableName(tableName) && columnExists(knownTables, tableName, columnName, new Map()));

  return {
    outputName: columnName,
    origins: originTables.length === 1 ? [{ tableName: originTables[0], columnName }] : [],
  };
}

function parseSelectItem(selectItem, localAliases, knownTables) {
  const explicitAlias = selectItem.match(/\s+AS\s+`?([A-Za-z][A-Za-z0-9_]*)`?\s*$/i);
  if (explicitAlias) {
    const expression = selectItem.slice(0, explicitAlias.index).trim();
    const parsed = parseSimpleColumnExpression(expression, localAliases, knownTables);
    return {
      outputName: normalizeIdentifier(explicitAlias[1]),
      origins: parsed?.origins || [],
    };
  }

  const trailingAlias = selectItem.match(/^(.+?)\s+`?([A-Za-z][A-Za-z0-9_]*)`?\s*$/);
  if (trailingAlias && !SQL_KEYWORDS.has(String(trailingAlias[2]).toUpperCase())) {
    const parsed = parseSimpleColumnExpression(trailingAlias[1], localAliases, knownTables);
    return {
      outputName: normalizeIdentifier(trailingAlias[2]),
      origins: parsed?.origins || [],
    };
  }

  return parseSimpleColumnExpression(selectItem, localAliases, knownTables);
}

function parseDerivedTableColumns(sql, knownTables) {
  const selectIndex = findTopLevelKeyword(sql, 'SELECT');
  if (selectIndex < 0) {
    return { columns: new Set(), origins: new Map() };
  }

  const selectEnd = selectIndex + 'SELECT'.length;
  const fromIndex = findTopLevelKeyword(sql, 'FROM', selectEnd);
  if (fromIndex < 0) {
    return { columns: new Set(), origins: new Map() };
  }

  const localAliases = extractRealTableAliases(sql, knownTables);
  const columns = new Set();
  const origins = new Map();

  for (const item of splitTopLevelCommaList(sql.slice(selectEnd, fromIndex))) {
    const parsed = parseSelectItem(item, localAliases, knownTables);
    if (!parsed?.outputName) {
      continue;
    }
    columns.add(parsed.outputName);
    origins.set(parsed.outputName, parsed.origins || []);
  }

  return { columns, origins };
}

function extractDerivedTables(sql, knownTables) {
  const derivedTables = new Map();
  const derivedRegex = /\b(?:FROM|JOIN)\s*\(/gi;
  let match;

  while ((match = derivedRegex.exec(sql)) !== null) {
    const openIndex = sql.indexOf('(', match.index);
    const closeIndex = findClosingParen(sql, openIndex);
    if (closeIndex < 0) {
      continue;
    }

    const aliasMatch = sql.slice(closeIndex + 1).match(/^\s+(?:AS\s+)?`?([A-Za-z][A-Za-z0-9_]*)`?/i);
    if (!aliasMatch) {
      continue;
    }

    const alias = normalizeIdentifier(aliasMatch[1]);
    const upper = alias.toUpperCase();
    if (alias && !TABLE_ALIAS_STOPWORDS.has(upper) && !SQL_KEYWORDS.has(upper) && !knownTables.has(alias)) {
      derivedTables.set(alias, parseDerivedTableColumns(sql.slice(openIndex + 1, closeIndex), knownTables));
    }
    derivedRegex.lastIndex = closeIndex + 1 + aliasMatch[0].length;
  }

  return derivedTables;
}

function collectPromptTables(promptContext = {}, allowedTables = []) {
  const tables = new Map();
  const tableContexts = Array.isArray(promptContext.tables) ? promptContext.tables : [];

  for (const table of tableContexts) {
    const tableName = table.tableName || table.name;
    if (!tableName) {
      continue;
    }

    const columns = new Set([
      ...(table.includedColumns || []).map((column) => column.name),
      ...(table.omittedColumnNames || []),
    ]);
    tables.set(tableName, columns);
  }

  for (const tableName of allowedTables || []) {
    if (!tables.has(tableName)) {
      tables.set(tableName, new Set());
    }
  }

  return tables;
}

function extractRealTableAliases(sql, knownTables) {
  const aliases = new Map();
  const cleaned = stripSqlLiterals(sql);
  const tableRegex = /\b(?:FROM|JOIN)\s+`?([A-Za-z][A-Za-z0-9_]*)`?(?:\s+(?:AS\s+)?`?([A-Za-z][A-Za-z0-9_]*)`?)?/gi;
  let match;

  for (const tableName of knownTables.keys()) {
    aliases.set(tableName, tableName);
  }

  while ((match = tableRegex.exec(cleaned)) !== null) {
    const tableName = normalizeIdentifier(match[1]);
    const alias = normalizeIdentifier(match[2]);
    if (!knownTables.has(tableName)) {
      continue;
    }
    if (alias && !TABLE_ALIAS_STOPWORDS.has(alias.toUpperCase()) && !knownTables.has(alias)) {
      aliases.set(alias, tableName);
    }
  }

  return aliases;
}

function extractTableContext(sql, knownTables) {
  const cleaned = stripSqlLiterals(sql);
  const aliases = extractRealTableAliases(cleaned, knownTables);
  const derivedTables = extractDerivedTables(cleaned, knownTables);

  for (const alias of derivedTables.keys()) {
    aliases.set(alias, DERIVED_TABLE_PREFIX + alias);
  }

  return { aliases, derivedTables };
}

function extractOutputAliases(sql) {
  const aliases = new Set();
  const cleaned = stripSqlLiterals(sql);
  const aliasRegex = /\bAS\s+`?([A-Za-z][A-Za-z0-9_]*)`?/gi;
  let match;

  while ((match = aliasRegex.exec(cleaned)) !== null) {
    aliases.add(normalizeIdentifier(match[1]));
  }

  return aliases;
}

function extractCteNames(sql) {
  const ctes = new Set();
  const cleaned = stripSqlLiterals(sql);
  if (!/^\s*WITH\b/i.test(cleaned)) {
    return ctes;
  }

  const cteRegex = /(?:^\s*WITH\s+(?:RECURSIVE\s+)?|,)\s*`?([A-Za-z][A-Za-z0-9_]*)`?\s+AS\s*\(/gi;
  let match;
  while ((match = cteRegex.exec(cleaned)) !== null) {
    ctes.add(normalizeIdentifier(match[1]));
  }

  return ctes;
}

function columnExists(knownTables, tableName, columnName, derivedTables = new Map()) {
  const derivedAlias = derivedAliasFromTableName(tableName);
  if (derivedAlias) {
    return Boolean(derivedTables.get(derivedAlias)?.columns?.has(columnName));
  }

  const columns = knownTables.get(tableName);
  return columns instanceof Set && columns.has(columnName);
}

function validateQualifiedColumns(sql, knownTables, aliases, derivedTables) {
  const cleaned = stripSqlLiterals(sql);
  const usedColumns = [];
  const columnRegex = /`?([A-Za-z][A-Za-z0-9_]*)`?\s*\.\s*`?([A-Za-z][A-Za-z0-9_]*)`?/g;
  let match;

  while ((match = columnRegex.exec(cleaned)) !== null) {
    const qualifier = normalizeIdentifier(match[1]);
    const columnName = normalizeIdentifier(match[2]);
    const tableName = aliases.get(qualifier);

    if (!tableName) {
      throw new Error(`SQL references unknown table or alias "${qualifier}" in qualified column "${qualifier}.${columnName}".`);
    }
    if (!columnExists(knownTables, tableName, columnName, derivedTables)) {
      throw new Error(`SQL references unknown column "${columnName}" on table "${tableName}".`);
    }

    usedColumns.push({ tableName, columnName, qualifier });
  }

  return usedColumns;
}

function validateSuspiciousUnqualifiedIdentifiers(sql, knownTables, aliases, derivedTables) {
  const cleaned = stripSqlLiterals(sql);
  const knownColumns = new Set([...knownTables.values()].flatMap((columns) => [...columns]));
  const knownIdentifiers = new Set([
    ...knownTables.keys(),
    ...aliases.keys(),
    ...knownColumns,
    ...[...derivedTables.values()].flatMap((table) => [...(table.columns || [])]),
    ...extractOutputAliases(cleaned),
    ...extractCteNames(cleaned),
  ]);
  const identifierRegex = /`?([A-Za-z][A-Za-z0-9_]*)`?/g;
  let match;

  while ((match = identifierRegex.exec(cleaned)) !== null) {
    const identifier = normalizeIdentifier(match[1]);
    const upper = identifier.toUpperCase();
    const before = cleaned.slice(Math.max(0, match.index - 2), match.index);
    const after = cleaned.slice(match.index + match[0].length, match.index + match[0].length + 2);

    if (before.includes('.') || after.includes('.')) {
      continue;
    }
    if (SQL_KEYWORDS.has(upper) || knownIdentifiers.has(identifier)) {
      continue;
    }
    if (/[A-Z]/.test(identifier) && !/^[A-Z_]+$/.test(identifier)) {
      throw new Error(`SQL references unknown identifier "${identifier}".`);
    }
  }
}

function relationshipKey(leftTable, leftColumn, rightTable, rightColumn) {
  return `${leftTable}.${leftColumn}->${rightTable}.${rightColumn}`;
}

function collectRelationshipKeys(promptContext = {}) {
  const keys = new Set();
  const relationships = Array.isArray(promptContext.relationships) ? promptContext.relationships : [];

  for (const relationship of relationships) {
    const left = relationshipKey(
      relationship.fromTable,
      relationship.fromColumn,
      relationship.toTable,
      relationship.toColumn
    );
    const right = relationshipKey(
      relationship.toTable,
      relationship.toColumn,
      relationship.fromTable,
      relationship.fromColumn
    );
    keys.add(left);
    keys.add(right);
  }

  for (const joinHint of promptContext.semanticPlan?.joinHints || []) {
    const match = String(joinHint.joinSql || '').match(
      /([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*=\s*([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)/
    );
    if (!match) {
      continue;
    }
    keys.add(relationshipKey(match[1], match[2], match[3], match[4]));
    keys.add(relationshipKey(match[3], match[4], match[1], match[2]));
  }

  return keys;
}

function resolveJoinColumnReferences(tableName, columnName, derivedTables) {
  const derivedAlias = derivedAliasFromTableName(tableName);
  if (!derivedAlias) {
    return [{ tableName, columnName }];
  }

  return derivedTables.get(derivedAlias)?.origins?.get(columnName) || [];
}

function validateJoinGuardrails(sql, knownTables, aliases, derivedTables, promptContext) {
  const relationshipKeys = collectRelationshipKeys(promptContext);
  const cleaned = stripSqlLiterals(sql);
  const equalityRegex =
    /`?([A-Za-z][A-Za-z0-9_]*)`?\s*\.\s*`?([A-Za-z][A-Za-z0-9_]*)`?\s*=\s*`?([A-Za-z][A-Za-z0-9_]*)`?\s*\.\s*`?([A-Za-z][A-Za-z0-9_]*)`?/g;
  let match;
  const checkedJoins = [];

  while ((match = equalityRegex.exec(cleaned)) !== null) {
    const leftQualifier = normalizeIdentifier(match[1]);
    const leftTable = aliases.get(leftQualifier);
    const leftColumn = normalizeIdentifier(match[2]);
    const rightQualifier = normalizeIdentifier(match[3]);
    const rightTable = aliases.get(rightQualifier);
    const rightColumn = normalizeIdentifier(match[4]);

    if (!leftTable || !rightTable || leftTable === rightTable) {
      continue;
    }

    const leftReferences = resolveJoinColumnReferences(leftTable, leftColumn, derivedTables);
    const rightReferences = resolveJoinColumnReferences(rightTable, rightColumn, derivedTables);
    if (leftReferences.length === 0 || rightReferences.length === 0) {
      continue;
    }

    for (const leftReference of leftReferences) {
      for (const rightReference of rightReferences) {
        if (leftReference.tableName === rightReference.tableName) {
          continue;
        }

        const key = relationshipKey(
          leftReference.tableName,
          leftReference.columnName,
          rightReference.tableName,
          rightReference.columnName
        );
        checkedJoins.push({
          leftTable: leftReference.tableName,
          leftColumn: leftReference.columnName,
          rightTable: rightReference.tableName,
          rightColumn: rightReference.columnName,
          leftQualifier,
          rightQualifier,
        });
        if (!relationshipKeys.has(key)) {
          throw new Error(
            'SQL joins ' +
              leftReference.tableName +
              '.' +
              leftReference.columnName +
              ' to ' +
              rightReference.tableName +
              '.' +
              rightReference.columnName +
              ', which is not an in-scope relationship.'
          );
        }
      }
    }
  }

  return checkedJoins;
}

function normalizeSqlForColumnSearch(sql) {
  return stripSqlLiterals(sql).replace(/`/g, '').toLowerCase();
}

function columnMentioned(sqlText, qualifiedColumn) {
  const [tableName, columnName] = String(qualifiedColumn || '').split('.');
  if (!tableName || !columnName) {
    return false;
  }

  const lowerColumn = columnName.toLowerCase();
  const lowerQualified = `${tableName}.${columnName}`.toLowerCase();
  return new RegExp(`\\b${lowerColumn}\\b`).test(sqlText) || sqlText.includes(lowerQualified);
}

function validateMetricGuardrails(sql, promptContext = {}) {
  const metrics = promptContext.semanticPlan?.metrics || [];
  const hasLineMetric = metrics.some((metric) => metric.name === 'line_net_sales');
  const sqlText = normalizeSqlForColumnSearch(sql);
  const checkedMetrics = [];

  for (const metric of metrics) {
    if (metric.name === 'net_sales' && hasLineMetric) {
      continue;
    }
    if (/^COUNT\s*\(/i.test(metric.preferredExpression || '')) {
      continue;
    }

    const preferredColumns = metric.preferredColumns || [];
    if (preferredColumns.length === 0) {
      continue;
    }

    checkedMetrics.push({ name: metric.name, preferredColumns });
    if (!preferredColumns.some((column) => columnMentioned(sqlText, column))) {
      throw new Error(
        `SQL does not use a preferred column for semantic metric "${metric.name}" (${preferredColumns.join(', ')}).`
      );
    }
  }

  return checkedMetrics;
}

/**
 * Candidate ID validation is scoped to product master-data groups
 * represented by candidate.ProductId. Other entity IDs need their own column set.
 */
function collectCandidateProductIds(masterDataCandidates = []) {
  const ids = new Set();

  for (const group of masterDataCandidates || []) {
    if (group.entity && group.entity !== 'product') {
      continue;
    }

    for (const term of group.terms || []) {
      for (const candidate of term.candidates || []) {
        if (Number.isFinite(Number(candidate.ProductId))) {
          ids.add(Number(candidate.ProductId));
        }
      }
    }
  }

  return ids;
}

function collectProductIdColumnNames(promptContext = {}) {
  const columns = new Set(['ProductId']);
  const relationships = Array.isArray(promptContext.relationships) ? promptContext.relationships : [];
  const tableContexts = Array.isArray(promptContext.tables) ? promptContext.tables : [];

  for (const relationship of relationships) {
    if (relationship.toTable === 'Product' && relationship.toColumn === 'ProductId') {
      columns.add(relationship.fromColumn);
    }
    if (relationship.fromTable === 'Product' && relationship.fromColumn === 'ProductId') {
      columns.add(relationship.toColumn);
    }
  }

  for (const table of tableContexts) {
    for (const column of table.includedColumns || []) {
      if (column.name === 'ProductId' || (column.references?.model === 'Product' && column.references?.key === 'ProductId')) {
        columns.add(column.name);
      }
    }
  }

  return [...columns].filter(Boolean).sort((left, right) => right.length - left.length);
}

function buildProductIdColumnReferencePattern(productIdColumnNames) {
  const columnPattern = productIdColumnNames.map(escapeRegExp).join('|');
  return '\\b(?:`?[A-Za-z][A-Za-z0-9_]*`?\\s*\\.\\s*)?`?(?:' + columnPattern + ')`?';
}

function collectReferencedProductIds(sql, productIdColumnNames) {
  const referencedIds = new Set();
  const columnReferencePattern = buildProductIdColumnReferencePattern(productIdColumnNames);
  const equalityRegex = new RegExp(`${columnReferencePattern}\\s*=\\s*(\\d+)`, 'gi');
  const inRegex = new RegExp(`${columnReferencePattern}\\s+IN\\s*\\(([^)]*)\\)`, 'gi');
  let match;

  while ((match = equalityRegex.exec(sql)) !== null) {
    referencedIds.add(Number(match[1]));
  }

  while ((match = inRegex.exec(sql)) !== null) {
    for (const idMatch of match[1].matchAll(/\b\d+\b/g)) {
      referencedIds.add(Number(idMatch[0]));
    }
  }

  return referencedIds;
}

function validateMasterDataCandidateIds(sql, promptContext = {}) {
  const candidateIds = collectCandidateProductIds(promptContext.masterDataCandidates);
  if (candidateIds.size === 0) {
    return { candidateIds: [], referencedIds: [] };
  }

  const cleaned = stripSqlLiterals(sql);
  const productIdColumnNames = collectProductIdColumnNames(promptContext);
  const referencedIds = collectReferencedProductIds(cleaned, productIdColumnNames);

  for (const productId of referencedIds) {
    if (!candidateIds.has(productId)) {
      throw new Error(`SQL references ProductId ${productId}, which was not in the resolved master-data candidates.`);
    }
  }

  return {
    candidateIds: [...candidateIds],
    productIdColumnNames,
    referencedIds: [...referencedIds],
  };
}

function validateResponseTableContract(response, tablesUsed, allowedTables) {
  if (!response || !Array.isArray(response.tables_used)) {
    return null;
  }

  const allowed = new Set(allowedTables || []);
  const declared = [...new Set(response.tables_used)];
  const actual = [...new Set(tablesUsed || [])];

  for (const tableName of declared) {
    if (!allowed.has(tableName)) {
      throw new Error(`Response tables_used includes table "${tableName}" outside the allowed table set.`);
    }
  }

  const missing = actual.filter((tableName) => !declared.includes(tableName));
  if (missing.length > 0) {
    throw new Error(`Response tables_used omitted SQL table(s): ${missing.join(', ')}.`);
  }

  return { declaredTables: declared, actualTables: actual };
}

export function validateSqlGuardrails(
  sql,
  { allowedTables = [], promptContext = null, response = null, tablesUsed = [] } = {}
) {
  if (!promptContext) {
    return null;
  }

  const knownTables = collectPromptTables(promptContext, allowedTables);
  const { aliases, derivedTables } = extractTableContext(sql, knownTables);
  const qualifiedColumns = validateQualifiedColumns(sql, knownTables, aliases, derivedTables);
  validateSuspiciousUnqualifiedIdentifiers(sql, knownTables, aliases, derivedTables);
  const joinChecks = validateJoinGuardrails(sql, knownTables, aliases, derivedTables, promptContext);
  const metricChecks = validateMetricGuardrails(sql, promptContext);
  const masterDataChecks = validateMasterDataCandidateIds(sql, promptContext);

  return {
    columnChecks: {
      qualifiedColumns,
    },
    joinChecks,
    metricChecks,
    masterDataChecks,
    responseTableChecks: validateResponseTableContract(response, tablesUsed, allowedTables),
  };
}
