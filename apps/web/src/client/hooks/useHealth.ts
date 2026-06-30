import { useEffect, useState } from 'react';

import { loadHealth } from '../api';
import type { HealthResponse } from '../types';

export function useHealth(): HealthResponse | null {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    loadHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  return health;
}
