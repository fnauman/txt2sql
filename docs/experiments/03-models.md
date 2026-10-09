# Experiment 03: models (gpt-4o-mini → gpt-6-luna at low / medium reasoning effort)

**Variable:** the model and its reasoning effort (`MODEL_NAME` /
`REASONING_EFFORT`, or `--model` / `--reasoning-effort`), from `gpt-4o-mini`
(no reasoning) to `gpt-6-luna` at effort `low` and at effort `medium`.
**Status:** complete — adopted (live runs on 2026-10-07 at commit `a57fa44`;
`gpt-6-luna` at reasoning effort `low` is the default and its run is the
committed default baseline, `eval/baselines/gpt-6-luna.low.json`). The
Hypothesis and Design sections are the pre-registration as committed at
`a57fa44`, written before any paid call and unchanged since.
**Source:** the model-support change (`src/model-config.js`): the request each
model family accepts, the effort and its source in every header and report,
reasoning tokens in the usage, and the gpt-6-luna price.

## Hypothesis

A current reasoning model answers more of the suite correctly than
gpt-4o-mini with the same prompt, the same product loop and the same
validator, at a cost and latency the product can carry. Reasoning effort
trades accuracy for tokens and latency, so `low` and `medium` are both
measured.

## Design

- **Reference:** the committed baseline `eval/baselines/gpt-4o-mini.json`
  (gpt-4o-mini, hints v2, full schema scope, 404-case suite, 3 repetitions):
  strict accuracy 73.6%, dev 88.3% (245 cases), holdout 49.2% (147 cases);
  $0.00060 per correct answer (dev cases), p95 question latency 4.4 s.
- **Candidates:** `gpt-6-luna` at `--reasoning-effort low` and at
  `--reasoning-effort medium` (OpenAI endpoint; $0.10 input, $0.01 cached
  input, $0.50 output per 1M tokens, verified 2026-10-07). Everything else
  stays fixed: prompt version (the prompt does not depend on the model), hints
  version, schema scope, retry budget, statement timeout, datasets, fixtures,
  oracle. The request differs only as `src/model-config.js` requires for a
  reasoning model: no `temperature`, `reasoning_effort` sent,
  `max_completion_tokens` 16000 (`LLM_MAX_COMPLETION_TOKENS`).
- **Pairing:** each candidate run compares itself with the reference
  explicitly (`--compare eval/baselines/gpt-4o-mini.json`: the default
  baseline of `gpt-6-luna` at an effort would be
  `eval/baselines/gpt-6-luna.<effort>.json`, which does not exist). The
  comparison flags the model change by design.
- **Budget:** $4.00 for all remaining paid work, every run capped with
  `--budget-usd`.

### Pre-registered decision rule

A candidate arm is adopted as the default model only if all of these hold:

1. strict accuracy improves over the reference with an exact two-sided
   McNemar p < 0.05 on the paired answer cases (392 when every case pairs);
2. the holdout does not regress: on the paired holdout cases, read once in
   aggregate with `--holdout-summary` on the concluding run, the candidate is
   not significantly worse than the reference (an exact McNemar p < 0.05 with
   more regressions than improvements fails the arm); the holdout accuracy
   point estimate is reported next to it;
3. cost per correct answer is at most 3x the reference's (at most $0.0018);
4. p95 question latency (product loop) stays under 10 s.

Cost per correct answer and latency are read as report.md shows them by
default (dev cases, the holdout hidden), like the reference's figures.

Rule 2 was first written as a point estimate (the candidate's holdout
accuracy not below 49.2%). It was changed to the paired test above on
2026-10-07, before the pilot or any paid call: with 147 holdout cases, an arm
exactly as accurate as the reference falls below a fixed point estimate about
half the time, and `--holdout-summary` now gives the paired holdout test in
aggregate without showing any case. Rule 1 already requires a significant
overall gain; rule 2 guards against a gain that comes from the dev cases the
prompt was tuned on at the holdout's expense.

Between two qualifying arms, prefer the cheaper (cost per correct answer)
unless the other is significantly better than it (exact McNemar p < 0.05
between the two arms). If no arm qualifies, gpt-4o-mini stays the default.

### Procedure

