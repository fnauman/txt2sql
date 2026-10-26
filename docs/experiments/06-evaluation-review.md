# Experiment 06: Evaluation and production-readiness review

**Status:** complete — audit; default unchanged (2026-10-14).

Logical version: `exp06-evaluation-review-2026-10-14`. See the
[registry](registry.json) and [aggregate results](results/06-evaluation-review-summary.json)
for the exact source fingerprint, base commit, artifact hashes and fixture
versions. This is an offline audit with zero model calls, not a new accuracy run.

## Hypothesis

Reproducing the baseline and passing the existing verification gate may conceal
overfitting in the evaluation oracle. Check those claims separately before
selecting a production model or expanding the provider benchmark.

## Design

Use the existing isolated MariaDB 10.6 benchmark fixtures, with hints v2 and the
current default product settings. Run `verify-dataset` across all six datasets;
rescore `eval/baselines/gpt-6-luna.low.json` with `--offline --gate
--holdout-summary --no-docker --no-seed`. The wrapper only loads local connection
settings and delegates to these repository entrypoints. No gold, fixture,
scoring rule, dataset manifest, default model or recorded model answer changes.

Inspect aggregate holdout results and oracle-control coverage, not individual
holdout model failures to tune the system. Oracle control mutations were
reviewed during the audit; this control tier must not be represented as an
untouched blind test for future oracle tuning. Create new independent controls
and sealed questions after any revisions. Development-case semantic review is
allowed and is described below.

## Offline measurements

All 413 dataset definitions (404 deduplicated cases) pass gold-query verification
against seed/v2/v3: zero reported dataset problems. This confirms executable,
self-consistent gold under today's oracle, not that every question's business
meaning is unambiguous.

| Dataset | Definitions | Design-control kills | Held-out-control kills |
|---|---:|---:|---:|
| Core | 9 | 77/77 | 16/16 |
| Edge | 17 | 152/152 | 28/28 |
| Hard | 40 | 140/140 | 15/19 (78.9%) |
| Holdout | 149 | 779/779 | 64/74 (86.5%) |
| Paraphrases | 9 | 77/77 | 16/16 |
| Templated | 189 | 1,504/1,504 | 185/236 (78.4%) |

These are mutated SQL control checks, not model accuracy. The default design
kill-rate threshold is 95%, but the held-out-control threshold is **0%**.
Consequently today's gate passes despite missing several held-out wrong-query
controls. All positive controls match gold results; the validator still rejects
one each in core, edge and paraphrases. These checks do not remove the
sensitivity gap.

The offline Luna rescore exactly reproduces the recording: **89.37%** strict
answer accuracy, **81.63%** on the existing holdout, 392 paired answer cases,
zero improvements/regressions and McNemar p=1. Re-execution validates regression
compatibility; it cannot establish generalization or replay a different prompt.
The existing 149-case holdout manifest remains unchanged.

## Semantic finding

The common oracle failure in Experiment 05, development case `core_public_009`,
asks for top ledger accounts by credit amount in March 2026. Gold filters by
sales document date and excludes canceled documents; the inspected model SQL
uses accounting posting date. The fixtures distinguish them. The question does
not clearly specify which date convention applies to this ledger request.

This needs a business-contract decision and possibly clarification behavior,
not an automatic gold correction to match model consensus. Historical scores
remain frozen. A revised question/oracle must receive a new version and new
discriminating controls. “Consistently wrong” in Experiment 05 describes the
existing oracle verdict, not proof that this business interpretation is wrong.

## Decision

Keep the default and historical baselines. Treat current figures as comparisons
on a known synthetic regression suite. Address ambiguous semantics, independent
oracle controls, behavior/clarification coverage and a new schema-disjoint
sealed evaluation before making a production quality claim. See the
[production roadmap](../production-roadmap.md) for bounded retrieval/planning
comparisons, local GPU serving, user isolation and UI priorities.
