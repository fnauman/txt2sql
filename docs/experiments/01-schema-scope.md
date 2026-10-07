# Experiment 01: schema scope

**Variable:** `SCHEMA_SCOPE`, from `retrieved` (the baseline before this experiment) to
`full` (what the new default `auto` resolves to on the 13-table demo schema).
**Status:** complete — adopted (`auto` is the default; live run 2026-10-06,
see [Decision](#decision)).
Audit findings: EVAL-RET-2 / D1 (a retrieval miss is an unrecoverable
failure), EVAL-RET-9 / D8 (at 13 tables pruning buys little: measured below,
about 8% of uncached prompt tokens, and it prints the schema twice).

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

`retrieved` has widen-on-demand for large schemas (`SCHEMA_WIDEN_ON_DEMAND`):
a `TABLE_SCOPE` rejection of an in-scope table rebuilds the prompt with that
table and its FK paths for the retry, within the same retry budget, and tells
the model the table was added (trace event `prompt.widened`). Each added
table gets the shortest path to every retrieved table it reaches (any
length); the widened set is the union over the added tables, so it does not
depend on the order they were added in (the live loop and the offline
verifier and rescore, which sort them, allow the same tables) and a second
widening never drops a connector the first allowed. Paths are never cut to
fit the budget, since a cut path is a join the retry cannot write; a widened
schema block over `SCHEMA_FULL_MAX_TOKENS` is reported in the prompt
context (`schemaScope.widenOverBudget`, `widenedSchemaEstimatedTokens`) and
the trace (`prompt.widen_over_budget`). It is on by
default when `auto` falls back to `retrieved` (a schema over the budget) and
off by default for an explicit `SCHEMA_SCOPE=retrieved`, which is therefore
the previous baseline's product loop with one variable: the same prompt, byte for byte,
for all 255 suite questions, the same prompt version and the same retries.
`SCHEMA_SCOPE=retrieved SCHEMA_WIDEN_ON_DEMAND=1` selects retrieved +
widening explicitly.

**The comparison:** a paid `--repeat 3` run with the default setting, paired
against the baseline committed before this experiment (gpt-4o-mini, 3
repetitions, retrieved scope, no widening; `eval/baselines/gpt-4o-mini.json`
at commit `1aa30a3`). Everything else is fixed: model, datasets and gold, fixtures,
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

| Scope | Strict accuracy | dev / holdout | System failures | Retry rate, answer cases (all cases¹) |
|---|---|---|---|---|
| `retrieved`, no widening (the baseline's loop) | 86.5% (212/245) | 89.3% / 80.5% | 33 (retrieval misses 32, guardrail false rejection 1) | 13.5% (16.9%) |
| `retrieved` + widen-on-demand | 99.6% (244/245) | 100% / 98.7% | 1 (guardrail false rejection) | 13.5% (16.9%) |
| `full` (= `auto`) | 99.6% (244/245) | 100% / 98.7% | 1 (guardrail false rejection) | 0.4% (4.3%) |

¹ The all-cases rate includes the 10 behaviour cases, which the stand-in
answers with empty SQL, so each of them retries once; that is the stand-in,
not the product. The retry rates describe a model that writes gold SQL, not
gpt-4o-mini. A reviewer's stand-in that reports the SQL's own tables in
`tables_used` (instead of the gold's) got the same accuracies and answer-case
retry rates of 13.3% / 13.3% / 0.8%.

The one case left is `tpl_revenue_credits_monthly_q1_2026_e1b20a` (the
account name "Sales Revenue" trips the net-sales metric guardrail,
`METRIC_COLUMN`), the only `known_validator_rejection` still flagged; it is the
one answer-case retry in the full scope. Widen-on-demand recovers all 32
retrieval misses, but only on the retry.

### Rescore of the committed baseline under each scope

The baseline here is the retrieved-scope recording that was committed before
this experiment (`eval/baselines/gpt-4o-mini.json` at commit `1aa30a3`, git
sha `f5e6ffef21c9`, prompt version `0c314451d4b7`); the live run below has
since replaced that file. `SCHEMA_SCOPE=<scope> npm run eval -- --rescore
<that recording>` re-validates, re-executes and re-scores the recorded SQL
(see Reproduce for extracting it); `full` and `auto` give the same row:

| Scope | Strict accuracy | Majority passes | System failures (repetitions) | Paired vs baseline |
|---|---|---|---|---|
| `retrieved`, no widening | 68.8% (dev 72.6%, holdout 60.6%) | 169/245 | 92 (all retrieval misses) | identical: 0 flips |
| `retrieved` + widen-on-demand | 68.8% | 169/245 | 61 (retrieval misses 58, guardrail false rejections 3²) | 0 flips |
| `full` (= `auto`) | 69.8% (dev 73.6%, holdout 61.5%; 95% CI 64.1%–75.5%) | 172/245 | 3 (guardrail false rejections 3², retrieval misses 0) | 3 improvements³, 0 regressions; Δ +0.9 pts (95% CI +0.0 to +2.2); McNemar p = 0.250 |

² Oracle artefacts, mostly (see below): all 3 under retrieved + widening and 2
of the 3 under full are repetitions of the two `hard_zero_harbor_kiosk_*`
cases, where the oracle cannot tell right SQL from wrong. The one genuine
false rejection is `tpl_category_net_sales_apr_2026_ce5e82` repetition 2.

³ Two are real (`hard_sv_products_most_units_mar_2026`,
`hard_vocab_receivables_by_outlet_mar_2026`). The third,
`hard_zero_harbor_kiosk_products_mar_2026`, is an oracle false positive.

**Zero-answer cases the oracle cannot judge.** Two of the formerly flagged
cases have a gold answer that is empty or zero on every fixture:

- `hard_zero_harbor_kiosk_products_mar_2026` ("Which products did Harbor Kiosk
  buy in March 2026?"): the gold returns no rows on seed, v2 and v3.
- `hard_zero_harbor_kiosk_credit_notes_2026`: the gold counts 0 on all three.

Any SQL that also returns nothing matches. The recorded SQL for the first
reads the customer price list (`CustomerProductPrice` by `EffectiveDate`)
instead of sales, and Harbor Kiosk has no price rows on any fixture, so it
"passes". The recorded SQL for the second filters
`sd.CustomerId IN (SELECT CustomerId FROM StoreLocation ...)`: `StoreLocation`
has no `CustomerId`, so the name resolves to the outer table, and the count is
0 everywhere. Both are wrong SQL that the oracle scores as right. Until a
fixture gives these cases a non-empty answer (outside this experiment), read
their passes, in the rescore and in the live run, as unknown.
The baseline's 92 system repetitions (31 cases, every one of them among the 33
formerly flagged) are mostly not rejections: 73 are wrong results the model
wrote around the missing table, 14 guardrail and 5 safety rejections. Only 44
attempts (40 repetitions of 14 cases) were rejected with `TABLE_SCOPE`. Under
the full scope those 44 recorded attempts become:

| Today's verdict on the 44 recorded `TABLE_SCOPE` attempts | Attempts | Of which oracle false positives (zero-answer cases) |
|---|---|---|
| Accepted, executed and scored correct | 8 (`hard_sv_products_most_units_mar_2026` 3/3, `hard_vocab_receivables_by_outlet_mar_2026` 2/3, `hard_zero_harbor_kiosk_products_mar_2026` 3/3) | 3 (`hard_zero_harbor_kiosk_products_mar_2026`) |
| Accepted and wrong | 0 | |
| Rejected by `RESPONSE_TABLES`, scored correct (guardrail false rejection) | 6 (`hard_zero_harbor_kiosk_credit_notes_2026` 3, `tpl_herbal_tea_net_sales_monthly_nov_2025_feb_2026_af98b0` 2, `tpl_category_net_sales_apr_2026_ce5e82` 1) | 3 (`hard_zero_harbor_kiosk_credit_notes_2026`) |
| Not reached (a later attempt after an accepted one), scored correct | 2 (`hard_zero_harbor_kiosk_products_mar_2026`) | 2 |
| Rejected by `RESPONSE_TABLES`, wrong | 20 | |
| Rejected by `UNKNOWN_COLUMN` / `UNKNOWN_TABLE_ALIAS`, wrong | 6 / 2 | |

By the oracle 16 of the 44 are correct SQL, but 8 of those come from the two
zero-answer cases and are wrong SQL. That leaves 8 genuinely correct: 5 pass
today and at most 3 are thrown away by the response-table contract
(`tables_used` must list every table the SQL uses). In those 3 the recorded
responses left the table out of `tables_used`, because the model had been told
it was outside the allowed set. That is an artefact of replaying
retrieved-scope answers, not something a full-scope prompt asks for, so the
rescore slightly understates the full scope here (by at most 3 attempts). The
other way round, it cannot show
regressions: on cases where retrieval was right the recorded SQL is the same
and only re-validated, so whether 13 tables in the prompt distract the model
(for example toward the `CustomerProductPrice` price list) only the live run
can tell.

On the 33 formerly flagged cases the baseline passed 7 of 99 repetitions (2
majority passes); the full-scope rescore passes 14 (5 majority passes); the
ceiling is 33/33. Without the zero-answer oracle false positives that is 6 → 11
repetitions (2 → 4 majority passes). The guardrail confusion matrix moves from
precision 100%, recall 26.4% to precision 94.0%, recall 31.8% (the 6
`RESPONSE_TABLES` false rejections above, 3 of them oracle artefacts; the 44
safety-layer rejections become guardrail decisions).

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
# rescore per scope of the previous (retrieved-scope) baseline, which the live
# run replaced: extract it from the commit that last held it (fixtures seeded;
# no LLM calls). Expect 68.8% / 68.8% / 69.8%.
git show 1aa30a3:eval/baselines/gpt-4o-mini.json > /tmp/gpt-4o-mini-retrieved-baseline.json
SCHEMA_SCOPE=retrieved npm run eval -- --rescore /tmp/gpt-4o-mini-retrieved-baseline.json
SCHEMA_SCOPE=retrieved SCHEMA_WIDEN_ON_DEMAND=1 npm run eval -- --rescore /tmp/gpt-4o-mini-retrieved-baseline.json
SCHEMA_SCOPE=full npm run eval -- --rescore /tmp/gpt-4o-mini-retrieved-baseline.json
# separately: the gate check of the current default baseline under the
# default setting (exits 0; its numbers: docs/evaluation-dataset.md#current-baseline)
npm run eval -- --offline --gate
# ceiling: point OPENAI_BASE_URL at a local server that answers each case's gold SQL, then
OPENAI_API_KEY=sk-local OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 npm run eval -- --skip-verify --no-baseline
```

## Live results

Run on 2026-10-06: `npm run eval -- --repeat 3 --budget-usd 1 --write-baseline`
with the default setting (`SCHEMA_SCOPE` unset = `auto` → `full`, 2,258 of
8,000 estimated tokens), paired automatically against the previous
`eval/baselines/gpt-4o-mini.json`. Fixtures, datasets (apart from the removed
stale `known_validator_rejection` flags) and the model are unchanged; only the
schema scope and the prompt layout differ. Cost of the run: $0.33.

| | Baseline (retrieved) | Candidate (full) |
|---|---|---|
| Git sha / prompt version | `f5e6ffef21c9` / `0c314451d4b7` | `606e0ee94531` / `b264e57d8e15` |
| Strict accuracy (95% CI) | 68.8% (63.1%–74.6%) | **72.8%** (67.2%–78.2%) |
| dev / holdout | 72.6% / 60.6% | 74.6% / **68.8%** |
| Majority-pass cases | 169/245 | 179/245 |
| Intent-clustered accuracy | 66.1% | 69.6% |
| System failures (repetitions) | 92 (retrieval misses 92) | **0** |
| Model failures (repetitions) | 137 | 200 |
| Guardrail precision / recall | 100% / 26.4% | 100% / 22.6% |
| Paired: improvements / regressions, McNemar p | | 17 / 7, p = 0.064 |
| Δ strict accuracy (95% CI, paired bootstrap) | | +4.0 pts (+0.1 to +7.9) |
| Cost per correct answer | $0.00073 | **$0.00062** |
| Prompt tokens per call / cached share | 3,407 / 72% | 3,690 / **91.5%** |
| Latency p50 / p95, retry rate | 2.41 s / 5.39 s, 11.5% | 2.64 s / 5.25 s, **5.6%** |

**Excluding the two oracle artefacts** (`hard_zero_harbor_kiosk_*`, whose gold
is empty or zero on every fixture, so wrong SQL that returns nothing passes;
both are among the improvements): 243 cases, 69.3% → 72.6% (+3.3 pts),
15 improvements vs 7 regressions, exact McNemar p = 0.134.

**Where the gains come from.** All 92 system failures disappear: every
retrieval miss that the old allow-list turned into a hard `TABLE_SCOPE`
rejection now reaches the model. 11 of the 15 real improvements are cases that
used to fail on a missing table (brand / category / campaign breakdowns, the
Swedish and typo phrasings, new vocabulary such as "receivables by outlet"),
which is why holdout gains 8.2 points against 2.0 on dev. The single cached
prefix (one prefix for every question instead of 48) raises the cached share
of prompt tokens from 72% to 91.5%, so cost per correct answer falls 15% even
though the prompt is 8% longer, and retries halve.

**Where it loses.** The 7 regressions are systematic (3/3 repetitions) and are
the classic cost of a wider context — distractors the model used to be unable
to see:

- `tpl_brand_net_sales_feb_2026`: joins through the `ProductBrand` bridge
  table (a documented trap) instead of `Product.BrandId`;
- `tpl_outstanding_balance_due_apr_2026`: `SUM(BillTotalAmount)` instead of
  `BalanceAmount`; `tpl_total_net_sales_feb15_mar15_2026`: `NetPayableAmount`
  instead of `NetAmount` — metric-column confusion between near-synonyms that
  are now all visible;
- `tpl_customer_net_sales_sales_invoices_mar_2026`: line-level amounts plus a
  `DocumentType` join for a document-level question;
- `tpl_customers_bought_feb_not_mar_2026`, `tpl_distinct_customers_monthly_q1_2026`:
  wrong result shape (one row per customer instead of a count);
- `hard_entity_sales_revenue_credits_feb_2026`: filters the posting date on
  `AccountingPosting` instead of the document date.

Model failures rise from 137 to 200 repetitions because cases that used to stop
at the validator now reach execution; most of them were failing before too.

## Decision

**Adopt `auto` (= `full` for schemas that fit 8,000 estimated tokens) as the
default.** It removes an entire failure class (retrieval misses: 92 → 0), lifts
holdout accuracy by 8 points, lowers cost per correct answer by 15% and halves
retries, with no guardrail false rejections. The net accuracy gain is
directionally positive (+4.0 pts, paired bootstrap CI +0.1 to +7.9) but **not
significant at α = 0.05** by the exact McNemar test (p = 0.064; p = 0.134
without the two oracle artefacts), so it is reported as a likely improvement,
not a proven one. `retrieved` stays selectable (and is still what `auto` picks
for large schemas, with widen-on-demand).

The committed baseline is replaced by this run (`--write-baseline`), so later
experiments are measured against full-schema prompting.

**Follow-ups this run points to:** the regressions are metric-column confusion
and distractor joins, which are exactly what the next planned experiments
target — deterministic metric compilation from the semantic layer
(net vs payable vs bill total vs balance) and join-path guardrails for bridge
tables (`ProductBrand`, `CustomerProductPrice`). The two zero-answer hard cases
need a fixture row that separates right from wrong SQL.
