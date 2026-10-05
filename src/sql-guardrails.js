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

// Built-in MariaDB functions that models often write in mixed case
// (DateDiff, YearWeek, Coalesce). A call to one of these is not a hallucinated
// column, so the unqualified-identifier check skips it when it is followed by
// '('. Restricted functions are rejected earlier, by the safety layer.
const KNOWN_SQL_FUNCTIONS = new Set([
  // date and time
  'ADDDATE', 'ADDTIME', 'CONVERT_TZ', 'CURDATE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURTIME',
  'DATE', 'DATEDIFF', 'DATE_ADD', 'DATE_FORMAT', 'DATE_SUB', 'DAY', 'DAYNAME', 'DAYOFMONTH', 'DAYOFWEEK',
  'DAYOFYEAR', 'EXTRACT', 'FROM_DAYS', 'FROM_UNIXTIME', 'HOUR', 'LAST_DAY', 'LOCALTIME', 'LOCALTIMESTAMP',
  'MAKEDATE', 'MAKETIME', 'MICROSECOND', 'MINUTE', 'MONTH', 'MONTHNAME', 'NOW', 'PERIOD_ADD', 'PERIOD_DIFF',
  'QUARTER', 'SECOND', 'SEC_TO_TIME', 'STR_TO_DATE', 'SUBDATE', 'SUBTIME', 'SYSDATE', 'TIME', 'TIMEDIFF',
  'TIMESTAMP', 'TIMESTAMPADD', 'TIMESTAMPDIFF', 'TIME_FORMAT', 'TIME_TO_SEC', 'TO_DAYS', 'TO_SECONDS',
  'UNIX_TIMESTAMP', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'WEEK', 'WEEKDAY', 'WEEKOFYEAR', 'YEAR', 'YEARWEEK',
  // strings
  'ASCII', 'CHAR', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'CONCAT', 'CONCAT_WS', 'ELT', 'FIELD', 'FIND_IN_SET',
  'FORMAT', 'INSTR', 'LCASE', 'LEFT', 'LENGTH', 'LOCATE', 'LOWER', 'LPAD', 'LTRIM', 'MID', 'POSITION',
  'REGEXP_INSTR', 'REGEXP_REPLACE', 'REGEXP_SUBSTR', 'REPEAT', 'REPLACE', 'REVERSE', 'RIGHT', 'RPAD', 'RTRIM',
  'SPACE', 'SUBSTR', 'SUBSTRING', 'SUBSTRING_INDEX', 'TRIM', 'UCASE', 'UPPER',
  // numbers
  'ABS', 'CEIL', 'CEILING', 'EXP', 'FLOOR', 'GREATEST', 'LEAST', 'LN', 'LOG', 'LOG10', 'LOG2', 'MOD', 'PI',
  'POW', 'POWER', 'RAND', 'ROUND', 'SIGN', 'SQRT', 'TRUNCATE',
  // control flow and conversion
  'CAST', 'COALESCE', 'CONVERT', 'IF', 'IFNULL', 'ISNULL', 'NULLIF',
  // aggregates and window functions
  'AVG', 'BIT_AND', 'BIT_OR', 'BIT_XOR', 'COUNT', 'GROUP_CONCAT', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'MAX', 'MIN',
  'STD', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'SUM', 'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'CUME_DIST',
  'DENSE_RANK', 'FIRST_VALUE', 'LAG', 'LAST_VALUE', 'LEAD', 'MEDIAN', 'NTH_VALUE', 'NTILE', 'PERCENTILE_CONT',
  'PERCENTILE_DISC', 'PERCENT_RANK', 'RANK', 'ROW_NUMBER',
  // JSON
  'JSON_ARRAY', 'JSON_EXTRACT', 'JSON_OBJECT', 'JSON_UNQUOTE', 'JSON_VALUE',
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
    if (KNOWN_SQL_FUNCTIONS.has(upper) && /^\s*\(/.test(cleaned.slice(match.index + match[0].length))) {
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
 * - ENFORCED metrics (explicit phrases such as "net sales", "revenue",
 *   "quantity sold") each reject the SQL when none of their preferred columns
 *   is used. A word that only looks like a metric inside a longer name ("Sales
 *   Revenue" ledger account) is removed earlier, by span arbitration in
 *   buildSemanticPlan, so it never reaches this check.
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

  const metric = checkedMetrics.find((checked) => checked.enforcement === 'enforced' && !checked.satisfied);
  if (metric) {
    throw guardrailError(
      'METRIC_COLUMN',
      `SQL does not use a preferred column for semantic metric "${metric.name}" (${metric.preferredColumns.join(', ')}).`,
      { metric: metric.name, preferredColumns: metric.preferredColumns }
    );
  }

  // Only advisory metrics can be unsatisfied here.
  for (const checked of checkedMetrics) {
    if (checked.satisfied) {
      continue;
    }
    warnings.push({
      code: 'METRIC_COLUMN_NOT_USED',
      layer: 'guardrail',
      metric: checked.name,
      enforcement: checked.enforcement,
      reason: checked.enforcementReason || 'advisory_match',
      message: `SQL does not use a preferred column for ${checked.enforcement} semantic metric "${checked.name}" (${checked.preferredColumns.join(', ')}).`,
    });
  }

  return { checkedMetrics, warnings };
}

// ---------------------------------------------------------------------------
// Fan-out detection
// ---------------------------------------------------------------------------

const FAN_OUT_AGGREGATES = ['SUM', 'AVG'];

// Aggregates that collapse rows. A derived table or CTE that uses one (without
// OVER) is not a row-level pass-through of its source table.
const ROW_COLLAPSING_AGGREGATES = new Set([
  'SUM',
  'COUNT',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'STD',
  'STDDEV',
  'STDDEV_POP',
  'STDDEV_SAMP',
  'VARIANCE',
  'VAR_POP',
  'VAR_SAMP',
  'BIT_AND',
  'BIT_OR',
  'BIT_XOR',
  'JSON_ARRAYAGG',
  'JSON_OBJECTAGG',
]);

// Aggregates whose result ignores duplicate rows: the MAX of a parent value
// repeated once per child row is still that value.
const DUPLICATE_INSENSITIVE_AGGREGATES = new Set(['MIN', 'MAX', 'ANY_VALUE', 'BIT_AND', 'BIT_OR']);

// Words that end a WHERE clause at its own depth.
const WHERE_CLAUSE_TERMINATORS = new Set(['GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'WINDOW', 'INTO', 'FOR', 'LOCK', 'PROCEDURE']);

// Words that end a GROUP BY list at its own depth (WITH starts WITH ROLLUP).
const GROUP_BY_TERMINATORS = new Set(['HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'INTO', 'FOR', 'LOCK', 'PROCEDURE', 'WITH']);

// Words that end a join's ON condition at its own depth.
const ON_CLAUSE_TERMINATORS = new Set([
  ...WHERE_CLAUSE_TERMINATORS,
  'WHERE',
  'JOIN',
  'STRAIGHT_JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
]);

// Operators that combine values multiplicatively (higher precedence than + and
// every comparison/logical operator).
const MULTIPLICATIVE_OPERATORS = new Set(['*', '/', '%']);
const MULTIPLICATIVE_KEYWORDS = ['DIV', 'MOD'];
// Logical/comparison keywords that separate operands like an operator does.
const OPERAND_SEPARATOR_KEYWORDS = ['AND', 'OR', 'XOR', 'NOT', 'IS', 'LIKE', 'IN', 'BETWEEN', 'REGEXP', 'RLIKE', 'SOUNDS'];

function isPunctToken(token, value) {
  return Boolean(token) && token.type === 'punct' && token.value === value;
}

function isOperatorToken(token, ...values) {
  return Boolean(token) && token.type === 'operator' && (values.length === 0 || values.includes(token.value));
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

// The table's own spelling of `columnName` (column names are case-insensitive
// in MariaDB), or null when the table has no such column.
function findColumnName(knownTables, tableName, columnName) {
  const columns = knownTables.get(tableName);
  if (!columns || !columnName) {
    return null;
  }
  if (columns.has(columnName)) {
    return columnName;
  }
  const lower = String(columnName).toLowerCase();
  return [...columns].find((candidate) => candidate.toLowerCase() === lower) || null;
}

// tableName -> Map(columnName -> { primaryKey, allowNull }) for the prompt tables.
function collectColumnMetadata(promptContext = {}) {
  const metadata = new Map();
  for (const table of Array.isArray(promptContext.tables) ? promptContext.tables : []) {
    const tableName = table.tableName || table.name;
    if (!tableName) {
      continue;
    }
    const columns = new Map();
    for (const column of table.includedColumns || []) {
      columns.set(column.name, { primaryKey: Boolean(column.primaryKey), allowNull: column.allowNull !== false });
    }
    metadata.set(tableName, columns);
  }
  return metadata;
}

function primaryKeyColumnsOf(columnMetadata, tableName) {
  return [...(columnMetadata.get(tableName) || new Map()).entries()]
    .filter(([, column]) => column.primaryKey)
    .map(([columnName]) => columnName);
}

// Child -> parent foreign keys among the prompt tables. A one-to-one key (the
// child's FK column is its table's ONLY primary-key column) cannot fan out and
// is skipped; an FK that is just one part of a composite key is one-to-many.
function collectForeignKeyEdges(promptContext = {}, columnMetadata = collectColumnMetadata(promptContext)) {
  return (Array.isArray(promptContext.relationships) ? promptContext.relationships : [])
    .filter((relationship) => {
      if (!relationship.fromTable || !relationship.toTable || relationship.fromTable === relationship.toTable) {
        return false;
      }
      const keyColumns = primaryKeyColumnsOf(columnMetadata, relationship.fromTable);
      return !(keyColumns.length === 1 && keyColumns[0] === relationship.fromColumn);
    })
    .map((relationship) => ({
      childTable: relationship.fromTable,
      childColumn: relationship.fromColumn,
      parentTable: relationship.toTable,
      parentColumn: relationship.toColumn,
    }));
}

/**
 * Token-level helpers over one analyzed statement: skipping atoms (paren groups,
 * CASE ... END, function calls, qualified names) and splitting a token range
 * into top-level AND conjuncts.
 */
function createTokenWalker(analysis) {
  const { tokens, groups } = analysis;

  const closeOf = (index) => groups[tokens[index].groupId].close;

  // Index of the END that closes the CASE at `caseIndex` (same paren depth).
  const matchingCaseEnd = (caseIndex, end) => {
    let depth = 0;
    for (let index = caseIndex; index < end; index += 1) {
      const token = tokens[index];
      if (isPunctToken(token, '(')) {
        index = closeOf(index);
        continue;
      }
      if (isKeywordToken(token, 'CASE')) {
        depth += 1;
      } else if (isKeywordToken(token, 'END')) {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }
    return end - 1;
  };

  // Index just past the atom that starts at `index`.
  const nextAtom = (index, end) => {
    const token = tokens[index];
    if (isPunctToken(token, '(')) {
      return Math.min(end, closeOf(index) + 1);
    }
    if (isKeywordToken(token, 'CASE')) {
      return Math.min(end, matchingCaseEnd(index, end) + 1);
    }
    if (tokenIdentifierName(token) && isPunctToken(tokens[index + 1], '(')) {
      return Math.min(end, closeOf(index + 1) + 1);
    }
    return index + 1;
  };

  // Top-level AND conjuncts of [start, end) as [from, to) ranges, or null when
  // an OR / XOR / || sits at the top level (no conjunct is then guaranteed to
  // hold for every row). The AND of `x BETWEEN a AND b` is not a separator.
  const splitConjuncts = (start, end) => {
    const conjuncts = [];
    let conjunctStart = start;
    let pendingBetween = false;
    for (let index = start; index < end; ) {
      const token = tokens[index];
      if (isKeywordToken(token, 'OR', 'XOR') || isOperatorToken(token, '||')) {
        return null;
      }
      if (isKeywordToken(token, 'BETWEEN')) {
        pendingBetween = true;
      } else if (isKeywordToken(token, 'AND') || isOperatorToken(token, '&&')) {
        if (pendingBetween && isKeywordToken(token, 'AND')) {
          pendingBetween = false;
        } else {
          conjuncts.push([conjunctStart, index]);
          conjunctStart = index + 1;
        }
        index += 1;
        continue;
      }
      index = nextAtom(index, end);
    }
    conjuncts.push([conjunctStart, end]);
    return conjuncts;
  };

  // Top-level comma-separated items of [start, end) as [from, to) ranges.
  const splitList = (start, end) => {
    const items = [];
    let itemStart = start;
    for (let index = start; index < end; ) {
      if (isPunctToken(tokens[index], ',')) {
        items.push([itemStart, index]);
        itemStart = index + 1;
        index += 1;
        continue;
      }
      index = nextAtom(index, end);
    }
    items.push([itemStart, end]);
    return items;
  };

  // Strip parentheses that wrap the whole range: `((a.b IS NULL))` -> `a.b IS NULL`.
  const unwrapParens = ([start, end]) => {
    let from = start;
    let to = end;
    while (to - from >= 2 && isPunctToken(tokens[from], '(') && closeOf(from) === to - 1) {
      from += 1;
      to -= 1;
    }
    return [from, to];
  };

  // `q . col` at `index` -> { qualifier, column }.
  const qualifiedColumnAt = (index) => {
    const qualifier = tokenIdentifierName(tokens[index]);
    const column = tokenIdentifierName(tokens[index + 2]);
    if (qualifier && column && isPunctToken(tokens[index + 1], '.') && !tokens[index].afterDot) {
      return { qualifier, column };
    }
    return null;
  };

  return { tokens, groups, closeOf, nextAtom, splitConjuncts, splitList, unwrapParens, qualifiedColumnAt };
}

// The block's base paren group (null for the top-level statement).
function blockBaseGroup(block) {
  return block.scopeId === 'top' ? null : block.scopeId;
}

// [start, end) of the block's WHERE condition, or null.
function findWhereRange(walker, block) {
  const { tokens } = walker;
  const baseGroup = blockBaseGroup(block);
  const indexes = block.tokenIndexes;
  const whereAt = indexes.findIndex(
    (index) => isKeywordToken(tokens[index], 'WHERE') && tokens[index].parentGroupId === baseGroup
  );
  if (whereAt < 0) {
    return null;
  }
  const start = indexes[whereAt] + 1;
  let end = indexes[indexes.length - 1] + 1;
  for (const index of indexes.slice(whereAt + 1)) {
    const token = tokens[index];
    if (token.parentGroupId === baseGroup && isKeywordToken(token, ...WHERE_CLAUSE_TERMINATORS)) {
      end = index;
      break;
    }
  }
  return [start, end];
}

// [start, end) of the block's GROUP BY list (without WITH ROLLUP), or null.
function findGroupByRange(walker, block) {
  const { tokens } = walker;
  const baseGroup = blockBaseGroup(block);
  const indexes = block.tokenIndexes.filter((index) => tokens[index].parentGroupId === baseGroup);
  const groupAt = indexes.findIndex((index) => isKeywordToken(tokens[index], 'GROUP') && isKeywordToken(tokens[index + 1], 'BY'));
  if (groupAt < 0) {
    return null;
  }
  const start = indexes[groupAt] + 2;
  let end = block.tokenIndexes[block.tokenIndexes.length - 1] + 1;
  for (const index of indexes.slice(groupAt + 2)) {
    const token = tokens[index];
    const windowClause =
      isKeywordToken(token, 'WINDOW') && tokenIdentifierName(tokens[index + 1]) && isKeywordToken(tokens[index + 2], 'AS');
    if (isKeywordToken(token, ...GROUP_BY_TERMINATORS) || windowClause || isPunctToken(token, ';')) {
      end = index;
      break;
    }
  }
  return [start, end];
}

/**
 * The entries whose columns the block's GROUP BY keys read ([] when there is
 * no GROUP BY), or null when a key cannot be attributed to a joined table: a
 * positional `GROUP BY 1`, an output alias, an outer-scope column or an
 * unknown identifier.
 */
function collectGroupByOwners(walker, block, { qualifierEntries, unqualifiedOwners }) {
  const range = findGroupByRange(walker, block);
  if (!range) {
    return [];
  }
  const { tokens } = walker;
  const owners = [];
  for (const item of walker.splitList(range[0], range[1])) {
    const [start, end] = walker.unwrapParens(item);
    if (end - start === 1 && tokens[start].type === 'number') {
      return null;
    }
    for (let index = start; index < end; index += 1) {
      const token = tokens[index];
      if (token.blockId !== block.id) {
        continue;
      }
      const reference = walker.qualifiedColumnAt(index);
      if (reference) {
        const entry = qualifierEntries.get(reference.qualifier);
        if (!entry) {
          return null;
        }
        owners.push(entry);
        index += 2;
        continue;
      }
      const name = tokenIdentifierName(token);
      if (!name || token.afterDot || isPunctToken(tokens[index + 1], '(')) {
        continue;
      }
      const found = unqualifiedOwners(name);
      if (found.length === 1) {
        owners.push(found[0].entry);
      } else if (!(token.type === 'word' && SQL_KEYWORDS.has(token.upper))) {
        return null;
      }
    }
  }
  return owners;
}

// The join condition of a table reference: { on: [start, end) } for
// `ON <condition>`, { using: [columns] } for `USING (...)`, or null.
function findJoinCondition(walker, ref) {
  const { tokens } = walker;
  const baseGroup = tokens[ref.index].parentGroupId;

  // Skip the reference itself (a derived table's body, the alias) up to ON/USING.
  let cursor = ref.kind === 'derived' ? ref.close + 1 : ref.index + 1;
  while (cursor < tokens.length && tokens[cursor].parentGroupId === baseGroup && !isKeywordToken(tokens[cursor], 'ON', 'USING')) {
    if (isPunctToken(tokens[cursor], ',') || isKeywordToken(tokens[cursor], ...ON_CLAUSE_TERMINATORS)) {
      return null;
    }
    cursor = walker.nextAtom(cursor, tokens.length);
  }

  if (isKeywordToken(tokens[cursor], 'USING') && isPunctToken(tokens[cursor + 1], '(')) {
    const columns = [];
    for (let index = cursor + 2; index < walker.closeOf(cursor + 1); index += 1) {
      const name = tokenIdentifierName(tokens[index]);
      if (name) {
        columns.push(name);
      }
    }
    return { using: columns };
  }
  if (!isKeywordToken(tokens[cursor], 'ON')) {
    return null;
  }

  // The condition runs to the next join / FROM-list comma / clause keyword at
  // the same depth (nextAtom skips nested groups, so a ')' here closes ours).
  const start = cursor + 1;
  let end = start;
  while (end < tokens.length) {
    const token = tokens[end];
    if (isPunctToken(token, ')') || isPunctToken(token, ',') || isPunctToken(token, ';') || isKeywordToken(token, ...ON_CLAUSE_TERMINATORS)) {
      break;
    }
    end = walker.nextAtom(end, tokens.length);
  }
  return { on: [start, end] };
}

// One side of a top-level `a = b`: { qualifier, column }, { column } for an
// unqualified column, { constant: true } for a number or string literal, or
// null for any other expression.
function parseEqualityOperand(walker, range) {
  const { tokens } = walker;
  const [from, to] = walker.unwrapParens(range);
  if (to - from === 3) {
    return walker.qualifiedColumnAt(from);
  }
  if (to - from === 2 && isOperatorToken(tokens[from], '-', '+') && tokens[from + 1].type === 'number') {
    return { constant: true };
  }
  if (to - from !== 1) {
    return null;
  }
  const token = tokens[from];
  if (token.type === 'number' || token.type === 'string') {
    return { constant: true };
  }
  const name = tokenIdentifierName(token);
  return name && !token.afterDot && !(token.type === 'word' && SQL_KEYWORDS.has(token.upper)) ? { column: name } : null;
}

// Top-level `a = b` AND-conjuncts of [start, end) as [left, right] operand
// pairs (none when an OR sits at the top level).
function collectEqualities(walker, start, end) {
  const pairs = [];
  for (const conjunct of walker.splitConjuncts(start, end) || []) {
    const [from, to] = walker.unwrapParens(conjunct);
    const equals = [];
    for (let index = from; index < to; index = walker.nextAtom(index, to)) {
      if (isOperatorToken(walker.tokens[index], '=')) {
        equals.push(index);
      }
    }
    if (equals.length !== 1) {
      continue;
    }
    const left = parseEqualityOperand(walker, [from, equals[0]]);
    const right = parseEqualityOperand(walker, [equals[0] + 1, to]);
    if (left && right) {
      pairs.push([left, right]);
    }
  }
  return pairs;
}

/**
 * Equalities that restrict the rows of a block's joined references, each as
 * { pair, appliesTo }: top-level WHERE conjuncts and the conditions of inner
 * joins filter every joined row (appliesTo null); a LEFT JOIN's condition only
 * restricts the rows of the reference it joins (appliesTo = that entry), since
 * the rows on its left are kept either way. RIGHT/NATURAL joins restrict
 * nothing here. `USING (col)` equates the joined reference's col with each
 * earlier entry's col.
 */
function collectRestrictingEqualities(walker, block, analysis, entries) {
  const found = [];
  const whereRange = findWhereRange(walker, block);
  if (whereRange) {
    for (const pair of collectEqualities(walker, whereRange[0], whereRange[1])) {
      found.push({ pair, appliesTo: null });
    }
  }

  for (const ref of analysis.tableRefs.filter((candidate) => candidate.blockId === block.id)) {
    const joinType = ref.joinType || 'INNER';
    const entry = entries.find((candidate) => candidate.ref === ref) || null;
    if (!['INNER', 'CROSS', 'LEFT'].includes(joinType) || (joinType === 'LEFT' && !entry)) {
      continue;
    }
    const condition = findJoinCondition(walker, ref);
    const appliesTo = joinType === 'LEFT' ? entry : null;
    if (condition?.on) {
      for (const pair of collectEqualities(walker, condition.on[0], condition.on[1])) {
        found.push({ pair, appliesTo });
      }
    } else if (condition?.using && entry) {
      for (const column of condition.using) {
        for (const earlier of entries.slice(0, entries.indexOf(entry))) {
          found.push({ pair: [{ qualifier: entry.qualifier, column }, { qualifier: earlier.qualifier, column }], appliesTo });
        }
      }
    }
  }
  return found;
}

// Columns of a joined reference that are equated in its own join condition
// (`ON q.col = x.y` as a top-level conjunct, or `USING (col)`): for every
// matched row they are non-NULL.
function collectJoinKeyColumns(walker, ref, alias) {
  const { tokens } = walker;
  const columns = new Set();
  const condition = findJoinCondition(walker, ref);
  if (condition?.using) {
    for (const name of condition.using) {
      columns.add(name);
    }
    return columns;
  }
  if (!condition) {
    return columns;
  }

  const [start, end] = condition.on;
  for (const conjunct of walker.splitConjuncts(start, end) || []) {
    const [from, to] = walker.unwrapParens(conjunct);
    if (to - from !== 7 || !isOperatorToken(tokens[from + 3], '=')) {
      continue;
    }
    for (const side of [from, from + 4]) {
      const reference = walker.qualifiedColumnAt(side);
      if (reference && reference.qualifier === alias) {
        columns.add(reference.column);
      }
    }
  }
  return columns;
}

/**
 * LEFT-joined references that are anti-joins: `LEFT JOIN child c ... WHERE
 * c.col IS NULL`, where the IS NULL test is a top-level AND conjunct of the
 * block's WHERE clause (not under OR, not in ON/SELECT/CASE) and `col` can only
 * be NULL for unmatched rows: the child's primary key, a NOT NULL column, or a
 * column equated in the join condition. Such a child keeps one row per parent.
 */
function collectAntiJoinedRefs(walker, block, entries, columnMetadata) {
  const antiJoined = new Set();
  const whereRange = findWhereRange(walker, block);
  if (!whereRange) {
    return antiJoined;
  }
  const conjuncts = walker.splitConjuncts(whereRange[0], whereRange[1]);
  if (!conjuncts) {
    return antiJoined;
  }

  const { tokens } = walker;
  for (const conjunct of conjuncts) {
    const [from, to] = walker.unwrapParens(conjunct);
    if (to - from !== 5 || !isKeywordToken(tokens[from + 3], 'IS') || !isKeywordToken(tokens[from + 4], 'NULL')) {
      continue;
    }
    const reference = walker.qualifiedColumnAt(from);
    const entry = reference && entries.find((candidate) => candidate.qualifier === reference.qualifier);
    if (!entry || entry.viaDerived || entry.ref.joinType !== 'LEFT') {
      continue;
    }
    const column = columnMetadata.get(entry.tableName)?.get(reference.column);
    const neverNullWhenMatched =
      Boolean(column && (column.primaryKey || !column.allowNull)) ||
      collectJoinKeyColumns(walker, entry.ref, entry.qualifier).has(reference.column);
    if (neverNullWhenMatched) {
      antiJoined.add(entry);
    }
  }
  return antiJoined;
}

/**
 * A derived table or CTE whose body is a plain row-level projection of exactly
 * one table (no GROUP BY, DISTINCT, row-collapsing aggregate, LIMIT or set
 * operator) has one row per source row, so for fan-out purposes it IS that
 * table: `JOIN (SELECT * FROM SalesDocumentLine) x` multiplies like the table.
 * Returns the source table name or null.
 */
function resolvePassThroughTable(walker, analysis, ref, knownTables, depth = 0) {
  if (depth > 5) {
    return null;
  }
  const { tokens } = walker;
  let openIndex = null;
  if (ref.kind === 'derived') {
    openIndex = ref.open;
  } else if (ref.kind === 'cte') {
    const cte = analysis.ctes.find(
      (candidate) =>
        candidate.name.toLowerCase() === String(ref.cteName || ref.name).toLowerCase() &&
        ref.index >= candidate.visibleFrom &&
        ref.index < candidate.visibleTo
    );
    openIndex = cte ? cte.bodyOpen : null;
  }
  if (openIndex === null || !isPunctToken(tokens[openIndex], '(')) {
    return null;
  }

  const scopeId = tokens[openIndex].groupId;
  const bodyBlocks = analysis.blocks.filter((block) => block.scopeId === scopeId);
  if (bodyBlocks.length !== 1) {
    return null;
  }
  const [block] = bodyBlocks;
  for (const index of block.tokenIndexes) {
    const token = tokens[index];
    if (token.parentGroupId !== scopeId) {
      continue;
    }
    if (isKeywordToken(token, 'DISTINCT', 'DISTINCTROW', 'LIMIT', 'HAVING')) {
      return null;
    }
    if (isKeywordToken(token, 'GROUP') && isKeywordToken(tokens[index + 1], 'BY')) {
      return null;
    }
    if (
      token.type === 'word' &&
      ROW_COLLAPSING_AGGREGATES.has(token.upper) &&
      isPunctToken(tokens[index + 1], '(') &&
      !isKeywordToken(tokens[walker.closeOf(index + 1) + 1], 'OVER')
    ) {
      return null;
    }
  }

  const bodyRefs = analysis.tableRefs.filter((candidate) => candidate.blockId === block.id);
  if (bodyRefs.length !== 1) {
    return null;
  }
  const [source] = bodyRefs;
  if (source.kind === 'table') {
    return !source.schema && knownTables.has(source.name) ? source.name : null;
  }
  return resolvePassThroughTable(walker, analysis, source, knownTables, depth + 1);
}

/**
 * Grain analysis of one aggregate argument. Each value is classified as:
 * - 'const': no column of this block (literals, other-scope subqueries),
 * - 'fine': at the grain of a table with no one-to-many child joined here,
 * - { coarse }: a column of a parent table whose child is joined here.
 * Additive combinations (+, -, comparisons, COALESCE/IFNULL/CASE arms, ...)
 * are coarse when any part is coarse: SUM(COALESCE(d.NetAmount, l.NetAmount))
 * still repeats d.NetAmount per line. A multiplicative term is fine when any
 * factor is fine: SUM(l.Quantity * p.Price) is a per-line value. WHEN/IF
 * conditions only filter rows and do not set the grain.
 */
function createGrainEvaluator(walker, { blockId, qualifierEntries, unqualifiedOwners, knownTables, isCoarse, isGroupedWithin }) {
  const { tokens } = walker;
  const references = [];

  const combineAdditive = (grains) => grains.find((grain) => grain.coarse) || (grains.includes('fine') ? 'fine' : 'const');
  const combineMultiplicative = (grains) =>
    grains.includes('fine') ? 'fine' : grains.find((grain) => grain.coarse) || 'const';

  const columnGrain = (entry, tableName, columnName) => {
    const coarse = isCoarse(tableName);
    references.push({ entry, tableName, columnName, coarse });
    return coarse ? { coarse: { tableName, columnName } } : 'fine';
  };

  // SUM(MAX(d.NetAmount)) OVER (): the inner, non-window MIN/MAX ignores the
  // repeated parent rows and yields one value per group. When every GROUP BY
  // key reads only that parent's columns (or there is no GROUP BY), the groups
  // are the ones the query has without the child join, so the outer windowed
  // SUM adds each value once per group, not once per child row. The parent key
  // itself is not required (GROUP BY d.CustomerId is fine), but a key from
  // another table (l.ProductId) splits a parent across groups and still fans
  // out. An inner SUM/AVG is not reduced and stays a fan-out.
  const isReducedPerParent = (nameToken, closeIndex, innerReferences) => {
    if (
      nameToken.type !== 'word' ||
      nameToken.afterDot ||
      !DUPLICATE_INSENSITIVE_AGGREGATES.has(nameToken.upper) ||
      isKeywordToken(tokens[closeIndex + 1], 'OVER')
    ) {
      return false;
    }
    const coarseEntries = new Set(innerReferences.filter((reference) => reference.coarse).map((reference) => reference.entry));
    return coarseEntries.size === 1 && isGroupedWithin([...coarseEntries][0]);
  };

  const splitAt = (start, end, isSeparator) => {
    const parts = [];
    let partStart = start;
    for (let index = start; index < end; ) {
      if (isSeparator(tokens[index], index === start ? null : tokens[index - 1])) {
        parts.push([partStart, index]);
        partStart = index + 1;
        index += 1;
        continue;
      }
      index = walker.nextAtom(index, end);
    }
    parts.push([partStart, end]);
    return parts;
  };

  const isMultiplicativeSeparator = (token) =>
    (token.type === 'operator' && MULTIPLICATIVE_OPERATORS.has(token.value)) || isKeywordToken(token, ...MULTIPLICATIVE_KEYWORDS);
  // A sign right after another operator (or at the start) is unary and binds
  // to its operand: `l.Quantity * -d.Rate` is one multiplicative term.
  const isAdditiveSeparator = (token, previous) => {
    if (isOperatorToken(token, '-', '+') && (!previous || previous.type === 'operator' || isPunctToken(previous, ',') || isKeywordToken(previous, ...OPERAND_SEPARATOR_KEYWORDS, ...MULTIPLICATIVE_KEYWORDS))) {
      return false;
    }
    return (
      (token.type === 'operator' && !MULTIPLICATIVE_OPERATORS.has(token.value)) ||
      isPunctToken(token, ',') ||
      isKeywordToken(token, ...OPERAND_SEPARATOR_KEYWORDS)
    );
  };

  let evaluateExpression;

  const evaluateCase = (caseIndex, endIndex) => {
    // Arms are the THEN and ELSE expressions; the CASE operand and the WHEN
    // conditions are skipped.
    const arms = [];
    let armStart = null;
    for (let index = caseIndex + 1; index < endIndex; ) {
      const token = tokens[index];
      if (isKeywordToken(token, 'WHEN', 'ELSE')) {
        if (armStart !== null) {
          arms.push([armStart, index]);
        }
        armStart = isKeywordToken(token, 'ELSE') ? index + 1 : null;
        index += 1;
        continue;
      }
      if (isKeywordToken(token, 'THEN')) {
        armStart = index + 1;
        index += 1;
        continue;
      }
      index = walker.nextAtom(index, endIndex);
    }
    if (armStart !== null) {
      arms.push([armStart, endIndex]);
    }
    return combineAdditive(arms.map(([from, to]) => evaluateExpression(from, to)));
  };

  const evaluateCall = (nameToken, openIndex) => {
    const closeIndex = walker.closeOf(openIndex);
    let args = splitAt(openIndex + 1, closeIndex, (token) => isPunctToken(token, ','));
    if (nameToken.type === 'word' && nameToken.upper === 'IF' && args.length === 3) {
      args = args.slice(1);
    }
    const firstReference = references.length;
    const grain = combineAdditive(args.map(([from, to]) => evaluateExpression(from, to)));
    if (grain.coarse && isReducedPerParent(nameToken, closeIndex, references.slice(firstReference))) {
      return 'fine';
    }
    return grain;
  };

  const evaluateFactor = (start, end) => {
    const grains = [];
    for (let index = start; index < end; ) {
      const token = tokens[index];
      const next = walker.nextAtom(index, end);
      if (token.blockId !== blockId) {
        index = next;
        continue;
      }
      if (isPunctToken(token, '(')) {
        grains.push(evaluateExpression(index + 1, walker.closeOf(index)));
      } else if (isKeywordToken(token, 'CASE')) {
        grains.push(evaluateCase(index, next - 1));
      } else if (tokenIdentifierName(token) && isPunctToken(tokens[index + 1], '(')) {
        grains.push(evaluateCall(token, index + 1));
      } else if (walker.qualifiedColumnAt(index)) {
        const { qualifier, column } = walker.qualifiedColumnAt(index);
        const entry = qualifierEntries.get(qualifier);
        if (entry && (entry.viaDerived || knownTables.get(entry.tableName)?.has(column))) {
          grains.push(columnGrain(entry, entry.tableName, column));
        }
        index += 3;
        continue;
      } else if (tokenIdentifierName(token) && !token.afterDot) {
        // Unqualified column, plain or backtick-quoted; MariaDB column names are
        // case-insensitive (`grossamount` is SalesDocument.GrossAmount).
        const owners = unqualifiedOwners(tokenIdentifierName(token));
        if (owners.length === 1) {
          grains.push(columnGrain(owners[0].entry, owners[0].entry.tableName, owners[0].columnName));
        }
      }
      index = next;
    }
    return combineAdditive(grains);
  };

  const evaluateTerm = (start, end) =>
    combineMultiplicative(splitAt(start, end, isMultiplicativeSeparator).map(([from, to]) => evaluateFactor(from, to)));

  evaluateExpression = (start, end) =>
    combineAdditive(splitAt(start, end, isAdditiveSeparator).map(([from, to]) => evaluateTerm(from, to)));

  return { evaluateExpression, references };
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
 * Reject SUM/AVG whose value is at a parent table's grain when the same SELECT
 * block also joins a one-to-many child of that parent (the child has a foreign
 * key to it): every parent value is repeated once per child row. COUNT/MIN/MAX
 * are not affected, children referenced only inside EXISTS/IN subqueries live
 * in a different block, an anti-joined child (LEFT JOIN ... WHERE key IS NULL)
 * keeps one row per parent, and a derived table or CTE that merely projects a
 * child table counts as that child.
 */
function validateFanOut(analysis, knownTables, promptContext) {
  const columnMetadata = collectColumnMetadata(promptContext);
  const edges = collectForeignKeyEdges(promptContext, columnMetadata);
  const checks = [];
  if (edges.length === 0) {
    return checks;
  }

  const walker = createTokenWalker(analysis);
  const { tokens } = analysis;

  for (const block of analysis.blocks) {
    const entries = [];
    for (const ref of analysis.tableRefs.filter((candidate) => candidate.blockId === block.id)) {
      if (ref.kind === 'table' && !ref.schema && knownTables.has(ref.name)) {
        entries.push({ ref, tableName: ref.name, qualifier: ref.alias || ref.name, viaDerived: false });
      } else if (ref.kind === 'derived' || ref.kind === 'cte') {
        const tableName = resolvePassThroughTable(walker, analysis, ref, knownTables);
        const qualifier = ref.alias || (ref.kind === 'cte' ? ref.name : null);
        if (tableName && qualifier) {
          entries.push({ ref, tableName, qualifier, viaDerived: true });
        }
      }
    }
    if (entries.length < 2) {
      continue;
    }

    const antiJoined = collectAntiJoinedRefs(walker, block, entries, columnMetadata);

    const qualifierEntries = new Map();
    for (const entry of entries) {
      qualifierEntries.set(entry.qualifier, entry);
      if (!entry.viaDerived && !qualifierEntries.has(entry.tableName)) {
        qualifierEntries.set(entry.tableName, entry);
      }
    }
    // One joined table per name that has an unqualified `name` column, with the
    // table's spelling of it.
    const unqualifiedOwners = (name) => {
      const owners = new Map();
      for (const entry of entries) {
        const columnName = entry.viaDerived ? null : findColumnName(knownTables, entry.tableName, name);
        if (columnName && !owners.has(entry.tableName)) {
          owners.set(entry.tableName, { entry, columnName });
        }
      }
      return [...owners.values()];
    };
    // A joined child whose whole primary key is pinned to constants or to the
    // parent's columns (`LEFT JOIN SalesDocumentLine l ON l.SalesDocumentId =
    // d.SalesDocumentId AND l.SalesDocumentLineId = 1`) has at most one row
    // per parent row, so it cannot repeat the parent's values.
    let restrictingEqualities;
    const pinnedColumns = (entry, parentTable) => {
      if (!restrictingEqualities) {
        restrictingEqualities = collectRestrictingEqualities(walker, block, analysis, entries);
      }
      const resolve = (operand) => {
        if (operand.constant) {
          return operand;
        }
        if (operand.qualifier) {
          const owner = qualifierEntries.get(operand.qualifier);
          const columnName = owner && (owner.viaDerived ? operand.column : findColumnName(knownTables, owner.tableName, operand.column));
          return columnName ? { entry: owner, columnName } : null;
        }
        const owners = unqualifiedOwners(operand.column);
        return owners.length === 1 ? owners[0] : null;
      };
      const pinned = new Set();
      for (const { pair, appliesTo } of restrictingEqualities) {
        if (appliesTo && appliesTo !== entry) {
          continue;
        }
        const [left, right] = pair.map(resolve);
        for (const [side, other] of [
          [left, right],
          [right, left],
        ]) {
          if (side?.entry === entry && other && (other.constant || (other.entry !== entry && other.entry.tableName === parentTable))) {
            pinned.add(side.columnName);
          }
        }
      }
      return pinned;
    };
    const restrictedToOneRow = (entry, parentTable) => {
      if (entry.viaDerived) {
        return false;
      }
      const keyColumns = primaryKeyColumnsOf(columnMetadata, entry.tableName);
      const pinned = keyColumns.length > 0 ? pinnedColumns(entry, parentTable) : null;
      return Boolean(pinned) && keyColumns.every((columnName) => pinned.has(columnName));
    };
    const childEdgesOf = (tableName) =>
      edges.filter(
        (edge) =>
          edge.parentTable === tableName &&
          edge.childTable !== tableName &&
          entries.some(
            (entry) => entry.tableName === edge.childTable && !antiJoined.has(entry) && !restrictedToOneRow(entry, tableName)
          )
      );

    let groupByOwners;
    const isGroupedWithin = (entry) => {
      if (groupByOwners === undefined) {
        groupByOwners = collectGroupByOwners(walker, block, { qualifierEntries, unqualifiedOwners });
      }
      return Array.isArray(groupByOwners) && groupByOwners.every((owner) => owner === entry);
    };

    for (const index of block.tokenIndexes) {
      const token = tokens[index];
      if (!isKeywordToken(token, ...FAN_OUT_AGGREGATES) || !isPunctToken(tokens[index + 1], '(')) {
        continue;
      }

      const group = analysis.groups[tokens[index + 1].groupId];
      const evaluator = createGrainEvaluator(walker, {
        blockId: block.id,
        qualifierEntries,
        unqualifiedOwners,
        knownTables,
        isCoarse: (tableName) => childEdgesOf(tableName).length > 0,
        isGroupedWithin,
      });
      const grain = evaluator.evaluateExpression(group.open + 1, group.close);
      if (evaluator.references.length === 0) {
        continue;
      }

      const referencedTables = [...new Set(evaluator.references.map((reference) => reference.tableName))];
      if (!grain.coarse) {
        checks.push({ aggregate: token.upper, tables: referencedTables, fanOut: false });
        continue;
      }

      const { tableName, columnName } = grain.coarse;
      const [edge] = childEdgesOf(tableName);
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
  const actual = [...new Set(tablesUsed || [])];
  // CTE names are query-local (and case-insensitive), so a model that lists them
  // in tables_used is not claiming access to another table. A name that is also
  // a physical table the SQL reads (`WITH Customer AS (SELECT ... FROM
  // Customer)`) stays declared.
  const lowerCteNames = new Set([...cteNames].map((name) => String(name).toLowerCase()));
  const declared = [...new Set(response.tables_used)].filter(
    (tableName) => actual.includes(tableName) || !lowerCteNames.has(String(tableName).toLowerCase())
  );

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
