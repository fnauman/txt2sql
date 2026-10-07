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
2. the holdout does not regress: the candidate's holdout accuracy (read in
   aggregate, by split) is not below the reference's 49.2%;
3. cost per correct answer is at most 3x the reference's (at most $0.0018);
4. p95 question latency (product loop) stays under 10 s.

Cost per correct answer and latency are read as report.md shows them by
default (dev cases, the holdout hidden), like the reference's figures.

Between two qualifying arms, prefer the cheaper (cost per correct answer)
unless the other is significantly better than it (exact McNemar p < 0.05
between the two arms). If no arm qualifies, gpt-4o-mini stays the default.

### Procedure

1. **Pilot** (to measure tokens, cost, truncation and latency before the full
   runs): the same 24 dev cases, fixed before the pilot and listed here, x 1
   repetition per arm, for example

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
     --compare eval/baselines/gpt-4o-mini.json --budget-usd <from the pilot>
   npm run eval -- --model gpt-6-luna --reasoning-effort medium --repeat 3 \
     --compare eval/baselines/gpt-4o-mini.json --budget-usd <from the pilot>
   ```

   The header line of each run must read `model gpt-6-luna (--model);
   reasoning effort low (--reasoning-effort)` (or `medium`); a run whose
   header names another model or effort is discarded.
3. **Holdout in aggregate only** (no `--reveal-holdout`); error analysis of
   the candidates' failures on dev cases only.
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
