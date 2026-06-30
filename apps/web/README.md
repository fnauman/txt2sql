# Text-to-SQL Web App

Modular React fullstack app for the repository's optimized text-to-SQL pipeline.

## Run

From the repository root:

```bash
npm run web:dev
```

This starts:

- React/Vite frontend: http://localhost:5173
- API server: http://127.0.0.1:8787

The API server loads the repository root `.env` by default unless `ENV_FILE`, `ENV_DIR`, or `USE_HOME_ENV=1` is set. It binds to `127.0.0.1` by default; set `WEB_API_HOST=0.0.0.0` only for trusted networks, and use `WEB_ALLOWED_ORIGINS` to list allowed browser origins.

## Configuration

The interactive UI streams over **`POST /api/query/stream`** (Server-Sent Events):
stage frames drive a live progress stepper, the generated SQL is shown the instant
the model returns it, then `columns → residency → rows → viz → insights → layout → metrics`
frames fill the result progressively (the `residency` and `layout` frames are emitted
only when present). The blocking **`POST /api/query`** (JSON) is
the same pipeline with a non-streaming serializer, kept for CLIs/curl/tests. Both
share the auth + rate-limit middleware.

The API never executes client-supplied SQL — the browser only sends a natural-language
question, and the server runs the same read-only guardrails as the CLI before executing.
Additional server-side controls:

| Env var | Default | Purpose |
|---|---|---|
| `WEB_API_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only on trusted networks. |
| `WEB_ALLOWED_ORIGINS` | localhost/loopback | Comma/space-separated list of allowed browser origins (CORS). |
| `WEB_API_TOKEN` | _(unset)_ | When set, `/api/query`, `/api/query/stream`, and `/api/insights` require `Authorization: Bearer <token>` (or an `x-api-token` header). Unset leaves the API open for local use. |
| `WEB_RATE_LIMIT_MAX` | `30` | Max requests per window per client IP for the query/insights endpoints. `0` disables limiting. |
| `WEB_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `WEB_MAX_QUESTION_LENGTH` | `2000` | Max question length. |
| `WEB_QUERY_ROW_LIMIT` | `1000` | Max rows returned to the browser. |
| `WEB_QUERY_STATEMENT_TIMEOUT_MS` | `8000` | MariaDB statement timeout for generated SQL (bounds the tail so a pathological join can't pin the shared instance). `0` disables. |
| `WEB_RESULT_CACHE` | enabled | Exact-match NL→result cache for the web routes. Enabled unless set to `0`. |
| `WEB_RESULT_CACHE_TTL_MS` | `900000` | Cache entry TTL (15 min). Bounds staleness from column-level schema drift. |
| `WEB_RESULT_CACHE_SIZE` | `200` | Max cached results (LRU). |

**Auth and the browser:** `WEB_API_TOKEN` is meant for non-browser callers
(scripts/curl) and for deployments fronted by a **trusted reverse proxy that
injects the `Authorization` header**. Do **not** ship the token to the browser —
the SPA never reads it, because any secret baked into client JS (e.g. a Vite
`VITE_*` value) is readable by anyone who loads the page and is therefore not
access control. For real browser auth, put the app behind a session/OAuth proxy.

Errors returned to the browser are sanitized (no stack traces); full detail is
available in the debug trace when the Debug toggle is on.

## Checks

From the repository root:

```bash
npm run web:typecheck
npm run web:build
npm run web:test
```

## Recording a demo

`apps/web/scripts/record-web-demo.mjs` drives the running UI with a headless
browser and produces `media/demo.mp4` (the GIF embedded in the root README was
generated the same way). It is not part of the app's dependencies — install the
tooling on demand:

```bash
npm i -D playwright && npx playwright install chromium   # one time; ffmpeg must also be on PATH
```

Then, with the app running against a real `.env` (so queries actually execute):

```bash
npm run web:dev                              # terminal 1
node apps/web/scripts/record-web-demo.mjs    # terminal 2 → media/demo.mp4
GIF=1 node apps/web/scripts/record-web-demo.mjs   # also writes media/demo.gif
```

Override the demo with `QUERIES='["…","…"]'`, and the frame with `WIDTH`/`HEIGHT`,
`TYPE_DELAY`, or `READ_PAUSE`. See the script header for all options.

## Features

- **Streaming query console (SSE)** — live progress stepper, SQL shown the instant
  the model returns it (before validation/execution), per-section skeletons, and a
  **Stop** button that aborts the in-flight generation server-side (the
  `AbortController` also fires on client disconnect).
- **Exact-match result cache** — repeated questions (example chips, recents) replay
  in ~0ms with a `cached` badge; busts on schema drift; demo data only.
- **Statement timeout** on generated SQL to bound the tail on the shared instance.
- **Virtualized results table** — all returned rows (no silent truncation) with
  filtering, sorting, column visibility, and full-set CSV export.
- **Adaptive layout** — a deterministic, Zod-validated `LayoutSpec` of typed blocks
  rendered through a trusted component registry (no `eval`/`dangerouslySetInnerHTML`);
  the seam that generalizes to csv/xlsx/pdf agents.
- **Gated client-side cross-filter** — for synthetic `demo_retail` data only, filter
  in the browser (arquero, lazy-loaded) and recompute charts/KPIs with zero
  round-trips; enforced by a default-deny `dataResidency` gate.
- Deterministic insight cards (with runnable follow-up suggestions), local session
  dashboard pins, and an optional debug trace panel.
