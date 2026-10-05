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

`--write-baseline` warns when the run used a subset of the suite or a dirty
working tree. Check the run's `report.md` before committing the file, and
commit it in its own change with a note on what was measured (model, prompt
version, repetitions).

How it is used (details in
[docs/evaluation-dataset.md](../../docs/evaluation-dataset.md#running-evaluations)):

- **Comparison**: cases are paired by id; a case whose gold changed since the
  baseline is excluded and listed. Flips are tested with an exact McNemar test;
  `--gate` fails a run that is significantly worse.
- **Rescore**: `--offline` re-validates, re-executes and re-scores the
  baseline's recorded SQL with today's validator, fixtures and oracle, so a
  guardrail, comparator or fixture change shows its effect on real generations
  at no cost.

Refresh the baseline when the prompt version, the model or the datasets change
on purpose; the comparison table in `report.md` shows what moved.