1. **Pilot** (to measure tokens, cost, truncation and latency before the full
   runs): the same 24 dev cases, fixed before the pilot and listed below, x 1
   repetition per arm. They are spread evenly over the 245 dev answer cases
   in id order (the middle case of each of 24 equal slices):

   `core_public_006`
   `edge_public_007_category_quantity_current_join`
   `hard_entity_lakeside_spend_q1_2026`
   `hard_typo_qty_by_category_feb_2026`
   `hard_zero_harbor_kiosk_products_mar_2026`
   `tpl_account_debit_credit_posted_apr_2026_2218ff`
   `tpl_average_order_value_mar_2026_30dc49`
   `tpl_brand_qty_q1_2026_8f2e8c`
   `tpl_category_distinct_customers_mar_2026_483c88`
   `tpl_category_qty_feb_2026_7d67a2`
   `tpl_customer_net_sales_q1_2025_vs_q1_2026_d99d9e`
   `tpl_customer_net_sales_top3_jan_2026_83a22a`
   `tpl_distinct_customers_feb_2026_20cd13`
   `tpl_doctype_net_sales_q1_2026_c03c7d`
   `tpl_document_count_monthly_2026_bd4fed`
   `tpl_household_net_sales_feb_2026_79c349`
   `tpl_net_sales_by_customer_and_store_mar_2026_c04623`
   `tpl_net_sales_monthly_q1_2026_561627`
   `tpl_outstanding_balance_mar_2026_c15bb6`
   `tpl_product_net_sales_top5_q1_2026_d39faf`
   `tpl_revenue_credits_monthly_q1_2026_4e91fe`
   `tpl_store_gross_feb_2026_a9f48b`
   `tpl_total_gross_q1_2026_3c6ada`
   `tpl_total_qty_dec_2025_12ab97`

   For example

   ```bash
   npm run eval -- --model gpt-6-luna --reasoning-effort low --split dev --case-id <24 dev ids> \
     --compare eval/baselines/gpt-4o-mini.json --budget-usd 0.25
   npm run eval -- --model gpt-6-luna --reasoning-effort medium --split dev --case-id <24 dev ids> \
     --compare eval/baselines/gpt-4o-mini.json --budget-usd 0.40
   ```

   Read: cost per question, reasoning tokens per call, `LLM_TRUNCATED`
   failures (reasoning tokens count against the 16000 limit), p50 / p95
   latency. Recompute the full-run estimates from these numbers (the planning
   estimate is about $0.8 for `low` and $1.5-2 for `medium` at `--repeat 3`).
2. **Full suite**, per arm, as far as the budget allows (`--repeat 3`, fewer
   repetitions only if the pilot says the budget cannot cover 3):

   ```bash
   npm run eval -- --model gpt-6-luna --reasoning-effort low --repeat 3 \
     --compare eval/baselines/gpt-4o-mini.json --holdout-summary --budget-usd <from the pilot>
   npm run eval -- --model gpt-6-luna --reasoning-effort medium --repeat 3 \
     --compare eval/baselines/gpt-4o-mini.json --holdout-summary --budget-usd <from the pilot>
   ```

   The header line of each run must read `model gpt-6-luna (--model);
   reasoning effort low (--reasoning-effort)` (or `medium`); a run whose
   header names another model or effort is discarded.
3. **Holdout in aggregate only** (no `--reveal-holdout`): the one holdout
   readout is the `--holdout-summary` line of the full runs, read against
   rule 2. Error analysis of the candidates' failures uses dev cases only.
4. Do not re-baseline in the same step: a new default baseline
   (`eval/baselines/gpt-6-luna.<effort>.json`) is written only after the
   decision, from a clean tree.

## Offline measurements

No LLM calls; on the final code unless stated otherwise.

- **Prompt size: unchanged.** The prompt does not depend on the model: the
  reference and both arms recorded prompt version `4358263bcf82` (report.md,
  Provenance), and `npm run measure-prompt-cache -- --suite --split dev`
  prints, for any model, 255 dev questions with one cacheable prefix, an
  average prompt of 19,493 characters (4,874.4 estimated tokens) and an
  average cacheable prefix of 4,361.0 estimated tokens. What the live runs
  billed is in the Tokens row below (per LLM call over the dev cases, the
  Tokens row divided by the LLM calls of the Retry rate row: 4,377 prompt
  tokens for the reference, 4,362 for either arm; the cached share fell from
  83.5% to 81.9% and 80.4%).
