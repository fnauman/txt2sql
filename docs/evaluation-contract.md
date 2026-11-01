# Evaluation contract work

Status: the enforcement changes below are implemented. Business sign-off and
an independently authored sealed evaluation remain open. Historical artifacts
and the existing holdout stay frozen.

## Enforced now

`oracle-controls-v2` uses 95% negative-control detection per dataset for both
design and later-authored controls. This is the same tolerated miss rate for
both tiers, not a floor adjusted to the observed results. Coverage must include
current negative SQL controls for every answer case; positive controls alone,
stale gold fingerprints and missing tiers cannot satisfy the check. Errors and
undecided mappings still count as not killed.

The default strict verifier currently exposes the documented sensitivity gaps.
`--oracle-policy regression` exists for historical compatibility only. Reports
name that policy, and the evaluator refuses baseline promotion when it was
used, verification was skipped, or controls were skipped. CI captures an
advisory strict audit separately from its required historical regression job.

## Decisions requiring a business owner

For ledger questions such as “top accounts by March credits”, choose and state
the intended date basis: posting date, sales document date, or a clarification
choice when the request supplies neither. Also decide the cancellation policy
for a ledger metric. The existing development gold applies document date and
excludes canceled documents; this historical reading is preserved, not endorsed
by a code change. Model agreement is not evidence for choosing the contract.

Record each metric's date basis, cancellations, aggregation grain, currency,
top-N/tie rules, name resolution and empty-result meaning. Identify which
defaults are safe and which missing details require clarification. Then version
the contract and oracle independently, with a reason for each revision.

## Sealed evaluation acceptance procedure

1. Agree the contract and freeze development selection criteria, product source,
   candidate model/settings, budget and the decision rule before any paid run.
2. Have an author independent of scorer tuning create a different schema family,
   questions and discriminating fixtures. Cover plausible wrong joins, missing
   cancellation or access filters, date substitutions, grain and aggregation
   errors, plus correct alternatives and clarification/abstention cases.
3. Keep the sealed questions, gold and independent controls outside the visible
   development checkout. Record their hashes and custody/access history in the
   experiment manifest. Hashing public examples does not make a sealed test.
4. Validate executable gold and controls under the frozen contract. Require the
   strict oracle policy; record sample sizes and misses as well as rates. An
   inadequate control set is a failed measurement, not a reason to relax the
   threshold or tune fixtures against sealed survivors.
5. Freeze the candidate on development, execute the sealed comparison once,
   report aggregate correctness and behavior metrics separately with
   intent-clustered uncertainty, cost and latency, and record all source/data
   versions. Any revealed cases are retired from sealed status before tuning.

These steps deliberately do not claim that a fresh independent dataset has
been created in this session. The existing synthetic suite remains useful
for compatibility regression, with its documented scope and reuse limits.
