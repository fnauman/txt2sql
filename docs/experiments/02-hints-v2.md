# Experiment 02: hints v2 (de-poisoning and semantic-layer knowledge)

**Variable:** `HINTS_VERSION`, from `1` (the committed baseline's prompt
knowledge) to `2` (the new default).
**Status:** offline measurements done; live run pending.
**Source:** the error analysis of the 66 failing cases of the Experiment 1
baseline, and the skeptic review's first recommendation ("Exp A: pipeline
de-poisoning plus knowledge-only semantic layer").

## Hypothesis

About a third of the baseline's failures have a trigger inside the product, not
in the model's free choice:

- the temporal resolver turns a phrase it only partly understands into a
  wrong whole month, and rule 4 tells the model not to reinterpret it;
- business rules present alternatives as equivalent (rule 7: either
  `PostingDate`; rule 18: `Product.BrandId` or the partial `ProductBrand`
  bridge) or force a shape the question did not ask for (rule 26: `LIMIT 10`
  on every ranking, also "rank" and a singular "the highest");
- the semantic layer is missing the money words the suite uses ("turnover",
  "spend", "average order value", "open amount"), so the model falls back to
  `BillTotalAmount`; it prefers the `ProductBrand` bridge for brands; it lists
  "stopped selling" as a quantity synonym and "account" as a customer synonym;
- the conventions behind the gold (units are product lines only, canceled
  documents are excluded wherever `SalesDocument` appears, campaigns are
  attributed through the product) appear nowhere in the prompt;