- **Requests.** Only the request options change, as `src/model-config.js`
  requires for a reasoning model: both arms recorded
  `max_completion_tokens 16000, reasoning_effort low` (or `medium`) and no
  `temperature` (report.md, "Model settings"), and the exact request bodies
  of both efforts are pinned by `test/model-requests.test.js` (the OpenAI SDK
  against a local stand-in). Every live run's header read
  `model gpt-6-luna (--model); reasoning effort low (--reasoning-effort);
  endpoint api.openai.com` (or `medium`), as step 2 requires.
- **Ceiling.** The datasets, fixtures and oracle are the reference's, and
  `npm run verify-dataset` reports 0 failures on the final code: under the
  default hints version 2 the validator accepts every gold answer except
  those of the 4 holdout cases flagged `known_validator_rejection`. So the
  ceiling with perfect SQL is unchanged: 99.0%.

### Pilot

The 24 dev cases listed above, 1 repetition per arm, run as written in step 1
(with `--no-docker` and an `--output-dir`). Figures as each run's console and
report.md print them:

| Arm | Passed | Cost (per question) | Latency p50 / p95 | Prompt tokens (cached) | Completion tokens (reasoning) | `LLM_TRUNCATED` |
|---|---|---|---|---|---|---|
| low | 24/24 | $0.0095 ($0.00040) | 3.16 s / 4.90 s | 104,242 (42,987) | 5,863 (1,434) | 0 |
| medium | 24/24 | $0.0104 ($0.00043) | 3.63 s / 5.36 s | 104,242 (42,987) | 7,677 (3,090) | 0 |

The reference passes the same 24 cases (24 paired, no flip in either arm).
No repetition was cut off at the 16000-token limit, so it stayed. Recomputed
full-run estimates: about $0.48 (low) and $0.52 (medium) for 1,212
repetitions at the pilot's cost per question, against the planning estimate
of $0.8 and $1.5-2. Both arms therefore ran with `--repeat 3` under
`--budget-usd 1.00` each. The full runs cost less than estimated ($0.3276 and
$0.3992): over 1,212 repetitions far more of the prompt is served from the
cache (81.9% and 80.4% of the dev cases' prompt tokens, against 41.2% in the
pilot).

## Live results

Two paid runs on 2026-10-07 at commit `a57fa44` (a clean tree), endpoint
api.openai.com, one per arm:

```bash
npm run eval -- --model gpt-6-luna --reasoning-effort low --repeat 3 \
  --compare eval/baselines/gpt-4o-mini.json --holdout-summary --budget-usd 1.00 \
  --write-baseline --baseline-file <outside the repository>
npm run eval -- --model gpt-6-luna --reasoning-effort medium --repeat 3 \
  --compare eval/baselines/gpt-4o-mini.json --holdout-summary --budget-usd 1.00 \
  --write-baseline --baseline-file <outside the repository>
```

(plus `--no-docker` and an `--output-dir`). Each saved a compact copy of its
report outside `eval/baselines/` (step 4: no re-baselining in the run); after
the decision the low arm's copy was committed as
`eval/baselines/gpt-6-luna.low.json`, unchanged except that the two local
paths in its recorded runner flags (`baselineFile`, `outputDir`) read
`<outside the repository>/…`. The medium arm's is not committed. Both
runs completed every case (no budget stop) and paired all 392 answer cases
with the reference (no gold or scoring change between `4ff6ecb` and
`a57fa44`). The rows marked dev cover the dev cases, as report.md prints
them by default; the holdout is read only as its accuracy by split and the
`--holdout-summary` line.

