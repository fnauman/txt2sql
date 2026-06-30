import { AlertTriangle, Loader2, Zap } from 'lucide-react';

import { CopyButton } from '../result/CopyButton';

export function SqlPlanCard({
  sql,
  explanation,
  status,
  cacheHit,
}: {
  sql: string;
  explanation: string;
  status: 'streaming' | 'done' | 'error';
  cacheHit: boolean;
}) {
  const generating = status === 'streaming' && !sql;

  return (
    <section className="tool-panel sql-plan-card" aria-live="polite">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Generated SQL</p>
          <h2>{generating ? 'Writing the query…' : 'Query plan'}</h2>
        </div>
        <div className="toolbar">
          {cacheHit && (
            <span className="chip cache-chip" title="Served from the result cache">
              <Zap size={13} /> cached
            </span>
          )}
          {status === 'error' && (
            <span className="chip warn-chip" title="This query did not return a successful result">
              <AlertTriangle size={13} /> did not run
            </span>
          )}
          {sql && <CopyButton value={sql} label="Copy SQL" />}
        </div>
      </div>

      {generating ? (
        <div className="sql-pending">
          <Loader2 size={16} className="spin" />
          <span>The model is generating SQL…</span>
        </div>
      ) : (
        <>
          <pre className="sql-block">{sql || 'No SQL was generated.'}</pre>
          {explanation && <p className="sql-explanation">{explanation}</p>}
        </>
      )}
    </section>
  );
}
