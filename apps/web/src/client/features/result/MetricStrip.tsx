import { formatCurrency, formatValue } from '../../format';
import type { QueryResponse } from '../../types';

export function MetricStrip({ result }: { result: QueryResponse }) {
  return (
    <div className="metric-strip">
      <div>
        <span>Rows</span>
        <strong>{result.totalRowCount.toLocaleString()}</strong>
      </div>
      <div>
        <span>Attempts</span>
        <strong>{result.attemptCount || 0}</strong>
      </div>
      <div>
        <span>Tokens</span>
        <strong>{formatValue(result.llmCost?.totalTokens)}</strong>
      </div>
      <div>
        <span>Cost</span>
        <strong>{formatCurrency(result.llmCost?.totalCost, result.llmCost?.currency || 'USD')}</strong>
      </div>
    </div>
  );
}
