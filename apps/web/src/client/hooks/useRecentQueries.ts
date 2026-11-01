import { useCallback, useState, useSyncExternalStore } from 'react';

import { MAX_RECENT_QUERIES } from '../lib/constants';
import { createSessionList } from '../storage';

export function useRecentQueries() {
  const [session] = useState(() => createSessionList<string>());
  const recentQueries = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const pushRecent = useCallback((query: string) => {
    session.update((current) => [query, ...current.filter((item) => item !== query)].slice(0, MAX_RECENT_QUERIES));
  }, [session]);

  return { recentQueries, pushRecent, clearRecentQueries: session.clear };
}
