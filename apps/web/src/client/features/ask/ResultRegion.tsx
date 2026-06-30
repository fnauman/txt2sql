import { useMemo } from 'react';

import type { StreamState } from '../../hooks/useQueryStream';
import type { DashboardPin, InsightCard, VisualizationSuggestion } from '../../types';
import { validateLayout } from '../../lib/layout-schema';
import { useLocalDataset } from '../../hooks/useLocalDataset';
import { LayoutRenderer } from '../../blocks/LayoutRenderer';

import { ProgressStepper } from './ProgressStepper';
import { SqlPlanCard } from './SqlPlanCard';
import { CrossFilter } from '../result/CrossFilter';
import { LazyChartPanel } from '../result/LazyChartPanel';
import { DebugPanel } from '../result/DebugPanel';
import { ErrorBanner } from '../result/ErrorBanner';
import { InsightGrid } from '../result/InsightGrid';
import { MetricStrip } from '../result/MetricStrip';
import { ResultTable } from '../result/ResultTable';
import { ChartSkeleton, MetricSkeleton, TableSkeleton } from '../result/skeletons/Skeletons';

type PinHandler = (
  type: DashboardPin['type'],
  options?: { visualization?: VisualizationSuggestion; insight?: InsightCard }
) => void;

export function ResultRegion({
  state,
  debugEnabled,
  onPin,
  onFollowUp,
}: {
  state: StreamState;
  debugEnabled: boolean;
  onPin: PinHandler;
  onFollowUp?: (insight: InsightCard) => void;
}) {
  const { status, result, hasColumns, hasRows, hasViz, hasInsights, cacheHit } = state;
  const streaming = status === 'streaming';
  const errored = status === 'error';
  const sqlStatus = errored ? 'error' : status === 'done' ? 'done' : 'streaming';
  const zeroRows = status === 'done' && hasColumns && result.rows.length === 0;

  // Once complete, render the deterministic adaptive layout via the trusted
  // block registry. During streaming (and if no valid spec arrives) fall back to
  // the progressive skeleton path below.
  // Depend only on the fields validateLayout reads (the raw spec + the viz list
  // it cross-checks), not the whole `result` object which is replaced on every
  // streaming frame — both are swapped by-reference in their own reducer cases.
  const layout = useMemo(() => (result.layout ? validateLayout(result.layout, result) : null), [result.layout, result.visualizations]);
  const useSpec = status === 'done' && !errored && !zeroRows && Boolean(layout && layout.blocks.length > 0);

  // Gated client-side cross-filter (demo data only). When complete, charts/KPIs
  // re-derive from the filtered rows entirely in the browser.
  const local = useLocalDataset(result);
  const showCrossFilter = useSpec && local.enabled;
  const viewResult = showCrossFilter ? local.liveResult : result;

  return (
    <div className={debugEnabled ? 'result-layout with-debug' : 'result-layout'}>
      <div className="result-main">
        {streaming && <ProgressStepper stages={state.stages} />}

        {(state.hasSql || streaming) && (
          <SqlPlanCard sql={result.sql} explanation={result.explanation} status={sqlStatus} cacheHit={cacheHit} />
        )}

        {errored && state.error && <ErrorBanner error={state.error} />}

        {!errored && (hasColumns || streaming) && (hasColumns ? <MetricStrip result={result} /> : <MetricSkeleton />)}

        {!errored &&
          (zeroRows ? (
            <div className="empty-state large">The query ran successfully and returned 0 rows.</div>
          ) : useSpec && layout ? (
            <>
              {showCrossFilter && (
                <CrossFilter
                  query={local.query}
                  onChange={local.setQuery}
                  filteredCount={local.filteredCount}
                  totalCount={local.totalCount}
                  active={local.active}
                />
              )}
              <LayoutRenderer
                spec={layout}
                result={viewResult}
                onPin={onPin}
                onFollowUp={onFollowUp}
                hideTableFilter={showCrossFilter}
              />
            </>
          ) : (
            <>
              {hasInsights && result.insights.length > 0 && (
                <InsightGrid insights={result.insights} onPin={(insight) => onPin('insight', { insight })} onFollowUp={onFollowUp} />
              )}
              <div className="visual-grid">
                {hasViz ? (
                  result.visualizations.length > 0 ? (
                    <LazyChartPanel result={result} onPin={(visualization) => onPin('chart', { visualization })} />
                  ) : (
                    <section className="tool-panel chart-panel compact-empty">
                      <div className="empty-state">No chart for this shape</div>
                    </section>
                  )
                ) : streaming ? (
                  <ChartSkeleton />
                ) : null}

                {hasRows ? (
                  <ResultTable result={result} onPin={() => onPin('table')} />
                ) : streaming ? (
                  <TableSkeleton columns={hasColumns ? result.columns : []} />
                ) : null}
              </div>
            </>
          ))}
      </div>
      {debugEnabled && <DebugPanel result={result} />}
    </div>
  );
}
