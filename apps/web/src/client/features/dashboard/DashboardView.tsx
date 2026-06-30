import { X } from 'lucide-react';

import type { DashboardPin } from '../../types';
import { LazyChartPanel } from '../result/LazyChartPanel';
import { InsightGrid } from '../result/InsightGrid';
import { ResultTable } from '../result/ResultTable';

export function DashboardView({ pins, onRemove }: { pins: DashboardPin[]; onRemove: (id: string) => void }) {
  return (
    <main className="dashboard-view">
      <div className="view-title">
        <p className="eyebrow">Session dashboard</p>
        <h1>Pinned results</h1>
      </div>
      {pins.length === 0 ? (
        <div className="empty-dashboard">No pinned products</div>
      ) : (
        <div className="pin-grid">
          {pins.map((pin) => {
            const insight = pin.result.insights.find((product) => product.id === pin.insightId);
            return (
              <article key={pin.id} className="pin-card">
                <div className="pin-header">
                  <div>
                    <p className="eyebrow">{pin.type}</p>
                    <h2>{pin.title}</h2>
                  </div>
                  <button className="icon-button small" type="button" onClick={() => onRemove(pin.id)} title="Remove pin" aria-label="Remove pin">
                    <X size={16} />
                  </button>
                </div>
                {pin.type === 'chart' ? (
                  <LazyChartPanel result={pin.result} forcedVisualizationId={pin.visualizationId} compact />
                ) : pin.type === 'insight' && insight ? (
                  <InsightGrid insights={[insight]} />
                ) : (
                  <ResultTable result={pin.result} />
                )}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