- retrieval matches generic words against column comments ("both days
  included" points at `NetPayableAmount`, "total" at `BillTotalAmount`);
- an entity's display columns invite a per-document list for "What were sales
  in March 2026?";
- the metric guardrail enforces net sales in a ledger question whose account
  is named "Sales Revenue", rejecting every correct answer.

Removing these triggers, and stating the missing knowledge as rules and
semantic-layer entries, should flip failures that prompt rules "ignored"
because the rules were ambiguous or wrong, without touching the model, the
datasets or the oracle.

## Design

**One switch.** `HINTS_VERSION` (`src/hints-version.js`) is read like
`SCHEMA_SCOPE` by the web server, the `optimized` CLI, `npm run eval` (live
run, rescore and verification), `verify-dataset`, `measure-prompt-cache`,
`debug-retrieval` and `evaluate-retrieval`; an invalid value stops them.
`HINTS_VERSION=1` reproduces the base branch byte for byte: prompts in both
schema scopes, semantic plans and validator decisions
(`test/hints-version.test.js` pins 20 questions against
`test/fixtures/hints-v1-prompts.json`, written by the base branch; the
question-specific part of all 255 suite prompts was diffed too, identical),
and the prompt version stays the committed baseline's `b264e57d8e15`. Version
2's prompt version is `16200b102bf9`.

**Held fixed:** the model (gpt-4o-mini), temperature and request options, the
few-shot pool and how it is picked (version 1 tokens in both arms), the schema
scope (`auto` → full), the retry budget (1), the statement timeout, the
datasets and their gold, the fixtures, the oracle. `metadata/semantic-layer.json`
and its template are unchanged; version 2 reads
`metadata/semantic-layer.hints-v2.json` on top (an overlay entry replaces the
same-named base entry in full; a new name is appended). The basic pipeline has
no hints and ignores the switch.

**Provenance.** `provenance.product.hintsVersion` records the arm (a report
without it ran version 1); `semanticLayerVersion` hashes the base layer
(version 1) or the base layer and the overlay together (version 2, plus
`semanticLayerOverlay`); report.md shows the hints version in the provenance
and comparison tables, and a rescore of a recording made with another version
says so.

### The changes and the cases behind them

Case ids are the failing cases of the Experiment 1 baseline that motivated
each change. "(holdout)" marks a case that is holdout today; the inspected
holdout is being moved to dev in a parallel change, and a blind holdout is
being written separately, so designing from these failures is in-sample work
and the live result must be read as such. Every change is a general rule or
vocabulary entry, not a fix for one wording.

**Temporal (pipeline):**

| Change | Motivating cases |
|---|---|
| A `<Month> <Year>` match that is part of a longer date phrase is dropped instead of resolved to the whole month: a day of the month ("between 1 and 10 March 2026", "Today is 15 February 2026"); a part of the month or a period ending in it ("the first week of", "the last 10 days of", "the second half of", "mid-" / "early" / "late", "the quarter ending", "the three months to"); anchors (as of, since, before, after, until, up to, end of); ranges and lists sharing a year, at either end ("January–March 2026", "from March 2026 to the end of May 2026", "between November 2025 and February 2026", "January and February 2026", "from March 2026 until today"); and to-date or open-ended tails ("to date", "year to date", "YTD", "onwards"). Quarters and as-of windows stay unresolved (a later experiment). The detector is a list of patterns around the match, not a full date grammar: a phrasing it does not list can still resolve to the whole month (`test/hints-v2.test.js` pins the listed ones and the plain mentions that must still resolve). 27 of the 255 questions lose a range and none gains or changes one; 26 of the 27 ranges were wrong, and one was right but incomplete ("Compare January and February 2026 net sales by customer in separate columns": only February was resolved). (The first version missed the parts-of-a-month, period-ending and open-range phrasings and kept only the start month of "from March 2026 to the end of May 2026"; review caught it. None of them is in the suite, so the suite's plans did not change.) | `tpl_document_count_mar01_10_2026_785050`, `hard_asof_month_to_date_documents` (the model obeyed the wrong month); latent in `tpl_customer_qty_top3_q1_2026_1d11c5`, `tpl_north_district_document_count_q1_2026_c55b7e`, `tpl_total_net_sales_feb15_mar15_2026_40ae9d` (holdout) |
| Rule 4: resolved references are exact for the phrases they quote; anything else is read from the question (was: "do not reinterpret"). | same |

**Business rules** (`BUSINESS_RULES_V2` in `src/constants.js`; version 1's
27 rules are untouched, version 2 rewrites 11 and adds 3, 30 in all):

| Rule | Version 2 | Motivating cases |
|---|---|---|
| 6, 7 posting date | "posted" / "posting date" of documents filters `SalesDocument.PostingDate` on `SalesDocument` itself, never through `AccountingPosting` rows; `AccountingPosting.PostingDate` only for ledger postings | `edge_public_004_posting_date_trap`; `tpl_documents_posted_feb_2026_b4d3f2`, `_f54d6b` (holdout) |
| 8 cancellation | also where `SalesDocument` is joined only for a date, inside a subquery or `NOT EXISTS`, and in a `LEFT JOIN` anti-join's `ON` clause | `core_public_005`, `paraphrase_public_005`, `core_public_009`, `paraphrase_public_009`; `tpl_active_customers_without_sales_q1_2026_d84881`, `_a927e0` (holdout) |
| 10 document money totals | sales, revenue, turnover, spend and order value are `NetAmount`; `GrossAmount` only when gross or tax included is said; bill total / payable / subtotal only when named (was: those four listed as alternatives "based on the wording") | `hard_vocab_department_turnover_feb_2026`, `hard_entity_lakeside_spend_q1_2026`, `hard_vocab_outlet_turnover_top1_mar_2026`, `tpl_average_order_value_mar_2026_30dc49`, `tpl_store_average_order_value_q1_2026_146d60`, `tpl_average_order_value_monthly_q1_2026_afb751`, `tpl_customer_average_order_value_top3_q1_2026_820a8d`; `40ae9d` (holdout) |
| 12 product level | line `NetAmount` for sales, `Quantity` for units; `TotalAmount` / `SalePrice` only when asked (was: all four side by side) | `hard_vocab_department_turnover_feb_2026`; `tpl_product_net_sales_rank_dec_2025_af0d37`, `tpl_brand_net_sales_top3_q1_2026_025f70`, `tpl_herbal_tea_net_sales_monthly_nov_2025_feb_2026_a36878` (holdout) |
| 16 campaigns | campaign sales, units and customers through `Product.CampaignId`, not `SalesDocument.CampaignId` (states the gold's convention; the skeptic's preferred resolution of that ambiguity) | `tpl_weekend_pantry_net_sales_monthly_q1_2026_712deb`, `edge_public_002_campaign_net_sales_march_2026`; `tpl_campaign_net_sales_q1_2026_918652`, `_0be558` (holdout) |
| 18 brands | through `Product.BrandId`; the `ProductBrand` bridge (4 of 13 products) is not for brand results (was: "`Product.BrandId` or `ProductBrand`") | `tpl_brand_net_sales_feb_2026_196b6b`; `tpl_brand_net_sales_top3_q1_2026_d343eb`, `_025f70` (holdout) |
| 21 ledger accounts | "account" in a ledger question is `LedgerAccount`; account numbers on `AccountCode`, never `LedgerAccountId`; names with `LIKE` on `AccountName` | `tpl_account_net_movement_feb_2026_c1256b`, `tpl_receivable_debits_posted_mar_2026_aab20c`, `hard_entity_sales_revenue_credits_feb_2026` |
| 23 units | units count product lines only (`SalesDocumentLine.ProductId IS NOT NULL`: delivery-fee lines are not units) | `tpl_total_qty_dec_2025_214320`, `_12ab97`, `tpl_customer_qty_top3_q1_2026_2f8130`, `_1d11c5`; `tpl_store_qty_mar_2026_651565`, `_4d7e63` (holdout) |
| 26 ranking limits | `top N` → `LIMIT N`; a singular superlative → `LIMIT 1`; plural top / most / highest without a number → 10; rank / order / sort / highest-to-lowest without a number → no `LIMIT` (the golds' convention) | `hard_vocab_outlet_turnover_top1_mar_2026` (rep 2: `LIMIT 10` for "the highest"); `af0d37` (holdout: "Rank" cut 13 rows to 10) |
| new: count | "how many / number of / count the <entities>" is one row with one number (no `GROUP BY`, no name columns) unless per / by / each / every; count by ID, not name; "how many units" is a `SUM` | `core_public_004`, `paraphrase_public_004`, `tpl_urban_refresh_customers_q1_2026_809e2f`; `tpl_customers_bought_feb_not_mar_2026_a6915c`, `_bbddd4` (holdout) |
| new: single total | "how much / what was / total <metric>" with no per / by / each / split / time grain is one row, also when filtered to one named entity | `hard_ambiguous_sales_mar_2026`; `tpl_outstanding_balance_mar_2026_c15bb6`, `tpl_net_sales_south_store_mar_2026_ff1f77`, `_4dd0d0` (holdout) |
| new: time grain | monthly / per month / each month / by month is one row per month with a period label (`DATE_FORMAT(date_col, '%Y-%m')`), grouped and ordered by it, never replaced by a name column | `tpl_gross_monthly_2025_a7ccf5`, `tpl_distinct_customers_monthly_q1_2026_c34a0c`; `a36878`, `tpl_revenue_credits_monthly_q1_2026_e1b20a` (holdout) |

**Semantic layer** (the overlay):

| Change | Motivating cases |
|---|---|
| `net_sales`: "turnover", "spend", "spent" as **advisory** synonyms (a hint, never a `METRIC_COLUMN` rejection, so "gross turnover" keeps `GrossAmount`), with the money-word convention as its note; with a product dimension the line-level metric is derived as before | `hard_vocab_department_turnover_feb_2026`, `hard_vocab_outlet_turnover_top1_mar_2026`, `hard_entity_lakeside_spend_q1_2026`; `40ae9d`, `af0d37`, `a36878`, `025f70`, `918652` (holdout) |
| new metric `average_order_value` = `AVG(COALESCE(SalesDocument.NetAmount, 0))`, enforced on "average order value", advisory on "order value" alone. A new per-metric list, `advisory_when_mentioned` (gross, tax included, including tax, bill total, net payable, subtotal, ...), makes the metric a hint when the question names another amount, so "average gross order value" and "average order value including tax" accept `GrossAmount` as rule 10 says; `net_sales` carries the same list ("revenue including tax"), and an explicit "net" phrase ("net sales") still enforces. (The first version enforced "order value" in every question; review showed it contradicted rule 10.) | `30dc49`, `146d60`, `afb751`, `820a8d` (4 of 4 AOV questions failed, all on `BillTotalAmount`) |
| new metric `open_balance` = `BalanceAmount`, enforced on "open amount", "open balance", "unpaid balance" (and its name), advisory on "outstanding", "unpaid", "owe", "owed". (It was first named `outstanding_balance`; the matcher reads a name as a synonym, so "outstanding balance" enforced the metric in two holdout questions, `45fa9f` and `59ffde`, which the vocabulary check did not see. Renamed; see the dataset paragraph below.) The guardrail accepts `BalanceAmount`, or `NetPayableAmount` together with `PaidAmount` (a new `alternative_column_sets` field: `BalanceAmount = NetPayableAmount - PaidAmount` in every `SalesDocument` row of seed, v2 and v3), so an equivalent open-amount formula is not rejected; `BillTotalAmount - PaidAmount` still is. | `tpl_outstanding_balance_due_apr_2026_571390` ("open amount" → `BillTotalAmount`) |
| `quantity_sold`: "units" and "quantity" (advisory: "unit price" must not demand `Quantity`), default filter `ProductId IS NOT NULL`, no "stopped selling" | `214320`, `12ab97`, `2f8130`, `1d11c5`, `paraphrase_public_004` ("stopped selling" made a count a quantity); `651565`, `4d7e63` (holdout) |
| `brand` prefers `Brand` only (no `ProductBrand`, so no bridge join hints) | `196b6b`; `d343eb`, `025f70` (holdout) |
| `customer` (and the `Customer` table alias) without "account" / "accounts" | `c1256b`; noise in `e1b20a` |
| metric default filters (cancellation) and notes printed in the hint; the debit / credit notes say to join `SalesDocument` only for a document column and then filter cancellations, and that a `PostingDate` filter needs no join (their preferred tables keep `SalesDocument`: the `DocumentDate` ledger golds need it) | `core_public_005`, `paraphrase_public_005`, `core_public_009`, `paraphrase_public_009`; `tpl_account_debit_credit_posted_apr_2026_2218ff` (holdout) |
| an advisory metric says which kind of weak match it is (generic wording or a count question), so "How many units did we sell" is not told that counts do not need the quantity | supports the units changes |

**Plan, retrieval and guardrail:**

| Change | Motivating cases |
|---|---|
| An entity whose every matched word lies inside a matched metric measured at that entity's grain loses its display columns (keeps tables and default filters): "sales" in "What were sales…" is net sales over documents, not a document list. A metric phrase that names another entity ("biggest buyers") keeps that entity's columns. 55 questions lose `DocumentNo` / `DocumentDate`; no gold selects them. | `hard_ambiguous_sales_mar_2026`; `c15bb6` (holdout) |
| Retrieval ignores words that matched columns by accident: included, distinct, total, units, recorded, used, column, row, as (and inflections). 51 relevance hints lose an accidental column. The semantic plan does not read them. | `edge_public_002` ("total" → `BillTotalAmount`); `40ae9d` (holdout: "included" → `NetPayableAmount`) |
| An account named after its code, "account 4000 (Sales Revenue)" (or with a quoted name), is one ledger-account reference whose span consumes the metric words in the name, as the existing "sales revenue account" synonym does for "the Sales Revenue ledger account". Sales words outside the name still match and enforce, so "net sales and total credits" enforces both measures. Only `e1b20a` changes. (A first version demoted every enforced sales metric once a debit or credit metric matched; review showed it accepted `BillTotalAmount` for "What were net sales and total credits…", so it was replaced; `test/hints-v2.test.js` pins both questions.) | `tpl_revenue_credits_monthly_q1_2026_e1b20a` (holdout; the gold, all alternatives and the positive control were rejected) |

**Considered and not done:**

- *Few-shot examples:* none added. The evidence (a list-shaped anti-join
  example priming list answers to "how many") points at a counted anti-join
  example, which would be near-equal to eval intents (`core_public_004`,
  `a6915c`) and leak; the count rule covers it. `test/few-shot-leakage.test.js`
  is unchanged and green.
- *Dropping `SalesDocument` from the debit / credit metrics:* the
  `DocumentDate` ledger golds need the join; a note replaces it.
- *Enforcing "turnover", "units" or "quantity":* would reject correct answers
  ("gross turnover", "unit price"); kept advisory.
- *"takings", "take in":* no failure is caused by them (passing cases use
  them); not added.
- *A DISTINCT rule for "which X did we sell":* one case
  (`edge_public_003_sparkling_water_master_data`); not added.
- *Quarter and as-of resolution, a multi-table value index, deterministic
  lints (cancellation injection, `NOT IN` over nullable columns, fan-out of
  `COUNT(*)`):* later experiments (the analysis's Exp B to D).

**Dataset flag.** The dataset is unchanged. Its one
`known_validator_rejection: METRIC_COLUMN` (`e1b20a`) is real under version 1
and closed by version 2. Both arms must verify, so verification now asks the
other supported hints versions before calling a flag stale: under version 2
the flag is a note ("still rejects it under HINTS_VERSION=1, which keeps the
flag"); a flag no supported version needs is still a problem. Remove the flag
when version 1 is retired. The templated generator's holdout-vocabulary check
now reads both arms' layers (the overlay adds "average order value", "open
amount", ...) and the names of the overlay's entries (underscores as spaces),
because the matcher treats a name as one more synonym. The committed holdout
contains none of that vocabulary. Under version 2 the holdout still meets
the overlay's single-word synonyms, which the check allows by design
("turnover", "spend", "outstanding", "unpaid", "units": advisory hints, never
a rejection); with the inspected holdout moving to dev that matters only for
the blind holdout being written. Not closed here: the base layer's names are
not checked, and "store location" (entity `store_location`) occurs in five
committed holdout questions under both versions; closing it needs a dataset
change.

**The comparison:** a paid `--repeat 3` run with the default setting
(`HINTS_VERSION` unset = 2), paired against the committed baseline (hints
version 1, recorded as not recorded). With no dataset change the pairing is
complete (245 answer cases).

**Confounds, stated up front:** version 2 changes the system prompt for every
question (8,409 vs 5,670 characters of instructions) and the question-specific
context of 190 of the 255 questions (129 of them pass today), so a live
result measures the bundle, not each change; the per-change tables say which
failures each change targets. The motivating failures include today's holdout
cases.

## Offline measurements

All with zero LLM calls, on freshly seeded fixtures (seed `094282546fe5`, v2
`7adec1b3bc33`, v3 `51d1c42c3b88`), over the default suite (255 unique cases,
245 answer cases, 130 intents), full schema scope.

### Version 1 is the baseline

- `test/hints-version.test.js`: 20 questions (every change's wording) give the
  base branch's system prompt, user prompt (sha256), allow-list and semantic
  plan, in the full and the retrieved scope;
  `test/schema-scope.test.js` still reproduces main's retrieved-scope prompts.
- The question-specific context of all 255 suite questions under
  `HINTS_VERSION=1` equals the base branch's; the prompt version is the
  committed baseline's.
- Rescore of the committed baseline with `HINTS_VERSION=1`: 72.8%
  (179/245 majority passes), 0 flips — the baseline exactly.

### Ceiling (gold-answering stand-in)

A local stand-in for the OpenAI API answers every answer case with its gold
SQL (`tables_used` = the gold's tables) and declines abstain / clarify cases:

| | `HINTS_VERSION=1` | `HINTS_VERSION=2` |
|---|---|---|
| Strict accuracy | 99.6% (244/245) | **100.0% (245/245)** |
| System failures | 1 guardrail false rejection (`e1b20a`, `METRIC_COLUMN`) | 0 |
| Abstain / clarify declined | 10/10 | 10/10 |

The ceiling does not drop; version 2 removes the last guardrail false
rejection.

### Rescore of the committed baseline under version 2

`npm run eval -- --offline` (`HINTS_VERSION` unset = 2) re-validates,
re-executes and re-scores the recorded SQL. Only validator and semantic-plan
effects can show: the recorded SQL was generated from version 1's prompts,
so none of the prompt changes (rules, hints, temporal, retrieval) is measured
here.

| | Baseline | Rescore, version 2 |
|---|---|---|
| Strict accuracy | 72.8% | 72.8% (paired 245, Δ 0.0, 0 flips) |
| Repetitions: pass / wrong result / guardrail true rejection | 535 / 188 / 12 | 535 / 176 / 24 |
| Guardrail confusion (over every attempt) | TP 55, FP 0, FN 188 · precision 100%, recall 22.6% | TP 64, FP 0, FN 176 · precision 100%, recall 26.7% |

What moved, repetition by repetition:

- 15 repetitions of 5 cases (`30dc49`, `146d60`, `afb751`, `820a8d` average
  order value; `571390` open amount) answered with `BillTotalAmount` are now
  rejected by `METRIC_COLUMN` (true rejections: those answers are wrong).
  Live, the product would retry with a message naming `NetAmount` /
  `BalanceAmount`; a rescore cannot replay that retry.
- `e1b20a`'s first attempt (credits as one total) is no longer rejected: it
  executes and is still wrong (no monthly grain), so the case needs the
  time-grain rule as well, which only a live run can test.
- No passing repetition changed; no gold, alternative or positive control is
  rejected (`npm run verify-dataset`, below).

### Verification

`npm run verify-dataset` passes every gate under `HINTS_VERSION=2` and under
`HINTS_VERSION=1` (264 cases, 0 failures; design kill rate 100% on every
dataset). Templated positive controls passing the validator: 58/59 (version
1, the `e1b20a` control is the known rejection) → 59/59 (version 2).

### Prompt size

`measure-prompt-cache` over the suite, full scope (estimated tokens =
characters / 4):

| Per question | Version 1 | Version 2 |
|---|---|---|
| Prompt | 4,127 est. tokens | 4,875 est. tokens (+18%) |
| Cacheable prefix (system + schema) | 3,676 | 4,361 (+685: the rewritten and added rules) |
| Question part | 451 | 514 |
| Distinct cacheable prefixes | 1 | 1 |

### Plan changes over the suite

Of the 255 questions under version 2: 27 lose a temporal range, 26 of them wrong (17 pass
today), 55 lose document display columns, 51 relevance hints lose an
accidental column, 66 have different metric matches, 39 different join hints
(the `ProductBrand` bridge hints are gone), 82 different default filters. The
few-shot examples are the same for every question. Under
`SCHEMA_SCOPE=retrieved` (not the default) retrieval misses fall from 33 to 25
golds and none is added.

### Reproduce

```bash
# version 1 = the base branch, byte for byte; per-change unit tests
node --test test/hints-version.test.js test/hints-v2.test.js
# fixtures, verification under both arms
npm run seed-fixtures
npm run verify-dataset
HINTS_VERSION=1 npm run verify-dataset
# rescore of the committed baseline (no LLM calls)
npm run eval -- --offline
HINTS_VERSION=1 npm run eval -- --offline
# ceiling: point OPENAI_BASE_URL at a local server that answers each case's gold SQL, then
OPENAI_API_KEY=sk-local OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 npm run eval -- --skip-verify --no-baseline
HINTS_VERSION=1 OPENAI_API_KEY=sk-local OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 npm run eval -- --skip-verify --no-baseline
```

## Live results

Not run yet.

## Decision

Pending the live run.
