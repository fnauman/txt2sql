import assert from 'node:assert/strict';
import test from 'node:test';

import { createResultInsights, inferColumns, normalizeRows, suggestVisualizations } from '../src/result-intelligence.js';

test('inferColumns detects numeric, date, and categorical result fields', () => {
  const rows = [
    { month: '2026-01-01', customer: 'Alpha', total_sales: 100.25 },
    { month: '2026-02-01', customer: 'Beta', total_sales: 150.75 },
  ];

  const columns = inferColumns(rows);

  assert.equal(columns.find((column) => column.key === 'month')?.type, 'date');
  assert.equal(columns.find((column) => column.key === 'customer')?.type, 'text');
  assert.equal(columns.find((column) => column.key === 'total_sales')?.type, 'number');
});

test('suggestVisualizations proposes trend and grouped metric charts', () => {
  const rows = [
    { month: '2026-01-01', customer: 'Alpha', total_sales: 100 },
    { month: '2026-02-01', customer: 'Beta', total_sales: 150 },
  ];
  const columns = inferColumns(rows);
  const visualizations = suggestVisualizations(rows, columns);

  assert.ok(visualizations.some((visualization) => visualization.type === 'line'));
  assert.ok(visualizations.some((visualization) => visualization.type === 'bar'));
});

test('createResultInsights summarizes row count, totals, top groups, and trends', () => {
  const rows = [
    { month: '2026-01-01', customer: 'Alpha', total_sales: 100 },
    { month: '2026-02-01', customer: 'Beta', total_sales: 150 },
  ];
  const columns = inferColumns(rows);
  const insights = createResultInsights({ question: 'sales by month', rows, columns });

  assert.ok(insights.some((insight) => insight.id === 'row-count'));
  assert.ok(insights.some((insight) => insight.id === 'metric-total_sales'));
  assert.ok(insights.some((insight) => insight.id === 'top-customer-total_sales'));
  assert.ok(insights.some((insight) => insight.id === 'trend-month-total_sales'));
});

test('normalizeRows makes database values JSON-safe and applies display limits', () => {
  const rows = [
    { id: 1n, created_at: new Date('2026-01-01T00:00:00Z') },
    { id: 2n, created_at: new Date('2026-01-02T00:00:00Z') },
  ];

  assert.deepEqual(normalizeRows(rows, { limit: 1 }), [
    { id: 1, created_at: '2026-01-01T00:00:00.000Z' },
  ]);
});


test('suggestVisualizations treats numeric week buckets as trend dimensions', () => {
  const rows = [
    { week_start: 202606, total_net_amount: 100 },
    { week_start: 202607, total_net_amount: 150 },
  ];
  const columns = inferColumns(rows);
  const weekColumn = columns.find((column) => column.key === 'week_start');
  const visualizations = suggestVisualizations(rows, columns);

  assert.equal(weekColumn?.type, 'text');
  assert.equal(weekColumn?.semanticType, 'temporal_bucket');
  assert.ok(visualizations.some((visualization) => visualization.type === 'line'));
});

test('inferColumns tags identifier and code columns', () => {
  const rows = [
    { CustomerId: 4983, ProductCode: 'WF10', CustomerName: 'Alpha', SalesDocumentPaid: 12.5 },
    { CustomerId: 4984, ProductCode: 'WF11', CustomerName: 'Beta', SalesDocumentPaid: 30.0 },
  ];
  const columns = inferColumns(rows);

  assert.equal(columns.find((column) => column.key === 'CustomerId')?.semanticType, 'identifier');
  assert.equal(columns.find((column) => column.key === 'ProductCode')?.semanticType, 'identifier');
  // A real metric that merely ends in "...aid" must NOT be treated as an identifier.
  assert.equal(columns.find((column) => column.key === 'SalesDocumentPaid')?.semanticType, null);
  assert.equal(columns.find((column) => column.key === 'CustomerName')?.semanticType, null);
});

test('createResultInsights does not aggregate identifier columns as metrics', () => {
  const rows = [
    { CustomerId: 4983, CustomerName: 'Alpha' },
    { CustomerId: 4984, CustomerName: 'Beta' },
    { CustomerId: 4985, CustomerName: 'Gamma' },
  ];
  const insights = createResultInsights({ question: 'list customers', rows });

  // No "Customer Id total: 14,952" nonsense.
  assert.ok(!insights.some((insight) => insight.id === 'metric-CustomerId'));
  assert.ok(!insights.some((insight) => /total/i.test(insight.title) && /id/i.test(insight.title)));
  assert.ok(insights.some((insight) => insight.id === 'row-count'));
});

test('createResultInsights still totals a real metric when an identifier column is present', () => {
  const rows = [
    { CustomerId: 1, CustomerName: 'Alpha', total_net_amount: 100 },
    { CustomerId: 2, CustomerName: 'Beta', total_net_amount: 200 },
  ];
  const insights = createResultInsights({ question: 'net sales by customer', rows });

  assert.ok(insights.some((insight) => insight.id === 'metric-total_net_amount'));
  assert.ok(!insights.some((insight) => insight.id === 'metric-CustomerId'));
});

test('suggestVisualizations does not chart identifier columns', () => {
  const rows = [
    { CustomerId: 4983, CustomerName: 'Alpha' },
    { CustomerId: 4984, CustomerName: 'Beta' },
  ];
  const columns = inferColumns(rows);
  const visualizations = suggestVisualizations(rows, columns);

  assert.ok(!visualizations.some((visualization) => visualization.yKeys?.includes('CustomerId')));
});
