import { csvField } from '../format';
import type { QueryResponse, ResultColumn } from '../types';

export type SortState = { key: string; direction: 'asc' | 'desc' } | null;

export function compareValues(left: unknown, right: unknown, column?: ResultColumn) {
  if (column?.type === 'number') {
    return Number(left ?? 0) - Number(right ?? 0);
  }

  if (column?.type === 'date') {
    return Date.parse(String(left ?? '')) - Date.parse(String(right ?? ''));
  }

  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function exportCsv(result: QueryResponse, rows: Record<string, unknown>[], columns: ResultColumn[]) {
  const csv = [
    columns.map((column) => csvField(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => csvField(row[column.key])).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${result.question.slice(0, 48).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'query'}-results.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
