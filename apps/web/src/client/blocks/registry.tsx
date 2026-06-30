import type { ReactNode } from 'react';

import type { DashboardPin, InsightCard, LayoutBlock, QueryResponse, VisualizationSuggestion } from '../types';
import { LazyChartPanel } from '../features/result/LazyChartPanel';
import { InsightGrid } from '../features/result/InsightGrid';
import { ResultTable } from '../features/result/ResultTable';

export type PinHandler = (
  type: DashboardPin['type'],
  options?: { visualization?: VisualizationSuggestion; insight?: InsightCard }
) => void;

export interface BlockContext {
  result: QueryResponse;
  onPin: PinHandler;
  onFollowUp?: (insight: InsightCard) => void;
  hideTableFilter?: boolean;
}

// Trusted registry: block.type is a NAME looked up in this dictionary. There is
// no eval, no new Function, no dangerouslySetInnerHTML, no dynamic import of
// model-supplied strings. An unknown type renders a typed fallback, never the
// raw input.
const BLOCK_REGISTRY: Record<string, (block: LayoutBlock, ctx: BlockContext) => ReactNode> = {
  kpiStrip: (_block, { result, onPin, onFollowUp }) => (
    <InsightGrid insights={result.insights} onPin={(insight) => onPin('insight', { insight })} onFollowUp={onFollowUp} />
  ),
  chart: (block, { result, onPin }) => (
    <LazyChartPanel
      result={result}
      forcedVisualizationId={block.visualizationId}
      onPin={(visualization) => onPin('chart', { visualization })}
    />
  ),
  table: (_block, { result, onPin, hideTableFilter }) => (
    <ResultTable result={result} onPin={() => onPin('table')} hideFilter={hideTableFilter} />
  ),
  narrative: (block) => (
    <section className="tool-panel narrative-card">
      {block.title && <h2>{block.title}</h2>}
      {block.body && <p>{block.body}</p>}
    </section>
  ),
};

function FallbackBlock({ block }: { block: LayoutBlock }) {
  return (
    <section className="tool-panel compact-empty">
      <div className="empty-state">Unsupported block: {block.type}</div>
    </section>
  );
}

export function renderBlock(block: LayoutBlock, ctx: BlockContext): ReactNode {
  const render = BLOCK_REGISTRY[block.type];
  if (!render) {
    return <FallbackBlock block={block} />;
  }
  return render(block, ctx);
}
