# text-to-sql

Minimal text-to-SQL starter for MariaDB 10.6 using OpenAI-compatible models and prompt context compiled from Sequelize model files.

[![text-to-SQL web app demo: a natural-language question streams through planning, entity resolution, and SQL generation, then fills in metrics, insights, a chart, and a results table](media/demo.gif)](media/demo.mp4)

*The web app answering live questions: the streaming progress stepper, the generated SQL (with temporal ranges and master-data terms resolved deterministically), and the adaptive result layout with per-query token/cost accounting.*

This repo is intentionally narrow:

- It uses only these in-scope demo tables (the source of truth is `DEFAULT_INCLUDED_TABLES` in `src/constants.js`): `SalesDocument`, `SalesDocumentLine`, `Product`, `Customer`, `StoreLocation`, `DocumentType`, `AccountingPosting`, `LedgerAccount`, `CustomerProductPrice`, `Campaign`, `ProductCategory`, `Brand`, `ProductBrand`
- It compiles prompt context from the local `models/` directory, and automatically recompiles `generated/schema.json` whenever that cache drifts from the model files on disk, so a stale or copied-in schema cannot silently drop in-scope tables
- It ignores foreign keys whose target models are not present
- It generates and runs only read-only `SELECT` / `WITH` SQL: a token-based validator rejects anything else before execution, and by default the query runs as the `SELECT`-only `demo_readonly` user under a statement timeout (see [Structured Output And Guardrails](#structured-output-and-guardrails))

## Prerequisites

- **Node.js 22.18 or newer** (`engines` in `package.json`; `.nvmrc` pins 24). 22.18 is the first 22.x release that runs the web app's `.ts` tests under `node --test` without flags.
- **Docker with Compose v2** (`docker compose`) for the local database, which uses the **`mariadb:10.6`** image (pulled on the first `docker compose up`).
- An **OpenAI API key** (or an OpenAI-compatible endpoint) for anything that generates SQL: `basic`, `optimized`, `eval` / `benchmark` and web queries.

`npm test` needs neither a database nor an API key.

## How this differs from a typical text-to-SQL project

Most text-to-SQL demos stop at "dump the schema into the prompt, parse whatever SQL the model returns, and run it." This repo treats that approach as the *starting* point and adds the parts that matter when the database is real, wide, and business-critical:

| Typical demo | This repo |
|---|---|
| Whole schema pasted into every prompt, or a retrieval guess that cannot be undone | **A schema scope sized to the schema** (`SCHEMA_SCOPE`, default `auto`): when the whole in-scope schema fits a token budget (8,000 estimated tokens; the 13-table demo is about 2,300) it is sent as one stable, cacheable prompt prefix and every in-scope table is allowed, while **rule-based semantic retrieval** (lexical scoring plus the hand-curated `metadata/semantic-layer.json`) only ranks tables and columns as a one-line hint. A larger schema is narrowed by retrieval to the highest-scoring tables plus the tables on the foreign-key paths between them, and a table it missed is added on demand when the model's SQL needs it |
| Model output trusted and executed | **Deterministic guardrails** (optimized pipeline) re-validate the SQL against the schema context the model saw: qualified table/column references must exist, joins must match in-scope foreign keys or declared join hints, explicitly named metrics must use their canonical columns, `SUM`/`AVG` over a parent table's column while a 1:N child is joined is rejected as a fan-out, and product ID literals must come from the resolved candidate list |
| "Read-only" assumed | **Read-only checked, then enforced by grants**: a validator built on one MariaDB-faithful tokenizer allows a single `SELECT`/`WITH` statement with no comments and no `WITH RECURSIVE`, rejects cross-database and metadata-schema references, and denylists DML/DDL, `INTO OUTFILE`, locking reads, `@`/`@@` variables and timing/exfiltration functions. By default the query then runs as a `SELECT`-only user under a statement timeout |
| Entity names guessed by the model | **Bounded master-data resolution**: ambiguous product terms are resolved against whitelisted columns *before* generation, and only the top candidate rows are passed to the prompt — the full product master never enters the context |
| Dates left to the model | **Temporal normalization** rewrites phrases like "March 2026" into explicit half-open ranges before the model sees them, so date logic is deterministic |
| "It got the right answer once" | **Evaluation you can trust**: a value-aware comparator scores every answer on three fixture databases; `npm run eval` reports case-level accuracy with confidence intervals over repeated runs, says whether each failure was the model's, the guardrails' or the infrastructure's, and compares runs with a paired McNemar test |
| Cost ignored | **Cache-aware prompt layout** plus per-call token/cost accounting, with an offline prompt-cache-prefix estimator |

The guiding idea: the LLM proposes, but a small, testable, deterministic layer disposes. Table scope is *enforced* (optimized SQL may only use in-scope tables: all of them in the full schema scope, the retrieved ones in the retrieved scope, widened on demand when that is on), and safety is *checked* in the application and *enforced* by the database grants, not assumed.

## Repo Layout

```text
.
├── .env.example
├── .gitignore
├── README.md
├── apps/web/         # React + Express streaming web app
├── datasets/
├── docs/             # architecture, evaluation/scoring, experiments, slide deck
├── metadata/
├── models/
├── scripts/
├── src/
└── test/
```

## Quickstart

Run these steps once when setting up the repo locally.

1. Install dependencies:

```bash
npm install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Edit `.env`. The app uses two database users:

```bash
OPENAI_API_KEY=...
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=demo_retail

# Query user: everything that runs model-generated SQL (web app, basic,
# optimized, benchmark, resolve-master-data) connects as this user.
DB_USER=demo_readonly
DB_PASSWORD=<query-user password>

# Admin user: only bootstrap-db and seed-demo (DDL and inserts) use it.
DB_ADMIN_USER=root
MARIADB_ROOT_PASSWORD=<root password>   # or DB_ADMIN_PASSWORD
```

Why two users: least privilege is the real security boundary. The SQL validator is defense in depth, but a query that gets past it still runs as a user that can only `SELECT` from the demo databases, so it cannot write, read server files, or read other databases on the same MariaDB instance.

4. Start MariaDB 10.6:

```bash
docker compose up -d --wait mariadb
```

When the data volume is first created, `docker/mariadb/initdb/01-readonly-user.sh` creates the query user (`DB_READONLY_USER`, default `demo_readonly`, with password `DB_READONLY_PASSWORD`, default `DB_PASSWORD`) with `SELECT` on `` `demo\_retail%`.* `` only. Root gets the first non-blank of `DB_ADMIN_PASSWORD`, `MARIADB_ROOT_PASSWORD`, `DB_PASSWORD`, the same order the admin scripts use; when none of them is set (only `DB_READONLY_PASSWORD`), Compose falls back to the literal root password `secret`, so set one. Compose refuses to start when neither `DB_PASSWORD` nor `DB_READONLY_PASSWORD` is set. Because the grant is `` `demo\_retail%`.* ``, keep `DB_NAME` within that pattern (for example `demo_retail` or `demo_retail_v2`): with any other name the query user gets "Access denied".

Init scripts run only on a fresh volume. If your volume predates the query user (for example `demo_readonly` gets "Access denied"), reset it with `docker compose down -v` (this deletes the database) and repeat steps 4 to 6.

5. Create the starter schema from the copied Sequelize models (admin user):

```bash
npm run bootstrap-db
```

6. Load the synthetic demo data (small, fully fictional retail dataset; admin user):

```bash
npm run seed-demo
```

7. Smoke test the pipeline (query user; makes one model call):

```bash
npm run basic -- "How many active customers do we have?"
```

The `basic` and `optimized` CLIs print a warning on stderr when the query user has more than `SELECT`/`USAGE`. Without any admin setting, `bootstrap-db` and `seed-demo` fall back to `DB_USER` with a warning, which fails for a `SELECT`-only user.

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

- Load `.env` from the current working directory (the web server defaults to the repository-root `.env`)

Optional overrides:

```bash
npm run optimized -- --use-home-env
npm run optimized -- --env-dir=/path/to/folder
npm run optimized -- --dotenv=/path/to/.env      # or: --dotenv /path/to/.env
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
- `--env-dir` and `--dotenv` switch the source to that explicit location; the path must exist, and the flag needs a value
- Variables already set in the shell are not overridden by the file
- `--env-file` is rejected with a pointer to `--dotenv`. Node.js reserves that flag and acts on it even after the script path (with a missing file, `node` exits with `not found` before the script runs), so the scripts do not use it

Required environment variables:

- `OPENAI_API_KEY` (for anything that calls the model)
- `DB_NAME`
- `DB_PASSWORD` (the query user's password; `DB_USER` defaults to `demo_readonly`)
- `DB_ADMIN_PASSWORD` or `MARIADB_ROOT_PASSWORD` (only for `bootstrap-db` and `seed-demo`; `DB_ADMIN_USER` defaults to `root`)

Common variables:

- `DB_HOST`, `DB_PORT`, `DB_SOCKET`
- `DB_USER` (query user, default `demo_readonly`)
- `DB_READONLY_USER` / `DB_READONLY_PASSWORD` (Docker Compose only: the query user the init script creates; they default to `demo_readonly` / `DB_PASSWORD`)
- `MODEL_NAME`, `OPENAI_BASE_URL`
- `OPENAI_TIMEOUT_MS` (per HTTP attempt, default `60000`) and `OPENAI_MAX_RETRIES` (SDK transport retries, default `1`)
- `QUERY_STATEMENT_TIMEOUT_MS` (MariaDB statement timeout for generated SQL and master-data lookups on every path, default `8000`; `0` disables)
- `WEB_QUERY_MAX_RETRIES` (extra model attempts after a failed generation, validation or execution, `0` to `5`, default `1`). Despite the `WEB_` prefix, the `optimized` CLI reads it too, and an invalid value stops it
- `SCHEMA_SCOPE` (`auto`, `full` or `retrieved`, default `auto`), `SCHEMA_FULL_MAX_TOKENS` (default `8000`) and `SCHEMA_WIDEN_ON_DEMAND` (default on when `auto` falls back to `retrieved`, off for an explicit `SCHEMA_SCOPE=retrieved`): how much schema the optimized prompt shows and which tables the validator allows. `full` sends every in-scope table as one stable prompt prefix and allows them all, with retrieval as a ranking hint; `retrieved` sends and allows the retrieved tables (the behaviour before this setting existed, prompt for prompt and retry for retry) and, with `SCHEMA_WIDEN_ON_DEMAND=1`, retries a `TABLE_SCOPE` rejection of an in-scope table with that table added; `auto` is `full` while the full schema block fits `SCHEMA_FULL_MAX_TOKENS` estimated tokens (characters / 4), else `retrieved`. The web server, the `optimized` CLI, `npm run eval`, `verify-dataset` and `measure-prompt-cache` all read them, and an invalid value stops them. `SCHEMA_SCOPE=retrieved` on its own reproduces the product loop of the previous (retrieved-scope) baseline, `eval/baselines/gpt-4o-mini.json` at commit `1aa30a3` (prompt version `0c314451d4b7`); the current committed baseline ran `auto` (full on this schema). See [docs/experiments/01-schema-scope.md](docs/experiments/01-schema-scope.md)
- `HINTS_VERSION` (`1` or `2`, default `2`): the generation of the optimized prompt's knowledge layer. `2` ("hints v2") leaves a month unresolved when it is part of a longer date phrase it does not resolve (day ranges, parts of a month, periods ending in it, open ranges, to-date tails; a pattern list, not a full date grammar), uses unambiguous business rules (posting date, brand path, ranking limits, count / single-total / time-grain answer shapes, money words, units, cancellations, campaigns, ledger accounts), reads the semantic-layer overlay `metadata/semantic-layer.hints-v2.json` on top of `metadata/semantic-layer.json` (turnover / spend, average order value, open amount, units, ...), states metric default filters in the hints, ignores generic words in retrieval and does not read an account name such as "account 4000 (Sales Revenue)" as a sales metric. `1` reproduces the prompts, semantic plans and validator decisions of the committed baseline byte for byte. Read by the same entry points as `SCHEMA_SCOPE`; an invalid value stops them. See [docs/experiments/02-hints-v2.md](docs/experiments/02-hints-v2.md)

See [.env.example](.env.example) for a starting point.

## Local MariaDB Quick Start

If you see `connect ECONNREFUSED 127.0.0.1:3306`, nothing is listening on that host and port yet.

Fastest local path:

```bash
cp .env.example .env          # set DB_PASSWORD and MARIADB_ROOT_PASSWORD
docker compose up -d --wait mariadb
npm run bootstrap-db
```

That gives you:

- MariaDB 10.6 on `127.0.0.1:${DB_PORT}` (Compose binds loopback only)
- Database `${DB_NAME}`
- The query user `demo_readonly` with `SELECT` on `` `demo\_retail%`.* `` only (created on first volume init)
- The in-scope tables created from the copied Sequelize models (every table in `DEFAULT_INCLUDED_TABLES`)

Notes:

- `docker compose up` fails with "required variable DB_PASSWORD is missing a value" when neither `DB_PASSWORD` nor `DB_READONLY_PASSWORD` is set: the init script could not create the query user.
- Changing the passwords in `.env` later does not change them in an existing volume; `docker compose down -v` resets it (and deletes the data).
- `npm run bootstrap-db` creates an empty schema only. Run `npm run seed-demo` to load the bundled synthetic demo data, or supply your own seed data, for useful query results.
- If the database already exists and you want to rebuild the tables, run `npm run bootstrap-db -- --drop-existing`.
- If you only want to inspect the generated DDL, run `npm run bootstrap-db -- --print-sql`.
- The bootstrap generator automatically downgrades some oversized `VARCHAR` columns to `TEXT` when needed so wide demo tables fit MariaDB row-size limits.

## Demo data and safety

This repository ships with **synthetic data only**. The bundled seed (`scripts/seed-public-db.js`) is a small, fully fictional retail dataset — customers such as "North District Market", products such as "Sparkling Water 12 Pack", and generic ledger accounts. No real customer, product, or financial data is included anywhere in the code, datasets, metadata, or model comments.

The application-layer checks (read-only validation, single statement, table allow-list, cross-database rejection) are defense in depth, **not** a substitute for database-level isolation; the database grants are the real boundary. Docker Compose sets this up for the demo. If you point the pipeline at another MariaDB instance:

- Run it against its **own database** (default `demo_retail`), never alongside production data you don't want reachable.
- Connect the query paths as a **dedicated least-privilege user** with `SELECT`-only grants scoped to that one database, not as `root`. For example:

  ```sql
  CREATE USER 'demo_readonly'@'%' IDENTIFIED BY '<strong-password>';
  GRANT SELECT ON demo_retail.* TO 'demo_readonly'@'%';
  ```

  Then set `DB_USER` / `DB_PASSWORD` to that user, and `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` to a separate user for `bootstrap-db` and `seed-demo`. With only these grants, a query that gets past the validator still cannot write, read server files (no `FILE` privilege) or read other databases on the instance.
- The app checks this for you: the web server at startup, the `basic`/`optimized` CLIs (on stderr) and the token-authorized deep health check (which also needs `OPENAI_API_KEY`) warn when the query user has more than `SELECT`/`USAGE`, or has grants that reach system schemas or databases other than `DB_NAME`. The check only warns; it never blocks.
- Keep the API server bound to `127.0.0.1` (the default). Before exposing it on a shared network, set `WEB_API_TOKEN`, `WEB_ALLOWED_HOSTS` and `WEB_ALLOWED_ORIGINS` (see [Web App](#web-app)).

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

`npm run benchmark` and `npm run evaluate` are the evaluation runner (`npm run eval`, see [Evaluation](#evaluation)) with the benchmark profile: one dataset (default `core-public`), no Docker start, no fixture seeding, no verification, and exit code 1 when any case fails in a single run (an abstain / clarify case fails when it is not declined: the model answers it, or its call fails without SQL). The benchmark calls the model for every case (up to 2 attempts per case, and again for every repetition with `--repeat`), so it costs money; `verify-dataset` below does not.

### Datasets and the scoring oracle

`datasets/` holds six public datasets, which `npm run eval` de-duplicates into
one suite of 404 unique cases over 217 intents (see [Evaluation](#evaluation)):

- `core-public` (9 cases) and `paraphrase-public` (9 rephrasings of them): the
  original smoke cases, the wording the prompt rules and the semantic layer
  were tuned on (all `dev`);
- `edge-cases-public` (17 cases): the 9 core cases plus 8 targeted edge cases
  (metric/column confusion, header↔detail grain, wrong date column, stale
  snapshot fields, two join-path traps, a fuzzy product term, aggregation
  shape), built by `npm run build-edge-dataset`;
- `templated-public` (189 cases over 94 intents): metrics, dimensions, time
  windows, filters and result shapes composed into 2-3 phrasings per intent,
  generated deterministically with their oracle controls by
  `npm run build-eval-dataset`;
- `hard-cases-public` (40 hand-written cases): new vocabulary, Swedish, typos,
  relative dates with an explicit as-of date, named entities, zero-row
  answers, and 10 unanswerable or ambiguous questions whose right behaviour is
  to abstain or ask (no gold SQL; reported apart from accuracy);
- `holdout-public` (149 cases over 77 intents): a fresh holdout (v2), authored
  blind on 2026-10-06 and frozen, every case `holdout`: new shapes (shares,
  ratios, receivables ageing, trial balance, running totals, window
  functions), named entities, explicit tie-breaks, relative dates with an
  as-of date, Swedish, typos and two-reading questions, built by
  `npm run build-holdout-dataset` (see
  [docs/evaluation-dataset.md](docs/evaluation-dataset.md#fresh-holdout-v2)).

Every answer case is execution-verified on the three fixture databases (seed,
v2, v3) with its row counts pinned, and resolves oracle controls in
`datasets/controls/`: plausible wrong SQL the oracle must reject and correct
alternatives it must accept. Every case in the five datasets before
`holdout-public` is `dev`: the holdout the error analysis of Experiment 1
inspected was retired to dev (tagged `formerly_holdout`). The holdout is
`holdout-public` alone, authored blind and frozen by
`datasets/holdout-manifest.json`. With one or two cases per failure class in
the edge suite, per-class results there are examples, not rates.

It relies on a value-aware comparator (`compareResults` in `src/benchmark.js`):
results are matched on **values**, not column names, so a different aggregate
alias or extra projected columns do not by themselves make a result mismatch
(the previous exact-row oracle scored ~80% of correct answers as failures for
cosmetic reasons). A case's `signal_checks` still name expected output columns,
so a correct answer under a different alias can be scored `low_signal_success`
instead of `pass`. Cases opt in via a `comparison` block
(`scalar` / `rowset` / `ranked`); datasets without one keep the legacy exact-row
behavior. See `docs/evaluation-dataset.md` for the full taxonomy, the comparison
spec, the multi-fixture oracle and its controls, and documented coverage
limits.

Validate every gold query on the three fixture databases and measure the
oracle with its controls, without spending any LLM calls (run this after
schema/data changes to separate dataset rot from model regressions):

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

Every repetition of every case is kept. The headline is the **strict
accuracy**: the mean over cases of each case's pass rate across repetitions,
with a 95% confidence interval from a case bootstrap. The case is the unit
because repetitions of one case are strongly correlated (failures at
temperature 0 are systematic), so pooling them as independent trials overstates
confidence; the old pooled `reliability` block (with its pooled Wilson bound) is
still written for older consumers, labelled as such. A repeated run is a
measurement and does not fail the process on run-to-run variance.

Even the whole suite (404 cases over 217 intents) is small next to real
usage, and one dataset alone is a smoke test; read a single dataset's numbers
as smoke signals, and use the whole suite with repetitions (`npm run eval --
--repeat 3`) for any reliability claim.

## Evaluation

One command runs the whole evaluation:

```bash
npm run eval
```

It makes sure MariaDB is up (starting the docker-compose database when it is
local and down), seeds the three fixture databases with the admin role when
they are missing or drifted, verifies every gold query and the oracle controls
(no LLM call happens if that fails), runs every unique case of every dataset in
`datasets/` through the product loop with 4 cases in flight and a per-case
deadline, and writes `generated/runs/<timestamp>/all/<model>/`.

The suite is 404 unique cases over 217 intents: the original core, paraphrase
and edge cases, a templated set (`datasets/templated-public.json`, 94 intents
with 2-3 phrasings each, built by `npm run build-eval-dataset`), 40
hand-written hard cases (new vocabulary, Swedish, typos, relative dates with an
as-of date, named entities, zero-row answers, and 10 unanswerable or ambiguous
questions where the right behaviour is to abstain or ask, reported apart from
accuracy) and a fresh holdout (`datasets/holdout-public.json`, 149 cases over
77 intents, authored blind on 2026-10-06). Every case is `dev` or `holdout`:
the 255 cases over 140 intents of the first five datasets are dev, and the
149 fresh cases are the holdout. The 45 intents (81 cases) that used to be
holdout were read during the error analysis of Experiment 1, so they are dev
now, tagged `formerly_holdout`. The fresh holdout is new intents whose
questions avoid every multi-word phrase of the semantic layer and its tuned
word "revenue" (single words such as customer, store or units still match
it), so it measures new intents in partly new wording. It is frozen by
`datasets/holdout-manifest.json`: a test fails when a holdout case is added,
removed or changed without a reviewed manifest update
(`npm run holdout-manifest -- --write --note "..."`). Error analysis and
experiment design use dev failures only; report.md and the console show the
holdout in aggregate (accuracy by split), never per case, unless
`--reveal-holdout`. `--split dev|holdout` runs one split.

The golds encode written-down conventions (net amounts, header vs line
grain, campaign attribution through the product, the cancel filter, units on
product lines, top-N and ranking rules), and two documented scoring
relaxations are opt-in per case: a customer pivot may also list customers
with 0 everywhere, and a scalar total may be empty where the gold is NULL /
0 (see [docs/evaluation-dataset.md](docs/evaluation-dataset.md#gold-conventions)).
A case can be flagged as a known product gap (the validator rejects every
correct answer today; five cases, where a guardrail misreads a ledger account
name or the word "credit": one dev, four holdout); it still counts in
accuracy, and a repetition that ends with the validator rejecting it with the
flagged code is a system error (any other failure of it, such as a wrong
result or a rejection for another reason, is judged as usual). The report
contains:

- `report.md`: strict accuracy with a 95% confidence interval, accuracy by
  split, who caused each failure (model, guardrail false rejection, retrieval
  miss, known validator rejection, infrastructure), the guardrail confusion
  matrix, the abstain / clarify cases handled, a per-case table (dev cases;
  holdout ones only with `--reveal-holdout`), cost / latency / retries /
  tokens, and the provenance (git sha, prompt, semantic-layer, fixture and
  dataset hashes);
- `report.json` (everything, every repetition) and `trace.jsonl`.

**Current baseline** (`eval/baselines/gpt-4o-mini.json`: gpt-4o-mini, the
whole 404-case suite, 3 repetitions, full-schema prompting via the default
`SCHEMA_SCOPE=auto`, measured on 2026-10-06):

| Measure | Result |
|---|---|
| Strict accuracy (392 answer cases, 205 intents) | **62.2%** (95% CI 57.5%–66.8%) |
| By split | dev **74.7%** (245 cases) · fresh holdout **41.3%** (147 cases) |
| Failures by cause (repetitions) | model 445 · system 0 (no known validator rejections, retrieval misses or guardrail false rejections) · infrastructure 0 |
| Guardrails over every attempt | precision 100%, recall 18.0%, false-rejection rate 0% |
| Abstain / clarify cases handled | 0 of 12 (the product always answers; not in accuracy) |
| Cost and latency | $0.54 total · $0.00074 per correct answer · p50 2.5 s, p95 5.2 s · 91.5% of prompt tokens cached |

The fresh holdout is 77 new intents written blind (no model answers to them
were seen while writing) and audited by two independent annotators before
this run; reports show it in aggregate only. The 33-point gap between dev and
holdout is the honest measure of how the product copes with new kinds of
questions: the holdout leans on analytical shapes the dev set barely covers
(shares and ratios, overdue and ageing balances, running totals,
month-over-month change, weekday and value-band breakdowns) and on unfamiliar
wording, so dev accuracy overstates what a new user's questions would get.
With perfect SQL the suite's ceiling is 98.7% (5 cases are known validator
rejections: the validator rejects their correct answers); every failure of
this baseline is a model error, including those on the flagged cases, none of
which ended in the flagged rejection. (The failure causes come from
`npm run eval -- --offline`, which recomputes them; the attribution recorded
inside `eval/baselines/gpt-4o-mini.json` predates the fix that limits the
system bucket to the flagged rejection and still says model 430 · system 15.) On the earlier 255-case
suite, [Experiment 1](docs/experiments/01-schema-scope.md) (full-schema
prompting) moved strict accuracy from 68.8% to 72.8%. These are measurements
of the product, not targets.

With a baseline (`--compare <report.json>`, or `eval/baselines/<model>.json`
when committed) it adds a paired comparison with an exact McNemar test;
`--gate` makes a significantly worse run exit 1 (and, with `--min-accuracy X`,
a run below X; with only abstain / clarify cases selected there is no accuracy,
so `--min-accuracy` is refused with exit 2). Harness, database and
provider problems (and case deadlines) exit 2, never 1, and Ctrl-C still writes
a partial report. `--rescore <report.json>` and `--offline` re-validate,
re-execute and re-score recorded SQL with zero LLM calls. Useful flags: `--repeat 3`, `--budget-usd 1`, `--dataset`, `--tag`,
`--case-id`, `--split`, `--reveal-holdout`. One repetition of the whole 404-case suite costs
about 18 cents on gpt-4o-mini (the committed baseline: $0.54 for 3 repetitions). The dataset composition, the generator, how to add a
case, setup, flags, how to read the report, and the CI jobs are in
[docs/evaluation-dataset.md](docs/evaluation-dataset.md#running-evaluations).

## Web App

A modular React fullstack app lives in `apps/web/`. The query console **streams over Server-Sent Events** (`POST /api/query/stream`): a live progress stepper, the generated SQL shown the instant the model returns it, then per-section results filling in via `columns → rows → viz → insights → layout` frames (a `residency` frame precedes `rows` and the `layout` frame is emitted only when present). Failed questions report the stage they stopped in (`llm`, `validation`, `execution`, `aborted` or `infra`) and an error code: the JSON result has top-level `errorStage`/`errorCode` (plus `error.code`/`error.stage`/`error.layer`), and the SSE `error` frame carries the same values as `code`, `stage` and `layer`. It also includes an exact-match result cache (repeated questions replay in ~0ms; demo database read as `demo_readonly` only), a virtualized results table, a deterministic Zod-validated adaptive layout rendered through a trusted block registry, deterministic insight cards, local dashboard pins, an optional debug trace view, and a gated client-side cross-filter for synthetic demo data. The blocking `POST /api/query` (JSON) is the same pipeline kept as a drift-free fallback for CLIs/curl/tests. See `apps/web/README.md` for details and configuration.

Run it from the repository root:

```bash
npm run web:dev
```

Other workspace checks (run from the repo root):

```bash
npm run web:build      # production build to apps/web/dist
npm run web:typecheck  # TypeScript type-check
npm run web:test       # web unit tests
npm run web:start      # run the built API server (apps/web/src/server/main.js)
```

Default local URLs (`WEB_FRONTEND_PORT` and `WEB_API_PORT` change them; `web:dev` uses both):

- Frontend: `http://localhost:5173`
- API: `http://127.0.0.1:8787`

The API server (`apps/web/src/server/main.js`) loads the env file first, then validates its settings: an invalid `WEB_*` value stops startup with one error listing every problem, so values set only in `.env` (such as `WEB_API_TOKEN`) take effect. It loads the repository root `.env` by default unless `--dotenv`, `ENV_FILE`, `ENV_DIR`, or `USE_HOME_ENV=1` is set; pass the flag through npm as `npm run web:start -- --dotenv <path>` (same for `web:dev`), and relative paths resolve against the directory you ran npm from. It binds to `127.0.0.1` by default; on a loopback bind, requests whose `Host` header is not a loopback name or listed in `WEB_ALLOWED_HOSTS` get 403, and API requests from an `Origin` outside `WEB_ALLOWED_ORIGINS` get 403. Set `WEB_API_HOST=0.0.0.0` only for trusted networks, together with `WEB_API_TOKEN`. SIGTERM/SIGINT drain in-flight requests for up to `WEB_SHUTDOWN_TIMEOUT_MS`. See `apps/web/README.md` for every setting, the admin schema-refresh endpoint and the health checks.

## LLM Cost Tracking

Every LLM call automatically estimates token costs based on the model used. Costs are printed per-call and as a run total.

Runtime default: `gpt-4o-mini` when `MODEL_NAME` is unset. The `gpt-5.4-*` rows are included for OpenAI-compatible gateway deployments configured with `OPENAI_BASE_URL`.

Supported cost estimates: `gpt-4o-mini`, `gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4` (including date-suffixed snapshots like `gpt-5.4-mini-2026-03-05`).

To change the prices of a listed model without editing code, set `MODEL_PRICING_OVERRIDES` to a JSON map keyed by its base name, e.g. `MODEL_PRICING_OVERRIDES='{"gpt-5.4-mini":{"inputPerMillion":0.7,"outputPerMillion":4.2}}'`; the given fields replace that model's defaults. Models that are not listed above cannot be added this way, and malformed JSON is ignored.

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

This runs the unit tests in `test/` and `apps/web/test/`, including retrieval, semantic-layer, master-data resolver, prompt-cache, cost, tracing, SQL validator and web server tests. The few MariaDB integration tests in `test/mariadb.integration.test.js` are skipped unless `TEST_MARIADB_PORT` (and `TEST_MARIADB_PASSWORD`) point at a running database.

## Semantic Retrieval And Master Data

The optimized pipeline uses `metadata/semantic-layer.json` at runtime to map business phrasing to in-scope tables, joins, metrics, filters, and clarification hints. This is deliberately **rule-based / hand-curated semantic retrieval**, not an embedding model and not a vector database. The runtime combines lexical token scoring with curated semantic boosts, so prompts such as `biggest buyers`, `SKUs moved`, and synthetic product requests rank the right demo tables first. In the full schema scope that ranking is a hint next to the whole in-scope schema; in the retrieved scope (large schemas) it decides which tables the prompt shows.

This has a useful failure mode for a reference project: when a business term is missing, the fix is visible in metadata and tests. The tradeoff is that new vocabulary must be added deliberately. Embedding or hybrid retrieval is not implemented.

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
| `llm.failed` / `sql.validation_failed` / `sql.execution_failed` | Error events with details (`error.code`; validation failures also carry `error.layer`) |

Notes:

- `--trace` writes JSONL events to stdout
- When `--trace` is enabled, the human-readable CLI output is sent to stderr so stdout stays machine-readable
- `--trace-file <path>` writes the same JSONL events to a file
- You can combine both flags to trace to stdout and a file at the same time
- All events share a `runId` for correlating events from the same run
- Each event includes `timestamp` and duration timings (`startedAt`, `endedAt`, `durationMs`)
- Optimized prompt traces include `context.promptCache`, which estimates the stable schema-prefix size available for provider prompt caching, and `schemaScope` (requested and effective scope, the full-schema token estimate, widened tables); a widen-on-demand retry emits `prompt.widened` with the rejected and added tables; `npm run eval` also stamps every trace line with `schemaScopeRequested`, `schemaScopeEffective`, `schemaFullEstimatedTokens` and `schemaWidenOnDemand`
- LLM cost output includes cached input token counts and percentages when the provider returns `prompt_tokens_details.cached_tokens`

## Prompt Cache Measurement

The optimized prompt is arranged so stable instructions and the schema context appear before volatile question-specific context. In the full schema scope (the default for this schema) that schema block is the same for every question, so every question shares one provider prompt-cache prefix; in the retrieved scope questions with the same retrieved tables share one. The product master never enters the prompt either way.

Measure the cache-aware prompt layout without making model calls:

```bash
npm run measure-prompt-cache -- --suite --schema-scope all
npm run measure-prompt-cache -- --dataset paraphrase-public --results-file generated/prompt-cache-paraphrase-public.json
```

The report includes average characters and estimated tokens, cacheable-prefix and question-part tokens, the old monolithic-layout prefix estimate, and cacheable-prefix reuse groups, per schema scope. Over the 255-question suite the full scope averages 4,127 estimated tokens per prompt with 1 distinct prefix (451 tokens per question outside it), the retrieved scope 3,800 with 48 prefixes (1,312 outside them). It is an offline estimate; actual cached token counts and cost savings come from provider usage metadata during real model runs.

## Structured Output And Guardrails

The optimized pipeline requests a provider-enforced JSON schema with `sql`, `explanation`, `tables_used`, and `assumptions`. Before anything runs, the SQL goes through two local validation layers. Both read the SQL through one MariaDB-faithful tokenizer (`src/sql-tokenizer.js`), so comments, quoted identifiers and string contents are seen the way MariaDB sees them (for example, `--` starts a comment only when followed by whitespace, a control character or the end of input). These are local JavaScript checks and add no LLM calls.

**Layer 1, safety** (`validateSqlSafety` in `src/pipeline.js`; every path, including `basic`):

- A single `SELECT` or `WITH` statement (one trailing `;` is allowed; the query may open with parentheses).
- No SQL comments at all: `--`, `#` and `/* */` are rejected as `SQL_COMMENT`, and `/*! */` / `/*M! */` as `EXECUTABLE_COMMENT`. The prompts tell the model not to write them.
- Non-recursive CTEs, including column lists and CTE chains, are accepted: CTE names are query-local, and the tables inside CTE bodies are checked like any other. `WITH RECURSIVE` is rejected (`RECURSIVE_CTE`).
- Every table must be in the allowed set (`TABLE_SCOPE`): every in-scope table in the full schema scope, the retrieved tables (widened on demand when that is on) in the retrieved scope. Any database-qualified table or `db.function()` is rejected (`CROSS_DATABASE`), as are metadata schemas such as `information_schema`, `mysql` and `sys`, bare or backtick-quoted (`METADATA_SCHEMA`).
- Denylisted: DML/DDL keywords, any `INTO` (including `INTO OUTFILE`/`DUMPFILE`), `SET` (except `CHARACTER SET`), `PROCEDURE`, locking reads, index hints, `FOR SYSTEM_TIME`, table functions such as `JSON_TABLE`, `@`/`@@` variables, and timing, locking, file, sequence and session-information functions (`SLEEP`, `BENCHMARK`, `GET_LOCK`, `LOAD_FILE`, `NEXTVAL`, `CURRENT_USER`, ...), also when backtick-quoted.

**Layer 2, guardrails** (`validateSqlGuardrails` in `src/sql-guardrails.js`; optimized pipeline only, against the prompt context the model saw):

- Qualified table and column references (`c.CustomerName`) must exist in the prompt's schema context. Unqualified names are only partly checked: an unknown mixed-case identifier such as `FooBar` is rejected, but an unknown lower-case one such as `foobar` is not (MariaDB then fails it at execution).
- Cross-table equality joins must match in-scope foreign keys or semantic join hints.
- Explicitly named metrics ("net sales", "revenue", "units sold", ...) must use their preferred columns, for example net sales uses `SalesDocument.NetAmount` and product (line-grain) net sales uses `SalesDocumentLine.NetAmount`. Metrics matched only through generic words ("sales", "sold") or in count/list questions are advisory: a missing preferred column is recorded in `guardrails.warnings[]` (`METRIC_COLUMN_NOT_USED`) instead of rejecting the SQL.
- Fan-out: in each `SELECT` scope, `SUM`/`AVG` over a parent table's column while a 1:N child table is joined is rejected (`FAN_OUT`), because the join repeats the parent row. `COUNT`/`MIN`/`MAX`, children used only in `EXISTS`/`IN` or pre-aggregated in a subquery, and anti-joins (`child.col IS NULL`) are allowed.
- When product master-data candidates were resolved, product ID literals compared with `ProductId` (or a product foreign key) must come from that candidate list. Other entities' IDs are not checked.
- `tables_used` must stay inside the allowed table set and include every SQL table reference.

Every rejection is a `SqlValidationError` with a stable `error.code` (such as `SQL_COMMENT`, `TABLE_SCOPE`, `UNKNOWN_COLUMN`, `JOIN_PATH`, `METRIC_COLUMN`, `FAN_OUT`) and `error.layer` (`safety` or `guardrail`). Trace events carry both, and validation details are included on `sql.validated.validation.guardrails` trace events.

**Execution bounds** (`executeReadOnlySql`):

- Every path (web, CLIs, benchmark, `verify-dataset`, master-data lookups) runs the statement under `SET STATEMENT max_statement_time=...` from `QUERY_STATEMENT_TIMEOUT_MS` (default 8000 ms; `0` disables; the web server can override it with `WEB_QUERY_STATEMENT_TIMEOUT_MS`).
- The web server also caps rows server-side with `sql_select_limit` (which applies only to the outermost result, so subqueries, window functions and `GROUP BY` are unaffected) and stops reading at the cap even when the SQL has a larger explicit `LIMIT`. A capped result reports `truncated: true` and `totalRowCount: null`, and the UI shows "N+ rows".
- When a web request is cancelled (Stop button, client disconnect or the request deadline), the OpenAI call is aborted and a running query is stopped with `KILL QUERY` over a separate connection.
- The OpenAI client uses `OPENAI_TIMEOUT_MS` (default 60000) per attempt and `OPENAI_MAX_RETRIES` (default 1) transport retries. A response cut off at the token limit fails as `LLM_TRUNCATED`, and a content-filter block or refusal as `LLM_REFUSED`, instead of being parsed. Provider failures are classified as `LLM_TIMEOUT`, `LLM_CONNECTION_ERROR`, `LLM_MODEL_NOT_FOUND` (an unknown model or deployment, sent as 404 or 400) or `HTTP_<status>`; outages (timeouts, connection errors, HTTP 401/403/404/429 and 5xx, unknown models) fail fast without an app-level retry.

**Known gaps.** The validator is defense in depth, and these are not covered by it:

- Resource-heavy but otherwise read-only SQL is accepted, for example a `REPEAT()` memory bomb or a cartesian self-join. Only the statement timeout and (on the web path) the row cap bound it.
- There is no function allowlist yet; the function check is a denylist.
- The master-data ID check covers product IDs only and looks at literal comparisons, so a subquery or a join on the product name is not checked against the candidate list.
- Unqualified column checks are partial (see above).

The `SELECT`-only query user is what stops anything the validator misses from writing data or reading outside the demo databases.

## What The Scripts Do

- [scripts/build-schema.js](scripts/build-schema.js): parses the local Sequelize model files into a normalized schema JSON
- [scripts/bootstrap-db.js](scripts/bootstrap-db.js): creates the local MariaDB schema from the copied model metadata
- [scripts/basic.js](scripts/basic.js): sends compact schema context and the question to the model
- [scripts/optimized.js](scripts/optimized.js): adds semantic table retrieval, bounded master-data candidate resolution, business rules, few-shot examples, provider-enforced JSON output, retries, and SQL guardrails
- [scripts/debug-retrieval.js](scripts/debug-retrieval.js): explains selected tables, semantic matches, temporal references, and retrieved examples for one question or benchmark case
- [scripts/evaluate-retrieval.js](scripts/evaluate-retrieval.js): measures table recall and prompt width for retrieval without making model calls
- [scripts/resolve-master-data.js](scripts/resolve-master-data.js): runs the product master-data resolver against the configured database for one question
- [scripts/measure-prompt-cache.js](scripts/measure-prompt-cache.js): estimates optimized prompt cache-prefix size across benchmark datasets without model calls
- [scripts/eval.js](scripts/eval.js): the one-command evaluation (`npm run eval`): database preflight, fixture seeding, gold and controls verification, the run, failure attribution, statistics, baseline comparison, and `report.json` + `report.md` + `trace.jsonl` under `generated/runs/`; `--rescore` / `--offline` re-judge recorded runs with no LLM calls
- [scripts/evaluate.js](scripts/evaluate.js): scores one case through the product loop and the multi-fixture oracle (`evaluateQuestion`); its CLI (`npm run benchmark` / `npm run evaluate`) is `scripts/eval.js` with the benchmark profile
- [scripts/verify-dataset.js](scripts/verify-dataset.js): validates every dataset's gold `expected_sql` on the three fixture databases (no LLM), checks the pinned row counts and gold-vs-gold self-consistency under each case's `comparison` spec, and measures the oracle with the controls in `datasets/controls/` (kill-rate gate)
- [scripts/build-edge-dataset.mjs](scripts/build-edge-dataset.mjs): regenerates the public edge-case benchmark dataset (`datasets/edge-cases-public.json`) from the core public cases plus the inline edge cases (`npm run build-edge-dataset`)
- [scripts/build-eval-dataset.mjs](scripts/build-eval-dataset.mjs): generates the templated dataset (`datasets/templated-public.json`) and its oracle controls deterministically (`npm run build-eval-dataset`; `-- --check` fails when the committed files are out of date)
- [scripts/seed-public-db.js](scripts/seed-public-db.js): seeds the `demo_retail` database with the bundled synthetic retail data (`npm run seed-demo`)

## Notes

- SQL targets MariaDB 10.6, not SQLite.
- Prompt context comes from the `comment`, column names, and in-scope foreign keys in the copied models.
- Semantic retrieval hints come from `metadata/semantic-layer.json`; this maps business phrasing such as buyers, SKUs, document classes, and product search terms to preferred tables, columns, filters, and joins.
- Master-data resolution is currently scoped to product candidates from `Product`; additional entity types need explicit resolver and guardrail support.
- Missing foreign keys are ignored on purpose rather than guessed.
- The local bootstrap uses the copied models to create a practical starter schema, not a byte-for-byte production clone.
- Generated files are written to `generated/` and are excluded from git.
- Evaluation datasets live under `datasets/`: `core-public` and `paraphrase-public` (the original smoke and paraphrase cases), `edge-cases-public` (the core cases plus targeted edge cases), `templated-public` (generated by `npm run build-eval-dataset`), `hard-cases-public` (hand-written, including abstain / clarify cases) and `holdout-public` (the fresh holdout v2, built by `npm run build-holdout-dataset`), de-duplicated by `npm run eval` into one suite with `dev` / `holdout` splits (the first five are all dev; `holdout-public` is the holdout, frozen by `datasets/holdout-manifest.json`); their oracle controls are under `datasets/controls/`. Composition, splits, scoring and the value-aware comparator are documented in `docs/evaluation-dataset.md`.
- The *why* behind the pipeline and the web app — design decisions, trade-offs, and the invariants — is in `docs/architecture.md`.
- Measured product changes (one variable, paired against the committed baseline) are written up in `docs/experiments/` (protocol in `docs/experiments/README.md`).

## License

MIT — see [LICENSE](LICENSE). This is a portfolio/reference project and the bundled data is fully synthetic. Contributions and security reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
