# Architecture & Design Rationale

This document explains **why** the system is built the way it is. The
[README](../README.md) is the how-to reference (commands, env vars, script
descriptions); this is the design narrative behind it.

The guiding idea throughout: **the LLM proposes, a small deterministic layer
disposes.** Table scope is *enforced*, not advisory; safety is *checked*, not
assumed; dates and entity names are *resolved* before the model ever sees the
question. Every deterministic step is plain, testable JavaScript and adds no
extra LLM calls.

```
question
   │
   ▼  temporal normalization      "March 2026" → [2026-03-01, 2026-04-01)
   ▼  semantic retrieval          rank the in-scope tables; full schema scope: every in-scope table in
   ▼                              the prompt, ranking as a hint; retrieved scope: only the top tables (+ FK paths)
   ▼  master-data resolution      resolve "sparkling water" → bounded candidate rows
   ▼  LLM (structured JSON out)    { sql, explanation, tables_used, assumptions }
   ▼  deterministic validation     read-only safety layer + schema guardrails vs the exact schema it saw
   ▼  bounded execution            SELECT-only DB user, statement timeout; web: row cap, KILL on cancel
   ▼  value-aware result scoring   (benchmark only)
```

The optimized CLI (`scripts/optimized.js`) and the web server (`apps/web/`) call
the **same** orchestration, `runOptimizedQuestion` in `src/query-service.js`. The
basic CLI and the benchmark (`scripts/evaluate.js`) have their own loops over the
same building blocks (prompt builders, validator, executor), so their retry
behavior can differ. The heavy lifting (retrieval, prompt construction, safety)
lives in `src/pipeline.js`, `src/sql-tokenizer.js` and `src/sql-guardrails.js`.

---

## Core pipeline design decisions

### Why the schema scope depends on the schema size

`SCHEMA_SCOPE` (`src/schema-scope.js`, default `auto`) decides how much of the
in-scope schema the prompt shows and which tables the validator allows:

