# Experiments

Each experiment changes **one product variable**, measures it against the
committed baseline (`eval/baselines/gpt-4o-mini.json`) with a paired
comparison, and writes the result up here. The evaluation harness is
described in [docs/evaluation-dataset.md](../evaluation-dataset.md); this page
is the protocol on top of it.

| # | Experiment | Variable | Status |
|---|---|---|---|
| 01 | [Schema scope](01-schema-scope.md) | `SCHEMA_SCOPE` (retrieved → full) | complete — adopted |
| 02 | [Hints v2](02-hints-v2.md) | `HINTS_VERSION` (1 → 2: de-poisoned rules, temporal resolution, semantic layer) | complete — adopted |

## How an experiment is run

1. **One variable, behind a setting.** The change ships as a product setting
   (an env variable read by the web server, the CLI and `npm run eval` alike)
   whose old value reproduces the baseline's product loop. Check that first:
   the old value must give the baseline's prompt version in provenance and,
   rescored, the baseline's numbers exactly. Everything else stays fixed: the
   model (`MODEL_NAME`), the datasets and their gold, the fixtures, the
   semantic layer, the retry budget, the statement timeout.
2. **Offline first, for $0.** Before any paid call:
   - prompt size and cache layout per arm: `npm run measure-prompt-cache --
     --suite` (characters, estimated tokens, distinct cacheable prefixes);
   - the ceiling: `npm run eval` against a local stand-in for the OpenAI API
     that answers every case with its gold SQL (accuracy with perfect SQL, so
     what the validator alone takes away);
   - a rescore of the committed baseline under the new setting: `SETTING=...
     npm run eval -- --rescore eval/baselines/gpt-4o-mini.json` (or
     `--offline`) re-validates, re-executes and re-scores the recorded SQL with
     zero LLM calls. It shows which recorded rejections the change turns into
     executable SQL and whether that SQL is correct. It cannot show how the
     model would have answered a different prompt.
   - `npm run verify-dataset` under the new setting (every gate), so the
     dataset flags match the product.
3. **One paid run, paired, pre-registered.** Before it, write down the
   hypothesis, the arms and the decision rule (what the paired holdout test
   of step 4 must show for the setting to be kept). Then
   `npm run eval -- --repeat 3` with the new setting. A live run compares
   itself with `eval/baselines/<model>[.<effort>].json` automatically (`--compare
   <report.json>` for another baseline): cases are paired by id (a case whose
   gold or scoring changed is excluded and listed). Add `--budget-usd` as a
   cap.
4. **Conclude on the holdout, once.** The out-of-sample evidence an
   experiment ends with is the paired holdout test, read against the
   decision rule written down in step 3. Pass `--holdout-summary` on the
   concluding run, or afterwards, with zero LLM calls, on a rescore of it
   under the candidate arm's setting: `SETTING=<candidate value> npm run eval
   -- --rescore <its report.json> --compare <baseline report.json>
   --holdout-summary`
   (the rescore re-judges the recorded SQL with today's settings; it must
   print no "note: the recording ran with …" line, or its holdout line is
   not the run's and does not conclude anything). report.md's comparison
   section and the console then add one line over the paired holdout cases:
   their number, improvements, regressions, the exact McNemar p and verdict,
   and strict accuracy baseline → candidate with the change and its paired
   bootstrap 95% CI; nothing per case. Never pass it while designing or
   tuning the change: error analysis uses dev failures only (see
   [the holdout policy](../evaluation-dataset.md#splits-and-the-holdout-policy)),
   and a change reworked after its holdout line was read is no longer
   measured blind on that holdout.
5. **Do not re-baseline in the same step.** The committed baseline is replaced
   (`--write-baseline`, from a clean tree) only after the result is reviewed
   and the setting is kept.

## The statistics

- **Strict accuracy** is the mean over answer cases of each case's pass rate
  across repetitions, with a 95% case-bootstrap interval. The comparison adds
  the paired accuracy delta with a paired case-bootstrap interval.
- **Majority verdict per case**: pass when more than half of its counted
  repetitions passed. The 2x2 table of paired majority verdicts (both pass,
  regression, improvement, both fail) feeds an **exact two-sided McNemar
  test** on the off-diagonal cells. With 245 answer cases, 6 one-sided flips
  and none the other way is the smallest significant result (p = 0.031);
  `--gate` exits 1 only for a significant regression.
- A flip is a case, not a repetition, and paraphrases of one intent are not
  independent: read the intent-clustered accuracy and the flip list too.

## What to report

For each arm (baseline and candidate):

- provenance: git sha, prompt version, the product setting as report.md's
  Provenance shows it (for the schema scope: requested and effective scope,
  the full-schema token estimate), model and endpoint, repetitions;
- strict accuracy, accuracy by split (dev / holdout; the holdout in
  aggregate only: design the experiment from dev failures, never from
  holdout cases, see
  [the holdout policy](../evaluation-dataset.md#splits-and-the-holdout-policy)),
  and the dev cases' interval, majority-pass cases and intent-clustered
  accuracy (report.md gives these for dev cases only while the holdout is
  hidden);
- attribution: pass / model / system / infra buckets, guardrail false
  rejections, retrieval misses, known validator rejections, the guardrail
  confusion matrix;
- the paired table, McNemar p, the accuracy delta with its interval, and the
  regression and improvement case lists (report.md gives them over the
  paired dev cases while the holdout is hidden; the holdout's evidence there
  is its accuracy by split in both arms and, with `--holdout-summary` on the
  concluding run, its paired test: paired holdout cases, improvements /
  regressions, exact McNemar p, the accuracy change with its interval);
- cost per question and per correct answer, prompt tokens and their cached
  share, p50 / p95 latency, retry rate;
- the offline numbers it was predicted from (ceiling, rescore, prompt size),
  and how far the live result is from them;
- threats to validity: what else the change moved (prompt layout, prompt
  version), what a rescore cannot replay, noise between repetitions.

Keep the write-up in `docs/experiments/NN-name.md` with sections Hypothesis,
Design, Offline measurements, Live results, Decision.
