# Frontend Redesign Plan — Low-Latency, Dynamic, Adaptive UI

Author: Claude Opus 4.8 (Claude Code with Ultracode)
Date: 2026-06-19

> Status: living document. Each phase below maps to one GitHub issue + one pull request.
> Implementation notes, assumptions, and hiccups are recorded as **comments on the
> corresponding issue**, not in this file.

## Why (the diagnosis)

The web app's snappiness is a **frontend-choreography problem, not an engine problem**.
Measured cost per request:

- **~80–95% of wall-clock is the single blocking LLM call** (`generateOptimizedResponse`
  in `src/pipeline.js`, no `stream:true`).
- The data path (`executeReadOnlySql` over ≤1000 synthetic rows) is already **milliseconds**.
- The server returns one big `res.json()` and the client renders **everything at once**, so
  the screen is a dead spinner for 1–3s and then the whole dashboard pops in.

This is the key reframe of the Databricks **Lakehouse-RT / Reyden** analogy: Reyden solves a
real-time *engine/serving* problem (sub-100ms aggregation at high QPS over large governed data).
This repo, at small/medium scale, instead needs **transport + render choreography**, **caching
of the expensive step**, and **adaptive composition** — not a new engine.

## The mental model: three layers

| Layer | Governs | Lever |
|---|---|---|
| **1. Perceived latency** | what the user *feels* before "something useful" appears | stream pipeline stages; show the most expensive artifact (the SQL) the instant it exists; per-section skeletons |
| **2. Actual latency** | real wall-clock + round-trips | cache the NL→SQL step (not execution); bound the query tail; exploit prompt-prefix caching; kill post-query round-trips |
| **3. Adaptive UI** | *what* to show & how to compose it | decide layout deterministically from data **shape**; keep any LLM layout decision *off* the first-paint path |

Discipline: keep the layers **separate** and build in **leverage-per-effort order**. Steps 1–3
(Phases 0–2 below) deliver ~90% of the felt + actual improvement.

## Hard constraints (do not regress)

- **Data residency / shared instance.** The MariaDB instance may also host sensitive non-demo
  databases; the demo connects only through the SELECT-only `demo_readonly` user scoped to
  `demo_retail`. **Never ship non-demo data to the browser.**
  Any client-side compute or caching path must be gated on `DB_USER === demo_readonly` **AND**
  `DB_NAME === demo_retail`, default-deny. Client-side filtering is *presentation, never access control*.
- **NL-only in.** The browser never sends SQL. `validateReadOnlySql` / guardrails run unchanged on
  the **complete** SQL before any execution. No raw-SQL endpoint, ever.
- **One pipeline, two serializers.** The streaming route must wrap the *same* pipeline as the
  blocking route; keep the blocking JSON route as a drift-free fallback for CLI/curl/tests.
- **Auth.** `WEB_API_TOKEN` is never shipped to the browser. New routes must be covered by the same
  auth/rate-limit middleware (and any reverse-proxy auth rules).

---

## Phases (each = 1 issue + 1 PR, stacked)

### Phase 0 — Split `App.tsx` (pure refactor, prerequisite)
- **Goal:** break the ~800-line monolith into `features/`, `hooks/`, `lib/` so later phases are
  tractable. Zero behavior change.
- **Files:** `apps/web/src/client/App.tsx` (→ shell), new `features/{ask,result,dashboard}/*`,
  `hooks/{useHealth,useRecentQueries,usePins}.ts`, `lib/{constants,table-utils,pin-utils}.ts`.
- **Effort:** M · **Impact:** iteration velocity (no runtime change).
- **Done when:** `web:typecheck` + `web:test` green; manual smoke identical to before.

### Phase 1 — SSE streaming: stage frames + SQL-on-arrival + skeletons (Layer 1)
- **Goal:** convert the single blocking `res.json` into a sequence of SSE frames over the same
  pipeline; emit the generated SQL the instant the LLM returns; replace the global spinner with a
  live progress stepper + per-section skeletons.
- **Files:** `apps/web/src/server/index.js` (+`/api/query/stream`, streaming trace logger),
  `apps/web/src/client/api.ts` (+`runQueryStream`), new `hooks/useQueryStream.ts`,
  `features/ask/{ProgressStepper,SqlPlanCard,ResultRegion}.tsx`,
  `features/result/skeletons/*`, `styles.css`.
- **Effort:** L · **Impact:** the headline felt win.
- **Done when:** stepper + SQL card appear ≲200ms after submit; sections fill progressively;
  blocking route still works; tests green.