| Measure | gpt-4o-mini (reference) | gpt-6-luna low | gpt-6-luna medium |
|---|---|---|---|
| Git sha / prompt version | `4ff6ecb` / `4358263bcf82` | `a57fa44` / `4358263bcf82` | `a57fa44` / `4358263bcf82` |
| Strict accuracy, every split (392 answer cases) | 73.6% | **89.4%** | 89.6% |
| By split: dev (245) / fresh holdout (147) | 88.3% / 49.2% | 94.0% / **81.6%** | 93.6% / 83.0% |
| Strict accuracy, dev (95% CI) | 88.3% (84.4%–92.0%) | 94.0% (91.2%–96.6%) | 93.6% (90.6%–96.5%) |
| Majority-pass cases, dev | 217/245 | 232/245 | 229/245 |
| Intent-clustered accuracy, dev (130 intents) | 86.5% | 94.1% | 93.6% |
| vs reference, every paired answer case (392): improvements / regressions, exact McNemar p | | 74 / 8, p < 0.001 | 75 / 12, p < 0.001 |
| Δ strict accuracy, every paired case (paired bootstrap 95% CI) | | +15.7 pts (+11.7 to +19.7) | +16.0 pts (+11.8 to +20.3) |
| vs reference, paired dev cases (245): improvements / regressions, p | | 18 / 3, p = 0.001 | 19 / 7, p = 0.029 |
| Δ strict accuracy, paired dev cases (95% CI) | | +5.7 pts (+2.5 to +9.4) | +5.3 pts (+1.6 to +9.3) |
| Attribution, dev (repetitions) | pass 649 · model 86 · system 0 | pass 691 · model 44 · system 0 | pass 688 · model 47 · system 0 |
| Guardrails, dev attempts: wrong SQL caught / correct SQL rejected / wrong SQL accepted | 34 / 0 / 78 (recall 30.4%) | 0 / 0 / 44 (recall 0.0%) | 0 / 0 / 47 (recall 0.0%) |
| `LLM_TRUNCATED`, dev (repetitions) | | 0 | 0 |
| Abstain / clarify handled, dev | 0 / 10 | 0 / 10 | 0 / 10 |
| Cost per question / per correct answer, dev | $0.00051 / $0.00060 | $0.00024 / $0.00027 | $0.00028 / $0.00031 |
| Whole-run spend (the Budget row) | $0.6347 | $0.3276 | $0.3992 |
| Tokens, dev: prompt (cached) · completion (reasoning) | 3,475,276 (2,902,528) · 147,513 | 3,345,434 (2,740,668) · 194,015 (51,171) | 3,345,914 (2,691,420) · 247,399 (102,539) |
| Question latency p50 / p95, retry rate, dev | 2.39 s / 4.40 s, 3.8% | 3.04 s / 5.73 s, 0.3% | 4.03 s / 6.36 s, 0.3% |

The reference column is `npm run eval -- --rescore eval/baselines/gpt-4o-mini.json`,
the low column `npm run eval -- --offline` (the committed default baseline)
and the medium column that run's report.md; all rescore to the same figures
on today's code with zero LLM calls. The every-paired-case rows are the test
`--gate` applies and pre-registered rule 1 reads (the run's report.json,
`comparison`); report.md and the console show the dev rows and the holdout
line, whose counts add up to them. The low arm's paired-dev row is what
`npm run eval -- --offline --compare eval/baselines/gpt-4o-mini.json` prints.

**The holdout, in aggregate** (the one readout, the `--holdout-summary` line
of each full run; `npm run eval -- --offline --compare
eval/baselines/gpt-4o-mini.json --holdout-summary` prints the low arm's
again):

- low: `147 paired holdout case(s); 56 improvement(s), 5 regression(s); exact
  McNemar p = 0.000 → significantly better than the baseline; strict accuracy
  49.2% → 81.6%, Δ +32.4 pts (95% CI +24.3 pts to +40.4 pts)`
- medium: `147 paired holdout case(s); 56 improvement(s), 5 regression(s);
  exact McNemar p = 0.000 → significantly better than the baseline; strict
  accuracy 49.2% → 83.0%, Δ +33.8 pts (95% CI +25.2 pts to +41.9 pts)`

**Medium vs low.** A zero-cost rescore of the medium run compared with the low
run (`npm run eval -- --rescore <medium report.json> --compare <low
report.json>`; the figures are that rescore's report.json, `comparison`, like
the every-paired-case rows above, since its console and report.md show the dev
cases only): every paired answer case (392), 89.4% → 89.6%, 3 improvements and
6 regressions, exact McNemar p = 0.508 → no significant difference. Medium
spent twice the reasoning tokens (102,539 against 51,171 over the dev cases)
and 1 s more at the median for no measurable gain.

