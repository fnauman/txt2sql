import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Pin } from 'lucide-react';

import { formatValue } from '../../format';
import { CHART_COLORS } from '../../lib/constants';
import type { QueryResponse, VisualizationSuggestion } from '../../types';

// Persisted at module scope (not component state) so the user's chart-type choice
// survives ChartPanel remounts — e.g. the streaming→done layout switch, or
// re-running the same query — instead of resetting to the first suggestion.
let lastSelectedChartType: string | null = null;

export function ChartPanel({
  result,
  forcedVisualizationId,
  compact = false,
  onPin,
}: {
  result: QueryResponse;
  forcedVisualizationId?: string;
  compact?: boolean;
  onPin?: (visualization: VisualizationSuggestion) => void;
}) {
  const [selectedId, setSelectedId] = useState('');
  const visualizations = result.visualizations;
  const selected = visualizations.find((product) => product.id === (forcedVisualizationId || selectedId)) || visualizations[0];

  useEffect(() => {
    const vizs = result.visualizations;
    const preferred = lastSelectedChartType ? vizs.find((visualization) => visualization.type === lastSelectedChartType) : undefined;
    setSelectedId((preferred || vizs[0])?.id || '');
  }, [result.question, result.sql, result.visualizations]);

  if (!selected) {
    return (
      <section className="tool-panel chart-panel compact-empty">
        <div className="empty-state">No chart shape</div>
      </section>
    );
  }

  const yKeys = selected.yKeys.length > 0 ? selected.yKeys : [];
  const firstYKey = yKeys[0] || '';
  const height = compact ? 220 : 330;
  const pieData = result.rows.map((row) => ({
    name: formatValue(row[selected.xKey]),
    value: Number(row[firstYKey] || 0),
  }));

  return (
    <section className="tool-panel chart-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Chart</p>
          <h2>{selected.title}</h2>
        </div>
        <div className="toolbar">
          {!forcedVisualizationId && visualizations.length > 1 && (
            <div className="segmented compact-tabs">
              {visualizations.map((visualization) => (
                <button
                  key={visualization.id}
                  className={visualization.id === selected.id ? 'active' : ''}
                  type="button"
                  onClick={() => {
                    lastSelectedChartType = visualization.type;
                    setSelectedId(visualization.id);
                  }}
                >
                  {visualization.type}
                </button>
              ))}
            </div>
          )}
          {onPin && (
            <button className="icon-button" type="button" onClick={() => onPin(selected)} title="Pin chart" aria-label="Pin chart">
              <Pin size={17} />
            </button>
          )}
        </div>
      </div>

      <div className="chart-stage">
        <ResponsiveContainer width="100%" height={height}>
          {selected.type === 'pie' ? (
            <PieChart>
              <Tooltip />
              <Legend />
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={compact ? 36 : 58} outerRadius={compact ? 76 : 112}>
                {pieData.map((entry, index) => (
                  <Cell key={`${entry.name}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          ) : selected.type === 'bar' ? (
            <BarChart data={result.rows} margin={{ top: 12, right: 16, bottom: 10, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey={selected.xKey} tickLine={false} minTickGap={18} />
              <YAxis tickLine={false} width={64} />
              <Tooltip />
              <Legend />
              {yKeys.map((key, index) => (
                <Bar key={key} dataKey={key} fill={CHART_COLORS[index % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          ) : selected.type === 'area' ? (
            <AreaChart data={result.rows} margin={{ top: 12, right: 16, bottom: 10, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey={selected.xKey} tickLine={false} minTickGap={18} />
              <YAxis tickLine={false} width={64} />
              <Tooltip />
              <Legend />
              {yKeys.map((key, index) => (
                <Area key={key} dataKey={key} type="monotone" stroke={CHART_COLORS[index % CHART_COLORS.length]} fill={CHART_COLORS[index % CHART_COLORS.length]} fillOpacity={0.18} />
              ))}
            </AreaChart>
          ) : (
            <LineChart data={result.rows} margin={{ top: 12, right: 16, bottom: 10, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey={selected.xKey} tickLine={false} minTickGap={18} />
              <YAxis tickLine={false} width={64} />
              <Tooltip />
              <Legend />
              {yKeys.map((key, index) => (
                <Line key={key} dataKey={key} type="monotone" stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={2.5} dot={false} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  );
}
