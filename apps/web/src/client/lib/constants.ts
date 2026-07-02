// Shared constants extracted from App.tsx (Phase 0 refactor — no behavior change).

export const RECENT_QUERIES_KEY = 'text-to-sql.recentQueries';
export const DASHBOARD_PINS_KEY = 'text-to-sql.dashboardPins';

export const EXAMPLES = [
  'Show outstanding balance by customer',
  'Which products sold the most this month?',
  'Monthly sales trend for sparkling water this year',
  'Top customers by invoice value',
];

// Chart palette tuned for legibility on both the light and dark console themes.
// Order: brand emerald, coral, azure, amber, violet.
export const CHART_COLORS = ['#1f9d6b', '#e0584a', '#3a7bd5', '#d4a72c', '#8a6fb0'];

export const MAX_TABLE_RENDER_ROWS = 300;
export const MAX_PINNED_ROWS = 300;
export const MAX_DASHBOARD_PINS = 18;
export const MAX_RECENT_QUERIES = 8;