**Spend.** $0.747 of the $4.00 budget: pilots $0.0199 ($0.0095 + $0.0104),
low $0.3276, medium $0.3992.

**Reading it.** The gain is the model's: the prompt version (`4358263bcf82`),
hints version, schema scope, retry budget, datasets, fixtures and oracle are
the reference's. The validator code and the hints-v2 semantic-layer overlay
received review fixes between `4ff6ecb` and `a57fa44` (the semantic-layer
version recorded in the two baselines' provenance differs; the prompt does
not), but they move none of the reference's verdicts: on the final code
`MODEL_NAME=gpt-4o-mini npm run eval -- --offline --gate` rescores its
recorded SQL with 0 flips, so the comparison scores both sides with the same
code. On the dev cases, the ones the prompt was tuned on for gpt-4o-mini, the gain is +5.7 pts
(88.3% → 94.0%); on the blind holdout it is +32.4 pts (49.2% → 81.6%, 56
improvements against 5 regressions), so most of the improvement is on the new
intents and wording that gpt-4o-mini handled worst. It is out-of-sample
evidence twice over: the holdout was written blind before this experiment, and
neither the model nor the prompt was tuned on it. The dev-holdout gap narrows
from 39 to 12 points. Cost per correct answer falls by more than half
($0.00060 → $0.00027): the gpt-6-luna price per token is lower, and retries
almost vanish (3.8% → 0.3%). Latency rises (p95 4.40 s → 5.73 s) with the
reasoning tokens. The guardrails rejected none of the low arm's dev SQL (0
caught, 0 false rejections): every wrong dev answer is a valid query that
returns the wrong result, which the validator cannot see (the product retries
only a query that fails generation, validation or execution).

