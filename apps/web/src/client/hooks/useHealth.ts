import { useEffect, useMemo, useState } from 'react';

import { loadHealth } from '../api';
import { createHealthCheck, type HealthSnapshot } from './healthCheck';

export type { HealthStatus } from './healthCheck';

export function useHealth() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>({ health: null, status: 'checking' });
  const check = useMemo(() => createHealthCheck(loadHealth, setSnapshot), []);

  useEffect(() => {
    void check.refresh();
    return () => check.dispose();
  }, [check]);

  return { health: snapshot.health, status: snapshot.status, refresh: check.refresh };
}
