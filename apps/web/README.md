# Text-to-SQL Web App

Modular React fullstack app for the repository's optimized text-to-SQL pipeline.

## Run

From the repository root:

```bash
npm run web:dev
```

This starts:

- React/Vite frontend: http://localhost:5173 (`WEB_FRONTEND_PORT`; Vite runs with `--strictPort`)
- API server: http://127.0.0.1:8787 (`WEB_API_PORT`), with Vite proxying `/api` to it

`npm run web:start` runs the API server alone (it also serves the built SPA from
`apps/web/dist` after `npm run web:build`). Both use the entry point
`src/server/main.js`, which loads the env file first and then validates the
settings: an invalid value (for example a non-integer `WEB_API_PORT`; integer
settings accept plain decimal digits only) stops startup with one error that
lists every problem. The env file is the repository root `.env` unless
`--dotenv <path>`, `ENV_FILE`, `ENV_DIR`, or `USE_HOME_ENV=1` selects another;
variables already set in the shell win over the file. From the repository root,
pass the flag through npm (`npm run web:start -- --dotenv ./config/dev.env`, same
for `web:dev`); relative paths resolve against the directory npm was run from
(`INIT_CWD`), not `apps/web`.

## Configuration

The interactive UI streams over **`POST /api/query/stream`** (Server-Sent Events):
stage frames drive a live progress stepper, the generated SQL is shown the instant
the model returns it, then `columns → residency → rows → viz → insights → layout → metrics`
frames fill the result progressively (the `residency` and `layout` frames are emitted
only when present). The blocking **`POST /api/query`** (JSON) is
the same pipeline with a non-streaming serializer, kept for CLIs/curl/tests. Both
share the auth + rate-limit middleware.

The API never executes client-supplied SQL — the browser only sends a natural-language
question, and the server runs the same read-only validation as the CLI before executing.
Database work is bounded: a MariaDB statement timeout, a server-side row cap
(`sql_select_limit`, and the read stops at the cap even under a larger explicit
`LIMIT`), and `KILL QUERY` for a running query when the request is cancelled
(Stop button, client disconnect or `WEB_REQUEST_TIMEOUT_MS`). A capped result
reports `truncated: true` with `totalRowCount: null`, and the UI shows "N+ rows".

