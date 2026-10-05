import {
  analyzeSqlStructure,
  isKeywordToken,
  stripSqlTokens,
  tokenizeSql,
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

const DERIVED_TABLE_PREFIX = '__derived_table__:';

// Modifiers between SELECT and the select list.
const SELECT_OPTION_WORDS = [
  'ALL',
  'DISTINCT',
  'DISTINCTROW',
  'HIGH_PRIORITY',
  'STRAIGHT_JOIN',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT',
  'SQL_CACHE',
  'SQL_NO_CACHE',
  'SQL_CALC_FOUND_ROWS',
];

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

/**
 * Name resolution per SELECT block, the way MariaDB 10.6 scopes it (verified
 * on the server):
 * - a block sees the tables, derived tables and CTE references of its own FROM
 *   clause, then those of the enclosing blocks, innermost first, so a
 *   correlated subquery can use an outer alias unless its own FROM shadows it;
 * - a derived table or CTE body sees nothing outside itself, and UNION
 *   branches do not see each other's FROM;
 * - a reference is qualified by its alias, or by its name as written when it
 *   has none. Table names and aliases are case-sensitive
 *   (lower_case_table_names=0); a CTE is found case-insensitively, but its
 *   columns are then qualified by the spelling used in FROM (`FROM X` ->
 *   `X.col`, while `x.col` is unknown).
 * Derived tables and CTEs resolve to DERIVED_TABLE_PREFIX + a per-body key, so
 * two derived tables that share an alias in different scopes stay distinct.
 */
function buildRelationModel(analysis, knownTables, { primaryKeyOf = () => [] } = {}) {
  const { tokens, groups } = analysis;
  const blocksById = new Map(analysis.blocks.map((block) => [block.id, block]));
  const bodies = new Map();
  const bodyGroups = new Set();

  // Derived tables and CTEs, by key; their columns are projected below, once
  // every block's bindings are known.
  const relationOfBody = (openIndex, label, columnList = null) => {
    const key = `${label}@${openIndex}`;
    if (!bodies.has(key)) {
      bodies.set(key, { label, openIndex, columnList });
    }
    bodyGroups.add(tokens[openIndex].groupId);
    return DERIVED_TABLE_PREFIX + key;
  };

  // The innermost CTE that a `kind: 'cte'` reference names.
  const cteOf = (ref) => {
    const lower = String(ref.name).toLowerCase();
    return analysis.ctes
      .filter((cte) => cte.name.toLowerCase() === lower && ref.index >= cte.visibleFrom && ref.index < cte.visibleTo)
      .sort((left, right) => right.visibleFrom - left.visibleFrom)[0];
  };

  const bindRef = (ref) => {
    // The tokenizer only takes a word as an alias where MariaDB does, so a
    // non-reserved keyword such as `date` is an alias too.
    const alias = ref.alias || null;
    if (ref.kind === 'table' && !ref.schema && knownTables.has(ref.name)) {
      return [alias || ref.name, ref.name];
    }
    if (ref.kind === 'cte') {
      const cte = cteOf(ref);
      if (!cte) {
        return null;
      }
      return [alias || ref.name, relationOfBody(cte.bodyOpen, cte.name, cte.columns)];
    }
    if (ref.kind === 'derived') {
      const relation = relationOfBody(ref.open, alias || 'derived');
      return alias ? [alias, relation] : null;
    }
    return null;
  };

  const bindings = new Map();
  const relationOfRef = new Map();
  for (const ref of analysis.tableRefs) {
    const binding = bindRef(ref);
    if (!binding) {
      continue;
    }
    relationOfRef.set(ref, binding[1]);
    if (!bindings.has(ref.blockId)) {
      bindings.set(ref.blockId, new Map());
    }
    const blockBindings = bindings.get(ref.blockId);
    if (!blockBindings.has(binding[0])) {
      blockBindings.set(binding[0], binding[1]);
    }
  }
  // CTEs that are declared but never referenced still get their columns parsed.
  for (const cte of analysis.ctes) {
    relationOfBody(cte.bodyOpen, cte.name, cte.columns);
  }

  const enclosingBlock = (blockId) => {
    const block = blocksById.get(blockId);
    if (!block || block.scopeId === 'top' || bodyGroups.has(block.scopeId)) {
      return null;
    }
    return tokens[groups[block.scopeId].open].blockId;
  };

  // Table name or derived-relation name that `qualifier` denotes in a block.
  const resolve = (blockId, qualifier) => {
    for (let current = blockId; current; current = enclosingBlock(current)) {
      const relation = bindings.get(current)?.get(qualifier);
      if (relation) {
        return relation;
      }
    }
    return null;
  };

  const derivedTables = new Map();
  const walker = createTokenWalker(analysis);
  const projectRelation = (relationName) => {
    const key = derivedAliasFromTableName(relationName);
    if (!derivedTables.has(key)) {
      // A body that (indirectly) reads itself projects nothing.
      derivedTables.set(key, {
        label: bodies.get(key).label,
        columns: new Set(),
        origins: new Map(),
        orderedColumns: [],
        sourceTables: new Set(),
        blockId: null,
        uniqueness: null,
      });
      derivedTables.set(key, { label: bodies.get(key).label, ...projectBody(bodies.get(key)) });
    }
    return derivedTables.get(key);
  };

  // The columns a relation exposes, each with the table columns it comes from.
  const relationColumns = (relationName) => {
    if (isDerivedTableName(relationName)) {
      return projectRelation(relationName).orderedColumns.filter(Boolean);
    }
    return [...(knownTables.get(relationName) || [])].map((columnName) => ({
      outputName: columnName,
      origins: [{ tableName: relationName, columnName }],
    }));
  };
  const columnOrigins = (relationName, columnName) => {
    if (isDerivedTableName(relationName)) {
      const relation = projectRelation(relationName);
      return relation.origins.get(findDerivedColumnName(relation, columnName)) || [];
    }
    const canonical = findColumnName(knownTables, relationName, columnName);
    return canonical ? [{ tableName: relationName, columnName: canonical }] : [];
  };
  const hasColumn = (relationName, columnName) =>
    isDerivedTableName(relationName)
      ? Boolean(findDerivedColumnName(projectRelation(relationName), columnName))
      : Boolean(findColumnName(knownTables, relationName, columnName));

  // What an expression reads, so GROUP BY keys can be matched with select
  // items: `col:<qualifier>.<column>` for a column of one FROM reference, the
  // normalized token text otherwise.
  const columnKey = (qualifier, columnName) => `col:${qualifier}.${String(columnName).toLowerCase()}`;
  const expressionKey = (block, from, to) => {
    const qualified = to - from === 3 ? walker.qualifiedColumnAt(from) : null;
    if (qualified) {
      return columnKey(qualified.qualifier, qualified.column);
    }
    const name = to - from === 1 && !tokens[from].afterDot ? tokenIdentifierName(tokens[from]) : null;
    if (name) {
      const owners = [...(bindings.get(block.id) || new Map())].filter(([, relationName]) => hasColumn(relationName, name));
      return owners.length === 1 ? columnKey(owners[0][0], name) : `name:${name.toLowerCase()}`;
    }
    const text = [];
    for (let index = from; index < to; index += 1) {
      const token = tokens[index];
      text.push(token.type === 'word' ? (token.afterDot ? token.value.toLowerCase() : token.upper) : tokenIdentifierName(token) ?? token.value);
    }
    return `expr:${text.join(' ')}`;
  };
  // The relation's own spelling of a column it has, or null.
  const relationColumnName = (relationName, columnName) =>
    isDerivedTableName(relationName)
      ? findDerivedColumnName(projectRelation(relationName), columnName)
      : findColumnName(knownTables, relationName, columnName);
  // A select item that copies one column of a FROM reference records it as its
  // source: { qualifier, relationName, columnName }.
  const sourceOf = (qualifier, relationName, columnName) => {
    const canonical = relationName ? relationColumnName(relationName, columnName) : null;
    return canonical ? { qualifier, relationName, columnName: canonical } : null;
  };
  const withKeys = (qualifier, relationName, columns) =>
    columns.map((column) => ({
      ...column,
      key: columnKey(qualifier, column.outputName),
      source: { qualifier, relationName, columnName: column.outputName },
    }));

  // One select-list item: { outputName, origins, key, source } (outputName null
  // for an unnamed expression, source null unless it copies one column), or
  // the expanded columns of `*` / `q.*`.
  const projectItem = (block, [from, to]) => {
    const blockBindings = bindings.get(block.id) || new Map();
    if (to - from === 1 && isOperatorToken(tokens[from], '*')) {
      return [...blockBindings].flatMap(([qualifier, relationName]) => withKeys(qualifier, relationName, relationColumns(relationName)));
    }
    if (to - from === 3 && tokenIdentifierName(tokens[from]) && isPunctToken(tokens[from + 1], '.') && isOperatorToken(tokens[from + 2], '*')) {
      const qualifier = tokenIdentifierName(tokens[from]);
      const relationName = resolve(block.id, qualifier);
      return relationName ? withKeys(qualifier, relationName, relationColumns(relationName)) : [];
    }

    let alias = null;
    let end = to;
    const last = tokens[to - 1];
    const previous = tokens[to - 2];
    if (to - from >= 3 && isKeywordToken(previous, 'AS') && (tokenIdentifierName(last) || last.type === 'string')) {
      alias = last.type === 'string' ? last.value.slice(1, -1) : tokenIdentifierName(last);
      end = to - 2;
    } else if (to - from >= 2) {
      alias = trailingAliasName(tokens, from, to);
      end = alias === null ? to : to - 1;
    }

    const key = expressionKey(block, from, end);
    const qualified = end - from === 3 ? walker.qualifiedColumnAt(from) : null;
    if (qualified) {
      const relationName = resolve(block.id, qualified.qualifier);
      return [
        {
          outputName: alias || qualified.column,
          origins: relationName ? columnOrigins(relationName, qualified.column) : [],
          key,
          source: sourceOf(qualified.qualifier, relationName, qualified.column),
        },
      ];
    }
    const name = end - from === 1 && !tokens[from].afterDot ? tokenIdentifierName(tokens[from]) : null;
    if (name) {
      const owners = [...blockBindings].filter(([, relationName]) => hasColumn(relationName, name));
      const [owner] = owners.length === 1 ? owners : [];
      return [
        {
          outputName: alias || name,
          origins: owner ? columnOrigins(owner[1], name) : [],
          key,
          source: owner ? sourceOf(owner[0], owner[1], name) : null,
        },
      ];
    }
    return [{ outputName: alias, origins: [], key, source: null }];
  };

  // Positions of the select items each GROUP BY key matches: the same column
  // or expression, a position (`GROUP BY 1`) or an output alias that is not a
  // FROM column. An empty list means the key is not projected.
  const groupKeyPositions = (block, projected) => {
    const range = findGroupByRange(walker, block);
    if (!range) {
      return null;
    }
    return walker.splitList(range[0], range[1]).map((item) => {
      let [from, to] = walker.unwrapParens(item);
      if (to - from > 1 && isKeywordToken(tokens[to - 1], 'ASC', 'DESC')) {
        to -= 1;
      }
      if (to - from === 1 && tokens[from].type === 'number') {
        const position = Number(tokens[from].value) - 1;
        return projected[position] ? [position] : [];
      }
      const key = expressionKey(block, from, to);
      const matches = (column) => column.key === key || (key.startsWith('name:') && column.outputName?.toLowerCase() === key.slice(5));
      return projected.flatMap((column, position) => (matches(column) ? [position] : []));
    });
  };

  // Columns of a derived table or CTE body: the select list of its first SELECT
  // block, resolved against that block's FROM (which may name earlier CTEs),
  // renamed positionally by a CTE column list. Also records the tables the
  // body reads and what makes its rows unique (see isDerivedUniqueOn).
  const projectBody = ({ openIndex, columnList }) => {
    const scopeId = tokens[openIndex].groupId;
    const bodyBlocks = analysis.blocks.filter((candidate) => candidate.scopeId === scopeId);
    const [block] = bodyBlocks;
    const selectList = block ? findSelectListRange(walker, block) : null;
    const projected = [];
    for (const item of selectList ? walker.splitList(selectList.start, selectList.end) : []) {
      projected.push(...projectItem(block, item));
    }

    const renamed = Array.isArray(columnList) && columnList.length > 0
      ? columnList.map((outputName, index) => ({ outputName, origins: projected[index]?.origins || [], source: projected[index]?.source || null }))
      : projected.map((column) => (column.outputName ? { outputName: column.outputName, origins: column.origins, source: column.source } : null));
    const columns = new Set();
    const origins = new Map();
    for (const column of renamed.filter(Boolean)) {
      columns.add(column.outputName);
      origins.set(column.outputName, column.origins);
    }

    const sourceTables = new Set();
    for (const ref of analysis.tableRefs.filter((candidate) => bodyBlocks.some((bodyBlock) => bodyBlock.id === candidate.blockId))) {
      const relationName = relationOfRef.get(ref);
      if (relationName && isDerivedTableName(relationName)) {
        projectRelation(relationName).sourceTables.forEach((tableName) => sourceTables.add(tableName));
      } else if (relationName) {
        sourceTables.add(relationName);
      }
    }

    let uniqueness = null;
    if (selectList && bodyBlocks.length === 1) {
      uniqueness = describeUniqueness(block, selectList, projected, renamed);
    } else if (selectList && bodyBlocks.slice(1).every(isDistinctSetOperation)) {
      // UNION [DISTINCT] (and INTERSECT / EXCEPT without ALL) removes
      // duplicate rows: the result is unique on all its output columns.
      uniqueness = { singleRow: false, keys: [renamed.map((column) => (column ? [column.outputName] : []))] };
    }
    return { columns, origins, orderedColumns: renamed, sourceTables, uniqueness };
  };

  // Whether a block after the first of a body is joined by a duplicate-removing
  // set operator (not UNION ALL, EXCEPT ALL or INTERSECT ALL).
  const isDistinctSetOperation = (setBlock) => {
    const operatorIndex = setBlock.tokenIndexes[0];
    return isKeywordToken(tokens[operatorIndex], 'UNION', 'INTERSECT', 'EXCEPT') && !isKeywordToken(tokens[operatorIndex + 1], 'ALL');
  };

  /**
   * What makes a single-SELECT body's rows unique, as { singleRow, keys }:
   * singleRow when it returns at most one row (an aggregate without GROUP BY,
   * or LIMIT 0/1); each key is a list of components, each the output names
   * that carry one key value, and the rows are unique on any key whose every
   * component is pinned (see isDerivedUniqueOn):
   * - the GROUP BY keys (a key that is not projected has no names),
   * - every output column of a DISTINCT select list,
   * - for a row-level pass-through of one table, its primary key,
   * - for a row-level pass-through of one derived table or CTE, that
   *   relation's own keys, through the columns that copy them.
   */
  const describeUniqueness = (block, selectList, projected, renamed) => {
    const groupKeys = groupKeyPositions(block, projected);
    const aggregated = block.tokenIndexes.some(
      (index) =>
        isKeywordToken(tokens[index], ...ROW_COLLAPSING_AGGREGATES) &&
        isPunctToken(tokens[index + 1], '(') &&
        !isKeywordToken(tokens[walker.closeOf(index + 1) + 1], 'OVER')
    );
    const limit = findLimitCount(walker, block);
    let singleRow = (aggregated && !groupKeys) || (limit !== null && limit <= 1);
    const keys = [];
    if (groupKeys) {
      keys.push(groupKeys.map((positions) => positions.map((position) => renamed[position]?.outputName).filter(Boolean)));
    }
    if (selectList.distinct) {
      keys.push(renamed.map((column) => (column ? [column.outputName] : [])));
    }

    const blockRefs = analysis.tableRefs.filter((candidate) => candidate.blockId === block.id);
    const relationName = blockRefs.length === 1 ? relationOfRef.get(blockRefs[0]) : null;
    if (!groupKeys && !aggregated && !selectList.distinct && relationName) {
      const copies = (columnName) =>
        renamed.filter((column) => column?.source?.relationName === relationName && column.source.columnName === columnName).map((column) => column.outputName);
      if (isDerivedTableName(relationName)) {
        const inner = projectRelation(relationName).uniqueness;
        if (inner) {
          singleRow = singleRow || inner.singleRow;
          keys.push(...inner.keys.map((key) => key.map((component) => component.flatMap(copies))));
        }
      } else {
        const keyColumns = primaryKeyOf(relationName);
        if (keyColumns.length > 0) {
          keys.push(keyColumns.map(copies));
        }
      }
    }
    return { singleRow, keys };
  };

  for (const key of bodies.keys()) {
    projectRelation(DERIVED_TABLE_PREFIX + key);
  }

  // Lower-cased output names of a block's select list (aliases included).
  const outputNames = (blockId) => {
    const block = blocksById.get(blockId);
    const selectList = block ? findSelectListRange(walker, block) : null;
    const names = new Set();
    for (const item of selectList ? walker.splitList(selectList.start, selectList.end) : []) {
      for (const column of projectItem(block, item)) {
        if (column.outputName) {
          names.add(String(column.outputName).toLowerCase());
        }
      }
    }
    return names;
  };

  const qualifiers = new Set([...bindings.values()].flatMap((blockBindings) => [...blockBindings.keys()]));
  return {
    resolve,
    derivedTables,
    qualifiers,
    outputNames,
    relationOf: (ref) => relationOfRef.get(ref) || null,
  };
}

// Words in SQL_KEYWORDS that MariaDB also takes as a bare alias (`SELECT
// l.ProductId year`); END is left out, since `CASE ... THEN 1 END` must not
// read as an alias.
const ALIASABLE_KEYWORDS = new Set([
  'ABS',
  'AVG',
  'CAST',
  'COALESCE',
  'CONCAT',
  'COUNT',
  'DATE',
  'DATE_ADD',
  'DATE_FORMAT',
  'DATE_SUB',
  'DAY',
  'IFNULL',
  'LOWER',
  'MAX',
  'MIN',
  'MONTH',
  'NULLIF',
  'ROUND',
  'SUM',
  'UPPER',
  'YEAR',
]);

// The alias of the select item [from, to) written without AS (`expr alias`),
// or null: an identifier that is not a reserved word, or a string literal (not
// after another string, which concatenates), following a complete operand
// rather than an operator or operator keyword. The unit of `INTERVAL 1 DAY`
// and the literal of `DATE '2026-03-01'` are not aliases.
function trailingAliasName(tokens, from, to) {
  const last = tokens[to - 1];
  const previous = tokens[to - 2];
  let name;
  if (last.type === 'string') {
    if (previous.type === 'string' || isKeywordToken(previous, 'DATE', 'TIME', 'TIMESTAMP')) {
      return null;
    }
    name = last.value.slice(1, -1);
  } else {
    name = tokenIdentifierName(last);
    if (!name || last.afterDot || (last.type === 'word' && SQL_KEYWORDS.has(last.upper) && !ALIASABLE_KEYWORDS.has(last.upper))) {
      return null;
    }
    if (last.type === 'word' && SQL_KEYWORDS.has(last.upper)) {
      for (let index = from; index < to - 1; index += 1) {
        if (isKeywordToken(tokens[index], 'INTERVAL') && tokens[index].parentGroupId === last.parentGroupId) {
          return null;
        }
      }
    }
  }
  const complete =
    !isPunctToken(previous, '.') &&
    !isPunctToken(previous, ',') &&
    previous.type !== 'operator' &&
    !isKeywordToken(previous, ...OPERAND_SEPARATOR_KEYWORDS, ...MULTIPLICATIVE_KEYWORDS, 'AS', 'BINARY', 'COLLATE', 'DISTINCT', 'ESCAPE', 'INTERVAL', 'SELECT');
  return complete ? name : null;
}

// { start, end, distinct } of a SELECT block's select list (after SELECT and
// its options), or null.
function findSelectListRange(walker, block) {
  const { tokens } = walker;
  const baseGroup = blockBaseGroup(block);
  const indexes = block.tokenIndexes.filter((index) => tokens[index].parentGroupId === baseGroup);
  const selectAt = indexes.findIndex((index) => isKeywordToken(tokens[index], 'SELECT'));
  if (selectAt < 0) {
    return null;
  }
  let start = indexes[selectAt] + 1;
  let distinct = false;
  while (isKeywordToken(tokens[start], ...SELECT_OPTION_WORDS)) {
    distinct = distinct || isKeywordToken(tokens[start], 'DISTINCT', 'DISTINCTROW');
    start += 1;
  }
  let end = block.tokenIndexes[block.tokenIndexes.length - 1] + 1;
  for (const index of indexes.slice(selectAt + 1)) {
    if (index >= start && (isKeywordToken(tokens[index], 'FROM', ...WHERE_CLAUSE_TERMINATORS) || isPunctToken(tokens[index], ';'))) {
      end = index;
      break;
    }
  }
  return { start, end, distinct };
}

function extractTableContext(sql, knownTables, promptContext = {}) {
  const analysis = analyzeSqlStructure(String(sql || ''), { tolerant: true });
  const columnMetadata = collectColumnMetadata(promptContext);
  return {
    analysis,
    model: buildRelationModel(analysis, knownTables, { primaryKeyOf: (tableName) => primaryKeyColumnsOf(columnMetadata, tableName) }),
  };
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

// A derived table's or CTE's own spelling of `columnName`, or null. Like table
// columns, derived columns are found case-insensitively.
function findDerivedColumnName(relation, columnName) {
  const columns = relation?.columns;
  if (!columns || !columnName) {
    return null;
  }
  if (columns.has(columnName)) {
    return columnName;
  }
  const lower = String(columnName).toLowerCase();
  return [...columns].find((candidate) => candidate.toLowerCase() === lower) || null;
}

// The relation's own spelling of `columnName` (a table, or a derived table or
// CTE), or null when it has no such column.
function findRelationColumnName(knownTables, tableName, columnName, derivedTables = new Map()) {
  const derivedKey = derivedAliasFromTableName(tableName);
  if (derivedKey) {
    return findDerivedColumnName(derivedTables.get(derivedKey), columnName);
  }
  return findColumnName(knownTables, tableName, columnName);
}

function describeRelation(tableName, derivedTables) {
  const derivedKey = derivedAliasFromTableName(tableName);
  return derivedKey ? `derived table or CTE "${derivedTables.get(derivedKey)?.label ?? derivedKey}"` : `table "${tableName}"`;
}

// Each `qualifier.column` reference, resolved in the SELECT block it appears in.
function collectQualifiedColumnTokens(analysis) {
  const { tokens } = analysis;
  const references = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const qualifier = tokenIdentifierName(tokens[index]);
    const columnName = tokenIdentifierName(tokens[index + 2]);
    if (!qualifier || tokens[index].afterDot || !isPunctToken(tokens[index + 1], '.') || !columnName) {
      continue;
    }
    references.push({ index, blockId: tokens[index].blockId, qualifier, columnName });
    index += 2;
  }
  return references;
}

function validateQualifiedColumns(analysis, knownTables, model) {
  const usedColumns = [];

  for (const { blockId, qualifier, columnName: written } of collectQualifiedColumnTokens(analysis)) {
    const tableName = model.resolve(blockId, qualifier);
    if (!tableName) {
      throw guardrailError(
        'UNKNOWN_TABLE_ALIAS',
        `SQL references unknown table or alias "${qualifier}" in qualified column "${qualifier}.${written}".`
      );
    }
    const columnName = findRelationColumnName(knownTables, tableName, written, model.derivedTables);
    if (!columnName) {
      throw guardrailError(
        'UNKNOWN_COLUMN',
        `SQL references unknown column "${written}" on ${describeRelation(tableName, model.derivedTables)}.`
      );
    }

    usedColumns.push({ tableName, columnName, qualifier });
  }

  return usedColumns;
}

function validateSuspiciousUnqualifiedIdentifiers(sql, knownTables, qualifiers, derivedTables) {
  const cleaned = stripSqlLiterals(sql);
  const knownColumns = new Set([...knownTables.values()].flatMap((columns) => [...columns]));
  const knownIdentifiers = new Set([
    ...knownTables.keys(),
    ...qualifiers,
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

function resolveJoinColumnReferences(knownTables, tableName, columnName, derivedTables) {
  const derivedKey = derivedAliasFromTableName(tableName);
  if (!derivedKey) {
    return [{ tableName, columnName: findColumnName(knownTables, tableName, columnName) || columnName }];
  }

  const relation = derivedTables.get(derivedKey);
  return relation?.origins?.get(findDerivedColumnName(relation, columnName)) || [];
}

// Every `a.x = b.y` comparison, each side resolved in its own SELECT block.
function validateJoinGuardrails(analysis, knownTables, model, promptContext) {
  const relationshipKeys = collectRelationshipKeys(promptContext);
  const { tokens } = analysis;
  const { derivedTables } = model;
  const references = collectQualifiedColumnTokens(analysis);
  const checkedJoins = [];

  for (let position = 0; position + 1 < references.length; position += 1) {
    const left = references[position];
    const right = references[position + 1];
    if (!isOperatorToken(tokens[left.index + 3], '=') || right.index !== left.index + 4) {
      continue;
    }
    position += 1;

    const leftQualifier = left.qualifier;
    const leftTable = model.resolve(left.blockId, leftQualifier);
    const leftColumn = left.columnName;
    const rightQualifier = right.qualifier;
    const rightTable = model.resolve(right.blockId, rightQualifier);
    const rightColumn = right.columnName;

    if (!leftTable || !rightTable || leftTable === rightTable) {
      continue;
    }

    const leftReferences = resolveJoinColumnReferences(knownTables, leftTable, leftColumn, derivedTables);
    const rightReferences = resolveJoinColumnReferences(knownTables, rightTable, rightColumn, derivedTables);
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

// tableName -> Map(columnName -> { primaryKey, allowNull, type }) for the prompt tables.
function collectColumnMetadata(promptContext = {}) {
  const metadata = new Map();
  for (const table of Array.isArray(promptContext.tables) ? promptContext.tables : []) {
    const tableName = table.tableName || table.name;
    if (!tableName) {
      continue;
    }
    const columns = new Map();
    for (const column of table.includedColumns || []) {
      columns.set(column.name, { primaryKey: Boolean(column.primaryKey), allowNull: column.allowNull !== false, type: column.type || null });
    }
    metadata.set(tableName, columns);
  }
  return metadata;
}

// Character column types (Sequelize and SQL spellings). MariaDB compares such a
// column with a number numerically, so `name = 0` matches every non-numeric
// string and does not pin the column to one value.
const STRING_COLUMN_TYPE = /^(STRING|CHAR|VARCHAR|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CITEXT|ENUM|UUID)\b/i;

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

// The row count of the block's `LIMIT n`, `LIMIT offset, n` or `LIMIT n OFFSET
// m`, or null.
function findLimitCount(walker, block) {
  const { tokens } = walker;
  const baseGroup = blockBaseGroup(block);
  const limitIndex = block.tokenIndexes.find(
    (index) => tokens[index].parentGroupId === baseGroup && isKeywordToken(tokens[index], 'LIMIT')
  );
  if (limitIndex === undefined || tokens[limitIndex + 1]?.type !== 'number') {
    return null;
  }
  if (isPunctToken(tokens[limitIndex + 2], ',')) {
    return tokens[limitIndex + 3]?.type === 'number' ? Number(tokens[limitIndex + 3].value) : null;
  }
  return Number(tokens[limitIndex + 1].value);
}

/**
 * The entries whose columns the block's GROUP BY keys read ([] when there is
 * no GROUP BY), or null when a key cannot be attributed to a joined table: a
 * positional `GROUP BY 1`, an output alias (keyword-like ones such as `year`
 * too; GROUP BY prefers a FROM column of the same name, as MariaDB does), a
 * subquery, an outer-scope column or an unknown identifier.
 */
function collectGroupByOwners(walker, block, { qualifierEntries, unqualifiedOwners, outputNames }) {
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
        return null;
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
      } else if (found.length > 1 || outputNames.has(name.toLowerCase()) || !(token.type === 'word' && SQL_KEYWORDS.has(token.upper))) {
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
// unqualified column, { constant: true, numeric } for a number or string
// literal, or null for any other expression.
function parseEqualityOperand(walker, range) {
  const { tokens } = walker;
  const [from, to] = walker.unwrapParens(range);
  if (to - from === 3) {
    return walker.qualifiedColumnAt(from);
  }
  if (to - from === 2 && isOperatorToken(tokens[from], '-', '+') && tokens[from + 1].type === 'number') {
    return { constant: true, numeric: true };
  }
  if (to - from !== 1) {
    return null;
  }
  const token = tokens[from];
  if (token.type === 'number' || token.type === 'string') {
    return { constant: true, numeric: token.type === 'number' };
  }
  const name = tokenIdentifierName(token);
  return name && !token.afterDot && !(token.type === 'word' && SQL_KEYWORDS.has(token.upper)) ? { column: name } : null;
}

// Top-level `a = b` AND-conjuncts of [start, end) as [left, right] operand
// pairs (none when an OR sits at the top level). A parenthesized conjunct is
// split again: `ON (l.a = d.a AND l.k = 1)` holds both equalities.
function collectEqualities(walker, start, end) {
  const pairs = [];
  for (const conjunct of walker.splitConjuncts(start, end) || []) {
    const [from, to] = walker.unwrapParens(conjunct);
    if (from !== conjunct[0]) {
      pairs.push(...collectEqualities(walker, from, to));
      continue;
    }
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
 * Whether a derived table or CTE has at most one row per value of its `pinned`
 * output columns (those equated to constants or to the parent's columns), so
 * joining it cannot repeat a parent row: it returns at most one row, or every
 * component of one of its keys (see describeUniqueness in buildRelationModel)
 * is pinned. GROUP BY SalesDocumentId joined on SalesDocumentId qualifies, and
 * so does a CTE that filters or renames it; GROUP BY SalesDocumentId,
 * ProductId does not. DISTINCT, GROUP BY or LIMIT n alone do not make a child
 * unique per parent.
 */
function isDerivedUniqueOn(relation, pinned) {
  const uniqueness = relation?.uniqueness;
  if (!uniqueness) {
    return false;
  }
  return (
    uniqueness.singleRow ||
    uniqueness.keys.some((key) => key.length > 0 && key.every((component) => component.some((name) => pinned.has(name))))
  );
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
    const coarse = isCoarse(tableName, entry);
    references.push({ entry, tableName, columnName, coarse });
    return coarse ? { coarse: { tableName, columnName, entry } } : 'fine';
  };

  // A column of a joined entry, by its own spelling. A derived column that
  // copies one table column is that column (`h.amt` for `d.NetAmount AS amt`
  // is SalesDocument.NetAmount); any other column of a single-table body is
  // at that table's grain.
  const entryColumnGrain = (entry, columnName) => {
    if (!entry.viaDerived) {
      return columnGrain(entry, entry.tableName, columnName);
    }
    const [origin, ...more] = entry.relation?.origins.get(columnName) || [];
    if (origin && more.length === 0) {
      return columnGrain(entry, origin.tableName, origin.columnName);
    }
    return entry.tableName ? columnGrain(entry, entry.tableName, columnName) : null;
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
        const columnName =
          entry && (entry.viaDerived ? findDerivedColumnName(entry.relation, column) : findColumnName(knownTables, entry.tableName, column));
        const grain = columnName ? entryColumnGrain(entry, columnName) : null;
        if (grain) {
          grains.push(grain);
        }
        index += 3;
        continue;
      } else if (tokenIdentifierName(token) && !token.afterDot) {
        // Unqualified column, plain or backtick-quoted, of a table or of a
        // derived table or CTE; MariaDB column names are case-insensitive
        // (`grossamount` is SalesDocument.GrossAmount).
        const owners = unqualifiedOwners(tokenIdentifierName(token));
        const grain = owners.length === 1 ? entryColumnGrain(owners[0].entry, owners[0].columnName) : null;
        if (grain) {
          grains.push(grain);
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
 * or a child pinned to one row by its key keeps one row per parent, and a
 * derived table or CTE counts as every table it reads unless it is provably
 * unique on the columns that join it to the parent (isDerivedUniqueOn).
 */
function validateFanOut(analysis, knownTables, promptContext, model) {
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
        entries.push({ ref, tableName: ref.name, childTables: new Set([ref.name]), qualifier: ref.alias || ref.name, viaDerived: false });
      } else if (ref.kind === 'derived' || ref.kind === 'cte') {
        // A derived table or CTE stands for the tables it reads; tableName is
        // set when it reads exactly one.
        const relationName = model.relationOf(ref);
        const relation = relationName ? model.derivedTables.get(derivedAliasFromTableName(relationName)) : null;
        const qualifier = ref.alias || (ref.kind === 'cte' ? ref.name : null);
        if (relation?.sourceTables.size > 0 && qualifier) {
          const tableName = relation.sourceTables.size === 1 ? [...relation.sourceTables][0] : null;
          entries.push({ ref, tableName, childTables: relation.sourceTables, qualifier, viaDerived: true, relation });
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
    // One joined table per name (and each derived table or CTE) that has an
    // unqualified `name` column, with its own spelling of it.
    const unqualifiedOwners = (name) => {
      const owners = new Map();
      for (const entry of entries) {
        const columnName = entry.viaDerived ? findDerivedColumnName(entry.relation, name) : findColumnName(knownTables, entry.tableName, name);
        const ownerKey = entry.viaDerived ? entry : entry.tableName;
        if (columnName && !owners.has(ownerKey)) {
          owners.set(ownerKey, { entry, columnName });
        }
      }
      return [...owners.values()];
    };
    // A joined child whose whole primary key is pinned to constants or to the
    // columns of the parent row being summed (`LEFT JOIN SalesDocumentLine l
    // ON l.SalesDocumentId = d.SalesDocumentId AND l.SalesDocumentLineId = 1`),
    // or a derived child that is unique on its pinned columns, has at most one
    // row per parent row, so it cannot repeat the parent's values. Equalities
    // chain: `amt.SalesDocumentId = qty.SalesDocumentId` pins amt when qty's
    // key is equated to the parent's. A column equated to another instance of
    // the parent's table (one joined through the child, say) is not pinned.
    let restrictingEqualities;
    // The declared type of a resolved column (a derived column's single origin).
    const columnTypeOf = ({ entry, columnName }) => {
      const [origin, ...more] = entry.viaDerived ? entry.relation.origins.get(columnName) || [] : [{ tableName: entry.tableName, columnName }];
      return origin && more.length === 0 ? columnMetadata.get(origin.tableName)?.get(origin.columnName)?.type : null;
    };
    const resolveOperand = (operand) => {
      if (operand.constant) {
        return operand;
      }
      if (operand.qualifier) {
        const owner = qualifierEntries.get(operand.qualifier);
        const columnName =
          owner && (owner.viaDerived ? findDerivedColumnName(owner.relation, operand.column) : findColumnName(knownTables, owner.tableName, operand.column));
        return columnName ? { entry: owner, columnName } : null;
      }
      const owners = unqualifiedOwners(operand.column);
      return owners.length === 1 ? owners[0] : null;
    };
    const pinnedColumns = (entry, parentEntry) => {
      if (!restrictingEqualities) {
        restrictingEqualities = collectRestrictingEqualities(walker, block, analysis, entries).map(({ pair, appliesTo }) => ({
          sides: pair.map(resolveOperand),
          appliesTo,
        }));
      }
      // Equivalence classes of the equalities that hold for every row of
      // `entry` (WHERE, inner joins, and its own LEFT JOIN condition).
      const links = new Map();
      const find = (node) => {
        let current = node;
        while (links.has(current) && links.get(current) !== current) {
          current = links.get(current);
        }
        return current;
      };
      const nodeOf = (side) => (side.constant ? 'constant' : `${entries.indexOf(side.entry)}:${side.columnName.toLowerCase()}`);
      const anchors = ['constant'];
      const candidates = [];
      for (const { sides, appliesTo } of restrictingEqualities) {
        if ((appliesTo && appliesTo !== entry) || !sides[0] || !sides[1]) {
          continue;
        }
        const [constant, column] = sides[0].constant ? sides : [sides[1], sides[0]];
        if (constant.numeric && !column.constant && STRING_COLUMN_TYPE.test(columnTypeOf(column) || '')) {
          continue;
        }
        links.set(find(nodeOf(sides[0])), find(nodeOf(sides[1])));
        for (const side of sides) {
          if (side.entry === parentEntry) {
            anchors.push(nodeOf(side));
          } else if (side.entry === entry) {
            candidates.push(side);
          }
        }
      }
      const anchored = new Set(anchors.map(find));
      return new Set(candidates.filter((side) => anchored.has(find(nodeOf(side)))).map((side) => side.columnName));
    };
    const restrictedToOneRow = (entry, parentEntry) => {
      if (entry.viaDerived) {
        return isDerivedUniqueOn(entry.relation, pinnedColumns(entry, parentEntry));
      }
      const keyColumns = primaryKeyColumnsOf(columnMetadata, entry.tableName);
      const pinned = keyColumns.length > 0 ? pinnedColumns(entry, parentEntry) : null;
      return Boolean(pinned) && keyColumns.every((columnName) => pinned.has(columnName));
    };
    // Edges from `tableName` to a child joined here by an entry other than
    // `owner`, the entry whose value is summed (a derived table that reads both
    // a parent and its child does not repeat its own rows).
    const childEdgesOf = (tableName, owner) =>
      edges.filter(
        (edge) =>
          edge.parentTable === tableName &&
          edge.childTable !== tableName &&
          entries.some(
            (entry) =>
              entry !== owner &&
              entry.childTables.has(edge.childTable) &&
              !antiJoined.has(entry) &&
              !restrictedToOneRow(entry, owner)
          )
      );

    let groupByOwners;
    const isGroupedWithin = (entry) => {
      if (groupByOwners === undefined) {
        groupByOwners = collectGroupByOwners(walker, block, { qualifierEntries, unqualifiedOwners, outputNames: model.outputNames(block.id) });
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
        isCoarse: (tableName, owner) => childEdgesOf(tableName, owner).length > 0,
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

      const { tableName, columnName, entry } = grain.coarse;
      const [edge] = childEdgesOf(tableName, entry);
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
  const { analysis, model } = extractTableContext(sql, knownTables, promptContext);
  const cteNames = new Set(analysis.ctes.map((cte) => cte.name));
  const qualifiedColumns = validateQualifiedColumns(analysis, knownTables, model);
  validateSuspiciousUnqualifiedIdentifiers(sql, knownTables, model.qualifiers, model.derivedTables);
  const joinChecks = validateJoinGuardrails(analysis, knownTables, model, promptContext);
  const fanOutChecks = validateFanOut(analysis, knownTables, promptContext, model);
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
