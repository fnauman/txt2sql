import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Download, Eye, EyeOff, Pin, Search } from 'lucide-react';

import { formatValue } from '../../format';
import { compareValues, exportCsv } from '../../lib/table-utils';
import type { QueryResponse, ResultColumn } from '../../types';

type Row = Record<string, unknown>;
const ROW_HEIGHT = 38;

export function ResultTable({
  result,
  onPin,
  hideFilter = false,
}: {
  result: QueryResponse;
  onPin?: () => void;
  hideFilter?: boolean;
}) {
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset table state when a new query lands (matches the previous behavior).
  useEffect(() => {
    setGlobalFilter('');
    setSorting([]);
    setColumnVisibility({});
  }, [result.question, result.sql]);

  const numericKeys = useMemo(
    () => new Set(result.columns.filter((column) => column.type === 'number').map((column) => column.key)),
    [result.columns]
  );

  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      result.columns.map((column: ResultColumn) => ({
        id: column.key,
        accessorFn: (row) => row[column.key],
        header: column.label,
        cell: (info) => formatValue(info.getValue()),
        sortingFn: (rowA, rowB) => compareValues(rowA.getValue(column.key), rowB.getValue(column.key), column),
      })),
    [result.columns]
  );

  const table = useReactTable<Row>({
    data: result.rows as Row[],
    columns,
    state: { globalFilter, sorting, columnVisibility },
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const visibleColumns = result.columns.filter((column) => columnVisibility[column.key] !== false);
  // Header and body rows share this template so columns align; minmax floor keeps
  // numeric cells from clipping while wide tables scroll horizontally.
  const gridTemplateColumns = `repeat(${Math.max(visibleColumns.length, 1)}, minmax(140px, 1fr))`;

  return (
    <section className="tool-panel table-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Result table</p>
          <h2>{`${filteredCount.toLocaleString()} ${filteredCount === 1 ? 'row' : 'rows'}`}</h2>
        </div>
        <div className="toolbar">
          {onPin && (
            <button className="icon-button" type="button" onClick={onPin} title="Pin table" aria-label="Pin table">
              <Pin size={17} />
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            onClick={() => exportCsv(result, table.getFilteredRowModel().rows.map((row) => row.original), visibleColumns)}
            title="Export CSV"
            aria-label="Export CSV"
            disabled={filteredCount === 0}
          >
            <Download size={17} />
          </button>
        </div>
      </div>

      <div className="table-controls">
        {!hideFilter && (
          <label className="search-field">
            <Search size={16} />
            <input value={globalFilter} onChange={(event) => setGlobalFilter(event.target.value)} placeholder="Filter rows" />
          </label>
        )}
        <div className="column-toggles" aria-label="Column visibility">
          {result.columns.map((column) => {
            const hidden = columnVisibility[column.key] === false;
            return (
              <button
                key={column.key}
                className={hidden ? 'chip muted' : 'chip'}
                type="button"
                onClick={() => setColumnVisibility((current) => ({ ...current, [column.key]: hidden }))}
                title={hidden ? `Show ${column.label}` : `Hide ${column.label}`}
              >
                {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                {column.label}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="table-scroll" role="region" aria-label="Result rows" tabIndex={0}>
        {/* display:grid (for virtualization) strips the implicit ARIA table
            roles, so they are restored explicitly. aria-rowcount includes the
            header row; rows carry aria-rowindex (header = 1, data = index + 2). */}
        <table className="virtual-table" role="table" aria-rowcount={filteredCount + 1}>
          <thead role="rowgroup">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} role="row" aria-rowindex={1} style={{ gridTemplateColumns }}>
                {headerGroup.headers.map((header, columnIndex) => {
                  const sorted = header.column.getIsSorted();
                  const isNumeric = numericKeys.has(header.column.id);
                  return (
                    <th
                      key={header.id}
                      role="columnheader"
                      aria-colindex={columnIndex + 1}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      className={isNumeric ? 'numeric' : undefined}
                    >
                      <button type="button" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? <ArrowUp size={13} /> : sorted === 'desc' ? <ArrowDown size={13} /> : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody role="rowgroup" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <tr
                  key={row.id}
                  role="row"
                  aria-rowindex={virtualRow.index + 2}
                  data-index={virtualRow.index}
                  style={{ transform: `translateY(${virtualRow.start}px)`, gridTemplateColumns }}
                >
                  {row.getVisibleCells().map((cell, columnIndex) => (
                    <td
                      key={cell.id}
                      role="cell"
                      aria-colindex={columnIndex + 1}
                      className={numericKeys.has(cell.column.id) ? 'numeric' : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredCount === 0 && <div className="empty-state">No rows</div>}
      </div>
    </section>
  );
}
