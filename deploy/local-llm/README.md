# Local inference pilot

Preparation for a single GPU serving this application's SQL model. The Compose
file has been parsed, but **no GPU inference has been run**: `nvidia-smi` could
not communicate with a driver in the review environment. Image/checkpoint
compatibility, throughput, VRAM, and SQL accuracy remain to be measured.

## Hardware and first candidates

NVIDIA lists the [RTX 5090 laptop GPU](https://www.nvidia.com/en-us/geforce/laptops/50-series/)
with 24 GB and the [RTX PRO 6000 Blackwell workstation](https://www.nvidia.com/en-gb/products/workstations/professional-desktop-gpus/rtx-pro-6000/)
with 96 GB. Treat the requested 80 GB workstation tier as a usable budget;
confirm the actual device with `nvidia-smi` before sizing.

| Tier | First candidate | Comparison candidate | Initial limits |
|---|---|---|---|
| 24 GB laptop | [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) | [Gemma 4 12B official W4A16 checkpoint](https://huggingface.co/google/gemma-4-12B-it-qat-w4a16-ct) | 8,192 total tokens, one active sequence, then two |
| 80 GB usable workstation | [Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B) | [Gemma 4 31B official W4A16 checkpoint](https://huggingface.co/google/gemma-4-31B-it-qat-w4a16-ct) | 8,192 total tokens, four active sequences, then eight |

These are candidates, not SQL benchmark winners. Rough BF16 weight arithmetic is
18 GB for 9B and 54 GB for 27B, before runtime, activations, KV/state caches,
and allocator overhead. The 9B BF16 pilot may need quantization or shorter
context on a laptop also driving a display. Google's [memory table](https://ai.google.dev/gemma/docs/core)
also separates loading estimates from context requirements. A model's advertised
context window is not an affordable concurrency target. MoE active parameters
do not mean only those weights need to reside in memory.

## Prepare and launch

1. Verify the host driver, Docker GPU access, and the
   [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
   RTX Blackwell support depends on the image's CUDA and attention/quantization
   kernels; support on a datacenter Blackwell GPU alone is insufficient evidence.
2. Follow the chosen model's official serving recipe. Download weights and
   tokenizer to an immutable local directory before isolating inference from
   the network; satisfy the checkpoint's license/access terms. Record its exact
   repository revision and file hashes. Do not enable remote model code by default.
3. Choose a compatible vLLM release, test it on the actual GPU, then record the
   resolved image digest. Copy `settings.example` to an ignored settings file
   outside this directory and replace all placeholders. Keep its permissions
   private and use a dedicated local API secret.
4. Validate and start (the first command does not start a container):

   ```bash
   docker compose --env-file /absolute/path/local-llm.env -f deploy/local-llm/compose.yaml config --quiet
   docker compose --env-file /absolute/path/local-llm.env -f deploy/local-llm/compose.yaml up -d
   ```

The template binds the API to host loopback, mounts predownloaded weights read
only, disables request logging/telemetry and prefix caching, and serves only
the language component under `local-sql`. It does not use an `internal: true`
network, because Docker publishes no ports from one and the host application
could not connect. The offline flags stop model downloads; to block all
outbound traffic from the container, add a host firewall rule (for example in
the `DOCKER-USER` iptables chain) and verify it before sensitive use. It starts
with thinking disabled through the chat template. Check that the selected
release accepts every flag and that the checkpoint honors that template option.
Do not silently remove a rejected control: adapt and record it explicitly.
The workstation example uses 0.80 of 96 GB, about 76.8 GB; the fraction refers
to physical VRAM, not the requested 80 GB budget.

Configure the application server, not the browser, with:

```dotenv
MODEL_NAME=local-sql
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=<dedicated local inference secret>
REASONING_EFFORT=
```

An app running in another container needs a private container address instead
of host loopback. Do not expose port 8000 publicly to solve that. The shared
app token is not a substitute for user identity or database authorization.

Before a full evaluation, smoke-test this app's actual structured response
schema, output-token limit, thinking mode, truncation/error handling, corrective
retry, streaming cancellation, and cancellation's release of GPU capacity.
vLLM supports [structured outputs](https://docs.vllm.ai/en/stable/features/structured_outputs/),
but this exact client/checkpoint combination still needs validation. No hosted
fallback should run for sensitive requests. If local pricing is entered as zero
in the evaluator, label it **API charges only**; it excludes hardware and power.

## Several users and three kinds of memory

Share one inference engine and its model weights across users. Use continuous
batching behind an authenticated application gateway, a bounded fair queue,
per-user quotas, request deadlines, and cancellation. Do not start one model
process per user. `max-num-seqs` limits simultaneous inference sequences; it
does not specify how many people may have an idle conversation.

Keep these separate:

- **Conversation state:** durable records scoped to tenant/user/conversation,
  with retention, encryption, and deletion. Store validated intent, resolved
  filters/date convention and previous SQL/results metadata; avoid retaining
  unrestricted result rows by default.
- **Prompt context:** rebuild a bounded prompt from authorized schema, business
  rules, the current question, a few recent turns and verified state. Reserve
  output/reasoning tokens within the total context budget. Summaries cannot
  create new permissions or override explicit filters. Never append history
  indefinitely.
- **GPU cache/state:** transient per active sequence; capacity depends on model,
  precision and length. It is not conversation storage. Prefix caching starts
  off. If enabled later, use a server-generated tenant isolation salt and review
  [vLLM's cache isolation guidance](https://docs.vllm.ai/en/latest/design/prefix_caching/).

Enforce tenant access using database permissions, views or separate read-only
accounts/pools. An LLM-generated tenant filter is insufficient. Scope any result
cache to identity/permissions plus data, schema, prompt and model revisions;
the current cache is intentionally restricted to the demo database.

## Acceptance experiment

Screen both laptop candidates on development questions, then both workstation
candidates only if the laptop tier misses a defined requirement. Freeze the
chosen checkpoint/template/settings before using a new sealed evaluation set.
Compare direct JSON-to-SQL with the existing hosted baseline under the same
contract; measure correct answers, appropriate clarification/refusal, and
privacy boundary failures separately.

Load-test 1, 2, 4 and 8 concurrent requests with mixed short/long questions,
cold/warm runs, cancellations and queue saturation. Record queue time, time to
first token, end-to-end p50/p95, tokens/second, peak VRAM, OOMs, and correctness
under load. Select concurrency from measured latency and memory headroom.
Include driver/GPU, model commit/file hashes, tokenizer/chat template,
quantization, image digest, vLLM/CUDA versions, context and sequence limits,
sampling and application source fingerprint in each run manifest.

Local inference avoids an external model API, but privacy also requires local
retrieval/embeddings, controlled logs and browser storage, no remote fallback,
and an audited egress policy for the whole application. Review the
[vLLM security guidance](https://docs.vllm.ai/en/latest/usage/security/).
Compare electricity, equipment amortization and operational effort per correct
answer with hosted cost at expected utilization; do not assume zero API charges
mean lower total cost.
