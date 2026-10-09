# Evaluation Dataset And Scoring

The canonical reference for what the evaluation suite contains, how it is
built and scored, and how to run it: the datasets and their splits, the
templated generator and the hand-written hard cases, behaviour (abstain /
clarify) cases, the multi-fixture oracle and its controls, the value-aware
comparison spec, `npm run eval` and its report, and the known limits.

| Asset | Path |
|---|---|
| Original benchmarks (dev) | `datasets/core-public.json` (9), `datasets/paraphrase-public.json` (9), `datasets/edge-cases-public.json` (17) |
| Templated benchmark | `datasets/templated-public.json` (189 cases, 94 intents), built by `scripts/build-eval-dataset.mjs` (`npm run build-eval-dataset`) |
| Hard cases | `datasets/hard-cases-public.json` (40 cases, hand-written) |
| Fresh holdout (v2) | `datasets/holdout-public.json` (149 cases, 77 intents, all holdout; authored blind 2026-10-06), built by `scripts/build-holdout-dataset.mjs` (`npm run build-holdout-dataset`), see [Fresh holdout (v2)](#fresh-holdout-v2) |
| Oracle controls (wrong and correct SQL per case) | `datasets/controls/*.json` |
| Value-aware comparator | `compareResultsDetailed` / `compareResults` in `src/benchmark.js` |
| Case schema (splits, behaviours, flags) | `normalizeBenchmarkCase` in `src/benchmark.js` |
| Multi-fixture oracle | `scoreAgainstGold` in `src/eval/oracle.js` |
| Evaluation fixtures (seed, v2, v3) | `src/eval/fixtures.js`, data in `src/eval/fixture-data.js` |
| Fixture seeding | `scripts/seed-fixtures.js` (`npm run seed-fixtures`) |
| Dataset verifier | `scripts/verify-dataset.js` (`npm run verify-dataset`) |
| Evaluation runner (one command) | `scripts/eval.js` (`npm run eval`), see [Running evaluations](#running-evaluations) |
| Per-case scoring through the product loop | `evaluateQuestion` in `scripts/evaluate.js` |
| Attribution, statistics, comparison, rescore | `src/eval/attribution.js`, `stats.js`, `compare.js`, `rescore.js` |
| Dataset hygiene tests | `test/dataset-hygiene.test.js` (with the id registry `test/fixtures/case-question-registry.json`), `test/gold-sql-validator.test.js`, `test/few-shot-leakage.test.js`, `test/holdout-manifest.test.js` |
| Holdout freeze | `datasets/holdout-manifest.json`, `scripts/holdout-manifest.js` (`npm run holdout-manifest`), `src/eval/holdout.js` |
| Edge-dataset generator | `scripts/build-edge-dataset.mjs` (the 9 core cases + 8 edge cases) |

These are synthetic regression fixtures over an owned demo schema, not a
substitute for early user feedback. In the original deployment, real users
surfaced bilingual terms, shorthand product names and compact temporal phrases
that a hand-authored benchmark would not contain until the system was put in
front of them. Treat production feedback as the source of new cases and
distill public-safe versions into these datasets. **Do not** add generated
traces, private database dumps, or customer/vendor-specific examples here.

## Dataset composition

The default suite is every `datasets/*.json` (the holdout manifest
`datasets/holdout-manifest.json` is not a dataset), de-duplicated (the edge
suite repeats the 9 core cases, which run once): **404 unique cases over 217
intents**: **dev, 255 cases over 140 intents** (the five datasets below the
fresh holdout; the 81 cases, 45 intents, that were holdout until the
Experiment 1 error analysis looked at them are dev now, tagged
`formerly_holdout`), and **holdout, 149 cases over 77 intents** (the
[fresh holdout (v2)](#fresh-holdout-v2), authored blind and frozen by the
manifest; see [Splits and the holdout policy](#splits-and-the-holdout-policy)).
The rest of this section describes the dev datasets unless it names the fresh
holdout.

| Split | Datasets | Cases | Intents | Answer cases | Behaviour cases | Known validator rejections |
|---|---|---|---|---|---|---|
| dev | the five datasets above `holdout-public` | 255 | 140 | 245 | 10 | 1 |
| holdout | `holdout-public` | 149 | 77 | 147 | 2 | 4 |
| **Suite** | | **404** | **217** | **392** | **12** | **5** |

| Dataset | Cases | Intents | Intents of its own | Formerly holdout intents (cases) | Behaviour cases | Known validator rejections | Cases with alternative gold |
|---|---|---|---|---|---|---|---|
| `core-public` | 9 | 9 | 9 | 0 | 0 | 0 | 2 |
| `paraphrase-public` | 9 | 9 | 0 (paraphrases of core) | 0 | 0 | 0 | 2 |
| `edge-cases-public` | 17 | 17 | 8 (+ the 9 core cases) | 0 | 0 | 0 | 3 |
| `templated-public` | 189 | 94 | 94 | 35 (70) | 0 | 1 | 36 |
| `hard-cases-public` | 40 | 37 | 29 (8 rephrase an existing intent) | 10 (11) | 10 (5 abstain, 5 clarify) | 0 | 8 |
| **Dev (unique)** | **255** | **140** | **140** | **45 (81)** | **10** | **1** | |
| `holdout-public` (fresh holdout v2, the holdout) | 149 | 77 | 77 | 0 (all 77 intents are holdout) | 2 | 4 | 28 |

The original three datasets hold 17 intents; the templated and hard-case
datasets add 123.

Strict accuracy counts the 245 answer cases (130 intents); the 10 behaviour
cases are reported separately (see [Behaviour cases](#behaviour-cases-abstain--clarify)).

By difficulty: 16 easy, 95 medium, 144 hard. By comparison mode: 77 scalar,
112 rowset, 56 ranked (and 10 behaviour cases without one). By
`failure_class` (the trap a case targets; see the
[failure taxonomy](#failure-taxonomy)):

| `failure_class` | Cases | | `failure_class` | Cases |
|---|---|---|---|---|
| `aggregation_shape` (series, pivots, counts) | 35 | | `entity_filter` | 16 |
| `time_window` | 20 | | `wrong_date_column` | 11 |
| `metric_column_confusion` | 20 | | `distinct_count` | 10 |
| `grain_confusion` | 18 | | `ratio_metric` | 8 |
| `default_filter` | 16 | | `stale_snapshot_field` | 5 |
| `wrong_join_path` | 9 | | `campaign_join_path` | 3 |
| `vocabulary` | 5 | | `multilingual` | 5 |
| `typo` | 4 | | `relative_date` | 5 |
| `entity_resolution` | 4 | | `empty_result` | 4 |
| `abstention` | 5 | | `clarification` | 5 |
| `ambiguous_metric` | 2 | | (none) | 45 |

Templated coverage (cases): windows: 89 single-month (every month from
November 2025 to May 2026), 68 quarter, 14 year, 14 explicit date range, 4
all-time; shapes: 39 ranked (top-N or full ranking), 58 grouped rowsets, 50
scalars, 26 month-by-month series, 4 side-by-side pivots.

Why this size: with the original 17 intents, an exact McNemar test needed at
least 6 unanimous case flips (about 35% of the suite) before a method change
could show as significant. With 245 answer cases (130 intents) the same 6
flips are 2.4% of the suite, and the intent-clustered interval is narrower.

## Splits and the holdout policy

Every case carries `split: 'dev' | 'holdout'` (a missing split reads as dev;
any other value is an error in `normalizeBenchmarkCase`, and verify-dataset
names every case with one). All phrasings of an intent share its split, and
one gold SQL belongs to one intent (so a holdout case is never a dev query in
other words).

- **dev**: everything the product may be tuned on: the original core,
  paraphrase and edge cases (the prompt rules, the few-shot pool and the
  semantic layer were tuned on their wording), the templated and hard-case
  intents, and the **formerly holdout** cases (tag `formerly_holdout`).
- **holdout**: the [fresh holdout (v2)](#fresh-holdout-v2),
  `datasets/holdout-public.json`, held out as a whole (every case `holdout`,
  by construction): 149 cases over 77 new intents, authored blind on
  2026-10-06 and frozen by the manifest (below). Until the
  measurement-hygiene change a hash rule put 45 of the 123 templated and
  hard-case intents (81 cases) in the holdout (`wasHoldoutIntent` in
  `scripts/build-eval-dataset.mjs`: the first 32 bits of `sha256(intentId)`,
  mod 100, below 42). The error analysis of the Experiment 1 failures read
  every failing case, holdout ones included, and some proposed fixes were
  designed from holdout failures (15 of the 18 "turnover" questions were
  holdout), so those cases could no longer estimate generalization: they are
  dev now, tagged `formerly_holdout` (`--tag formerly_holdout` selects them;
  report.md's tag breakdown shows them as a group).
- **Holdout wording** (enforced by `scripts/build-holdout-dataset.mjs` and by
  `test/dataset-hygiene.test.js` over every holdout case of every dataset): a
  holdout question contains no multi-word phrase of
  `metadata/semantic-layer.json` (entity, metric and filter-hint synonyms,
  value aliases, clarification triggers; whole words, plurals included), and
  none of the single-word metric synonyms the layer *enforces* (today only
  "revenue", the net-sales synonym a metric guardrail acts on; master-data
  names such as the "Sales Revenue" account aside). Holdout questions
  therefore say "turnover", "net takings", "net of tax" or "net amount" where
  dev questions say "net sales" or "net revenue". Single-word entity synonyms
  (customer, store, product, units, documents) and the advisory words
  ("sales", "sold") still match the layer: they are the only names of those
  things. The rule covers both `HINTS_VERSION` arms: the multi-word phrases
  the hints-v2 overlay (`metadata/semantic-layer.hints-v2.json`) adds are
  refused too. The fresh holdout was authored against the base layer and
  frozen before the overlay's vocabulary was checked against it: five of its
  questions contain overlay phrases ("open balance" in four, "unpaid balance"
  in one). They stay as frozen and are pinned, exactly, in
  `FROZEN_HINTS_V2_VOCABULARY` (any other match fails the build); for the
  version-2 arm those five cases do not measure unseen vocabulary.

**The holdout freeze.** `datasets/holdout-manifest.json` (not a dataset:
the suite, verify-dataset and the hygiene tests skip it) lists every holdout
case of every dataset with the fingerprints of its question, its gold
(`gold_fingerprint`), its scoring (`scoring_fingerprint`: gold,
alternatives and comparison spec; what a comparison pairs cases on), its
measurement (`measurement_fingerprint`: split, expected behaviour,
`known_validator_rejection`, expected tables, failure class, difficulty and
tags, the fields that move a failure between attribution buckets or report
breakdowns), its whole definition (`definition_fingerprint`: the suite's
own notion of one case definition, `caseDefinitionFingerprint`, which also
covers the row-count pins, signal checks, expected and disallowed columns and
the canonical question, with the gold and alternative SQL also compared
inside quoted literals, where `'A  B'` and `'A B'` are different values; only
the free-text `notes` is left out, since nothing reads it, and a hygiene test
fails on a dataset field that is in neither list) and its oracle controls
(`controls_fingerprint`: the negative and positive controls verify-dataset
applies to the case, found by id or intent as verification finds them, each
control's id, type, held-out and validator flags and SQL; a control's
free-text note is left out; `null` for a case without controls), its intent
and datasets, and a dated `history` of notes. The
manifest `fingerprint` covers every one of those fields, so every change the
check reports needs a note. `manifestVersion` is the fingerprint scheme (2
since the definition and controls fingerprints were added on 2026-10-07, a
change recorded with a note and no case or control changed); a manifest of
another scheme fails the check until it is rewritten with a note. The check
reads the controls of `<datasets-dir>/controls` (`--controls-dir` to point
elsewhere; none there means every controls fingerprint is `null`). `test/holdout-manifest.test.js` fails when a
holdout case is added, removed (or moved to dev) or changed without the
manifest being rewritten, when the manifest is edited by hand, and when its
current state has no note:

```bash
npm run holdout-manifest                                          # check (exit 1 on a difference)
npm run holdout-manifest -- --write --note "<what changed and why>"  # record the reviewed change
```

**Holdout policy.**

- Error analysis and experiment design use **dev failures only**. Nobody
  reads holdout questions, golds or per-case results to decide what to
  build or how to tune it.
- The holdout is looked at **in aggregate**: report.md and the console show
  holdout accuracy by split, never per case and never as flipped cases or
  flip counts (a comparison with a baseline covers the paired dev cases),
  unless `npm run eval` gets `--reveal-holdout` (for a deliberate,
  documented look, for example when retiring a holdout) or, for the paired
  holdout cases' counts and test in one aggregate line,
  `--holdout-summary` (below). `report.json` keeps
  every case for the rescore, the comparison and the gate, and `trace.jsonl`
  (printed on stdout with `--trace`) logs every case's events and the run's
  all-case statistics; opening either, or running with `--trace`, is
  revealing the holdout.
- While the holdout is hidden, these still cover every case, holdout
  included: the headline strict accuracy (a point estimate without an
  interval: the split accuracies weighted by their case counts), the budget
  row's spend, and **the exit code with its reasons** (a failed `--gate`
  tests every paired case, but when a holdout case is paired its reason
  gives no counts: every case's counts minus the dev ones shown would be
  the holdout's flips). The
  headline's intervals, the majority-pass cases, the intent-clustered
  accuracy, the holdout split row's majority passes, the legacy pooled rate,
  the count of answer cases left out of accuracy (no counted repetition),
  the count of cases a run stopped early did not finish, and the comparison
  (its paired table, accuracy change and interval, McNemar p, verdict and
  lists) are dev figures: two runs with the same holdout accuracy can differ
  in how its pass rates spread over cases and intents, in excluded, skipped
  and cancelled holdout repetitions, or in which holdout cases flipped, and
  those figures would show it. (The count of answer cases left out is a dev
  figure so that it agrees with the dev figures beside it; the number of
  holdout answer cases left out is not hidden: the holdout's case count,
  less its abstain / clarify cases and the cases its split row counts,
  gives it.) A comparison recorded without its paired
  cases cannot be recomputed over the dev cases: its own figures are shown
  when none of its holdout cases is paired (each is listed as new, not in
  the run, not counted or with a changed gold), and otherwise report.md and
  the console say that the dev-only comparison cannot be reconstructed from
  that recording and show no figure. The exit code can give a hidden holdout outcome away in edge
  cases: in the benchmark profile a run whose dev cases all pass exits 1
  when a holdout case failed, a holdout abstain / clarify case included
  (whose outcome report.md does not show; the reason does not itemize
  holdout cases), and an exit 2's harness reasons (gold, runner,
  infrastructure and provider errors, timeouts, aborted or cancelled
  repetitions) count every repetition. Both are kept on purpose: the
  benchmark gate fails on any failed case, and an exit 2 run is not a
  measurement and cannot become a baseline.
- **Concluding a pre-registered experiment: `--holdout-summary`.** The
  holdout's paired test is the out-of-sample evidence an experiment
  concludes with (Experiment 2: 17 improvements and 6 regressions over 147
  paired holdout cases, exact McNemar p = 0.035). With a comparison that
  pairs at least one holdout case, `npm run eval -- --holdout-summary` adds
  **one line** to report.md's comparison section and to the console's
  comparison: the number of paired holdout cases, their improvements and
  regressions, the exact McNemar p with the usual verdict wording, and
  strict accuracy on those cases, baseline → candidate, with the change and
  its paired bootstrap 95% CI ("Holdout in aggregate (`--holdout-summary`):
  147 paired holdout case(s); 17 improvement(s), 6 regression(s); exact
  McNemar p = 0.035 → significantly better than the baseline; strict
  accuracy … → …, Δ … (95% CI …)"). The figures come from `summarizePairs`
  over the comparison's paired holdout cases with the comparison's alpha and
  bootstrap settings: the number of cases, the improvements and
  regressions, p and the verdict are exactly those of the holdout cases in
  the full comparison `--reveal-holdout` lists, and so are the accuracies
  and the change up to the order of a floating-point sum (at a rounding tie,
  one unit in the last printed digit; with one repetition they are exact).
  The pairs are taken in a canonical order of their outcomes instead of by
  id, so every figure on the line, the bootstrap interval included, depends
  only on the paired outcomes, never on which cases they are (the interval
  is a paired bootstrap like the dev one, not the same draw as one over the
  holdout cases in id order). Nothing else about the holdout is shown: no
  ids, no per-case verdicts, no attribution, behaviour, guardrail or cost
  figures, no pass-rate changes. Without a comparison, or when no holdout
  case is paired, it prints nothing extra; without the flag nothing changes. `--gate` decides the same either
  way; a gate that fails while a holdout case is paired still gives no
  counts in its reason, which with the flag points at the line too. Use it
  **only to conclude a pre-registered experiment** (hypothesis, arms and
  decision rule written down before the paid run, see
  [docs/experiments/README.md](experiments/README.md)), never while
  designing or tuning a change: a holdout figure read between iterations
  becomes a target. Error analysis stays dev-only. Pass it on the concluding
  run, or afterwards, with zero LLM calls, on a rescore of that run against
  the same baseline under the candidate arm's setting
  (`<SETTING>=<candidate value> npm run eval -- --rescore <its report.json>
  --compare <baseline report.json> --holdout-summary`): a rescore re-judges
  the recorded SQL with today's code and today's settings, so without the
  arm's setting it re-runs the validator's decisions under another arm. The
  rescore must print no "note: the recording ran with schema scope …" or
  "… hints version …" line (report.md's Provenance then shows a "Recorded
  schema scope" or "Recorded hints version" row); if it does, its line is
  not the run's paired holdout test and must not conclude the experiment.
  With the right setting and nothing else changed since, it gives the run's
  verdicts. With `--reveal-holdout` (which lists every case and gives the
  all-case comparison) the same line is printed too: it is the holdout
  subset's own test, which the all-case comparison does not give.
- **Any change to the holdout** (a case added, removed, reworded, re-scored,
  re-labelled, for example a `known_validator_rejection` flag, or moved to
  dev) requires a manifest update with a note saying what and
  why; the manifest diff is the reviewable record.
- A holdout that has been inspected is retired to dev with a tag (as the
  first one was, `formerly_holdout`), and a new one is authored blind.

Limit: a holdout whose wording avoids the semantic layer mixes two effects,
unseen intents and unseen vocabulary, so a dev / holdout gap does not say
which one hurts.

Run one split with `npm run eval -- --split dev` (or `holdout`; with no
holdout case that would be an empty selection, exit 2), or the fresh holdout
alone with `--dataset holdout-public`; report.md breaks every run down by
split, the holdout in aggregate.

## The templated generator

`scripts/build-eval-dataset.mjs` writes `datasets/templated-public.json` and
`datasets/controls/templated-public.json`; `npm run build-eval-dataset --
--check` fails when the committed files differ from what it would write, and
`test/dataset-hygiene.test.js` checks it reproduces them byte for byte.

**Intents.** Each of the 94 entries of `INTENTS` composes:

| Part | Values |
|---|---|
| Metric | document net sales (`NetAmount`), line net sales (product, brand, category, campaign breakdowns), gross amount, quantity (product units), document count, distinct buying customers (`COUNT(DISTINCT CustomerId)`), average order value (header `AVG`), outstanding balance (`BalanceAmount`), paid amount, ledger debit / credit / net movement / posting count |
| Dimensions | customer, store location, document type, product, brand, product category, campaign, ledger account, month (one or two per intent) |
| Window | every single month from November 2025 to May 2026 (including months only v3 has much data for), Q1 2025, Q4 2025, Q1 2026, explicit ranges (15 Feb - 15 Mar, 1-10 Mar, Nov 2025 - Feb 2026), 2025, 2026, all time |
| Filters | a store, brand, category, campaign, customer, product or document type, by name with `LIKE '%...%'`; a ledger account by code; manual journals |
| Shape | top-N with a `LIMIT` that binds on v3 (`ranked`), full ranking (`ranked`), grouped rowset (`rowset`), scalar, month-by-month series, two windows side by side (pivot), plus a few one-off templates (active customers without sales, customers lost between months, last purchase date, largest document, canceled documents) |

**Gold SQL** comes from small builders, never typed by hand, and follows the
repo's conventions: `IFNULL(d.IsCanceled, 0) = 0`, half-open date ranges,
`COALESCE` inside aggregates, `ROUND(..., 2)` for money and `ROUND(..., 3)`
for quantity, line-level amounts for product / brand / category / campaign
breakdowns, never a header amount summed over a line join, units counted on
product lines only (a unit total without a product dimension adds
`l.ProductId IS NOT NULL`: the delivery-fee lines are not units sold), a
manual-journal or one-account ledger question as one total, ledger questions
either by the sales document's date (the core cases' convention) or, when the
question says so, by `AccountingPosting.PostingDate`.

**Comparison blocks** follow the [comparison spec](#comparison-spec-value-aware-scoring):
ranked for top-N and rankings (`value_columns` = the metric), rowset for
breakdowns and series, scalar for totals; `tolerance: 0.01` for line money and
averages (rounding placement can differ by a cent); `null_as_zero` (and the
`empty_as_zero` relaxation) for scalar sums over a window some fixture has no
rows in; `column_order` and `null_as_zero` for pivots (and, for a pivot by
customer, the `ignore_all_zero_rows` relaxation); ledger rowsets compare the account name and the amounts (the code
may be left out; an answer with codes only fails, so those questions ask for
the account names). **Alternative gold** where a second reading or output form
is equally correct: a month labelled `'YYYY-MM-01'`, by number, by name (one
calendar year only), as `'Jan 2026'` or `'January 2026'` as well as
`'YYYY-MM'`; postings of canceled documents left out of a posting-date ledger
question; every customer (LEFT JOIN, 0 where none) in a customer pivot; every
customer, with no date for one that never bought, for "each customer's last
purchase". Each is explained in the case's `notes`.

**Wording** is curated, not generated: 2-3 phrasings per intent that a
retail or distribution manager would type ("Which 3 clients spent the most
with us in December 2025, measured by net amount?", "How many units left each
of our locations in March 2026?", "Put total net takings for March 2025 next to
March 2026 in one row."). A phrasing that a careful analyst could read two
ways is reworded rather than silently resolved by the gold ("each category and
store combination that had sales", "the customers who bought in November",
"all document types included", "have a posting date in February"). The
generator writes dev cases only; the intents the retired hash rule held out
keep their holdout-style wording ("turnover", "net takings") and the tag
`formerly_holdout`.

**Ids** are `tpl_<intentId>_<first 6 hex of sha256(question)>`: editing a
question gives a new id, so an id is never reused for a different question
(comparisons pair cases by id).

**Pins.** `expected_row_counts` are carried over from the committed file while
a case's id and gold are unchanged. After adding or changing an intent, run
the generator, then `npm run verify-dataset -- --dataset templated-public
--write-pins` on freshly seeded fixtures, then the generator again (it keeps
the pins; `--check` passes).

**Controls.** Every intent gets negative controls from the mutation families
that apply to its template (745 design controls in all), built by the same
builders with one knob changed:

| Family (`type`) | Mutation |
|---|---|
| `cancel` | the cancel filter dropped (inverted or dropped for canceled-document intents; applied to one month only in a two-month comparison) |
| `date_col` | `PostingDate` for `DocumentDate` (or the other way round; `DueDate` intents get `DocumentDate`) |
| `date_boundary` | both off-by-one sides: the first day of the window excluded, and the day after included (`<=` the end date, as `BETWEEN` with the next month's first day does) |
| `date_filter` | `MONTH(...) = m` without the year |
| `metric` | net / gross, outstanding / payable, paid / outstanding, line Net / TotalAmount, debit / credit swapped, debits minus credits for a one-account or manual-journal total |
| `grain` | a header amount (or row) repeated for every line; line net summed for a document metric; the document amount summed per product |
| `count` | `COUNT(*)` for a distinct count or a quantity; `COUNT(DISTINCT CustomerName)` (merges the two Summit Grocers); a forgotten `DISTINCT` that counts documents instead of customers |
| `sum_distinct` | `SUM(DISTINCT ...)` |
| `group_by` | grouped by the customer name only (merges the two Summit Grocers); the second key of a two-key breakdown dropped from `GROUP BY` (its name still selected); the month dropped from a series' `GROUP BY` |
| `order_limit` | ascending order; the `LIMIT` dropped |
| `filter` | a named filter dropped; the delivery-fee lines counted as units |
| `stale_snapshot` | grouped by `BrandNameSnapshot` / `CategoryNameSnapshot` |
| `join_path` | brand through `ProductBrand`, category through the brand, campaign through the document header |
| `join_type` | an inner join to `SalesDocument` that drops manual journals |
| `shape` | the two pivot columns swapped |

A family that cannot change an intent's answer, or that no fixture can
separate without breaking another designed property, is not emitted, and the
controls file says why under `not_emitted` (`NOT_EMITTED` and the template
rules in the generator):

- equivalent here: grouping by a unique name (product, brand, category,
  campaign, store and document type names are unique: 31 intents);
  `COUNT(DISTINCT SalesDocumentId)` for a document count (9); the cancel filter
  on posting-date ledger questions, where both readings are accepted (4); for
  the manual-journal total, the cancel filter, the document date and the inner
  join to `SalesDocument` (manual journals have no sales document) and the
  debit / credit swap (every journal balances); `COUNT(*)` over the lost
  customers' `SELECT DISTINCT` set;
- fixture limits (9): the day after a window that ends on 2026-06-01 (June 2026
  must stay empty for the zero-row case) or on 2027-01-01 (no fixture has data
  after May 2026); the day after February for Household (v2 cannot sell a tenth
  product in March 2026, and v3's March totals hold its tie and top-10 cut-off);
  the first day of Q1 for "active customers without sales"; and the
  merged-by-name count of customers lost between February and March (both
  Summit Grocers buy in March on v2 and v3).

**Held-out controls** (`h*`, `heldout: true`, 117): families the fixtures were
deliberately *not* extended against, so their kill rate estimates how the
oracle does on a mistake nobody designed a row for: a filter on a line
snapshot (`ProductNameSnapshot` / `BrandNameSnapshot` / `CategoryNameSnapshot
LIKE`) instead of the master data, grouping by `ProductNameSnapshot`,
`QUARTER()` without `YEAR()`, the cancel filter written as `HAVING
MAX(IsCanceled) = 0`, and a ranking ordered by another amount than the one it
shows. They are reported, not gated (see
[Oracle controls](#oracle-controls-and-kill-rate)).

Positive controls (29) rewrite the gold of every third intent as a CTE, a
derived table, or with another alias and no `COALESCE` inside `SUM`.

## Fresh holdout (v2)

**Provenance.** `datasets/holdout-public.json` was authored blind on
2026-10-06 and is frozen. Its author saw the schema (`models/`), the master
data (`src/eval/fixture-data.js`), the case format and the existing datasets
(to avoid their intents), and the semantic layer and the few-shot pool only to
keep their vocabulary and examples out; no model output, failure analysis, run
report or baseline was looked at, and nothing in the product (prompt rules,
few-shot pool, semantic layer) has been tuned on it. Keep it that way:
never tune on its wording or its failures, and do not edit a question or a gold
to chase a score (an edited question gets a new id). When it has been looked
at, retire it to dev and add a new holdout instead. Its golds were audited
before any model answer to it was looked at (below), and the [current
baseline](#current-baseline) measures it, read in aggregate only (49.2% on
its 147 answer cases under hints version 2; the version-1 baseline before
it, 41.3%).

It was authored on a branch where the inspected hash-split holdout was still
`holdout`, and integrated onto the measurement-hygiene change afterwards: the
fresh set is now the only holdout, recorded in `datasets/holdout-manifest.json`
on 2026-10-06. Two exposures happened during authoring, both of existing cases
or of the product, not of model answers to the fresh questions: after the set
was frozen, the required `npm run eval -- --offline` printed the committed
baseline's per-case outcomes for existing (now dev) cases. Separately, a first
test run listed which fresh golds the validator would reject under the
retrieved schema scope; the only
question edits after that kept two questions under the few-shot similarity
limit. Its golds predate the [gold conventions](#gold-conventions) write-up
and its two opt-in scoring relaxations: no fresh case sets
`ignore_all_zero_rows` or `empty_as_zero` (28 set `null_as_zero`, 14 of them
scalar), so on those questions the holdout scores a little more strictly
than dev does. A sampled review found one more such strictness: a "for each
month from ... to ..." question whose gold lists only the months with sales,
so a calendar-spine answer that also lists an empty month with 0 / NULL fails
on the fixture where that month is empty, although the [breakdown
convention](#gold-conventions) accepts a zero row where the question says "for
each". These are recorded, not fixed: changing a holdout gold or its scoring
needs a dated manifest note (`npm run holdout-manifest -- --write --note
...`), and the decision is the maintainer's, made without looking at holdout
results.

**Gold audit.** On 2026-10-06 the golds were audited before any model
answer to the fresh questions was looked at. Each of the 147 answer cases
was given to two annotators who worked independently (294 annotations). Each
annotator wrote their own SQL from the question, the schema and the master
data, scored it against the gold with the oracle (`scoreAgainstGold`) on all
three fixtures, and checked the gold against the [gold
conventions](#gold-conventions). Where the annotators disagreed with the gold
or with each other, an adjudicator re-ran both readings with the oracle, the
case's controls and the production validator. No model output, run report or
baseline was opened, and no LLM was called. Of the disputed cases, 9 were
adjudicated to a change, and the change was applied to every phrasing of the
intent, so 10 cases over 6 intents changed. None was dropped:

- **1 gold fix (2 cases).** "Largest open items" now lists only documents
  with an unpaid balance (`d.BalanceAmount > 0`, as in the ageing and overdue
  golds). On seed it returns 3 rows; it used to fill the top 5 with paid
  documents at 0.00.
- **3 every-member alternatives (6 cases).** The store March/April pivot,
  "for each customer ... paid and still open" (which also gets `null_as_zero`
  on both amounts) and the category H1/H2 pivot accept the `LEFT JOIN`
  listing of every member with 0, as the dev pivots do.
- **2 rewordings (2 cases, new ids).** "Documents raised in the 7 days ..."
  became "How many documents were raised ...", because the case is scalar.
  "Each campaign ... through each outlet" now names "the campaign and outlet
  combinations that had sales", the rewording the templated generator uses
  for the same two-dimension ambiguity.

The seed pin of the open-items intent moved from 5 to 3. The pins were
rewritten on freshly seeded fixtures, and the controls still kill every
design negative and pass every positive (779/779 and 23/23). The change is
recorded in `datasets/holdout-manifest.json`. The counts in this section
are after the audit.

**How it was built.** `scripts/build-holdout-dataset.mjs` (`npm run
build-holdout-dataset`, `-- --check` for drift; the hygiene tests check it
reproduces both files byte for byte) writes the dataset and
`datasets/controls/holdout-public.json` from 77 hand-written intents
(75 answer intents and 2 abstain cases), each with 1-3 phrasings: 149 cases,
147 of them answer cases. Every case is `split: 'holdout'` by construction
(the whole set is held out; no intent hash applies) and carries the
tag `holdout_v2`. Ids are `ho2_<intentId>_<first 6 hex of sha256(question)>`.
Questions follow the holdout wording rule above (the build fails on a
semantic-layer phrase or "revenue"); gold SQL follows the conventions of the
templated generator, and `expected_row_counts` were written with
`verify-dataset --write-pins` on freshly seeded fixtures. No fixture was
changed for it.

| Intent category | Intents | Examples |
|---|---|---|
| New shapes in holdout wording (`standard`, `new_dimension`, `ratio`, `finance`) | 35 | turnover by customer segment; each store's share of Q1 turnover; void rate by store; collection rate; average payment terms and posting lag; trial balance as at a date; running total, month-over-month change, weekday totals, value bands; new customers by first purchase month |
| Named entities (`named_entity`) | 16 | Valley Corner Shop, customer code C-004, Lakeside Wholesale (days between purchase dates), Dormant Demo Account, Spring Essentials, Northstar Goods split by category, Lime Seltzer 8 Pack, the Sales Revenue account |
| Ranking with explicit tie-breaks (`ranking_ties`) | 7 | best seller per category (alphabetical on ties), top customer per store, busiest day (earliest on ties), runner-up store (`LIMIT 1 OFFSET 1`), largest open items |
| Unfamiliar vocabulary (`new_vocabulary`) | 6 | "voided", "AR ageing", "delisted", "range breadth", "credit notes", "lines that carry no product" |
| Relative dates with an as-of date (`relative_date`) | 5 | overdue as of 2026-04-15, past-due by customer, due through month end, last Monday-to-Sunday week, the last 7 days |
| Two readings accepted (`ambiguous`) | 5 | "how many products" (distinct or units), "average basket" (value or units), lapsed for 60 days (boundary), year to date (with or without today), average unit price (plain or weighted) |
| Swedish (`multilingual`) | 1 | "Hur mycket moms bokfördes i mars 2026?" |
| Abstain (`unanswerable`) | 2 | stock on hand, a salesperson |

Across the cases: 6 Swedish and 2 bilingual phrasings, 7 typo or shorthand
ones, 19 with an explicit as-of date, 34 with alternative gold, 10 ranked, 32
scalar and 105 rowset comparisons. Four cases are known validator rejections
(`METRIC_COLUMN`): "credit notes" makes the credit-amount guardrail demand
`AccountingPosting.CreditAmount` on a document question, and the "Sales
Revenue" account name trips the net-sales guardrail (the same gap as
`tpl_revenue_credits_monthly_q1_2026`).

**Controls.** 398 design negatives (the generator's mutation families: cancel
filter, `PostingDate`, both off-by-one sides, `MONTH()` without `YEAR()`,
another amount column, a header amount per line, `SUM(DISTINCT ...)`, the
duplicate customer name merged, dropped filters and `GROUP BY` keys, join paths
and snapshots, order and `LIMIT`), 37 held-out negatives (`h*`: `QUARTER()`
without `YEAR()`, snapshot filters, and mistakes specific to the new shapes: a
ratio's denominator, LAG before or after the window, an ageing bucket edge,
band edges) and 11 positive rewrites. On the frozen fixtures the first pass
killed 87.2% of the design negatives (737/845, counted per case). The
survivors were triaged the way the generator's are, except that no fixture row
could be added: eight questions moved to a window or threshold the fixtures
separate (C-004 in January, the month-end due window, last week as of 8 April,
the last 7 days as of 7 April, customers above 2,600, repeat customers and the
two-brand customers in March, Metro Online Store in Q1), and 40 survivors are
recorded under `not_emitted` (38 fixture limits, each naming what no fixture
has, and 2 equivalences), next to 15 declared up front (14 windows ending on
2027-01-01, after the fixtures' last data, and one equivalence). Final design
kill rate 100% (779/779 per case), held-out 86.5% (64/74), positives 23/23
(every one passes the validator). The held-out survivors are the snapshot
filters on Long Grain Rice 5kg and Herbal Tea Variety Pack (their snapshots
contain the master name), the reversed tie-break of the per-category best
seller (no category ties in March 2026), the brand snapshot of the two-brand
customers and the inner join of the price agreements (every agreement has 2026
sales).

## Hard cases

`datasets/hard-cases-public.json` holds 40 hand-written cases, each verified
on every fixture:

| Category (tag) | Cases | Examples |
|---|---|---|
| New vocabulary (`new_vocabulary`) | 5 | "Which outlet had the highest turnover in March 2026?", "How much do our debtors still owe us for sales made in Q1 2026?", "How many distinct shoppers made a purchase in April 2026?" |
| Swedish / bilingual (`swedish` 4, `bilingual` 1) | 5 | "Visa de största kunderna efter nettoförsäljning i mars 2026." (core_public_001), "Vilka är de tio produkter som sålde flest enheter i mars 2026?" (core_public_002, with the ten its LIMIT needs), "Visa net sales per varumärke för March 2026, störst först." |
| Typos and shorthand (`typo`) | 4 | "top custmers by net sales in Mrach 2026", "AR bal by store mar 2026", "rev by brnd Q1 26" |
| Relative dates with an as-of date (`relative_date`) | 5 | "As of 2026-04-01, what were last month's net sales?", "Today is 15 February 2026. How many sales documents have we recorded this month so far?" |
| Named entities beyond products (`named_entity`) | 5 | customers, campaigns, brands and the Sales Revenue account by name; "List the March 2026 net takings of each customer named Summit Grocers, with their customer codes." (two customers share that name) |
| Zero-row answers (`zero_row`) | 4 | June 2026 by customer (empty everywhere), 2023 total (one NULL row), Harbor Kiosk's March purchases (empty), its credit notes (0) |
| Unanswerable (`unanswerable`, abstain) | 5 | employee headcount, the weather, a forecast, competitor prices, a satisfaction score |
| Ambiguous (`ambiguous`) | 7 | clarify: "Who is our best customer?", "How much did Summit Grocers buy in March 2026?" (two customers share the name); two readings accepted: "What were sales in March 2026?" (net or gross), "How many orders did we get in March 2026?" (all documents or Online Orders) |

Cases that rephrase an existing intent (the Swedish, bilingual and most typo
cases, three as-of or shorthand versions of templated intents, and the
ambiguous "sales" question, whose net-sales gold is the as-of case's) reuse
that intent's gold, comparison and split, so their controls resolve by intent.
Hand-written ids are bound to their question by
`test/fixtures/case-question-registry.json`: a new question gets a new id.

57 hand-written negative controls, 5 held-out ones (`xh*`) and 2 positives for
20 cases (in `datasets/controls/hard-cases-public.json`) cover the new answer
intents where a plausible mistake exists: the relative date read as the
current month, the duplicate name merged, a dropped cancel filter or
`PostingDate` for the per-code Summit Grocers totals, the brand snapshot for
Clearspring Waters, and for the zero-row cases the mistakes that do return
rows on a fixture (`MONTH()` without `YEAR()`, `PostingDate`, a dropped cancel
filter, every year instead of 2026).

**Zero-row answers and the comparator.** Two empty results always match,
whatever their columns. A SUM over no rows is one row holding NULL, which
does not equal 0 unless the column is listed in `null_as_zero` (the zero-row
and windowed scalar cases list it). An empty result does not equal one NULL
row unless the case opts into the `empty_as_zero` relaxation (every scalar
sum does, see [Scoring relaxations](#scoring-relaxations)); the 2023 case
also keeps its older alternative with `HAVING COUNT(*) > 0`.
`test/eval-behavior.test.js` and `test/comparison-relaxations.test.js` pin
these rules. What it means for
scoring: an empty gold only tests that the product does not invent rows in an
empty window. Any query that returns nothing (or 0 / NULL for a scalar)
passes, a wrong metric or a document count included (the held-out `xh*`
controls of the 2023 and June cases are such survivors); the design controls
are the plausible mistakes that do return rows on some fixture.

## Gold conventions

Every gold encodes choices a careful analyst could make differently. They
are written down here (and, where a case depends on one, in its `notes`) so
that a failure on a convention is visible as such, and so that no experiment
is credited with a convention it happened to change. They were reviewed
after the error analysis of the Experiment 1 failures: the golds were kept,
one alternative reading was added (`hard_entity_lakeside_spend_q1_2026`,
below; the committed baseline answered it with the bill total, so a rescore
passes it: a gold decision, not a model gain), and where the analysis found another reading defensible but the
gold stays, the reason is given.

| Convention | Rule | Other reading, and the decision |
|---|---|---|
| Sales amounts | Sales, revenue, turnover, takings, spend and order value are net of tax: header `SalesDocument.NetAmount`, or line `SalesDocumentLine.NetAmount` (next row). `GrossAmount` only when the question says gross or including tax, or as an accepted reading of an ambiguous word ("sales", "spend"). | **"Spend"** (`hard_entity_lakeside_spend_q1_2026`): net (gold), gross and, since the analysis, the billed total `BillTotalAmount` (what the customer was billed) are accepted: the case already accepted gross, so rejecting the bill total was arbitrary. The billed total is not accepted elsewhere. **Average order value** (`tpl_*average_order_value*`): the average header `NetAmount` per non-canceled document; a bill-total average is not accepted (the usual definition of order value excludes tax and charges, and the analysis judged the gold reasonable). |
| Header vs line grain | Header amounts for document-level dimensions and filters (customer, store, document type, month); line amounts whenever a product, brand, category or campaign is a dimension or filter, also next to a document-level dimension (customer × brand); never a header amount summed over a line join. | None defensible: a header amount over a line join counts a document once per line, and a header amount for a product slice includes the document's other products. `tpl_customer_net_sales_sales_invoices_mar_2026_*` (a document-type filter) is header grain; `tpl_weekend_pantry_net_sales_monthly_q1_2026_*` (a campaign filter) is line grain. |
| Campaign attribution | A sale belongs to the campaign of the product sold: `Product.CampaignId`, on line amounts. `SalesDocument.CampaignId` is the campaign a whole document was entered under (an order-level tag) and is not used for sales attribution. | The document campaign is a declared foreign key ("Optional campaign directly associated with this document"), so the analysis found it defensible on its face (`tpl_campaign_net_sales_q1_2026_*`, `edge_public_002`, `tpl_weekend_pantry_*`). Kept as the gold anyway: the product itself tells the model to attribute through the product (the prompt rule "For campaign-filtered product sales, join SalesDocumentLine to Product and Product to Campaign", the semantic layer's only campaign join path `product_to_campaign`, "campaign sales" as a line-level metric), the two readings differ on every fixture, and accepting both would drop the `campaign_join_path` trap. The ambiguous metadata comment is a product defect to fix in the product (metadata or semantic layer), not in the dataset. |
| Brand | `Product.BrandId`, the product's current brand. | `ProductBrand` is a partial bridge (4 of the 13 products), so a brand total through it leaves products out: not an alternative. |
| Canceled documents | Every question that selects sales documents leaves canceled ones out (`IFNULL(d.IsCanceled, 0) = 0`) unless it asks for them, also when `SalesDocument` is joined only for its date (ledger questions by document date) and inside an anti-join (customers or products without sales). | **Ledger questions by the posting date** select postings by their own date: there the postings of canceled documents may be kept (the gold, with manual journals) or left out (alternative). **Ledger questions by the document date** (`core_public_005` / `009`, their paraphrases, `tpl_account_net_movement_feb_2026_*`, `tpl_account_debit_credit_q1_2026_*`) select postings through their sales document and keep the filter: the product's own rule says to exclude canceled documents whenever it queries `SalesDocument`, and accepting the unfiltered answer would pass four failing cases by relaxing the gold. |
| Units | Units are product units: product lines only (`l.ProductId IS NOT NULL`, or a join to `Product`); the delivery-fee lines (NULL `ProductId`, quantity 1) are service charges, not units sold. | Counting the fee lines is not a defensible answer to a units question. The analysis is right that the product does not tell the model (the `quantity_sold` metric has no default filter); that is a product gap for a semantic-layer change to close, not a reason to accept fee lines. |
| Breakdowns and zero rows | A breakdown lists the members with activity in the window. Listing every member with 0 is accepted where the question invites it (alternatives: "for each customer", a pivot, "each customer named ...", an empty window). A customer pivot also accepts any extra customers with 0 everywhere, and a scalar sum an empty result for an empty window ([scoring relaxations](#scoring-relaxations)). | See [Pins and alternative gold](#pins-and-alternative-gold). |
| Top N and rankings | "Top N", "the N biggest": `LIMIT N` after a deterministic tiebreak (items tied at the cut-off are interchangeable, see the oracle rules). "Top" without a number (`core_public_002` / `008` and their paraphrases): the product's own rule, `LIMIT 10`. "Rank", "order every ... highest first", "from highest to lowest" without a number: every member, no `LIMIT`. A singular superlative ("which outlet had the highest ..."): `LIMIT 1`. | A `LIMIT 10` on "Rank products by turnover" (`tpl_product_net_sales_rank_dec_2025_*`) cuts v3's 13 products: the question asks for the ranking, not a top 10. The prompt rule that says `LIMIT 10` for "top", "biggest" and "most" does not mention rankings. |
| Dates | `DocumentDate` unless the question says posted / posting date (`SalesDocument.PostingDate` for documents, `AccountingPosting.PostingDate` for postings) or due date (`DueDate`); half-open ranges; a quarter, a "January–March" range or "1 to 10 March, inclusive" means every day in it. | Kept; the temporal failures the analysis found are product defects (a range resolved as one month, an as-of date ignored), not readings. |
| Document types | Every document type is a sale, Credit Memos included (they carry positive amounts in this schema). | A reading that leaves Credit Memos out fails; see [Known limits](#known-limits). |

## Behaviour cases (abstain / clarify)

A case with `expected_behavior: 'abstain'` (the data cannot answer it) or
`'clarify'` (it is ambiguous; a correct product asks) has no gold SQL, and may
not carry one (`expected_sql`, alternatives, a comparison or pins are errors).
The default, `'answer'`, is every other case.

- **Run**: no gold runs before the product loop and nothing is scored after
  it; executed SQL is status `answered`.
- **Attribution**: SQL in any attempt is `answered_instead_of_abstain` /
  `answered_instead_of_clarify` (model bucket; tagged `not_executed` when the
  SQL was rejected or failed). No SQL in any attempt, because the model sent
  an empty query (`EMPTY_SQL`) or refused (`LLM_REFUSED`), is `declined`:
  handled correctly. Outages, timeouts and budget skips keep their usual
  outcomes and do not count for the behaviour score. Any SQL counts as not
  clarifying, even SQL that hedges well: a per-customer breakdown for "How much
  did Summit Grocers buy in March 2026?" is `answered_instead_of_clarify` (that
  reading is scored by the answer case
  `hard_entity_summit_grocers_by_code_mar_2026`, which asks for each namesake).
- **Report**: never in strict accuracy, the legacy totals, the attribution
  tables, the guardrail matrix or the paired comparison; `report.json`'s
  `behavior` block and report.md's "Behaviour cases: abstain/clarify — N
  cases, M handled correctly" section report them. A case is handled when it
  declined in more than half of its counted repetitions.
- **verify-dataset** runs nothing for them (no gold, no pins, no controls); a
  rescore keeps them as recorded. **evaluate-retrieval** leaves them out of
  the recall numbers (no expected tables) and lists them under
  `behavior_cases` with the tables retrieval would offer.

**Why the product fails them today.** The product has no abstention or
clarification channel: the response schema has no field for "cannot answer"
or for a question back, retrieval falls back to some tables for any question
(nonsense included), and the prompt asks for SQL. So every behaviour case is
expected to be `answered_instead_of_*` until that changes (audit finding D5).
They are in the suite to measure that gap and to score the fix when it comes;
keeping them out of strict accuracy stops them from hiding answer-quality
changes.

## Known validator rejections

`known_validator_rejection: '<code>'` marks a case whose correct answers the
production validator rejects today, in the default product configuration or
in another supported arm of an A/B switch, a product gap the suite measures
instead of hiding. Five cases are flagged: one dev case, `METRIC_COLUMN`
(`tpl_revenue_credits_monthly_q1_2026_e1b20a`: the account name "Sales
Revenue" trips the net-sales metric guardrail on a ledger question), and four
holdout cases, counted here and not named (the holdout is looked at in
aggregate only). Every flag was measured with hints version 1's prompts.
Hints version 2 (`HINTS_VERSION`, the default) closes the dev case's gap; the
flag stays because version 1, the A/B control arm, still has it
([docs/experiments/02-hints-v2.md](experiments/02-hints-v2.md)). A holdout
flag version 2 closes stays for the same reason (the frozen holdout is not
edited); which holdout flags version 2 closes is not listed here.

- verify-dataset reports a rejection of the gold, an alternative or a positive
  control with that code as a note, and fails when the validator accepts every
  gold variant under every supported hints version (the flag is stale and must
  go). When only the configured version accepts it and another supported one
  still rejects with that code, that is a note naming the version that keeps
  the flag, so both arms of the `HINTS_VERSION` A/B verify;
  `test/gold-sql-validator.test.js` and `test/dataset-hygiene.test.js` check
  the same offline (every flag under version 1; under version 2 the dev
  flag's closure, and for a holdout flag only that version 2 rejects its gold
  variants with the flag's code or not at all). The in-process
  verification of `npm run eval` only warns about a stale flag (in the console
  and report.md's Verification section), so a product change that closes the
  gap can be measured, live or with `--offline --gate`, before the dataset is
  updated; the dataset change then follows in the same pull request.
- In a run the case counts in strict accuracy like any other, and **the
  flagged rejection is a system error**: a repetition of a flagged case whose
  final attempt the validator rejected (guardrail or safety layer) with the
  flagged code is tagged `known_validator_rejection` and moved to the system
  bucket, because no model can get an answer to that question past the
  validator (`report.json`'s `attribution.system.knownValidatorRejections`,
  the Attribution section of report.md and the console headline count them).
  The flag describes the validator rejecting the correct gold, not every
  possible answer: any other failure of a flagged case (a wrong result, an
  execution error, a rejection with a different code such as `FAN_OUT`) is
  attributed as for any other case, normally to the model. A correct answer
  the validator throws away is, as for any case,
  `guardrail_false_rejection`.

**Retrieval misses and the schema scope.** Validation follows the product
configuration (`SCHEMA_SCOPE`, see the README). Until the schema scope existed
the retrieved tables were the allow-list, and 33 more cases were flagged
`TABLE_SCOPE`: retrieval did not pick a table the answer needs (a named store,
brand, campaign, product or customer; Swedish; typos; "units"; new vocabulary
such as "turnover" or "net takings"), which capped accuracy at 86.5% even with
perfect SQL. The default scope (`auto`, full at 13 tables) allows every
in-scope table, so those flags were stale and are gone (the ceiling is now
99.6%). Under `SCHEMA_SCOPE=retrieved` verify-dataset (and the in-process
verification) notes such a gold as "rejected under the retrieved schema scope
because retrieval did not pick <table>", a retrieval miss the run measures,
not a dataset problem; `test/gold-sql-validator.test.js` pins that exactly
those 33 golds are rejected there. A table outside the in-scope schema is a
problem in every scope. See
[docs/experiments/01-schema-scope.md](experiments/01-schema-scope.md).

## How to add a case

1. **Templated** (preferred for answerable questions): add an entry to
   `INTENTS` in `scripts/build-eval-dataset.mjs` (template, metric,
   dimensions, window, filters, shape, 2-3 phrasings). The case is dev (the
   generator writes no holdout). Run `npm run build-eval-dataset`. Then on
   seeded fixtures run `npm run verify-dataset -- --dataset
   templated-public --write-pins`, run the generator again, and `npm run
   verify-dataset`. Controls come with the template. A survivor means one of
   three things: the family cannot change this intent's answer (add it to
   `NOT_EMITTED` with the reason); no fixture separates it yet (add fact rows
   to v2 or v3, see below, re-seed and re-pin); or rows that would separate it
   break another designed property (add it to `NOT_EMITTED` with that fixture
   limit, and list it under [Known blind spots](#known-blind-spots)).
2. **Hand-written** (hard cases, or a shape no template covers): add the case
   to `datasets/hard-cases-public.json` with `split: 'dev'` (and the intent
   of the existing intent whose gold it shares, if any), a
   gold that follows the conventions above (a scalar gold returns one row), a
   comparison block, `notes` for any alternative reading, and
   tags/`failure_class`; add its id and question hash to
   `test/fixtures/case-question-registry.json` (a changed question needs a new
   id). Write pins with `--write-pins`. Add negative controls under the case id
   in `datasets/controls/hard-cases-public.json` when a plausible mistake
   exists (each must be killed; positives must match and pass the validator);
   a mistake the fixtures were not designed against can go in as a held-out
   control (`heldout: true`, id `xh*`), which is reported but not gated.
3. **Abstain / clarify**: `expected_behavior` plus question, intent, split,
   tags and `notes` saying why; nothing else.
4. Run `npm test` (hygiene: splits, holdout vocabulary, one intent per gold,
   ids, leakage, pins, determinism, mutation families) and `npm run
   verify-dataset` (every gate).

If the validator rejects a correct gold, do not bend the gold around it: add
`known_validator_rejection` with the code (the gap is then measured), unless
the gold itself is at fault.

## Failure taxonomy

`failure_class` names the trap a case targets; report.md breaks accuracy down
by it. The original eight, from the edge suite:

| `failure_class` | What it traps |
|---|---|
| `metric_column_confusion` | The wrong amount column (gross vs net, payable vs outstanding, header vs line). |
| `grain_confusion` | Header grain where the question is about lines, or the reverse. |
| `wrong_join_path` | A plausible but wrong join path (brand through the bridge table). |
| `campaign_join_path` | The campaign through the document header instead of the product. |
| `wrong_date_column` | Posting date vs document date vs due date. |
| `stale_snapshot_field` | A denormalized snapshot column instead of the master data. |
| `master_data_resolution` | A fuzzy entity term resolved to the right products (no case today: see below). |
| `aggregation_shape` | The wrong result shape (series, side-by-side columns; a list where "how many" asks for one count). |

Added with the new datasets: `time_window` (quarters, ranges, years),
`entity_filter` (a named member), `distinct_count`, `ratio_metric` (average
order value), `vocabulary`, `multilingual`, `typo`, `relative_date`,
`entity_resolution`, `empty_result`, `ambiguous_metric`, `abstention`,
`clarification`. Added after the error analysis of the Experiment 1
failures: `default_filter`, a filter every answer must carry by convention
although the question does not say it: canceled documents left out (also
when `SalesDocument` is joined into a ledger question by document date, or
sits inside an anti-join) and product lines only for units (the
delivery-fee lines are not units sold).

The same analysis corrected labels that named the wrong trap and filled the
missing labels of the failing cases (generator rules or intent overrides for
templated cases, so every phrasing of an intent shares its label):

| Cases | Was | Now | Why |
|---|---|---|---|
| `edge_public_003` | `master_data_resolution` | `grain_confusion` | the name-based filter returns the same products as the tag-based one on this master data; the trap left is one row per line instead of per product (missing `DISTINCT`) |
| `hard_entity_lakeside_spend_q1_2026` | `entity_resolution` | `metric_column_confusion` | the customer resolves; the amount ("spend") is the trap |
| `tpl_outstanding_balance_due_apr_2026_*` | `wrong_date_column` | `metric_column_confusion` | "open amount" / "unpaid balance" is `BalanceAmount`; the due date is not where answers go wrong |
| `tpl_account_debit_credit_posted_apr_2026_*` | `wrong_date_column` | `wrong_join_path` | an inner join to `SalesDocument` drops the manual journals |
| `tpl_customer_qty_top3_q1_2026_*` | `time_window` | `default_filter` | product lines only for units |
| `tpl_active_customers_without_sales_q1_2026_*` | `time_window` | `default_filter` | the cancel filter inside the anti-join |
| `core_public_004`, `paraphrase_public_004`, `tpl_customers_bought_feb_not_mar_2026_*` | none | `aggregation_shape` | "how many" over an anti-join: one count |
| `core_public_005` / `009`, `paraphrase_public_005` / `009`, the templated document-date ledger intents (`tpl_account_net_movement_feb_2026_*`, `tpl_account_debit_credit_q1_2026_*`) | none | `default_filter` | postings of non-canceled sales documents only |
| `tpl_store_qty_mar_2026_*`, `tpl_total_qty_dec_2025_*` | none | `default_filter` | product lines only for units |

`failure_class` is not part of the scoring fingerprint, so relabelling never
takes a case out of a paired comparison.

## The multi-fixture oracle

On the original seed alone (9 documents, 10 lines) many plausible-wrong
queries return exactly the gold answer: line `TotalAmount` equals `NetAmount`
on every line, header `NetPayableAmount` equals `NetAmount`, the posting month
always equals the document month, the one canceled document has no postings.
The audit measured that the old oracle caught only 50 of 108 hand-written wrong
queries (46.3%) on it. Following test-suite accuracy (Zhong et al. 2020,
*Semantic Evaluation for Text-to-SQL with Distilled Test Suites*), a prediction
counts as correct only if it returns the gold answer on **every** fixture:

| Fixture | Database | Facts |
|---|---|---|
| `seed` (primary) | `demo_retail` | The original demo facts (also `npm run seed-demo`). The product loop runs here. |
| `v2` | `demo_retail_v2` | The audit's hand-designed fixture (mutation workstream v2 + v2b), ported to code: header and line metrics separated (NetPayable = Net + 12.50, BillTotal = Gross + 7.25, line TotalAmount = Net × 1.05), header-level discounts, canceled documents in range (one with postings), month-boundary documents posted in another month, multi-line documents, a NULL-ProductId fee line, a manual journal, 2025 documents in the same months, sub-cent amounts, ties, stale snapshots. The v2c rows from the oracle review (prior-year Urban Refresh sales, same-amount twins in January-March 2026, the inactive customer and the discontinued product selling, a canceled February sale, March category totals out of ID order, Harbor Kiosk's April order). The v2d rows for the templated controls (`addV2dFacts`): Harbor Kiosk's canceled first-day Q1 document, its only 2025 document (dated 2025-12-31, posted 2026-01-02) and a document the day after Q1; first-day documents for two customers; the first Summit Grocers buying on 2026-02-01 (both namesakes then buy in February and their merged total overtakes the third-ranked customer); the largest documents around the March boundary; a canceled, partly paid March document; canceled documents in April and February; December 2025 sales (both Summit Grocers, a canceled one for the inactive customer); prior-year sales in November / December 2024 and April / May 2025; manual journals on 2026-01-01 and in April. The v2e rows from the dataset review (`addV2eFacts`): canceled February / March documents for Harbor Kiosk (a Weekend Pantry product), the second Summit Grocers, and a customer without an April purchase; a Summit Grocers document dated in February and posted in March; documents on 2026-04-01 (Lakeside's 2500.00, the largest near March, Metro Online Store, Summit Grocers' first 2026 Urban Refresh purchase); first days of Q1 2026 and Q4 2025; 20 Kitchen Towels on 2025-04-01; a June 2025 sale, Harbor Kiosk credit memos (canceled in March 2026, live in March 2024) and a 2022-12-30 document posted in 2023 for the zero-row cases; manual adjustments debiting Sales Revenue and crediting Accounts Receivable in February and March 2026; a Clearspring Waters line in March 2026 that keeps the brand's former name as its snapshot. |
| `v3` | `demo_retail_v3` | ~260 documents from a seeded PRNG (mulberry32, `V3_PRNG_SEED = 20260331`) over January - March 2025 and November 2025 - May 2026: boundary-day dates, cancellations, NULLs, stale snapshots, a customer tie, 12 products selling in March 2026 so a top-10 `LIMIT` binds (with a clear gap at the cut-off), the inactive customer buying in January-March 2026, the discontinued product selling in March, a same-amount twin document in every month (`addV3Twins`), and Harbor Kiosk's designed documents (`addV3dFacts`, `addV3eFacts`): two dated 2026-02-01 and posted in March (the only customer buying in February but not in March), one on 2026-04-01, and its only 2025 document on 2025-01-01. |

**All fixtures share identical master data** (customers, products, brands,
categories, campaigns, locations, document types, ledger accounts, price
lists) and differ only in the fact tables (`SalesDocument`,
`SalesDocumentLine`, `AccountingPosting`). The model's prompt context
(master-data candidates, product names) is resolved on the primary fixture
only, so a fixture with other dimension rows would test a different question.
The master data includes the v2 discriminators for every fixture, the seed
included: an active customer without sales in seed and v3 (Harbor Kiosk), a
second "Summit Grocers", a second Beverages brand (Clearspring Waters), a
tag-only seltzer, a still-water decoy, a second sparkling SKU, a Northstar
product in Snacks, and a discontinued product ("Oat Cookies Tin").

`npm run seed-fixtures` (admin credentials) creates, bootstraps and seeds all
three databases from code and records `name`, `content_hash`,
`generator_version` (now 3) and `prng_seed` in a `_fixture_meta` table in
each. It is idempotent: a database whose rows already hash to the generated
content is left alone; any other is rewritten (`--force` rewrites it anyway).
The SELECT-only query user reads every fixture through its `demo\_retail%`
grant. A unit test pins the content hashes, so a generator change is visible.

**Drift is detected from the rows, not the meta row.** `checkFixtureContent`
re-hashes every seeded table and reports `current`, `drifted`, `stale` or
`missing`, plus whether the master tables equal the shared `MASTER_DATA`.
`verify-dataset` fails on any fixture that is not `current` or whose master
data differs; the benchmark warns on drifted facts and refuses to run when a
fixture's master data differs. Both always read `demo_retail`,
`demo_retail_v2` and `demo_retail_v3`; `DB_NAME` is not used.

Oracle rules (`scoreAgainstGold`):

- **Gold variants**: the gold plus any `alternative_expected_sql`. A prediction
  must match **one** variant on every fixture (mixing readings across fixtures
  does not count).
- **One column mapping**: the comparator's gold-column → prediction-column
  assignment must be the same on every fixture. `findSharedAssignment`
  searches for one mapping valid on every fixture at once (candidate carriers
  intersected across fixtures, partial mappings pruned by their row tuples);
  no common mapping is `inconsistent_assignment`, and a search cut off by its
  step bound fails closed as `assignment_search_exhausted`, never a pass.
- **Ties at the cut-off**: per gold variant and fixture, a ranked gold that
  returned as many rows as its own outermost `LIMIT` runs once more with that
  `LIMIT` raised by `GOLD_TIE_LOOKAHEAD_ROWS` (1000, cached like the gold);
  the rows past the original `LIMIT` that tie with its last ranking value may
  stand in for its boundary rows (see [the comparison
  spec](#comparison-spec-value-aware-scoring)), so the verdict never depends
  on which tied item MariaDB returned. A cut with no such row stays strict,
  and so does a run past the `LIMIT` that does not start with exactly the
  gold's rows. Every gold with a `LIMIT` orders by a tiebreak after its
  metric, so the gold itself is deterministic (a dataset hygiene test checks
  it).
- **Gold runs with its own timeout** (`GOLD_STATEMENT_TIMEOUT_MS`, 30 s), cached
  per fixture; a failing gold is `expected_sql_error`, never a model error.
- **The prediction runs as the read-only query user** through
  `executeReadOnlySql`, with the statement timeout and a row cap of (largest
  gold row count + 1).
- **Signal checks and disallowed columns are warnings**, never failures.

### Pins and alternative gold

- `expected_row_counts: { seed, v2, v3 }` pins the gold row count per fixture
  on every answer case (`npm run verify-dataset -- --write-pins` rewrites them,
  and refuses to write anything unless every fixture is `current` with the
  shared master data: run `npm run seed-fixtures` first; behaviour cases have
  none). An external dataset may still carry the older single
  `expected_row_count`; it is read as the seed's pin (and ignored next to
  `expected_row_counts`), and a result record (live or rescored) keeps it
  among its case fields.
- `alternative_expected_sql: [sql, ...]` lists other readings a case accepts,
  each explained in the case `notes`: the original ledger rankings without
  zero-total accounts (`core_public_005` / `009`), the `edge_public_008` pivot
  listing every customer; and, new, month-label forms of series, posting-date
  ledger questions without canceled documents' postings, customer pivots,
  per-name lists, the June 2026 zero-row case and "each customer's last
  purchase" with every customer, both readings of "sales" and "orders", month
  to date with or without today, "spend" net, with tax or as billed, and an empty
  result for a year without sales.
- **Which readings get an alternative** (one rule for the whole suite): a
  breakdown lists the members with activity in the window; listing every
  member with 0 or NULL is accepted only where the question invites it ("for
  each customer", a pivot, "each customer named ...", an empty window). A
  scalar returns one row (NULL or 0 for an empty window). Two scoring
  relaxations widen this on purpose (next section): a customer pivot also
  accepts extra customers with 0 everywhere, and a scalar sum also accepts
  an empty result where its gold is NULL / 0.

### Scoring relaxations

Two comparison-spec flags relax the oracle on purpose. Each is opt-in per
case, so the cases that use it are listed by their `comparison` block, and
each changes the case's scoring fingerprint, so a comparison with a report
scored without it excludes the case (`goldChanged`, "alternatives or
comparison spec changed") instead of counting a free flip.

| Flag | Applies to | Relaxation |
|---|---|---|
| `ignore_all_zero_rows` | rowset mode with `null_as_zero` | prediction rows whose `null_as_zero` metrics are all 0 / NULL and whose member is absent from the gold (and listed once) are ignored |
| `empty_as_zero` | scalar mode with `null_as_zero` | an empty prediction equals a gold of one NULL / 0 row |

The rules are in the [comparison spec](#comparison-spec-value-aware-scoring);
`test/comparison-relaxations.test.js` pins them. Where they are used, and why
(both came out of the error analysis of the Experiment 1 failures):

- `ignore_all_zero_rows`: the customer pivots (`edge_public_008` and the
  templated `customer_net_sales_q1_2025_vs_q1_2026`, 3 cases; the generator
  sets it on every pivot by customer). A pivot that also lists customers with
  0 in every window (every customer that bought at any time, say) gives the
  same answer, as long as each extra customer is listed once and is not a
  customer the gold lists: a pivot grouped one level too fine (by year
  without the window, or by `IsCanceled`) that adds a 0/0 row next to a
  customer's real row still fails (negative controls on both pivots guard
  this). The oracle used to accept only the gold's customer set or
  every customer (the LEFT JOIN alternative), so such an answer matched one
  reading on one fixture and the other on another, and failed. The review
  controls that encoded that rejection (`edge_public_008/r3` and `r4`) are
  positive controls now (`rp7`, `rp8`). Not set on the single-row pivot (no
  member to pad) or on the empty June 2026 case (an empty gold stays strict).
- `empty_as_zero`: every scalar sum with `null_as_zero` (30 templated cases,
  10 hard cases). "How much did South Store take in March 2026?" answered
  with a total grouped by the store is empty on a fixture where the store
  sold nothing, and one NULL row is what the gold returns there.

Rescoring the committed gpt-4o-mini baseline (no LLM calls) with and without
them flips five of its failing cases to pass (the three customer pivots and
`tpl_net_sales_south_store_mar_2026` ×2) and none the other way; a gain from
the relaxations is a measurement change, not a model gain. A comparison with
a report scored before them excludes these 43 cases (scoring fingerprint
changed).

### Statuses and warnings

The benchmark status depends on values only: `pass`, `result_mismatch`, or
`retrieval_miss` (no match and an expected table was not retrieved); a failed
product loop reports `llm_error`, `validation_error`, `execution_error`,
`infra_error` or `aborted` from its `errorStage`; a broken gold is
`expected_sql_error`; a behaviour case whose SQL executed is `answered`; the
runner adds `skipped_budget` and `evaluation_error`. The status says where the
product loop stopped; the attribution outcome built on it says who caused it
(see [Reading report.md](#reading-reportmd)). `low_signal_success` and
`disallowed_column_used` are warning flags on a result, never statuses:

- **Signal checks** (`signal_checks`) are resolved through the comparator's
  column assignment and reported as `signal_warnings`; verify-dataset still
  requires every gold to pass its own signal checks.
- **Disallowed columns** (`disallowed_columns`) are a token-based lint over the
  shared MariaDB tokenizer (comments, string literals and output aliases never
  count; `Table.Column` entries resolve table aliases), reported as
  `disallowed_column_warnings`.

## Comparison spec (value-aware scoring)

`compareResultsDetailed(expected, actual, comparison)` (`src/benchmark.js`)
returns `{ match, assignment, reason }`: it matches the gold's compared columns
to the model's columns by **value** (any name, any position, extra predicted
columns ignored) and checks the row tuples agree. `assignment` maps each gold
column to the prediction column that carries it; `reason` is `match` or the
first failed requirement (`row_count`, `missing_columns`, `values`,
`column_order`, `scalar_column`, `ranking`). Every committed answer case
carries a `comparison` block; a case without one falls back to the legacy
exact-row behaviour.

```jsonc
comparison: {
  mode: 'scalar' | 'rowset' | 'ranked',  // default 'rowset'
  compare_columns: [..gold column names], // default: all gold columns
  value_columns:   [..gold column names], // ranked: the ranking metric(s); default: first truly numeric gold column
  order: 'desc' | 'asc',                  // ranked: default 'desc'
  decimals: number,                       // rounding precision, default 2 (matches gold ROUND(.., 2))
  tolerance: number,                      // absolute numeric tolerance; default 0
  column_order: [..gold column names],    // these keep their relative SELECT-list order in the prediction
  null_as_zero: [..gold column names],    // NULL counts as 0 in these columns, on both sides
  ignore_all_zero_rows: true,             // relaxation, rowset + null_as_zero: extra all-zero rows are ignored
  empty_as_zero: true                     // relaxation, scalar + null_as_zero: no rows = one NULL / 0 row
}
```

- Numbers match by equality after rounding to `decimals`, or with `tolerance`
  by true absolute difference. Numeric strings compare as numbers (`'03'`
  equals 3, `'2025'` equals 2025).
- **Dates**: a JS `Date` and a date/datetime string normalize to one canonical
  value, so a DATE column matches a `DATE_FORMAT` string of the same day
  (`'2026-01-01'`); `'2026-01'` is text. Dates never equal numbers.
- **scalar / rowset**: an order-blind bijection of compared row tuples must
  exist. **Empty results**: two empty results match; an empty result never
  equals one row (unless the case opts into `empty_as_zero`, below).
- **ranked**: the bijection must exist **and** the model's primary value column
  must be monotonic in `order` up to ties (tie reordering by label is
  tolerated; NULL metrics sort last). Without a tolerance values compare as cells match, so
  two values that both match one gold value tie: rounded to `decimals`, a
  NULL under `null_as_zero` and 0.004 tie at two decimals. With a tolerance
  the column's own order compares unrounded, so a prediction sorted by its
  own values always passes the order check (per-line `ROUND` sums can flip a
  near-tie of two distinct gold values by a cent: gold Zeta 100.01, Alpha
  100.00 and prediction Alpha 100.01, Zeta 100.00), and a column out of its
  own order passes only by the row matching: the gold rows the prediction's
  rows pair with must come in the gold's ranking order, so two out-of-order
  rows tie only when they pair with equal gold values, as 9.992 listed
  before 10.008 (descending) both pairing with a gold 10 at 0.01. Gold rows
  10.015 and 10 are distinct ranks even though their values are within twice
  the tolerance, so 10 listed before 10.015 fails, and at a cut-off the boundary
  rows and their ties rank as one tie. The default ranking column is the
  first truly numeric gold column, never a numeric-looking code string.
- **Ties at the cut-off** (ranked only): when a gold variant returns as many
  rows as its own outermost `LIMIT` on a fixture (`isCutByLimit`), the
  oracle reads it past that `LIMIT` and passes the left-out rows as
  `goldTies`. The gold's **boundary** rows are those whose ranking values
  (every `value_columns` entry, NULL included) equal its last row's; its
  **ties** are the left-out rows with those same values. When there are
  ties, each prediction row with the boundary's ranking values must equal,
  by its full tuple, a distinct row of the boundary rows plus the ties: as
  many boundary-valued rows as the gold's, each a real tied item, none listed
  twice. Every row above the boundary still pairs by its full tuple, and the
  ranking must still hold. A `LIMIT` that cuts through tied items keeps
  whichever its tiebreak puts first; a model's SQL without the gold's
  tiebreak keeps whichever its execution plan puts first, so without this
  rule the same SQL could pass or fail between runs (it did:
  `tpl_product_qty_top5_feb_2026_8a9dc1`, where 'Herbal Tea Variety Pack' and
  'Spring Water 24 Pack' tie at 34 units at position 5 on v3). Values compare
  as everywhere else (`decimals`, `tolerance`, `null_as_zero`); with
  `value_columns` naming several columns a tie is equality on all of them.
  Strict otherwise: being cut is not a tie, so a gold whose left-out rows all
  rank below its last row still checks its last row's label (a top 1 whose
  label is wrong but whose total is right still fails), and a gold that
  returns fewer rows than its `LIMIT`, or has none, already holds every item
  of its last value, so another label there is an item that does not belong.
  Limits: a `LIMIT` inside a subquery or CTE does not count, an `OFFSET`'s
  first boundary stays strict, and a tie group longer than
  `GOLD_TIE_LOOKAHEAD_ROWS` is only partly known (a prediction that picks an
  unread tied item fails). Scalar and rowset comparisons never relax.
- **Name pinning**: when exactly one prediction column has a gold column's name
  (ignoring case and punctuation), only that column may carry that gold column,
  and it carries no other; a column named like the gold must hold the gold's
  values. "Named like" also covers a longer name containing the gold name's
  words as a whole run not preceded by a negation.
- **column_order**: for the listed gold columns, a carrier named like its gold
  column identifies itself; the others must keep the gold's relative order.
  Limit: carriers named unlike any listed column are judged by position only.
- **null_as_zero**: NULL counts as 0 on both sides in the listed columns (a
  pivot's month without sales, a SUM over an empty window), in a ranked case's
  order check too (a NULL between 10 and 5 in a descending ranking is a 0 out
  of place). Without it a NULL gold never equals 0.
- **Scoring relaxations** (opt-in per case; each is a policy choice listed
  under [Scoring relaxations](#scoring-relaxations)):
  - `ignore_all_zero_rows` (rowset mode with `null_as_zero`): a prediction
    row with no counterpart in the gold is ignored when every compared
    `null_as_zero` column it carries (under the column assignment) is 0 or
    NULL and its member (its compared cells outside `null_as_zero`, the
    customer name in a customer pivot) is absent from the gold and appears on
    no other prediction row. A second, all-zero row for a member the answer
    already lists (`Lakeside Wholesale 200.00 0.00` next to
    `Lakeside Wholesale 0.00 0.00`, from a pivot grouped by year or by
    `IsCanceled` as well) contradicts the answer and is never ignored. Every
    gold row must still pair with a distinct prediction row, and a prediction
    row with any non-zero metric must pair with a gold row. An empty gold, or
    a comparison whose compared columns are all `null_as_zero` (no member to
    tell), stays strict. The member is what the gold compares, so in the
    customer pivots it is the customer name: two customers that share a name
    (the two Summit Grocers) are one member, and a 0/0 row for one of them
    next to the other's real row fails too (a known strictness; on the current
    fixtures every listing of extra customers passes, `rp7` and `rp8`). The oracle reads up to
    `ALL_ZERO_ROWS_ALLOWANCE` (1000) rows past the gold for such a case; a
    prediction longer than that is a `row_count` mismatch.
  - `empty_as_zero` (scalar mode with `null_as_zero`): an empty prediction
    equals a gold of one row whose compared cells are all NULL, or 0 in a
    `null_as_zero` column. An empty gold is not relaxed the other way.
  - A flag on a case of another mode or without `null_as_zero` is a dataset
    error (`normalizeBenchmarkCase` throws); a flag that is absent (or false)
    leaves the case's scoring fingerprint as it was.
- **Scalar rule**: when the gold is a single value and the prediction has
  several columns, the carrier must be the column named exactly like the gold
  column when there is one, else the only column of the value's kind, else the
  only column named like it. Known false negative: a correct answer plus one
  more numeric column under an unrelated alias fails.
- **Tolerance rule**: sums of line-level money and averages set `tolerance:
  0.01` (the fixtures hold sub-cent line amounts, so `SUM(ROUND(x, 2))` and
  `ROUND(SUM(x), 2)` can differ by a cent); header and posting amounts are
  whole cents and counts and quantities never get a tolerance.

## Oracle controls and kill rate

`datasets/controls/<dataset>.json` holds, per case id, **negative** controls
(plausible-but-wrong SQL the oracle must kill: execute on every fixture and
fail to match on at least one) and **positive** controls (correct alternatives it must accept on every
fixture, which must also pass the production validator). A case resolves its
controls by its own id, else by its intent when the gold fingerprint matches
(paraphrases, the Swedish and typo hard cases, and hard cases sharing a
templated intent reuse their source's controls); a `gold_fingerprint` flags
controls whose gold changed. verify-dataset fails when a dataset's design kill
rate is below `--min-kill-rate` (default 0.95). The original controls:

- **Audit controls** (`m*`, `h*`, `a*`): 108 design mutants, 28 held-out
  mutants (written after the v2 fixture was frozen), 32 of the 35 correct
  alternatives, plus 5 positives for the alternative readings.
- **Review controls** (`r*`, `rp*`): 44 design negatives for the families the
  oracle review found surviving (MONTH() without YEAR(), SUM(DISTINCT ...),
  invented IsActive filters, hedged answers, one-sided cancel filters, ...)
  and 36 correct alternatives (`edge_public_008/rp7` and `rp8` were the
  negatives `r3` and `r4` until the `ignore_all_zero_rows` relaxation; its
  `r5` and `r6`, pivots grouped by year or by `IsCanceled` as well, are the
  duplicate 0/0 rows the relaxation must still reject). `core_public_004/rp4` is flagged
  `validator_known_false_rejection` (the FAN_OUT guardrail rejects a boolean
  header aggregate that cannot fan out).
- **Templated controls** (`n*` design, `h*` held-out, `p*` positive):
  generated, see [the generator](#the-templated-generator).
- **Hard-case controls** (`x*` design, `xh*` held-out, `xp*` positive):
  hand-written.

Measured with `npm run verify-dataset` on freshly seeded fixtures, counting
each distinct control once ("alone" = the oracle with that single fixture):

| Design negatives | Seed alone | v2 alone | v3 alone | All three fixtures |
|---|---|---|---|---|
| 152 original (edge suite, audit + review) | 57 (37.5%) | 151 (99.3%) | 139 (91.4%) | **152 (100%)** |
| 746 templated | 169 (22.7%) | 606 (81.2%) | 652 (87.4%) | **746 (100%)** |
| 126 resolved by the hard cases (57 hand-written) | 45 (35.7%) | 117 (92.9%) | 111 (88.1%) | **126 (100%)** |
| 398 fresh holdout (v2), after triage (see [Fresh holdout (v2)](#fresh-holdout-v2)) | 127 (31.9%) | 350 (87.9%) | 341 (85.7%) | **398 (100%)** |

| Held-out negatives | Seed alone | v2 alone | v3 alone | All three fixtures |
|---|---|---|---|---|
| 28 original (audit, written after v2 was frozen) | 12 (42.9%) | 27 (96.4%) | 26 (92.9%) | **28 (100%)** |
| 117 templated (families never designed against) | 14 (12.0%) | 78 (66.7%) | 84 (71.8%) | **92 (78.6%)** |
| 16 resolved by the hard cases (5 hand-written) | 5 (31.3%) | 11 (68.8%) | 12 (75.0%) | **12 (75.0%)** |
| 37 fresh holdout (v2), new shapes included | 10 (27.0%) | 24 (64.9%) | 30 (81.1%) | **32 (86.5%)** |

Templated held-out kill rates by family: `QUARTER()` without `YEAR()` 30/31,
the cancel filter in `HAVING` 52/55, grouping by `ProductNameSnapshot` 4/7,
snapshot filters 1/5, rankings ordered by another amount 5/19. Positive
controls all match on every fixture (73 original, 29 templated, 26 resolved by
the hard cases); every one passes the validator except `core_public_004/rp4`
and those of questions flagged `known_validator_rejection` (rejected with the
same code, a note). Per dataset the gate counts each control once per case
that resolves it: templated design 1504/1504 (held-out 185/236), hard cases
design 140/140 (held-out 15/19); the design gate (>= 0.95) passes for every
dataset, and held-out rates are reported, not gated (`--min-heldout-kill-rate`
defaults to 0).

A negative control counts as killed only when it executes on every fixture
and does not match: one that fails to execute (a bad column, a timeout) is
**invalid**, and one hit by an infrastructure error (a dropped connection) is
**unscored**. Both are problems that fail `verify-dataset`, and both stay in
the denominator as not killed, so a broken control or a lost connection can
only lower the reported rate, never raise it. A verdict that rests on a
column-mapping search cut off by its bound (`assignment_search_exhausted`: the
oracle fails closed, which is right for a model's SQL) is **undecided** for a
control: listed, and counted as not killed like a survivor.

**Read the design numbers as fitted, not as a generalization estimate.** The
fixtures were extended until the design controls died: v2b after the audit's
held-out mutants, v2c and the v3 changes after the review's survivors, the
v2d / v3d rows, the twins in every v3 month and the prior-year v2 rows after
the templated controls showed survivors, and the v2e / v3e rows after the
dataset review (the other off-by-one side, cancel filters and `PostingDate` on
named-entity and zero-row cases, debits minus credits, a forgotten
`DISTINCT`, a renamed brand's snapshot). The review's independent adversarial
set (50 wrong queries and 8 hedges written without looking at the controls)
went from 58% to 98% killed; most of those queries are now controls too. The
held-out tiers are the honest estimate: about three in four mistakes from a
family nobody designed a row for are caught (79% templated, 75% hard cases),
and on the seed alone about one in eight. One tiny seed catches under half of
plausible-wrong SQL; fixtures designed against known mistake families catch
nearly all of those families; a new family is caught only if some fixture
happens to separate it.

### Known blind spots

Kinds of wrong SQL the oracle is known to let through:

- **Held-out survivors** (reported in every verify run): rankings ordered by
  the gross amount, line `TotalAmount` or the net amount while showing
  another (the amounts rank the same on these fixtures), filters on line
  snapshots for products and categories whose snapshots contain the master
  name, `HAVING MAX(IsCanceled) = 0` where no group mixes canceled and live
  documents, `QUARTER()` without `YEAR()` where every Q1 2025 buyer also buys
  in Q1 2026, and the empty-window survivors below.
- **Zero-row cases**: any query that returns nothing (or 0 / NULL for a
  scalar) passes them, a document count or the gross amount for "net sales in
  2023" included. They only test that no rows are invented.
- **Fixture limits recorded under `not_emitted`** (9 templated mutants): the
  day after a window ending on 2026-06-01 or 2027-01-01, the day after
  February for Household, the first day of Q1 for active customers without
  sales, and `COUNT(DISTINCT CustomerName)` for the customers lost between
  February and March (both Summit Grocers buy in March on v2 and v3).
- **Contrived posting readings**: "only debit postings count as postings"
  (`NOT EXISTS (… AND p.DebitAmount > 0)` for `core_public_006`) passes,
  because every posted document has an AR debit.
- **Filters equivalent on this master data**: `ProductTags LIKE '%seltzer%'`
  alone for "sparkling water", "active = `IsActive = 1` and a segment".
  Separating them would need more master rows, which every fixture would share.
- **Grouping by a unique name**: equivalent by construction on this master
  data, so it is not a control.
- **Label-only swaps of unrelated names** in the gold's column positions.
- **Items tied at a cut-off**: where a gold's `LIMIT` cuts its ranking through
  tied items, a boundary row passes as any of those items, so a wrong query
  that happens to keep another of them passes on that fixture (see ties at
  the cut-off in the comparison spec); another fixture has to separate it.
  Only real ties relax: on the fixtures the rule came in with that is the
  boundary of `tpl_product_qty_top5_feb_2026_*` on v3, and no control was
  killed only by a tie.
- **Readings no fixture separates yet**: a new mistake family is caught only by
  chance; add a fixture row and a control when one is found.

And correct SQL it rejects (known false negatives): the scalar rule's extra
numeric column under an unrelated alias, and the validator's FAN_OUT false
rejection of `core_public_004/rp4`.

Gold row counts of the original cases (seed / v2 / v3): core_001 4/7/7,
core_002 5/9/10, core_003 3/3/4, core_004 1/1/1, core_005 2/4/4, core_006
1/1/1, core_007 1/1/1, core_008 5/9/10, core_009 2/4/4, edge_001 3/4/5,
edge_002 1/1/1, edge_003 1/2/3, edge_004 1/1/1, edge_005 4/7/7, edge_006
3/3/4, edge_007 3/3/4, edge_008 3/7/8. Every other case pins its own counts
in its dataset file.

## Running evaluations

### One command

```bash
npm run eval                                        # the whole suite, once
npm run eval -- --repeat 3                          # three repetitions per case
npm run eval -- --split holdout                     # only the holdout (or --split dev)
npm run eval -- --offline --reveal-holdout          # list holdout cases one by one (a deliberate look)
npm run eval -- --repeat 3 --holdout-summary        # conclude a pre-registered experiment: + the paired holdout test, one line
npm run eval -- --dataset hard-cases-public         # one dataset
npm run eval -- --dataset edge-cases-public --tag join_path
npm run eval -- --compare eval/baselines/gpt-4o-mini.json --gate
npm run eval -- --rescore generated/runs/<run>/all/gpt-4o-mini/report.json
npm run eval -- --offline                           # no LLM: setup, verify, rescore the baseline
npm run eval -- --help                              # every flag
```

`npm run eval` (`scripts/eval.js`) does, in order:

1. **Database preflight.** Connects as the query user. When nothing answers at
   a local `DB_HOST` and Docker is available, it runs `docker compose up -d
   --wait --no-recreate mariadb` and waits until the query user can connect;
   `--no-docker` turns that off. Compose needs `DB_PASSWORD` (the read-only
   user's password); a missing or inconsistent setting is reported before
   anything starts, and so is a missing admin password when seeding may be
   needed. A compose service that is running but does not answer at
   `DB_HOST:DB_PORT` is never started or recreated: the run stops and says to
   check the setting.
2. **Fixtures.** Every fixture database is re-hashed; missing, stale or drifted
   ones (and any whose master data differs) are seeded with the admin role
   (`DB_ADMIN_PASSWORD`, `DB_ADMIN_USER` when not `root`, or
   `MARIADB_ROOT_PASSWORD`). `--no-seed` never writes and stops instead.
3. **Verification.** Every gold query and every control of the suite's
   datasets, in process, with the verify-dataset gates: no case problem (an
   invalid or unscored negative control is one: a control that does not
   execute is never a kill), and each dataset's design kill rate at least
   `--min-kill-rate` (0.95; held-out floor `--min-heldout-kill-rate`, default
   0; undecided controls count as not killed). A missing or empty controls
   directory, or one whose controls apply to none of the datasets, stops the
   run too. A failure stops the run with exit 2 before any LLM call;
   `--skip-verify` runs anyway, `--skip-controls` verifies the gold only.
4. **The run** (needs `OPENAI_API_KEY`; `OPENAI_BASE_URL` for an
   OpenAI-compatible endpoint; `MODEL_NAME` or `--model`, and for a reasoning
   model `REASONING_EFFORT` or `--reasoning-effort`, checked per model family
   before anything starts; the header line names both with their source and
   the endpoint host, see "Models" in the root README). Every selected case
   goes through the product loop (`evaluateQuestion` -> `runOptimizedQuestion`)
   on `--concurrency` workers (default 4), each repetition under a deadline
   (`--case-timeout-ms`, default 120000) that covers the whole repetition:
   the gold runs, the product loop and the multi-fixture scoring. Its
   AbortSignal reaches all three, and a result that arrives after the
   deadline, a late pass included, is a `timeout` (`late_status` names what
   it would have been; its attempts and cost are kept), so a slow case never
   counts as a pass. `--repeat N` keeps every repetition. `--budget-usd X`
   stops starting new cases once the LLM cost of finished cases reaches X (the
   rest are `skipped_budget`). A provider answer of HTTP 401 or 403 (wrong
   key), 404 (wrong `OPENAI_BASE_URL` path or model) or an unknown model
   (`model_not_found`) stops the run at once: that repetition is an
   `llm_outage` (excluded from accuracy), the rest are `cancelled`, exit 2.
   Ctrl-C (or SIGTERM) aborts the cases in flight, writes a partial report and
   exits 130; a second Ctrl-C a second later exits at once.
5. **Attribution, statistics, comparison, report.** Guardrail rejections are
   re-run on the fixtures, every repetition gets an outcome, and
   `report.json`, `report.md` and `trace.jsonl` are written to
   `generated/runs/<timestamp>/<suite>/<model>[.<effort>]/`.

The suite defaults to every dataset in `datasets/`, de-duplicated by case id
and by identical question and gold scored the same way (same alternatives,
comparison spec and expected behaviour): today 404 cases over 217 intents
(255 dev, 149 holdout).
Only the kept definition runs, so a duplicate is dropped only when dataset
order cannot matter; anything else is a dataset conflict (exit 2). A case id
that appears in two datasets must be the same case in every field that is run,
verified, scored, selected or reported on: a different question or gold, but
equally a different split, `known_validator_rejection`, `expected_row_counts`
(a legacy `expected_row_count` counts as the seed's pin, so it equals
`expected_row_counts: { seed: n }`), `signal_checks`, intent, tags, expected tables or columns, difficulty or
failure class is a conflict, also when its first appearance was dropped as a
duplicate of another id. Whitespace in the question and SQL and the order of
the top-level list fields (tags, expected / disallowed columns, expected
tables) are not differences; list order inside `signal_checks` or the
comparison spec is. Free-text `notes` is not compared. Rejecting the second definition,
rather than verifying both and running the first, is the conservative choice:
no definition is left unused without a word. A question duplicate under
another id is merged only when every other compared field agrees too (split,
`known_validator_rejection`, `expected_row_counts`, `signal_checks`, intent,
tags, expected / disallowed columns and tables, canonical question up to
letter case, difficulty and failure class): only the kept case's are read, and
they decide which split counts the case, how verification treats a validator
rejection, what `--intent` / `--tag` select, how the statistics group the case,
whether a miss is attributed to retrieval, which warnings are raised and what
the case record says. An intent left out defaults to the case's own id, so it
takes an explicit shared `intentId`. Filters: `--dataset a,b` or `--dataset-file`, `--split
dev|holdout|all` (default all), `--case-id`, `--tag` (any of), `--intent`;
`--case-id` with a dropped duplicate's id selects the case kept in its place
(in a rescore too). `--fixtures` scores on a subset (it must include `seed`).
Flags are checked strictly: an unknown flag, a flag missing its value or a
stray argument stops with exit 2 before anything starts. A live run also
checks `OPENAI_API_KEY` (and, with `--budget-usd`, the model's price: a row
in `src/pricing.js`, found without a vendor prefix, or a
`MODEL_PRICING_OVERRIDES` entry; without one the run refuses to start) before
the database is touched.

`npm run benchmark` and `npm run evaluate` run the same runner with `--profile
benchmark`: one dataset (default `core-public`), no Docker start, no seeding,
no verification, and exit 1 when any case fails in a single-repetition run: an
answer case that does not pass, or an abstain / clarify case that is not
declined: the model answers it, or its call fails without SQL and without a
decline code (behaviour cases stay out of strict accuracy, but not out of this
rule).

### Reading report.md

- **Headline**: strict accuracy with its 95% CI, the number of counted cases
  and intents, repetitions, model and date; majority-pass cases with a Wilson
  interval and the intent-clustered accuracy; **by split** (dev and holdout
  accuracy, when a run has both, with what the holdout rule enforces: no
  multi-word semantic-layer phrase and not "revenue"); the **behaviour line** ("Behaviour cases:
  abstain/clarify — N cases, M handled correctly"); the comparison line when
  there is a baseline (over the paired dev cases while the holdout is
  hidden). While the holdout is hidden, the first line gives
  every case's strict accuracy without an interval ("every split; no
  interval while the holdout is hidden") and the second line is the dev
  cases': their strict accuracy with its CI, majority-pass cases and
  intent-clustered accuracy (the console prints the same two lines).
- **Attribution** (answer cases only): who caused each outcome, per repetition
  and per case (majority outcome):

  | Outcome | Bucket | In accuracy | Meaning |
  |---|---|---|---|
  | `pass` | pass | counted | matched the gold on every fixture |
  | `wrong_result` | model | counted | ran, the oracle rejects it |
  | `guardrail_true_rejection` | model | counted | a guardrail rejected SQL that is wrong (caught) |
  | `safety_rejection` | model | counted | the safety layer rejected it (never executed) |
  | `execution_error` | model | counted | MariaDB rejected the final SQL |
  | `llm_error` | model | counted | truncated, refused or unusable output |
  | `guardrail_false_rejection` | system | counted | a guardrail rejected SQL that matches the gold on every fixture, in any attempt of a repetition that would otherwise be a model failure |
  | any model outcome tagged `retrieval_miss` | system | counted | an expected table was not in the allow-list (retrieved schema scope only: in the full scope every in-scope table is allowed) |
  | `guardrail_true_rejection` / `safety_rejection` tagged `known_validator_rejection` | system | counted | a case flagged `known_validator_rejection` whose final attempt the validator rejected with the flagged code: it rejects every correct answer to it today (any other failure of a flagged case is attributed as usual) |
  | `timeout` / `aborted` | infra | counted | the case deadline fired |
  | `infra_error` | infra | excluded | the database failed (in the product loop, a gold query, or a guardrail re-check: tagged `guardrail_unverified`) |
  | `llm_outage` | infra | excluded | provider timeout, unreachable, 401/403/404/429/5xx, unknown model (`LLM_MODEL_NOT_FOUND`) |
  | `skipped_budget` | skipped | excluded | not run, budget spent |
  | `cancelled` | skipped | excluded | the run was stopped before this repetition finished |
  | `expected_sql_error` | harness | excluded | the gold failed (no LLM call was made) |
  | `harness_error` | harness | excluded | the runner itself threw |

  Behaviour cases have their own outcomes (`declined`,
  `answered_instead_of_abstain`, `answered_instead_of_clarify`) and section;
  the section's "Excluded from accuracy" line counts them next to the
  excluded outcomes.
  To decide a guardrail rejection, its SQL must first pass the safety layer;
  then it runs read-only on every fixture through the oracle, and a match makes
  it a false rejection. A timeout counts as a failure on purpose (slow cases
  cannot inflate accuracy), but any timeout makes the run exit 2 and a case
  whose majority outcome is a timeout is left out of the paired comparison.
- **Guardrail confusion matrix** over every attempt of the answer cases:
  rejected and incorrect (caught), rejected and correct (false rejection),
  accepted and incorrect (missed), accepted and correct; precision, recall,
  false rejection rate; unknown and safety-layer rejections counted apart.
- **Behaviour cases (abstain / clarify)**: per expected behaviour, cases
  handled, the majority outcomes, and a per-case table.
- **Holdout in aggregate only** (by default): holdout cases appear in the
  split line and rows only; the case tables, the behaviour-case table and
  the console's progress and rescore lines leave them out and count them
  ("N holdout case(s) not listed"); the comparison (report.md and the
  console) covers the paired dev cases and only says how many holdout cases
  it left out; and the failure-class, difficulty and tag breakdowns, the
  attribution tables, the guardrail confusion matrix, the behaviour summary
  and the cost, latency, retry and token figures (report.md and the console)
  cover dev cases, so that subtracting
  the listed dev rows from a total cannot give a holdout outcome away; so do
  the headline's intervals, majority-pass cases and intent-clustered
  accuracy and the legacy pooled rate, and the holdout's split row shows no
  majority passes ("not shown");
  holdout behaviour cases are counted, without their outcomes (they are not
  in the split accuracy). `--reveal-holdout` lists them;
  `--holdout-summary` adds one aggregate line for the comparison's paired
  holdout cases (counts, McNemar p, accuracy change with its CI) to conclude
  a pre-registered experiment. See
  [Splits and the holdout policy](#splits-and-the-holdout-policy).
- **Cases**: id, question, passes / counted repetitions (declined / counted
  for behaviour cases), the case outcome and its attribution. The case
  outcome agrees with the majority pass: `pass` only when more than half of
  the counted repetitions passed, otherwise the most frequent failing outcome
  (ties: the order of the table above), even when `pass` is the most frequent
  single outcome (2 passes against two different failures is a failed case).
  The case's bucket is the most frequent bucket among the repetitions with
  that outcome (a retrieval miss or a known validator rejection can put some
  of them in the system bucket), with ties going to the system, and its tags
  come from those repetitions only; it never depends on the repetitions'
  order.
  A behaviour case's outcome agrees with its majority the same way:
  `declined` only when more than half of its scored repetitions declined.
- **By split, failure class, difficulty and tag**: cases, accuracy, majority
  passes (for a hidden holdout's split row, "not shown").
- **Cost, latency, retries, tokens** (every case, behaviour cases included;
  dev cases only while the holdout is hidden): total cost, cost per question
  and per correct answer, p50/p95 product-loop and LLM-call latency, retry
  rate, prompt (cached) and completion tokens ("completion N (reasoning M)"
  when a reasoning model reported reasoning tokens, which are part of the
  completion tokens), the budget (always the whole run's spend).
- **Verification**: fixture status, the kill rates per dataset, and the
  undecided, invalid and unscored negative controls (counts per dataset, ids
  below the table).
- **Provenance**: git sha (and whether the tree was dirty), prompt and
  semantic-layer versions (under hints version 2 the semantic-layer version
  hashes `metadata/semantic-layer.json` and its overlay
  `metadata/semantic-layer.hints-v2.json` together, and the overlay is named),
  the schema scope (requested and effective, the full-schema token estimate,
  widen-on-demand), the hints version (`product.hintsVersion`), the model
  settings (`product.model`, `product.modelSource`: `--model`, `MODEL_NAME`
  or `default`, `recorded` in a rescore; `product.reasoningEffort` and its
  source; `product.requestOptions`, the optimized request's options as sent
  without the response format), schema, fixture, dataset and controls hashes,
  model, the LLM endpoint host (never keys), Node and every runner flag. The comparison table shows both reports'
  schema scopes and hints versions (a report from before a setting reads "not
  recorded (before SCHEMA_SCOPE: retrieved, no widening)" or "not recorded
  (before HINTS_VERSION: 1)"), and so does the console when they differ.

### Statistics

The case is the unit. Repetitions of one case are strongly correlated (at
temperature 0 the audit saw 16 of 17 edge cases at 0% or 100% across three
repeats), so pooling them as independent trials overstates confidence.

- **Strict accuracy** = the mean over counted answer cases of each case's pass
  rate. Its 95% CI is a percentile case bootstrap (10,000 resamples, fixed
  seed 20261005).
- **Majority pass**: a case passes when more than half of its counted
  repetitions passed; Wilson 95% interval over cases.
- **Intent-clustered accuracy**: the mean over intents of the intent's mean
  case pass rate (paraphrases of one intent are not independent evidence),
  with a cluster bootstrap over intents.
- **By split** and the other breakdowns use the same per-case pass rates.
- The old pooled `reliability` block is still in `report.json`, labelled as
  pooled and correlated; report.md's "Legacy pooled reliability" line shows
  it (over the dev cases while the holdout is hidden).

### Rescore (no LLM calls)

`--rescore <report.json>` re-judges recorded generations with today's
validator (in today's `SCHEMA_SCOPE`), fixtures and oracle. Per repetition it replays the recorded
attempts (each SQL re-validated in the real prompt context; the first
accepted one re-executed and re-scored on every fixture); later attempts are
judged and recorded in `rescore.laterAttempts` without changing the outcome; a
replay that would have needed a retry it cannot make is tagged
`replay_truncated`. Every recorded attempt stays in `attempts`: the replayed
ones are marked `replay: "reached"`, the others `replay: "not_reached"` with
their SQL and LLM details as recorded (their recorded validation and
execution under `recorded`), so a later rescore can still replay them, and
`attempt_count` and the retry statistics stay those of the original run.
Recorded guardrail verdicts are never reused. The case definition is today's
dataset case with the same id (so a fixed gold is rescored with the fix),
else the recorded one, and the rescored report records the definition its
verdicts used: recorded case fields never override it (a report from before
`repetitions[]` existed is its own single repetition, minus its case fields).
Behaviour cases are kept as recorded (their outcome
only depends on whether the run produced SQL). Cost, latency and tokens stay
the original run's. The selection filters (`--split`, `--case-id`, `--tag`,
`--intent`) pick which recorded cases are rescored.

The schema scope is today's: under the full scope a recorded `TABLE_SCOPE`
rejection of an in-scope table is accepted and the SQL runs; under the
retrieved scope with widen-on-demand the attempt after such a rejection is
judged against the widened prompt (`widened_tables`, `rescore.widenedTables`),
as the product loop would have widened it. The console and report.md say when
the recording ran another scope or another widen-on-demand setting.
`SCHEMA_SCOPE=retrieved` (widen-on-demand is off by default for an explicit
retrieved scope) re-judges a pre-scope report exactly as it ran.

The hints version is today's too (`HINTS_VERSION`): the replayed SQL is
validated against today's semantic plan (metric enforcement, join hints), so
a guardrail change of hints version 2 shows, while its prompt changes cannot
(the recorded SQL was generated from the recorded prompts). The console and
report.md say when the recording ran another hints version;
`HINTS_VERSION=1` re-judges a report from before the setting exactly as it
ran.

The model settings are the recording's, not today's (no LLM is called):
report.md, `report.model` and `provenance.product` name the recorded model
and effort (source `recorded`). The configured ones (`--model` /
`MODEL_NAME`, `--reasoning-effort` / `REASONING_EFFORT`) only pick the default
baseline to rescore, so the header calls them "configured", the console notes
a recording of another model or effort, and `runner.flags` records them as
`configuredModel`, `configuredReasoningEffort` and their sources.

`--offline` runs the preflight, fixtures and verification, then rescores
`eval/baselines/<model>[.<effort>].json` when it exists, or says there is none and exits 0
(exit 2 with `--gate`).

### Compare and gate

`--compare <report.json>` (default: `eval/baselines/<model>[.<effort>].json`
when present, with the effort when one is set or the model family has a
reasoning default (`medium` for `gpt-6*`), and a `/` in the model id
written `__`; an id that is not plain (plain: lower-case letters and digits
with single `.` or `-` between them, in `/`-separated parts, not ending in
`.<effort>`) is written sanitized plus `_` and the first 8 hex digits of its
SHA-256, so ids that sanitize alike still get their own file; `--no-baseline`
turns that off) aligns cases by id. When the two
reports ran another model or reasoning effort the comparison says so
(`modelChange`; a "Model change" line in report.md, a `model:` line on the
console, and a note when the baseline is loaded): the paired test then
measures the model change. Other request options with the same model and
effort (`LLM_MAX_COMPLETION_TOKENS`, OpenRouter's `require_parameters`; the
prompt version does not cover them) are flagged the same way when both
reports record them (`modelChange.requestOptions`, a "Request options" row
and a "Request change" line in report.md, a `request options:` console
line). A case whose gold or
scoring fingerprint changed is excluded and listed, as are cases one report
did not count or whose majority outcome is a timeout; behaviour cases are not
compared; new and removed cases are listed. Per paired case the verdict is the
majority over repetitions: regressions and improvements feed an **exact
two-sided McNemar test**, and a paired case bootstrap gives a 95% CI for the
change in strict accuracy. The console prints the paired 2x2 table, the
accuracy change, the McNemar p and the flipped case ids; report.md lists the
flips with their questions. While the holdout is hidden, both recompute all
of it over the paired dev cases and leave the holdout cases out of every
list, saying only how many there are ("Dev cases only: the comparison's N
holdout case(s) are left out ..."); `--gate` still decides on every paired
case, holdout included. `--holdout-summary` adds one line for the paired
holdout cases in aggregate (their number, improvements, regressions, exact
McNemar p and verdict, accuracy change with its CI; see the
[holdout policy](#splits-and-the-holdout-policy)), only to conclude a
pre-registered experiment.

With `--gate` the run exits 1 when the candidate is significantly worse (p <
0.05 and more regressions than improvements) or, with `--min-accuracy X`, when
strict accuracy is below X. `--gate` with nothing to compare with stops with
exit 2 (with `--min-accuracy` it only warns). A selection of only abstain /
clarify cases has no strict accuracy, so `--min-accuracy` is refused for it
with exit 2 before any LLM call (and before a rescore), instead of comparing a
missing accuracy with the threshold. A loaded baseline must be an
evaluation report (a non-empty `results[]` of cases with ids, a known
`reportVersion`), else exit 2. `--gate` also exits 2, not 0, when the
comparison pairs no case or fewer than half of the run's answer cases
(`MIN_GATE_PAIRED_FRACTION` = 0.5 in scripts/eval.js): the regression gate has
then not tested the run, and the baseline is stale. On a rescore
(`--offline --gate`, `--rescore`) the same floor applies to today's
(filtered) suite: how many of its answer cases are paired (same id, same gold
and scoring, counted in both). A significant change needs at least 6
unanimous flips in one direction (p = 0.031).

Exit codes (over every case, holdout included: see the
[holdout policy](#splits-and-the-holdout-policy)): 0 success; 1 failed gate
(or, in the benchmark profile, a failed case); 2 harness, dataset or
infrastructure failure (unreachable database, fixtures that cannot be
seeded, failed verification, bad flags, any
`expected_sql_error`, `harness_error`, `infra_error`, `llm_outage`, `timeout`,
`aborted` or `cancelled` repetition, a run stopped early, a run with no
counted answer case unless only behaviour cases were selected, or
`--min-accuracy` with only behaviour cases selected); 130 when interrupted.
Exit 2 wins over 1.

### Baselines

The committed baseline for a model lives at `eval/baselines/<model>[.<effort>].json`: a
**compact** report of the whole default suite (see `eval/baselines/README.md`).
`npm run eval -- --repeat 3 --write-baseline` writes one from a clean tree,
only when the run exits 0 with no case skipped by the budget; the run's own
`report.json` stays complete. The compact form (`src/eval/compact-report.js`,
`compact: true`, `compactVersion: 1`, still report version 2) keeps what
`--offline` / `--rescore`, `--compare` / `--gate` and the summaries read: the
top-level model, provenance, runner, suite, oracle, stats, attribution,
behaviour and verification blocks (without per-case notes); per case its id,
the case fields a rescore rebuilds it from, `gold_fingerprint`,
`scoring_fingerprint`, `datasets` and `summary`; per repetition its status,
outcome, error code, token usage and total cost, timings and every attempt
(SQL, the LLM call's usage, total cost, duration, `tables_used` and failure
code, the validation verdict with its message, the execution verdict). When a
repetition made a single LLM call, that call's usage and cost are stored once,
on the repetition, and `llm_usage_attempt` names the call; a rescore puts the
call's copy back. It drops what a
rescore re-derives or nobody reads: row previews, explanations and
assumptions, master-data candidates and retrieved tables, the oracle's
per-fixture details, recorded guardrail re-checks, the previous comparison and
the first repetition's copy at the case's top level. A rescore of the compact
baseline gives the same outcomes and statistics as a rescore of the full
report; for 255 cases at `--repeat 3` it is about 1.4 MB (10^6 bytes, as
the "Baseline written" line prints it) instead of about 6-9 MB, one line per
case (the committed 404-case baseline is about 2.1 MB). A fake-provider run whose wrong answers were long plausible SQL, with
retries, measured 1,374,116 bytes; a real model's longer SQL can add some. A filtered or
partial run (filters, fewer fixtures, or a case set that differs from the
default suite) is refused before it starts; `--baseline-file <path>` saves
such a subset somewhere else, never inside `eval/baselines/` (every file there
is a model's default baseline). The committed baseline is
`eval/baselines/gpt-4o-mini.json` (see [Current baseline](#current-baseline));
it has to be re-made whenever the datasets, the prompt or the model change on
purpose.

### Current baseline

`eval/baselines/gpt-4o-mini.json`, written by
`npm run eval -- --repeat 3 --budget-usd 1.5 --write-baseline` on 2026-10-06
(the [Experiment 2](experiments/02-hints-v2.md) live run, at commit
`4ff6ecb`): gpt-4o-mini at api.openai.com, `SCHEMA_SCOPE` unset (`auto` →
`full`), `HINTS_VERSION` unset (2), prompt version `4358263bcf82`, fixtures
seed `094282546fe5` / v2 `7adec1b3bc33` / v3 `51d1c42c3b88`, the whole default
suite (404 unique cases: 392 answer cases and 12 abstain/clarify cases; dev
255, fresh holdout 149), compact file 2.07 MB. The rows below are what the
offline rescore (`npm run eval -- --offline`) prints by default: every row
after the first two covers the dev cases, except the whole-run spend that
opens the Cost row (report.md's Budget row), and the holdout is read only as
its accuracy by split (see the [holdout policy](#splits-and-the-holdout-policy);
`--reveal-holdout` prints every case).

| Measure | Result |
|---|---|
| Strict accuracy (392 answer cases, every split) | 73.6% (a point estimate: no interval while the holdout is hidden) |
| By split | dev 88.3% (245 cases) · fresh holdout 49.2% (147 cases) |
| Strict accuracy, dev cases (245 answer cases) | 88.3% (95% CI 84.4%–92.0%, case bootstrap) |
| Majority-pass cases, dev | 217/245 (Wilson 95% 84.0%–92.0%) |
| Intent-clustered accuracy, dev (130 intents) | 86.5% (95% CI 81.0%–91.4%) |
| Attribution, dev cases (repetitions) | pass 649 · model 86 · system 0 (known validator rejections 0, retrieval misses 0, guardrail false rejections 0) · infrastructure 0 · skipped 0 |
| Guardrail confusion, dev cases (761 attempts) | 34 wrong SQL caught, 0 correct SQL rejected, 78 wrong SQL accepted; precision 100%, recall 30.4% |
| Behaviour cases | dev: 0 of 10 handled (abstain / clarify); 2 holdout cases, outcomes not shown |
| Cost | $0.6347 for the whole run (the Budget row; divided by its 1,212 repetitions about $0.00052 per question, see [Cost](#cost)) · dev cases: $0.00051 per question · $0.00060 per correct answer · 83.5% of prompt tokens cached |
| Latency, dev cases | p50 2.39 s · p95 4.40 s (product loop) · retry rate 3.8% |

How to read it:

- **Dev vs holdout.** Dev (245 answer cases) is everything that was inspected
  or tuned on; the fresh holdout (147 answer cases) is new intents written
  blind and audited by two independent annotators. Experiment 2 was designed
  from dev failures, so its dev gain (74.7% → 88.3%) is in-sample; its holdout
  gain (41.3% → 49.2%; 17 improvements vs 6 regressions, exact McNemar
  p = 0.035, as the live run's report.md counted the holdout's flips at the
  time: report.md no longer shows holdout flip counts) is the out-of-sample
  evidence. The remaining 39-point gap is the
  clearest measurement in this repository: the holdout leans on analytical
  shapes the dev set barely covers (shares and ratios, overdue and ageing
  balances, running totals, month-over-month change, weekday and value-band
  breakdowns) and on unfamiliar wording. Per the
  [holdout policy](#splits-and-the-holdout-policy), only dev failures are
  analysed case by case.
- **Gold audit effect.** A hints-version-1 run before the audit scored the
  holdout at 35.4%; the version-1 baseline, on the same code after the audit
  (the earlier baseline below), scored it at 41.3%. The audit changed 10 of
  the 147 holdout answer cases (6 every-member alternatives, 2 rewordings, a
  gold fix on 2); the rest of that difference is run-to-run variation
  between two live runs. The step from 41.3% to this baseline's 49.2% is
  hints version 2 (Experiment 2), not the audit.
- **System failures.** None among the dev cases (the holdout's failure
  causes are not shown). Under hints v2 the dev flagged case (`e1b20a`) is no
  longer rejected; the 4 holdout cases flagged `known_validator_rejection`
  (`METRIC_COLUMN`) cap strict accuracy at 99.0% with perfect SQL.
- **Guardrails** (dev cases) never reject correct SQL but catch under a
  third of wrong SQL (34 of 112 attempts); most wrong answers are
  semantically wrong SQL that is still valid.
- **Reproduction.** `npm run eval -- --offline --gate` rescores this file's
  recorded SQL with today's code and reproduces it exactly (0 flips).

Earlier baselines: the retrieved-scope baseline (prompt version
`0c314451d4b7`, 68.8% on the 255-case suite), the full-schema baseline of
[Experiment 1](experiments/01-schema-scope.md) (72.8% on that suite), and the
version-1 baseline on the 404-case suite (62.2%; dev 74.7%, holdout 41.3%).

### CI

`.github/workflows/ci.yml`:

- **test** (Node 22.18 and 24): `npm test` (the hygiene and generator
  determinism tests included), `web:typecheck`, `web:build`, `web:test`.
- **db**: MariaDB from `docker compose`, then `bootstrap-db`, `seed-fixtures`,
  `verify-dataset` (every dataset, the kill-rate gate), the opt-in real-database
  tests (including `npm run eval` against an OpenAI stand-in: the original
  datasets with fixed numbers, then the whole suite with behaviour cases,
  splits and known validator rejections), `npm run eval -- --offline` (with
  `--gate` once a baseline is committed) and `evaluate-retrieval`. No LLM call.
- **eval-paid**: only on a manual dispatch or a pull request labelled
  `run-eval`; `npm run eval -- --budget-usd <budget>` (default 1 USD).

### Cost

LLM cost is small: the committed gpt-4o-mini baseline cost $0.00052 per
question over the whole run ($0.6347 over its 1,212 case repetitions,
holdout included; a repetition makes up to two LLM calls), so one repetition of the
whole 404-case suite is about 21 cents and `--repeat 3` about 63 cents
(measured: $0.6347), inside the default 1 USD budget. `--budget-usd` caps it.
(The $0.00051 per question that report.md and the [current
baseline](#current-baseline) table give is the dev cases' figure: while the
holdout is hidden, report.md's cost rows cover the dev cases, and only its
Budget row is the whole run's spend.)
Rescoring and `--offline` cost nothing.

## Known limits

- **Fitted oracle**: the design kill rates above are measured on controls the
  fixtures were designed against; the held-out tiers (about 75-79%) are the
  estimate for a new mistake family. See [Oracle controls](#oracle-controls-and-kill-rate)
  and [Known blind spots](#known-blind-spots).
- **A small holdout, one run per product version**: the inspected holdout
  was retired to dev (`formerly_holdout`); the fresh one (147 answer cases
  over 75 intents) is measured in aggregate only, by one 3-repetition run
  per hints version on the audited set (the [current baseline](#current-baseline), version 2:
  49.2%; the version-1 baseline: 41.3%), a wide interval at that size. **A
  holdout mixes two effects**: unseen intents and unseen vocabulary. It avoids
  the semantic layer's multi-word phrases and its enforced word "revenue", not
  its single-word entity synonyms, so its wording differs from dev's
  systematically ("turnover" and "net takings" where dev says "net revenue").
- **Zero-row cases** accept any empty result (or 0 / NULL for a scalar): they
  only test that the product does not invent rows in an empty window.
- **Every document type is a sale**: Credit Memos carry positive amounts in
  this schema and count as sales, orders and purchases everywhere (average
  order value, last purchase date, "spend"), a convention inherited from the
  core cases; a reading that leaves them out fails.
- **Breakdowns list members with activity**: a LEFT JOIN listing of every
  member with 0 is accepted only where the question invites it; scalars
  return one row (see [Pins and alternative gold](#pins-and-alternative-gold)),
  except under the [scoring relaxations](#scoring-relaxations).
- **Ledger rows are compared on the account name**: an answer with account
  codes only fails, so the new ledger questions ask for names; the original
  ledger cases (`core_public_005` / `009`) do not say so.
- **Top-N without an N**: `core_public_002` / `008` and their paraphrases ask
  for "the top products" without a number, and their gold uses the product's
  own LIMIT 10 rule, which binds on v3 (12 products); a full ranking or a top
  5 fails there. (The new cases name their N.)
- **One schema, synthetic data**: every case is about the same 13-table demo
  retail schema, with tiny dimension tables (8 customers, 13 products), so
  entity questions repeat the same names.
- **Templated wording**: 2-3 curated phrasings per intent; the templated
  intents are regular by construction (one metric, at most two dimensions).
- **Swedish, typos and shorthand** are a handful of cases; the product's
  ASCII-only normalization fails them today, and so does retrieval on most new
  vocabulary and named entities (with the full schema scope that only weakens
  the ranking hint; under the retrieved scope it is a table-scope rejection).
- **Behaviour cases** are 12 (10 dev, 2 holdout) and are scored only on whether SQL was produced;
  a future clarification answer will need its own check.
- **Ambiguity is partly encoded as alternatives**: where two readings are both
  defensible, either passes; a reading the dataset did not foresee fails.
- **Temporal**: the product's normalizer understands month-name + year only;
  quarters, ranges, relative dates and as-of dates are in the suite but not
  handled by the product.
- **Master data**: the product resolves products only; customers, stores,
  campaigns, brands, categories and ledger accounts are not resolved before
  generation.
- **Accounting dates**: the original ledger cases filter postings by the sales
  document's `DocumentDate`; the posting-date reading is used only where a
  question says "posted" or "posting date".
- **Guardrails**: the unqualified-identifier check only flags mixed-case unknown
  identifiers; joins between two foreign keys to the same table are rejected as
  JOIN_PATH; FAN_OUT rejects a boolean header aggregate over line-joined headers
  (`core_public_004/rp4`).

## Verifying the dataset without the LLM

`npm run eval` runs this verification itself before any LLM call. To run the
pieces by hand, start MariaDB (`docker compose up -d mariadb`; the init script
creates the SELECT-only query user), then:

```bash
npm run seed-fixtures                             # admin role; idempotent
npm run verify-dataset                            # all datasets, all fixtures, every gate
npm run verify-dataset -- --dataset templated-public
npm run verify-dataset -- --dataset-file my.json --fixtures seed --skip-controls
npm run verify-dataset -- --write-pins            # rewrite expected_row_counts
npm run build-eval-dataset -- --check             # the templated files are up to date
npm run evaluate-retrieval -- --dataset edge-cases-public
```

`evaluate-retrieval` writes `generated/retrieval-evaluation-hints-v<N>.json`
for the hints version it ran (so a `HINTS_VERSION=1` run and a default run
never overwrite each other; `--results-file <path>` writes elsewhere) and
records that version (`hints_version`) and the evaluation reports' product
configuration block (`product`: schema scope and hints version; the schema
scope does not change what retrieval returns).

The controls come from `datasets/controls` or `--controls-dir <dir>`. A
missing directory, one without any `*.json` controls file, JSON that is not
controls, or controls that apply to none of the cases being verified stop the
run with an error before any database is read, instead of silently skipping
the kill-rate gate; `--skip-controls` is the explicit way to verify without
the controls.

The opt-in database tests re-seed the fixture databases, check the master data
is identical across them, that edited rows are detected as drift and
repaired, the verify logic over every dataset, and `npm run eval` end to end
against a local stand-in for the OpenAI API (no paid call). They run when
`TEST_MARIADB_PORT` is set; the seeding tests also need the admin password and
fail with that message when `TEST_MARIADB_ADMIN_PASSWORD` is missing. They write
`demo_retail*`, so point them at a throwaway server, one file at a time:

```bash
TEST_MARIADB_PORT=3306 TEST_MARIADB_PASSWORD=<DB_PASSWORD> \
TEST_MARIADB_ADMIN_PASSWORD=<root password> \
  node --test --test-concurrency=1 test/mariadb.integration.test.js \
    test/eval-fixtures.integration.test.js test/eval-runner.integration.test.js
```
