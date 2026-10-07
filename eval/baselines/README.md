# Evaluation baselines

`npm run eval` compares every run with `eval/baselines/<model>.json` when that
file exists (for example `gpt-4o-mini.json`), and `npm run eval -- --offline`
(the CI `db` job) rescores it with no LLM calls. The committed baseline is
`gpt-4o-mini.json` (gpt-4o-mini, the whole 404-case suite with the fresh
holdout, 3 repetitions, full-schema prompting via the default
`SCHEMA_SCOPE=auto`, prompt version `b264e57d8e15`); its numbers are in
[docs/evaluation-dataset.md](../../docs/evaluation-dataset.md#current-baseline).

A baseline is a **compact** `report.json` (report version 2, marked
`compact: true`) of the **whole default suite** (every dataset in `datasets/`,
de-duplicated) with enough repetitions to be stable. Compact means it keeps
only what the rescore, the comparison and the gate read (the run's summaries,
each case's definition, fingerprints and summary, and per repetition its
outcome, usage, cost, timings and every attempt's SQL and verdicts) and drops
row previews, explanations, master-data candidates, per-fixture oracle details
and recorded guardrail re-checks; see `src/eval/compact-report.js`. Rescoring
it gives the same outcomes and statistics as rescoring the full report, at
about 1.4 MB (10^6 bytes) for 255 cases x 3 repetitions instead of 6-9 MB
(about 2.1 MB for the current 404 cases), one line per case. A repetition's only LLM call shares its usage and cost
with the repetition (`llm_usage_attempt`); a rescore restores the call's
copy. The run's own `report.json` under `generated/runs/` stays complete.
To make one:

```bash
git status                                   # commit first: the report records the git sha and a dirty flag
npm run eval -- --repeat 3 --write-baseline  # writes a compact copy of the run's report.json here as <model>.json
```

`--write-baseline` only writes after a clean, complete run (exit 0, no case
skipped by the budget); otherwise it says why and leaves the existing file
alone. It refuses, before the run starts, to replace `<model>.json` with a
subset: filters (`--case-id`, `--tag`, `--intent`, `--split`), fewer
`--fixtures`, or a suite (`--dataset`, `--dataset-file`, `--datasets-dir`)
whose cases are not exactly the default suite's. A subset can be saved with
`--baseline-file <path>` outside this directory and compared with
`--compare <path>`; every file here is a model's default baseline, so
`--baseline-file` refuses a path in here other than the run's own
`<model>.json` (it would replace another model's baseline). It warns on a
dirty working tree. Check the run's `report.md` before committing the file, and
commit it in its own change with a note on what was measured (model, prompt
version, repetitions).

How it is used (details in
[docs/evaluation-dataset.md](../../docs/evaluation-dataset.md#running-evaluations)):

- **Comparison**: cases are paired by id; a case whose gold changed since the
  baseline is excluded and listed. Flips are tested with an exact McNemar test;
  `--gate` fails a run that is significantly worse (and stops with exit 2 when
  there is no baseline to compare with, when the file is not a report, or when
  it pairs fewer than half of the run's cases).
- **Rescore**: `--offline` re-validates, re-executes and re-scores the
  baseline's recorded SQL with today's validator, fixtures and oracle, so a
  guardrail, comparator or fixture change shows its effect on real generations
  at no cost. Once a baseline is committed, the CI `db` job runs it with
  `--gate`.

Refresh the baseline when the prompt version, the model or the datasets change
on purpose; the comparison table in `report.md` shows what moved.
