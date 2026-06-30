# text-to-sql

Minimal text-to-SQL starter for MariaDB 10.6 using OpenAI-compatible models and prompt context compiled from Sequelize model files.

![text-to-SQL web app demo: a natural-language question streams through planning, entity resolution, and SQL generation, then fills in metrics, insights, a chart, and a results table](media/demo.gif)

*The web app answering live questions: the streaming progress stepper, the generated SQL (with temporal ranges and master-data terms resolved deterministically), and the adaptive result layout with per-query token/cost accounting.*

This repo is intentionally narrow:

- It uses only these in-scope demo tables (the source of truth is `DEFAULT_INCLUDED_TABLES` in `src/constants.js`): `SalesDocument`, `SalesDocumentLine`, `Product`, `Customer`, `StoreLocation`, `DocumentType`, `AccountingPosting`, `LedgerAccount`, `CustomerProductPrice`, `Campaign`, `ProductCategory`, `Brand`, `ProductBrand`
- It compiles prompt context from the local `models/` directory, and automatically recompiles `generated/schema.json` whenever that cache drifts from the model files on disk, so a stale or copied-in schema cannot silently drop in-scope tables
- It ignores foreign keys whose target models are not present
- It generates and runs only read-only `SELECT` / `WITH` SQL, enforced by a keyword/function denylist (no DML/DDL, file I/O, locking, server variables, metadata schemas, or timing/exfiltration functions) plus single-statement and table-scope checks

## How this differs from a typical text-to-SQL project

Most text-to-SQL demos stop at "dump the schema into the prompt, parse whatever SQL the model returns, and run it." This repo treats that approach as the *starting* point and adds the parts that matter when the database is real, wide, and business-critical:

| Typical demo | This repo |
|---|---|
| Whole schema pasted into every prompt | **Rule-based semantic retrieval** selects only the in-scope tables a question needs using lexical scoring plus the hand-curated `metadata/semantic-layer.json`, so the prompt stays narrow even when the source ERP has hundreds of tables |
| Model output trusted and executed | **Deterministic guardrails** re-validate the SQL against the exact schema context the model saw — every table/column must exist, joins must match in-scope foreign keys or declared join hints, metrics must use their canonical columns, and filter IDs must come from a resolved candidate list |
| "Read-only" assumed | **Read-only enforced**: first keyword must be `SELECT`/`WITH`, single statement only, plus a keyword/function denylist blocking DML/DDL, `INTO OUTFILE`, locking reads, `@`/`@@` variables, `information_schema`/`mysql`/`sys`, and timing/exfiltration functions |
| Entity names guessed by the model | **Bounded master-data resolution**: ambiguous product terms are resolved against whitelisted columns *before* generation, and only the top candidate rows are passed to the prompt — the full product master never enters the context |
| Dates left to the model | **Temporal normalization** rewrites phrases like "March 2026" into explicit half-open ranges before the model sees them, so date logic is deterministic |
| "It got the right answer once" | **Reliability measurement**: a value-aware comparator scores answers on values not column names, and `--repeat N` reports min/mean/max accuracy with a Wilson 95% lower bound instead of one lucky run |
| Cost ignored | **Cache-aware prompt layout** plus per-call token/cost accounting, with an offline prompt-cache-prefix estimator |

The guiding idea: the LLM proposes, but a small, testable, deterministic layer disposes. Retrieval is *enforced*, not advisory; safety is *checked*, not assumed.

## Repo Layout

```text
.
├── .env.example
├── .gitignore
├── README.md
├── apps/web/         # React + Express streaming web app
├── datasets/
├── docs/             # architecture, evaluation/scoring, slide deck
├── metadata/
├── models/
├── scripts/
├── src/
└── test/
```

## Install

```bash
npm install
```

## One-Time Setup

Run these steps once when setting up the repo locally.

1. Install dependencies:

```bash
npm install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Edit `.env` and set at least these values:

```bash
OPENAI_API_KEY=...
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=demo_retail
```

Optional for local Docker Compose only:

```bash
# Defaults to DB_PASSWORD when omitted
MARIADB_ROOT_PASSWORD=secret
```

4. Start MariaDB 10.6:

```bash
docker compose up -d mariadb
```

5. Create the starter schema from the copied Sequelize models:

```bash
npm run bootstrap-db
```

6. Load the synthetic demo data (small, fully fictional retail dataset):

```bash
npm run seed-demo
```

7. Smoke test the pipeline:

```bash
npm run basic -- "How many active customers do we have?"
```

If you need to rebuild the local schema from scratch:

```bash
npm run bootstrap-db -- --drop-existing
```

If you only want to inspect the generated DDL:

```bash
npm run bootstrap-db -- --print-sql
```

## Environment

Default behavior:

- Load `.env` from the current working directory

Optional overrides:

```bash
npm run optimized -- --use-home-env
npm run optimized -- --env-dir=/path/to/folder
npm run optimized -- --env-file=/path/to/.env
```

Equivalent environment variables:

```bash
USE_HOME_ENV=1 npm run optimized
ENV_DIR=/path/to/folder npm run optimized
ENV_FILE=/path/to/.env npm run optimized
```

Loading behavior:

- Exactly one env source is used for each run
- Default is the current folder `.env`
- `--use-home-env` switches the source to `~/.env`
- `--env-dir` and `--env-file` switch the source to that explicit location

Required environment variables:

- `OPENAI_API_KEY`
- `DB_USER`
- `DB_NAME`

Common MariaDB variables:

- `DB_HOST`
- `DB_PORT`
- `DB_PASSWORD`
- `DB_SOCKET`
- `MARIADB_ROOT_PASSWORD` (optional for local Docker Compose; defaults to `DB_PASSWORD`)
- `MODEL_NAME`
- `OPENAI_BASE_URL`

See [.env.example](.env.example) for a starting point.

## Local MariaDB Quick Start

If you see `connect ECONNREFUSED 127.0.0.1:3306`, nothing is listening on that host and port yet.

Fastest local path:

```bash
cp .env.example .env
docker compose up -d mariadb
npm run bootstrap-db
```

That gives you:

- MariaDB 10.6 on `127.0.0.1:${DB_PORT}`
- Database `${DB_NAME}`
- The in-scope tables created from the copied Sequelize models (every table in `DEFAULT_INCLUDED_TABLES`)

Notes:

- `npm run bootstrap-db` creates an empty schema only. Run `npm run seed-demo` to load the bundled synthetic demo data, or supply your own seed data, for useful query results.
- If the database already exists and you want to rebuild the tables, run `npm run bootstrap-db -- --drop-existing`.
- If you only want to inspect the generated DDL, run `npm run bootstrap-db -- --print-sql`.
- The bootstrap generator automatically downgrades some oversized `VARCHAR` columns to `TEXT` when needed so wide demo tables fit MariaDB row-size limits.

## Demo data and safety

This repository ships with **synthetic data only**. The bundled seed (`scripts/seed-public-db.js`) is a small, fully fictional retail dataset — customers such as "North District Market", products such as "Sparkling Water 12 Pack", and generic ledger accounts. No real customer, product, or financial data is included anywhere in the code, datasets, metadata, or model comments.

If you point this pipeline at a real database, the application-layer guardrails (read-only, single-statement, table allow-list, cross-database qualifier rejection) are your first line of defense, but they are **not** a substitute for database-level isolation. Recommended hardening:

- Run the demo against its **own database** (default `demo_retail`), never alongside production data you don't want reachable.
- Connect as a **dedicated least-privilege user** with `SELECT`-only grants scoped to that one database — not as `root`. For example:

  ```sql
  CREATE USER 'demo_readonly'@'%' IDENTIFIED BY '<strong-password>';
  GRANT SELECT ON demo_retail.* TO 'demo_readonly'@'%';
  ```

  Then set `DB_USER=demo_readonly` in `.env`. This guarantees that even a misconfigured `DB_NAME` or a script that bypasses the pipeline cannot read other databases on the same MariaDB instance.
- Keep the API server bound to `127.0.0.1` (the default) and set `WEB_API_TOKEN` / `WEB_ALLOWED_ORIGINS` before exposing it on any shared network.

## Usage

Build the normalized schema from the local model files:

```bash
npm run build-schema
```

Create the local MariaDB schema from the copied models:

```bash
npm run bootstrap-db
```

Run the basic pipeline:

```bash
npm run basic
npm run basic -- "How many active customers do we have?"
```

Run the optimized pipeline:

```bash
npm run optimized
npm run optimized -- "Show outstanding balance by customer"
```

Inspect retrieval without making an LLM call:

```bash
npm run debug-retrieval -- "Show sparkling water product sales by branch month-wise"
npm run evaluate-retrieval -- --dataset paraphrase-public
```

Inspect product master-data resolution against the configured database:

```bash
npm run resolve-master-data -- "sparkling water sales"
```

Run the benchmark runner:

```bash
npm run benchmark
npm run benchmark -- --dataset paraphrase-public
npm run benchmark -- --dataset core-public --case-id core_public_001
npm run benchmark -- --dataset core-public --tag temporal
npm run benchmark -- --dataset edge-cases-public          # public edge-case suite
npm run benchmark -- --dataset edge-cases-public --tag join_path
```

`npm run evaluate` is kept as an alias for the same benchmark runner.

### Edge-case suite and the scoring oracle

`datasets/edge-cases-public.json` is a public edge-case suite built to expose weaknesses in
the core algorithms — metric/column confusion, header↔detail grain, join-path
traps (empty bridge tables, null foreign keys, obsolete denormalized fields),
temporal parsing, aggregation shape, fuzzy entity matching, and empty-result
robustness. Each case is tagged with a `failure_class` and is execution-verified
against the public demo database.

It relies on a value-aware comparator (`compareResults` in `src/benchmark.js`):
results are matched on **values**, not column names, so a correct answer with a
different aggregate alias or extra projected columns is no longer scored as a
mismatch (the previous exact-row oracle scored ~80% of correct answers as
failures for cosmetic reasons). Cases opt in via a `comparison` block
(`scalar` / `rowset` / `ranked`); datasets without one keep the legacy exact-row
behavior. See `docs/evaluation-dataset.md` for the full taxonomy, the comparison
spec, the current baseline, and documented coverage limits.

Validate every gold query against the public demo database without spending any LLM
calls (run this after schema/data changes to separate dataset rot from model
regressions):

```bash
npm run verify-dataset                          # all datasets in datasets/
npm run verify-dataset -- --dataset edge-cases-public
```

### Measuring reliability, not a single lucky run

Generation is non-deterministic, so the pass/fail of any one benchmark run is a
sample, not a guarantee. A single `accuracy: 1.0` on a small dataset is not
evidence the system is reliable — repeated runs of the same code can land
anywhere from 0 to 1.0. Use `--repeat N` to run every case `N` times and report
the variance instead of one run:

```bash
npm run benchmark -- --dataset core-public --repeat 10
```

In reliability mode the report adds a `reliability` block with the per-run
accuracies (min/mean/max), the overall pass-rate, the fraction of runs in which
every case passed, per-case pass rates, and a Wilson 95% lower bound on the true
pass-rate. The Wilson lower bound is the honest headline number: for example
6/6 on a single run has a lower bound near 0.6, not 1.0. Reliability mode is a
measurement and never fails the process on expected run-to-run variance.

The committed datasets are intentionally small and cover a limited set of
intents; treat their numbers as smoke signals and grow `datasets/` (with
execution-verified `expected_sql`) before making any reliability claim.

## Web App

A modular React fullstack app lives in `apps/web/`. The query console **streams over Server-Sent Events** (`POST /api/query/stream`): a live progress stepper, the generated SQL shown the instant the model returns it, then per-section results filling in via `columns → rows → viz → insights → layout` frames (a `residency` frame precedes `rows` and the `layout` frame is emitted only when present). It also includes an exact-match result cache (repeated questions replay in ~0ms), a virtualized results table, a deterministic Zod-validated adaptive layout rendered through a trusted block registry, deterministic insight cards, local dashboard pins, an optional debug trace view, and a gated client-side cross-filter for synthetic demo data. The blocking `POST /api/query` (JSON) is the same pipeline kept as a drift-free fallback for CLIs/curl/tests. See `apps/web/README.md` for details and configuration.

Run it from the repository root:

```bash
npm run web:dev
```

Other workspace checks (run from the repo root):

```bash
npm run web:build      # production build to apps/web/dist
npm run web:typecheck  # TypeScript type-check
npm run web:test       # web unit tests
npm run web:start      # run the built API server
```

Default local URLs:

- Frontend: `http://localhost:5173`
- API: `http://127.0.0.1:8787`

