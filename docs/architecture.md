# Architecture & Design Rationale

This document explains **why** the system is built the way it is. The
[README](../README.md) is the how-to reference (commands, env vars, script
descriptions); this is the design narrative behind it.

The guiding idea throughout: **the LLM proposes, a small deterministic layer
disposes.** Retrieval is *enforced*, not advisory; safety is *checked*, not
assumed; dates and entity names are *resolved* before the model ever sees the
question. Every deterministic step is plain, testable JavaScript and adds no
extra LLM calls.

```
question
   │
   ▼  temporal normalization      "March 2026" → [2026-03-01, 2026-04-01)
   ▼  semantic retrieval          pick only the in-scope tables a question needs
   ▼  master-data resolution      resolve "sparkling water" → bounded candidate rows
   ▼  LLM (structured JSON out)    { sql, explanation, tables_used, assumptions }
   ▼  deterministic guardrails     re-validate SQL vs the exact schema it saw
   ▼  read-only execution          single SELECT/WITH, table allow-list, statement timeout
   ▼  value-aware result scoring
```

The CLI (`scripts/*`) and the web server (`apps/web/`) call the **same** core
pipeline in `src/`. The orchestration lives in `src/query-service.js`; the heavy
lifting (retrieval, prompt construction, safety) lives in `src/pipeline.js`.

---

## Core pipeline design decisions

### Why rule-based semantic retrieval instead of embeddings

Retrieval narrows a potentially huge ERP schema down to the few tables a
question actually needs, so the prompt stays small and the model can't invent
joins across tables it never saw. It is deliberately **rule-based and lexical**,
not an embedding model or a vector database:

- Lexical token scoring weights matches by where they land — table name, table
  alias, table description, column name, column comment (`scoreTableDetailed` in
  `src/pipeline.js`).
- Curated **semantic boosts** from `metadata/semantic-layer.json` push the
  preferred tables for known business phrasing (entities, metrics, filter hints,
  join hints).
- The top-scoring tables are then expanded along **shortest foreign-key join
  paths** (BFS over the FK graph) so a question that needs a bridge table gets it.

The deliberate trade-off: new vocabulary must be added on purpose. The payoff is
the failure mode — when a business term is missing, the fix is a **visible,
testable edit** in `metadata/semantic-layer.json` plus a retrieval test, not an
opaque vector nudge. Hybrid lexical + embedding retrieval is listed as future
work rather than silently implied.

### Why guardrails re-validate the model's SQL deterministically

Structured output (a provider-enforced JSON schema with `sql`, `explanation`,
`tables_used`, `assumptions`) makes the model's answer *parseable*, not
*trustworthy*. Two deterministic layers re-check it before anything runs:

1. **Read-only enforcement** (`validateReadOnlySql` + `READ_ONLY_DENYLIST` in
   `src/pipeline.js`): the first keyword must be `SELECT`/`WITH`, it must be a
   single statement, and a keyword/function denylist blocks DML/DDL,
   `INTO OUTFILE`/`DUMPFILE`, locking reads, `@`/`@@` variables,
   `information_schema`/`performance_schema`/`mysql`/`sys`, and
   timing/exfiltration functions. The table allow-set is enforced **fail-closed**,
   which is also what rejects cross-database references like `FROM otherdb.Table`.
2. **Schema-aware validation** (`validateSqlGuardrails` in
   `src/sql-guardrails.js`): every qualified table/column must exist in the
   *exact* schema context the model saw, joins must match in-scope foreign keys
   or declared join hints, metrics must use their canonical columns, filter IDs
   must come from the resolved candidate list, and `tables_used` must stay inside
   the allowed set and cover every table the SQL references. Query-local CTE
   names from `WITH … AS (…)` are recognized as temporary identifiers.

Rationale: defense-in-depth beats trusting a schema-shaped JSON blob. These are
local checks, so they cost nothing and are covered by the `test/sql-*` suites.

### Why master-data resolution is product-only (today)

