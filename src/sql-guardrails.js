import {
  analyzeSqlStructure,
  isKeywordToken,
  stripSqlTokens,
  tokenizeSql,
  tokensToText,
} from './sql-tokenizer.js';

/**
 * Error thrown by every deterministic SQL check. `code` is a stable string
 * (e.g. SQL_COMMENT, TABLE_SCOPE, FAN_OUT) and `layer` says which layer rejected
 * the SQL: 'safety' (read-only / table scope, pipeline.js) or 'guardrail'
 * (schema-aware checks in this module).
 */
export class SqlValidationError extends Error {
  constructor(message, { code, layer, details = null } = {}) {
    super(message);
    this.name = 'SqlValidationError';
    this.code = code;
    this.layer = layer;
    if (details) {
      this.details = details;
    }
  }
}

function guardrailError(code, message, details = null) {
  return new SqlValidationError(message, { code, layer: 'guardrail', details });
}

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

// Blank string literals and drop comments using the shared MariaDB tokenizer, so
// this layer sees exactly the SQL text the safety layer validated. Comments
// become a space so neighbouring tokens never glue together. Tolerant mode:
// layer 1 has already rejected unterminated tokens before this runs.
function stripSqlLiterals(sql) {
  return stripSqlTokens(tokenizeSql(String(sql || ''), { tolerant: true }));
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

function expandStarSelectItem(selectItem, localAliases, knownTables) {
  const text = String(selectItem || '').trim();
  const qualifiedStar = text.match(/^`?([A-Za-z][A-Za-z0-9_]*)`?\s*\.\s*\*$/);
  let tableNames = [];
  if (text === '*') {
    tableNames = [...new Set([...localAliases.values()])].filter((tableName) => !isDerivedTableName(tableName));
  } else if (qualifiedStar) {
    const tableName = localAliases.get(normalizeIdentifier(qualifiedStar[1]));
    tableNames = tableName && !isDerivedTableName(tableName) ? [tableName] : [];
  } else {
    return null;
  }

  return tableNames.flatMap((tableName) =>
    [...(knownTables.get(tableName) || [])].map((columnName) => ({
      outputName: columnName,
      origins: [{ tableName, columnName }],
    }))
  );
}

function parseDerivedTableColumns(sql, knownTables) {
  const empty = { columns: new Set(), origins: new Map(), orderedColumns: [] };
  const selectIndex = findTopLevelKeyword(sql, 'SELECT');
  if (selectIndex < 0) {
    return empty;
  }

  const selectEnd = selectIndex + 'SELECT'.length;
  const fromIndex = findTopLevelKeyword(sql, 'FROM', selectEnd);
  const selectListEnd = fromIndex < 0 ? sql.length : fromIndex;

  const localAliases = fromIndex < 0 ? new Map() : extractRealTableAliases(sql, knownTables);
  const columns = new Set();
  const origins = new Map();
  const orderedColumns = [];

  for (const item of splitTopLevelCommaList(sql.slice(selectEnd, selectListEnd).replace(/^\s*DISTINCT\b/i, ''))) {
    // SELECT * / alias.* expose every column of the underlying table(s).
    const starColumns = expandStarSelectItem(item, localAliases, knownTables);
    const parsedItems = starColumns || [parseSelectItem(item, localAliases, knownTables)];
    for (const parsed of parsedItems) {
      if (!parsed?.outputName) {
        orderedColumns.push(null);
        continue;
      }
      columns.add(parsed.outputName);
      origins.set(parsed.outputName, parsed.origins || []);
      orderedColumns.push(parsed);
    }
  }

  return { columns, origins, orderedColumns };
}

// A CTE with an explicit column list (`m (CustomerId, Net) AS (...)`) renames
// the body's select items positionally.
function parseCteColumns(cte, bodyText, knownTables) {
  const parsed = parseDerivedTableColumns(bodyText, knownTables);
  if (!Array.isArray(cte.columns) || cte.columns.length === 0) {
    return parsed;
  }

  const columns = new Set(cte.columns);
  const origins = new Map();
  cte.columns.forEach((columnName, index) => {
    origins.set(columnName, parsed.orderedColumns[index]?.origins || []);
  });
  return { columns, origins, orderedColumns: cte.columns.map((outputName) => ({ outputName, origins: origins.get(outputName) })) };
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

function isUsableAlias(alias, knownTables) {
  if (!alias) {
    return false;
  }
  const upper = alias.toUpperCase();
  return !TABLE_ALIAS_STOPWORDS.has(upper) && !SQL_KEYWORDS.has(upper) && !knownTables.has(alias);
}

// Table aliases from the token-level table references, so comma-joined tables
// (`FROM SalesDocument d, Customer c`) get their aliases too.
function extractRealTableAliases(sql, knownTables) {
  const aliases = new Map();
  for (const tableName of knownTables.keys()) {
    aliases.set(tableName, tableName);
  }

  const analysis = analyzeSqlStructure(String(sql || ''), { tolerant: true });
  for (const ref of analysis.tableRefs) {
    if (ref.kind === 'table' && !ref.schema && knownTables.has(ref.name) && isUsableAlias(ref.alias, knownTables)) {
      aliases.set(ref.alias, ref.name);
    }
  }

  return aliases;
}

// Aliases, derived tables and CTEs for the whole statement. CTEs are registered
// like derived tables (name -> projected columns), so qualified CTE references
// such as `mar.ProductId` resolve instead of failing as unknown aliases.
function extractTableContext(sql, knownTables) {
  const analysis = analyzeSqlStructure(String(sql || ''), { tolerant: true });
  const aliases = new Map();
  const derivedTables = new Map();

  for (const tableName of knownTables.keys()) {
    aliases.set(tableName, tableName);
  }

  for (const cte of analysis.ctes) {
    const bodyText = tokensToText(analysis.tokens, cte.bodyOpen + 1, cte.bodyClose);
    derivedTables.set(cte.name, parseCteColumns(cte, bodyText, knownTables));
    aliases.set(cte.name, DERIVED_TABLE_PREFIX + cte.name);
  }

  for (const ref of analysis.tableRefs) {
    if (ref.kind === 'table' && !ref.schema && knownTables.has(ref.name)) {
      if (isUsableAlias(ref.alias, knownTables)) {
        aliases.set(ref.alias, ref.name);
      }
    } else if (ref.kind === 'cte') {
      if (isUsableAlias(ref.alias, knownTables) && ref.alias !== ref.cteName) {
        aliases.set(ref.alias, DERIVED_TABLE_PREFIX + ref.cteName);
      }
    } else if (ref.kind === 'derived' && isUsableAlias(ref.alias, knownTables)) {
      const bodyText = tokensToText(analysis.tokens, ref.open + 1, ref.close);
      derivedTables.set(ref.alias, parseDerivedTableColumns(bodyText, knownTables));
      aliases.set(ref.alias, DERIVED_TABLE_PREFIX + ref.alias);
    }
  }

  return { aliases, derivedTables, analysis };
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

export function extractCteNames(sql) {
  return new Set(analyzeSqlStructure(String(sql || ''), { tolerant: true }).ctes.map((cte) => cte.name));
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
      throw guardrailError(
        'UNKNOWN_TABLE_ALIAS',
        `SQL references unknown table or alias "${qualifier}" in qualified column "${qualifier}.${columnName}".`
      );
    }
    if (!columnExists(knownTables, tableName, columnName, derivedTables)) {
      throw guardrailError('UNKNOWN_COLUMN', `SQL references unknown column "${columnName}" on table "${tableName}".`);
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
      throw guardrailError('UNKNOWN_IDENTIFIER', `SQL references unknown identifier "${identifier}".`);
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
          throw guardrailError(
            'JOIN_PATH',
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

function metricEnforcement(metric) {
  // Plans built before metric arbitration existed (or by hand in tests) carry no
  // enforcement flag; they keep the original, enforced behavior.
  return metric.enforcement === 'advisory' ? 'advisory' : 'enforced';
}

/**
 * Metric guardrail with arbitration.
 *
 * - Metrics whose preferred expression is a COUNT are hints only.
 * - `net_sales` is skipped when the line-level `line_net_sales` also matched.
 * - ADVISORY metrics (matched only through generic words such as "sales" or
 *   "sold", or through a count/existence question) never reject; a missing
 *   preferred column is recorded as a warning instead.
 * - ENFORCED metrics (explicit phrases such as "net sales", "quantity sold")
 *   reject the SQL when none of them is used. When several enforced metrics
 *   matched, using one satisfies the check and the others become warnings, so
 *   a stray second match cannot veto otherwise-correct SQL.
 */
function validateMetricGuardrails(sql, promptContext = {}) {
  const metrics = promptContext.semanticPlan?.metrics || [];
  const hasLineMetric = metrics.some((metric) => metric.name === 'line_net_sales');
  const sqlText = normalizeSqlForColumnSearch(sql);
  const checkedMetrics = [];
  const warnings = [];

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

    checkedMetrics.push({
      name: metric.name,
      preferredColumns,
      enforcement: metricEnforcement(metric),
      enforcementReason: metric.enforcementReason || null,
      satisfied: preferredColumns.some((column) => columnMentioned(sqlText, column)),
    });
  }

  const enforced = checkedMetrics.filter((metric) => metric.enforcement === 'enforced');
  if (enforced.length > 0 && !enforced.some((metric) => metric.satisfied)) {
    const [metric] = enforced;
    throw guardrailError(
      'METRIC_COLUMN',
      `SQL does not use a preferred column for semantic metric "${metric.name}" (${metric.preferredColumns.join(', ')}).`,
      { metric: metric.name, preferredColumns: metric.preferredColumns }
    );
  }

  for (const metric of checkedMetrics) {
    if (metric.satisfied) {
      continue;
    }
    warnings.push({
      code: 'METRIC_COLUMN_NOT_USED',
      layer: 'guardrail',
      metric: metric.name,
      enforcement: metric.enforcement,
      reason: metric.enforcement === 'advisory' ? metric.enforcementReason || 'advisory_match' : 'another_enforced_metric_used',
      message: `SQL does not use a preferred column for ${metric.enforcement} semantic metric "${metric.name}" (${metric.preferredColumns.join(', ')}).`,
    });
  }

  return { checkedMetrics, warnings };
}

// ---------------------------------------------------------------------------
// Fan-out detection
// ---------------------------------------------------------------------------

const FAN_OUT_AGGREGATES = ['SUM', 'AVG'];

function isPunctToken(token, value) {
  return Boolean(token) && token.type === 'punct' && token.value === value;
}

function tokenIdentifierName(token) {
  if (!token) {
    return null;
  }
  if (token.type === 'quoted_identifier') {
    return token.name;
  }
  return token.type === 'word' ? token.value : null;
}

// Child -> parent foreign keys among the prompt tables. A one-to-one key (the
// child's FK column is also its primary key) cannot fan out and is skipped.
function collectForeignKeyEdges(promptContext = {}) {
  const primaryKeys = new Set();
  for (const table of Array.isArray(promptContext.tables) ? promptContext.tables : []) {
    const tableName = table.tableName || table.name;
    for (const column of table.includedColumns || []) {
      if (column.primaryKey) {
        primaryKeys.add(`${tableName}.${column.name}`);
      }
    }
  }

  return (Array.isArray(promptContext.relationships) ? promptContext.relationships : [])
    .filter(
      (relationship) =>
        relationship.fromTable &&
        relationship.toTable &&
        relationship.fromTable !== relationship.toTable &&
        !primaryKeys.has(`${relationship.fromTable}.${relationship.fromColumn}`)
    )
    .map((relationship) => ({
      childTable: relationship.fromTable,
      childColumn: relationship.fromColumn,
      parentTable: relationship.toTable,
      parentColumn: relationship.toColumn,
    }));
}

// Column references inside one aggregate call, limited to the aggregate's own
// SELECT block (a nested subquery is a different scope) and excluding CASE WHEN
// conditions, which filter rows but do not decide the grain of the summed value.
function collectAggregateColumnRefs(tokens, group, blockId, aliasMap, blockTableNames, knownTables) {
  const refs = [];
  let whenDepth = 0;

  for (let index = group.open + 1; index < group.close; index += 1) {
    const token = tokens[index];
    if (token.blockId !== blockId) {
      continue;
    }
    if (isKeywordToken(token, 'WHEN')) {
      whenDepth += 1;
      continue;
    }
    if (isKeywordToken(token, 'THEN')) {
      whenDepth = Math.max(0, whenDepth - 1);
      continue;
    }
    if (whenDepth > 0) {
      continue;
    }

    const qualifier = tokenIdentifierName(token);
    if (qualifier && isPunctToken(tokens[index + 1], '.') && tokenIdentifierName(tokens[index + 2])) {
      const columnName = tokenIdentifierName(tokens[index + 2]);
      const tableName = aliasMap.get(qualifier);
      if (tableName && knownTables.get(tableName)?.has(columnName)) {
        refs.push({ tableName, columnName });
      }
      index += 2;
      continue;
    }

    if (
      token.type === 'word' &&
      !token.afterDot &&
      !isPunctToken(tokens[index + 1], '(') &&
      !isPunctToken(tokens[index - 1], '.')
    ) {
      const owners = blockTableNames.filter((tableName) => knownTables.get(tableName)?.has(token.value));
      if (owners.length === 1) {
        refs.push({ tableName: owners[0], columnName: token.value });
      }
    }
  }

  return refs;
}

// `LEFT JOIN child c ... WHERE c.col IS NULL` keeps only parents without child
// rows, so that child cannot multiply parent rows.
function collectAntiJoinedTables(tokens, blockTokenIndexes, blockId, refs) {
  const leftJoinedByQualifier = new Map();
  for (const ref of refs) {
    if (ref.joinType === 'LEFT') {
      leftJoinedByQualifier.set(ref.alias || ref.name, ref.name);
    }
  }

  const antiJoined = new Set();
  for (const index of blockTokenIndexes) {
    const qualifier = tokenIdentifierName(tokens[index]);
    if (
      qualifier &&
      leftJoinedByQualifier.has(qualifier) &&
      isPunctToken(tokens[index + 1], '.') &&
      tokenIdentifierName(tokens[index + 2]) &&
      isKeywordToken(tokens[index + 3], 'IS') &&
      isKeywordToken(tokens[index + 4], 'NULL') &&
      tokens[index + 3].blockId === blockId
    ) {
      antiJoined.add(leftJoinedByQualifier.get(qualifier));
    }
  }
  return antiJoined;
}

function describeFanOut({ aggregate, tableName, columnName, edge, knownTables }) {
  const child = edge.childTable;
  const childHasSameColumn = knownTables.get(child)?.has(columnName);
  const fix = childHasSameColumn
    ? `Use ${child}.${columnName} for ${child}-level (e.g. product, brand or category) breakdowns, or aggregate the ${child} rows in a subquery first.`
    : `Aggregate ${tableName} before joining ${child}, aggregate the ${child} rows in a subquery first, or use EXISTS/IN instead of a join when ${child} is only needed as a filter.`;
  return (
    `Fan-out: ${aggregate} over ${tableName}.${columnName} while joining ${child} ` +
    `(one row per ${child} row via ${child}.${edge.childColumn} -> ${tableName}.${edge.parentColumn}) ` +
    `double-counts ${tableName} values. ${fix}`
  );
}

/**
 * Reject SUM/AVG over a parent-grain column when the same SELECT block also
 * joins a one-to-many child of that parent (child has a foreign key to it):
 * every parent value is repeated once per child row. COUNT/MIN/MAX are not
 * affected, and children referenced only inside EXISTS/IN subqueries live in a
 * different block. An aggregate that also references a column of the finest
 * joined table (e.g. SUM(line.Quantity * product.Price)) is at child grain and
 * is accepted.
 */
function validateFanOut(analysis, knownTables, promptContext) {
  const edges = collectForeignKeyEdges(promptContext);
  const checks = [];
  if (edges.length === 0) {
    return checks;
  }

  const { tokens } = analysis;
  const blockTables = new Map();
  for (const ref of analysis.tableRefs) {
    if (ref.kind !== 'table' || ref.schema || !knownTables.has(ref.name)) {
      continue;
    }
    if (!blockTables.has(ref.blockId)) {
      blockTables.set(ref.blockId, []);
    }
    blockTables.get(ref.blockId).push(ref);
  }

  for (const block of analysis.blocks) {
    const refs = blockTables.get(block.id) || [];
    if (refs.length < 2) {
      continue;
    }

    const aliasMap = new Map();
    for (const ref of refs) {
      aliasMap.set(ref.name, ref.name);
    }
    for (const ref of refs) {
      if (ref.alias) {
        aliasMap.set(ref.alias, ref.name);
      }
    }
    const blockTableNames = [...new Set(refs.map((ref) => ref.name))];
    const antiJoined = collectAntiJoinedTables(tokens, block.tokenIndexes, block.id, refs);
    const childEdgesOf = (tableName) =>
      edges.filter(
        (edge) =>
          edge.parentTable === tableName &&
          edge.childTable !== tableName &&
          blockTableNames.includes(edge.childTable) &&
          !antiJoined.has(edge.childTable)
      );

    for (const index of block.tokenIndexes) {
      const token = tokens[index];
      if (!isKeywordToken(token, ...FAN_OUT_AGGREGATES) || !isPunctToken(tokens[index + 1], '(')) {
        continue;
      }

      const group = analysis.groups[tokens[index + 1].groupId];
      const columnRefs = collectAggregateColumnRefs(tokens, group, block.id, aliasMap, blockTableNames, knownTables);
      if (columnRefs.length === 0) {
        continue;
      }

      const referencedTables = [...new Set(columnRefs.map((ref) => ref.tableName))];
      // The aggregate is at the grain of its finest referenced table; it is
      // safe when at least one referenced table has no joined child.
      if (referencedTables.some((tableName) => childEdgesOf(tableName).length === 0)) {
        checks.push({ aggregate: token.upper, tables: referencedTables, fanOut: false });
        continue;
      }

      const tableName = referencedTables[0];
      const [edge] = childEdgesOf(tableName);
      const { columnName } = columnRefs.find((ref) => ref.tableName === tableName);
      throw guardrailError(
        'FAN_OUT',
        describeFanOut({ aggregate: token.upper, tableName, columnName, edge, knownTables }),
        {
          aggregate: token.upper,
          table: tableName,
          column: columnName,
          childTable: edge.childTable,
          childColumn: edge.childColumn,
        }
      );
    }
  }

  return checks;
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
    // `ProductId IN (SELECT ... WHERE Quantity > 10)` is a subquery, not an ID
    // list; its numeric literals are not ProductIds.
    if (/\bSELECT\b/i.test(match[1])) {
      continue;
    }
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
      throw guardrailError(
        'MASTER_DATA_ID',
        `SQL references ProductId ${productId}, which was not in the resolved master-data candidates.`
      );
    }
  }

  return {
    candidateIds: [...candidateIds],
    productIdColumnNames,
    referencedIds: [...referencedIds],
  };
}

function validateResponseTableContract(response, tablesUsed, allowedTables, cteNames = new Set()) {
  if (!response || !Array.isArray(response.tables_used)) {
    return null;
  }

  const allowed = new Set(allowedTables || []);
  // CTE names are query-local, so a model that lists them in tables_used is not
  // claiming access to another table.
  const declared = [...new Set(response.tables_used)].filter((tableName) => !cteNames.has(tableName));
  const actual = [...new Set(tablesUsed || [])];

  for (const tableName of declared) {
    if (!allowed.has(tableName)) {
      throw guardrailError(
        'RESPONSE_TABLES',
        `Response tables_used includes table "${tableName}" outside the allowed table set.`
      );
    }
  }

  const missing = actual.filter((tableName) => !declared.includes(tableName));
  if (missing.length > 0) {
    throw guardrailError('RESPONSE_TABLES', `Response tables_used omitted SQL table(s): ${missing.join(', ')}.`);
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
  const { aliases, derivedTables, analysis } = extractTableContext(sql, knownTables);
  const cteNames = new Set(analysis.ctes.map((cte) => cte.name));
  const qualifiedColumns = validateQualifiedColumns(sql, knownTables, aliases, derivedTables);
  validateSuspiciousUnqualifiedIdentifiers(sql, knownTables, aliases, derivedTables);
  const joinChecks = validateJoinGuardrails(sql, knownTables, aliases, derivedTables, promptContext);
  const fanOutChecks = validateFanOut(analysis, knownTables, promptContext);
  const { checkedMetrics: metricChecks, warnings: metricWarnings } = validateMetricGuardrails(sql, promptContext);
  const masterDataChecks = validateMasterDataCandidateIds(sql, promptContext);

  return {
    columnChecks: {
      qualifiedColumns,
    },
    joinChecks,
    fanOutChecks,
    metricChecks,
    masterDataChecks,
    responseTableChecks: validateResponseTableContract(response, tablesUsed, allowedTables, cteNames),
    warnings: [...metricWarnings],
  };
}
