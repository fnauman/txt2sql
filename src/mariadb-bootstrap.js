function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function quoteString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const MAX_ESTIMATED_INLINE_ROW_BYTES = 7000;

function mapIntegerType(type) {
  const match = /^INTEGER(?:\((\d+)\))?$/i.exec(type || '');
  if (!match) {
    return null;
  }

  return 'INT';
}

function mapStringType(type) {
  const match = /^STRING(?:\((\d+)\))?$/i.exec(type || '');
  if (!match) {
    return null;
  }

  const length = Number(match[1] || 255);
  return length > 255 ? 'TEXT' : `VARCHAR(${length})`;
}

function decodeEnumValue(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function splitEnumValues(body) {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return [];
  }

  try {
    const parsed = JSON.parse(`[${trimmedBody}]`);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }
  } catch {
    // Fall back to a quoted-string aware splitter for non-JSON enum bodies.
  }

  const values = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < trimmedBody.length; index += 1) {
    const char = trimmedBody[index];

    if (!quote && char === ',') {
      const value = decodeEnumValue(current);
      if (value != null) {
        values.push(value);
      }
      current = '';
      continue;
    }

    current += char;

    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }

    if (quote === '"' && char === '\\' && index + 1 < trimmedBody.length) {
      current += trimmedBody[index + 1];
      index += 1;
      continue;
    }

    if (quote === "'" && char === "'" && trimmedBody[index + 1] === "'") {
      current += trimmedBody[index + 1];
      index += 1;
      continue;
    }

    if (quote && char === quote) {
      quote = null;
    }
  }

  const value = decodeEnumValue(current);
  if (value != null) {
    values.push(value);
  }

  return values;
}

function mapEnumType(type) {
  const match = /^ENUM\((.*)\)$/i.exec(type || '');
  if (!match) {
    return null;
  }

  const values = splitEnumValues(match[1]).map((value) => quoteString(value));

  return `ENUM(${values.join(', ')})`;
}

export function mapColumnTypeToMariaDb(type) {
  if (!type) {
    return 'TEXT';
  }

  return (
    mapIntegerType(type) ||
    mapStringType(type) ||
    mapEnumType(type) ||
    (type === 'DATE' ? 'DATETIME' : null) ||
    (type === 'DATEONLY' ? 'DATE' : null) ||
    (type === 'DECIMAL' ? 'DECIMAL(24,8)' : null) ||
    (/^(CHAR|BINARY)\(\d+\)$/i.test(type) ? type.toUpperCase() : null) ||
    (/^(TEXT|BLOB)$/i.test(type) ? type.toUpperCase() : null) ||
    'TEXT'
  );
}

