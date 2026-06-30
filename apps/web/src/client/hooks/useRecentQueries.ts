import { useCallback, useEffect, useState } from 'react';

import { MAX_RECENT_QUERIES, RECENT_QUERIES_KEY } from '../lib/constants';
import { loadJson, saveJson } from '../storage';

export function useRecentQueries() {
  const [recentQueries, setRecentQueries] = useState<string[]>(() => loadJson<string[]>(RECENT_QUERIES_KEY, []));

  useEffect(() => saveJson(RECENT_QUERIES_KEY, recentQueries), [recentQueries]);

  const pushRecent = useCallback((query: string) => {
    setRecentQueries((current) => [query, ...current.filter((item) => item !== query)].slice(0, MAX_RECENT_QUERIES));
  }, []);

  return { recentQueries, pushRecent };
}
