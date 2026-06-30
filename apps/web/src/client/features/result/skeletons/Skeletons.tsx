import type { ResultColumn } from '../../../types';

export function MetricSkeleton() {
  return (
    <div className="metric-strip skeleton-metric" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i}>
          <span className="skeleton-line short" />
          <span className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <section className="tool-panel chart-panel" aria-hidden="true">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Chart</p>
          <span className="skeleton-line" style={{ width: '40%' }} />
        </div>
      </div>
      <div className="chart-stage skeleton-chart">
        <span className="skeleton-block" />
      </div>
    </section>
  );
}

export function TableSkeleton({ columns = [] }: { columns?: ResultColumn[] }) {
  const headers: { key: string; label: string }[] =
    columns.length > 0 ? columns : Array.from({ length: 4 }, (_, i) => ({ key: String(i), label: '' }));
  return (
    <section className="tool-panel table-panel" aria-hidden="true">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Result table</p>
          <span className="skeleton-line" style={{ width: '30%' }} />
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {headers.map((column) => (
                <th key={column.key}>{column.label || <span className="skeleton-line" />}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, rowIndex) => (
              <tr key={rowIndex}>
                {headers.map((column) => (
                  <td key={column.key}>
                    <span className="skeleton-line" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
