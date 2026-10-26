import { useCallback, useEffect, useRef, useState } from 'react';

import { loadHealth } from '../api';
import type { HealthResponse } from '../types';

export type HealthStatus = 'checking' | 'connected' | 'unavailable';

export function useHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [status, setStatus] = useState<HealthStatus>('checking');
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 5000);
    setStatus('checking');
    try {
      const next = await loadHealth(controller.signal);
      if (active.current === controller) {
        setHealth(next);
        setStatus('connected');
      }
    } catch {
      if (active.current === controller) {
        setHealth(null);
        setStatus('unavailable');
      }
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, [refresh]);

  return { health, status, refresh };
}
