import { useEffect, useMemo, useState } from 'react';

import type { QueryResponse } from '../types';

type Engine = typeof import('../lib/local-engine');

// Gated client-side cross-filter. When the server marks the rows
// `dataResidency.engine === 'client-ok'` (synthetic demo_retail only), filtering
// happens IN THE BROWSER — recomputing charts + KPIs with the same pure helpers
// the server uses, zero round-trips, zero LLM cost. For any other source the hook
// is inert and the original server result flows through unchanged.
//
// The heavy arquero engine is dynamically imported only on first cross-filter, so
// it never weighs down the initial bundle / first paint.
export function useLocalDataset(result: QueryResponse) {
  const enabled = result.dataResidency?.engine === 'client-ok' && result.rows.length > 0;
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    if (!enabled || !query.trim() || engine) {
      return;
    }
    let cancelled = false;
    import('../lib/local-engine').then((module) => {
      if (!cancelled) {
        setEngine(module);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, query, engine]);

  const liveResult = useMemo<QueryResponse>(() => {
    const needle = query.trim();
    if (!enabled || !needle || !engine) {
      return result; // until the engine chunk loads, show the full result
    }
    return engine.filterDataset(result, needle);
  }, [enabled, query, engine, result]);

  return {
    enabled,
    query,
    setQuery,
    liveResult,
    filteredCount: liveResult.rows.length,
    totalCount: result.rows.length,
    active: enabled && query.trim().length > 0,
  };
}
