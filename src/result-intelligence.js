function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCellValue(value) {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value.toString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return value;
}

function isNumericValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDateLikeValue(value) {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  if (typeof value !== 'string') {
    return false;
  }

  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return false;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp);
}

function isTemporalBucketKey(key) {
  return /(^|[_\s-])(week|yearweek|year_week|month|quarter|period|date|day)([_\s-]|$)/i.test(String(key || ''));
}

// Identifier and code columns (CustomerId, ProductId, AccountCode, ...) are
// numeric or text by storage but are not metrics or meaningful categories.
// Summing or charting them produces nonsense like "Customer Id total: 134,892",
// so they are tagged and excluded from metric/category/visualization roles.
// The patterns target word-boundary "Id"/"Code" suffixes to avoid false hits on
// real metrics such as SalesDocumentPaid (".. -aid") or columns merely ending in "id".
function isIdentifierKey(key) {
  const text = String(key || '');
  return (
    /^id$/i.test(text) ||
    /[a-z0-9]Id$/.test(text) ||
    /_id$/i.test(text) ||
    /^code$/i.test(text) ||
    /[a-z0-9]Code$/.test(text) ||
    /_code$/i.test(text)
  );
}

function titleize(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}

function compareDateLike(left, right) {
  return Date.parse(left) - Date.parse(right);
}

export function normalizeRows(rows, { limit = 1000 } = {}) {
  if (!Array.isArray(rows)) {
    return [];
  }

  const effectiveLimit = Number.isFinite(limit) && limit >= 0 ? limit : rows.length;

  return rows.slice(0, effectiveLimit).map((row) => {
    if (!isPlainObject(row)) {
      return { value: normalizeCellValue(row) };
    }

    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = normalizeCellValue(value);
    }
    return normalized;
  });
}

export function inferColumns(rows) {
  const normalizedRows = normalizeRows(rows, { limit: Array.isArray(rows) ? rows.length : 0 });
  const keys = [];
  const seen = new Set();

  for (const row of normalizedRows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }

  return keys.map((key) => {
    const values = normalizedRows.map((row) => row[key]).filter((value) => value !== null && value !== undefined);
    const numericCount = values.filter(isNumericValue).length;
    const dateCount = values.filter(isDateLikeValue).length;
    const booleanCount = values.filter((value) => typeof value === 'boolean').length;
    const uniqueValues = new Set(values.map((value) => String(value))).size;
    const temporalBucket = isTemporalBucketKey(key);
    const identifier = !temporalBucket && isIdentifierKey(key);
    let type = 'text';

    if (values.length > 0 && dateCount / values.length >= 0.8) {
      type = 'date';
    } else if (values.length > 0 && numericCount / values.length >= 0.8 && !temporalBucket) {
      type = 'number';
    } else if (values.length > 0 && booleanCount / values.length >= 0.8) {
      type = 'boolean';
    }

    return {
      key,
      label: titleize(key),
      type,
      semanticType: temporalBucket ? 'temporal_bucket' : identifier ? 'identifier' : null,
      nonNullCount: values.length,
      numericCount,
      dateCount,
      uniqueCount: uniqueValues,
      sampleValues: values.slice(0, 5),
    };
  });
}

export function suggestVisualizations(rows, columns = inferColumns(rows)) {
  const normalizedRows = normalizeRows(rows, { limit: Array.isArray(rows) ? rows.length : 0 });
  if (normalizedRows.length < 2) {
    return [];
  }

  const numericColumns = columns.filter(
    (column) => column.type === 'number' && column.nonNullCount > 0 && column.semanticType !== 'identifier'
  );
  const dateColumns = columns.filter((column) => column.type === 'date' || column.semanticType === 'temporal_bucket');
  const categoricalColumns = columns.filter(
    (column) =>
      column.type !== 'number' &&
      column.type !== 'date' &&
      column.semanticType !== 'temporal_bucket' &&
      column.semanticType !== 'identifier' &&
      column.uniqueCount > 1 &&
      column.uniqueCount <= 50
  );
  const suggestions = [];

  if (dateColumns.length > 0 && numericColumns.length > 0) {
    const xColumn = dateColumns[0];
    const yColumns = numericColumns.slice(0, 3);
    suggestions.push({
      id: `line-${xColumn.key}-${yColumns.map((column) => column.key).join('-')}`,
      title: `${yColumns[0].label} over ${xColumn.label}`,
      type: 'line',
      xKey: xColumn.key,
      yKeys: yColumns.map((column) => column.key),
      reason: 'Date-like dimension with numeric metrics.',
      confidence: 0.9,
    });

    if (yColumns.length === 1) {
      suggestions.push({
        id: `area-${xColumn.key}-${yColumns[0].key}`,
        title: `${yColumns[0].label} trend`,
        type: 'area',
        xKey: xColumn.key,
        yKeys: [yColumns[0].key],
        reason: 'Single metric trend can be read as an area chart.',
        confidence: 0.74,
      });
    }
  }

  if (categoricalColumns.length > 0 && numericColumns.length > 0) {
    const xColumn = categoricalColumns[0];
    const yColumn = numericColumns[0];
    suggestions.push({
      id: `bar-${xColumn.key}-${yColumn.key}`,
      title: `${yColumn.label} by ${xColumn.label}`,
      type: 'bar',
      xKey: xColumn.key,
      yKeys: [yColumn.key],
      reason: 'Categorical grouping with a numeric metric.',
      confidence: 0.86,
    });

    if (normalizedRows.length <= 10 && xColumn.uniqueCount <= 8) {
      suggestions.push({
        id: `pie-${xColumn.key}-${yColumn.key}`,
        title: `${yColumn.label} share`,
        type: 'pie',
        xKey: xColumn.key,
        yKeys: [yColumn.key],
        reason: 'Small category set can be shown as a share chart.',
        confidence: 0.66,
      });
    }
  }

  return suggestions.slice(0, 4);
}