Ambiguous entity names ("sparkling water") are the classic place a model
hallucinates an ID. Rather than let it guess, the pipeline resolves product
terms **before generation**: terms are extracted from semantic filter hints,
expanded through editable value aliases, and looked up against a whitelist of
`Product` columns (`ProductName`/`ProductCode`/`ProductTags`) with parameterized
SQL. Only the top candidate rows reach the prompt — the full product master
never does (defaults: 200 DB rows per term, 20 ranked candidates, top 8
rendered).

Only the **product** entity is implemented today. Other entity types (customers,
ledger accounts, …) would each need their own resolver and matching guardrail
support before they could be trusted. This is a deliberate scoping decision for a
reference project, not an oversight.

### Why temporal phrases are normalized before the model sees them

Date logic is where models quietly produce off-by-a-month or inclusive/exclusive
boundary bugs. So phrases like "March 2026" are rewritten into explicit
**half-open ranges** — `[2026-03-01, 2026-04-01)` — before the question reaches
the prompt, making the boundary deterministic. The current normalizer handles
**month-name + year** only; relative dates, quarters, and YTD are out of scope
and are not overclaimed.

### Why the prompt is split system / schema-prefix / question

The prompt is laid out in three segments to maximize provider prompt-cache reuse:

- **System message** — globally stable instructions and business rules.
- **Schema-context prefix** — built with the question tokens *empty*, so it is
  identical for any two questions that retrieve the same tables.
- **Question-specific context** — the volatile tail (the question, resolved
  candidates, retry context).

Because the long, stable prefix comes first, repeated questions over the same
retrieved tables reuse a large cached prefix instead of re-sending the full
context (`summarizePromptCacheLayout` reports the cacheable-prefix size offline;
real savings are confirmed from provider `cached_tokens` on live runs).

### Reliability is measured, not assumed

Generation is non-deterministic, so one passing benchmark run is a *sample*, not
proof. The benchmark therefore scores answers with a **value-aware comparator**
(matching on values, not column aliases) and reports run-to-run variance via
`--repeat N` with a **Wilson 95% lower bound** as the honest headline. See
[evaluation-dataset.md](evaluation-dataset.md) for the scoring spec.

---

## Web application design decisions

The web app (`apps/web/`) wraps the same core pipeline. Its job is **transport
and render choreography**, not a new engine: the data path over ≤1000 synthetic
rows is already milliseconds; the dominant cost is the single blocking LLM call.
So the design targets *perceived* latency and *adaptive composition* rather than
query speed.

### One pipeline, two serializers

There are two routes over the *same* `runOptimizedQuestion` pipeline, both behind
the same auth + rate-limit middleware:

- **`POST /api/query/stream`** (Server-Sent Events) — the interactive default.
- **`POST /api/query`** (blocking JSON) — kept as a **drift-free fallback** for
  CLIs, `curl`, and tests.

Keeping the blocking route means the streaming serializer can never silently
diverge from a known-good reference.

### Streaming surfaces the most expensive artifact first

The blocking single `res.json()` made the screen a dead spinner until everything
was ready. The SSE route instead emits a sequence of frames so the UI fills
progressively, showing the generated SQL **the instant the model returns it**
(before validation/execution). Frame order (`streamResultFrames` in
`apps/web/src/server/index.js`):

```
sql → columns → [residency] → rows → viz → insights → [layout] → metrics → [debug] → [error] → done
```

`residency` and `layout` frames are emitted only when present. Cancellation is
real: a **Stop** button (and client disconnect) fires an `AbortController` that
reaches the in-flight OpenAI call and the DB driver server-side.

### Exact-match result cache — demo-gated

Example chips and recents replay in ~0ms via an in-memory NL→result cache
(`apps/web/src/server/result-cache.js`). It is intentionally conservative:

- The cache key folds the question, a **schema version** (table presence), the
  row limit, and the insights flag, so adding/removing a table busts it; a 15-min
  TTL bounds staleness from finer column-level drift.
- It **only caches `demo_retail` results** (`DB_NAME === demo_retail` AND
  `DB_USER === demo_readonly`) and never caches failures.
