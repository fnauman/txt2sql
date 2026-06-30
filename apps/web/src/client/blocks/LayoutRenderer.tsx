import type { InsightCard, LayoutSpec, QueryResponse } from '../types';
import { renderBlock, type PinHandler } from './registry';

// Renders a validated LayoutSpec by iterating blocks through the trusted registry.
// `width: 'half'` blocks pair up on a two-column grid; `'full'` spans the row —
// reproducing the chart+table side-by-side layout while staying data-driven.
export function LayoutRenderer({
  spec,
  result,
  onPin,
  onFollowUp,
  hideTableFilter,
}: {
  spec: LayoutSpec;
  result: QueryResponse;
  onPin: PinHandler;
  onFollowUp?: (insight: InsightCard) => void;
  hideTableFilter?: boolean;
}) {
  return (
    <div className="layout-grid">
      {spec.blocks.map((block) => (
        <div key={block.id} className={`layout-cell ${block.width === 'half' ? 'half' : 'full'}`}>
          {renderBlock(block, { result, onPin, onFollowUp, hideTableFilter })}
        </div>
      ))}
    </div>
  );
}
