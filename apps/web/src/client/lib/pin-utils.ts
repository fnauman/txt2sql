import { MAX_PINNED_ROWS } from './constants';
import type { DashboardPin, InsightCard, QueryResponse, VisualizationSuggestion } from '../types';

export function createId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function compactResultForPin(
  result: QueryResponse,
  type: DashboardPin['type'],
  options: { visualization?: VisualizationSuggestion; insight?: InsightCard }
): QueryResponse {
  const rows = type === 'insight' ? [] : result.rows.slice(0, MAX_PINNED_ROWS);
  const columns = type === 'insight' ? [] : result.columns;
  const visualizations = options.visualization ? [options.visualization] : [];
  const insights = options.insight ? [options.insight] : [];

  return {
    ...result,
    rows,
    columns,
    rowCount: rows.length,
    visualizations,
    insights,
    explanation: '',
    assumptions: [],
    tablesUsed: [],
    promptTables: [],
    llmUsage: null,
    llmCost: null,
    attemptCount: 0,
    error: null,
    debug: null,
    truncated: result.truncated || result.rows.length > rows.length,
  };
}