**Repetitions vary.** Repetitions are not deterministic for either model: a
reasoning model takes no `temperature`, and gpt-4o-mini at temperature 0
varies too. 11 of the 245 dev cases have 1 or 2 passes out of 3 at low effort,
5 at medium and 6 for gpt-4o-mini (report.md, Cases; one run each, so this
does not rank the models' variability). Every live-results figure averages 3
repetitions per case (the pilot: 1), and every comparison here uses
`--repeat 3`.

**Threats to validity.** One 3-repetition run per arm on one day; a provider
update of the model could move it. The reference ran a day earlier
(2026-10-06, `4ff6ecb`) with the same prompt version, datasets, fixtures and
oracle (the validator fixes since then leave its verdicts unchanged, see
above). The prompt and the semantic layer were tuned on gpt-4o-mini's dev
failures, which may favour or handicap another model on the dev cases; the
holdout is the measurement that does not depend on that. The holdout is small
(147 answer cases over 75 intents) and is read only in aggregate, so its gain
says nothing about which kinds of holdout question improved.

### Remaining gaps (dev cases only)

**Every dev failure is a wrong result.** The low arm's 44 failing dev
repetitions are all `wrong_result` (model bucket; no system error, no
`LLM_TRUNCATED`, no guardrail rejection). They make up 13 dev cases that fail
by majority; 10 of them failed in the reference too and 3 are the low arm's
regressions against it (`tpl_category_distinct_customers_mar_2026_cd96b8`,
`tpl_product_qty_top5_feb_2026_8a9dc1`, `tpl_store_qty_mar_2026_651565`). By
failure class (the low run's report.md and its report.json, dev cases only):

| `failure_class` | Cases | Which (passes of 3) |
|---|---|---|
| `default_filter` | 5 | the ledger-account rankings by debit or credit in March 2026, `core_public_005`, `core_public_009` and their paraphrases `paraphrase_public_005`, `paraphrase_public_009` (0/3 each: postings of non-canceled sales documents only); `tpl_store_qty_mar_2026_651565` (1/3: the two failing repetitions applied the product-line and cancel filters but listed every location, with a zero row for a store with no March sales) |
| `aggregation_shape` | 2 | monthly series, `tpl_net_sales_online_orders_monthly_2026_25aa4c`, `tpl_sunvale_net_sales_monthly_q1_2026_334c95` (0/3 each) |
| (none) | 2 | "SKUs that moved the most units", `paraphrase_public_002` (1/3), `tpl_product_qty_top5_feb_2026_8a9dc1` (0/3) |
| `entity_resolution` | 1 | `hard_entity_clearspring_units_mar_2026` (0/3) |
| `entity_filter` | 1 | `tpl_net_sales_metro_online_store_q1_2026_87a58f` (0/3) |
| `grain_confusion` | 1 | `tpl_product_net_sales_top5_online_fulfillment_mar_2026_288feb` (1/3) |
| `distinct_count` | 1 | `tpl_category_distinct_customers_mar_2026_cd96b8` (0/3) |

By tag, 7 of the 13 are `ranking` cases and 4 are `accounting` (the four
ledger rankings); report.md's breakdown gives dev accuracy 70.8% for
`default_filter` (11 of 16 cases pass by majority), 79.4% for `accounting`
and 88.3% for `ranking`, against 94.0% overall. The ledger convention
behind 4 of the 5 `default_filter` failures (the cancel filter on ledger
postings, by document date) is the clearest single target for the next
product change; listing a group with no rows as a zero row
(`tpl_store_qty_mar_2026_651565`) is a separate, smaller one.

**Abstain / clarify: 0 of 10 dev cases handled**, as before: the model
answers every unanswerable or ambiguous question with SQL; the product has
no abstention or clarification channel.

### Reproduce

No LLM calls (the pilot and the full runs are the paid commands above):

```bash
# the low arm, the committed default baseline: rescored with 0 flips (the CI gate)
npm run eval -- --offline --gate
# the low arm vs the gpt-4o-mini reference over the paired dev cases (18 / 3, p = 0.001)
npm run eval -- --offline --compare eval/baselines/gpt-4o-mini.json
# the reference column
npm run eval -- --rescore eval/baselines/gpt-4o-mini.json
# prompt size (the same for every model)
npm run measure-prompt-cache -- --suite --split dev
```

## Decision

**Adopt `gpt-6-luna` at reasoning effort `low` as the default.** Both arms
qualify on every pre-registered rule:

| Rule | low | medium |
|---|---|---|
| 1. significant overall gain (exact McNemar p < 0.05, every paired answer case) | 74 / 8, p < 0.001: passes | 75 / 12, p < 0.001: passes |
| 2. holdout not significantly worse (`--holdout-summary`) | 56 / 5, p = 0.000, significantly better; 81.6% (reference 49.2%): passes | 56 / 5, p = 0.000, significantly better; 83.0%: passes |
| 3. cost per correct answer at most $0.0018 | $0.00027: passes | $0.00031: passes |
| 4. p95 question latency under 10 s | 5.73 s: passes | 6.36 s: passes |

Between the two qualifying arms the rule prefers the cheaper one (low:
$0.00027 per correct answer against $0.00031) unless the other is
significantly better than it; medium is not (3 improvements, 6 regressions,
exact McNemar p = 0.508). So low.

What changed: `DEFAULT_MODEL` is `gpt-6-luna` and `DEFAULT_REASONING_EFFORT`
is `low` (`src/model-config.js`). The default is the pair: with no effort set,
`gpt-6-luna` runs at `low` whether it is defaulted or named (`MODEL_NAME`,
`--model`), so a run of it with no effort set pairs with
`eval/baselines/gpt-6-luna.low.json` like the default run. OpenRouter's
`openai/gpt-6-luna` and a dated snapshot (`gpt-6-luna-2026-09-30`) run at
`low` too, but each looks up its own baseline file
(`openai__gpt-6-luna.low.json`, `gpt-6-luna-2026-09-30.low.json`; neither is
committed), so pass `--compare eval/baselines/gpt-6-luna.low.json` to pair
one with the default's. Any other model keeps its family's default (`medium`
for `gpt-6-sol`, none for `gpt-4o-mini`). The low arm's run is the committed
default baseline, which `npm run eval -- --offline --gate` (and the CI `db`
job) rescores with 0 flips.
`eval/baselines/gpt-4o-mini.json` stays, unchanged, as the reference of
experiments 1-3 (`MODEL_NAME=gpt-4o-mini` still runs it and pairs with it).
The next product work is in the remaining gaps above: the cancel filter on
ledger postings (4 of the 5 `default_filter` failures) and an abstain /
clarify channel.
