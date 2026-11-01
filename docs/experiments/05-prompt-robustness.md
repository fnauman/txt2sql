# Experiment 05: Cheap prompt sensitivity check

**Status:** complete — diagnostic; default unchanged (2026-10-14).

Protocol fixed before paid calls on 2026-10-14. Development only; no holdout
questions were inspected or used for this experiment.

Logical version: `exp05-prompt-robustness-2026-10-14`. Original reports did not
record Git or source-content identity. The session's base was
`717ec520a363c55d638ef7fd811b64dc27d7dee5`, but that is a retrospective
reference, not proof of exact run source. Artifact and frozen prompt-manifest
hashes are indexed in the [registry](registry.json). Future runs capture source
provenance at start and completion.

Later [semantic review](06-evaluation-review.md#semantic-finding) found an
ambiguous date convention in the shared consistently failing development case.
Here “wrong” means failure against the frozen oracle, not an independently
settled business interpretation. Historical scores are unchanged.

## Design

Five models at explicit low effort: Luna, Claude Haiku/Sonnet 5.5, Gemini
3.8 Flash, and DeepSeek v4.1 Flash. Each model receives 16 distinct intents,
selected by SHA-256 rank within source strata: 3 core, 3 edge, 5 hard, and
5 templated questions. Selection does not use any model's previous scores.
This is a small stratified diagnostic sample, not a population error estimate.

Each case has five fresh requests:

1. Original prompt.
2. Identical original prompt again, to estimate ordinary generation noise.
3. Prefix the question with “Please answer this question:”.
4. Double spaces in the question.
5. Reverse the order of the 13 intact schema-table blocks.

The model boundary is perturbed after the application builds the prompt.
Original questions still drive deterministic retrieval, temporal resolution,
and master-data lookup. Business rules, schema facts, examples, gold SQL,
validation, one application retry, and scoring against seed/v2/v3 fixtures
remain fixed. Native cache block metadata and returned reasoning blocks are
preserved. The trace records original/perturbed message hashes and the actual
messages dispatched by the wrapper.

Two workers per model; all five models overlap. The output ceiling remains
16,000 tokens and case deadline 120 seconds. SDK transport retries are disabled;
the product's one corrective retry is retained. Caps total $2.25: Sonnet $1.00,
Gemini $0.65, and $0.20 for each other model. Each API call reserves a
conservative bound for input bytes and the full output ceiling before dispatch.
Aborted calls without returned billing keep their reservation. DeepSeek uses
higher reservation rates than the catalog to allow for routed providers.

## Measures

- Baseline and per-tweak SQL-result correctness against all three fixtures.
- Original/repeat correctness flips, separating ordinary stochastic variation
  from observed flips under changed presentation.
- Questions correct under all five presentations, and questions wrong under
  all five. Consistently wrong is stable, but not reliable.
- Initially correct cases that become wrong under at least one tweak; also
  report this among cases correct on both unchanged controls.
- Per-case aggregated confidence intervals, rather than treating the three
  tweaks of one question as independent evidence.
- Historical development-only repeat stability from Experiment 04, plus the
  recorded Luna and GPT-4o-mini runs. These had three unchanged repetitions.

A changed-prompt failure can also reflect generation noise. One repeat control
and a small sample cannot establish that a particular perturbation caused a
failure. This does not test prompt injection, substantial context changes,
unseen schemas, behavior/abstention, or production error probability. Identical
correctness verdicts do not imply identical SQL or identical wrong answers.

## Reproduction and artifacts

```bash
node scripts/benchmark-robustness.mjs --prepare --output-dir generated/my-robustness-run
node scripts/benchmark-robustness.mjs --use-home-env \
  --model claude-haiku-5-5 --output-dir generated/my-robustness-run
```

Use existing seeded database credentials in the environment. `--db-config`
accepts a local JSON environment file; credentials never enter reports or argv.
Run each model in the frozen manifest once. Existing reports are never replaced.
The runner checks the fixtures read-only before any call (as `npm run eval
-- --no-seed` does) and stops on drift. A call the arm budget blocks is
excluded from scoring, not counted as a model error (the published runs had
no blocked calls).

```bash
node scripts/summarize-robustness.mjs generated/my-robustness-run
```

This writes `summary.json` in the run directory. `--historical <dir>` adds the
unchanged-repeat stability of an Experiment 4 report directory, and
`--publish <file>` also writes the summary to a committed path; the published
summary was made with `--historical generated/provider-benchmark-2026-10-14/full
--publish docs/experiments/results/05-prompt-robustness-summary.json`.
The original experiment's seeded database was reused, then stopped after the
last report was verified. The product default, gold, and scoring were unchanged.

## Results

All five models completed 80 scored question runs, with no excluded cases,
deadlines, budget blocks, or unreturned billing. DeepSeek used one corrective
retry: 401 model calls total for 400 scored runs. Every report carries the same
frozen manifest hash. Total returned charges/native estimates: **$1.029841**,
below the planned $2.25 cap.

| Model, low effort | Original correct | Repeat correct | Polite correct | Whitespace correct | Schema reorder correct | Correct in all five | Correct to wrong under any tweak |
|---|---:|---:|---:|---:|---:|---:|---:|
| Luna | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 0/15 |
| Haiku 5.5 | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 0/15 |
| Sonnet 5.5 | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 0/15 |
| Gemini 3.8 Flash | 14/16 | 15/16 | 15/16 | 14/16 | 15/16 | 14/16 | 0/14 |
| DeepSeek v4.1 Flash | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 15/16 | 0/15 |

The sole consistently wrong case was shared by every model: the development
question about top ledger accounts by March credit amount (`core_public_009`).
Every model returned a scored wrong result on all five versions, rather than
an infrastructure failure. This demonstrates the difference between stable
answers and reliable correct answers.

Gemini additionally varied on the sparkling-water product question
(`edge_public_003_sparkling_water_master_data`): wrong on original/whitespace,
correct on unchanged repeat/polite/schema reorder. Because its unchanged repeat
also changed correctness, this is not evidence that a specific tweak caused
the difference. No originally correct case became wrong under a tweak.

Zero observed losses is weak evidence at this sample size: the case-level
Wilson 95% interval for loss under any of these three tweaks is 0–20.4% for
0/15 cases and 0–21.5% for Gemini's 0/14. These intervals concern this diagnostic
selection and do not estimate production risk. There is no supported general
robustness ranking from this test.

### Existing unchanged-prompt repeat stability

Development answer cases only: 245 cases, three unchanged runs. “Mixed” means
at least one correct and one incorrect repetition. Counts measure correctness
stability, not SQL-text identity. Luna/GPT-4o-mini are older recordings.

| Model | Effort | All three correct | Mixed correctness | All three wrong |
|---|---|---:|---:|---:|
| Luna | low | 224 | 11 | 10 |
| GPT-4o-mini | none | 213 | 6 | 26 |
| Haiku 5.5 | low | 233 | 4 | 8 |
| Haiku 5.5 | high | 233 | 5 | 7 |
| Sonnet 5.5 | low | 235 | 2 | 8 |
| Sonnet 5.5 | high | 238 | 0 | 7 |
| Gemini 3.8 Flash | low | 236 | 1 | 8 |
| DeepSeek v4.1 Flash | low | 233 | 1 | 11 |
| DeepSeek v4.1 Flash | high | 230 | 6 | 9 |

### Latency and cost of this diagnostic

Latency covers the product loop on all 80 development question runs including
retries; it excludes gold execution and fixture scoring. Providers/models ran
concurrently with two workers each. It is not a same-day control for Experiment
04. Native Claude cost includes cache writes; OpenRouter uses returned charges.

| Model, low | Median | p95 | Returned/estimated spend |
|---|---:|---:|---:|
| Luna | 4.078 s | 6.654 s | $0.028403 |
| Haiku | 3.906 s | 6.565 s | $0.047507 |
| Sonnet | 2.942 s | 3.960 s | $0.575834 |
| Gemini | 3.477 s | 5.063 s | $0.347921 |
| DeepSeek | 3.159 s | 5.529 s | $0.030177 |

- [Repository aggregate JSON](results/05-prompt-robustness-summary.json)
- Frozen manifest and local summary: `generated/prompt-robustness-2026-10-14/manifest.json`
  and `summary.json` (gitignored; the [registry](registry.json) records each model report's hash)

Per-model full JSON reports, dispatch hashes, actual prompt messages, and
traces are beside the local summary. No API key was printed or recorded.

Verification: all reports contain the same manifest hash, 16 complete cases,
48 changed-prompt trials, zero budget blocks, and spending below their caps.
The full repository suite passed: 2,175 tests, with 32 opt-in database tests
skipped. Tests cover intact schema reordering, native cache metadata, question
perturbations, unchanged assistant reasoning replay, and correctness-flip
accounting that excludes outages. Syntax and whitespace checks passed.

## Decision

Keep the product default. The small check found no correct-to-wrong losses
under these presentation tweaks, with one noisy Gemini case. It supports
keeping correctness and consistency as separate measurements; it does not
justify changing models or claiming immunity to prompt changes. A larger
pre-registered test of meaningful paraphrases and context changes would be
needed to estimate broader sensitivity.
