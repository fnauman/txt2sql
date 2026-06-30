import { CornerDownLeft, Pin } from 'lucide-react';

import type { InsightCard } from '../../types';

export function InsightGrid({
  insights,
  onPin,
  onFollowUp,
}: {
  insights: InsightCard[];
  onPin?: (insight: InsightCard) => void;
  onFollowUp?: (insight: InsightCard) => void;
}) {
  if (insights.length === 0) {
    return null;
  }

  return (
    <section className="insight-grid" aria-label="Insight cards">
      {insights.map((insight) => {
        const actionable = Boolean(onFollowUp) && insight.id === 'follow-up';
        return (
          <article key={insight.id} className={`insight-card ${insight.tone}${actionable ? ' actionable' : ''}`}>
            {actionable ? (
              <button type="button" className="insight-action" onClick={() => onFollowUp?.(insight)} title="Run this follow-up query">
                <p>{insight.title}</p>
                <strong>{insight.value}</strong>
                <span>
                  {insight.detail}
                  <em className="insight-run-hint">
                    <CornerDownLeft size={12} /> run
                  </em>
                </span>
              </button>
            ) : (
              <div>
                <p>{insight.title}</p>
                <strong>{insight.value}</strong>
                <span>{insight.detail}</span>
              </div>
            )}
            {onPin && (
              <button className="icon-button small" type="button" onClick={() => onPin(insight)} title="Pin insight" aria-label="Pin insight">
                <Pin size={15} />
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