- There is deliberately **no per-identity key** — the threat model is a
  single-user local demo. Multi-tenant use would require an identity component in
  the key first.

### Data residency: client-side compute is default-deny

The MariaDB instance may also host non-demo databases, so **no non-demo data may
reach the browser**, and any client-side compute is *presentation, never access
control*. `resolveDataResidency` returns `engine: 'client-ok'` **only** for the
`demo_retail` + `demo_readonly` source and `server-only` otherwise (the
`data-residency.test.js` suite fails closed for other databases, the `root` user,
and empty env). The gated client-side cross-filter (arquero, lazy-loaded)
re-runs the pure result-intelligence functions over already-returned demo rows
with zero round-trips — and stays inert for any non-demo source.

### Adaptive layout: a validated spec through a trusted registry

Results are composed from an ordered, Zod-validated **`LayoutSpec`** of typed
blocks (`src/result-layout.js` → `lib/layout-schema.ts`), rendered through a
hard-coded `{ blockType → Component }` registry (`blocks/registry.tsx`) — **no
`eval`, no `dangerouslySetInnerHTML`**. The deterministic first paint is decided
from the data *shape*; any LLM `layout_hint` is optional, validated against the
real columns, and may only *refine* the layout, never block first paint. Unknown
block types fall back to a typed placeholder. This is also the seam that future
csv/xlsx/pdf agents can reuse.

### Virtualized results — no silent truncation

The results table renders **all** returned rows via TanStack Table +
`react-virtual` (filter, sort, column visibility, full-set CSV export), replacing
an earlier hand-sliced 300-row table that silently dropped data.

### Bounding the tail

A model-generated cartesian join can't pin a shared instance: generated SQL runs
under a MariaDB statement timeout (`SET STATEMENT max_statement_time …`, default
8000 ms), and the API is loopback-bound with opt-in bearer auth that is **never
shipped to the browser**.

---

## Invariants (do not regress)

- **Data residency.** Client-side compute/caching is gated on
  `DB_USER === demo_readonly` AND `DB_NAME === demo_retail`, default-deny. Never
  ship non-demo data to the browser.
- **NL-only in.** The browser sends a natural-language question only — never SQL.
  Read-only guardrails run unchanged on the *complete* SQL before any execution.
  There is no raw-SQL endpoint.
- **One pipeline, two serializers.** The streaming route must wrap the same
  pipeline as the blocking route; keep the blocking JSON route as a drift-free
  fallback.
- **Auth.** `WEB_API_TOKEN` is never shipped to the browser; new routes must be
  covered by the same auth/rate-limit middleware.

## Known limitations & risks

- `npm run bootstrap-db` creates an **empty** schema; useful results need
  `npm run seed-demo` (or your own seed data).
- Master-data resolution covers **products only**; other entities need explicit
  resolver + guardrail support before being relied on.
- Temporal normalization handles **month-name + year** only.
- Prompt-cache reports are **offline estimates**; confirm real savings from
  provider `cached_tokens` on live runs.
- Semantic metadata is intentionally **small and curated**; grow it from observed
  user language, with tests, rather than synthetic prompts alone.
- The result cache has **no per-identity key** (single-user scope by design).

## Diagnosing a failure

When a question produces the wrong answer, separate the failure class before
fixing anything:

1. **Retrieval miss** — the right tables weren't selected. Run
   `npm run debug-retrieval -- "<question>"` and inspect semantic matches,
   temporal normalization, retrieved examples, and expanded tables. Fix semantic
   metadata or scoring.
2. **Validation error** — the model's SQL failed a guardrail. Inspect the
   `sql.validated.validation.guardrails` trace event and the model's assumptions.
3. **Execution error / result mismatch** — the SQL ran but returned the wrong
   shape or values. Use `npm run benchmark -- --trace` to separate retrieval
   misses, validation errors, execution errors, low-signal successes, and result
   mismatches.
4. **Entity ambiguity** — run `npm run resolve-master-data -- "<question>"` and
   check the returned product candidates.
