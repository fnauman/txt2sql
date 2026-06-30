import { Filter, X, Zap } from 'lucide-react';

// Dataset-level cross-filter: typing here re-filters the already-returned rows in
// the browser (arquero) and recomputes charts + KPIs live — no server round-trip.
// Only shown when the data is sanctioned for client-side compute (demo data).
export function CrossFilter({
  query,
  onChange,
  filteredCount,
  totalCount,
  active,
}: {
  query: string;
  onChange: (value: string) => void;
  filteredCount: number;
  totalCount: number;
  active: boolean;
}) {
  return (
    <section className="cross-filter" aria-label="Client-side cross-filter">
      <span className="cross-filter-badge" title="Filtering happens in your browser — no server round-trip">
        <Zap size={13} /> live
      </span>
      <label className="search-field cross-filter-field">
        <Filter size={16} />
        <input
          value={query}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Cross-filter the dataset — charts & metrics update instantly"
          aria-label="Cross-filter the dataset"
        />
        {query && (
          <button className="icon-button small" type="button" onClick={() => onChange('')} title="Clear filter" aria-label="Clear filter">
            <X size={14} />
          </button>
        )}
      </label>
      {active && (
        <span className="cross-filter-count" aria-live="polite">
          {filteredCount.toLocaleString()} of {totalCount.toLocaleString()} rows
        </span>
      )}
    </section>
  );
}