function estimateInlineBytes(sqlType) {
  if (!sqlType) {
    return 20;
  }

  if (/^TINYINT(?:\(\d+\))?$/i.test(sqlType)) {
    return 1;
  }

  if (/^INT(?:EGER)?(?:\(\d+\))?$/i.test(sqlType)) {
    return 4;
  }

  if (/^DECIMAL(?:\(\d+,\d+\))?$/i.test(sqlType)) {
    return 12;
  }

  if (/^DATETIME$/i.test(sqlType)) {
    return 8;
  }

  if (/^DATE$/i.test(sqlType)) {
    return 3;
  }

  const varcharMatch = /^VARCHAR\((\d+)\)$/i.exec(sqlType);
  if (varcharMatch) {
    const length = Number(varcharMatch[1]);
    return length * 4 + (length > 255 ? 2 : 1);
  }

  const charMatch = /^CHAR\((\d+)\)$/i.exec(sqlType);
  if (charMatch) {
    return Number(charMatch[1]) * 4;
  }

  const binaryMatch = /^BINARY\((\d+)\)$/i.exec(sqlType);
  if (binaryMatch) {
    return Number(binaryMatch[1]);
  }

  if (/^(TEXT|BLOB)$/i.test(sqlType)) {
    return 20;
  }

  if (/^ENUM\(/i.test(sqlType)) {
    return 2;
  }

  return 20;
}

function buildColumnPlan(column) {
  const sqlType = mapColumnTypeToMariaDb(column.type);
  return {
    column,
    sqlType,
    estimatedInlineBytes: estimateInlineBytes(sqlType),
    downgradedToText: false,
  };
}

function applyRowSizeDowngrades(table, plannedColumns) {
  let totalInlineBytes = plannedColumns.reduce((sum, entry) => sum + entry.estimatedInlineBytes, 0);
  if (totalInlineBytes <= MAX_ESTIMATED_INLINE_ROW_BYTES) {
    return {
      plannedColumns,
      totalInlineBytes,
      downgradedColumns: [],
    };
  }

  const candidates = plannedColumns
    .filter((entry) => /^VARCHAR\((\d+)\)$/i.test(entry.sqlType) && !entry.column.primaryKey && !entry.column.unique)
    .map((entry) => ({
      entry,
      savings: entry.estimatedInlineBytes - estimateInlineBytes('TEXT'),
      length: Number(entry.sqlType.match(/^VARCHAR\((\d+)\)$/i)?.[1] || 0),
    }))
    .sort((left, right) => right.savings - left.savings || right.length - left.length || left.entry.column.name.localeCompare(right.entry.column.name));

  const downgradedColumns = [];
  for (const candidate of candidates) {
    if (totalInlineBytes <= MAX_ESTIMATED_INLINE_ROW_BYTES) {
      break;
    }

    if (candidate.savings <= 0) {
      break;
    }

    candidate.entry.sqlType = 'TEXT';
    candidate.entry.downgradedToText = true;
    totalInlineBytes -= candidate.savings;
    candidate.entry.estimatedInlineBytes = estimateInlineBytes(candidate.entry.sqlType);
    downgradedColumns.push(candidate.entry.column.name);
  }

  if (totalInlineBytes > MAX_ESTIMATED_INLINE_ROW_BYTES) {
    throw new Error(
      `Starter DDL for table "${table.tableName}" still exceeds the MariaDB row-size budget after downgrading wide VARCHAR columns.`
    );
  }

  return {
    plannedColumns,
    totalInlineBytes,
    downgradedColumns,
  };
}

function formatDefaultClause(column, sqlType) {
  if (column.defaultValue == null || column.autoIncrement) {
    return null;
  }

  if (/\b(TEXT|BLOB)\b/i.test(sqlType)) {
    return null;
  }

  if (column.defaultValue === '[Function NOW]') {
    return 'DEFAULT CURRENT_TIMESTAMP';
  }

  if (typeof column.defaultValue === 'number') {
    return `DEFAULT ${column.defaultValue}`;
  }

  if (typeof column.defaultValue === 'string' && /^-?\d+(?:\.\d+)?$/.test(column.defaultValue)) {
    return `DEFAULT ${column.defaultValue}`;
  }

  return `DEFAULT ${quoteString(column.defaultValue)}`;
}

function buildColumnSql(columnPlan) {
  const { column, sqlType } = columnPlan;
  const parts = [quoteIdentifier(column.name), sqlType];

  if (column.autoIncrement) {
    parts.push('AUTO_INCREMENT');
  }

  parts.push(column.allowNull === false || column.primaryKey ? 'NOT NULL' : 'NULL');

  const defaultClause = formatDefaultClause(column, sqlType);
  if (defaultClause) {
    parts.push(defaultClause);
  }

  if (column.comment) {
    parts.push(`COMMENT ${quoteString(column.comment)}`);
  }

  return parts.join(' ');
}

export function buildCreateTableSql(table, { dropExisting = false } = {}) {
  const columnPlan = applyRowSizeDowngrades(
    table,
    table.columns.map(buildColumnPlan)
  );
  const lines = columnPlan.plannedColumns.map(buildColumnSql);

  if (table.primaryKey.length > 0) {
    lines.push(`PRIMARY KEY (${table.primaryKey.map(quoteIdentifier).join(', ')})`);
  }

  for (const column of table.columns.filter((entry) => entry.unique)) {
    lines.push(
      `UNIQUE KEY ${quoteIdentifier(`${table.tableName}_${column.name}_unique`)} (${quoteIdentifier(column.name)})`
    );
  }

  for (const foreignKey of table.foreignKeys) {
    lines.push(
      `KEY ${quoteIdentifier(`${table.tableName}_${foreignKey.column}_idx`)} (${quoteIdentifier(foreignKey.column)})`
    );
  }

  const createStatement = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.tableName)} (\n  ${lines.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;`;
  return {
    statements: dropExisting
      ? [`DROP TABLE IF EXISTS ${quoteIdentifier(table.tableName)};`, createStatement]
      : [createStatement],
    downgradedColumns: columnPlan.downgradedColumns,
    estimatedInlineBytes: columnPlan.totalInlineBytes,
  };
}

export function buildBootstrapPlan(schema, databaseName, { dropExisting = false } = {}) {
  const statements = [
    `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `USE ${quoteIdentifier(databaseName)};`,
  ];
  const adjustments = [];

  for (const table of schema.tables) {
    const tablePlan = buildCreateTableSql(table, { dropExisting });
    statements.push(...tablePlan.statements);
    if (tablePlan.downgradedColumns.length > 0) {
      adjustments.push({
        tableName: table.tableName,
        downgradedColumns: tablePlan.downgradedColumns,
        estimatedInlineBytes: tablePlan.estimatedInlineBytes,
      });
    }
  }

  return {
    statements,
    adjustments,
  };
}

export function buildBootstrapSql(schema, databaseName, { dropExisting = false } = {}) {
  return buildBootstrapPlan(schema, databaseName, { dropExisting }).statements;
}
