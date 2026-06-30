// Typed client wrapper around the shared, pure result-intelligence helpers that
// the Node pipeline also uses. Re-running them in the browser lets cross-filtering
// recompute charts + KPIs with zero server round-trips. The Buffer shim must load
// first (the shared module references the Node global Buffer.isBuffer).
import './node-shims';
// @ts-expect-error -- shared pure JS helper from the repo root; no type declarations
import { createResultInsights as cri, inferColumns as ic, suggestVisualizations as sv } from '../../../../../src/result-intelligence.js';

import type { InsightCard, ResultColumn, VisualizationSuggestion } from '../types';

type Row = Record<string, unknown>;

export function inferColumns(rows: Row[]): ResultColumn[] {
  return ic(rows) as ResultColumn[];
}

export function suggestVisualizations(rows: Row[], columns: ResultColumn[]): VisualizationSuggestion[] {
  return sv(rows, columns) as VisualizationSuggestion[];
}

export function createResultInsights(args: {
  question?: string;
  rows: Row[];
  columns?: ResultColumn[];
  rowLimit?: number | null;
}): InsightCard[] {
  return cri(args) as InsightCard[];
}
