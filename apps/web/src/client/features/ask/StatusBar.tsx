import { Activity, CheckCircle2, Database } from 'lucide-react';

import type { HealthResponse } from '../../types';
import type { HealthStatus } from '../../hooks/useHealth';

export function StatusBar({ health, status, onRetry }: { health: HealthResponse | null; status: HealthStatus; onRetry: () => void }) {
  const unavailable = status === 'unavailable';
  const ready = Boolean(health?.openAiConfigured && health?.dbConfigured);
  const missing = [
    health && !health.openAiConfigured ? 'AI model access' : null,
    health && !health.dbConfigured ? 'database connection' : null,
  ].filter(Boolean);
  const statusTitle = unavailable
    ? 'The query service could not be reached. Retry the connection when it is available.'
    : !health
    ? 'Checking service status…'
    : ready
      ? 'The query service is connected and ready.'
      : `Setup needed: ${missing.join(' and ')} not configured on the server.`;

  return (
    <div className="status-bar" aria-live="polite">
      <span className={ready ? 'status-pill ready' : 'status-pill warning'} title={statusTitle}>
        {ready ? <CheckCircle2 size={15} /> : <Activity size={15} />}
        {unavailable ? 'Service unavailable' : !health ? 'Connecting…' : ready ? 'Ready' : 'Setup needed'}
      </span>
      <span className="status-detail" title="Model used to generate SQL">
        <Database size={15} />
        {health?.model || (unavailable ? 'Model unavailable' : 'checking model…')}
      </span>
      {unavailable && <button className="status-retry" type="button" onClick={onRetry}>Retry connection</button>}
    </div>
  );
}
