// Heavy client-side engine (arquero + the shared result-intelligence helpers).
// Loaded via dynamic import() ONLY when the user actually cross-filters demo data,
// so arquero stays out of the initial bundle and first paint stays fast.
import { escape, from } from 'arquero';

import type { QueryResponse } from '../types';
import { createResultInsights, inferColumns, suggestVisualizations } from './result-intelligence';

type Row = Record<string, unknown>;

// Filter the already-returned rows in the browser and re-derive visualizations +
// insights from the filtered set (same pure helpers the server uses).
export function filterDataset(result: QueryResponse, needle: string): QueryResponse {
  const lower = needle.trim().toLowerCase();
  if (!lower) {
    return result;
  }

  const keys = result.columns.map((column) => column.key);
  const filtered = from(result.rows as Row[])
    .filter(escape((row: Row) => keys.some((key) => String(row[key] ?? '').toLowerCase().includes(lower))))
    .objects() as Row[];

  const liveColumns = inferColumns(filtered);
  return {
    ...result,
    rows: filtered,
    rowCount: filtered.length,
    totalRowCount: filtered.length,
    truncated: false,
    visualizations: suggestVisualizations(filtered, liveColumns),
    insights: createResultInsights({ question: result.question, rows: filtered, columns: liveColumns }),
  };
}