- **full**: every in-scope table in one stable schema block, the same for every
  question (one prompt-cache prefix), and every in-scope table allowed.
  Retrieval only adds a one-line hint ("most relevant tables/columns for this
  question: ...") to the question part.
- **retrieved**: the retrieved tables (plus their foreign-key paths) are both
  the schema shown and the allow-list. With **widen-on-demand** (on by default
  when auto falls back to retrieved; off for an explicit `SCHEMA_SCOPE=retrieved`,
  which is exactly the behaviour before scopes existed), a
  `TABLE_SCOPE` rejection of a table that is in scope but was not retrieved
  rebuilds the prompt with that table and its join path for the retry, within
  the same retry budget (`prompt.widened` in the trace). The join paths go to
  every retrieved table the added table reaches, at any length; the widened
  allow-list depends on the set of added tables, not their order (so the
  offline verifier and rescore rebuild it exactly), and a later widening keeps
  every table an earlier one allowed. No path is cut to fit the token budget
  (the cap is the in-scope schema); a widened schema block over
  `SCHEMA_FULL_MAX_TOKENS` is reported instead (`schemaScope.widenOverBudget`
  and the `prompt.widen_over_budget` trace event). A table outside the
  in-scope schema is rejected in every scope.
- **auto**: full while the full schema block fits `SCHEMA_FULL_MAX_TOKENS`
  (default 8,000 estimated tokens), else retrieved.

The reason is measured, not assumed (`docs/experiments/01-schema-scope.md`). On
the 13-table demo schema (about 2,300 estimated tokens in full) the retrieved
scope saved only about 8% of uncached prompt tokens (it printed its tables
twice, once stable and once ranked), split the cacheable prefix 48 ways, and
cost more than the full scope once prompt caching is counted. It also made
every retrieval miss unrecoverable: the allow-list was the retrieved set and
retries never widened it, which capped accuracy at 86.5% even with perfect
SQL. The full scope removes that failure class (ceiling 99.6%) for about 8.6%
more uncached prompt tokens. Retrieval matters again when the schema does not fit: an
ERP with hundreds of tables keeps the retrieved scope, and widen-on-demand turns
its misses back into a retry instead of a dead end.

### Why rule-based semantic retrieval instead of embeddings

Retrieval ranks the in-scope tables for a question; in the retrieved scope it
narrows a potentially huge ERP schema to a small set of relevant tables, so the
prompt stays small and the model can't invent joins across tables it never saw.
It is deliberately **rule-based and lexical**, not an embedding model or a vector
database:

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
opaque vector nudge. Embedding or hybrid retrieval is not implemented.

### Why the prompt's knowledge layer is versioned

Everything the prompt tells the model beyond the schema (business rules, the
temporal resolver, the semantic layer, retrieval's tokens, the metric
guardrail's arbitration) is one versioned layer, `HINTS_VERSION`
(`src/hints-version.js`, default 2). A change to it can then be A/B'd as one
variable against the committed baseline, with `HINTS_VERSION=1` reproducing
the baseline's prompts byte for byte. Version 2's semantic-layer changes live
in an overlay (`metadata/semantic-layer.hints-v2.json`, entries replacing the
same-named entries of `metadata/semantic-layer.json`), so the base file stays
the version-1 layer. The error analysis behind version 2, and its offline
measurements, are in `docs/experiments/02-hints-v2.md`.

Retrieval narrows rather than minimizes: "How many active customers do we
have?" still retrieves 5 of the 13 tables. In the retrieved scope the point is
that the prompt does not grow with the whole schema.

### Why guardrails re-validate the model's SQL deterministically

Structured output (a provider-enforced JSON schema with `sql`, `explanation`,
`tables_used`, `assumptions`) makes the model's answer *parseable*, not
*trustworthy*. Two deterministic layers re-check it before anything runs. Both
read the SQL through **one MariaDB-faithful tokenizer** (`src/sql-tokenizer.js`):
earlier, three regex lexers disagreed about comments, quotes and parentheses,
which is where bypasses and false rejections came from. The tokenizer follows
MariaDB's rules (for example, `--` is a comment only when followed by whitespace,
a control character or the end of input) and throws on unterminated strings,
identifiers and comments, so validation fails closed.

1. **Safety** (`validateSqlSafety` in `src/pipeline.js`, every path): a single
   `SELECT`/`WITH` statement; no comments of any kind (`SQL_COMMENT`,
   `EXECUTABLE_COMMENT`); no `WITH RECURSIVE`; every table inside the allowed
   set, with CTE names treated as query-local and the tables inside CTE bodies
   checked; any `db.table` or `db.fn()` rejected as `CROSS_DATABASE` and the
   metadata schemas as `METADATA_SCHEMA`; and a word-token denylist for
   DML/DDL, any `INTO`, `SET`, `PROCEDURE`, locking reads, index hints,
   `FOR SYSTEM_TIME`, table functions, `@`/`@@` variables, and timing, locking,
   file, sequence and session-information functions (also when backtick-quoted,
   since MariaDB runs `` `SLEEP`(5) ``). Words inside string literals are not
   tokens, so they no longer trigger the denylist.
2. **Schema-aware guardrails** (`validateSqlGuardrails` in
   `src/sql-guardrails.js`, optimized pipeline only): qualified table/column
   references must exist in the *exact* schema context the model saw (unknown
   unqualified names are caught only when mixed-case); joins must match in-scope
   foreign keys or declared join hints; explicitly named metrics must use their
   canonical columns; `SUM`/`AVG` over a parent table's column while a 1:N child
   is joined in the same `SELECT` scope is rejected as `FAN_OUT`; product ID
   literals must come from the resolved candidate list; and `tables_used` must
   stay inside the allowed set and cover every table the SQL references.

Every rejection is a `SqlValidationError` with a stable `code` and a `layer`
(`safety` or `guardrail`), which the trace, the API (`errorCode`, `error.layer`)
and the web client's error headline use instead of message text.

**Enforced vs advisory.** Metric matching arbitrates overlapping phrases
(longest span wins, so "sales documents" does not fire net sales). Explicit
metric phrases ("net sales", "revenue") are *enforced* and reject SQL that does
not use the preferred column. Metrics matched only through generic words
("sales", "sold") or in count/list/existence questions are *advisory*: they stay
prompt hints, and a miss is recorded as a `METRIC_COLUMN_NOT_USED` entry in
`guardrails.warnings[]` instead of an error. This removed false rejections of
correct `COUNT` queries without loosening the explicit cases.

Rationale: defense-in-depth beats trusting a schema-shaped JSON blob. These are
local checks, so they cost nothing; they are covered by the `test/sql-*` suites,
a bypass battery (`test/sql-bypass-battery.test.js`), a must-accept corpus of
unusual valid SQL (`test/sql-valid-unusual.test.js`), every gold query in its
real prompt context (`test/gold-sql-validator.test.js`) and recorded live model
generations (`test/live-generations.test.js`).

They are not the security boundary. The **database grants** are: the query
paths connect as a `SELECT`-only user (Docker Compose creates `demo_readonly`
with `SELECT` on `` `demo\_retail%`.* `` and nothing else), and the admin
credentials are used only by `bootstrap-db` and `seed-demo`. Known gaps in the
validator, which only the grants and the execution bounds cover:

- Resource-heavy read-only SQL (a `REPEAT()` memory bomb, a cartesian self-join)
  is accepted; the statement timeout and the web row cap bound it.
- The function check is a denylist; there is no allowlist yet.
- The master-data ID check covers product ID literals only, so a subquery or a
  join on the product name bypasses it, and other entities' IDs are unchecked.
- Unqualified column checks are partial (lower-case unknown names pass to
  MariaDB, which rejects them at execution).

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
  identical for every question in the full schema scope, and for any two
  questions that retrieve the same tables in the retrieved scope.
- **Question-specific context** — the volatile tail (the question, resolved
  candidates, retry context).

Because the long, stable prefix comes first, questions reuse a large cached
prefix (in the retrieved scope only questions over the same retrieved tables) instead of re-sending the full
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

`residency` and `layout` frames are emitted only when present. A failed question
ends with an `error` frame carrying the stage it stopped in (`llm`, `validation`,
`execution`, `aborted`, `infra`) and an error code. Cancellation is real: a
**Stop** button, a client disconnect or the request deadline
(`WEB_REQUEST_TIMEOUT_MS`) fires an `AbortController` that aborts the in-flight
OpenAI call and, if the SQL is already running, sends `KILL QUERY` for it over a
separate short-lived connection (a pool slot could be queued behind the very
query it should stop).

### Exact-match result cache — demo-gated

Example chips and recents replay in ~0ms via an in-memory NL→result cache
(`apps/web/src/server/result-cache.js`). It is intentionally conservative:

- The cache key folds the question, a **schema version** (table presence), the
  row limit, and the insights flag, so adding/removing a table busts it; a 15-min
  TTL bounds staleness from finer column-level drift.
- It **only caches `demo_retail` results** (`DB_NAME === demo_retail` AND
  `DB_USER === demo_readonly`) and never caches failures. The admin schema
  refresh (`POST /api/admin/refresh-schema`) clears it.
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
from the data *shape*. An LLM `layout_hint` is **planned, not implemented**: the
schema leaves room for one that would be validated against the real columns and
could only *refine* the layout, never block first paint. Unknown
block types fall back to a typed placeholder. This is also the seam that future
csv/xlsx/pdf agents can reuse.

### Virtualized results — no silent truncation

The results table renders **all** returned rows via TanStack Table +
`react-virtual` (filter, sort, column visibility, full-set CSV export), replacing
an earlier hand-sliced 300-row table that silently dropped data. The server caps
results at `WEB_QUERY_ROW_LIMIT` rows; it asks for one row more than it shows, so
a capped result is reported as `truncated: true` with `totalRowCount: null`, and
the UI says "1,000+ rows" instead of a number that would understate it.

### Bounding the tail

A model-generated cartesian join can't pin a shared instance for long. On every
path (web, CLIs, benchmark, master-data lookups) generated SQL runs under a
MariaDB statement timeout (`SET STATEMENT max_statement_time …`,
`QUERY_STATEMENT_TIMEOUT_MS`, default 8000 ms). The web path adds
`sql_select_limit` as a server-side row cap, which applies only to the outermost
result (subqueries, window functions and `GROUP BY` still see every row), and
stops reading at the cap even when the SQL has a larger explicit `LIMIT`.

The OpenAI transport is bounded too: `OPENAI_TIMEOUT_MS` per attempt and
`OPENAI_MAX_RETRIES` transport retries. A truncated or refused response becomes
a typed failure (`LLM_TRUNCATED`, `LLM_REFUSED`) instead of being parsed, and
provider outages fail fast without an app-level retry.

The HTTP surface is loopback-bound by default. Requests whose `Host` header is
not a loopback name or listed in `WEB_ALLOWED_HOSTS` get 403 (DNS-rebinding
protection), API requests from an origin outside `WEB_ALLOWED_ORIGINS` get 403,
and responses carry `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and a
same-origin resource policy. Bearer auth (`WEB_API_TOKEN`) is opt-in and
**never shipped to the browser**; it also gates the deep health check and is
required for the admin schema refresh. Debug payloads are honored only when
`WEB_ALLOW_DEBUG` allows them (by default only on a loopback bind).

### Config is read after the env file

`main.js` loads the env file, then builds a validated, frozen config with
`loadWebConfig`, then creates the app. Nothing in the server reads `process.env`
at import time: ESM evaluates static imports before an entry point's
`await loadEnvironment()`, so settings that lived only in `.env` (including
`WEB_API_TOKEN`) used to be silently ignored. An invalid value stops startup with
one error listing every problem.

---

## Invariants (do not regress)

- **Data residency.** Client-side compute/caching is gated on
  `DB_USER === demo_readonly` AND `DB_NAME === demo_retail`, default-deny. Never
  ship non-demo data to the browser.
- **NL-only in.** The browser sends a natural-language question only — never SQL.
  Read-only validation runs unchanged on the *complete* SQL before any execution.
  There is no raw-SQL endpoint.
- **Least privilege.** Every path that runs model-authored SQL connects as the
  query user (`DB_USER`, default `demo_readonly`), which must be `SELECT`-only;
  admin credentials (`DB_ADMIN_*`) are for `bootstrap-db` and `seed-demo` only.
- **Bounded execution.** Model-authored SQL always runs through
  `executeReadOnlySql`, so the statement timeout applies on every path.
- **One pipeline, two serializers.** The streaming route must wrap the same
  pipeline as the blocking route; keep the blocking JSON route as a drift-free
  fallback.
- **Auth.** `WEB_API_TOKEN` is never shipped to the browser; new routes must be
  covered by the same auth/rate-limit middleware, and admin routes must refuse
  to run when no token is configured.
- **Config after env.** No server module reads `process.env` at import time;
  settings come from `loadWebConfig` after the env file is loaded.

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
- The SQL validator has known gaps (resource-heavy read-only SQL, no function
  allowlist, product-only and literal-only master-data ID checks, partial
  unqualified-column checks); see the guardrails section above. The database
  grants and execution bounds are what cover them.
- The unqualified-identifier check knows output aliases (`AS alias`,
  `` AS `Customer Name` ``, and an implicit `expr alias` at the end of a select
  item, before `,`, `)`, the end or any keyword that ends the SELECT list, e.g.
  `COUNT(*) ActiveCount ORDER BY ActiveCount`) for the whole statement, so an
  alias referenced in WHERE passes validation and only fails at execution.
- The benchmark has its own orchestration loop rather than calling
  `runOptimizedQuestion`, so its retry behavior can drift from the web/CLI path.

## Diagnosing a failure

When a question produces the wrong answer, separate the failure class before
fixing anything:

1. **Retrieval miss** (retrieved schema scope) — the right tables weren't
   selected, so the SQL was rejected with `TABLE_SCOPE` or written around the
   missing table; look for `prompt.widened` in the trace. Run
   `npm run debug-retrieval -- "<question>"` and inspect semantic matches,
   temporal normalization, retrieved examples, and expanded tables. Fix semantic
   metadata or scoring. In the full scope a poor ranking only weakens the hint.
2. **Validation error** — the model's SQL failed a check. The
   `sql.validation_failed` trace event carries `error.code` and `error.layer`
   (`safety` or `guardrail`); for SQL that passed, advisory metric warnings are
   in `sql.validated.validation.guardrails.warnings`. Check the model's
   assumptions too.
3. **Execution error / result mismatch** — the SQL ran but returned the wrong
   shape or values. Use `npm run benchmark -- --trace` to separate retrieval
   misses, validation errors, execution errors, low-signal successes, and result
   mismatches.
4. **Entity ambiguity** — run `npm run resolve-master-data -- "<question>"` and
   check the returned product candidates.
