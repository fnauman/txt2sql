# Next steps: evaluation, local inference, and product readiness

Review date: 2026-10-14. Base commit:
`717ec520a363c55d638ef7fd811b64dc27d7dee5`; the provider, provenance and UI
changes reviewed here were committed afterwards. Experiment labels, artifact hashes and provenance gaps are indexed in
[the registry](experiments/registry.json). The default model remains unchanged.

## 1. Repair the evaluation contract before selecting another winner

The current suite is useful as a regression suite, not sufficient evidence of
production accuracy. It covers one small synthetic business schema. The first
holdout was retired; the replacement has also been used for several model
comparisons. Calling it fresh would overstate its independence.

The [offline audit](experiments/06-evaluation-review.md) re-executed all gold
queries and rescored the recorded baseline without any model calls. The
baseline reproduced exactly. However, held-out oracle-control detection is
only 78–86% for three datasets, while the configured minimum is zero. Passing
the gate therefore does not establish sensitivity to unfamiliar wrong SQL.
All new providers also failed the existing 12 behavior cases in Experiment 04;
SQL answer accuracy hides that weakness.

There is a concrete contract ambiguity in a development question about ledger
credits in March: gold uses sales document date and excludes canceled documents;
the models use ledger posting date. The fixtures distinguish them. Specify the
business meaning or require clarification before judging this as a model error.
Do not change gold simply because many models agree.

Next deliverable:

1. Review development gold and business semantics with a domain owner: date
   basis, cancellations, aggregation grain, ties/top-N, names, empty results,
   and when clarification is required. Version any changed oracle separately;
   preserve historical scores and recordings.
2. Build independent discriminating fixtures and positive/negative controls
   after the contract is frozen. Include plausible wrong joins, missing tenant
   or cancellation filters, date substitutions and aggregation errors. Require
   a justified nonzero held-out control threshold, not a threshold chosen to
   make today's results pass. Keep control authors independent of scorer tuning.
3. Create a new sealed test set, with schema/intent families disjoint from
   development, realistic vocabulary, ambiguous questions, unanswerable tasks,
   and safe multi-turn corrections. Do not carry forward the current holdout's
   artificial synonym exclusion as a production assumption.
4. Freeze candidates on development, run the sealed set once for the decision,
   and report intent-clustered intervals, appropriate abstention/clarification,
   answer correctness, failure attribution and cost/latency separately. The old
   suite stays as a compatibility/regression check.

The cheap prompt test found very little instability on 16 development intents;
it cannot estimate production reliability. Retrieval was held fixed, so it also
does not establish robustness of the complete pipeline to paraphrases.

## 2. Test a bounded set of retrieval and generation alternatives

**Adequately tested for this small schema:** weighted lexical schema retrieval,
join expansion and full-schema prompting. Experiment 01 supported full schema
on this corpus. Few-shot selection also uses lexical matching. This is not a
general comparison of retrieval methods or evidence for larger schemas.

**Not demonstrated by comparative experiments in this repository:** dense
retrieval, BM25/dense hybrid retrieval, reranking, or an alternative semantic
planning/compiler pipeline. More provider benchmarks do not answer that question.

| Question | Small comparison | Measure before paid generation |
|---|---|---|
| Does retrieval help as schemas grow? | Full schema vs current lexical/join expansion vs BM25 + local dense retrieval with join closure | Table/column recall, required join-path coverage, prompt size, retrieval latency; authorized schema only |
| Does explicit planning reduce semantic errors? | Current direct structured SQL + one retry vs typed intent/metric/filter plan compiled for supported operations, with explicit clarification/fallback | Plan coverage, invalid plans, unsupported-intent detection, business-rule violations |
| Do local models remain reliable? | Two local candidates per needed hardware tier, using the winning retrieval setup | Correctness and abstention, prompt/context sensitivity, latency, VRAM, load behavior |

Start with development-only screens, shared prompts and fixed budgets; add a
reranker only if retrieval misses justify it. Use a larger schema and at least
one different schema family. Test one variable at a time and record retrieval
recall independently of final SQL execution. Avoid an exhaustive model ×
retrieval × planner grid. A compiler is a scoped product choice, not assumed to
handle arbitrary SQL better than a model.

## 3. Bring up one local serving tier, then load-test it

The [local inference runbook](../deploy/local-llm/README.md) contains checkpoint
candidates, a Compose template and exact application settings. Start with
Qwen3.5-9B and a quantized Gemma 4 12B comparison on the 24 GB laptop. For the
workstation, screen Qwen3.6-27B and quantized Gemma 4 31B if more capacity is
needed. These are unmeasured candidates, not benchmark recommendations.

NVIDIA specifies 96 GB for RTX PRO 6000 Blackwell; use the requested 80 GB as a
working allocation budget. Begin at 8k context with one active laptop sequence
or four workstation sequences. Test 1/2/4/8 simultaneous requests before choosing
admission limits. No working GPU driver was available for this review, so the
serving template has only configuration validation, not a successful GPU run.

One shared inference process serves multiple users. Add authenticated user and
tenant identity, a fair bounded queue, quotas/deadlines and cancellation. Store
conversation state outside the GPU, partitioned by identity; construct bounded
context from verified state. Model weights, prompt context and KV cache have
different lifecycles. Database permissions must enforce data access independently
of generated SQL. Keep local processing local across embeddings, logs, browser
storage and fallback paths as well as the model API.

The completion criterion is an immutable deployment manifest plus measured
accuracy, p95 latency, OOM behavior, tenant isolation and cost per correct answer
at expected utilization. Hosted Luna's recorded development API cost was about
$0.27 per 1,000 correct answers: privacy may justify local inference before
hardware economics do. Electricity, idle time and operations need to be counted.

## 4. Make the UI support trustworthy daily use

The UI already supports SSE progress, cancellation, SQL inspection, tables,
charts and dashboard pins. The review reproduced an API-down state that stayed
on “Connecting.” A separate web fix (PR #18) adds a five-second health
deadline, a clear unavailable state and Retry; also a question-field
accessibility label and useful dashboard empty-state guidance.

Browser checks covered API unavailable → Retry → connected, synthetic successful
table, empty result and model timeout. The preview used a fake runtime with no
database or model execution. It is UI evidence, not an end-to-end SQL evaluation.
See [the unavailable-state screenshot](images/ui-service-unavailable-2026-10-14.jpg).
Responsive layouts and real GPU/server integration remain unchecked.

Next UI slice:

- Present clarification choices and resolved date/filter assumptions before
  treating every request as SQL. Show truncation, data freshness and the model's
  local/hosted source in a useful results summary.
- Show queue state, meaningful timeout/retry actions and cancellation. Exercise
  these against the real local inference endpoint, including recovery and load.
- Partition or remove browser-persisted question history and dashboard rows for
  production; add retention/logout controls. Local storage currently has no user
  boundary, and pins can persist result data, including server-engine results.
- Add a few browser-level acceptance checks around failure/recovery, accessible
  keyboard operation, clarification and small-screen results. Keep existing
  component/API tests; do not replace them with a large screenshot suite.

The current shared bearer token and shared database account do not provide
multi-user authorization. The result cache is explicitly demo-only; preserve
that restriction until identity, permission and data-revision keys are designed.

## Recommended order

First freeze evaluation semantics and new evidence rules. In parallel, run the
single-GPU compatibility smoke test and the UI clarification/privacy slice.
Then screen the bounded retrieval/planning alternatives on development, freeze
the local model/configuration, and perform one sealed accuracy decision plus a
separate concurrency/isolation acceptance run. Do not promote a default from
the old benchmark ranking alone.