| Env var | Default | Purpose |
|---|---|---|
| `WEB_API_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only on trusted networks, with `WEB_API_TOKEN` set. |
| `WEB_API_PORT` | `8787` | API port. |
| `WEB_FRONTEND_HOST` | `127.0.0.1` | Vite dev-server bind address (read by `vite.config.ts`). Set `0.0.0.0` or a LAN IP only on trusted networks; browsers on other hosts also need their origin in `WEB_ALLOWED_ORIGINS`. |
| `WEB_FRONTEND_PORT` | `5173` | Vite dev-server port for `web:dev` (falls back to `VITE_PORT`). Also part of the default allowed origins. |
| `WEB_ALLOWED_HOSTS` | _(empty)_ | Extra `Host` names to accept, comma/space-separated; a leading dot (`.example.test`) also matches subdomains. On a loopback bind, requests for any other non-loopback `Host` get 403 `HOST_NOT_ALLOWED` (DNS-rebinding protection). A non-loopback bind is only checked when this is set. |
| `WEB_ALLOWED_ORIGINS` | `http://{localhost,127.0.0.1,[::1]}` on the frontend and API ports | Browser origins allowed to call the API. An API request from any other `Origin` gets 403 `ORIGIN_NOT_ALLOWED`. Same-origin requests are accepted only when the `Host` header is validated (loopback bind or `WEB_ALLOWED_HOSTS`), so a non-loopback bind without `WEB_ALLOWED_HOSTS` must list its own origin here for the built SPA. |
| `WEB_API_TOKEN` | _(unset)_ | When set, `/api/query`, `/api/query/stream`, `/api/insights`, `/api/admin/*` and `/api/health?deep=1` require `Authorization: Bearer <token>` (or an `x-api-token` header). Unset leaves the query routes open for local use and disables the admin endpoint. |
| `WEB_ALLOW_DEBUG` | on for a loopback bind, off otherwise | Whether a client's `debug` flag is honored (prompts, raw model output and the trace). When off, the flag is ignored and infra error messages are redacted for callers without the token. |
| `WEB_RATE_LIMIT_MAX` | `30` | Max requests per window per client IP for the query, insights and admin endpoints. `0` disables limiting. |
| `WEB_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `WEB_MAX_QUESTION_LENGTH` | `2000` | Max question length (longer questions get 413 `QUESTION_TOO_LONG`). |
| `WEB_QUERY_ROW_LIMIT` | `1000` | Max rows returned to the browser (the server-side row cap). |
| `WEB_QUERY_STATEMENT_TIMEOUT_MS` | `QUERY_STATEMENT_TIMEOUT_MS`, else `8000` | MariaDB statement timeout for generated SQL (bounds the tail so a pathological join can't pin the shared instance). `0` disables. |
| `WEB_QUERY_MAX_RETRIES` | `1` | Extra model attempts after a failed generation, validation or execution (0 to 5). Provider outages and infra failures are not retried. The `optimized` CLI reads it too. |
| `WEB_REQUEST_TIMEOUT_MS` | `120000` | Per-request deadline; when it passes, the OpenAI call is aborted and the running query killed. `0` disables. It also bounds how long a schema refresh lets in-flight questions keep the old runtime: it is closed when they finish, or at the latest this deadline + 30 s after the refresh; with `0` it waits for them however long they run (only shutdown closes it earlier). |
| `WEB_DB_CONNECTION_LIMIT` | `5` | MariaDB pool size. |
| `WEB_RESULT_CACHE` | enabled | Exact-match NL→result cache for the web routes. On by default; set to `0` (or `false`/`no`/`off`) to disable. It only caches results from `demo_retail` read as `demo_readonly`. |
| `WEB_RESULT_CACHE_TTL_MS` | `900000` | Cache entry TTL (15 min). Bounds staleness from column-level schema drift. |
| `WEB_RESULT_CACHE_SIZE` | `200` | Max cached results (LRU). `0` disables the cache. |
| `WEB_SHUTDOWN_TIMEOUT_MS` | `10000` | On SIGTERM/SIGINT the server stops accepting connections and drains in-flight requests for up to this long, then closes the query runtimes (their DB pools, including one an admin schema refresh is still building), waiting up to this long again; a runtime still loading then is closed as soon as it finishes. A second signal within 1 s counts as a duplicate; one after that exits immediately. |
| `OPENAI_TIMEOUT_MS` / `OPENAI_MAX_RETRIES` | `60000` / `1` | OpenAI SDK timeout per HTTP attempt and transport retries. |

**Endpoints besides the query routes:**

- `GET /api/health` is unauthenticated and cheap (the status bar polls it). `GET /api/health?deep=1` loads the query runtime and touches the database; it requires the token when one is configured. The runtime creates the OpenAI client first, so without `OPENAI_API_KEY` the deep check returns 503 `OPENAI_NOT_CONFIGURED` with `dbReachable: null` (the database was not tried) and no privilege report. Only callers that present the token see the DB host/port, env path, schema and the query-user privilege report; anonymous callers never do.
- `POST /api/admin/refresh-schema` rebuilds the runtime from a freshly compiled schema and clears the result cache. It requires `WEB_API_TOKEN` (403 `ADMIN_DISABLED` when none is configured). In-flight questions finish on the old runtime, whose pool is closed once they are done. The old `refreshSchema` flag in query bodies is ignored.

**Request hardening:** responses carry `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and
`Cross-Origin-Resource-Policy: same-origin`. Malformed JSON, oversized bodies and
invalid input get a 4xx with an error `code`. A failed question reports
its stage (`llm`, `validation`, `execution`, `aborted`, `infra`) and an error
code: the JSON result has top-level `errorStage`/`errorCode` plus `error.code`
and `error.stage`, and the SSE `error` frame's data is that same `error` object
(`name`, `message`, `code`, `stage`). Validation failures also carry
`error.layer` (`safety` or `guardrail`) in both. LLM provider outages map to
502/503/504, and an unanswerable question to 422. At startup the server logs the
effective settings and warns when the query user has more than `SELECT`.

**Auth and the browser:** `WEB_API_TOKEN` is meant for non-browser callers
(scripts/curl) and for deployments fronted by a **trusted reverse proxy that
injects the `Authorization` header**. Do **not** ship the token to the browser —
the SPA never reads it, because any secret baked into client JS (e.g. a Vite
`VITE_*` value) is readable by anyone who loads the page and is therefore not
access control. For real browser auth, put the app behind a session/OAuth proxy.

Errors returned to the browser are sanitized (no stack traces); full detail is
available in the debug trace when debug is allowed and the Debug toggle is on.

When Vite is started directly rather than through `web:dev`, its `/api` proxy
targets `VITE_API_PROXY`, else `WEB_API_HOST`/`WEB_API_PORT` from the shell
environment, else `http://127.0.0.1:8787`.

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
  **Stop** button that aborts the in-flight generation server-side and kills a
  running query (the `AbortController` also fires on client disconnect).
- **Exact-match result cache** — repeated questions (example chips, recents) replay
  in ~0ms with a `cached` badge; busts on schema drift; demo data only.
- **Statement timeout and row cap** on generated SQL to bound the tail on the shared instance.
- **Virtualized results table** — all returned rows with filtering, sorting,
  column visibility, and full-set CSV export; a result cut at the row cap is
  labeled "N+ rows" rather than silently truncated.
- **Error banner** with the stage a question failed in and a plain-language
  headline chosen from the error code, validator layer and stage.
- **Adaptive layout** — a deterministic, Zod-validated `LayoutSpec` of typed blocks
  rendered through a trusted component registry (no `eval`/`dangerouslySetInnerHTML`);
  the seam that generalizes to csv/xlsx/pdf agents.
- **Gated client-side cross-filter** — for synthetic `demo_retail` data only, filter
  in the browser (arquero, lazy-loaded) and recompute charts/KPIs with zero
  round-trips; enforced by a default-deny `dataResidency` gate.
- Deterministic insight cards (with runnable follow-up suggestions), local session
  dashboard pins, and an optional debug trace panel.
