# Experiment 04: Claude, Gemini Flash, and DeepSeek Flash

**Status:** complete — measured; default unchanged (2026-10-14). Seven full configurations were measured:
Claude Haiku/Sonnet and DeepSeek at low/high, plus Gemini at low. Gemini high
remains a diagnostic pilot, for the feasibility reasons recorded below.
The original protocol was pre-registered before paid pilot calls.

Logical version: `exp04-providers-2026-10-14`; recorded base commit
`717ec520a363c55d638ef7fd811b64dc27d7dee5` with a dirty working tree. No
run-time source snapshot was captured, so exact source recovery is unavailable.
The [registry](registry.json) identifies original artifacts by hash. The later
[evaluation audit](06-evaluation-review.md) limits these results to the existing
regression suite; it does not revise the published numbers.

The requested comparison covers Claude Haiku 5.5 and Claude Sonnet 5.5 on
Anthropic's native Messages API, and `google/gemini-3.8-flash` and
`deepseek/deepseek-v4.1-flash` on OpenRouter.
Each model was scheduled at explicit `low` and `high` effort. Effort names are
provider controls, not equivalent amounts of computation across providers.

## Protocol

- Use the existing 404-case suite: 392 answer cases and 12 behavior cases.
  Score SQL results against the same seed, v2, and v3 MariaDB 10.6 fixtures.
- Keep hints v2, full schema (`auto`), prompts, business rules, gold answers,
  scoring, one product retry, and the 16,000 output-token ceiling unchanged.
- First run the same 24 development pilot cases listed in Experiment 03,
  once per arm, to verify transport, output schema, billing, and truncation.
  Pilots are excluded from the final accuracy and latency figures.
- Run the full suite three times per case, concurrency 4, for each arm.
  Run low/high sequentially within each model. Report
  product question latency p50/p95 (generation, validation, execution,
  and retries); the fixture-scoring harness is excluded from this latency.
- Compare with the recorded `gpt-6-luna.low.json` baseline; pair low and high
  within each model. Historical reference latency is not a same-day control.
- Report strict accuracy overall and by development/holdout split. Strict
  accuracy averages per-case pass rates across repetitions; it is separate
  from the majority-pass verdict used in paired McNemar comparisons.
- Do not inspect holdout cases individually, tune prompts to these runs,
  change gold/scoring, or change the product's default model.
- Use native structured JSON output for Claude and OpenRouter's strict JSON
  schema for Gemini and DeepSeek. Preserve returned reasoning blocks unchanged on retries.
  Claude's already stable schema prefix receives an explicit five-minute
  cache breakpoint, preserving all text. Include cache writes in cost.
- Save full reports, traces, and logs under
  `generated/provider-benchmark-2026-10-14/`. Use pilot spending to choose
  per-arm budget caps before the full runs. An incomplete arm must be labeled
  incomplete and must not be compared as a full-suite result.
- Model/configuration capability preflight on 2026-10-14 confirmed access
  to both exact Claude IDs, adaptive thinking and structured outputs; the
  OpenRouter catalog confirmed the exact Gemini ID and low/medium/high effort.

## Provider references

