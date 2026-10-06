# Evaluation baselines

`npm run eval` compares every run with `eval/baselines/<model>.json` when that
file exists (for example `gpt-4o-mini.json`), and `npm run eval -- --offline`
(the CI `db` job) rescores it with no LLM calls. No baseline is committed yet;
until one is, those steps say so and skip the comparison.

A baseline is an ordinary `report.json` (report version 2) of the **whole
default suite** (every dataset in `datasets/`, de-duplicated) with enough
repetitions to be stable. To make one:

```bash
git status                                   # commit first: the report records the git sha and a dirty flag
npm run eval -- --repeat 3 --write-baseline  # writes the run's report.json here as <model>.json
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
