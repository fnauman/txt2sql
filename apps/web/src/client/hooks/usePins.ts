import { useCallback, useEffect, useState } from 'react';

import { DASHBOARD_PINS_KEY, MAX_DASHBOARD_PINS } from '../lib/constants';
import { loadJson, saveJson } from '../storage';
import type { DashboardPin } from '../types';

export function usePins() {
  const [pins, setPins] = useState<DashboardPin[]>(() => loadJson<DashboardPin[]>(DASHBOARD_PINS_KEY, []));

  useEffect(() => saveJson(DASHBOARD_PINS_KEY, pins), [pins]);

  const addPin = useCallback((pin: DashboardPin) => {
    setPins((current) => [pin, ...current].slice(0, MAX_DASHBOARD_PINS));
  }, []);

  const removePin = useCallback((id: string) => {
    setPins((current) => current.filter((pin) => pin.id !== id));
  }, []);

  return { pins, addPin, removePin };
}
