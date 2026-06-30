import { Activity, CheckCircle2, Database } from 'lucide-react';

import type { HealthResponse } from '../../types';

export function StatusBar({ health }: { health: HealthResponse | null }) {
  const ready = Boolean(health?.openAiConfigured && health?.dbConfigured);
  const missing = [
    health && !health.openAiConfigured ? 'AI model access' : null,
    health && !health.dbConfigured ? 'database connection' : null,
  ].filter(Boolean);
  const statusTitle = !health
    ? 'Checking service status…'
    : ready
      ? 'The query service is connected and ready.'
      : `Setup needed: ${missing.join(' and ')} not configured on the server.`;

  return (
    <div className="status-bar" aria-live="polite">
      <span className={ready ? 'status-pill ready' : 'status-pill warning'} title={statusTitle}>
        {ready ? <CheckCircle2 size={15} /> : <Activity size={15} />}
        {!health ? 'Connecting…' : ready ? 'Ready' : 'Setup needed'}
      </span>
      <span className="status-detail" title="Model used to generate SQL">
        <Database size={15} />
        {health?.model || 'checking model…'}
      </span>
    </div>
  );
}
