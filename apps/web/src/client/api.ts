import type { HealthResponse } from './types';

// NOTE: the browser never holds the API token. A shared secret embedded in
// client JS (e.g. a Vite `VITE_*` value) is readable by anyone who loads the app
// and is not access control. When the server sets `WEB_API_TOKEN`, run the UI
// behind a trusted reverse proxy that injects the `Authorization` header, or use
// a session/OAuth proxy — see apps/web/README.md.
//
// The interactive UI streams via `useQueryStream` (POST /api/query/stream). The
// blocking JSON route (POST /api/query) is intentionally kept server-side as a
// drift-free fallback for CLIs, curl, and tests — it just isn't called from here.

export async function loadHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Health request failed.');
  }

  return payload as HealthResponse;
}
