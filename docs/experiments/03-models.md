# Experiment 03: models (gpt-4o-mini → gpt-6-luna at low / medium reasoning effort)

**Variable:** the model and its reasoning effort (`MODEL_NAME` /
`REASONING_EFFORT`, or `--model` / `--reasoning-effort`), from `gpt-4o-mini`
(no reasoning) to `gpt-6-luna` at effort `low` and at effort `medium`.
**Status:** pre-registered — not yet run. Written before any paid call; the
decision rule below is fixed, the results sections are placeholders. Nothing
here is a measurement yet.
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

Not yet run. To fill in before the pilot: prompt size per question (unchanged
from the reference, same prompt version), and a dry run of both arms against
a local OpenAI-compatible stand-in to check the request bodies and the
headers (no paid call).

## Live results

Not yet run. Placeholders, one column per arm:

| Measure | gpt-4o-mini (reference) | gpt-6-luna low | gpt-6-luna medium |
|---|---|---|---|
| Git sha / prompt version | — | not yet run | not yet run |
| Strict accuracy (95% CI) | 73.6% | not yet run | not yet run |
| Dev / holdout accuracy | 88.3% / 49.2% | not yet run | not yet run |
| Paired table, McNemar p vs reference | — | not yet run | not yet run |
| Cost per question / per correct answer | — / $0.00060 | not yet run | not yet run |
| Completion tokens (reasoning) per call | — | not yet run | not yet run |
| `LLM_TRUNCATED` repetitions | — | not yet run | not yet run |
| Question latency p50 / p95 | 2.4 s / 4.4 s | not yet run | not yet run |

## Decision

Pending: the experiment has not been run.
