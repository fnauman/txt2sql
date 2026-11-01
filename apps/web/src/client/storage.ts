// Query history and pinned result rows belong only to this page's memory.
// Older releases wrote them to localStorage; remove those entries without
// reading their contents or disturbing theme preferences and other apps.
export const LEGACY_SENSITIVE_KEYS = ['text-to-sql.recentQueries', 'text-to-sql.dashboardPins'] as const;

export function purgeLegacySessionData(): void {
  for (const key of LEGACY_SENSITIVE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage may be blocked. Keep trying the other key; session state never
      // depends on reading or writing persistent browser storage.
    }
  }
}

export function createSessionList<T>() {
  purgeLegacySessionData();
  let items: T[] = [];
  const listeners = new Set<() => void>();
  const update = (change: (current: T[]) => T[]) => {
    items = change(items);
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => items,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update,
    clear: () => {
      purgeLegacySessionData();
      update(() => []);
    },
  };
}
