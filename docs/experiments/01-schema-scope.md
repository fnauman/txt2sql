# Experiment 01: schema scope

**Variable:** `SCHEMA_SCOPE`, from `retrieved` (the committed baseline) to
`full` (what the new default `auto` resolves to on the 13-table demo schema).
**Status:** offline measurements done; live run pending.
Audit findings: EVAL-RET-2 / D1 (a retrieval miss is an unrecoverable
failure), EVAL-RET-9 / D8 (pruning saves no tokens at 13 tables and prints the
schema twice).

## Hypothesis

On a small schema, using the retrieved table set as the validator allow-list
turns every retrieval miss into an unrecoverable failure: the SQL that needs
the missing table is rejected (`TABLE_SCOPE`), and the retry is only told to
avoid it. Sending the full in-scope schema as one stable prompt prefix and
validating against the full in-scope table set removes that failure class at
about the same token cost, while retrieval keeps ranking tables as a hint. For
large schemas the right fallback is the retrieved scope with widen-on-demand.

## Design

The setting (`src/schema-scope.js`, read the same way by the web server, the
`optimized` CLI, `npm run eval`, `verify-dataset` and `measure-prompt-cache`):

| | `retrieved` (baseline) | `full` (candidate) |
|---|---|---|
| Schema in the prompt | the retrieved tables + FK paths (4.4 tables on average), printed twice: a stable block and a question-ranked block | every in-scope table (13), once, in one stable block |
| Allow-list (`TABLE_SCOPE`) | the retrieved tables | every in-scope table |
| Retrieval output | decides the schema shown | a one-line hint: "Most relevant tables/columns for this question: ..." (or "No table matched ..." instead of four alphabetical tables) |
| Cacheable prefix | one per retrieved table set | one for every question |
| System prompt | unchanged (prompt version `0c314451d4b7`) | caching note changed (prompt version `b264e57d8e15`) |

`auto` (the new default) picks `full` while the full schema block fits
`SCHEMA_FULL_MAX_TOKENS` (default 8,000 estimated tokens, characters / 4); the
demo schema's block is 2,258. Tables outside the in-scope schema (other
databases, metadata schemas, tables not in `DEFAULT_INCLUDED_TABLES`) are
rejected in every scope.

`retrieved` keeps widen-on-demand as an option for large schemas
(`SCHEMA_WIDEN_ON_DEMAND`, default on): a `TABLE_SCOPE` rejection of an
in-scope table rebuilds the prompt with that table and its FK path for the
retry, within the same retry budget, and tells the model the table was added
(trace event `prompt.widened`). `SCHEMA_SCOPE=retrieved
SCHEMA_WIDEN_ON_DEMAND=0` is the baseline's product loop: the same prompt, byte
for byte, for all 255 suite questions, and the same prompt version.

**The comparison:** a paid `--repeat 3` run with the default setting, paired
against the committed baseline (gpt-4o-mini, 3 repetitions, retrieved scope,
no widening). Everything else is fixed: model, datasets and gold, fixtures,
semantic layer, retry budget (1), statement timeout.

**Confound, stated up front:** the full arm changes two things that cannot be
separated on this schema: the allow-list (every in-scope table) and the prompt
(all 13 tables, no ranked duplicate block, the relevance hint, one system
sentence). The retrieved + widen-on-demand arm isolates part of the first: it
keeps the retrieved prompt and only widens the allow-list on a retry. It is an
optional second paid arm (below).

## Offline measurements

All with zero LLM calls, on freshly seeded fixtures (seed `094282546fe5`, v2
`7adec1b3bc33`, v3 `51d1c42c3b88`), over the default suite (255 unique cases,
245 answer cases, 130 intents).

### Prompt size

`npm run measure-prompt-cache -- --suite --schema-scope all` (estimated tokens
are characters / 4; master-data candidates are not resolved offline):