### Phase 2 — Exact-match NL→result cache + statement timeout (Layer 2)
- **Goal:** make example chips / recents replay in ~0ms; bound the query tail so a model-generated
  cartesian join can't pin the shared instance.
- **Files:** new `apps/web/src/server/result-cache.js`, `apps/web/src/server/index.js`,
  `src/pipeline.js` (`executeReadOnlySql` timeout), `features/result/MetricStrip.tsx` (cacheHit badge).
- **Effort:** M · **Impact:** biggest *actual*-latency win on hot paths + availability protection.
- **Done when:** cached questions return instantly with a `cacheHit` badge; cache busts on schema
  drift; cache refuses non-`demo_retail` sources; statement timeout enforced; tests green.

### Phase 3 — Virtualized result table (Layer 3, correctness)
- **Goal:** replace the hand-sliced 300-row unvirtualized table (silent truncation) with TanStack
  Table + `react-virtual`; render all returned rows; keep filter/sort/column-hide/CSV.
- **Files:** `features/result/ResultTable.tsx` (rewrite), `apps/web/package.json`, `styles.css`.
- **Effort:** M · **Impact:** removes silent data loss, fixes single-paint jank.
- **Done when:** all rows render smoothly; CSV exports the full filtered set; tests green.

### Phase 4 — Validated LayoutSpec + trusted block registry (Layer 3, generalization seam)
- **Goal:** promote flat `visualizations[]+insights[]` into an ordered, Zod-validated `LayoutSpec`
  of typed blocks rendered through a hard-coded `{ blockType → Component }` registry (no eval /
  `dangerouslySetInnerHTML`). Any LLM `layout_hint` is optional, validated against real columns,
  and refines (never blocks) the deterministic first paint.
- **Files:** new `src/result-layout.js`, `apps/web/src/client/blocks/registry.tsx`,
  `lib/layout-schema.ts`, `apps/web/src/server/index.js`, `features/ask/ResultRegion.tsx`,
  `apps/web/package.json` (zod).
- **Effort:** M–L · **Impact:** adaptive composition + the seam reused by future md/csv/pdf agents.
- **Done when:** layout renders from a validated spec; unknown block → typed fallback; tests green.

### Phase 5 — *Gated:* client-side cross-filter via arquero (Layer 2 round-trip killer)
- **Goal:** after rows land, run sort/filter/re-aggregate **client-side** over already-returned
  demo rows (zero round-trips); re-run the pure `result-intelligence.js` client-side so charts/KPIs
  react live. **`demo_retail` only.** DuckDB-WASM explicitly deferred until the row cap rises.
- **Files:** new `hooks/useLocalDataset.ts`, `apps/web/src/server/index.js` (`dataResidency` stamp +
  assertion), new `apps/web/test/data-residency.test.js`, `features/result/{ChartPanel,InsightGrid}.tsx`,
  `apps/web/package.json` (`@uwdata/arquero`).
- **Effort:** M · **Impact:** live mini-dashboard; second-order at 1000 rows (hence gated).
- **Done when:** filtering recomputes charts/KPIs client-side with zero network; residency gate
  default-denies; residency test fails closed for non-demo sources.
  - **Note:** call `suggestVisualizations(rows, columns)` *positionally* (it is not object-style,
    unlike `createResultInsights`).

---

## Libraries to add

| Phase | Package | Why |
|---|---|---|
| 3 | `@tanstack/react-table` + `@tanstack/react-virtual` | headless, on-brand virtualized table; removes the 300-row slice |
| 4 | `zod` | validate the LayoutSpec (+ optional LLM hint) before rendering |
| 5 | `@uwdata/arquero` | tiny no-WASM dataframe for instant client-side slice/dice at 1000 rows |

## Cross-cutting (verification surfaced these — address as encountered)

- Distinct **empty / zero-row** state vs "still streaming"; "no chart for this shape" state.
- **Partial-stream failure**: if the reader ends without a terminal `done`/`error`, surface
  "connection interrupted, retry" (hand-rolled, since `fetch`+`getReader` has no native reconnect).
- **a11y**: `aria-live` on stepper/skeletons; virtualized table needs `aria-rowcount`/`aria-rowindex`;
  honor `prefers-reduced-motion`.
- **AbortController** must reach the OpenAI call + DB driver (pool is only 5; stuck streams starve it).
- **Observability**: log p50/p95 per-stage latency, cache-hit rate, statement-timeout aborts.
- **Compression**: if Express `compression` is ever added, exclude the SSE route or `res.flush()` per frame.
- **Prompt-prefix caching** (near-free ~50% input discount): verify the prompt prefix is stable
  (system + schema first, question last) so OpenAI auto-caching hits.