export function createResultInsights({ question = '', rows = [], columns = inferColumns(rows), rowLimit = null } = {}) {
  const normalizedRows = normalizeRows(rows, { limit: Array.isArray(rows) ? rows.length : 0 });
  const insights = [];
  const numericColumns = columns.filter((column) => column.type === 'number' && column.semanticType !== 'identifier');
  const dateColumns = columns.filter((column) => column.type === 'date' || column.semanticType === 'temporal_bucket');
  const categoricalColumns = columns.filter(
    (column) =>
      column.type !== 'number' &&
      column.type !== 'date' &&
      column.semanticType !== 'temporal_bucket' &&
      column.semanticType !== 'identifier'
  );

  if (normalizedRows.length === 0) {
    return [
      {
        id: 'empty-result',
        title: 'No matching rows',
        value: '0 rows',
        detail: 'The query ran, but the result set is empty.',
        tone: 'neutral',
      },
    ];
  }

  insights.push({
    id: 'row-count',
    title: 'Returned rows',
    value: formatNumber(normalizedRows.length),
    detail: rowLimit && normalizedRows.length >= rowLimit ? `Displayed result reached the ${rowLimit} row limit.` : 'Rows available in the current result set.',
    tone: normalizedRows.length > 500 ? 'warning' : 'neutral',
  });

  if (numericColumns.length > 0) {
    const metric = numericColumns[0];
    const values = normalizedRows.map((row) => row[metric.key]).filter(isNumericValue);
    const total = values.reduce((sum, value) => sum + value, 0);
    const average = values.length > 0 ? total / values.length : 0;

    insights.push({
      id: `metric-${metric.key}`,
      title: `${metric.label} total`,
      value: formatNumber(total),
      detail: `Average per row is ${formatNumber(average)}.`,
      tone: 'positive',
    });
  }

  if (categoricalColumns.length > 0 && numericColumns.length > 0) {
    const category = categoricalColumns[0];
    const metric = numericColumns[0];
    const ranked = normalizedRows
      .filter((row) => row[category.key] !== null && row[category.key] !== undefined && isNumericValue(row[metric.key]))
      .sort((left, right) => right[metric.key] - left[metric.key]);

    if (ranked.length > 0) {
      insights.push({
        id: `top-${category.key}-${metric.key}`,
        title: `Top ${category.label}`,
        value: String(ranked[0][category.key]),
        detail: `${metric.label}: ${formatNumber(ranked[0][metric.key])}.`,
        tone: 'positive',
      });
    }
  }

  if (dateColumns.length > 0 && numericColumns.length > 0) {
    const dateColumn = dateColumns[0];
    const metric = numericColumns[0];
    const sorted = normalizedRows
      .filter((row) => isDateLikeValue(row[dateColumn.key]) && isNumericValue(row[metric.key]))
      .sort((left, right) => compareDateLike(left[dateColumn.key], right[dateColumn.key]));

    if (sorted.length >= 2) {
      const first = sorted[0][metric.key];
      const last = sorted[sorted.length - 1][metric.key];
      const delta = last - first;
      const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      insights.push({
        id: `trend-${dateColumn.key}-${metric.key}`,
        title: `${metric.label} trend`,
        value: direction,
        detail: `Changed by ${formatNumber(delta)} from first to last period.`,
        tone: delta >= 0 ? 'positive' : 'warning',
      });
    }
  }

  const suggestedColumn = categoricalColumns[0] || dateColumns[0] || numericColumns[0];
  if (suggestedColumn) {
    insights.push({
      id: 'follow-up',
      title: 'Follow-up query',
      value: `Break down by ${suggestedColumn.label}`,
      detail: question ? `Use the same question with a narrower time window or ${suggestedColumn.label}.` : 'Narrow the result by time, customer, product, or branch.',
      tone: 'neutral',
    });
  }

  return insights.slice(0, 6);
}