The API server loads the repository root `.env` by default unless `ENV_FILE`, `ENV_DIR`, or `USE_HOME_ENV=1` is set. It binds to `127.0.0.1` by default; set `WEB_API_HOST=0.0.0.0` only for trusted networks, and use `WEB_ALLOWED_ORIGINS` to list allowed browser origins.

## LLM Cost Tracking

Every LLM call automatically estimates token costs based on the model used. Costs are printed per-call and as a run total.

Runtime default: `gpt-4o-mini` when `MODEL_NAME` is unset. The `gpt-5.4-*` rows are included for OpenAI-compatible gateway deployments configured with `OPENAI_BASE_URL`.

Supported cost estimates: `gpt-4o-mini`, `gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4` (including date-suffixed snapshots like `gpt-5.4-mini-2026-03-05`).

Example CLI output:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q: How many active customers do we have?
LLM: $0.001650 (1000 input + 200 output tokens, gpt-5.4-mini)
SQL: SELECT COUNT(*) AS active_count FROM Customer WHERE ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total LLM: $0.003300 (2000 input + 400 output tokens, gpt-5.4-mini)
```

The optimized pipeline also shows per-attempt costs when retries occur:

```text
LLM attempt 1: $0.001650 (1000 input + 200 output tokens, gpt-5.4-mini)
LLM attempt 2: $0.001800 (1100 input + 210 output tokens, gpt-5.4-mini)
Total LLM: $0.003450 (2100 input + 410 output tokens, gpt-5.4-mini)
```

For unknown models, the output shows `cost unavailable` with the token counts still visible.

Quick test (no DB or API key needed):

```bash
npm test
```

This runs the full unit test suite, including retrieval, semantic-layer, master-data resolver, prompt-cache, cost, tracing, and guardrail tests.

## Semantic Retrieval And Master Data

The optimized pipeline uses `metadata/semantic-layer.json` at runtime to map business phrasing to in-scope tables, joins, metrics, filters, and clarification hints. This is deliberately **rule-based / hand-curated semantic retrieval**, not an embedding model and not a vector database. The runtime combines lexical token scoring with curated semantic boosts, so prompts such as `biggest buyers`, `SKUs moved`, and synthetic product requests retrieve the right demo context without exposing every table.

This has a useful failure mode for a reference project: when a business term is missing, the fix is visible in metadata and tests. The tradeoff is that new vocabulary must be added deliberately; hybrid lexical + embedding retrieval is listed as future work rather than silently implied.

For product-name ambiguity, the pipeline resolves bounded master-data candidates before generation:

- Product terms are extracted from semantic filter hints.
- Editable value aliases expand terms such as `sparkling water`, `protein bar`, and `cold brew`.
- The resolver searches whitelisted `Product` columns with parameterized SQL.
- The prompt receives only top candidates, not the full product master.

Default product lookup limits are 200 DB rows per term query and 20 ranked candidates per term. Prompt rendering shows only the top 8 candidates per term.

## Tracing

Use structured JSONL tracing to inspect prompt construction, model calls, validation, retries, SQL execution, and timings.

Examples:

```bash
# Trace to stdout (human output moves to stderr)
npm run basic -- --trace "How many active customers do we have?"

