import { useCallback, useState, useSyncExternalStore } from 'react';

import { MAX_DASHBOARD_PINS } from '../lib/constants';
import { createSessionList } from '../storage';
import type { DashboardPin } from '../types';

export function usePins() {
  const [session] = useState(() => createSessionList<DashboardPin>());
  const pins = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const addPin = useCallback((pin: DashboardPin) => {
    session.update((current) => [pin, ...current].slice(0, MAX_DASHBOARD_PINS));
  }, [session]);

  const removePin = useCallback((id: string) => {
    session.update((current) => current.filter((pin) => pin.id !== id));
  }, [session]);

  return { pins, addPin, removePin, clearPins: session.clear };
}