- [Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Gemini model catalog](https://openrouter.ai/api/v1/models)
- [DeepSeek v4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)

Online prices verified 2026-10-14, USD per million tokens: Haiku input 0.10,
output 0.50, cache read 0.01, five-minute cache write 0.125 (under 100k input);
Sonnet 2.00 / 10.00, cache read 0.10, cache write 2.50; Gemini 0.75 / 3.75,
cache read 0.075. The OpenRouter catalog snapshot lists DeepSeek input 0.02016,
output 0.891, cache read 0.0054; routed-provider prices may differ.
OpenRouter's reported charge takes precedence over an estimate.
Claude includes thinking in billed output tokens but does not expose a separate
reasoning-token count; no count is inferred from displayed text.

## Results

Every full arm completed all 404 cases with three repetitions: 392 answer
cases (1,176 counted answer repetitions) and 12 behavior cases. There were
no excluded answer repetitions, budget stops, deadline failures, or unpriced calls. All seven
runs have the reference's application prompt version `4358263bcf82`, schema
fingerprint, fixture fingerprint, and 392 paired answer cases.

Accuracy below is the mean pass rate across repetitions. Latency covers
the 255 development questions, including 10 behavior cases (765 repetitions),
and measures the product loop through SQL execution and retries. It excludes
gold execution and scoring on the other fixtures. Cost per correct answer
also covers development questions; run spend covers every split and behavior
case. Claude and historical GPT costs are estimates from returned usage and
verified prices, including native cache writes. Gemini and DeepSeek costs use
OpenRouter's reported charges. They exclude account top-up fees.

| Model | Effort | Overall accuracy | Dev accuracy | Frozen holdout accuracy | Dev p50 | Dev p95 | Dev cost per correct answer | Full run spend |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Claude Haiku 5.5 | low | 92.86% | 95.92% | 87.76% | 3.879 s | 6.031 s | $0.000603 | $0.765925 |
| Claude Haiku 5.5 | high | 92.94% | 96.05% | 87.76% | 5.263 s | 7.572 s | $0.000833 | $1.044199 |
| Claude Sonnet 5.5 | low | 93.54% | 96.33% | 88.89% | 2.972 s | 4.071 s | $0.006914 | $8.198426 |
| Claude Sonnet 5.5 | high | 94.64% | 97.14% | 90.48% | 3.219 s | 5.115 s | $0.007317 | $9.276558 |
| Gemini 3.8 Flash | low | 92.94% | 96.46% | 87.07% | 3.515 s | 8.885 s | $0.004186 | $4.984299 |
| DeepSeek v4.1 Flash | low | 91.16% | 95.24% | 84.35% | 2.521 s | 4.573 s | $0.000332 | $0.449272 |
| DeepSeek v4.1 Flash | high | 91.58% | 95.24% | 85.49% | 3.181 s | 5.985 s | $0.000429 | $0.622984 |
| gpt-6-luna reference, 2026-10-07 | low | 89.37% | 94.01% | 81.63% | 3.043 s | 5.726 s | $0.000268 | $0.327579 |
| gpt-6-luna published reference, rounded | medium | 89.6% | 93.6% | 83.0% | 4.03 s | 6.36 s | $0.00031 | $0.3992 |
| gpt-4o-mini reference, 2026-10-06 | none | 73.64% | 88.30% | 49.21% | 2.386 s | 4.402 s | $0.000604 | $0.634683 |

The references are earlier recordings, not same-day latency or cost controls.
Luna medium comes from the rounded published table in Experiment 03; its full
recording is unavailable in the repository. The latest runs used the current working tree at `717ec52`; the
provider implementation was uncommitted. No prompt, gold, fixture, or scoring
change was made to fit these results. The default model remains unchanged.

### Thinking effort comparisons

Low and high are paired on all 392 answer cases. McNemar uses each case's
majority verdict over its three repetitions; strict accuracy uses its mean
pass rate, so the two statistics summarize different aspects of the run.

| Model, low to high | Strict accuracy delta | Paired bootstrap 95% interval | Improvements / regressions | Exact McNemar p |
|---|---:|---:|---:|---:|
| Haiku 5.5 | +0.09 percentage points | -0.94 to +1.19 points | 5 / 4 | 1.000 |
| Sonnet 5.5 | +1.11 percentage points | 0.00 to +2.38 points | 5 / 1 | 0.219 |
| DeepSeek v4.1 Flash | +0.43 percentage points | -0.60 to +1.53 points | 7 / 3 | 0.344 |

None of these comparisons established a statistically significant accuracy
advantage for high effort. Haiku high increased development median latency from 3.879
to 5.263 seconds and cost per correct answer by about 38%, with unchanged
holdout accuracy. Sonnet high had the highest observed accuracy, with p95
latency rising from 4.071 to 5.115 seconds. Its improvement over low remains
inconclusive in this run; this is not evidence that the settings are equivalent.

Haiku low is the cheapest Claude configuration measured. Sonnet low had lower
latency and a slightly higher accuracy point estimate, at about 11.5 times
the development cost per correct answer. These measurements support different
choices depending on the application's accuracy, latency, and cost needs.

DeepSeek high increased development median latency from 2.521 to 3.181 seconds
and cost per correct answer from $0.000332 to $0.000429, while development
accuracy stayed 95.24%. Its overall +0.43-point gain came from the holdout;
the low/high paired comparison remains inconclusive. DeepSeek low had the
lowest observed development median among the new provider runs. The historical
Luna low reference had the lowest development cost per correct answer overall.
These are descriptive observations under the recorded run conditions.

### Comparison with the recorded default

These comparisons are exploratory, with unadjusted p-values. The holdout is
shown only in aggregate; no candidate's holdout failures were inspected.

| Candidate | Overall delta | Overall improvements / regressions | Overall McNemar p | Holdout delta | Holdout McNemar p |
|---|---:|---:|---:|---:|---:|
| Haiku low | +3.49 points | 17 / 6 | 0.034690 | +6.12 points | 0.076813 |
| Haiku high | +3.57 points | 17 / 5 | 0.016901 | +6.12 points | 0.035156 |
| Sonnet low | +4.17 points | 18 / 5 | 0.010622 | +7.26 points | 0.035156 |
| Sonnet high | +5.27 points | 19 / 2 | 0.000221 | +8.84 points | 0.007385 |
| Gemini low | +3.57 points | 17 / 7 | 0.063915 | +5.44 points | 0.210114 |
| DeepSeek low | +1.79 points | 15 / 10 | 0.424356 | +2.72 points | 0.454498 |
| DeepSeek high | +2.21 points | 17 / 8 | 0.107752 | +3.85 points | 0.118469 |

DeepSeek low completed all 404 cases and 1,176 counted answer repetitions,
with no exclusions or stop. OpenRouter returned provider charges for every
development call. Its higher accuracy point estimate than the recorded Luna
default did not establish a significant difference in the paired
majority-verdict test. Gemini low also completed all 404 cases without
exclusions, deadline failures, or a stop, costing $4.984299 across every split.
Its mean pass-rate bootstrap interval versus Luna is above zero, while the
separate majority-verdict McNemar test is inconclusive (p = 0.063915).
DeepSeek high likewise has a positive mean pass-rate bootstrap interval versus
Luna, while its majority-verdict McNemar comparison remains inconclusive.

### OpenRouter authentication and billing

The Flash pilot stopped on HTTP 401, `User not found`, before any answer was
counted. A separate account-key check and fresh direct `fetch` POSTs using
the key parsed from `~/.env` returned the same 401. Direct POSTs tested both
the requested `google/gemini-3.8-flash` and `google/gemini-4-argon` from the
follow-up example. The parsed credential had the OpenRouter prefix, no
surrounding whitespace, and differed from the OpenAI key. No key was printed.

Those attempts produced no Gemini accuracy or inference-latency result. The failed request
timings are authentication timings and must not be presented as model latency.
The credential configuration was subsequently diagnosed: `~/.env` had two
`OPENROUTER_API_KEY` declarations, on lines 5 and 15. The earlier key returned
HTTP 200 from `/api/v1/key`; the later key returned HTTP 401 and was selected
by dotenv. Tests with optional `HTTP-Referer`, `X-OpenRouter-Title`, and legacy
`X-Title` headers did not change the failing key's response. Authentication
needs the Bearer header; the additional headers are optional app attribution,
as [OpenRouter documents](https://openrouter.ai/docs/api_reference/authentication).

The failing duplicate was removed while preserving the verified working key
and every other setting. Fresh direct Flash and Argon requests then returned
HTTP 200. That key subsequently returned HTTP 402 on benchmark calls; these
attempts are archived separately and excluded as infrastructure failures.
The user then enabled another key. Reloading `~/.env` confirmed HTTP 200,
approximately $19.99 account credit, and a $50 remaining key allowance before
the new pilots. The requested benchmarks were resumed and completed. The earlier
suggestion that a new key was needed was premature; a working key was already
present in the file.

### Artifacts and verification

- [Repository aggregate summary](results/04-provider-models-summary.json)
- [OpenRouter capability and price snapshot](results/04-openrouter-catalog.json)
- [Haiku low report](results/04-reports/claude-haiku-5-5.low.md)
- [Haiku high report](results/04-reports/claude-haiku-5-5.high.md)
- [Sonnet low report](results/04-reports/claude-sonnet-5-5.low.md)
- [Sonnet high report](results/04-reports/claude-sonnet-5-5.high.md)
- [Gemini low report](results/04-reports/google__gemini-3.8-flash.low.md)
- [DeepSeek low report](results/04-reports/deepseek__deepseek-v4.1-flash.low.md)
- [DeepSeek high report](results/04-reports/deepseek__deepseek-v4.1-flash.high.md)

The per-arm Markdown reports are committed copies of the run output (holdout
in aggregate only). The full JSON reports (about 12 MB each), JSONL traces and
the local aggregate `summary.json` stay in the gitignored
`generated/provider-benchmark-2026-10-14/`; the [registry](registry.json)
identifies each JSON report by its SHA-256. Sonnet's original logs are retained as
`*.original.log` because the first matrix later encountered its already
completed reports; those encounters made no duplicate inference calls.

Recorded spending for the new experiment: full runs $25.341663, pilots
$1.008370, transport/authentication probes $0.00122795; approximately
**$26.35** in total. Claude's portion is estimated; OpenRouter uses returned
charges. This excludes any charge for the aborted Gemini high pilot call
whose usage was not returned, and excludes unrelated account activity.
The OpenRouter full arms used caps of $10.08 (Gemini low), $1.00 (DeepSeek low),
and $1.04 (DeepSeek high); all completed below their caps.

Validation: the unit suite passed (opt-in database tests skipped); provider
wire-format tests cover both Claude models at low/high effort, signed-thinking
replay, Gemini reasoning-detail replay, cache-write pricing, missing-provider
keys, unsupported efforts, truncation, DeepSeek reasoning-detail replay, and
HTTP 402 infrastructure classification. Web typecheck/build passed. The
fixture verification gate passed for every live run. The recorded default's
offline gate passed with zero majority-verdict flips on all 392 paired cases.

### Interpretation limits

This is one three-repetition run per arm, on one synthetic retail schema with
13 tables. Paraphrases share intents; case-level intervals do not make those
phrasings independent. The result comparator has documented gaps, including
empty-answer ambiguities and held-out negative controls it cannot reject.
Provider interfaces and cache mechanisms differ, and the concurrent schedule
can affect latency. Native Claude does not expose a separate reasoning-token
count; generic zero reasoning totals must not be read as no thinking. These
results describe this workload and run conditions, not a general model ranking.

## Reproduction

Configure the demo's query/admin database credentials in the environment,
start MariaDB 10.6, and run `npm run seed-fixtures` as in the repository
quickstart. The matrix loads API credentials through the usual env loader,
then runs against those existing fixtures. It refuses to overwrite reports.

```bash
node scripts/benchmark-providers.mjs --use-home-env --phase pilot \
  --models claude-haiku-5-5,claude-sonnet-5-5,deepseek/deepseek-v4.1-flash \
  --output-dir generated/my-provider-run
node scripts/benchmark-providers.mjs --use-home-env --phase pilot \
  --models google/gemini-3.8-flash --efforts low \
  --output-dir generated/my-provider-run
node scripts/benchmark-providers.mjs --use-home-env --phase full \
  --models claude-haiku-5-5,claude-sonnet-5-5,deepseek/deepseek-v4.1-flash \
  --output-dir generated/my-provider-run
node scripts/benchmark-providers.mjs --use-home-env --phase full \
  --models google/gemini-3.8-flash --efforts low \
  --output-dir generated/my-provider-run
```

`--models claude-haiku-5-5,claude-sonnet-5-5` selects only Claude;
`--models google/gemini-3.8-flash,deepseek/deepseek-v4.1-flash` selects
the OpenRouter models. The reproducible
matrix runs models sequentially; invoking disjoint model selections
concurrently reproduces the scheduling amendment below. Each Claude run uses
`ANTHROPIC_API_KEY` on api.anthropic.com. Gemini and DeepSeek use `OPENROUTER_API_KEY`
on openrouter.ai; the matrix clears `OPENAI_API_KEY` for that child so the
OpenAI credential never wins over the router key. Keys never enter argv or
report files.

Aggregate the local reports, including GPT historical references and separate
development pilots, without exposing individual holdout cases:

```bash
node scripts/summarize-provider-benchmark.mjs generated/my-provider-run \
  docs/experiments/results/04-provider-models-summary.json
```

## Scheduling amendment

On 2026-10-14, while the first Haiku arm was still running and before any
full-suite result was available, the schedule was changed from sequential
models to concurrent Haiku and Sonnet runs. Each model retains four workers;
its low/high arms remain sequential. This reduces wall time without changing
cases, repetitions, thinking settings, or scoring. Latency includes any
contention from the concurrent models on the shared account and local fixture
server; it is not an isolated-provider latency measurement.

## OpenRouter scope amendment

On 2026-10-14, after the Claude results were available, the user requested
DeepSeek v4.1 Flash as well. Before its pilot, the exact catalog ID and strict
structured output support were checked; supported efforts are low/high/max.
Low/high use the same pilot, fixtures, prompts, scoring, and repetition plan.
Gemini and DeepSeek full runs may overlap, with four workers per model and
low/high sequential within a model. Per-arm caps derive from pilot cost;
available account credit is checked before starting expensive arms.

### Gemini high-effort feasibility amendment

The high-effort 24-case pilot had one harness deadline failure at 120 seconds.
Its observed median was 28.18 seconds and p95 110.37 seconds; reported charges
were $0.464758, excluding any charge for the timed-out call whose usage was
unavailable. The projected full three-repetition run cost was about $23.47,
exceeding available credits before other OpenRouter runs. Before any Gemini
full result was available, the full comparison was limited to low effort.
The high pilot is retained separately, not treated as a full-suite result or
used to claim a reliable low/high accuracy difference. Full two-level Claude
comparisons are unaffected. Reproduce the Gemini full arm with `--efforts low`.