| Per question | `retrieved` | `full` (= `auto`) |
|---|---|---|
| Tables in the prompt | 4.4 | 13 |
| Prompt | 15,194 chars · 3,800 est. tokens (median 3,792, p95 4,798) | 16,506 chars · 4,127 est. tokens (median 4,130, p95 4,366) |
| Cacheable prefix (system + schema) | 2,488 est. tokens | 3,676 est. tokens |
| Question part (outside the prefix) | 5,247 chars · 1,312 est. tokens | 1,804 chars · 451 est. tokens |
| Distinct cacheable prefixes over the suite | 48 (16 used by one question only) | 1 |
| Whole suite | 968,904 est. tokens | 1,052,452 est. tokens (+8.6%) |

The question part shrinks by two thirds because the question-ranked schema
block (a second copy of the retrieved tables) is gone. At gpt-4o-mini prices
($0.15 per million input tokens, $0.075 cached) the full prompt costs $0.000619
per question with no caching (+8.6%) and $0.000343 when its prefix is cached
(-10.4% against the retrieved prompt's best case of $0.000383, which needs
every one of its 48 prefixes to be warm). The baseline's real prompts averaged
3,407 tokens per call (2,906,179 over 853 calls, 72% of them cached across 3
repetitions), so the character estimate runs about 11% high; the cached share
of a live full-scope run is one of the numbers to read.

### Ceiling: accuracy with perfect SQL

`npm run eval` against a local stand-in for the OpenAI API that answers every
case with its gold SQL (and its gold tables in `tables_used`), 1 repetition,
no verification:

| Scope | Strict accuracy | dev / holdout | System failures | Retry rate |
|---|---|---|---|---|
| `retrieved`, no widening (the baseline's loop) | 86.5% (212/245) | 89.3% / 80.5% | 33 (retrieval misses 32, guardrail false rejection 1) | 16.9% |
| `retrieved` + widen-on-demand | 99.6% (244/245) | 100% / 98.7% | 1 (guardrail false rejection) | 16.9% |
| `full` (= `auto`) | 99.6% (244/245) | 100% / 98.7% | 1 (guardrail false rejection) | 4.3% |

The one case left is `tpl_revenue_credits_monthly_q1_2026_e1b20a` (the
account name "Sales Revenue" trips the net-sales metric guardrail,
`METRIC_COLUMN`), the only `known_validator_rejection` still flagged. The
retries in the full scope are that case and the 10 behaviour cases (the
stand-in returns no SQL for them); widen-on-demand recovers all 32 retrieval
misses, but only on the retry.

### Rescore of the committed baseline under each scope

`SCHEMA_SCOPE=<scope> npm run eval -- --rescore eval/baselines/gpt-4o-mini.json`
re-validates, re-executes and re-scores the recorded SQL (`npm run eval --
--offline --gate` is the `auto` row and exits 0):

| Scope | Strict accuracy | Majority passes | System failures (repetitions) | Paired vs baseline |
|---|---|---|---|---|
| `retrieved`, no widening | 68.8% (dev 72.6%, holdout 60.6%) | 169/245 | 92 (all retrieval misses) | identical: 0 flips |
| `retrieved` + widen-on-demand | 68.8% | 169/245 | 61 (retrieval misses 58, guardrail false rejections 3) | 0 flips |
| `full` (= `auto`) | 69.8% (dev 73.6%, holdout 61.5%; 95% CI 64.1%–75.5%) | 172/245 | 3 (guardrail false rejections 3, retrieval misses 0) | 3 improvements, 0 regressions; Δ +0.9 pts (95% CI +0.0 to +2.2); McNemar p = 0.250 |

The baseline's 92 system repetitions (31 cases, every one of them among the 33
formerly flagged) are mostly not rejections: 73 are wrong results the model
wrote around the missing table, 14 guardrail and 5 safety rejections. Only 44
attempts (40 repetitions of 14 cases) were rejected with `TABLE_SCOPE`. Under
the full scope those 44 recorded attempts become:

| Today's verdict on the 44 recorded `TABLE_SCOPE` attempts | Attempts |
|---|---|
| Accepted, executed and correct | 8 (3 cases: `hard_sv_products_most_units_mar_2026` 3/3, `hard_zero_harbor_kiosk_products_mar_2026` 3/3, `hard_vocab_receivables_by_outlet_mar_2026` 2/3) |
| Accepted and wrong | 0 |
| Rejected by `RESPONSE_TABLES`, but correct (guardrail false rejection) | 6 |
| Rejected by `RESPONSE_TABLES`, wrong | 20 (+2 later attempts not reached, also rejected) |
| Rejected by `UNKNOWN_COLUMN` / `UNKNOWN_TABLE_ALIAS`, wrong | 6 / 2 |

So 14 of the 44 are correct SQL: 8 pass today and 6 are thrown away by the
response-table contract (`tables_used` must list every table the SQL uses).
The recorded responses left the table out of `tables_used`: the model had been
told it was outside the allowed set. That is an artefact of replaying
retrieved-scope answers, not something a full-scope prompt asks for, so the
rescore understates the full scope here. The other way round, it cannot show
regressions: on cases where retrieval was right the recorded SQL is the same
and only re-validated, so whether 13 tables in the prompt distract the model
(for example toward the `CustomerProductPrice` price list) only the live run
can tell.

On the 33 formerly flagged cases the baseline passed 7 of 99 repetitions (2
majority passes); the full-scope rescore passes 14 (5 majority passes); the
ceiling is 33/33. The guardrail confusion matrix moves from precision 100%,
recall 26.4% to precision 94.0%, recall 31.8% (the 6 `RESPONSE_TABLES` false
rejections above; the 44 safety-layer rejections become guardrail decisions).

### Verification and dataset flags

The 33 `known_validator_rejection: TABLE_SCOPE` flags are stale under the
default scope (the validator accepts those golds now) and were removed (20
templated phrasings, 13 hard cases); the `METRIC_COLUMN` flag stays.
`npm run verify-dataset` passes every gate under the default scope and under
`SCHEMA_SCOPE=retrieved` (where those golds, their alternatives and positive
controls are notes: "rejected under the retrieved schema scope because
retrieval did not pick <table>"). `test/gold-sql-validator.test.js` pins that
exactly those 33 golds are rejected under the retrieved scope and admitted by
the default one.

### Reproduce

```bash
# prompt size
npm run measure-prompt-cache -- --suite --schema-scope all
# rescore per scope (fixtures seeded; no LLM calls)
SCHEMA_SCOPE=retrieved SCHEMA_WIDEN_ON_DEMAND=0 npm run eval -- --rescore eval/baselines/gpt-4o-mini.json
SCHEMA_SCOPE=retrieved npm run eval -- --rescore eval/baselines/gpt-4o-mini.json
npm run eval -- --offline --gate
# ceiling: point OPENAI_BASE_URL at a local server that answers each case's gold SQL, then
OPENAI_API_KEY=sk-local OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 npm run eval -- --skip-verify --no-baseline
```

## Live results

*To be filled in after the paid run.*

Run: `OPENAI_API_KEY=... npm run eval -- --repeat 3 --budget-usd 1` with the
default setting (`SCHEMA_SCOPE` unset = `auto`, which resolves to `full`),
paired automatically against `eval/baselines/gpt-4o-mini.json`.

| | Baseline (retrieved) | Candidate (full) |
|---|---|---|
| Git sha / prompt version | `f5e6ffef21c9` / `0c314451d4b7` | |
| Strict accuracy (95% CI) | 68.8% (63.1%–74.6%) | |
| dev / holdout | 72.6% / 60.6% | |
| Majority-pass cases | 169/245 | |
| Intent-clustered accuracy | 66.1% | |
| System failures (repetitions) | 92 (retrieval misses 92) | |
| Guardrail precision / recall | 100% / 26.4% | |
| Paired: improvements / regressions, McNemar p | | |
| Δ strict accuracy (95% CI) | | |
| Cost per correct answer | $0.00073 | |
| Prompt tokens per call / cached share | 3,407 / 72% | |
| Latency p50 / p95, retry rate | 2.41 s / 5.39 s, 11.5% | |

Optional second arm (`SCHEMA_SCOPE=retrieved`, widen-on-demand on): separates
the allow-list from the prompt layout.

## Decision

*Pending the live run.*