# Trace to a file
npm run optimized -- --trace-file generated/optimized-trace.jsonl "Show outstanding balance by customer"

# Benchmark runs already write a trace file under generated/runs/...
npm run benchmark -- --trace --dataset paraphrase-public
```

Example trace event (one JSONL line, formatted here for readability):

```json
{
  "timestamp": "2026-03-20T12:00:00.000Z",
  "pipeline": "optimized",
  "runId": "a1b2c3d4-...",
  "event": "llm.completed",
  "script": "scripts/optimized.js",
  "questionIndex": 1,
  "question": "Show outstanding balance by customer",
  "attempt": 1,
  "startedAt": "2026-03-20T12:00:00.100Z",
  "endedAt": "2026-03-20T12:00:01.500Z",
  "durationMs": 1400,
  "response": {
    "model": "gpt-5.4-mini-2026-03-05",
    "usage": {
      "prompt_tokens": 1000,
      "completion_tokens": 200,
      "prompt_tokens_details": { "cached_tokens": 400 }
    },
    "cost": {
      "totalCost": 0.00138,
      "inputCost": 0.00048,
      "outputCost": 0.0009,
      "cachedPromptTokens": 400
    }
  }
}
```

Key trace events:

| Event | Description |
|---|---|
| `run.started` | Pipeline begins (model, env, config) |
| `schema.loaded` | Schema compiled and filtered |
| `prompt.built` | Prompt constructed with full context |
| `llm.completed` | LLM response with usage, cost, and timings |
| `sql.validated` | SQL passed read-only safety checks |
| `sql.executed` | SQL executed against the database |
| `question.completed` | Per-question summary with aggregate cost |
| `run.completed` | Final summary with total cost across all questions |
| `llm.failed` / `sql.validation_failed` / `sql.execution_failed` | Error events with details |

Notes:

- `--trace` writes JSONL events to stdout
- When `--trace` is enabled, the human-readable CLI output is sent to stderr so stdout stays machine-readable
- `--trace-file <path>` writes the same JSONL events to a file
- You can combine both flags to trace to stdout and a file at the same time
- All events share a `runId` for correlating events from the same run
- Each event includes `timestamp` and duration timings (`startedAt`, `endedAt`, `durationMs`)
- Optimized prompt traces include `context.promptCache`, which estimates the stable schema-prefix size available for provider prompt caching
- LLM cost output includes cached input token counts and percentages when the provider returns `prompt_tokens_details.cached_tokens`

## Prompt Cache Measurement

The optimized prompt is arranged so stable instructions and the selected schema context appear before volatile question-specific context. This lets repeated questions with the same retrieved tables reuse a much longer provider prompt-cache prefix without sending the full product master.

Measure the cache-aware prompt layout without making model calls:

```bash
npm run measure-prompt-cache -- --dataset paraphrase-public --results-file generated/prompt-cache-paraphrase-public.json
```

The report includes estimated total tokens, cacheable-prefix tokens, the old monolithic-layout prefix estimate, and cacheable-prefix reuse groups across benchmark cases. It is an offline estimate; actual cached token counts and cost savings come from provider usage metadata during real model runs.

## Structured Output And Guardrails

The optimized pipeline requests a provider-enforced JSON schema with `sql`, `explanation`, `tables_used`, and `assumptions`. After the model responds, local validation checks the SQL against the same prompt context the model saw:

- Qualified table and column references must exist in the retrieved schema context.
- Cross-table equality joins must match in-scope foreign keys or semantic join hints.
- Semantic metrics must use their preferred columns, for example net sales uses `SalesDocument.NetAmount` or product (line-grain) net sales uses `SalesDocumentLine.NetAmount`.
- Resolved product master-data filters such as `ProductId` and product foreign keys like `ProductId` must come from the candidate list supplied to the prompt.
- `tables_used` must stay inside the allowed table set and include every SQL table reference.

These checks are local JavaScript validation, so they do not add any extra LLM calls. Validation details are included on `sql.validated.validation.guardrails` trace events. Query-local CTE names from `WITH ... AS (...)` are recognized as temporary identifiers during validation.

## What The Scripts Do

- [scripts/build-schema.js](scripts/build-schema.js): parses the local Sequelize model files into a normalized schema JSON
- [scripts/bootstrap-db.js](scripts/bootstrap-db.js): creates the local MariaDB schema from the copied model metadata
- [scripts/basic.js](scripts/basic.js): sends compact schema context and the question to the model
- [scripts/optimized.js](scripts/optimized.js): adds semantic table retrieval, bounded master-data candidate resolution, business rules, few-shot examples, provider-enforced JSON output, retries, and SQL guardrails
- [scripts/debug-retrieval.js](scripts/debug-retrieval.js): explains selected tables, semantic matches, temporal references, and retrieved examples for one question or benchmark case
- [scripts/evaluate-retrieval.js](scripts/evaluate-retrieval.js): measures table recall and prompt width for retrieval without making model calls
- [scripts/resolve-master-data.js](scripts/resolve-master-data.js): runs the product master-data resolver against the configured database for one question
- [scripts/measure-prompt-cache.js](scripts/measure-prompt-cache.js): estimates optimized prompt cache-prefix size across benchmark datasets without model calls
- [scripts/evaluate.js](scripts/evaluate.js): runs named benchmark datasets, applies signal checks, and writes `report.json` plus `trace.jsonl` under `generated/runs/`
- [scripts/verify-dataset.js](scripts/verify-dataset.js): validates every dataset's gold `expected_sql` against the public demo database (no LLM) and checks gold-vs-gold self-consistency under each case's `comparison` spec
- [scripts/build-edge-dataset.mjs](scripts/build-edge-dataset.mjs): regenerates the public edge-case benchmark dataset (`datasets/edge-cases-public.json`) from the core public cases plus the inline edge cases (`npm run build-edge-dataset`)
- [scripts/seed-public-db.js](scripts/seed-public-db.js): seeds the `demo_retail` database with the bundled synthetic retail data (`npm run seed-demo`)

## Notes

- SQL targets MariaDB 10.6, not SQLite.
- Prompt context comes from the `comment`, column names, and in-scope foreign keys in the copied models.
- Semantic retrieval hints come from `metadata/semantic-layer.json`; this maps business phrasing such as buyers, SKUs, document classes, and product search terms to preferred tables, columns, filters, and joins.
- Master-data resolution is currently scoped to product candidates from `Product`; additional entity types need explicit resolver and guardrail support.
- Missing foreign keys are ignored on purpose rather than guessed.
- The local bootstrap uses the copied models to create a practical starter schema, not a byte-for-byte production clone.
- Generated files are written to `generated/` and are excluded from git.
- Benchmark datasets live under `datasets/`: `core-public` and `paraphrase-public` (smoke/paraphrase) plus `edge-cases-public` (public edge-case suite). Scoring and the value-aware comparator are documented in `docs/evaluation-dataset.md`.
- The *why* behind the pipeline and the web app — design decisions, trade-offs, and the invariants — is in `docs/architecture.md`.

## License

MIT — see [LICENSE](LICENSE). This is a portfolio/reference project and the bundled data is fully synthetic. Contributions and security reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
