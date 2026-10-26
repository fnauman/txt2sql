import type { HealthResponse } from '../types';

export type HealthStatus = 'checking' | 'connected' | 'unavailable';

export interface HealthSnapshot {
  health: HealthResponse | null;
  status: HealthStatus;
}

// A health request that has not answered by then counts as unavailable, so
// the status bar never stays on "Connecting…" while the API is down.
export const HEALTH_TIMEOUT_MS = 5000;

interface HealthCheckOptions {
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The health state machine behind useHealth, free of React so it can be
 * tested: each refresh aborts the previous request, a request is aborted at
 * the deadline, and only the latest request may change the snapshot.
 */
export function createHealthCheck(
  load: (signal: AbortSignal) => Promise<HealthResponse>,
  onChange: (snapshot: HealthSnapshot) => void,
  {
    timeoutMs = HEALTH_TIMEOUT_MS,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle as number),
  }: HealthCheckOptions = {}
) {
  let active: AbortController | null = null;
  let health: HealthResponse | null = null;

  async function refresh() {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const timer = setTimer(() => controller.abort(), timeoutMs);
    onChange({ health, status: 'checking' });
    try {
      const next = await load(controller.signal);
      if (active === controller) {
        health = next;
        onChange({ health, status: 'connected' });
      }
    } catch {
      if (active === controller) {
        health = null;
        onChange({ health, status: 'unavailable' });
      }
    } finally {
      clearTimer(timer);
    }
  }

  function dispose() {
    const controller = active;
    active = null;
    controller?.abort();
  }

  return { refresh, dispose };
}
